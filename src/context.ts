import type { Config } from './config.js'
import type { Db } from './db.js'
import type { Registry } from './upstream/registry.js'
import type { TokenManager } from './auth/tokens.js'
import type { UserStore } from './users.js'
import type { ProgressStore } from './progress.js'
import type { PlaybackSessions } from './sessions.js'
import type { SocketHub } from './socket/hub.js'
import type { Catalog } from './upstream/catalog.js'
import type { ListeningHistory } from './history.js'
import type { CollectionStore } from './collections.js'
import type { IndexStore } from './index/store.js'
import type { IndexQuery } from './index/query.js'
import type { Indexer } from './index/sync.js'
import type { Accounts } from './accounts.js'
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
  catalog: Catalog
  history: ListeningHistory
  collections: CollectionStore
  indexStore: IndexStore
  indexQuery: IndexQuery
  indexer: Indexer
  accounts: Accounts
  /**
   * Library each user browsed last. Item detail and playback responses are
   * relabelled to a merged library when the user is browsing one, so the
   * web client does not switch libraries when an item page opens.
   */
  lastLibrary: Map<string, string>
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
