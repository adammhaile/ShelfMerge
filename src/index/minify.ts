/**
 * Conversions between Audiobookshelf's expanded library item JSON (what we
 * pull from upstream and store) and the minified JSON the clients expect
 * from list endpoints. Shapes follow LibraryItem.toOldJSONMinified() and
 * Book.oldMetadataToJSONMinified() upstream.
 */

export interface AuthorRef {
  id: string
  name: string
}

export interface SeriesRef {
  id: string
  name: string
  sequence: string | null
}

export interface ExpandedBookItem {
  id: string
  ino: string
  oldLibraryItemId?: string | null
  libraryId: string
  folderId: string
  path: string
  relPath: string
  isFile: boolean
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  addedAt: number
  updatedAt: number
  isMissing: boolean
  isInvalid: boolean
  mediaType: 'book'
  media: {
    id: string
    libraryItemId?: string
    metadata: {
      title: string
      titleIgnorePrefix?: string
      subtitle: string | null
      authors: AuthorRef[]
      narrators: string[]
      series: SeriesRef[]
      genres: string[]
      publishedYear: string | null
      publishedDate: string | null
      publisher: string | null
      description: string | null
      isbn: string | null
      asin: string | null
      language: string | null
      explicit: boolean
      abridged: boolean
      authorName?: string
      authorNameLF?: string
      narratorName?: string
      seriesName?: string
    }
    coverPath: string | null
    tags: string[]
    audioFiles?: unknown[]
    chapters?: unknown[]
    ebookFile?: { ebookFormat?: string } | null
    duration: number
    size: number
    tracks?: unknown[]
    numTracks?: number
    numAudioFiles?: number
    numChapters?: number
    ebookFormat?: string | null
  }
  libraryFiles?: unknown[]
  numFiles?: number
  size: number
}

/** What we keep per item: the expanded item without the heavy per-file arrays. */
export interface StoredItem extends Omit<ExpandedBookItem, 'libraryFiles'> {
  numFiles: number
}

export function strip(item: ExpandedBookItem): StoredItem {
  const { libraryFiles, ...rest } = item
  const media = { ...item.media }
  const numTracks = media.tracks?.length ?? media.numTracks ?? media.audioFiles?.length ?? 0
  const numAudioFiles = media.audioFiles?.length ?? media.numAudioFiles ?? 0
  const numChapters = media.chapters?.length ?? media.numChapters ?? 0
  const ebookFormat = media.ebookFile?.ebookFormat ?? media.ebookFormat ?? null
  delete media.audioFiles
  delete media.chapters
  delete media.tracks
  delete media.ebookFile
  return { ...rest, media: { ...media, numTracks, numAudioFiles, numChapters, ebookFormat }, numFiles: libraryFiles?.length ?? item.numFiles ?? 0 }
}

/** Upstream's getTitlePrefixAtEnd: "The Book" -> "Book, The" for configured prefixes. */
export function titleIgnorePrefix(title: string, prefixes: string[]): string {
  if (!title) return ''
  const lower = title.toLowerCase()
  for (const prefix of prefixes) {
    if (lower.startsWith(`${prefix} `)) return `${title.slice(prefix.length + 1)}, ${prefix[0].toUpperCase()}${prefix.slice(1)}`
  }
  return title
}

/** Upstream Book.authorNameLF: "First Last" -> "Last, First" per author. */
export function nameLastFirst(name: string): string {
  const trimmed = name.trim()
  if (!trimmed.includes(' ')) return trimmed
  const parts = trimmed.split(' ')
  const last = parts.pop()
  return `${last}, ${parts.join(' ')}`
}

export function seriesName(series: SeriesRef[]): string {
  return series.map((s) => (s.sequence ? `${s.name} #${s.sequence}` : s.name)).join(', ')
}

export function toMinified(item: StoredItem, prefixes: string[]): Record<string, unknown> {
  const m = item.media.metadata
  return {
    id: item.id,
    ino: item.ino,
    oldLibraryItemId: item.oldLibraryItemId ?? null,
    libraryId: item.libraryId,
    folderId: item.folderId,
    path: item.path,
    relPath: item.relPath,
    isFile: item.isFile,
    mtimeMs: item.mtimeMs,
    ctimeMs: item.ctimeMs,
    birthtimeMs: item.birthtimeMs,
    addedAt: item.addedAt,
    updatedAt: item.updatedAt,
    isMissing: !!item.isMissing,
    isInvalid: !!item.isInvalid,
    mediaType: item.mediaType,
    media: {
      id: item.media.id,
      metadata: {
        title: m.title,
        titleIgnorePrefix: titleIgnorePrefix(m.title, prefixes),
        subtitle: m.subtitle,
        authorName: m.authorName ?? m.authors.map((a) => a.name).join(', '),
        authorNameLF: m.authorNameLF ?? m.authors.map((a) => nameLastFirst(a.name)).join(', '),
        narratorName: (m.narrators ?? []).join(', '),
        seriesName: m.seriesName ?? seriesName(m.series ?? []),
        genres: [...(m.genres ?? [])],
        publishedYear: m.publishedYear,
        publishedDate: m.publishedDate,
        publisher: m.publisher,
        description: m.description,
        isbn: m.isbn,
        asin: m.asin,
        language: m.language,
        explicit: m.explicit,
        abridged: m.abridged
      },
      coverPath: item.media.coverPath,
      tags: [...(item.media.tags ?? [])],
      numTracks: item.media.numTracks ?? 0,
      numAudioFiles: item.media.numAudioFiles ?? 0,
      numChapters: item.media.numChapters ?? 0,
      duration: item.media.duration,
      size: item.media.size,
      ebookFormat: item.media.ebookFormat ?? undefined
    },
    numFiles: item.numFiles,
    size: item.size
  }
}
