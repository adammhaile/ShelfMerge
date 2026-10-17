import type { IndexStore } from './store.js'
import type { Registry } from '../upstream/registry.js'
import type { Catalog } from '../upstream/catalog.js'
import type { ExpandedBookItem } from './minify.js'
import { titleIgnorePrefix, nameLastFirst } from './minify.js'
import { log } from '../logger.js'

interface ItemsPage {
  results: Array<{ id: string; updatedAt: number }>
  total: number
}

interface SeriesPage {
  results: Array<{ id: string; name: string; description: string | null; addedAt: number; updatedAt: number; libraryId: string }>
  total: number
}

interface AuthorsResponse {
  authors: Array<{ id: string; name: string; description: string | null; imagePath: string | null; asin: string | null; addedAt: number; updatedAt: number; libraryId: string }>
}

const PAGE = 200
const BATCH = 100

/**
 * Keeps the index in step with upstream: a full pull per source library on
 * startup (when stale) and on a timer, plus incremental updates from the
 * item/series/author socket events the hub already relays.
 */
export class Indexer {
  private timer: NodeJS.Timeout | null = null
  private readonly running = new Set<string>()
  /** Consecutive failed pulls per library, for retry backoff. */
  private readonly failures = new Map<string, number>()

  constructor(
    private readonly store: IndexStore,
    private readonly registry: Registry,
    private readonly catalog: Catalog,
    private readonly prefixes: () => string[],
    /** Whether a server delivers live socket events; without them its index goes stale sooner. */
    private readonly hasLiveEvents: (serverKey: string) => boolean = () => true
  ) {}

  /** Called after a library was (re)pulled, so query caches can be dropped. */
  onLibraryPulled: ((libraryId: string) => void) | null = null

  /** Library ids the merged libraries draw from. */
  sourceLibraryIds(): Array<{ libraryId: string; serverKey: string }> {
    const out = new Map<string, string>()
    for (const merged of this.catalog.mergedLibraries()) for (const src of merged.sources ?? []) out.set(src.libraryId, src.serverKey)
    return [...out].map(([libraryId, serverKey]) => ({ libraryId, serverKey }))
  }

  /**
   * Full pull at startup when stale, then periodically: every `reconcileMs`
   * for servers with live events, every `noEventsMs` for servers without.
   */
  async start(reconcileMs = 6 * 60 * 60 * 1000, staleMs = 60 * 60 * 1000, noEventsMs = 30 * 60 * 1000) {
    await this.reconcileAll(staleMs)
    this.timer = setInterval(() => this.reconcileAll(reconcileMs, noEventsMs).catch(() => {}), Math.min(reconcileMs, noEventsMs))
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  /** Pull every source library not pulled within `staleMs` (`noEventsMs` for servers without live events). */
  async reconcileAll(staleMs: number, noEventsMs = staleMs) {
    const sources = this.sourceLibraryIds()
    await Promise.all(
      sources.map(async ({ libraryId, serverKey }) => {
        const limit = this.hasLiveEvents(serverKey) ? staleMs : Math.min(staleMs, noEventsMs)
        if (Date.now() - this.store.syncedAt(libraryId) < limit) return
        await this.pullLibrary(serverKey, libraryId)
      })
    )
  }

  async pullLibrary(serverKey: string, libraryId: string) {
    const server = this.registry.server(serverKey)
    if (!server || this.running.has(libraryId)) return
    this.running.add(libraryId)
    const started = Date.now()
    try {
      // The list endpoint only returns minified items (names, no author or
      // series ids); batch/get returns them expanded.
      const ids: string[] = []
      const updatedAt = new Map<string, number>()
      let page = 0
      let total = 0
      for (;;) {
        const r = await server.get<ItemsPage>(`/api/libraries/${libraryId}/items?limit=${PAGE}&page=${page}&minified=1`)
        total = r.total
        for (const item of r.results ?? []) {
          ids.push(item.id)
          updatedAt.set(item.id, item.updatedAt)
        }
        if (!r.results?.length || r.results.length < PAGE) break
        page++
      }
      const seen = new Set<string>()
      for (let i = 0; i < ids.length; i += BATCH) {
        const chunk = ids.slice(i, i + BATCH)
        const r = await server.post<{ libraryItems: ExpandedBookItem[] }>('/api/items/batch/get', { libraryItemIds: chunk })
        for (const item of r.libraryItems ?? []) {
          this.store.putItem(serverKey, item)
          seen.add(item.id)
          this.registry.record(item.id, serverKey, 'item', item.media?.id ?? null, libraryId)
        }
      }
      this.store.pruneLibrary(libraryId, seen)

      // Series and authors carry dates and images the item JSON lacks.
      page = 0
      for (;;) {
        const r = await server.get<SeriesPage>(`/api/libraries/${libraryId}/series?limit=${PAGE}&page=${page}`)
        for (const s of r.results ?? []) this.store.putSeries({ id: s.id, serverKey, libraryId, name: s.name, nameIgnorePrefix: titleIgnorePrefix(s.name, this.prefixes()), description: s.description, addedAt: s.addedAt, updatedAt: s.updatedAt })
        if (!r.results?.length || r.results.length < PAGE) break
        page++
      }
      const authors = await server.get<AuthorsResponse>(`/api/libraries/${libraryId}/authors`)
      for (const a of authors.authors ?? []) this.store.putAuthor({ id: a.id, serverKey, libraryId, name: a.name, lastFirst: nameLastFirst(a.name), description: a.description, imagePath: a.imagePath, asin: a.asin, addedAt: a.addedAt, updatedAt: a.updatedAt })

      this.store.markSynced(libraryId, serverKey, seen.size)
      this.onLibraryPulled?.(libraryId)
      log.info(`[index] ${serverKey}/${libraryId}: ${seen.size} of ${total} items indexed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
      this.failures.delete(libraryId)
    } catch (err) {
      // Retry soon rather than waiting for the next scheduled pass: 2, 5, 15, then 30 minutes.
      const n = (this.failures.get(libraryId) ?? 0) + 1
      this.failures.set(libraryId, n)
      const delayMin = [2, 5, 15][n - 1] ?? 30
      log.warn(`[index] pull of ${serverKey}/${libraryId} failed (attempt ${n}, retrying in ${delayMin} min):`, (err as Error).message)
      setTimeout(() => this.pullLibrary(serverKey, libraryId).catch(() => {}), delayMin * 60_000).unref()
    } finally {
      this.running.delete(libraryId)
    }
  }

  /** Apply a relayed upstream socket event to the index. */
  onEvent(serverKey: string, event: string, payload: unknown) {
    const sources = new Set(this.sourceLibraryIds().map((s) => s.libraryId))
    const inScope = (li: { libraryId?: string } | undefined) => !!li?.libraryId && sources.has(li.libraryId)
    const asItem = payload as ExpandedBookItem | undefined
    switch (event) {
      case 'item_added':
      case 'item_updated':
        if (inScope(asItem) && asItem?.media) this.store.putItem(serverKey, asItem)
        break
      case 'item_removed':
        if (asItem?.id) this.store.removeItem(asItem.id)
        break
      case 'items_added':
      case 'items_updated':
        for (const li of (payload as ExpandedBookItem[]) ?? []) if (inScope(li) && li.media) this.store.putItem(serverKey, li)
        break
      case 'series_removed':
        if ((payload as { id?: string })?.id) this.store.removeSeries((payload as { id: string }).id)
        break
      case 'series_added':
      case 'series_updated': {
        const s = payload as SeriesPage['results'][number] | undefined
        if (s?.id && sources.has(s.libraryId)) this.store.putSeries({ id: s.id, serverKey, libraryId: s.libraryId, name: s.name, nameIgnorePrefix: titleIgnorePrefix(s.name, this.prefixes()), description: s.description ?? null, addedAt: s.addedAt ?? 0, updatedAt: s.updatedAt ?? 0 })
        break
      }
      case 'author_removed':
        if ((payload as { id?: string })?.id) this.store.removeAuthor((payload as { id: string }).id)
        break
      case 'author_updated': {
        const a = payload as AuthorsResponse['authors'][number] | undefined
        if (a?.id && sources.has(a.libraryId)) this.store.putAuthor({ id: a.id, serverKey, libraryId: a.libraryId, name: a.name, lastFirst: nameLastFirst(a.name), description: a.description ?? null, imagePath: a.imagePath ?? null, asin: a.asin ?? null, addedAt: a.addedAt ?? 0, updatedAt: a.updatedAt ?? 0 })
        break
      }
      case 'library_removed': {
        const id = (payload as { id?: string })?.id
        if (id) this.store.removeLibrary(id)
        break
      }
    }
  }
}
