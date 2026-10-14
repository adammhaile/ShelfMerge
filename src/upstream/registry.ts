import type { Db, IdMapRow } from '../db.js'
import type { UpstreamServer } from './server.js'
import { log } from '../logger.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PATH_ID_RE = /\/(?:items|libraries|authors|series|collections|playlists|podcasts|session|sessions|hls|share)\/([0-9a-f-]{36})(?=\/|$|\?)/i

/**
 * Knows which upstream server owns which id. Upstream ids are UUIDv4 and
 * are passed through to clients unchanged, so this map is the only state
 * needed to route a request. It is filled lazily from every JSON response
 * that passes through the proxy and persisted in SQLite so it survives
 * restarts.
 */
export class Registry {
  private readonly cache = new Map<string, IdMapRow>()
  private readonly servers = new Map<string, UpstreamServer>()
  private readonly upsert
  private readonly selectOne

  constructor(
    private readonly db: Db,
    servers: UpstreamServer[]
  ) {
    for (const s of servers) this.servers.set(s.key, s)
    this.upsert = db.prepare(
      `INSERT INTO id_map (id, serverKey, kind, mediaId, libraryId, seenAt) VALUES (@id, @serverKey, @kind, @mediaId, @libraryId, @seenAt)
       ON CONFLICT(id) DO UPDATE SET serverKey = excluded.serverKey, kind = COALESCE(excluded.kind, id_map.kind), mediaId = COALESCE(excluded.mediaId, id_map.mediaId),
       libraryId = COALESCE(excluded.libraryId, id_map.libraryId), seenAt = excluded.seenAt`
    )
    this.selectOne = db.prepare('SELECT id, serverKey, kind, mediaId, libraryId FROM id_map WHERE id = ?')
  }

  get all(): UpstreamServer[] {
    return [...this.servers.values()]
  }

  get default(): UpstreamServer {
    return this.servers.values().next().value as UpstreamServer
  }

  /** Replace the server set (config reload). Returns the keys that were added or changed. */
  setServers(servers: UpstreamServer[]): { added: string[]; removed: string[]; changed: string[] } {
    const added: string[] = []
    const changed: string[] = []
    const next = new Map(servers.map((s) => [s.key, s]))
    for (const s of servers) {
      const prev = this.servers.get(s.key)
      if (!prev) added.push(s.key)
      else if (prev.url !== s.url || prev.authHeader !== s.authHeader) changed.push(s.key)
    }
    const removed = [...this.servers.keys()].filter((k) => !next.has(k))
    this.servers.clear()
    for (const [k, s] of next) this.servers.set(k, s)
    return { added, removed, changed }
  }

  server(key: string): UpstreamServer | undefined {
    return this.servers.get(key)
  }

  lookup(id: string): IdMapRow | undefined {
    const cached = this.cache.get(id)
    if (cached) return cached
    const row = this.selectOne.get(id) as IdMapRow | undefined
    if (row) this.cache.set(id, row)
    return row
  }

  /** Server owning `id`, or undefined when never seen. */
  resolve(id: string): UpstreamServer | undefined {
    const row = this.lookup(id)
    return row ? this.servers.get(row.serverKey) : undefined
  }

  /**
   * Server for a request path such as /api/items/<id>/play. Falls back to
   * the default server when the path has no id or the id is unknown; with a
   * single upstream that is always right, with several it is the best guess.
   */
  resolvePath(path: string): UpstreamServer {
    const m = PATH_ID_RE.exec(path)
    if (m) {
      const s = this.resolve(m[1])
      if (s) return s
      log.debug(`[registry] unknown id ${m[1]} in ${path}, using default server`)
    }
    return this.default
  }

  /**
   * Like resolvePath, but an unknown item id is probed on every server
   * first. Happens when a client (typically a phone with downloads) asks for
   * an item the proxy has never relayed, e.g. after the map was lost.
   */
  async resolvePathAsync(path: string): Promise<UpstreamServer> {
    const m = PATH_ID_RE.exec(path)
    if (!m) return this.default
    const known = this.resolve(m[1])
    if (known) return known
    const kind = /\/(items|libraries|authors|series|collections|playlists|podcasts)\//.exec(path)?.[1]
    if (kind) {
      const probed = await this.probe(kind, m[1])
      if (probed) return probed
    }
    return this.default
  }

  private readonly probing = new Map<string, Promise<UpstreamServer | undefined>>()

  /** Ask each server whether it has `id`; remember and return the one that does. */
  async probe(kind: string, id: string): Promise<UpstreamServer | undefined> {
    const existing = this.probing.get(id)
    if (existing) return existing
    const apiKind = kind === 'podcasts' ? 'items' : kind
    const task = (async () => {
      const results = await Promise.all(
        this.all.map(async (s) => {
          try {
            const r = await s.json(`/api/${apiKind}/${id}`)
            if (r.status === 200 && r.json) {
              this.learn(s.key, r.json)
              this.record(id, s.key)
              return s
            }
          } catch {
            /* unreachable server: skip */
          }
          return undefined
        })
      )
      const found = results.find(Boolean)
      log.info(`[registry] probed ${kind} ${id}: ${found ? `on ${found.key}` : 'not found'}`)
      return found
    })()
    this.probing.set(id, task)
    try {
      return await task
    } finally {
      this.probing.delete(id)
    }
  }

  record(id: string, serverKey: string, kind: string | null = null, mediaId: string | null = null, libraryId: string | null = null) {
    const row: IdMapRow = { id, serverKey, kind, mediaId, libraryId }
    const prev = this.cache.get(id)
    if (prev && prev.serverKey === serverKey && (kind === null || prev.kind === kind) && (mediaId === null || prev.mediaId === mediaId) && (libraryId === null || prev.libraryId === libraryId)) return
    this.cache.set(id, { id, serverKey, kind: kind ?? prev?.kind ?? null, mediaId: mediaId ?? prev?.mediaId ?? null, libraryId: libraryId ?? prev?.libraryId ?? null })
    this.upsert.run({ ...row, seenAt: Date.now() })
  }

  /**
   * Walk any JSON payload that came from `serverKey` and remember every
   * UUID-shaped `id` in it. Library items additionally get their media id
   * recorded, which the progress store needs for `mediaItemId`.
   */
  learn(serverKey: string, payload: unknown) {
    const tx = this.db.transaction(() => this.walk(serverKey, payload, 0))
    tx()
  }

  private walk(serverKey: string, node: unknown, depth: number) {
    if (depth > 12 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) this.walk(serverKey, child, depth + 1)
      return
    }
    const obj = node as Record<string, unknown>
    const id = obj.id
    if (typeof id === 'string' && UUID_RE.test(id)) {
      let kind: string | null = null
      let mediaId: string | null = null
      let libraryId: string | null = null
      if (typeof obj.mediaType === 'string' && obj.media && typeof obj.media === 'object') {
        kind = 'item'
        const m = (obj.media as Record<string, unknown>).id
        if (typeof m === 'string') mediaId = m
        if (typeof obj.libraryId === 'string') libraryId = obj.libraryId
      } else if (Array.isArray(obj.folders)) kind = 'library'
      else if ('libraryItemId' in obj && 'audioTracks' in obj) kind = 'session'
      else if ('books' in obj && 'libraryId' in obj) kind = 'collection'
      else if ('items' in obj && 'userId' in obj) kind = 'playlist'
      else if ('numBooks' in obj || ('imagePath' in obj && 'name' in obj)) kind = 'author'
      else if ('sequence' in obj && 'name' in obj) kind = 'series'
      this.record(id, serverKey, kind, mediaId, libraryId)
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') this.walk(serverKey, value, depth + 1)
    }
  }
}
