import { Router, type Request, type Response, type NextFunction } from 'express'
import type { Context } from '../context.js'
import type { FederatedLibrary } from '../upstream/catalog.js'
import { fetchItems, type LibraryItemJSON } from './items-helpers.js'

interface Shelf {
  id: string
  label: string
  labelStringKey: string
  type: string
  entities: unknown[]
  total?: number
}

/** Items from the index carry their source library id; present them as the merged library's. */
export function relabel<T extends { libraryId?: unknown }>(json: T, libraryId: string): T {
  return { ...json, libraryId }
}

/**
 * Merged (virtual) libraries, answered from the index. Mounted before the
 * passthrough library routes; anything for a non-merged library falls
 * through.
 */
export function mergedRoutes(ctx: Context): Router {
  const r = Router()
  const q = ctx.indexQuery

  const merged = (req: Request): FederatedLibrary | null => {
    const lib = ctx.catalog.get(req.params.id)
    return lib?.merged ? lib : null
  }
  const sources = (lib: FederatedLibrary) => lib.sources!.map((s) => s.libraryId)
  const onlyMerged = (handler: (req: Request, res: Response, lib: FederatedLibrary) => unknown) => (req: Request, res: Response, next: NextFunction) => {
    const lib = merged(req)
    if (!lib) return next()
    if (!ctx.catalog.canAccess(ctx.users.config(req.smUser), lib.id)) return res.sendStatus(403)
    ctx.lastLibrary.set(req.smUser.id, lib.id)
    return handler(req, res, lib)
  }
  const include = (req: Request) =>
    String(req.query.include ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
  const pageParams = (req: Request) => ({ limit: Number(req.query.limit) || 0, page: Number(req.query.page) || 0 })
  const libraryJson = (lib: FederatedLibrary) => {
    const { serverKey, upstreamName, merged, sources, ...json } = lib
    return json
  }

  r.get(
    '/libraries/:id',
    onlyMerged((req, res, lib) => {
      if (include(req).includes('filterdata')) {
        const filterdata = q.filterdata(sources(lib))
        return res.json({ filterdata, issues: filterdata.numIssues, numUserPlaylists: ctx.collections.playlists(req.smUser.id, lib.id).length, library: libraryJson(lib) })
      }
      res.json(libraryJson(lib))
    })
  )

  r.get(
    '/libraries/:id/items',
    onlyMerged((req, res, lib) => {
      const { limit, page } = pageParams(req)
      const payload = {
        results: [] as unknown[],
        total: 0,
        limit: req.query.limit || 0,
        page: req.query.page || 0,
        sortBy: req.query.sort,
        sortDesc: req.query.desc === '1',
        filterBy: req.query.filter,
        mediaType: lib.mediaType,
        minified: req.query.minified === '1',
        collapseseries: req.query.collapseseries === '1',
        include: include(req).join(','),
        offset: page * limit
      }
      const { results, total } = q.items({ libraryIds: sources(lib), userId: req.smUser.id, filterBy: payload.filterBy as string | undefined, sortBy: payload.sortBy as string | undefined, sortDesc: payload.sortDesc, collapseseries: payload.collapseseries, limit, offset: page * limit })
      payload.results = results.map((it) => relabel(it, lib.id))
      payload.total = total
      res.json(payload)
    })
  )

  r.get(
    '/libraries/:id/search',
    onlyMerged((req, res, lib) => {
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
      if (!query) return res.status(400).send('Invalid request. Query param "q" must be a string')
      const out = q.search(sources(lib), req.smUser.id, query, Number(req.query.limit) || 12)
      out.book = out.book.map((b) => ({ libraryItem: relabel(b.libraryItem, lib.id) }))
      out.series = out.series.map((s) => ({ series: relabel(s.series, lib.id), books: s.books.map((b) => relabel(b as { libraryId?: unknown }, lib.id)) }))
      out.authors = out.authors.map((a) => relabel(a as { libraryId?: unknown }, lib.id))
      res.json(out)
    })
  )

  r.get(
    '/libraries/:id/filterdata',
    onlyMerged((_req, res, lib) => res.json(q.filterdata(sources(lib))))
  )

  r.get(
    '/libraries/:id/series',
    onlyMerged((req, res, lib) => {
      const { limit, page } = pageParams(req)
      const hide = !!(lib.settings as { hideSingleBookSeries?: boolean })?.hideSingleBookSeries
      const { series, count } = q.series({ libraryIds: sources(lib), userId: req.smUser.id, filterBy: req.query.filter as string | undefined, sortBy: req.query.sort as string | undefined, sortDesc: req.query.desc === '1', limit, offset: page * limit, hideSingleBookSeries: hide }, lib.id)
      res.json({ results: series.map((s) => ({ ...s, books: s.books?.map((b) => relabel(b as { libraryId?: unknown }, lib.id)) })), total: count, limit: req.query.limit || 0, page: req.query.page || 0, sortBy: req.query.sort, sortDesc: req.query.desc === '1', filterBy: req.query.filter, minified: req.query.minified === '1', include: include(req).join(',') })
    })
  )

  r.get(
    '/libraries/:id/series/:seriesId',
    onlyMerged((req, res, lib) => {
      const detail = q.seriesDetail(sources(lib), req.params.seriesId, lib.id)
      if (!detail) return res.sendStatus(404)
      const json: Record<string, unknown> = { ...detail.series }
      if (include(req).includes('progress')) {
        const finished = detail.itemIds.filter((id) => ctx.progress.get(req.smUser.id, id)?.isFinished)
        json.progress = { libraryItemIds: detail.itemIds, libraryItemIdsFinished: finished, isFinished: detail.itemIds.length > 0 && finished.length >= detail.itemIds.length }
      }
      if (include(req).includes('rssfeed')) json.rssFeed = null
      res.json(json)
    })
  )

  r.get(
    '/libraries/:id/authors',
    onlyMerged((req, res, lib) => {
      const isPaginated = req.query.limit !== undefined && !Number.isNaN(Number(req.query.limit)) && !Number.isNaN(Number(req.query.page))
      const dir = req.query.desc === '1' ? -1 : 1
      const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
      let authors = q.authors(sources(lib), lib.id)
      switch (req.query.sort) {
        case 'name':
          authors.sort((a, b) => collator.compare(a.name, b.name) * dir)
          break
        case 'lastFirst':
          authors.sort((a, b) => collator.compare(a.lastFirst, b.lastFirst) * dir)
          break
        case 'addedAt':
          authors.sort((a, b) => (a.addedAt - b.addedAt) * dir)
          break
        case 'updatedAt':
          authors.sort((a, b) => (a.updatedAt - b.updatedAt) * dir)
          break
        case 'numBooks':
          authors.sort((a, b) => (a.numBooks - b.numBooks) * dir)
          break
      }
      if (!isPaginated) return res.json({ authors })
      const limit = Number(req.query.limit)
      const page = Number(req.query.page)
      const total = authors.length
      authors = authors.slice(page * limit, (page + 1) * limit)
      res.json({ results: authors, total, limit, page, sortBy: req.query.sort, sortDesc: req.query.desc === '1', filterBy: req.query.filter, minified: req.query.minified === '1', include: req.query.include })
    })
  )

  r.get(
    '/libraries/:id/narrators',
    onlyMerged((_req, res, lib) => res.json({ narrators: q.narrators(sources(lib)) }))
  )

  r.get(
    '/libraries/:id/stats',
    onlyMerged((_req, res, lib) => res.json(q.stats(sources(lib))))
  )

  r.get(
    '/libraries/:id/recent-episodes',
    onlyMerged((_req, res) => res.json({ episodes: [], limit: 0, page: 0 }))
  )

  r.get(
    '/libraries/:id/personalized',
    onlyMerged(async (req, res, lib) => {
      const limit = Number(req.query.limit) || 10
      const libs = sources(lib)
      const userId = req.smUser.id
      const inScope = new Set(libs)
      const hide = !!(lib.settings as { hideSingleBookSeries?: boolean })?.hideSingleBookSeries
      const onlyLater = !!(lib.settings as { onlyShowLaterBooksInContinueSeries?: boolean })?.onlyShowLaterBooksInContinueSeries

      // Progress-driven shelves from our store, items from the index (falling back to upstream for anything not indexed yet).
      const rows = ctx.progress.rowsForUser(userId).filter((mp) => !mp.episodeId)
      const stored = new Map<string, Record<string, unknown>>()
      const missing: string[] = []
      for (const mp of rows) {
        const it = ctx.indexStore.getItem(mp.libraryItemId)
        if (it && inScope.has(it.libraryId)) stored.set(mp.libraryItemId, q.minify(it))
        else if (!it) missing.push(mp.libraryItemId)
      }
      if (missing.length) for (const [id, li] of await fetchItems(ctx, missing)) if (inScope.has(li.libraryId)) stored.set(id, li as Record<string, unknown>)

      const continueListening: unknown[] = []
      const continueReading: unknown[] = []
      const listenAgain: unknown[] = []
      const finishedItems: LibraryItemJSON[] = []
      for (const mp of rows) {
        const li = stored.get(mp.libraryItemId)
        if (!li) continue
        if (mp.isFinished) finishedItems.push(li as LibraryItemJSON)
        if (mp.hideFromContinueListening) continue
        const entity = { ...relabel(li, lib.id), progressLastUpdate: mp.updatedAt, userMediaProgress: ctx.progress.getById(userId, mp.id) }
        if (mp.isFinished) {
          if (mp.finishedAt && Date.now() - mp.finishedAt < 60 * 24 * 60 * 60 * 1000) listenAgain.push({ ...entity, finishedAt: mp.finishedAt })
        } else if (mp.currentTime > 0) continueListening.push(entity)
        else if (mp.ebookProgress > 0) continueReading.push(entity)
      }

      // Continue Series: same rules as the passthrough shelf, books from the index.
      const continueSeries: Array<{ entity: unknown; recent: number }> = []
      const hidden = new Set(ctx.users.seriesHidden(userId))
      const seriesSeen = new Map<string, number>()
      for (const li of finishedItems) {
        for (const s of ((li.media.metadata as { series?: Array<{ id: string }> }).series ?? []) as Array<{ id: string }>) {
          if (hidden.has(s.id)) continue
          seriesSeen.set(s.id, Math.max(seriesSeen.get(s.id) ?? 0, ctx.progress.get(userId, li.id)?.lastUpdate ?? 0))
        }
      }
      const doneSeries = new Set<string>()
      for (const [seriesId, recent] of seriesSeen) {
        const books = q.seriesItemsForContinue(libs, seriesId)
        if (!books.length) continue
        const key = books.map((b) => b.id).join('|')
        if (doneSeries.has(key)) continue
        doneSeries.add(key)
        const prog = books.map((b) => ({ ...b, mp: ctx.progress.get(userId, b.id), seq: parseFloat(b.sequence ?? '') || null }))
        if (prog.some((p) => p.mp && !p.mp.isFinished && p.mp.currentTime > 0)) continue
        const finished = prog.filter((p) => p.mp?.isFinished)
        if (!finished.length) continue
        const maxSeq = Math.max(...finished.map((p) => p.seq ?? -Infinity))
        const next = prog.find((p) => !p.mp?.isFinished && (!onlyLater || (p.seq ?? Infinity) > maxSeq))
        if (!next) continue
        continueSeries.push({ entity: { ...relabel(next.json, lib.id), prevBookInProgress: false }, recent })
      }
      continueSeries.sort((a, b) => b.recent - a.recent)

      const recent = q.recentlyAdded(libs, limit)
      const recentSeries = q.recentSeries(libs, 5, hide, lib.id)
      const discover = q.discover(libs, userId, limit)
      const newestAuthors = q.newestAuthors(libs, limit, lib.id)

      const type = lib.mediaType === 'podcast' ? 'episode' : 'book'
      const shelves: Shelf[] = []
      if (continueListening.length) shelves.push({ id: 'continue-listening', label: 'Continue Listening', labelStringKey: 'LabelContinueListening', type, entities: continueListening.slice(0, limit), total: continueListening.length })
      if (continueReading.length) shelves.push({ id: 'continue-reading', label: 'Continue Reading', labelStringKey: 'LabelContinueReading', type: 'book', entities: continueReading.slice(0, limit), total: continueReading.length })
      if (continueSeries.length) shelves.push({ id: 'continue-series', label: 'Continue Series', labelStringKey: 'LabelContinueSeries', type: 'book', entities: continueSeries.slice(0, limit).map((c) => c.entity), total: continueSeries.length })
      if (recent.libraryItems.length) shelves.push({ id: 'recently-added', label: 'Recently Added', labelStringKey: 'LabelRecentlyAdded', type: lib.mediaType, entities: recent.libraryItems.map((it) => relabel(it, lib.id)), total: recent.count })
      if (recentSeries.series.length) shelves.push({ id: 'recent-series', label: 'Recent Series', labelStringKey: 'LabelRecentSeries', type: 'series', entities: recentSeries.series.map((s) => ({ ...s, books: s.books?.map((b) => relabel(b as { libraryId?: unknown }, lib.id)) })), total: recentSeries.count })
      if (discover.libraryItems.length) shelves.push({ id: 'discover', label: 'Discover', labelStringKey: 'LabelDiscover', type: lib.mediaType, entities: discover.libraryItems.map((it) => relabel(it as { libraryId?: unknown }, lib.id)), total: discover.count })
      if (listenAgain.length) shelves.push({ id: 'listen-again', label: 'Listen Again', labelStringKey: 'LabelListenAgain', type, entities: listenAgain.slice(0, limit), total: listenAgain.length })
      if (newestAuthors.authors.length) shelves.push({ id: 'newest-authors', label: 'Newest Authors', labelStringKey: 'LabelNewestAuthors', type: 'authors', entities: newestAuthors.authors, total: newestAuthors.count })
      res.json(shelves)
    })
  )

  // Anything else under a merged library id is not a thing (scans, downloads,
  // feeds...), except collections and playlists, which live in ShelfMerge.
  r.all('/libraries/:id/:what/*', (req, res, next) => (merged(req) && !['collections', 'playlists'].includes(req.params.what) ? res.sendStatus(404) : next()))
  r.all('/libraries/:id/:what', (req, res, next) => (merged(req) && !['collections', 'playlists'].includes(req.params.what) ? res.sendStatus(404) : next()))
  r.all('/libraries/:id', (req, res, next) => (merged(req) ? res.sendStatus(404) : next()))

  return r
}
