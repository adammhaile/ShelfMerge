import { v4 as uuidv4 } from 'uuid'
import type { Db, CollectionRow, PlaylistRow } from './db.js'

export interface PlaylistItemRef {
  libraryItemId: string
  episodeId: string | null
}

/**
 * Collections and playlists live in ShelfMerge, not upstream: upstream ones
 * would belong to the shared service account, and a collection here may span
 * servers because membership is just a list of item ids. Collections are
 * shared per library like upstream; playlists are per user.
 */
export class CollectionStore {
  constructor(private readonly db: Db) {}

  // Collections

  collection(id: string): CollectionRow | undefined {
    return this.db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as CollectionRow | undefined
  }

  collections(libraryId?: string): CollectionRow[] {
    return (libraryId ? this.db.prepare('SELECT * FROM collections WHERE libraryId = ? ORDER BY name').all(libraryId) : this.db.prepare('SELECT * FROM collections ORDER BY name').all()) as CollectionRow[]
  }

  collectionBooks(id: string): string[] {
    return (this.db.prepare('SELECT libraryItemId FROM collection_books WHERE collectionId = ? ORDER BY "order"').all(id) as Array<{ libraryItemId: string }>).map((r) => r.libraryItemId)
  }

  createCollection(libraryId: string, name: string, description: string | null, books: string[]): CollectionRow {
    const now = Date.now()
    const row: CollectionRow = { id: uuidv4(), libraryId, name, description, createdAt: now, updatedAt: now }
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO collections (id, libraryId, name, description, createdAt, updatedAt) VALUES (@id, @libraryId, @name, @description, @createdAt, @updatedAt)').run(row)
      this.setCollectionBooks(row.id, books)
    })()
    return row
  }

  updateCollection(id: string, patch: { name?: string; description?: string | null }): boolean {
    const row = this.collection(id)
    if (!row) return false
    const name = patch.name ?? row.name
    const description = patch.description === undefined ? row.description : patch.description
    if (name === row.name && description === row.description) return false
    this.db.prepare('UPDATE collections SET name = ?, description = ?, updatedAt = ? WHERE id = ?').run(name, description, Date.now(), id)
    return true
  }

  /** Replace membership with `books` in that order. Returns true if anything changed. */
  setCollectionBooks(id: string, books: string[]): boolean {
    const before = this.collectionBooks(id)
    const unique = [...new Set(books)]
    if (before.length === unique.length && before.every((b, i) => b === unique[i])) return false
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM collection_books WHERE collectionId = ?').run(id)
      const ins = this.db.prepare('INSERT INTO collection_books (collectionId, libraryItemId, "order") VALUES (?, ?, ?)')
      unique.forEach((b, i) => ins.run(id, b, i + 1))
      this.db.prepare('UPDATE collections SET updatedAt = ? WHERE id = ?').run(Date.now(), id)
    })()
    return true
  }

  deleteCollection(id: string) {
    this.db.prepare('DELETE FROM collections WHERE id = ?').run(id)
  }

  // Playlists

  playlist(id: string): PlaylistRow | undefined {
    return this.db.prepare('SELECT * FROM playlists WHERE id = ?').get(id) as PlaylistRow | undefined
  }

  playlists(userId: string, libraryId?: string): PlaylistRow[] {
    return (
      libraryId ? this.db.prepare('SELECT * FROM playlists WHERE userId = ? AND libraryId = ? ORDER BY name').all(userId, libraryId) : this.db.prepare('SELECT * FROM playlists WHERE userId = ? ORDER BY name').all(userId)
    ) as PlaylistRow[]
  }

  playlistItems(id: string): PlaylistItemRef[] {
    return (this.db.prepare('SELECT libraryItemId, episodeId FROM playlist_items WHERE playlistId = ? ORDER BY "order"').all(id) as Array<{ libraryItemId: string; episodeId: string }>).map((r) => ({ libraryItemId: r.libraryItemId, episodeId: r.episodeId || null }))
  }

  createPlaylist(userId: string, libraryId: string, name: string, description: string | null, items: PlaylistItemRef[]): PlaylistRow {
    const now = Date.now()
    const row: PlaylistRow = { id: uuidv4(), userId, libraryId, name, description, createdAt: now, updatedAt: now }
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO playlists (id, userId, libraryId, name, description, createdAt, updatedAt) VALUES (@id, @userId, @libraryId, @name, @description, @createdAt, @updatedAt)').run(row)
      this.setPlaylistItems(row.id, items)
    })()
    return row
  }

  updatePlaylist(id: string, patch: { name?: string; description?: string | null }): boolean {
    const row = this.playlist(id)
    if (!row) return false
    const name = patch.name ?? row.name
    const description = patch.description === undefined ? row.description : patch.description
    if (name === row.name && description === row.description) return false
    this.db.prepare('UPDATE playlists SET name = ?, description = ?, updatedAt = ? WHERE id = ?').run(name, description, Date.now(), id)
    return true
  }

  setPlaylistItems(id: string, items: PlaylistItemRef[]): boolean {
    const key = (i: PlaylistItemRef) => `${i.libraryItemId}/${i.episodeId ?? ''}`
    const before = this.playlistItems(id).map(key)
    const seen = new Set<string>()
    const unique = items.filter((i) => !seen.has(key(i)) && seen.add(key(i)))
    if (before.length === unique.length && before.every((b, i) => b === key(unique[i]))) return false
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM playlist_items WHERE playlistId = ?').run(id)
      const ins = this.db.prepare('INSERT INTO playlist_items (playlistId, libraryItemId, episodeId, "order") VALUES (?, ?, ?, ?)')
      unique.forEach((i, n) => ins.run(id, i.libraryItemId, i.episodeId ?? '', n + 1))
      this.db.prepare('UPDATE playlists SET updatedAt = ? WHERE id = ?').run(Date.now(), id)
    })()
    return true
  }

  deletePlaylist(id: string) {
    this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
  }
}
