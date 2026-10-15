import { describe, it, expect } from 'vitest'
import bcrypt from 'bcryptjs'
import { openDb } from '../../src/db.js'
import { TokenManager } from '../../src/auth/tokens.js'
import { ProgressStore } from '../../src/progress.js'
import { UserStore } from '../../src/users.js'
import type { Config, UserConfig } from '../../src/config.js'

const cfgWith = (users: Array<Partial<UserConfig> & { username: string }>) =>
  ({ accessTokenExpiry: 3600, refreshTokenExpiry: 86400, refreshTokenGracePeriod: 60, users: users.map((u) => ({ password: null, admin: false, libraries: null, accounts: {}, ...u })) }) as unknown as Config

function make() {
  const db = openDb(':memory:')
  const tokens = new TokenManager(db, cfgWith([]))
  return new UserStore(db, tokens, new ProgressStore(db))
}

describe('UserStore.syncFromConfig', () => {
  it('creates a user from a plain initial password and does not revert a UI change', () => {
    const users = make()
    users.syncFromConfig(cfgWith([{ username: 'adam', password: 'first' }]))
    expect(users.authenticate('adam', 'first')).not.toBeNull()
    users.setPassword(users.byUsername('adam')!.id, 'changed-in-ui')
    users.syncFromConfig(cfgWith([{ username: 'adam', password: 'first' }]))
    expect(users.authenticate('adam', 'first')).toBeNull()
    expect(users.authenticate('adam', 'changed-in-ui')).not.toBeNull()
  })

  it('applies a config hash when the config changes it, but keeps a UI change otherwise', () => {
    const users = make()
    const h1 = bcrypt.hashSync('one', 4)
    users.syncFromConfig(cfgWith([{ username: 'adam', password: h1 }]))
    expect(users.authenticate('adam', 'one')).not.toBeNull()
    users.setPassword(users.byUsername('adam')!.id, 'ui')
    users.syncFromConfig(cfgWith([{ username: 'adam', password: h1 }]))
    expect(users.authenticate('adam', 'ui')).not.toBeNull()
    const h2 = bcrypt.hashSync('two', 4)
    users.syncFromConfig(cfgWith([{ username: 'adam', password: h2 }]))
    expect(users.authenticate('adam', 'ui')).toBeNull()
    expect(users.authenticate('adam', 'two')).not.toBeNull()
  })

  it('only lets config-listed or admin-created users log in, and honours deactivation', () => {
    const users = make()
    users.syncFromConfig(cfgWith([{ username: 'adam', password: 'pw', admin: true }]))
    const friend = users.create('friend', 'pw')
    expect(users.authenticate('friend', 'pw')).not.toBeNull()
    expect(users.isAdmin(users.byUsername('adam')!)).toBe(true)
    expect(users.isAdmin(friend)).toBe(false)
    users.setActive(friend.id, false)
    expect(users.authenticate('friend', 'pw')).toBeNull()
    users.syncFromConfig(cfgWith([{ username: 'someone-else', password: 'x' }]))
    expect(users.authenticate('adam', 'pw')).toBeNull()
    expect(users.byId(users.byUsername('adam')!.id)).toBeUndefined()
  })
})
