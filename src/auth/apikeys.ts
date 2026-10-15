import { v4 as uuidv4 } from 'uuid'
import type { Db, ApiKeyRow } from '../db.js'
import type { TokenManager } from './tokens.js'

/**
 * API keys issued by ShelfMerge, for dashboards and scripts that talk to it
 * as a user without logging in. Same token shape as upstream's, so anything
 * built for Audiobookshelf's keys works.
 */
export class ApiKeyStore {
  constructor(
    private readonly db: Db,
    private readonly tokens: TokenManager
  ) {
    tokens.apiKeyResolver = (keyId) => {
      const row = this.get(keyId)
      if (!row) return undefined
      this.db.prepare('UPDATE api_keys SET lastUsedAt = ? WHERE id = ?').run(Date.now(), keyId)
      return { userId: row.userId, isActive: !!row.isActive, expiresAt: row.expiresAt }
    }
  }

  all(): ApiKeyRow[] {
    return this.db.prepare('SELECT * FROM api_keys ORDER BY createdAt').all() as ApiKeyRow[]
  }

  get(id: string): ApiKeyRow | undefined {
    return this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow | undefined
  }

  /** Create a key; the token is returned once, like upstream. */
  create(name: string, userId: string, createdByUserId: string, opts: { expiresIn?: number | null; isActive?: boolean } = {}): { row: ApiKeyRow; token: string } {
    const now = Date.now()
    const row: ApiKeyRow = { id: uuidv4(), name, userId, isActive: opts.isActive === false ? 0 : 1, expiresAt: opts.expiresIn && opts.expiresIn > 0 ? now + opts.expiresIn * 1000 : null, lastUsedAt: null, createdByUserId, createdAt: now, updatedAt: now }
    this.db.prepare('INSERT INTO api_keys (id, name, userId, isActive, expiresAt, lastUsedAt, createdByUserId, createdAt, updatedAt) VALUES (@id, @name, @userId, @isActive, @expiresAt, @lastUsedAt, @createdByUserId, @createdAt, @updatedAt)').run(row)
    return { row, token: this.tokens.apiKeyToken(row.id, name, opts.expiresIn) }
  }

  update(id: string, patch: { isActive?: boolean; userId?: string }): ApiKeyRow | undefined {
    const row = this.get(id)
    if (!row) return undefined
    const next = { ...row, isActive: patch.isActive === undefined ? row.isActive : patch.isActive ? 1 : 0, userId: patch.userId ?? row.userId, updatedAt: Date.now() }
    this.db.prepare('UPDATE api_keys SET isActive = @isActive, userId = @userId, updatedAt = @updatedAt WHERE id = @id').run(next)
    return next
  }

  remove(id: string) {
    this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id)
  }

  removeForUser(userId: string) {
    this.db.prepare('DELETE FROM api_keys WHERE userId = ?').run(userId)
  }
}
