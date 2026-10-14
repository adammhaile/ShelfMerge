import type { Db, ListeningSessionRow, PlaybackSessionRow } from './db.js'

/** Audiobookshelf's old playback-session JSON, what the stats pages and apps consume. */
export interface OldListeningSession {
  id: string
  userId: string
  libraryId: string | null
  libraryItemId: string
  bookId: string | null
  episodeId: string | null
  mediaType: string
  mediaMetadata: unknown
  chapters: null
  displayTitle: string
  displayAuthor: string
  coverPath: string | null
  duration: number
  playMethod: number | null
  mediaPlayer: string | null
  deviceInfo: unknown
  serverVersion: string | null
  date: string
  dayOfWeek: string
  timeListening: number
  startTime: number
  currentTime: number
  startedAt: number
  updatedAt: number
}

/** The upstream session JSON as returned by /play (minus libraryItem). */
export interface SessionSnapshot {
  id: string
  libraryId?: string | null
  libraryItemId: string
  bookId?: string | null
  episodeId?: string | null
  mediaType: string
  mediaMetadata?: unknown
  displayTitle?: string
  displayAuthor?: string
  coverPath?: string | null
  duration?: number
  playMethod?: number
  mediaPlayer?: string
  deviceInfo?: unknown
  serverVersion?: string
  date?: string
  dayOfWeek?: string
  timeListening?: number
  startTime?: number
  currentTime?: number
  startedAt?: number
  updatedAt?: number
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const dateStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function toOld(r: ListeningSessionRow): OldListeningSession {
  const isEpisode = r.mediaType === 'podcast' || !!r.episodeId
  return {
    id: r.id,
    userId: r.userId,
    libraryId: r.libraryId,
    libraryItemId: r.libraryItemId,
    bookId: isEpisode ? null : r.mediaItemId,
    episodeId: r.episodeId || null,
    mediaType: r.mediaType,
    mediaMetadata: JSON.parse(r.mediaMetadata),
    chapters: null,
    displayTitle: r.displayTitle,
    displayAuthor: r.displayAuthor,
    coverPath: r.coverPath,
    duration: r.duration,
    playMethod: r.playMethod,
    mediaPlayer: r.mediaPlayer,
    deviceInfo: r.deviceInfo ? JSON.parse(r.deviceInfo) : null,
    serverVersion: r.serverVersion,
    date: r.date,
    dayOfWeek: r.dayOfWeek,
    timeListening: r.timeListening,
    startTime: r.startTime,
    currentTime: r.currentTime,
    startedAt: r.startedAt,
    updatedAt: r.updatedAt
  }
}

/**
 * Listening history per ShelfMerge user. Upstream keeps the same records for
 * the service account, but mixed across all proxy users; this is the per-user
 * copy that feeds the stats pages and the apps' history screens.
 */
export class ListeningHistory {
  constructor(private readonly db: Db) {}

  get(id: string): ListeningSessionRow | undefined {
    return this.db.prepare('SELECT * FROM listening_sessions WHERE id = ?').get(id) as ListeningSessionRow | undefined
  }

  /**
   * Record listening time from a session sync. Like upstream, a session only
   * becomes history once it has listening time.
   */
  addListening(open: PlaybackSessionRow, timeListened: number, currentTime: number | undefined) {
    if (!timeListened || Number.isNaN(timeListened)) return
    const now = Date.now()
    const existing = this.get(open.id)
    if (existing) {
      this.db
        .prepare('UPDATE listening_sessions SET timeListening = timeListening + ?, currentTime = ?, updatedAt = ? WHERE id = ?')
        .run(Number(timeListened), currentTime ?? existing.currentTime, now, open.id)
      return
    }
    const snap = JSON.parse(open.snapshot || '{}') as SessionSnapshot
    const started = new Date(open.startedAt || now)
    this.insert({
      id: open.id,
      userId: open.userId,
      serverKey: open.serverKey,
      libraryId: open.libraryId || snap.libraryId || null,
      libraryItemId: open.libraryItemId,
      episodeId: open.episodeId,
      mediaItemId: open.mediaItemId,
      mediaType: open.mediaType,
      mediaMetadata: JSON.stringify(snap.mediaMetadata ?? {}),
      displayTitle: open.displayTitle,
      displayAuthor: snap.displayAuthor ?? '',
      coverPath: snap.coverPath ?? null,
      duration: open.duration,
      playMethod: snap.playMethod ?? null,
      mediaPlayer: snap.mediaPlayer ?? null,
      deviceInfo: snap.deviceInfo ? JSON.stringify(snap.deviceInfo) : null,
      serverVersion: snap.serverVersion ?? null,
      date: snap.date ?? dateStr(started),
      dayOfWeek: snap.dayOfWeek ?? DAYS[started.getDay()],
      timeListening: Number(timeListened),
      startTime: snap.startTime ?? 0,
      currentTime: currentTime ?? snap.currentTime ?? 0,
      startedAt: open.startedAt || now,
      updatedAt: now
    })
  }

  /** Offline sessions uploaded by the mobile apps carry the whole record. */
  upsertLocal(userId: string, serverKey: string, s: SessionSnapshot & { id: string; timeListening?: number }, mediaItemId: string) {
    if (!s.timeListening) return
    const started = new Date(s.startedAt ?? Date.now())
    const updated = s.updatedAt ?? Date.now()
    const existing = this.get(s.id)
    if (existing && existing.updatedAt >= updated) return
    const row: ListeningSessionRow = {
      id: s.id,
      userId,
      serverKey,
      libraryId: s.libraryId ?? null,
      libraryItemId: s.libraryItemId,
      episodeId: s.episodeId ?? '',
      mediaItemId,
      mediaType: s.mediaType ?? (s.episodeId ? 'podcast' : 'book'),
      mediaMetadata: JSON.stringify(s.mediaMetadata ?? {}),
      displayTitle: s.displayTitle ?? '',
      displayAuthor: s.displayAuthor ?? '',
      coverPath: s.coverPath ?? null,
      duration: s.duration ?? 0,
      playMethod: s.playMethod ?? 3,
      mediaPlayer: s.mediaPlayer ?? null,
      deviceInfo: s.deviceInfo ? JSON.stringify(s.deviceInfo) : null,
      serverVersion: s.serverVersion ?? null,
      date: s.date ?? dateStr(new Date(updated)),
      dayOfWeek: s.dayOfWeek ?? DAYS[new Date(updated).getDay()],
      timeListening: Number(s.timeListening),
      startTime: s.startTime ?? 0,
      currentTime: s.currentTime ?? 0,
      startedAt: started.valueOf(),
      updatedAt: updated
    }
    if (existing) this.db.prepare('DELETE FROM listening_sessions WHERE id = ?').run(s.id)
    this.insert(row)
  }

  private insert(row: ListeningSessionRow) {
    const cols = Object.keys(row)
    this.db.prepare(`INSERT INTO listening_sessions (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(row)
  }

  forUser(userId: string): OldListeningSession[] {
    const rows = this.db.prepare('SELECT * FROM listening_sessions WHERE userId = ? ORDER BY updatedAt DESC').all(userId) as ListeningSessionRow[]
    return rows.map(toOld)
  }

  forItem(userId: string, libraryItemId: string, episodeId: string | null): OldListeningSession[] {
    const rows = this.db.prepare('SELECT * FROM listening_sessions WHERE userId = ? AND libraryItemId = ? AND episodeId = ? ORDER BY updatedAt DESC').all(userId, libraryItemId, episodeId ?? '') as ListeningSessionRow[]
    return rows.map(toOld)
  }

  remove(userId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM listening_sessions WHERE userId = ? AND id = ?').run(userId, id).changes > 0
  }

  /** Same aggregation as ApiRouter.getUserListeningStatsHelpers upstream. */
  stats(userId: string) {
    const sessions = this.forUser(userId)
    const today = dateStr(new Date())
    const out = { totalTime: 0, items: {} as Record<string, { id: string; timeListening: number; mediaMetadata: unknown; lastUpdate: number }>, days: {} as Record<string, number>, dayOfWeek: {} as Record<string, number>, today: 0, recentSessions: sessions.slice(0, 10) }
    for (const s of sessions) {
      const t = Number(s.timeListening) || 0
      if (s.dayOfWeek) out.dayOfWeek[s.dayOfWeek] = (out.dayOfWeek[s.dayOfWeek] ?? 0) + t
      if (s.date && t > 0) {
        out.days[s.date] = (out.days[s.date] ?? 0) + t
        if (s.date === today) out.today += t
      }
      if (!out.items[s.libraryItemId]) out.items[s.libraryItemId] = { id: s.libraryItemId, timeListening: t, mediaMetadata: s.mediaMetadata, lastUpdate: s.updatedAt }
      else out.items[s.libraryItemId].timeListening += t
      out.totalTime += t
    }
    return out
  }

  /** Same shape as userStats.getStatsForYear upstream. */
  yearStats(userId: string, year: number, finished: Array<{ libraryItemId: string; mediaItemId: string; duration: number; finishedAt: number; title: string; hasCover: boolean }>) {
    const from = new Date(year, 0, 1).valueOf()
    const to = new Date(year + 1, 0, 1).valueOf()
    const sessions = (this.db.prepare('SELECT * FROM listening_sessions WHERE userId = ? AND startedAt >= ? AND startedAt < ?').all(userId, from, to) as ListeningSessionRow[]).map(toOld)

    let totalBook = 0
    let totalPodcast = 0
    const authors: Record<string, number> = {}
    const genres: Record<string, number> = {}
    const narrators: Record<string, number> = {}
    const months: Record<number, number> = {}
    const books: Record<string, number> = {}
    const booksWithCovers: string[] = []
    const finishedBooksWithCovers: string[] = []
    let longest: { id: string; title: string; duration: number; finishedAt: number } | null = null

    for (const f of finished) {
      if (f.hasCover && !finishedBooksWithCovers.includes(f.libraryItemId) && finishedBooksWithCovers.length < 5) finishedBooksWithCovers.push(f.libraryItemId)
      if (f.duration && (!longest || f.duration > longest.duration)) longest = { id: f.mediaItemId, title: f.title, duration: Math.round(f.duration), finishedAt: f.finishedAt }
    }
    for (const s of sessions) {
      if (s.coverPath && !booksWithCovers.includes(s.libraryItemId) && !finishedBooksWithCovers.includes(s.libraryItemId) && booksWithCovers.length < 25) booksWithCovers.push(s.libraryItemId)
      const t = s.timeListening || 0
      const m = new Date(s.startedAt).getMonth()
      months[m] = (months[m] ?? 0) + t
      if (s.mediaType === 'book') {
        totalBook += t
        if (s.displayTitle) books[s.displayTitle] = (books[s.displayTitle] ?? 0) + t
        const md = (s.mediaMetadata ?? {}) as { authors?: Array<{ name: string }>; narrators?: string[]; genres?: string[] }
        for (const a of md.authors ?? []) authors[a.name] = (authors[a.name] ?? 0) + t
        for (const n of md.narrators ?? []) narrators[n] = (narrators[n] ?? 0) + t
        for (const g of (md.genres ?? []).filter((g) => g && !g.toLowerCase().includes('audiobook') && !g.toLowerCase().includes('audio book'))) genres[g] = (genres[g] ?? 0) + t
      } else totalPodcast += t
    }
    const top = (map: Record<string, number>, key: string) =>
      Object.entries(map)
        .map(([k, v]) => ({ [key]: k, time: Math.round(v) }))
        .sort((a, b) => b.time - a.time)
        .slice(0, 3)
    const max = (map: Record<string, number>) => {
      let best: { name: string; time: number } | null = null
      for (const [k, v] of Object.entries(map)) if (!best || v > best.time) best = { name: k, time: Math.round(v) }
      return best
    }
    const bestMonth = max(Object.fromEntries(Object.entries(months).map(([k, v]) => [k, v])))
    return {
      totalListeningSessions: sessions.length,
      totalListeningTime: Math.round(totalBook + totalPodcast),
      totalBookListeningTime: Math.round(totalBook),
      totalPodcastListeningTime: Math.round(totalPodcast),
      topAuthors: top(authors, 'name'),
      topGenres: top(genres, 'genre'),
      mostListenedNarrator: max(narrators),
      mostListenedMonth: bestMonth ? { month: Number(bestMonth.name), time: bestMonth.time } : null,
      numBooksFinished: finished.length,
      numBooksListened: Object.keys(books).length,
      longestAudiobookFinished: longest,
      booksWithCovers,
      finishedBooksWithCovers
    }
  }
}
