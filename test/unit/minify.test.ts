import { describe, it, expect } from 'vitest'
import { titleIgnorePrefix, nameLastFirst, seriesName, strip, toMinified } from '../../src/index/minify.js'
import { book, PREFIXES } from './helpers.js'

describe('titleIgnorePrefix', () => {
  it('moves a leading article to the end, like upstream', () => {
    expect(titleIgnorePrefix('The Hobbit', PREFIXES)).toBe('Hobbit, The')
    expect(titleIgnorePrefix('A Court of Thorns', PREFIXES)).toBe('Court of Thorns, A')
    expect(titleIgnorePrefix('An Ordinary Life', PREFIXES)).toBe('Ordinary Life, An')
  })
  it('leaves other titles alone, including ones that merely start with the letters', () => {
    expect(titleIgnorePrefix('Theory of Everything', PREFIXES)).toBe('Theory of Everything')
    expect(titleIgnorePrefix('Dune', PREFIXES)).toBe('Dune')
    expect(titleIgnorePrefix('', PREFIXES)).toBe('')
  })
})

describe('nameLastFirst', () => {
  it('swaps first and last names', () => {
    expect(nameLastFirst('Andy Weir')).toBe('Weir, Andy')
    expect(nameLastFirst('Ursula K. Le Guin')).toBe('Guin, Ursula K. Le')
    expect(nameLastFirst('Plato')).toBe('Plato')
  })
})

describe('seriesName', () => {
  it('formats name and sequence the way minified items carry it', () => {
    expect(seriesName([{ id: 's', name: 'Series Two', sequence: '2' }])).toBe('Series Two #2')
    expect(seriesName([{ id: 's', name: 'Alone', sequence: null }])).toBe('Alone')
    expect(seriesName([])).toBe('')
  })
})

describe('strip and toMinified', () => {
  it('drops per-file arrays and keeps counts', () => {
    const stored = strip(book({ title: 'Long Walk', numAudioFiles: 3 }))
    expect(stored.media.audioFiles).toBeUndefined()
    expect(stored.media.tracks).toBeUndefined()
    expect(stored.media.numAudioFiles).toBe(3)
    expect(stored.media.numTracks).toBe(3)
    expect(stored.numFiles).toBe(1)
  })
  it('produces the minified shape clients expect', () => {
    const stored = strip(book({ title: 'The Sequel', author: 'John Roe', narrators: ['Narrator One'], series: [{ name: 'Series Name', sequence: '2' }], genres: ['Fiction'] }))
    const min = toMinified(stored, PREFIXES) as { media: { metadata: Record<string, unknown> } }
    const m = min.media.metadata
    expect(m.title).toBe('The Sequel')
    expect(m.titleIgnorePrefix).toBe('Sequel, The')
    expect(m.authorName).toBe('John Roe')
    expect(m.authorNameLF).toBe('Roe, John')
    expect(m.narratorName).toBe('Narrator One')
    expect(m.seriesName).toBe('Series Name #2')
    expect(m.genres).toEqual(['Fiction'])
    // Minified metadata carries names, not the id arrays of the expanded form.
    expect(m.authors).toBeUndefined()
    expect(m.series).toBeUndefined()
  })
})
