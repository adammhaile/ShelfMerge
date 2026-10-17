import { describe, it, expect, beforeEach } from 'vitest'
import { book, makeIndex } from './helpers.js'

const b64 = (s: string) => encodeURIComponent(Buffer.from(s).toString('base64'))
const titles = (r: { results: Array<Record<string, unknown>> }) => r.results.map((i) => (i as { media: { metadata: { title: string } } }).media.metadata.title)

describe('IndexQuery', () => {
  let ix: ReturnType<typeof makeIndex>
  const LIBS = ['lib-a', 'lib-b']
  const q = (over: Partial<Parameters<ReturnType<typeof makeIndex>['query']['items']>[0]> = {}) => ix.query.items({ libraryIds: LIBS, userId: 'u1', sortDesc: false, collapseseries: false, limit: 0, offset: 0, ...over })

  beforeEach(() => {
    ix = makeIndex()
    const { store } = ix
    store.putItem('a', book({ id: 'hobbit', title: 'The Hobbit', author: 'J. R. R. Tolkien', addedAt: 100, duration: 100, size: 100, genres: ['Fantasy'], narrators: ['Rob Inglis'], publishedYear: '1937', language: 'en' }))
    store.putItem('a', book({ id: 'dune', title: 'Dune', author: 'Frank Herbert', addedAt: 300, duration: 300, size: 300, genres: ['Sci-Fi'], series: [{ name: 'Dune', sequence: '1' }], tags: ['favourite'], publishedYear: '1965' }))
    store.putItem('a', book({ id: 'messiah', title: 'Dune Messiah', author: 'Frank Herbert', addedAt: 200, duration: 200, size: 200, genres: ['Sci-Fi'], series: [{ name: 'Dune', sequence: '2' }], publishedYear: '1969' }))
    store.putItem('b', book({ id: 'children', title: 'Children of Dune', author: 'Frank Herbert', authorId: 'author-herbert-on-b', libraryId: 'lib-b', addedAt: 400, duration: 400, size: 400, series: [{ id: 'series-dune-on-b', name: 'Dune', sequence: '3' }], publishedYear: '1976' }))
    store.putItem('b', book({ id: 'walk', title: 'A Long Walk', author: 'Jane Doe', libraryId: 'lib-b', addedAt: 500, duration: 500, size: 500, numAudioFiles: 0, coverPath: null, language: 'fr' }))
  })

  it('sorts by title honouring the ignore-prefix setting', () => {
    expect(titles(q({ sortBy: 'media.metadata.title' }))).toEqual(['Children of Dune', 'Dune', 'Dune Messiah', 'The Hobbit', 'A Long Walk'])
    ix.setIgnorePrefix(false)
    expect(titles(q({ sortBy: 'media.metadata.title' }))).toEqual(['A Long Walk', 'Children of Dune', 'Dune', 'Dune Messiah', 'The Hobbit'])
  })

  it('sorts by author last-first with title as secondary key, and descending', () => {
    expect(titles(q({ sortBy: 'media.metadata.authorNameLF' }))).toEqual(['A Long Walk', 'Children of Dune', 'Dune', 'Dune Messiah', 'The Hobbit'])
    expect(titles(q({ sortBy: 'addedAt', sortDesc: true }))).toEqual(['A Long Walk', 'Children of Dune', 'Dune', 'Dune Messiah', 'The Hobbit'])
    expect(titles(q({ sortBy: 'media.duration' }))).toEqual(['The Hobbit', 'Dune Messiah', 'Dune', 'Children of Dune', 'A Long Walk'])
  })

  it('pages', () => {
    const r = q({ sortBy: 'media.metadata.title', limit: 2, offset: 2 })
    expect(titles(r)).toEqual(['Dune Messiah', 'The Hobbit'])
    expect(r.total).toBe(5)
  })

  it('filters by genre, tag, narrator, language, publisher and decade', () => {
    expect(titles(q({ filterBy: `genres.${b64('Sci-Fi')}` })).sort()).toEqual(['Dune', 'Dune Messiah'])
    expect(titles(q({ filterBy: `tags.${b64('favourite')}` }))).toEqual(['Dune'])
    expect(titles(q({ filterBy: `narrators.${b64('Rob Inglis')}` }))).toEqual(['The Hobbit'])
    expect(titles(q({ filterBy: `languages.${b64('fr')}` }))).toEqual(['A Long Walk'])
    expect(titles(q({ filterBy: `publishedDecades.${b64('1960')}` })).sort()).toEqual(['Dune', 'Dune Messiah'])
  })

  it('filters by missing fields and track counts', () => {
    expect(titles(q({ filterBy: `missing.${b64('cover')}` }))).toEqual(['A Long Walk'])
    expect(titles(q({ filterBy: `missing.${b64('narrators')}` })).length).toBe(4)
    expect(titles(q({ filterBy: `tracks.${b64('none')}` }))).toEqual(['A Long Walk'])
    expect(titles(q({ filterBy: `series.${b64('no-series')}` })).sort()).toEqual(['A Long Walk', 'The Hobbit'])
  })

  it('merges same-named series and authors across servers and resolves any member id', () => {
    const fd = ix.query.filterdata(LIBS)
    expect(fd.series.map((s) => s.name)).toEqual(['Dune'])
    expect(fd.authors.map((a) => a.name)).toEqual(['Frank Herbert', 'J. R. R. Tolkien', 'Jane Doe'])
    const herbert = fd.authors.find((a) => a.name === 'Frank Herbert')!.id
    expect(titles(q({ filterBy: `authors.${b64(herbert)}`, sortBy: 'media.metadata.title' }))).toEqual(['Children of Dune', 'Dune', 'Dune Messiah'])
    // Filtering by the series via the id known only on server B still finds every book, ordered by sequence.
    const r = q({ filterBy: `series.${b64('series-dune-on-b')}`, sortBy: 'sequence' })
    expect(titles(r)).toEqual(['Dune', 'Dune Messiah', 'Children of Dune'])
    expect((r.results[2] as { series: { sequence: string } }).series.sequence).toBe('3')
  })

  it('collapses series to the first book with a collapsedSeries summary', () => {
    const r = q({ collapseseries: true, sortBy: 'media.metadata.title' })
    expect(titles(r)).toEqual(['Dune', 'The Hobbit', 'A Long Walk'])
    const dune = r.results[0] as { collapsedSeries: { name: string; numBooks: number; libraryItemIds: string[] } }
    expect(dune.collapsedSeries.name).toBe('Dune')
    expect(dune.collapsedSeries.numBooks).toBe(3)
    expect(dune.collapsedSeries.libraryItemIds).toHaveLength(3)
  })

  it('filters and sorts by the user progress store', () => {
    ix.progress.createUpdate('u1', 'a', 'media-dune', { libraryItemId: 'dune', duration: 300, currentTime: 100, progress: 0.33 })
    ix.progress.createUpdate('u1', 'a', 'media-hobbit', { libraryItemId: 'hobbit', duration: 100, currentTime: 100, progress: 1, isFinished: true })
    expect(titles(q({ filterBy: `progress.${b64('in-progress')}` }))).toEqual(['Dune'])
    expect(titles(q({ filterBy: `progress.${b64('finished')}` }))).toEqual(['The Hobbit'])
    expect(titles(q({ filterBy: `progress.${b64('not-started')}` })).sort()).toEqual(['A Long Walk', 'Children of Dune', 'Dune Messiah'])
    expect(titles(q({ sortBy: 'progress', sortDesc: true })).slice(0, 2).sort()).toEqual(['Dune', 'The Hobbit'])
    // Another user sees none of it.
    expect(titles(q({ filterBy: `progress.${b64('finished')}`, userId: 'u2' }))).toEqual([])
  })

  it('searches titles, series and authors', () => {
    const r = ix.query.search(LIBS, 'u1', 'dune', 12)
    expect(r.book.map((b) => (b.libraryItem as { media: { metadata: { title: string } } }).media.metadata.title).sort()).toEqual(['Children of Dune', 'Dune', 'Dune Messiah'])
    expect(r.series.map((s) => s.series.name)).toEqual(['Dune'])
    expect(r.series[0].books).toHaveLength(3)
    expect(ix.query.search(LIBS, 'u1', 'herbert', 12).authors.map((a) => (a as { name: string }).name)).toEqual(['Frank Herbert'])
  })

  it('lists series with books in sequence order and series detail with progress ids', () => {
    const { series } = ix.query.series({ libraryIds: LIBS, userId: 'u1', sortBy: 'name', sortDesc: false, limit: 0, offset: 0, hideSingleBookSeries: false }, 'merged')
    expect(series).toHaveLength(1)
    expect(series[0].books!.map((b) => (b as { media: { metadata: { title: string } } }).media.metadata.title)).toEqual(['Dune', 'Dune Messiah', 'Children of Dune'])
    const detail = ix.query.seriesDetail(LIBS, 'series-dune-on-b', 'merged')!
    expect(detail.itemIds).toEqual(['dune', 'messiah', 'children'])
    expect(detail.series.libraryId).toBe('merged')
  })

  it('computes stats and narrators', () => {
    const s = ix.query.stats(LIBS)
    expect(s.totalItems).toBe(5)
    expect(s.totalAuthors).toBe(3)
    expect(s.authorsWithCount[0]).toMatchObject({ name: 'Frank Herbert', count: 3 })
    expect(s.longestItems[0].title).toBe('A Long Walk')
    expect(ix.query.narrators(LIBS)).toEqual([{ id: b64('Rob Inglis'), name: 'Rob Inglis', numBooks: 1 }])
  })

  it('hides alternate editions when collapsing is enabled for the scope', () => {
    ix.store.putItem('b', book({ id: 'hobbit-b', title: 'The Hobbit', author: 'J. R. R. Tolkien', libraryId: 'lib-b', narrators: ['Andy Serkis'] }))
    ix.query.invalidate()
    expect(q({}).total).toBe(6)
    ix.query.useEditions(LIBS, { preferServers: ['b', 'a'], keepSeparate: new Set() })
    const r = q({ sortBy: 'media.metadata.title' })
    expect(r.total).toBe(5)
    const hobbit = r.results.find((i) => (i as { id: string }).id.startsWith('hobbit')) as { id: string; editions: { count: number } }
    expect(hobbit.id).toBe('hobbit-b')
    expect(hobbit.editions.count).toBe(2)
    expect(ix.query.editionSetOf(LIBS, 'hobbit')?.preferred).toBe('hobbit-b')
    ix.query.useEditions(LIBS, null)
    expect(q({}).total).toBe(6)
  })

  describe('per-viewer edition choice', () => {
    // The same book on server a (default first choice) and server b.
    const setup = () => {
      ix.store.putItem('b', book({ id: 'hobbit-b', title: 'The Hobbit', author: 'J. R. R. Tolkien', libraryId: 'lib-b', narrators: ['Andy Serkis'] }))
      ix.query.invalidate()
      ix.query.useEditions(LIBS, { preferServers: ['a', 'b'], keepSeparate: new Set() })
    }
    const shownHobbit = () => (q({}).results.find((i) => (i as { id: string }).id.startsWith('hobbit')) as { id: string }).id

    it('without a viewer shows the default edition', () => {
      setup()
      expect(shownHobbit()).toBe('hobbit')
    })

    it("shows the edition on the viewer's preferred server", () => {
      setup()
      expect(ix.query.asViewer({ userId: 'u1', order: ['b', 'a'] }, shownHobbit)).toBe('hobbit-b')
      expect(ix.query.asViewer({ userId: 'u1', order: ['a', 'b'] }, shownHobbit)).toBe('hobbit')
      // Servers missing from the order fall back to the default preference.
      expect(ix.query.asViewer({ userId: 'u1', order: [] }, shownHobbit)).toBe('hobbit')
    })

    it('prefers an edition the viewer has progress on, whatever the server order', () => {
      setup()
      ix.progress.createUpdate('u1', 'a', 'media-hobbit', { libraryItemId: 'hobbit', duration: 100, currentTime: 10 })
      expect(ix.query.asViewer({ userId: 'u1', order: ['b', 'a'] }, shownHobbit)).toBe('hobbit')
      // Another user without progress still gets their own preference.
      expect(ix.query.asViewer({ userId: 'u2', order: ['b', 'a'] }, shownHobbit)).toBe('hobbit-b')
      // Totals stay the same: one card per book either way.
      expect(ix.query.asViewer({ userId: 'u2', order: ['b', 'a'] }, () => q({}).total)).toBe(5)
    })

    it('keeps the viewer across awaits and isolates concurrent viewers', async () => {
      setup()
      const pick = async (order: string[]) => ix.query.asViewer({ userId: 'u3', order }, async () => {
        await new Promise((r) => setTimeout(r, 5))
        return shownHobbit()
      })
      const [x, y] = await Promise.all([pick(['b']), pick(['a'])])
      expect([x, y]).toEqual(['hobbit-b', 'hobbit'])
    })
  })
})
