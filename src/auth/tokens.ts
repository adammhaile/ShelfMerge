import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
import type { Request } from 'express'
import type { Db, AuthSessionRow, UserRow } from '../db.js'
import { kvGet, kvSet } from '../db.js'
import type { Config } from '../config.js'

export interface AccessPayload {
  userId: string
  username: string
  jti?: string
  type?: 'access' | 'refresh'
  exp?: number
  iat?: number
}

/**
 * Mirrors Audiobookshelf's TokenManager: short-lived access JWT, long-lived
 * refresh JWT stored per session, refresh rotation with a grace window for
 * clients that lose the rotation response. Clients cannot tell the
 * difference, which is the point.
 */
export class TokenManager {
  readonly secret: string

  constructor(
    private readonly db: Db,
    private readonly cfg: Config
  ) {
    let secret = process.env.SHELFMERGE_TOKEN_SECRET ?? kvGet(db, 'tokenSecret')
    if (!secret) {
      secret = crypto.randomBytes(32).toString('base64')
      kvSet(db, 'tokenSecret', secret)
    }
    this.secret = secret
  }

  /** Legacy non-expiring token Audiobookshelf still exposes as `user.token`. */
  legacyToken(user: Pick<UserRow, 'id' | 'username'>) {
    return jwt.sign({ userId: user.id, username: user.username }, this.secret)
  }

  accessToken(user: Pick<UserRow, 'id' | 'username'>) {
    return jwt.sign({ userId: user.id, username: user.username, jti: uuidv4(), type: 'access' }, this.secret, { expiresIn: this.cfg.accessTokenExpiry })
  }

  refreshToken(user: Pick<UserRow, 'id' | 'username'>) {
    return jwt.sign({ userId: user.id, username: user.username, jti: uuidv4(), type: 'refresh' }, this.secret, { expiresIn: this.cfg.refreshTokenExpiry })
  }

  /** Decode without throwing. Expiry is checked by callers, like upstream. */
  verify(token: string): AccessPayload | null {
    try {
      return jwt.verify(token, this.secret, { ignoreExpiration: true }) as AccessPayload
    } catch {
      return null
    }
  }

  /** True when a decoded token may authenticate API or socket calls. */
  static isAccess(p: AccessPayload | null): p is AccessPayload {
    if (!p?.userId) return false
    if (p.type === 'refresh') return false
    if (p.exp && p.exp < Date.now() / 1000) return false
    return true
  }

  createSession(user: UserRow, req: Request) {
    const accessToken = this.accessToken(user)
    const refreshToken = this.refreshToken(user)
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO auth_sessions (id, userId, refreshToken, expiresAt, ipAddress, userAgent, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(uuidv4(), user.id, refreshToken, now + this.cfg.refreshTokenExpiry * 1000, req.ip ?? null, req.headers['user-agent'] ?? null, now, now)
    return { accessToken, refreshToken }
  }

  /**
   * Validate a refresh token and rotate it. Returns the new pair or an error
   * string. The previous token stays valid for a grace period and returns the
   * already-rotated pair, so a retried request after a dropped response still
   * recovers the session.
   */
  refresh(refreshToken: string, req: Request): { accessToken: string; refreshToken: string; user: UserRow } | { error: string } {
    const payload = this.verify(refreshToken)
    if (!payload || payload.type !== 'refresh') return { error: 'Invalid refresh token' }
    if (payload.exp && payload.exp < Date.now() / 1000) {
      this.db.prepare('DELETE FROM auth_sessions WHERE refreshToken = ?').run(refreshToken)
      return { error: 'Refresh token expired' }
    }
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(payload.userId) as UserRow | undefined
    if (!user) return { error: 'User not found' }

    const now = Date.now()
    let session = this.db.prepare('SELECT * FROM auth_sessions WHERE refreshToken = ?').get(refreshToken) as AuthSessionRow | undefined
    if (!session) {
      session = this.db.prepare('SELECT * FROM auth_sessions WHERE lastRefreshToken = ? AND lastRefreshTokenExpiresAt > ?').get(refreshToken, now) as AuthSessionRow | undefined
      if (!session) return { error: 'Invalid refresh token' }
      // Within the grace window: hand back the current pair without rotating again.
      return { accessToken: this.accessToken(user), refreshToken: session.refreshToken, user }
    }
    if (session.expiresAt < now) {
      this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(session.id)
      return { error: 'Refresh token expired' }
    }

    const newRefresh = this.refreshToken(user)
    this.db
      .prepare(
        `UPDATE auth_sessions SET refreshToken = ?, expiresAt = ?, lastRefreshToken = ?, lastRefreshTokenExpiresAt = ?, updatedAt = ?, ipAddress = ?, userAgent = ? WHERE id = ?`
      )
      .run(newRefresh, now + this.cfg.refreshTokenExpiry * 1000, refreshToken, now + this.cfg.refreshTokenGracePeriod * 1000, now, req.ip ?? null, req.headers['user-agent'] ?? null, session.id)
    return { accessToken: this.accessToken(user), refreshToken: newRefresh, user }
  }

  invalidate(refreshToken: string) {
    this.db.prepare('DELETE FROM auth_sessions WHERE refreshToken = ? OR lastRefreshToken = ?').run(refreshToken, refreshToken)
  }

  invalidateAllForToken(refreshToken: string) {
    const payload = this.verify(refreshToken)
    if (payload?.userId) this.db.prepare('DELETE FROM auth_sessions WHERE userId = ?').run(payload.userId)
  }

  invalidateAllForUser(userId: string) {
    this.db.prepare('DELETE FROM auth_sessions WHERE userId = ?').run(userId)
  }
}
