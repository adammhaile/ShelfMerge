import type { Config } from './config.js'
import type { Db } from './db.js'
import type { Registry } from './upstream/registry.js'
import type { TokenManager } from './auth/tokens.js'
import type { UserStore } from './users.js'
import type { ProgressStore } from './progress.js'
import type { PlaybackSessions } from './sessions.js'
import type { SocketHub } from './socket/hub.js'
import type { SettingsCache } from './upstream/settings.js'
import type { UserRow } from './db.js'

/** Everything a route handler needs, built once in index.ts. */
export interface Context {
  cfg: Config
  db: Db
  registry: Registry
  tokens: TokenManager
  users: UserStore
  progress: ProgressStore
  sessions: PlaybackSessions
  socket: SocketHub
  settings: SettingsCache
  /** Audiobookshelf version of the bundled web client; reported in /status. */
  absVersion: string
}

declare global {
  namespace Express {
    interface Request {
      smUser: UserRow
      /** Client path + query with the router base path removed, e.g. `/api/libraries?x=1`. */
      smPath: string
    }
  }
}
