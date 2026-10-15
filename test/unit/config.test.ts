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
