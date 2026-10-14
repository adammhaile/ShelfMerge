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
}

export interface PlaybackSessionRow {
  id: string
  serverKey: string
  userId: string
  libraryItemId: string
  episodeId: string
  mediaItemId: string
  mediaType: string
  duration: number
  displayTitle: string
  deviceDescription: string
  startedAt: number
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
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export function openDb(dataDir: string): Db {
  fs.mkdirSync(dataDir, { recursive: true })
  const db = new Database(path.join(dataDir, 'shelfmerge.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(schema)
  return db
}

export function kvGet(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function kvSet(db: Db, key: string, value: string) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
