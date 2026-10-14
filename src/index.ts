import http from 'node:http'
import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { UpstreamServer } from './upstream/server.js'
import { Registry } from './upstream/registry.js'
import { SettingsCache } from './upstream/settings.js'
import { TokenManager } from './auth/tokens.js'
import { ProgressStore } from './progress.js'
import { UserStore } from './users.js'
import { PlaybackSessions } from './sessions.js'
import { SocketHub } from './socket/hub.js'
import { createApp, BASE_PATH } from './app.js'
import type { Context } from './context.js'
import { log } from './logger.js'

/** Version of the Audiobookshelf web client bundled with the image. */
const ABS_VERSION = process.env.ABS_VERSION ?? '2.37.1'

async function main() {
  const cfg = loadConfig()
  const db = openDb(cfg.dataDir)
  const servers = cfg.servers.map((s) => new UpstreamServer(s))
  const registry = new Registry(db, servers)
  const tokens = new TokenManager(db, cfg)
  const progress = new ProgressStore(db)
  const users = new UserStore(db, tokens, progress)
  users.syncFromConfig(cfg)
  const sessions = new PlaybackSessions(db)
  const settings = new SettingsCache(registry)
  const socket = new SocketHub(tokens, users, registry)

  const ctx: Context = { cfg, db, registry, tokens, users, progress, sessions, socket, settings, absVersion: ABS_VERSION }

  await settings.start()
  for (const s of servers) {
    try {
      const status = await s.get<{ serverVersion: string }>('/status')
      log.info(`[upstream:${s.key}] ${s.url} is Audiobookshelf ${status.serverVersion}`)
    } catch (err) {
      log.warn(`[upstream:${s.key}] ${s.url} unreachable:`, (err as Error).message)
    }
  }

  const app = createApp(ctx)
  const server = http.createServer(app)
  socket.attach(server, BASE_PATH)
  server.listen(cfg.port, () => log.info(`ShelfMerge listening on :${cfg.port}, base path "${BASE_PATH || '/'}" (${servers.length} upstream server${servers.length === 1 ? '' : 's'})`))

  const shutdown = async () => {
    log.info('shutting down')
    settings.stop()
    await socket.close()
    server.close()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  log.error('fatal:', err)
  process.exit(1)
})
