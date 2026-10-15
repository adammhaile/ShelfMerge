import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, parseConfig, fetchConfigText, isConfigUrl, type Config } from './config.js'
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
import { IndexStore } from './index/store.js'
import { IndexQuery } from './index/query.js'
import { Indexer } from './index/sync.js'
import { Accounts } from './accounts.js'
import { SocketHub } from './socket/hub.js'
import { createApp, BASE_PATH } from './app.js'
import { relabel } from './routes/merged.js'
import type { Context } from './context.js'
import { log } from './logger.js'

/** Version of the Audiobookshelf web client bundled with the image. */
const ABS_VERSION = process.env.ABS_VERSION ?? '2.37.1'
const CONFIG_SOURCE = process.env.SHELFMERGE_CONFIG ?? 'config/shelfmerge.yaml'
/** Seconds between checks of a URL config (file configs are polled every 2 s). */
const CONFIG_POLL_S = Number(process.env.SHELFMERGE_CONFIG_POLL) > 0 ? Number(process.env.SHELFMERGE_CONFIG_POLL) : 60
let lastConfigText = ''

async function readConfig(): Promise<Config> {
  if (isConfigUrl(CONFIG_SOURCE)) {
    lastConfigText = await fetchConfigText(CONFIG_SOURCE)
    return parseConfig(lastConfigText)
  }
  return loadConfig(CONFIG_SOURCE)
}

/** Events whose payload is a library item (or a list of them) with a libraryId. */
const ITEM_EVENTS = /^(item_added|item_updated|item_removed|items_added|items_updated)$/

async function main() {
  const cfg = await readConfig()
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
  const indexStore = new IndexStore(db, () => catalog.sortingPrefixes)
  const indexQuery = new IndexQuery(indexStore, progress, () => catalog.sortingPrefixes, () => catalog.sortingIgnorePrefix)
  const indexer = new Indexer(indexStore, registry, catalog, () => catalog.sortingPrefixes)
  const socket = new SocketHub(tokens, users, registry)

  socket.onUpstreamEvent = (serverKey, event, payload) => {
    // Library events carry upstream names; present them like /api/libraries does,
    // and refresh the cached list so new or renamed libraries show up at once.
    if (/^library_(added|updated|removed)$/.test(event)) {
      catalog.refreshServer(serverKey).catch(() => {})
      if (event === 'library_removed') indexer.onEvent(serverKey, event, payload)
      if (payload && typeof payload === 'object' && 'id' in payload && 'name' in payload) return catalog.decorate(serverKey, payload as never)
      return payload
    }
    indexer.onEvent(serverKey, event, payload)
    // Item events: clients ignore events for libraries they are not viewing, so
    // echo each one under every merged library that contains the item's library.
    if (ITEM_EVENTS.test(event)) {
      const list = Array.isArray(payload) ? (payload as Array<{ libraryId?: string }>) : [payload as { libraryId?: string }]
      const sourceIds = new Set(list.map((li) => li?.libraryId).filter((x): x is string => !!x))
      for (const id of sourceIds) indexQuery.invalidate(id)
      const variants: unknown[] = [payload]
      const mergedIds = new Set<string>()
      for (const id of sourceIds) for (const m of catalog.mergedContaining(id)) mergedIds.add(m.id)
      for (const mid of mergedIds) variants.push(Array.isArray(payload) ? list.map((li) => relabel(li, mid)) : relabel(payload as { libraryId?: unknown }, mid))
      return variants
    }
    if (/^(series|author)_/.test(event)) indexQuery.invalidate()
    return payload
  }

  const ctx = { cfg, db, registry, tokens, users, progress, sessions, socket, catalog, history, collections, indexStore, indexQuery, indexer, lastLibrary: new Map(), absVersion: ABS_VERSION } as Context
  ctx.accounts = new Accounts(ctx)

  await catalog.start()
  ctx.accounts.start()
  for (const s of servers) {
    try {
      const status = await s.get<{ serverVersion: string }>('/status')
      log.info(`[upstream:${s.key}] ${s.url} is Audiobookshelf ${status.serverVersion}`)
    } catch (err) {
      log.warn(`[upstream:${s.key}] ${s.url} unreachable:`, (err as Error).message)
    }
  }
  for (const m of catalog.mergedLibraries()) log.info(`[catalog] merged library "${m.name}" (${m.id}) <- ${m.sources!.map((s) => `${s.serverKey}/${s.libraryId.slice(0, 8)}`).join(', ') || 'no sources'}`)

  const app = createApp(ctx)
  const server = http.createServer(app)
  socket.attach(server, BASE_PATH)
  server.listen(cfg.port, () => log.info(`ShelfMerge listening on :${cfg.port}, base path "${BASE_PATH || '/'}" (${servers.length} upstream server${servers.length === 1 ? '' : 's'})`))

  // The index fills in the background; merged libraries serve whatever is indexed so far.
  indexer
    .start()
    .then(() => indexQuery.invalidate())
    .catch((err) => log.warn('[index] initial pull failed:', (err as Error).message))

  watchConfig(ctx)

  const shutdown = async () => {
    log.info('shutting down')
    catalog.stop()
    indexer.stop()
    ctx.accounts.stop()
    await socket.close()
    server.close()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/**
 * Re-read the config when the file changes: users, servers and merged
 * libraries can be added, removed or re-keyed without a restart. Port and
 * data paths need one.
 */
function watchConfig(ctx: Context) {
  const apply = (next: Config) => {
    ctx.cfg.users = next.users
    ctx.cfg.prefixLibraryNames = next.prefixLibraryNames
    ctx.cfg.allowPasswordChange = next.allowPasswordChange
    ctx.cfg.merged = next.merged
    ctx.users.syncFromConfig(next)
    const change = ctx.registry.setServers(next.servers.map((s) => new UpstreamServer(s)))
    ctx.cfg.servers = next.servers
    if (change.added.length || change.removed.length || change.changed.length) {
      log.info(`[config] servers added=${change.added.join(',') || '-'} removed=${change.removed.join(',') || '-'} changed=${change.changed.join(',') || '-'}`)
      ctx.socket.reconnectUpstreams()
    }
    ctx.catalog
      .refreshAll()
      .then(() => ctx.indexer.reconcileAll(60 * 60 * 1000))
      .then(() => ctx.indexQuery.invalidate())
      .catch(() => {})
    log.info(`[config] reloaded: ${next.servers.length} servers, ${next.users.length} users, ${next.merged.length} merged libraries`)
  }
  const failed = (err: unknown) => log.error(`[config] reload failed, keeping current config:`, (err as Error).message)

  if (isConfigUrl(CONFIG_SOURCE)) {
    // Shared config served over HTTP (several instances in different regions): re-fetch on a timer, apply when the text changed.
    const poll = async () => {
      try {
        const text = await fetchConfigText(CONFIG_SOURCE)
        if (text === lastConfigText) return
        const next = parseConfig(text)
        lastConfigText = text
        apply(next)
      } catch (err) {
        failed(err)
      }
    }
    const t = setInterval(() => poll().catch(() => {}), CONFIG_POLL_S * 1000)
    t.unref()
    log.info(`[config] polling ${CONFIG_SOURCE} every ${CONFIG_POLL_S}s`)
    return
  }

  const file = path.resolve(CONFIG_SOURCE)
  let timer: NodeJS.Timeout | null = null
  const reload = () => {
    try {
      apply(loadConfig(file))
    } catch (err) {
      failed(err)
    }
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

// A bug in one async route handler must not take the whole proxy down:
// log it and keep serving. (Express 4 does not catch async errors itself.)
process.on('unhandledRejection', (reason) => {
  log.error('[unhandled rejection]', reason instanceof Error ? reason.stack ?? reason.message : reason)
})
process.on('uncaughtException', (err) => {
  log.error('[uncaught exception]', err.stack ?? err.message)
})

main().catch((err) => {
  log.error('fatal:', err)
  process.exit(1)
})
