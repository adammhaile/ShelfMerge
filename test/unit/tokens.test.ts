import { describe, it, expect } from 'vitest'
import type { Request } from 'express'
import { openDb } from '../../src/db.js'
import { TokenManager } from '../../src/auth/tokens.js'
import type { Config } from '../../src/config.js'
import type { UserRow } from '../../src/db.js'

const cfg = { accessTokenExpiry: 3600, refreshTokenExpiry: 86400, refreshTokenGracePeriod: 60 } as Config
const req = { ip: '127.0.0.1', headers: { 'user-agent': 'test' } } as unknown as Request
const user: UserRow = { id: 'u1', username: 'adam', passwordHash: '', createdAt: 0, lastSeen: null }

/** Refreshing re-reads the user, so the row has to exist. */
const dbWithUser = () => {
  const db = openDb(':memory:')
  db.prepare('INSERT INTO users (id, username, passwordHash, createdAt) VALUES (?, ?, ?, ?)').run(user.id, user.username, 'x', 0)
  return db
}

describe('TokenManager', () => {
  it('issues verifiable access tokens and refuses refresh tokens as access tokens', () => {
    const tm = new TokenManager(dbWithUser(), cfg)
    const { accessToken, refreshToken } = tm.createSession(user, req)
    expect(TokenManager.isAccess(tm.verify(accessToken))).toBe(true)
    expect(TokenManager.isAccess(tm.verify(refreshToken))).toBe(false)
    expect(tm.verify('garbage')).toBeNull()
    expect(TokenManager.isAccess(tm.verify(tm.legacyToken(user)))).toBe(true)
  })

  it('rotates refresh tokens and honours the grace window once', () => {
    const tm = new TokenManager(dbWithUser(), cfg)
    const { refreshToken } = tm.createSession(user, req)
    const r1 = tm.refresh(refreshToken, req)
    expect('error' in r1).toBe(false)
    const rotated = (r1 as { refreshToken: string }).refreshToken
    expect(rotated).not.toBe(refreshToken)
    // The previous token still works inside the grace period and returns the current pair.
    const r2 = tm.refresh(refreshToken, req)
    expect((r2 as { refreshToken: string }).refreshToken).toBe(rotated)
    // A token that was never issued is rejected.
    expect('error' in tm.refresh(tm.refreshToken(user), req)).toBe(true)
  })

  it('invalidates sessions on logout and on password change', () => {
    const tm = new TokenManager(dbWithUser(), cfg)
    const a = tm.createSession(user, req)
    const b = tm.createSession(user, req)
    tm.invalidate(a.refreshToken)
    expect('error' in tm.refresh(a.refreshToken, req)).toBe(true)
    expect('error' in tm.refresh(b.refreshToken, req)).toBe(false)
    tm.invalidateAllForUser(user.id)
    expect('error' in tm.refresh((tm.refresh(b.refreshToken, req) as { refreshToken?: string }).refreshToken ?? b.refreshToken, req)).toBe(true)
  })

  it('persists its secret so tokens survive a restart', () => {
    const db = openDb(':memory:')
    const t1 = new TokenManager(db, cfg)
    const token = t1.accessToken(user)
    const t2 = new TokenManager(db, cfg)
    expect(t2.verify(token)?.userId).toBe('u1')
  })
})
