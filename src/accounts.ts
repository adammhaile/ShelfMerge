import type { Context } from './context.js'
import type { UserRow } from './db.js'
import type { UpstreamServer } from './upstream/server.js'
import type { OldMediaProgress, ProgressPayload } from './progress.js'
import { log } from './logger.js'

/**
 * Personal upstream accounts. A ShelfMerge user may hold their own API key
 * for a server; requests to that server are then made as them, and their
 * progress on that server is mirrored into ShelfMerge and back.
 */
export class Accounts {
  private timer: NodeJS.Timeout | null = null
  private readonly pulling = new Set<string>()

  constructor(private readonly ctx: Context) {}

  /**
   * The server to call for this user: their own account when mapped, else
   * the service account. Unauthenticated requests (cover images) have no
   * user and always use the service account.
   */
  upstream(user: Pick<UserRow, 'username'> | undefined, server: UpstreamServer): UpstreamServer {
    const key = user ? this.ctx.users.config(user)?.accounts[server.key] : undefined
    return key ? server.withKey(key) : server
  }

  hasAccount(user: Pick<UserRow, 'username'> | undefined, serverKey: string): boolean {
    return !!user && !!this.ctx.users.config(user)?.accounts[serverKey]
  }

  start(intervalMs = 5 * 60 * 1000) {
    this.timer = setInterval(() => this.pullAll().catch(() => {}), intervalMs)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  private async pullAll() {
    for (const u of this.ctx.cfg.users) {
      if (!Object.keys(u.accounts).length) continue
      const user = this.ctx.users.byUsername(u.username)
      if (user) await this.pull(user)
    }
  }

  /**
   * Bring progress the user made natively on their own servers into
   * ShelfMerge. Newer wins, by lastUpdate; ShelfMerge's own newer rows are
   * already upstream through write-through, so nothing is pushed here.
   */
  async pull(user: UserRow): Promise<number> {
    const accounts = this.ctx.users.config(user)?.accounts ?? {}
    if (this.pulling.has(user.id)) return 0
    this.pulling.add(user.id)
    let changed = 0
    try {
      for (const [serverKey, apiKey] of Object.entries(accounts)) {
        const server = this.ctx.registry.server(serverKey)
        if (!server) continue
        let me: { mediaProgress?: OldMediaProgress[] }
        try {
          me = await server.withKey(apiKey).get<{ mediaProgress?: OldMediaProgress[] }>('/api/me')
        } catch (err) {
          log.warn(`[accounts] ${user.username}@${serverKey}: pull failed:`, (err as Error).message)
          continue
        }
        for (const mp of me.mediaProgress ?? []) {
          if (!mp.libraryItemId || !mp.mediaItemId) continue
          const local = this.ctx.progress.get(user.id, mp.libraryItemId, mp.episodeId ?? null)
          if (local && local.lastUpdate >= mp.lastUpdate) continue
          this.ctx.registry.record(mp.libraryItemId, serverKey, 'item', mp.episodeId ? null : mp.mediaItemId)
          this.ctx.progress.importSnapshot(user.id, serverKey, mp)
          changed++
        }
      }
    } finally {
      this.pulling.delete(user.id)
    }
    if (changed) {
      log.info(`[accounts] ${user.username}: pulled ${changed} progress update${changed === 1 ? '' : 's'} from own account${Object.keys(accounts).length === 1 ? '' : 's'}`)
      this.ctx.socket.emitToUser(user.id, 'user_updated', this.ctx.users.toOldJSON(user))
    }
    return changed
  }

  /**
   * Mirror a progress change made through ShelfMerge (manual mark finished,
   * reset, hide from continue listening...) to the user's own account on the
   * item's server. Playback syncs need no mirroring: sessions on mapped
   * servers already run as the user.
   */
  async writeThrough(user: UserRow, serverKey: string, payload: ProgressPayload) {
    const apiKey = this.ctx.users.config(user)?.accounts[serverKey]
    const server = this.ctx.registry.server(serverKey)
    if (!apiKey || !server) return
    const { libraryItemId, episodeId, markAsFinishedTimeRemaining, markAsFinishedPercentComplete, createdAt, ...body } = payload
    const path = `/api/me/progress/${libraryItemId}${episodeId ? `/${episodeId}` : ''}`
    const r = await server.withKey(apiKey).json(path, { method: 'PATCH', body }).catch((err: Error) => ({ status: 0, text: err.message }))
    if (r.status < 200 || r.status >= 300) log.warn(`[accounts] ${user.username}@${serverKey}: write-through ${path} failed (${r.status}) ${r.text?.slice(0, 80)}`)
  }
}
