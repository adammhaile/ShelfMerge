import { describe, it, expect } from 'vitest'
import { substituteEnv } from '../../src/config.js'

describe('substituteEnv', () => {
  it('replaces ${VAR} and ${VAR:-default}', () => {
    const env = { KEY: 'abc', EMPTY: '' }
    expect(substituteEnv('apiKey: ${KEY}', env)).toBe('apiKey: abc')
    expect(substituteEnv('x: ${MISSING:-fallback}', env)).toBe('x: fallback')
    expect(substituteEnv('x: ${EMPTY:-fallback}', env)).toBe('x: fallback')
    expect(substituteEnv('plain text $notavar {}', env)).toBe('plain text $notavar {}')
  })
  it('fails loudly on an unset variable without a default', () => {
    expect(() => substituteEnv('apiKey: ${NOPE}', {})).toThrow(/NOPE/)
  })
})

import { parseConfig, isConfigUrl } from '../../src/config.js'

describe('parseConfig', () => {
  const base = `
servers:
  a: { url: http://a.example/, apiKey: k1, label: A }
  b: { url: http://b.example, apiKey: k2 }
users:
  adam: { password: pw, admin: true, accounts: { a: own } }
  guest: { libraries: ['a:*', 'merged:Everything'] }
`
  it('parses servers, users, defaults and the default merged library', () => {
    const cfg = parseConfig(base)
    expect(cfg.servers.map((s) => [s.key, s.url, s.label])).toEqual([['a', 'http://a.example', 'A'], ['b', 'http://b.example', 'b']])
    expect(cfg.users.find((u) => u.username === 'adam')).toMatchObject({ admin: true, accounts: { a: 'own' }, libraries: null })
    expect(cfg.users.find((u) => u.username === 'guest')).toMatchObject({ password: null, admin: false, libraries: ['a:*', 'merged:Everything'] })
    expect(cfg.merged).toEqual([{ name: 'Everything', mediaType: 'book', sources: ['*'], collapseEditions: true, preferServers: ['a', 'b'], keepSeparate: [] }])
    expect(cfg.prefixLibraryNames).toBe(true)
  })
  it('rejects rules and accounts that name unknown servers', () => {
    expect(() => parseConfig(base + "  bad: { libraries: ['zzz:*'] }\n")).toThrow(/zzz/)
    expect(() => parseConfig(base + "  bad: { accounts: { zzz: k } }\n")).toThrow(/zzz/)
    expect(() => parseConfig(base + "merged:\n  - { name: X, preferServers: [zzz] }\n")).toThrow(/zzz/)
  })
  it('requires at least one server and one user', () => {
    expect(() => parseConfig('users: { a: { password: x } }')).toThrow(/server/)
    expect(() => parseConfig('servers: { a: { url: http://a, apiKey: k } }')).toThrow(/user/)
  })
  it('recognises URL sources', () => {
    expect(isConfigUrl('https://example.com/c.yaml')).toBe(true)
    expect(isConfigUrl('config/shelfmerge.yaml')).toBe(false)
  })
})
