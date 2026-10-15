import { openDb } from '../../src/db.js'
import { IndexStore } from '../../src/index/store.js'
import { ProgressStore } from '../../src/progress.js'
import { IndexQuery } from '../../src/index/query.js'
import type { ExpandedBookItem } from '../../src/index/minify.js'

export const PREFIXES = ['the', 'a', 'an']

let n = 0
const uuid = () => {
  n++
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

export interface BookSpec {
  id?: string
  title: string
  author?: string
  authorId?: string
  narrators?: string[]
  series?: Array<{ id?: string; name: string; sequence?: string | null }>
  genres?: string[]
  tags?: string[]
  libraryId?: string
  duration?: number
  size?: number
  addedAt?: number
  publishedYear?: string | null
  publisher?: string | null
  language?: string | null
  asin?: string | null
  isbn?: string | null
  abridged?: boolean
  explicit?: boolean
  numAudioFiles?: number
  coverPath?: string | null
  subtitle?: string | null
}

/** A minimal expanded item as upstream's batch/get returns it. */
export function book(spec: BookSpec): ExpandedBookItem {
  const id = spec.id ?? uuid()
  const author = spec.author ?? 'Jane Doe'
  const authorId = spec.authorId ?? `author-${author.toLowerCase().replace(/\s+/g, '-')}`
  const series = (spec.series ?? []).map((s) => ({ id: s.id ?? `series-${s.name.toLowerCase().replace(/\s+/g, '-')}`, name: s.name, sequence: s.sequence ?? null }))
  const numAudioFiles = spec.numAudioFiles ?? 1
  return {
    id,
    ino: `ino-${id}`,
    libraryId: spec.libraryId ?? 'lib-a',
    folderId: 'folder',
    path: `/books/${spec.title}`,
    relPath: spec.title,
    isFile: false,
    mtimeMs: 1,
    ctimeMs: 1,
    birthtimeMs: 1,
    addedAt: spec.addedAt ?? 1_700_000_000_000,
    updatedAt: spec.addedAt ?? 1_700_000_000_000,
    isMissing: false,
    isInvalid: false,
    mediaType: 'book',
    media: {
      id: `media-${id}`,
      metadata: {
        title: spec.title,
        subtitle: spec.subtitle ?? null,
        authors: [{ id: authorId, name: author }],
        narrators: spec.narrators ?? [],
        series,
        genres: spec.genres ?? [],
        publishedYear: spec.publishedYear ?? null,
        publishedDate: null,
        publisher: spec.publisher ?? null,
        description: null,
        isbn: spec.isbn ?? null,
        asin: spec.asin ?? null,
        language: spec.language ?? null,
        explicit: spec.explicit ?? false,
        abridged: spec.abridged ?? false
      },
      coverPath: spec.coverPath === undefined ? '/cover.jpg' : spec.coverPath,
      tags: spec.tags ?? [],
      audioFiles: Array.from({ length: numAudioFiles }, (_, i) => ({ index: i })),
      chapters: [],
      duration: spec.duration ?? 3600,
      size: spec.size ?? 50_000_000,
      tracks: Array.from({ length: numAudioFiles }, (_, i) => ({ index: i }))
    },
    libraryFiles: [{}],
    size: spec.size ?? 50_000_000
  }
}

export function makeIndex() {
  const db = openDb(':memory:')
  const store = new IndexStore(db, () => PREFIXES)
  const progress = new ProgressStore(db)
  let ignorePrefix = true
  const query = new IndexQuery(store, progress, () => PREFIXES, () => ignorePrefix)
  return { db, store, progress, query, setIgnorePrefix: (v: boolean) => (ignorePrefix = v) }
}
