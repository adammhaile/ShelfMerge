import type { Db, PlaybackSessionRow } from './db.js'

/**
 * Open playback sessions started through the proxy. Upstream owns the real
 * session (and the transcode stream, if any) under the service account; we
 * remember which server and which proxy user it belongs to so sync/close
 * calls can be routed and progress credited to the right person.
 */
export class PlaybackSessions {
  constructor(private readonly db: Db) {}

  get(id: string): PlaybackSessionRow | undefined {
    return this.db.prepare('SELECT * FROM playback_sessions WHERE id = ?').get(id) as PlaybackSessionRow | undefined
  }

  forUser(userId: string): PlaybackSessionRow[] {
    return this.db.prepare('SELECT * FROM playback_sessions WHERE userId = ?').all(userId) as PlaybackSessionRow[]
  }

  upsert(row: PlaybackSessionRow) {
    this.db
      .prepare(
        `INSERT INTO playback_sessions (id, serverKey, userId, libraryItemId, episodeId, mediaItemId, mediaType, duration, displayTitle, deviceDescription, startedAt, updatedAt)
         VALUES (@id, @serverKey, @userId, @libraryItemId, @episodeId, @mediaItemId, @mediaType, @duration, @displayTitle, @deviceDescription, @startedAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET updatedAt = excluded.updatedAt`
      )
      .run(row)
  }

  touch(id: string) {
    this.db.prepare('UPDATE playback_sessions SET updatedAt = ? WHERE id = ?').run(Date.now(), id)
  }

  remove(id: string) {
    this.db.prepare('DELETE FROM playback_sessions WHERE id = ?').run(id)
  }
}
