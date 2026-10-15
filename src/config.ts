import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

export interface ServerConfig {
  key: string
  url: string
  apiKey: string
  label: string
}

export interface UserConfig {
  username: string
  password: string
  /**
   * Libraries this user may see, as `serverKey:*`, `serverKey:Library Name`
   * or `serverKey:<libraryId>`. Omitted means every library on every server.
   */
  libraries: string[] | null
}

/**
 * A virtual library made from several upstream libraries. `sources` are
 * `serverKey:*`, `serverKey:Library Name` or `serverKey:<libraryId>`; `*`
 * alone means every library of the matching media type on every server.
 */
export interface MergedLibraryConfig {
  name: string
  mediaType: 'book' | 'podcast'
  sources: string[]
  /** Show one card per book when the same book exists on several servers. */
  collapseEditions: boolean
  /** Server keys in order of preference for which edition is shown. Defaults to the config's server order. */
  preferServers: string[]
  /** Item ids that must never be collapsed (to pin a false match apart). */
  keepSeparate: string[]
}

export interface Config {
  port: number
  dataDir: string
  clientDir: string
  servers: ServerConfig[]
  users: UserConfig[]
  /** Merged libraries, listed first and default. Defaults to one "Everything" over all book libraries. */
  merged: MergedLibraryConfig[]
  /** Prefix library names with the server label. Defaults to on when there is more than one server. */
  prefixLibraryNames: boolean
  /** Seconds. Defaults match Audiobookshelf (1 h access, 30 d refresh). */
  accessTokenExpiry: number
  refreshTokenExpiry: number
  refreshTokenGracePeriod: number
}

interface RawConfig {
  port?: number
  dataDir?: string
  clientDir?: string
  servers?: Record<string, { url: string; apiKey: string; label?: string }>
  users?: Record<string, { password: string; libraries?: string[] }>
  merged?: Array<{ name?: string; mediaType?: string; sources?: string[]; collapseEditions?: boolean; preferServers?: string[]; keepSeparate?: string[] }>
  prefixLibraryNames?: boolean
  accessTokenExpiry?: number
  refreshTokenExpiry?: number
  refreshTokenGracePeriod?: number
}

export function loadConfig(file = process.env.SHELFMERGE_CONFIG ?? 'config/shelfmerge.yaml'): Config {
  const abs = path.resolve(file)
  const raw = YAML.parse(fs.readFileSync(abs, 'utf8')) as RawConfig
  const baseDir = path.dirname(abs)

  const servers = Object.entries(raw.servers ?? {}).map(([key, s]) => {
    if (!s?.url || !s?.apiKey) throw new Error(`Config: server "${key}" needs url and apiKey`)
    return { key, url: s.url.replace(/\/+$/, ''), apiKey: s.apiKey, label: s.label ?? key }
  })
  if (!servers.length) throw new Error('Config: at least one server is required')

  const users = Object.entries(raw.users ?? {}).map(([username, u]) => {
    if (!u?.password) throw new Error(`Config: user "${username}" needs a password`)
    const libraries = u.libraries ? u.libraries.map(String) : null
    for (const rule of libraries ?? []) {
      const key = rule.split(':')[0]
      if (!rule.includes(':') || (key !== 'merged' && !servers.some((s) => s.key === key))) throw new Error(`Config: user "${username}" library rule "${rule}" must be "<serverKey|merged>:<library name, id or *>"`)
    }
    return { username, password: String(u.password), libraries }
  })
  if (!users.length) throw new Error('Config: at least one user is required')

  const merged: MergedLibraryConfig[] = (raw.merged ?? [{ name: 'Everything', mediaType: 'book', sources: ['*'] }]).map((m, i) => {
    const mediaType = m.mediaType === 'podcast' ? 'podcast' : 'book'
    const sources = (m.sources ?? ['*']).map(String)
    for (const rule of sources) {
      const key = rule.split(':')[0]
      if (rule !== '*' && (!rule.includes(':') || !servers.some((s) => s.key === key))) throw new Error(`Config: merged library #${i + 1} source "${rule}" must be "*" or "<serverKey>:<library name, id or *>"`)
    }
    const preferServers = (m.preferServers ?? []).map(String)
    for (const key of preferServers) if (!servers.some((s) => s.key === key)) throw new Error(`Config: merged library #${i + 1} preferServers has unknown server "${key}"`)
    return {
      name: m.name?.trim() || 'Everything',
      mediaType,
      sources,
      collapseEditions: m.collapseEditions ?? true,
      preferServers: [...preferServers, ...servers.map((s) => s.key).filter((k) => !preferServers.includes(k))],
      keepSeparate: (m.keepSeparate ?? []).map(String)
    }
  })
  const names = new Set<string>()
  for (const m of merged) {
    if (names.has(m.name.toLowerCase())) throw new Error(`Config: merged library name "${m.name}" is used twice`)
    names.add(m.name.toLowerCase())
  }

  const resolveDir = (d: string | undefined, fallback: string) => path.resolve(baseDir, '..', d ?? fallback)

  return {
    port: Number(process.env.PORT ?? raw.port ?? 3333),
    dataDir: resolveDir(raw.dataDir, 'data'),
    clientDir: process.env.SHELFMERGE_CLIENT_DIR ?? resolveDir(raw.clientDir, 'client-dist'),
    servers,
    users,
    merged,
    prefixLibraryNames: raw.prefixLibraryNames ?? servers.length > 1,
    accessTokenExpiry: raw.accessTokenExpiry ?? 60 * 60,
    refreshTokenExpiry: raw.refreshTokenExpiry ?? 30 * 24 * 60 * 60,
    refreshTokenGracePeriod: raw.refreshTokenGracePeriod ?? 10 * 60
  }
}
