import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import type { Db, UserRow } from './db.js'
import type { Config, UserConfig } from './config.js'
import type { ProgressStore } from './progress.js'
import type { TokenManager } from './auth/tokens.js'
import { log } from './logger.js'

export interface OldUserJSON {
  id: string
  username: string
  email: string | null
  type: 'user' | 'admin'
  token: string
  isOldToken?: boolean
  mediaProgress: unknown[]
  seriesHideFromContinueListening: string[]
  bookmarks: unknown[]
  isActive: boolean
  isLocked: boolean
  lastSeen: number | null
  createdAt: number
  permissions: Record<string, boolean>
  librariesAccessible: string[]
  itemTagsSelected: string[]
  hasOpenIDLink: boolean
  accessToken?: string
  refreshToken?: string | null
}

/**
 * Permissions a ShelfMerge user reports to clients. `update` stays off so the
 * stock UI hides editing controls; it also hides "add to collection" (the
 * client gates both on the same flag), which we accept since playlists cover
 * the per-user case. The collection routes remain available to the API. The
 * forwarder refuses every upstream write regardless of this flag.
 */
export const USER_PERMISSIONS = {
  download: true,
  update: false,
  delete: false,
  upload: false,
  createEreader: false,
  accessAllLibraries: true,
  accessAllTags: true,
  accessExplicitContent: true,
  selectedTagsNotAccessible: false
}

const isBcrypt = (s: string | null | undefined) => !!s && /^\$2[aby]\$\d\d\$/.test(s)

/**
 * ShelfMerge users. Those listed in the config may log in and carry their
 * allow-lists and own-account keys there; users created by an admin from
 * the web UI live only in the database and see every library.
 */
export class UserStore {
  private readonly configs = new Map<string, UserConfig>()

  constructor(
    private readonly db: Db,
    private readonly tokens: TokenManager,
    private readonly progress: ProgressStore
  ) {}

  /** Effective config for a user: the YAML entry, or defaults for an admin-created user. */
  config(user: Pick<UserRow, 'username'>): UserConfig | undefined {
    const c = this.configs.get(user.username)
    if (c) return c
    const row = this.byUsername(user.username)
    if (row?.source === 'admin') return { username: row.username, password: null, admin: false, libraries: null, accounts: {} }
    return undefined
  }

  isAdmin(user: Pick<UserRow, 'username'>): boolean {
    return !!this.configs.get(user.username)?.admin
  }

  /**
   * Create local users from config. The config password only seeds a new
   * user (plain text or bcrypt hash); afterwards the database copy wins, so
   * passwords changed in the web UI or with the CLI stick. A bcrypt hash in
   * the config that differs from the stored one is applied, which is the
   * declarative way to reset a password.
   */
  syncFromConfig(cfg: Config) {
    this.configs.clear()
    for (const u of cfg.users) {
      this.configs.set(u.username, u)
      const existing = this.byUsername(u.username)
      const hash = isBcrypt(u.password)
      if (!existing) {
        if (!u.password) {
          log.warn(`[users] "${u.username}" has no password yet; set one from the Users page or with: npm run user -- passwd ${u.username}`)
          this.insert(u.username, '', 'config')
          continue
        }
        this.insert(u.username, hash ? u.password! : bcrypt.hashSync(u.password, 10), 'config', hash ? u.password! : null)
        log.info(`[users] created user "${u.username}"`)
      } else {
        if (existing.source !== 'config') this.db.prepare("UPDATE users SET source = 'config' WHERE id = ?").run(existing.id)
        // A hash in the config is applied when the *config* changed it, not merely
        // because it differs from the stored one: a password changed in the UI stays.
        if (hash && existing.configHash !== u.password) {
          this.db.prepare('UPDATE users SET passwordHash = ?, configHash = ? WHERE id = ?').run(u.password, u.password, existing.id)
          this.tokens.invalidateAllForUser(existing.id)
          log.info(`[users] password hash for "${u.username}" set from config, sessions invalidated`)
        } else if (!existing.passwordHash && u.password) {
          this.setPassword(existing.id, u.password)
          log.info(`[users] initial password set for "${u.username}"`)
        }
      }
    }
  }

  private insert(username: string, passwordHash: string, source: UserRow['source'], configHash: string | null = null): UserRow {
    const row = { id: uuidv4(), username, passwordHash, createdAt: Date.now(), source, configHash }
    this.db.prepare('INSERT INTO users (id, username, passwordHash, createdAt, source, configHash) VALUES (@id, @username, @passwordHash, @createdAt, @source, @configHash)').run(row)
    return this.byId(row.id)!
  }

  /** Users who may log in: listed in the config, or created by an admin. */
  private allowed(user: UserRow | undefined): UserRow | undefined {
    if (!user) return undefined
    return this.configs.has(user.username) || user.source === 'admin' ? user : undefined
  }

  all(): UserRow[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY username').all() as UserRow[]).filter((u) => this.allowed(u))
  }

  byId(id: string): UserRow | undefined {
    return this.allowed(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined)
  }

  byUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined
  }

  authenticate(username: string, password: string): UserRow | null {
    const user = this.allowed(this.byUsername(username))
    if (!user || !user.isActive || !user.passwordHash || !bcrypt.compareSync(password, user.passwordHash)) return null
    return user
  }

  /** Admin-created user; sees every library, no own-account keys. */
  create(username: string, password: string): UserRow {
    if (this.byUsername(username)) throw new Error('Username already taken')
    const row = this.insert(username, bcrypt.hashSync(password, 10), 'admin')
    log.info(`[users] admin created user "${username}"`)
    return row
  }

  setPassword(userId: string, password: string) {
    this.db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), userId)
  }

  setActive(userId: string, active: boolean) {
    this.db.prepare('UPDATE users SET isActive = ? WHERE id = ?').run(active ? 1 : 0, userId)
    if (!active) this.tokens.invalidateAllForUser(userId)
  }

  rename(userId: string, username: string) {
    this.db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, userId)
  }

  /** Remove an admin-created user and everything they own. */
  remove(userId: string) {
    this.db.transaction(() => {
      for (const t of ['auth_sessions', 'media_progress', 'bookmarks', 'user_extra', 'playback_sessions', 'listening_sessions', 'playlists', 'api_keys']) this.db.prepare(`DELETE FROM ${t} WHERE userId = ?`).run(userId)
      this.db.prepare('DELETE FROM users WHERE id = ?').run(userId)
    })()
  }

  touch(userId: string) {
    this.db.prepare('UPDATE users SET lastSeen = ? WHERE id = ?').run(Date.now(), userId)
  }

  seriesHidden(userId: string): string[] {
    const row = this.db.prepare('SELECT seriesHideFromContinueListening FROM user_extra WHERE userId = ?').get(userId) as { seriesHideFromContinueListening: string } | undefined
    return row ? (JSON.parse(row.seriesHideFromContinueListening) as string[]) : []
  }

  setSeriesHidden(userId: string, ids: string[]) {
    this.db
      .prepare('INSERT INTO user_extra (userId, seriesHideFromContinueListening) VALUES (?, ?) ON CONFLICT(userId) DO UPDATE SET seriesHideFromContinueListening = excluded.seriesHideFromContinueListening')
      .run(userId, JSON.stringify(ids))
  }

  /** Same shape as Audiobookshelf's User.toOldJSONForBrowser(). */
  toOldJSON(user: UserRow, minimal = false): OldUserJSON {
    const json: OldUserJSON = {
      id: user.id,
      username: user.username,
      email: null,
      type: this.isAdmin(user) ? 'admin' : 'user',
      token: this.tokens.legacyToken(user),
      mediaProgress: this.progress.allForUser(user.id),
      seriesHideFromContinueListening: this.seriesHidden(user.id),
      bookmarks: this.progress.bookmarksForUser(user.id),
      isActive: !!user.isActive,
      isLocked: false,
      lastSeen: user.lastSeen,
      createdAt: user.createdAt,
      permissions: { ...USER_PERMISSIONS },
      librariesAccessible: [],
      itemTagsSelected: [],
      hasOpenIDLink: false
    }
    if (minimal) {
      json.mediaProgress = []
      json.bookmarks = []
    }
    return json
  }
}
