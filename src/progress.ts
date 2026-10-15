import { v4 as uuidv4 } from 'uuid'
import type { Db, MediaProgressRow, BookmarkRow } from './db.js'
import { log } from './logger.js'

/** Audiobookshelf's "old" media progress JSON, what every client consumes. */
export interface OldMediaProgress {
  id: string
  userId: string
  libraryItemId: string
  episodeId: string | null
  mediaItemId: string
  mediaItemType: 'book' | 'podcastEpisode'
  duration: number
  progress: number
  currentTime: number
  isFinished: boolean
  hideFromContinueListening: boolean
  ebookLocation: string | null
  ebookProgress: number
  lastUpdate: number
  startedAt: number
  finishedAt: number | null
}

export interface ProgressPayload {
  libraryItemId: string
  episodeId?: string | null
  duration?: number
  currentTime?: number
  progress?: number
  isFinished?: boolean
  hideFromContinueListening?: boolean
  ebookLocation?: string | null
  ebookProgress?: number
  finishedAt?: number | null
  createdAt?: number
  markAsFinishedTimeRemaining?: number
  markAsFinishedPercentComplete?: number
}

export interface Bookmark {
  libraryItemId: string
  title: string
  time: number
  createdAt: number
}

const isNullOrNaN = (v: unknown) => v === null || v === undefined || Number.isNaN(Number(v))

function toOld(row: MediaProgressRow): OldMediaProgress {
  return {
    id: row.id,
    userId: row.userId,
    libraryItemId: row.libraryItemId,
    episodeId: row.episodeId || null,
    mediaItemId: row.mediaItemId,
    mediaItemType: row.mediaItemType,
    duration: row.duration,
    progress: row.progress,
    currentTime: row.currentTime,
    isFinished: !!row.isFinished,
    hideFromContinueListening: !!row.hideFromContinueListening,
    ebookLocation: row.ebookLocation,
    ebookProgress: row.ebookProgress,
    lastUpdate: row.updatedAt,
    startedAt: row.createdAt,
    finishedAt: row.finishedAt
  }
}

/**
 * ShelfMerge owns listening progress and bookmarks, because every proxy user
 * shares one upstream service account. The update rules copy
 * User.createUpdateMediaProgressFromPayload and MediaProgress.applyProgressUpdate
 * from Audiobookshelf so clients see identical behaviour.
 */
export class ProgressStore {
  constructor(private readonly db: Db) {}

  allForUser(userId: string): OldMediaProgress[] {
    const rows = this.db.prepare('SELECT * FROM media_progress WHERE userId = ? ORDER BY updatedAt DESC').all(userId) as MediaProgressRow[]
    return rows.map(toOld)
  }

  rowsForUser(userId: string): MediaProgressRow[] {
    return this.db.prepare('SELECT * FROM media_progress WHERE userId = ? ORDER BY updatedAt DESC').all(userId) as MediaProgressRow[]
  }

  get(userId: string, libraryItemId: string, episodeId: string | null = null): OldMediaProgress | null {
    const row = this.db.prepare('SELECT * FROM media_progress WHERE userId = ? AND libraryItemId = ? AND episodeId = ?').get(userId, libraryItemId, episodeId ?? '') as MediaProgressRow | undefined
    return row ? toOld(row) : null
  }

  getById(userId: string, id: string): OldMediaProgress | null {
    const row = this.db.prepare('SELECT * FROM media_progress WHERE userId = ? AND id = ?').get(userId, id) as MediaProgressRow | undefined
    return row ? toOld(row) : null
  }

  removeById(userId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM media_progress WHERE userId = ? AND id = ?').run(userId, id).changes > 0
  }

  /**
   * Create or update progress. `mediaItemId` is the upstream book id or
   * podcast episode id; the caller resolves it because only the item JSON
   * knows it.
   */
  createUpdate(userId: string, serverKey: string, mediaItemId: string, payload: ProgressPayload): OldMediaProgress {
    const episodeId = payload.episodeId ?? ''
    const existing = this.db.prepare('SELECT * FROM media_progress WHERE userId = ? AND libraryItemId = ? AND episodeId = ?').get(userId, payload.libraryItemId, episodeId) as MediaProgressRow | undefined
    const now = Date.now()

    if (!existing) {
      const row: MediaProgressRow = {
        id: uuidv4(),
        userId,
        serverKey,
        libraryItemId: payload.libraryItemId,
        episodeId,
        mediaItemId,
        mediaItemType: episodeId ? 'podcastEpisode' : 'book',
        duration: isNullOrNaN(payload.duration) ? 0 : Number(payload.duration),
        currentTime: isNullOrNaN(payload.currentTime) ? 0 : Number(payload.currentTime),
        progress: isNullOrNaN(payload.progress) ? 0 : Number(payload.progress),
        isFinished: payload.isFinished ? 1 : 0,
        hideFromContinueListening: payload.hideFromContinueListening ? 1 : 0,
        ebookLocation: payload.ebookLocation ?? null,
        ebookProgress: isNullOrNaN(payload.ebookProgress) ? 0 : Number(payload.ebookProgress),
        finishedAt: payload.finishedAt ?? null,
        createdAt: payload.createdAt ?? now,
        updatedAt: now
      }
      if (row.isFinished) {
        row.finishedAt = row.finishedAt ?? now
        row.progress = 1
      } else {
        row.finishedAt = null
      }
      this.insert(row)
      return toOld(row)
    }

    const row = { ...existing }
    const p = { ...payload }
    if (p.isFinished !== undefined) {
      if (p.isFinished && !row.isFinished) {
        row.finishedAt = p.finishedAt ?? now
        row.progress = 1
        delete p.finishedAt
      } else if (!p.isFinished && row.isFinished) {
        row.finishedAt = null
        row.progress = 0
        row.currentTime = 0
        delete p.finishedAt
        delete p.currentTime
      }
    } else if (!isNullOrNaN(p.progress) && Number(p.progress) !== row.progress) {
      row.progress = Math.min(1, Math.max(0, Number(p.progress)))
    }

    let currentTimeChanged = false
    if (!isNullOrNaN(p.currentTime) && Number(p.currentTime) !== row.currentTime) {
      row.currentTime = Number(p.currentTime)
      currentTimeChanged = true
    }
    if (!isNullOrNaN(p.duration)) row.duration = Number(p.duration)
    if (p.isFinished !== undefined) row.isFinished = p.isFinished ? 1 : 0
    if (p.hideFromContinueListening !== undefined) row.hideFromContinueListening = p.hideFromContinueListening ? 1 : 0
    if (p.ebookLocation !== undefined) row.ebookLocation = p.ebookLocation
    if (!isNullOrNaN(p.ebookProgress)) row.ebookProgress = Number(p.ebookProgress)
    if (p.finishedAt !== undefined) row.finishedAt = p.finishedAt

    if (currentTimeChanged && !p.hideFromContinueListening) row.hideFromContinueListening = 0

    // Auto mark-as-finished, same thresholds as upstream library settings defaults.
    let shouldMarkAsFinished = false
    if (row.duration) {
      if (!isNullOrNaN(p.markAsFinishedPercentComplete) && Number(p.markAsFinishedPercentComplete) > 0) {
        shouldMarkAsFinished = Number(p.markAsFinishedPercentComplete) / 100 < row.progress
      } else {
        const remaining = isNullOrNaN(p.markAsFinishedTimeRemaining) ? 10 : Number(p.markAsFinishedTimeRemaining)
        shouldMarkAsFinished = row.duration - row.currentTime < remaining
      }
    }
    if (!row.isFinished && shouldMarkAsFinished) {
      row.isFinished = 1
      row.finishedAt = row.finishedAt ?? now
      row.progress = 1
      log.info(`[progress] marking ${row.libraryItemId} finished for user ${userId}`)
    } else if (row.isFinished && currentTimeChanged && !shouldMarkAsFinished) {
      row.isFinished = 0
      row.finishedAt = null
    }

    row.updatedAt = now
    this.update(row)
    return toOld(row)
  }

  /**
   * Apply a progress snapshot from an upstream account as-is. Unlike
   * createUpdate, which follows Audiobookshelf's incremental rules (an
   * unfinish resets the position, thresholds may re-finish), this copies
   * the row verbatim; `lastUpdate` is the upstream timestamp.
   */
  importSnapshot(userId: string, serverKey: string, snap: OldMediaProgress): OldMediaProgress {
    const episodeId = snap.episodeId ?? ''
    const existing = this.db.prepare('SELECT * FROM media_progress WHERE userId = ? AND libraryItemId = ? AND episodeId = ?').get(userId, snap.libraryItemId, episodeId) as MediaProgressRow | undefined
    const row: MediaProgressRow = {
      id: existing?.id ?? uuidv4(),
      userId,
      serverKey,
      libraryItemId: snap.libraryItemId,
      episodeId,
      mediaItemId: snap.mediaItemId,
      mediaItemType: episodeId ? 'podcastEpisode' : 'book',
      duration: Number(snap.duration) || 0,
      progress: Number(snap.progress) || 0,
      currentTime: Number(snap.currentTime) || 0,
      isFinished: snap.isFinished ? 1 : 0,
      hideFromContinueListening: snap.hideFromContinueListening ? 1 : 0,
      ebookLocation: snap.ebookLocation ?? null,
      ebookProgress: Number(snap.ebookProgress) || 0,
      createdAt: existing?.createdAt ?? snap.startedAt ?? Date.now(),
      updatedAt: snap.lastUpdate || Date.now(),
      finishedAt: snap.isFinished ? (snap.finishedAt ?? existing?.finishedAt ?? Date.now()) : null
    }
    if (existing) this.update(row)
    else this.insert(row)
    return toOld(row)
  }

  private insert(row: MediaProgressRow) {
    this.db
      .prepare(
        `INSERT INTO media_progress (id, userId, serverKey, libraryItemId, episodeId, mediaItemId, mediaItemType, duration, progress, currentTime, isFinished, hideFromContinueListening, ebookLocation, ebookProgress, createdAt, updatedAt, finishedAt)
         VALUES (@id, @userId, @serverKey, @libraryItemId, @episodeId, @mediaItemId, @mediaItemType, @duration, @progress, @currentTime, @isFinished, @hideFromContinueListening, @ebookLocation, @ebookProgress, @createdAt, @updatedAt, @finishedAt)`
      )
      .run(row)
  }

  private update(row: MediaProgressRow) {
    this.db
      .prepare(
        `UPDATE media_progress SET duration = @duration, progress = @progress, currentTime = @currentTime, isFinished = @isFinished, hideFromContinueListening = @hideFromContinueListening,
         ebookLocation = @ebookLocation, ebookProgress = @ebookProgress, updatedAt = @updatedAt, finishedAt = @finishedAt WHERE id = @id`
      )
      .run(row)
  }

  // Bookmarks

  bookmarksForUser(userId: string): Bookmark[] {
    const rows = this.db.prepare('SELECT * FROM bookmarks WHERE userId = ? ORDER BY createdAt').all(userId) as BookmarkRow[]
    return rows.map((b) => ({ libraryItemId: b.libraryItemId, title: b.title, time: b.time, createdAt: b.createdAt }))
  }

  findBookmark(userId: string, libraryItemId: string, time: number): Bookmark | null {
    const b = this.db.prepare('SELECT * FROM bookmarks WHERE userId = ? AND libraryItemId = ? AND time = ?').get(userId, libraryItemId, time) as BookmarkRow | undefined
    return b ? { libraryItemId: b.libraryItemId, title: b.title, time: b.time, createdAt: b.createdAt } : null
  }

  createBookmark(userId: string, libraryItemId: string, time: number, title: string): Bookmark {
    const createdAt = Date.now()
    this.db
      .prepare('INSERT INTO bookmarks (userId, libraryItemId, time, title, createdAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(userId, libraryItemId, time) DO UPDATE SET title = excluded.title')
      .run(userId, libraryItemId, time, title, createdAt)
    return this.findBookmark(userId, libraryItemId, time)!
  }

  updateBookmark(userId: string, libraryItemId: string, time: number, title: string): Bookmark | null {
    const changed = this.db.prepare('UPDATE bookmarks SET title = ? WHERE userId = ? AND libraryItemId = ? AND time = ?').run(title, userId, libraryItemId, time).changes
    return changed ? this.findBookmark(userId, libraryItemId, time) : null
  }

  removeBookmark(userId: string, libraryItemId: string, time: number) {
    this.db.prepare('DELETE FROM bookmarks WHERE userId = ? AND libraryItemId = ? AND time = ?').run(userId, libraryItemId, time)
  }
}
