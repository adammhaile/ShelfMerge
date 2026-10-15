import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

export type Db = Database.Database

export interface UserRow {
  id: string
  username: string
  passwordHash: string
  createdAt: number
  lastSeen: number | null
  isActive: number
  /** 'config' for users listed in the YAML, 'admin' for users created from the web UI. */
  source: 'config' | 'admin'
  /** The last bcrypt hash applied from the config, so a changed YAML hash wins but a UI change is not reverted. */
  configHash: string | null
}

export interface AuthSessionRow {
  id: string
  userId: string
  refreshToken: string
  lastRefreshToken: string | null
  lastRefreshTokenExpiresAt: number | null
  expiresAt: number
  ipAddress: string | null
  userAgent: string | null
  createdAt: number
  updatedAt: number
}

/** Episode-less progress stores episodeId as '' so the UNIQUE constraint works. */
export interface MediaProgressRow {
  id: string
  userId: string
  serverKey: string
  libraryItemId: string
  episodeId: string
  mediaItemId: string
  mediaItemType: 'book' | 'podcastEpisode'
  duration: number
  progress: number
  currentTime: number
  isFinished: number
  hideFromContinueListening: number
  ebookLocation: string | null
  ebookProgress: number
  createdAt: number
  updatedAt: number
  finishedAt: number | null
}

export interface BookmarkRow {
  userId: string
  libraryItemId: string
  time: number
  title: string
  createdAt: number
}

export interface IdMapRow {
  id: string
  serverKey: string
  kind: string | null
  mediaId: string | null
  libraryId: string | null
}

export interface PlaybackSessionRow {
  id: string
  serverKey: string
  userId: string
  libraryId: string
  libraryItemId: string
  episodeId: string
  mediaItemId: string
  mediaType: string
  duration: number
  displayTitle: string
  deviceDescription: string
  startedAt: number
  updatedAt: number
  /** The upstream session JSON (minus libraryItem), used to seed the history row. */
  snapshot: string
}

/** A finished or in-progress listening session, Audiobookshelf's playback session history. */
export interface ListeningSessionRow {
  id: string
  userId: string
  serverKey: string
  libraryId: string | null
  libraryItemId: string
  episodeId: string
  mediaItemId: string
  mediaType: string
  mediaMetadata: string
  displayTitle: string
  displayAuthor: string
  coverPath: string | null
  duration: number
  playMethod: number | null
  mediaPlayer: string | null
  deviceInfo: string | null
  serverVersion: string | null
  date: string
  dayOfWeek: string
  timeListening: number
  startTime: number
  currentTime: number
  startedAt: number
  updatedAt: number
}

export interface ApiKeyRow {
  id: string
  name: string
  userId: string
  isActive: number
  expiresAt: number | null
  lastUsedAt: number | null
  createdByUserId: string
  createdAt: number
  updatedAt: number
}

export interface CollectionRow {
  id: string
  libraryId: string
  name: string
  description: string | null
  createdAt: number
  updatedAt: number
}

export interface PlaylistRow {
  id: string
  userId: string
  libraryId: string
  name: string
  description: string | null
  createdAt: number
  updatedAt: number
}

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  passwordHash TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  lastSeen INTEGER
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  refreshToken TEXT NOT NULL UNIQUE,
  lastRefreshToken TEXT,
  lastRefreshTokenExpiresAt INTEGER,
  expiresAt INTEGER NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(userId);
CREATE TABLE IF NOT EXISTS media_progress (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  serverKey TEXT NOT NULL,
  libraryItemId TEXT NOT NULL,
  episodeId TEXT NOT NULL DEFAULT '',
  mediaItemId TEXT NOT NULL,
  mediaItemType TEXT NOT NULL,
  duration REAL NOT NULL DEFAULT 0,
  progress REAL NOT NULL DEFAULT 0,
  currentTime REAL NOT NULL DEFAULT 0,
  isFinished INTEGER NOT NULL DEFAULT 0,
  hideFromContinueListening INTEGER NOT NULL DEFAULT 0,
  ebookLocation TEXT,
  ebookProgress REAL NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  finishedAt INTEGER,
  UNIQUE(userId, libraryItemId, episodeId)
);
CREATE TABLE IF NOT EXISTS bookmarks (
  userId TEXT NOT NULL,
  libraryItemId TEXT NOT NULL,
  time REAL NOT NULL,
  title TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (userId, libraryItemId, time)
);
CREATE TABLE IF NOT EXISTS user_extra (
  userId TEXT PRIMARY KEY,
  seriesHideFromContinueListening TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS id_map (
  id TEXT PRIMARY KEY,
  serverKey TEXT NOT NULL,
  kind TEXT,
  mediaId TEXT,
  seenAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playback_sessions (
  id TEXT PRIMARY KEY,
  serverKey TEXT NOT NULL,
  userId TEXT NOT NULL,
  libraryItemId TEXT NOT NULL,
  episodeId TEXT NOT NULL DEFAULT '',
  mediaItemId TEXT NOT NULL,
  mediaType TEXT NOT NULL,
  duration REAL NOT NULL DEFAULT 0,
  displayTitle TEXT NOT NULL DEFAULT '',
  deviceDescription TEXT NOT NULL DEFAULT '',
  startedAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS listening_sessions (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  serverKey TEXT NOT NULL,
  libraryId TEXT,
  libraryItemId TEXT NOT NULL,
  episodeId TEXT NOT NULL DEFAULT '',
  mediaItemId TEXT NOT NULL,
  mediaType TEXT NOT NULL,
  mediaMetadata TEXT NOT NULL DEFAULT '{}',
  displayTitle TEXT NOT NULL DEFAULT '',
  displayAuthor TEXT NOT NULL DEFAULT '',
  coverPath TEXT,
  duration REAL NOT NULL DEFAULT 0,
  playMethod INTEGER,
  mediaPlayer TEXT,
  deviceInfo TEXT,
  serverVersion TEXT,
  date TEXT NOT NULL,
  dayOfWeek TEXT NOT NULL,
  timeListening REAL NOT NULL DEFAULT 0,
  startTime REAL NOT NULL DEFAULT 0,
  currentTime REAL NOT NULL DEFAULT 0,
  startedAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS listening_sessions_user ON listening_sessions(userId, updatedAt);
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  libraryId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS collection_books (
  collectionId TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  libraryItemId TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  PRIMARY KEY (collectionId, libraryItemId)
);
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  libraryId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_items (
  playlistId TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  libraryItemId TEXT NOT NULL,
  episodeId TEXT NOT NULL DEFAULT '',
  "order" INTEGER NOT NULL,
  PRIMARY KEY (playlistId, libraryItemId, episodeId)
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  userId TEXT NOT NULL,
  isActive INTEGER NOT NULL DEFAULT 1,
  expiresAt INTEGER,
  lastUsedAt INTEGER,
  createdByUserId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** Columns added after the first release; applied to existing databases. */
const migrations: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'users', column: 'isActive', ddl: 'INTEGER NOT NULL DEFAULT 1' },
  { table: 'users', column: 'source', ddl: "TEXT NOT NULL DEFAULT 'config'" },
  { table: 'users', column: 'configHash', ddl: 'TEXT' },
  { table: 'id_map', column: 'libraryId', ddl: 'TEXT' },
  { table: 'playback_sessions', column: 'libraryId', ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: 'playback_sessions', column: 'snapshot', ddl: "TEXT NOT NULL DEFAULT '{}'" }
]

/** `':memory:'` opens a throwaway in-memory database (tests). */
export function openDb(dataDir: string): Db {
  let db: Db
  if (dataDir === ':memory:') db = new Database(':memory:')
  else {
    fs.mkdirSync(dataDir, { recursive: true })
    db = new Database(path.join(dataDir, 'shelfmerge.db'))
  }
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(schema)
  for (const m of migrations) {
    const cols = db.pragma(`table_info(${m.table})`) as Array<{ name: string }>
    if (!cols.some((c) => c.name === m.column)) db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`)
  }
  return db
}

export function kvGet(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function kvSet(db: Db, key: string, value: string) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
