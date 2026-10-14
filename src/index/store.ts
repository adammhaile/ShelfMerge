import type { Db } from '../db.js'
import { strip, titleIgnorePrefix, nameLastFirst, type ExpandedBookItem, type StoredItem } from './minify.js'

export interface ItemRow {
  id: string
  serverKey: string
  libraryId: string
  json: string
  title: string
  titleIgnorePrefix: string
  authorName: string
  authorNameLF: string
  publishedYear: number | null
  publisher: string | null
  language: string | null
  addedAt: number
  updatedAt: number
  birthtimeMs: number | null
  mtimeMs: number | null
  size: number
  duration: number
  numAudioFiles: number
  hasEbook: number
  isMissing: number
  isInvalid: number
  explicit: number
  abridged: number
  asin: string | null
  isbn: string | null
  subtitle: string | null
  coverPath: string | null
  description: string | null
  numChapters: number
  narrators: string
  genres: string
  tags: string
}

export interface SeriesRow {
  id: string
  serverKey: string
  libraryId: string
  name: string
  nameIgnorePrefix: string
  description: string | null
  addedAt: number
  updatedAt: number
}

export interface AuthorRow {
  id: string
  serverKey: string
  libraryId: string
  name: string
  lastFirst: string
  description: string | null
  imagePath: string | null
  asin: string | null
  addedAt: number
  updatedAt: number
}

const schema = `
CREATE TABLE IF NOT EXISTS idx_items (
  id TEXT PRIMARY KEY,
  serverKey TEXT NOT NULL,
  libraryId TEXT NOT NULL,
  json TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  titleIgnorePrefix TEXT NOT NULL DEFAULT '',
  authorName TEXT NOT NULL DEFAULT '',
  authorNameLF TEXT NOT NULL DEFAULT '',
  publishedYear INTEGER,
  publisher TEXT,
  language TEXT,
  addedAt INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL DEFAULT 0,
  birthtimeMs INTEGER,
  mtimeMs INTEGER,
  size INTEGER NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  numAudioFiles INTEGER NOT NULL DEFAULT 0,
  hasEbook INTEGER NOT NULL DEFAULT 0,
  isMissing INTEGER NOT NULL DEFAULT 0,
  isInvalid INTEGER NOT NULL DEFAULT 0,
  explicit INTEGER NOT NULL DEFAULT 0,
  abridged INTEGER NOT NULL DEFAULT 0,
  asin TEXT,
  isbn TEXT,
  subtitle TEXT,
  coverPath TEXT,
  description TEXT,
  numChapters INTEGER NOT NULL DEFAULT 0,
  narrators TEXT NOT NULL DEFAULT '[]',
  genres TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_items_library ON idx_items(libraryId);
CREATE INDEX IF NOT EXISTS idx_items_title ON idx_items(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_items_added ON idx_items(addedAt);
CREATE TABLE IF NOT EXISTS idx_item_series (
  itemId TEXT NOT NULL REFERENCES idx_items(id) ON DELETE CASCADE,
  seriesId TEXT NOT NULL,
  sequence TEXT,
  PRIMARY KEY (itemId, seriesId)
);
CREATE INDEX IF NOT EXISTS idx_item_series_series ON idx_item_series(seriesId);
CREATE TABLE IF NOT EXISTS idx_item_authors (
  itemId TEXT NOT NULL REFERENCES idx_items(id) ON DELETE CASCADE,
  authorId TEXT NOT NULL,
  PRIMARY KEY (itemId, authorId)
);
CREATE INDEX IF NOT EXISTS idx_item_authors_author ON idx_item_authors(authorId);
CREATE TABLE IF NOT EXISTS idx_series (
  id TEXT PRIMARY KEY,
  serverKey TEXT NOT NULL,
  libraryId TEXT NOT NULL,
  name TEXT NOT NULL,
  nameIgnorePrefix TEXT NOT NULL,
  description TEXT,
  addedAt INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_series_library ON idx_series(libraryId);
CREATE TABLE IF NOT EXISTS idx_authors (
  id TEXT PRIMARY KEY,
  serverKey TEXT NOT NULL,
  libraryId TEXT NOT NULL,
  name TEXT NOT NULL,
  lastFirst TEXT NOT NULL,
  description TEXT,
  imagePath TEXT,
  asin TEXT,
  addedAt INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_authors_library ON idx_authors(libraryId);
CREATE TABLE IF NOT EXISTS idx_libraries (
  libraryId TEXT PRIMARY KEY,
  serverKey TEXT NOT NULL,
  syncedAt INTEGER NOT NULL DEFAULT 0,
  itemCount INTEGER NOT NULL DEFAULT 0
);
`

/**
 * SQLite copy of every indexed upstream library's catalog: items with the
 * columns clients sort and filter on, plus series and authors. Merged
 * libraries are answered from here; a source server being down only stops
 * playback, not browsing.
 */
export class IndexStore {
  private readonly upsertItem
  private readonly upsertSeries
  private readonly upsertAuthor
  private readonly delItemSeries
  private readonly insItemSeries
  private readonly delItemAuthors
  private readonly insItemAuthor

  constructor(
    readonly db: Db,
    private readonly prefixes: () => string[]
  ) {
    db.exec(schema)
    const cols = ['id', 'serverKey', 'libraryId', 'json', 'title', 'titleIgnorePrefix', 'authorName', 'authorNameLF', 'publishedYear', 'publisher', 'language', 'addedAt', 'updatedAt', 'birthtimeMs', 'mtimeMs', 'size', 'duration', 'numAudioFiles', 'hasEbook', 'isMissing', 'isInvalid', 'explicit', 'abridged', 'asin', 'isbn', 'subtitle', 'coverPath', 'description', 'numChapters', 'narrators', 'genres', 'tags']
    this.upsertItem = db.prepare(`INSERT INTO idx_items (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')}) ON CONFLICT(id) DO UPDATE SET ${cols
      .filter((c) => c !== 'id')
      .map((c) => `${c} = excluded.${c}`)
      .join(', ')}`)
    this.upsertSeries = db.prepare(
      `INSERT INTO idx_series (id, serverKey, libraryId, name, nameIgnorePrefix, description, addedAt, updatedAt) VALUES (@id, @serverKey, @libraryId, @name, @nameIgnorePrefix, @description, @addedAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, nameIgnorePrefix = excluded.nameIgnorePrefix, description = COALESCE(excluded.description, idx_series.description),
       addedAt = CASE WHEN excluded.addedAt > 0 THEN excluded.addedAt ELSE idx_series.addedAt END, updatedAt = MAX(excluded.updatedAt, idx_series.updatedAt)`
    )
    this.upsertAuthor = db.prepare(
      `INSERT INTO idx_authors (id, serverKey, libraryId, name, lastFirst, description, imagePath, asin, addedAt, updatedAt) VALUES (@id, @serverKey, @libraryId, @name, @lastFirst, @description, @imagePath, @asin, @addedAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, lastFirst = excluded.lastFirst, description = COALESCE(excluded.description, idx_authors.description), imagePath = COALESCE(excluded.imagePath, idx_authors.imagePath),
       asin = COALESCE(excluded.asin, idx_authors.asin), addedAt = CASE WHEN excluded.addedAt > 0 THEN excluded.addedAt ELSE idx_authors.addedAt END, updatedAt = MAX(excluded.updatedAt, idx_authors.updatedAt)`
    )
    this.delItemSeries = db.prepare('DELETE FROM idx_item_series WHERE itemId = ?')
    this.insItemSeries = db.prepare('INSERT OR REPLACE INTO idx_item_series (itemId, seriesId, sequence) VALUES (?, ?, ?)')
    this.delItemAuthors = db.prepare('DELETE FROM idx_item_authors WHERE itemId = ?')
    this.insItemAuthor = db.prepare('INSERT OR REPLACE INTO idx_item_authors (itemId, authorId) VALUES (?, ?)')
  }

  /** Store an expanded upstream item (book libraries only). */
  putItem(serverKey: string, item: ExpandedBookItem) {
    if (item.mediaType !== 'book' || !item.media?.metadata) return
    const stored = strip(item)
    const m = stored.media.metadata
    const prefixes = this.prefixes()
    const authors = m.authors ?? []
    const series = m.series ?? []
    const row: ItemRow = {
      id: stored.id,
      serverKey,
      libraryId: stored.libraryId,
      json: JSON.stringify(stored),
      title: m.title ?? '',
      titleIgnorePrefix: titleIgnorePrefix(m.title ?? '', prefixes),
      authorName: m.authorName ?? authors.map((a) => a.name).join(', '),
      authorNameLF: m.authorNameLF ?? authors.map((a) => nameLastFirst(a.name)).join(', '),
      publishedYear: m.publishedYear && !Number.isNaN(Number(m.publishedYear)) ? Number(m.publishedYear) : null,
      publisher: m.publisher ?? null,
      language: m.language ?? null,
      addedAt: stored.addedAt ?? 0,
      updatedAt: stored.updatedAt ?? 0,
      birthtimeMs: stored.birthtimeMs ?? null,
      mtimeMs: stored.mtimeMs ?? null,
      size: stored.size ?? 0,
      duration: stored.media.duration ?? 0,
      numAudioFiles: stored.media.numAudioFiles ?? 0,
      hasEbook: stored.media.ebookFormat ? 1 : 0,
      isMissing: stored.isMissing ? 1 : 0,
      isInvalid: stored.isInvalid ? 1 : 0,
      explicit: m.explicit ? 1 : 0,
      abridged: m.abridged ? 1 : 0,
      asin: m.asin ?? null,
      isbn: m.isbn ?? null,
      subtitle: m.subtitle ?? null,
      coverPath: stored.media.coverPath ?? null,
      description: m.description ?? null,
      numChapters: stored.media.numChapters ?? 0,
      narrators: JSON.stringify(m.narrators ?? []),
      genres: JSON.stringify(m.genres ?? []),
      tags: JSON.stringify(stored.media.tags ?? [])
    }
    this.db.transaction(() => {
      this.upsertItem.run(row)
      this.delItemSeries.run(row.id)
      for (const s of series) {
        this.insItemSeries.run(row.id, s.id, s.sequence ?? null)
        this.upsertSeries.run({ id: s.id, serverKey, libraryId: row.libraryId, name: s.name, nameIgnorePrefix: titleIgnorePrefix(s.name, prefixes), description: null, addedAt: 0, updatedAt: 0 })
      }
      this.delItemAuthors.run(row.id)
      for (const a of authors) {
        this.insItemAuthor.run(row.id, a.id)
        this.upsertAuthor.run({ id: a.id, serverKey, libraryId: row.libraryId, name: a.name, lastFirst: nameLastFirst(a.name), description: null, imagePath: null, asin: null, addedAt: 0, updatedAt: 0 })
      }
    })()
  }

  putSeries(row: SeriesRow) {
    this.upsertSeries.run(row)
  }

  putAuthor(row: AuthorRow) {
    this.upsertAuthor.run(row)
  }

  removeItem(id: string) {
    this.db.prepare('DELETE FROM idx_items WHERE id = ?').run(id)
  }

  removeSeries(id: string) {
    this.db.prepare('DELETE FROM idx_series WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM idx_item_series WHERE seriesId = ?').run(id)
  }

  removeAuthor(id: string) {
    this.db.prepare('DELETE FROM idx_authors WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM idx_item_authors WHERE authorId = ?').run(id)
  }

  /** Drop everything of a library that is not in `keepIds` (after a full pull). */
  pruneLibrary(libraryId: string, keepIds: Set<string>) {
    const ids = (this.db.prepare('SELECT id FROM idx_items WHERE libraryId = ?').all(libraryId) as Array<{ id: string }>).map((r) => r.id)
    const del = this.db.prepare('DELETE FROM idx_items WHERE id = ?')
    this.db.transaction(() => {
      for (const id of ids) if (!keepIds.has(id)) del.run(id)
      // Series and authors no longer referenced by any item in this library.
      this.db.prepare('DELETE FROM idx_series WHERE libraryId = ? AND id NOT IN (SELECT seriesId FROM idx_item_series)').run(libraryId)
      this.db.prepare('DELETE FROM idx_authors WHERE libraryId = ? AND id NOT IN (SELECT authorId FROM idx_item_authors)').run(libraryId)
    })()
  }

  removeLibrary(libraryId: string) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM idx_items WHERE libraryId = ?').run(libraryId)
      this.db.prepare('DELETE FROM idx_series WHERE libraryId = ?').run(libraryId)
      this.db.prepare('DELETE FROM idx_authors WHERE libraryId = ?').run(libraryId)
      this.db.prepare('DELETE FROM idx_libraries WHERE libraryId = ?').run(libraryId)
    })()
  }

  markSynced(libraryId: string, serverKey: string, itemCount: number) {
    this.db.prepare('INSERT INTO idx_libraries (libraryId, serverKey, syncedAt, itemCount) VALUES (?, ?, ?, ?) ON CONFLICT(libraryId) DO UPDATE SET serverKey = excluded.serverKey, syncedAt = excluded.syncedAt, itemCount = excluded.itemCount').run(libraryId, serverKey, Date.now(), itemCount)
  }

  syncedAt(libraryId: string): number {
    return (this.db.prepare('SELECT syncedAt FROM idx_libraries WHERE libraryId = ?').get(libraryId) as { syncedAt: number } | undefined)?.syncedAt ?? 0
  }

  getItem(id: string): StoredItem | undefined {
    const row = this.db.prepare('SELECT json FROM idx_items WHERE id = ?').get(id) as { json: string } | undefined
    return row ? (JSON.parse(row.json) as StoredItem) : undefined
  }

  itemLibrary(id: string): string | undefined {
    return (this.db.prepare('SELECT libraryId FROM idx_items WHERE id = ?').get(id) as { libraryId: string } | undefined)?.libraryId
  }

  countItems(libraryIds: string[]): number {
    if (!libraryIds.length) return 0
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM idx_items WHERE libraryId IN (${libraryIds.map(() => '?').join(',')})`).get(...libraryIds) as { n: number }).n
  }
}
