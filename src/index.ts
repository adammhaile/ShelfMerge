import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { UpstreamServer } from './upstream/server.js'
import { Registry } from './upstream/registry.js'
import { Catalog } from './upstream/catalog.js'
import { TokenManager } from './auth/tokens.js'
import { ProgressStore } from './progress.js'
import { UserStore } from './users.js'
import { PlaybackSessions } from './sessions.js'
import { ListeningHistory } from './history.js'
import { CollectionStore } from './collections.js'
import { SocketHub } from './socket/hub.js'
import { createApp, BASE_PATH } from './app.js'
import type { Context } from './context.js'
import { log } from './logger.js'

/** Version of the Audiobookshelf web client bundled with the image. */
const ABS_VERSION = process.env.ABS_VERSION ?? '2.37.1'
const CONFIG_FILE = process.env.SHELFMERGE_CONFIG ?? 'config/shelfmerge.yaml'

async function main() {
  const cfg = loadConfig(CONFIG_FILE)
  const db = openDb(cfg.dataDir)
  const servers = cfg.servers.map((s) => new UpstreamServer(s))
  const registry = new Registry(db, servers)
  const tokens = new TokenManager(db, cfg)
  const progress = new ProgressStore(db)
  const users = new UserStore(db, tokens, progress)
  users.syncFromConfig(cfg)
  const sessions = new PlaybackSessions(db)
  const history = new ListeningHistory(db)
  const collections = new CollectionStore(db)
  const catalog = new Catalog(registry, cfg)
  const socket = new SocketHub(tokens, users, registry)

  // Library events carry upstream names; present them like /api/libraries does,
  // and refresh the cached list so new or renamed libraries show up at once.
  socket.onUpstreamEvent = (serverKey, event, payload) => {
    if (/^library_(added|updated|removed)$/.test(event)) {
      catalog.refreshServer(serverKey).catch(() => {})
      if (payload && typeof payload === 'object' && 'id' in payload && 'name' in payload) return catalog.decorate(serverKey, payload as never)
    }
    return payload
  }

  const ctx: Context = { cfg, db, registry, tokens, users, progress, sessions, socket, catalog, history, collections, absVersion: ABS_VERSION }

  await catalog.start()
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

  watchConfig(ctx)

  const shutdown = async () => {
    log.info('shutting down')
    catalog.stop()
    await socket.close()
    server.close()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/**
 * Re-read the config when the file changes: users and servers can be added,
 * removed or re-keyed without a restart. Port and data paths need one.
 */
function watchConfig(ctx: Context) {
  const file = path.resolve(CONFIG_FILE)
  let timer: NodeJS.Timeout | null = null
  const reload = () => {
    let next
    try {
      next = loadConfig(file)
    } catch (err) {
      log.error(`[config] reload failed, keeping current config:`, (err as Error).message)
      return
    }
    ctx.cfg.users = next.users
    ctx.cfg.prefixLibraryNames = next.prefixLibraryNames
    ctx.users.syncFromConfig(next)
    const change = ctx.registry.setServers(next.servers.map((s) => new UpstreamServer(s)))
    ctx.cfg.servers = next.servers
    if (change.added.length || change.removed.length || change.changed.length) {
      log.info(`[config] servers added=${change.added.join(',') || '-'} removed=${change.removed.join(',') || '-'} changed=${change.changed.join(',') || '-'}`)
      ctx.socket.reconnectUpstreams()
    }
    ctx.catalog.refreshAll().catch(() => {})
    log.info(`[config] reloaded: ${next.servers.length} servers, ${next.users.length} users`)
  }
  // Polling rather than inotify: it also works on bind mounts and network
  // filesystems (Docker volumes, WSL drvfs) where change events never arrive.
  fs.watchFile(file, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(reload, 500)
  })
  log.info(`[config] watching ${file}`)
}

main().catch((err) => {
  log.error('fatal:', err)
  process.exit(1)
})
