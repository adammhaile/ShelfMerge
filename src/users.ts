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
  type: 'user'
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

export class UserStore {
  private readonly configs = new Map<string, UserConfig>()

  constructor(
    private readonly db: Db,
    private readonly tokens: TokenManager,
    private readonly progress: ProgressStore
  ) {}

  /** The config entry for a user (library allow-list lives there). */
  config(user: Pick<UserRow, 'username'>): UserConfig | undefined {
    return this.configs.get(user.username)
  }

  /** Create or update local users from config. Passwords are bcrypt-hashed at rest. */
  syncFromConfig(cfg: Config) {
    this.configs.clear()
    for (const u of cfg.users) {
      this.configs.set(u.username, u)
      const existing = this.byUsername(u.username)
      if (!existing) {
        this.db.prepare('INSERT INTO users (id, username, passwordHash, createdAt) VALUES (?, ?, ?, ?)').run(uuidv4(), u.username, bcrypt.hashSync(u.password, 10), Date.now())
        log.info(`[users] created user "${u.username}"`)
      } else if (!bcrypt.compareSync(u.password, existing.passwordHash)) {
        this.db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(bcrypt.hashSync(u.password, 10), existing.id)
        this.tokens.invalidateAllForUser(existing.id)
        log.info(`[users] password changed for "${u.username}", sessions invalidated`)
      }
    }
  }

  /**
   * A user removed from the config keeps their rows (progress, history) but
   * can no longer log in or use existing tokens.
   */
  byId(id: string): UserRow | undefined {
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
    return user && this.configs.has(user.username) ? user : undefined
  }

  byUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined
  }

  authenticate(username: string, password: string): UserRow | null {
    if (!this.configs.has(username)) return null
    const user = this.byUsername(username)
    if (!user || !bcrypt.compareSync(password, user.passwordHash)) return null
    return user
  }

  setPassword(userId: string, password: string) {
    this.db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), userId)
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
      type: 'user',
      token: this.tokens.legacyToken(user),
      mediaProgress: this.progress.allForUser(user.id),
      seriesHideFromContinueListening: this.seriesHidden(user.id),
      bookmarks: this.progress.bookmarksForUser(user.id),
      isActive: true,
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
