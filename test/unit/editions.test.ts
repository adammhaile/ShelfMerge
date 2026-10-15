import { describe, it, expect } from 'vitest'
import { normalizeTitle, normalizeName, buildEditionSets } from '../../src/index/editions.js'
import { book, makeIndex } from './helpers.js'
import type { ExpandedBookItem } from '../../src/index/minify.js'

describe('normalizeTitle', () => {
  it('ignores case, punctuation, accents, articles and edition noise', () => {
    expect(normalizeTitle('The Hobbit')).toBe('hobbit')
    expect(normalizeTitle('Hobbit, The')).toBe('hobbit the')
    expect(normalizeTitle('The Hobbit (Unabridged)')).toBe('hobbit')
    expect(normalizeTitle('Dune: A Novel')).toBe('dune')
    expect(normalizeTitle('Crème Brûlée!')).toBe('creme brulee')
  })
  it('keeps subtitles, since they usually distinguish books', () => {
    expect(normalizeTitle('Dune: Messiah')).toBe('dune messiah')
  })
})

describe('normalizeName', () => {
  it('normalizes author names', () => {
    expect(normalizeName('J.R.R. Tolkien')).toBe('j r r tolkien')
    expect(normalizeName('  Andy  Weir ')).toBe('andy weir')
  })
})

function sets(items: ExpandedBookItem[], opts: { preferServers?: string[]; keepSeparate?: string[]; servers?: Record<string, string> } = {}) {
  const { store, query } = makeIndex()
  for (const it of items) store.putItem(opts.servers?.[it.id] ?? 'a', it)
  const libraryIds = [...new Set(items.map((i) => i.libraryId))]
  return buildEditionSets(query.all(libraryIds), { preferServers: opts.preferServers ?? ['a', 'b'], keepSeparate: new Set(opts.keepSeparate ?? []) }, false)
}

describe('buildEditionSets', () => {
  it('groups by ASIN before anything else', () => {
    const a = book({ id: 'a1', title: 'Totally Different Title', asin: 'B000X', libraryId: 'la' })
    const b = book({ id: 'b1', title: 'Another Name Entirely', asin: 'b000x', libraryId: 'lb' })
    const s = sets([a, b], { servers: { b1: 'b' } })
    expect(s.get('a1')?.members.map((m) => m.id).sort()).toEqual(['a1', 'b1'])
    expect(s.get('b1')?.members.find((m) => m.id === 'b1')?.reason).toBe('asin')
  })

  it('groups by ISBN regardless of hyphens', () => {
    const a = book({ id: 'a1', title: 'One', isbn: '978-0-123456-47-2' })
    const b = book({ id: 'b1', title: 'Two', isbn: '9780123456472' })
    expect(sets([a, b]).get('a1')?.members).toHaveLength(2)
  })

  it('groups same title and author across servers, with different narrators', () => {
    const a = book({ id: 'a1', title: 'Short Stories', author: 'Jane Doe', narrators: ['Narrator One'], libraryId: 'la' })
    const b = book({ id: 'b1', title: 'Short Stories', author: 'Jane Doe', narrators: ['Narrator Three'], libraryId: 'lb' })
    const s = sets([a, b], { servers: { b1: 'b' } })
    expect(s.get('a1')?.members).toHaveLength(2)
    expect(s.get('a1')?.preferred).toBe('a1')
  })

  it('keeps same titles by different authors apart', () => {
    const a = book({ id: 'a1', title: 'Long Walk', author: 'Jane Doe' })
    const b = book({ id: 'b1', title: 'Long Walk', author: 'John Roe' })
    expect(sets([a, b]).size).toBe(0)
  })

  it('does not merge translations or abridged with unabridged', () => {
    const en = book({ id: 'a1', title: 'Dune', author: 'Frank Herbert', language: 'en' })
    const de = book({ id: 'b1', title: 'Dune', author: 'Frank Herbert', language: 'de' })
    expect(sets([en, de]).size).toBe(0)
    const full = book({ id: 'a2', title: 'Dune', author: 'Frank Herbert' })
    const abridged = book({ id: 'b2', title: 'Dune', author: 'Frank Herbert', abridged: true })
    expect(sets([full, abridged]).size).toBe(0)
  })

  it('merges when only one side knows the language', () => {
    const a = book({ id: 'a1', title: 'Dune', author: 'Frank Herbert', language: 'en' })
    const b = book({ id: 'b1', title: 'Dune', author: 'Frank Herbert', language: null })
    expect(sets([a, b]).get('a1')?.members).toHaveLength(2)
  })

  it('prefers by server order, then bitrate', () => {
    const a = book({ id: 'a1', title: 'Dune', author: 'Frank Herbert', libraryId: 'la', duration: 3600, size: 10 })
    const b = book({ id: 'b1', title: 'Dune', author: 'Frank Herbert', libraryId: 'lb', duration: 3600, size: 100 })
    expect(sets([a, b], { servers: { b1: 'b' }, preferServers: ['b', 'a'] }).get('a1')?.preferred).toBe('b1')
    expect(sets([a, b], { servers: { b1: 'b' }, preferServers: ['a', 'b'] }).get('a1')?.preferred).toBe('a1')
    // Same server: the higher-bitrate copy wins.
    const c = book({ id: 'c1', title: 'Dune', author: 'Frank Herbert', duration: 3600, size: 100 })
    expect(sets([a, c]).get('a1')?.preferred).toBe('c1')
  })

  it('never collapses items listed in keepSeparate', () => {
    const a = book({ id: 'a1', title: 'Dune', author: 'Frank Herbert' })
    const b = book({ id: 'b1', title: 'Dune', author: 'Frank Herbert' })
    const c = book({ id: 'c1', title: 'Dune', author: 'Frank Herbert' })
    const s = sets([a, b, c], { keepSeparate: ['b1'] })
    expect(s.get('b1')).toBeUndefined()
    expect(s.get('a1')?.members.map((m) => m.id).sort()).toEqual(['a1', 'c1'])
  })

  it('chains rules: ASIN links one pair, title links another, into one set', () => {
    const a = book({ id: 'a1', title: 'Dune', author: 'Frank Herbert', asin: 'X1' })
    const b = book({ id: 'b1', title: 'Other', author: 'Someone', asin: 'X1' })
    const c = book({ id: 'c1', title: 'Dune', author: 'Frank Herbert' })
    expect(sets([a, b, c]).get('b1')?.members).toHaveLength(3)
  })
})
