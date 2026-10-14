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
      `INSERT INTO id_map (id, serverKey, kind, mediaId, seenAt) VALUES (@id, @serverKey, @kind, @mediaId, @seenAt)
       ON CONFLICT(id) DO UPDATE SET serverKey = excluded.serverKey, kind = COALESCE(excluded.kind, id_map.kind), mediaId = COALESCE(excluded.mediaId, id_map.mediaId), seenAt = excluded.seenAt`
    )
    this.selectOne = db.prepare('SELECT id, serverKey, kind, mediaId FROM id_map WHERE id = ?')
  }

  get all(): UpstreamServer[] {
    return [...this.servers.values()]
  }

  get default(): UpstreamServer {
    return this.servers.values().next().value as UpstreamServer
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

  record(id: string, serverKey: string, kind: string | null = null, mediaId: string | null = null) {
    const row: IdMapRow = { id, serverKey, kind, mediaId }
    const prev = this.cache.get(id)
    if (prev && prev.serverKey === serverKey && (kind === null || prev.kind === kind) && (mediaId === null || prev.mediaId === mediaId)) return
    this.cache.set(id, { ...prev, ...row, kind: kind ?? prev?.kind ?? null, mediaId: mediaId ?? prev?.mediaId ?? null })
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
      if (typeof obj.mediaType === 'string' && obj.media && typeof obj.media === 'object') {
        kind = 'item'
        const m = (obj.media as Record<string, unknown>).id
        if (typeof m === 'string') mediaId = m
      } else if (Array.isArray(obj.folders)) kind = 'library'
      else if ('libraryItemId' in obj && 'audioTracks' in obj) kind = 'session'
      else if ('books' in obj && 'libraryId' in obj) kind = 'collection'
      else if ('items' in obj && 'userId' in obj) kind = 'playlist'
      else if ('numBooks' in obj || ('imagePath' in obj && 'name' in obj)) kind = 'author'
      else if ('sequence' in obj && 'name' in obj) kind = 'series'
      this.record(id, serverKey, kind, mediaId)
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') this.walk(serverKey, value, depth + 1)
    }
  }
}
