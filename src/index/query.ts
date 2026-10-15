import type { IndexStore, ItemRow, SeriesRow, AuthorRow } from './store.js'
import { toMinified, type StoredItem } from './minify.js'
import { buildEditionSets, type EditionOptions, type EditionSet } from './editions.js'
import type { ProgressStore, OldMediaProgress } from '../progress.js'

/** Parsed index row with the bits queries touch, cached per library. */
export interface IndexedItem {
  row: ItemRow
  item: StoredItem
  narrators: string[]
  genres: string[]
  tags: string[]
  seriesIds: string[]
  authorIds: string[]
}

export interface ItemsQuery {
  libraryIds: string[]
  userId: string
  filterBy?: string
  sortBy?: string
  sortDesc: boolean
  collapseseries: boolean
  limit: number
  offset: number
  /** Respect hideFromContinueListening (home page shelves). */
  isHomePage?: boolean
}

export interface SeriesQuery {
  libraryIds: string[]
  userId: string
  filterBy?: string
  sortBy?: string
  sortDesc: boolean
  limit: number
  offset: number
  hideSingleBookSeries: boolean
}

export interface OldSeries {
  id: string
  name: string
  nameIgnorePrefix: string
  description: string | null
  addedAt: number
  updatedAt: number
  libraryId: string
  books?: unknown[]
  totalDuration?: number
}

const FILTER_GROUPS = ['genres', 'tags', 'series', 'authors', 'progress', 'narrators', 'publishers', 'publishedDecades', 'missing', 'languages', 'tracks', 'ebooks']
const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000

export function decodeFilter(text: string): string | null {
  try {
    return Buffer.from(decodeURIComponent(text), 'base64').toString()
  } catch {
    return null
  }
}

export function parseFilter(filterBy: string | undefined): { group: string | null; value: string | null } {
  if (!filterBy) return { group: null, value: null }
  const group = FILTER_GROUPS.find((g) => filterBy.startsWith(g + '.'))
  return { group: group ?? filterBy, value: group ? decodeFilter(filterBy.slice(group.length + 1)) : null }
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base' })
const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const cmpStr = (a: string | null | undefined, b: string | null | undefined) => collator.compare(a ?? '', b ?? '')
const cmpNum = (a: number | null | undefined, b: number | null | undefined) => (a ?? 0) - (b ?? 0)
const seq = (s: string | null | undefined) => (s === null || s === undefined || s === '' || Number.isNaN(parseFloat(s)) ? null : parseFloat(s))
const cmpSeqNullsLast = (a: string | null | undefined, b: string | null | undefined) => {
  const x = seq(a)
  const y = seq(b)
  if (x === null && y === null) return 0
  if (x === null) return 1
  if (y === null) return -1
  return x - y
}
const cmpSeqText = (a: string | null | undefined, b: string | null | undefined) => {
  if (!a) return 1
  if (!b) return -1
  return naturalCollator.compare(a, b)
}

/**
 * Answers library queries for merged libraries from the index. The data set
 * per library is small enough (thousands of items) to filter and sort in
 * memory, which keeps upstream's many sort and filter combinations simple
 * to reproduce faithfully.
 */
export class IndexQuery {
  private readonly cache = new Map<string, IndexedItem[]>()
  /** Edition collapsing per scope (sorted library ids joined), registered by the merged routes. */
  private readonly editionOptions = new Map<string, EditionOptions>()
  private readonly editionSets = new Map<string, Map<string, EditionSet>>()

  constructor(
    private readonly store: IndexStore,
    private readonly progress: ProgressStore,
    private readonly prefixes: () => string[],
    private readonly sortingIgnorePrefix: () => boolean
  ) {}

  invalidate(libraryId?: string) {
    if (libraryId) this.cache.delete(libraryId)
    else this.cache.clear()
    this.editionSets.clear()
  }

  // ---- editions ----

  private scopeKey(libraryIds: string[]) {
    return [...libraryIds].sort().join('|')
  }

  /** Enable (or disable, with null) edition collapsing for a set of source libraries. */
  useEditions(libraryIds: string[], opts: EditionOptions | null) {
    const key = this.scopeKey(libraryIds)
    const prev = this.editionOptions.get(key)
    if (!opts) {
      if (prev) {
        this.editionOptions.delete(key)
        this.editionSets.delete(key)
      }
      return
    }
    if (prev && prev.preferServers.join() === opts.preferServers.join() && [...prev.keepSeparate].join() === [...opts.keepSeparate].join()) return
    this.editionOptions.set(key, opts)
    this.editionSets.delete(key)
  }

  /** Edition sets for a scope (computed over every item, hidden ones included). */
  private sets(libraryIds: string[]): Map<string, EditionSet> {
    const key = this.scopeKey(libraryIds)
    const opts = this.editionOptions.get(key)
    if (!opts) return new Map()
    let sets = this.editionSets.get(key)
    if (!sets) {
      // Decisions are logged only when they differ from the last computation,
      // since the sets are rebuilt after every index change.
      sets = buildEditionSets(libraryIds.flatMap((id) => this.libraryItems(id)), opts, false)
      const signature = [...new Set([...sets.values()])].map((s) => s.members.map((m) => m.id).join(',') + '>' + s.preferred).sort().join(';')
      if (this.editionSignatures.get(key) !== signature) {
        this.editionSignatures.set(key, signature)
        buildEditionSets(libraryIds.flatMap((id) => this.libraryItems(id)), opts, true)
      }
      this.editionSets.set(key, sets)
    }
    return sets
  }
  private readonly editionSignatures = new Map<string, string>()

  editionSetOf(libraryIds: string[], itemId: string): EditionSet | undefined {
    return this.sets(libraryIds).get(itemId)
  }

  /** Ids hidden in this scope because a preferred edition stands in for them. */
  hiddenEditions(libraryIds: string[]): Set<string> {
    const hidden = new Set<string>()
    for (const [id, set] of this.sets(libraryIds)) if (set.preferred !== id) hidden.add(id)
    return hidden
  }

  minify(item: StoredItem): Record<string, unknown> {
    return toMinified(item, this.prefixes())
  }

  // ---- loading ----

  private libraryItems(libraryId: string): IndexedItem[] {
    let items = this.cache.get(libraryId)
    if (!items) {
      const rows = this.store.db.prepare('SELECT * FROM idx_items WHERE libraryId = ?').all(libraryId) as ItemRow[]
      const seriesRows = this.store.db.prepare('SELECT s.itemId, s.seriesId FROM idx_item_series s JOIN idx_items i ON i.id = s.itemId WHERE i.libraryId = ?').all(libraryId) as Array<{ itemId: string; seriesId: string }>
      const authorRows = this.store.db.prepare('SELECT a.itemId, a.authorId FROM idx_item_authors a JOIN idx_items i ON i.id = a.itemId WHERE i.libraryId = ?').all(libraryId) as Array<{ itemId: string; authorId: string }>
      const seriesBy = new Map<string, string[]>()
      for (const r of seriesRows) seriesBy.set(r.itemId, [...(seriesBy.get(r.itemId) ?? []), r.seriesId])
      const authorsBy = new Map<string, string[]>()
      for (const r of authorRows) authorsBy.set(r.itemId, [...(authorsBy.get(r.itemId) ?? []), r.authorId])
      items = rows.map((row) => ({
        row,
        item: JSON.parse(row.json) as StoredItem,
        narrators: JSON.parse(row.narrators) as string[],
        genres: JSON.parse(row.genres) as string[],
        tags: JSON.parse(row.tags) as string[],
        seriesIds: seriesBy.get(row.id) ?? [],
        authorIds: authorsBy.get(row.id) ?? []
      }))
      this.cache.set(libraryId, items)
    }
    return items
  }

  /** Items visible in this scope: everything indexed, minus hidden alternate editions. */
  all(libraryIds: string[]): IndexedItem[] {
    const items = libraryIds.flatMap((id) => this.libraryItems(id))
    if (!this.editionOptions.has(this.scopeKey(libraryIds))) return items
    const hidden = this.hiddenEditions(libraryIds)
    return hidden.size ? items.filter((it) => !hidden.has(it.row.id)) : items
  }

  private progressMap(userId: string): Map<string, OldMediaProgress> {
    const map = new Map<string, OldMediaProgress>()
    for (const mp of this.progress.allForUser(userId)) if (!mp.episodeId) map.set(mp.libraryItemId, mp)
    return map
  }

  seriesIn(libraryIds: string[]): SeriesRow[] {
    if (!libraryIds.length) return []
    return this.store.db.prepare(`SELECT * FROM idx_series WHERE libraryId IN (${libraryIds.map(() => '?').join(',')})`).all(...libraryIds) as SeriesRow[]
  }

  authorsIn(libraryIds: string[]): AuthorRow[] {
    if (!libraryIds.length) return []
    return this.store.db.prepare(`SELECT * FROM idx_authors WHERE libraryId IN (${libraryIds.map(() => '?').join(',')})`).all(...libraryIds) as AuthorRow[]
  }

  /**
   * Series (or authors) with the same name on different servers are shown
   * once. The canonical id is the smallest id of the group; any member id
   * resolves to the whole group.
   */
  private groups<T extends { id: string; name: string }>(rows: T[]): Map<string, T[]> {
    const byName = new Map<string, T[]>()
    for (const r of rows) {
      const key = r.name.trim().toLowerCase()
      byName.set(key, [...(byName.get(key) ?? []), r])
    }
    const out = new Map<string, T[]>()
    for (const members of byName.values()) {
      members.sort((a, b) => (a.id < b.id ? -1 : 1))
      out.set(members[0].id, members)
    }
    return out
  }

  seriesGroups(libraryIds: string[]) {
    return this.groups(this.seriesIn(libraryIds))
  }

  authorGroups(libraryIds: string[]) {
    return this.groups(this.authorsIn(libraryIds))
  }

  /** All ids in the group that `id` belongs to (any member id works). */
  private expandGroup<T extends { id: string }>(groups: Map<string, T[]>, id: string): { canonical: string; ids: Set<string>; members: T[] } | null {
    for (const [canonical, members] of groups) if (members.some((m) => m.id === id)) return { canonical, ids: new Set(members.map((m) => m.id)), members }
    return null
  }

  private seriesRefOf(it: IndexedItem, ids: Set<string>) {
    return (it.item.media.metadata.series ?? []).find((s) => ids.has(s.id)) ?? null
  }

  // ---- items ----

  private applyFilter(items: IndexedItem[], group: string | null, value: string | null, userId: string, libraryIds: string[], isHomePage: boolean): { items: IndexedItem[]; seriesIds?: Set<string> } {
    if (!group) return { items }
    const mp = this.progressMap(userId)
    const p = (it: IndexedItem) => mp.get(it.row.id)
    const now = Date.now()
    switch (group) {
      case 'genres':
        return { items: items.filter((it) => it.genres.includes(value ?? '')) }
      case 'tags':
        return { items: items.filter((it) => it.tags.includes(value ?? '')) }
      case 'narrators':
        return { items: items.filter((it) => it.narrators.includes(value ?? '')) }
      case 'authors': {
        const g = value ? this.expandGroup(this.authorGroups(libraryIds), value) : null
        if (!g) return { items: [] }
        return { items: items.filter((it) => it.authorIds.some((a) => g.ids.has(a))) }
      }
      case 'series': {
        if (value === 'no-series') return { items: items.filter((it) => !it.seriesIds.length) }
        const g = value ? this.expandGroup(this.seriesGroups(libraryIds), value) : null
        if (!g) return { items: [] }
        return { items: items.filter((it) => it.seriesIds.some((s) => g.ids.has(s))), seriesIds: g.ids }
      }
      case 'progress': {
        const visible = (it: IndexedItem) => !isHomePage || !p(it)?.hideFromContinueListening
        switch (value) {
          case 'not-finished':
            return { items: items.filter((it) => !p(it)?.isFinished && visible(it)) }
          case 'not-started':
            return { items: items.filter((it) => !(p(it)?.currentTime ?? 0) && !p(it)?.isFinished && visible(it)) }
          case 'finished':
            return { items: items.filter((it) => !!p(it)?.isFinished && visible(it)) }
          case 'in-progress':
            return { items: items.filter((it) => ((p(it)?.currentTime ?? 0) > 0 || (p(it)?.ebookProgress ?? 0) > 0) && p(it)?.isFinished === false && visible(it)) }
          case 'audio-in-progress':
            return { items: items.filter((it) => (p(it)?.currentTime ?? 0) > 0 && p(it)?.isFinished === false && visible(it)) }
          case 'ebook-in-progress':
            return { items: items.filter((it) => it.row.numAudioFiles === 0 && (p(it)?.ebookProgress ?? 0) > 0 && p(it)?.isFinished === false && visible(it)) }
          case 'ebook-finished':
            return { items: items.filter((it) => it.row.numAudioFiles === 0 && !!p(it)?.isFinished && !!it.row.hasEbook && visible(it)) }
          default:
            return { items }
        }
      }
      case 'publishers':
        return { items: items.filter((it) => it.row.publisher === value) }
      case 'languages':
        return { items: items.filter((it) => it.row.language === value) }
      case 'tracks':
        if (value === 'none') return { items: items.filter((it) => it.row.numAudioFiles === 0) }
        if (value === 'multi') return { items: items.filter((it) => it.row.numAudioFiles > 1) }
        return { items: items.filter((it) => it.row.numAudioFiles === 1) }
      case 'ebooks':
        if (value === 'ebook') return { items: items.filter((it) => !!it.row.hasEbook) }
        if (value === 'no-ebook') return { items: items.filter((it) => !it.row.hasEbook) }
        return { items } // supplementary flags need library files we do not keep
      case 'missing': {
        const empty = (v: string | number | null | undefined) => v === null || v === undefined || v === ''
        switch (value) {
          case 'asin':
            return { items: items.filter((it) => empty(it.row.asin)) }
          case 'isbn':
            return { items: items.filter((it) => empty(it.row.isbn)) }
          case 'subtitle':
            return { items: items.filter((it) => empty(it.row.subtitle)) }
          case 'publishedYear':
            return { items: items.filter((it) => empty(it.item.media.metadata.publishedYear)) }
          case 'description':
            return { items: items.filter((it) => empty(it.row.description)) }
          case 'publisher':
            return { items: items.filter((it) => empty(it.row.publisher)) }
          case 'language':
            return { items: items.filter((it) => empty(it.row.language)) }
          case 'cover':
            return { items: items.filter((it) => empty(it.row.coverPath)) }
          case 'genres':
            return { items: items.filter((it) => !it.genres.length) }
          case 'tags':
            return { items: items.filter((it) => !it.tags.length) }
          case 'narrators':
            return { items: items.filter((it) => !it.narrators.length) }
          case 'chapters':
            return { items: items.filter((it) => !it.row.numChapters) }
          case 'authors':
            return { items: items.filter((it) => !it.authorIds.length) }
          case 'series':
            return { items: items.filter((it) => !it.seriesIds.length) }
          default:
            return { items }
        }
      }
      case 'publishedDecades': {
        const start = parseInt(value ?? '', 10)
        if (Number.isNaN(start)) return { items: [] }
        return { items: items.filter((it) => it.row.publishedYear !== null && it.row.publishedYear >= start && it.row.publishedYear <= start + 9) }
      }
      case 'abridged':
        return { items: items.filter((it) => !!it.row.abridged) }
      case 'explicit':
        return { items: items.filter((it) => !!it.row.explicit) }
      case 'issues':
        return { items: items.filter((it) => !!it.row.isMissing || !!it.row.isInvalid) }
      case 'recent':
        return { items: items.filter((it) => it.row.addedAt >= now - SIXTY_DAYS) }
      case 'feed-open':
      case 'share-open':
        return { items: [] }
      default:
        return { items }
    }
  }

  private titleKey(it: IndexedItem) {
    return this.sortingIgnorePrefix() ? it.row.titleIgnorePrefix : it.row.title
  }

  private comparator(sortBy: string | undefined, sortDesc: boolean, userId: string, seriesIds?: Set<string>, displayTitle?: (it: IndexedItem) => string): (a: IndexedItem, b: IndexedItem) => number {
    const mp = this.progressMap(userId)
    const dir = sortDesc ? -1 : 1
    const title = (a: IndexedItem, b: IndexedItem) => cmpStr(this.titleKey(a), this.titleKey(b))
    const nullsLast = (get: (it: IndexedItem) => number | null | undefined) => (a: IndexedItem, b: IndexedItem) => {
      const x = get(a)
      const y = get(b)
      if ((x ?? null) === null && (y ?? null) === null) return 0
      if ((x ?? null) === null) return 1
      if ((y ?? null) === null) return -1
      return (x! - y!) * dir
    }
    const bySeq = (a: IndexedItem, b: IndexedItem) => cmpSeqNullsLast(this.seriesRefOf(a, seriesIds!)?.sequence, this.seriesRefOf(b, seriesIds!)?.sequence)
    let primary: (a: IndexedItem, b: IndexedItem) => number
    switch (sortBy) {
      case 'addedAt':
        primary = (a, b) => cmpNum(a.row.addedAt, b.row.addedAt) * dir
        break
      case 'size':
        primary = (a, b) => cmpNum(a.row.size, b.row.size) * dir
        break
      case 'birthtimeMs':
        primary = (a, b) => cmpNum(a.row.birthtimeMs, b.row.birthtimeMs) * dir
        break
      case 'mtimeMs':
        primary = (a, b) => cmpNum(a.row.mtimeMs, b.row.mtimeMs) * dir
        break
      case 'media.duration':
        primary = (a, b) => cmpNum(a.row.duration, b.row.duration) * dir
        break
      case 'media.metadata.publishedYear':
        primary = (a, b) => cmpNum(a.row.publishedYear, b.row.publishedYear) * dir
        break
      case 'media.metadata.authorNameLF':
        primary = (a, b) => cmpStr(a.row.authorNameLF, b.row.authorNameLF) * dir || title(a, b) * dir
        break
      case 'media.metadata.authorName':
        primary = (a, b) => cmpStr(a.row.authorName, b.row.authorName) * dir || title(a, b) * dir
        break
      case 'media.metadata.title':
        primary = displayTitle ? (a, b) => cmpStr(displayTitle(a), displayTitle(b)) * dir : (a, b) => title(a, b) * dir
        break
      case 'sequence':
        primary = seriesIds ? (a, b) => (sortDesc ? -bySeq(a, b) : bySeq(a, b)) : (a, b) => title(a, b) * dir
        break
      case 'progress':
        primary = nullsLast((it) => mp.get(it.row.id)?.lastUpdate)
        break
      case 'progress.createdAt':
        primary = nullsLast((it) => mp.get(it.row.id)?.startedAt)
        break
      case 'progress.finishedAt':
        primary = nullsLast((it) => mp.get(it.row.id)?.finishedAt)
        break
      case 'random':
        return () => Math.random() - 0.5
      default:
        primary = () => 0
    }
    if (seriesIds && sortBy !== 'sequence') return (a, b) => primary(a, b) || bySeq(a, b)
    return primary
  }

  items(q: ItemsQuery): { results: Array<Record<string, unknown>>; total: number } {
    let { group, value } = parseFilter(q.filterBy)
    let collapseseries = q.collapseseries
    let sortBy = q.sortBy
    if (group === 'series' && collapseseries) collapseseries = false
    if (group !== 'series' && sortBy === 'sequence') sortBy = 'media.metadata.title'

    const filtered = this.applyFilter(this.all(q.libraryIds), group, value, q.userId, q.libraryIds, !!q.isHomePage)
    let items = filtered.items
    const prefixes = this.prefixes()

    // Collapsed series: one card per series (its first book), other books hidden.
    const collapsed = new Map<string, { id: string; name: string; nameIgnorePrefix: string; sequence: string | null; numBooks: number; libraryItemIds: string[] }>()
    if (collapseseries) {
      const groups = this.seriesGroups(q.libraryIds)
      const exclude = new Set<string>()
      const included = new Set<string>()
      const byItem = new Map(items.map((it) => [it.row.id, it]))
      const allInLibs = this.all(q.libraryIds)
      for (const [canonical, members] of groups) {
        const ids = new Set(members.map((m) => m.id))
        const books = items.filter((it) => it.seriesIds.some((s) => ids.has(s))).sort((a, b) => cmpSeqNullsLast(this.seriesRefOf(a, ids)?.sequence, this.seriesRefOf(b, ids)?.sequence))
        if (!books.length) continue
        const numBooks = allInLibs.filter((it) => it.seriesIds.some((s) => ids.has(s))).length
        let found = false
        for (const book of books) {
          if (!found && !included.has(book.row.id)) {
            included.add(book.row.id)
            exclude.delete(book.row.id)
            collapsed.set(book.row.id, { id: canonical, name: members[0].name, nameIgnorePrefix: members[0].nameIgnorePrefix, sequence: this.seriesRefOf(book, ids)?.sequence ?? null, numBooks, libraryItemIds: books.map((b) => b.row.id) })
            found = true
          } else if (!exclude.has(book.row.id) && !included.has(book.row.id)) exclude.add(book.row.id)
        }
      }
      items = items.filter((it) => !exclude.has(it.row.id) && byItem.has(it.row.id))
    }

    const displayTitle = collapseseries ? (it: IndexedItem) => (collapsed.has(it.row.id) ? (this.sortingIgnorePrefix() ? collapsed.get(it.row.id)!.nameIgnorePrefix : collapsed.get(it.row.id)!.name) : this.titleKey(it)) : undefined
    items.sort(this.comparator(sortBy, q.sortDesc, q.userId, filtered.seriesIds, displayTitle))

    const total = items.length
    const page = q.limit ? items.slice(q.offset, q.offset + q.limit) : items
    const sets = this.sets(q.libraryIds)
    const results = page.map((it) => {
      const json = toMinified(it.item, prefixes) as Record<string, unknown>
      if (filtered.seriesIds) {
        const ref = this.seriesRefOf(it, filtered.seriesIds)
        if (ref) json.series = { id: ref.id, name: ref.name, sequence: ref.sequence ?? null }
      }
      const c = collapsed.get(it.row.id)
      if (c) json.collapsedSeries = c
      const set = sets.get(it.row.id)
      if (set) json.editions = { count: set.members.length, alternates: set.members.filter((m) => m.id !== it.row.id).map(({ id, serverKey, narratorName, duration }) => ({ id, serverKey, narratorName, duration })) }
      return json
    })
    return { results, total }
  }

  // ---- search ----

  search(libraryIds: string[], userId: string, query: string, limit: number) {
    const q = query.toLowerCase()
    const prefixes = this.prefixes()
    const all = this.all(libraryIds)
    const matches = (s: string | null | undefined) => !!s && s.toLowerCase().includes(q)
    const book = all
      .filter((it) => matches(it.row.title) || matches(it.row.subtitle) || matches(it.row.asin) || matches(it.row.isbn))
      .slice(0, limit)
      .map((it) => ({ libraryItem: this.expanded(it, prefixes) }))
    const countValues = (pick: (it: IndexedItem) => string[], key: 'numBooks' | 'numItems') => {
      const counts = new Map<string, number>()
      for (const it of all) for (const v of pick(it)) if (matches(v)) counts.set(v, (counts.get(v) ?? 0) + 1)
      return [...counts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([name, n]) => ({ name, [key]: n }))
    }
    const narrators = countValues((it) => it.narrators, 'numBooks')
    const tags = countValues((it) => it.tags, 'numItems')
    const genres = countValues((it) => it.genres, 'numItems')
    const series: Array<{ series: OldSeries; books: unknown[] }> = []
    for (const [canonical, members] of this.seriesGroups(libraryIds)) {
      if (!matches(members[0].name)) continue
      const ids = new Set(members.map((m) => m.id))
      const books = all.filter((it) => it.seriesIds.some((s) => ids.has(s))).map((it) => this.expanded(it, prefixes))
      if (books.length) series.push({ series: this.oldSeries(canonical, members), books })
      if (series.length >= limit) break
    }
    const authors: unknown[] = []
    for (const [canonical, members] of this.authorGroups(libraryIds)) {
      if (!matches(members[0].name)) continue
      const ids = new Set(members.map((m) => m.id))
      authors.push(this.oldAuthor(canonical, members, all.filter((it) => it.authorIds.some((a) => ids.has(a))).length))
      if (authors.length >= limit) break
    }
    return { book, narrators, tags, genres, series, authors }
  }

  /** Expanded old JSON for search results and series books, from the stored item. */
  private expanded(it: IndexedItem, prefixes: string[]): Record<string, unknown> {
    const min = toMinified(it.item, prefixes) as { media: { metadata: Record<string, unknown> } }
    const m = it.item.media.metadata
    min.media.metadata = { ...min.media.metadata, authors: m.authors ?? [], narrators: m.narrators ?? [], series: m.series ?? [], descriptionPlain: m.description ? m.description.replace(/<[^>]*>/g, '') : null }
    return min as unknown as Record<string, unknown>
  }

  // ---- filterdata ----

  filterdata(libraryIds: string[]) {
    const all = this.all(libraryIds)
    const genres = new Set<string>()
    const tags = new Set<string>()
    const narrators = new Set<string>()
    const languages = new Set<string>()
    const publishers = new Set<string>()
    const decades = new Set<string>()
    let numIssues = 0
    for (const it of all) {
      if (it.row.isMissing || it.row.isInvalid) numIssues++
      it.genres.forEach((g) => genres.add(g))
      it.tags.forEach((t) => tags.add(t))
      it.narrators.forEach((n) => narrators.add(n))
      if (it.row.publisher) publishers.add(it.row.publisher)
      if (it.row.language) languages.add(it.row.language)
      const y = it.row.publishedYear
      if (y && y > 0 && y < 3000) decades.add(String(Math.floor(y / 10) * 10))
    }
    const nat = (arr: string[]) => [...arr].sort(naturalCollator.compare)
    const seriesGroups = this.seriesGroups(libraryIds)
    const authorGroups = this.authorGroups(libraryIds)
    return {
      authors: [...authorGroups].map(([id, m]) => ({ id, name: m[0].name })).sort((a, b) => naturalCollator.compare(a.name, b.name)),
      genres: nat([...genres]),
      tags: nat([...tags]),
      series: [...seriesGroups].map(([id, m]) => ({ id, name: m[0].name || 'No Title' })).sort((a, b) => naturalCollator.compare(a.name, b.name)),
      narrators: nat([...narrators]),
      languages: nat([...languages]),
      publishers: nat([...publishers]),
      publishedDecades: nat([...decades]),
      bookCount: all.length,
      authorCount: authorGroups.size,
      seriesCount: seriesGroups.size,
      podcastCount: 0,
      numIssues,
      loadedAt: Date.now()
    }
  }

  // ---- series ----

  private oldSeries(canonical: string, members: SeriesRow[], libraryId?: string): OldSeries {
    const first = members[0]
    return {
      id: canonical,
      name: first.name,
      nameIgnorePrefix: first.nameIgnorePrefix,
      description: members.find((m) => m.description)?.description ?? null,
      addedAt: Math.min(...members.map((m) => m.addedAt || Date.now())),
      updatedAt: Math.max(...members.map((m) => m.updatedAt || 0)),
      libraryId: libraryId ?? first.libraryId
    }
  }

  private oldAuthor(canonical: string, members: AuthorRow[], numBooks: number, libraryId?: string) {
    const first = members[0]
    const withImage = members.find((m) => m.imagePath)
    return {
      id: withImage?.id ?? canonical,
      asin: members.find((m) => m.asin)?.asin ?? null,
      name: first.name,
      description: members.find((m) => m.description)?.description ?? null,
      imagePath: withImage?.imagePath ?? null,
      libraryId: libraryId ?? first.libraryId,
      addedAt: Math.min(...members.map((m) => m.addedAt || Date.now())),
      updatedAt: Math.max(...members.map((m) => m.updatedAt || 0)),
      numBooks,
      lastFirst: first.lastFirst
    }
  }

  /** Books of a series group, sorted by sequence, as minified items with `sequence` set. */
  private seriesBooks(all: IndexedItem[], ids: Set<string>, prefixes: string[]): Array<{ it: IndexedItem; json: Record<string, unknown> }> {
    return all
      .filter((it) => it.seriesIds.some((s) => ids.has(s)))
      .map((it) => ({ it, sequence: this.seriesRefOf(it, ids)?.sequence ?? null }))
      .sort((a, b) => cmpSeqText(a.sequence, b.sequence))
      .map(({ it, sequence }) => {
        const json = toMinified(it.item, prefixes) as Record<string, unknown>
        json.sequence = sequence
        return { it, json }
      })
  }

  series(q: SeriesQuery, libraryIdForJson: string): { series: OldSeries[]; count: number } {
    const { group, value } = parseFilter(q.filterBy)
    const all = this.all(q.libraryIds)
    const mp = this.progressMap(q.userId)
    const prefixes = this.prefixes()
    const out: Array<OldSeries & { _sort: number }> = []
    for (const [canonical, members] of this.seriesGroups(q.libraryIds)) {
      const ids = new Set(members.map((m) => m.id))
      const books = this.seriesBooks(all, ids, prefixes)
      if (!books.length) continue
      if (q.hideSingleBookSeries && books.length < 2) continue
      const bookMatches = (pred: (it: IndexedItem) => boolean) => books.some((b) => pred(b.it))
      const p = (it: IndexedItem) => mp.get(it.row.id)
      let keep = true
      if (group === 'genres') keep = bookMatches((it) => it.genres.includes(value ?? ''))
      else if (group === 'tags') keep = bookMatches((it) => it.tags.includes(value ?? ''))
      else if (group === 'narrators') keep = bookMatches((it) => it.narrators.includes(value ?? ''))
      else if (group === 'authors') {
        const g = value ? this.expandGroup(this.authorGroups(q.libraryIds), value) : null
        keep = !!g && bookMatches((it) => it.authorIds.some((a) => g.ids.has(a)))
      } else if (group === 'publishers') keep = bookMatches((it) => it.row.publisher === value)
      else if (group === 'languages') keep = bookMatches((it) => it.row.language === value)
      else if (group === 'progress') {
        if (value === 'not-finished') keep = bookMatches((it) => !p(it)?.isFinished)
        else if (value === 'finished') keep = !bookMatches((it) => !p(it)?.isFinished)
        else if (value === 'not-started') keep = !bookMatches((it) => !!p(it)?.isFinished || (p(it)?.currentTime ?? 0) > 0)
        else if (value === 'in-progress') keep = bookMatches((it) => ((p(it)?.currentTime ?? 0) > 0 || (p(it)?.ebookProgress ?? 0) > 0) && p(it)?.isFinished === false)
      }
      if (!keep) continue
      const s = this.oldSeries(canonical, members, libraryIdForJson)
      s.books = books.map((b) => b.json)
      let sortVal = 0
      switch (q.sortBy) {
        case 'numBooks':
          sortVal = books.length
          break
        case 'addedAt':
          sortVal = s.addedAt
          break
        case 'totalDuration':
          s.totalDuration = books.reduce((n, b) => n + b.it.row.duration, 0)
          sortVal = s.totalDuration
          break
        case 'lastBookAdded':
          sortVal = Math.max(...books.map((b) => b.it.row.addedAt))
          break
        case 'lastBookUpdated':
          sortVal = Math.max(...books.map((b) => b.it.row.updatedAt))
          break
        case 'random':
          sortVal = Math.random()
          break
      }
      out.push({ ...s, _sort: sortVal })
    }
    const dir = q.sortDesc ? -1 : 1
    if (q.sortBy === 'name') out.sort((a, b) => cmpStr(this.sortingIgnorePrefix() ? a.nameIgnorePrefix : a.name, this.sortingIgnorePrefix() ? b.nameIgnorePrefix : b.name) * dir)
    else if (q.sortBy) out.sort((a, b) => (a._sort - b._sort) * dir)
    const count = out.length
    const page = q.limit ? out.slice(q.offset, q.offset + q.limit) : out
    return { series: page.map(({ _sort, ...s }) => s), count }
  }

  seriesDetail(libraryIds: string[], seriesId: string, libraryIdForJson: string): { series: OldSeries; itemIds: string[] } | null {
    const g = this.expandGroup(this.seriesGroups(libraryIds), seriesId)
    if (!g) return null
    const books = this.seriesBooks(this.all(libraryIds), g.ids, this.prefixes())
    return { series: this.oldSeries(g.canonical, g.members, libraryIdForJson), itemIds: books.map((b) => b.it.row.id) }
  }

  // ---- authors / narrators ----

  authors(libraryIds: string[], libraryIdForJson: string) {
    const all = this.all(libraryIds)
    return [...this.authorGroups(libraryIds)].map(([canonical, members]) => {
      const ids = new Set(members.map((m) => m.id))
      return this.oldAuthor(canonical, members, all.filter((it) => it.authorIds.some((a) => ids.has(a))).length, libraryIdForJson)
    })
  }

  /**
   * Author landing page: the author (any member id of the group) with their
   * books across all source libraries, and those books grouped by series.
   * Mirrors AuthorController.findOne upstream.
   */
  authorDetail(libraryIds: string[], authorId: string, libraryIdForJson: string) {
    const g = this.expandGroup(this.authorGroups(libraryIds), authorId)
    if (!g) return null
    const all = this.all(libraryIds)
    const prefixes = this.prefixes()
    const books = all.filter((it) => it.authorIds.some((a) => g.ids.has(a)))
    const seriesGroups = this.seriesGroups(libraryIds)
    const seriesMap = new Map<string, { id: string; name: string; items: Array<Record<string, unknown>> }>()
    for (const it of books) {
      for (const s of it.item.media.metadata.series ?? []) {
        const sg = this.expandGroup(seriesGroups, s.id)
        const canonical = sg?.canonical ?? s.id
        const name = sg?.members[0].name ?? s.name
        const json = toMinified(it.item, prefixes) as { media: { metadata: Record<string, unknown> } }
        json.media.metadata.series = { id: canonical, name, nameIgnorePrefix: sg?.members[0].nameIgnorePrefix ?? name, sequence: s.sequence ?? null }
        const entry = seriesMap.get(canonical) ?? { id: canonical, name, items: [] }
        entry.items.push(json as unknown as Record<string, unknown>)
        seriesMap.set(canonical, entry)
      }
    }
    for (const entry of seriesMap.values()) entry.items.sort((a, b) => cmpSeqText((a.media as { metadata: { series: { sequence: string | null } } }).metadata.series.sequence, (b.media as { metadata: { series: { sequence: string | null } } }).metadata.series.sequence))
    const author = this.oldAuthor(g.canonical, g.members, books.length, libraryIdForJson)
    return { author, libraryItems: books.map((it) => toMinified(it.item, prefixes)), series: [...seriesMap.values()] }
  }

  narrators(libraryIds: string[]) {
    const counts = new Map<string, number>()
    for (const it of this.all(libraryIds)) for (const n of it.narrators) counts.set(n, (counts.get(n) ?? 0) + 1)
    return [...counts]
      .map(([name, numBooks]) => ({ id: encodeURIComponent(Buffer.from(name).toString('base64')), name, numBooks }))
      .sort((a, b) => naturalCollator.compare(a.name, b.name))
  }

  // ---- stats ----

  stats(libraryIds: string[]) {
    const all = this.all(libraryIds)
    const authors = this.authors(libraryIds, libraryIds[0] ?? '')
    const genreCounts = new Map<string, number>()
    for (const it of all) for (const g of it.genres) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1)
    const genresWithCount = [...genreCounts].map(([genre, count]) => ({ genre, count })).sort((a, b) => b.count - a.count)
    return {
      largestItems: [...all]
        .sort((a, b) => b.row.size - a.row.size)
        .slice(0, 10)
        .map((it) => ({ id: it.row.id, title: it.row.title, size: it.row.size })),
      totalAuthors: authors.length,
      authorsWithCount: [...authors]
        .sort((a, b) => b.numBooks - a.numBooks)
        .slice(0, 10)
        .map((a) => ({ id: a.id, name: a.name, count: a.numBooks })),
      totalGenres: genresWithCount.length,
      genresWithCount,
      totalItems: all.length,
      longestItems: [...all]
        .sort((a, b) => b.row.duration - a.row.duration)
        .slice(0, 10)
        .map((it) => ({ id: it.row.id, title: it.row.title, duration: it.row.duration })),
      totalSize: all.reduce((n, it) => n + it.row.size, 0),
      totalDuration: all.reduce((n, it) => n + it.row.duration, 0),
      numAudioTracks: all.reduce((n, it) => n + it.row.numAudioFiles, 0)
    }
  }

  // ---- shelves ----

  recentlyAdded(libraryIds: string[], limit: number) {
    const r = this.items({ libraryIds, userId: '', filterBy: 'recent', sortBy: 'addedAt', sortDesc: true, collapseseries: false, limit, offset: 0 })
    return { libraryItems: r.results, count: r.total }
  }

  recentSeries(libraryIds: string[], limit: number, hideSingleBookSeries: boolean, libraryIdForJson: string) {
    const all = this.all(libraryIds)
    const prefixes = this.prefixes()
    const cutoff = Date.now() - SIXTY_DAYS
    const out: OldSeries[] = []
    for (const [canonical, members] of this.seriesGroups(libraryIds)) {
      const s = this.oldSeries(canonical, members, libraryIdForJson)
      if (s.addedAt < cutoff) continue
      const ids = new Set(members.map((m) => m.id))
      const books = this.seriesBooks(all, ids, prefixes)
      if (!books.length || (hideSingleBookSeries && books.length < 2)) continue
      s.books = books.map((b) => b.json)
      out.push(s)
    }
    out.sort((a, b) => b.addedAt - a.addedAt)
    return { series: out.slice(0, limit), count: out.length }
  }

  /** Random not-started books; from a series only its first book, and only when the series is untouched. */
  discover(libraryIds: string[], userId: string, limit: number) {
    const all = this.all(libraryIds)
    const mp = this.progressMap(userId)
    const touched = (it: IndexedItem) => !!mp.get(it.row.id)?.isFinished || (mp.get(it.row.id)?.currentTime ?? 0) > 0
    const firstBooks = new Set<string>()
    for (const [, members] of this.seriesGroups(libraryIds)) {
      const ids = new Set(members.map((m) => m.id))
      const books = all.filter((it) => it.seriesIds.some((s) => ids.has(s)))
      if (!books.length || books.some(touched)) continue
      books.sort((a, b) => cmpSeqNullsLast(this.seriesRefOf(a, ids)?.sequence, this.seriesRefOf(b, ids)?.sequence))
      firstBooks.add(books[0].row.id)
    }
    const pool = all.filter((it) => !touched(it) && (!it.seriesIds.length || firstBooks.has(it.row.id)))
    const picked = [...pool].sort(() => Math.random() - 0.5).slice(0, limit)
    const prefixes = this.prefixes()
    return { libraryItems: picked.map((it) => toMinified(it.item, prefixes)), count: pool.length }
  }

  newestAuthors(libraryIds: string[], limit: number, libraryIdForJson: string) {
    const cutoff = Date.now() - SIXTY_DAYS
    const authors = this.authors(libraryIds, libraryIdForJson).filter((a) => a.numBooks > 0 && a.addedAt >= cutoff)
    authors.sort((a, b) => b.addedAt - a.addedAt)
    return { authors: authors.slice(0, limit), count: authors.length }
  }

  /** Books of the series `seriesId` (any member id) sorted by sequence, for Continue Series. */
  seriesItemsForContinue(libraryIds: string[], seriesId: string): Array<{ id: string; sequence: string | null; json: Record<string, unknown> }> {
    const g = this.expandGroup(this.seriesGroups(libraryIds), seriesId)
    if (!g) return []
    return this.seriesBooks(this.all(libraryIds), g.ids, this.prefixes()).map((b) => ({ id: b.it.row.id, sequence: (b.json.sequence as string | null) ?? null, json: b.json }))
  }
}
