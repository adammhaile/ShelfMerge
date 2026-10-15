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
  /**
   * Initial password (plain text or a bcrypt hash), used only when the user
   * does not exist yet, or to force a change when it is a hash. Afterwards
   * the password lives in the database and is changed from the web UI or
   * with `npm run user -- passwd <name>`. May be omitted for existing users.
   */
  password: string | null
  /** Sees the stock Users settings page: can create users, reset passwords, deactivate. */
  admin: boolean
  /**
   * Libraries this user may see, as `serverKey:*`, `serverKey:Library Name`
   * or `serverKey:<libraryId>`. Omitted means every library on every server.
   */
  libraries: string[] | null
  /**
   * The user's own API keys per server. On those servers every request for
   * this user is made as their account, so playback, progress and history
   * land there and their native listening flows back. Servers not listed
   * use the shared service account.
   */
  accounts: Record<string, string>
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
  users?: Record<string, { password?: string; admin?: boolean; libraries?: string[]; accounts?: Record<string, string | { apiKey: string }> } | null>
  merged?: Array<{ name?: string; mediaType?: string; sources?: string[]; collapseEditions?: boolean; preferServers?: string[]; keepSeparate?: string[] }>
  prefixLibraryNames?: boolean
  accessTokenExpiry?: number
  refreshTokenExpiry?: number
  refreshTokenGracePeriod?: number
}

/**
 * `${NAME}` and `${NAME:-default}` in the config file are replaced from the
 * environment, so API keys and passwords can live in an env file instead
 * of the YAML. A missing variable without a default is an error.
 */
export function substituteEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback: string | undefined) => {
    const v = env[name]
    if (v !== undefined && v !== '') return v
    if (fallback !== undefined) return fallback
    throw new Error(`Config: environment variable ${name} is not set`)
  })
}

export const isConfigUrl = (source: string) => /^https?:\/\//i.test(source)

/** Read the config from a local file. */
export function loadConfig(file = process.env.SHELFMERGE_CONFIG ?? 'config/shelfmerge.yaml'): Config {
  if (isConfigUrl(file)) throw new Error(`Config: ${file} is a URL; use fetchConfigText() and parseConfig()`)
  const abs = path.resolve(file)
  return parseConfig(fs.readFileSync(abs, 'utf8'), path.dirname(abs))
}

/**
 * Fetch the config text from a URL (several instances sharing one file).
 * SHELFMERGE_CONFIG_AUTH, when set, is sent as the Authorization header,
 * e.g. `token ghp_...` for a private GitHub raw URL.
 */
export async function fetchConfigText(url: string): Promise<string> {
  const headers: Record<string, string> = { accept: 'text/plain, application/x-yaml, */*' }
  if (process.env.SHELFMERGE_CONFIG_AUTH) headers.authorization = process.env.SHELFMERGE_CONFIG_AUTH
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Config: ${url} responded ${res.status}`)
  return res.text()
}

/**
 * Parse config text. Relative `dataDir`/`clientDir` resolve against the
 * parent of `baseDir` (the project root for config/shelfmerge.yaml); a URL
 * config should use absolute paths or SHELFMERGE_DATA_DIR.
 */
export function parseConfig(text: string, baseDir: string = path.join(process.cwd(), 'config')): Config {
  const raw = (YAML.parse(substituteEnv(text)) ?? {}) as RawConfig

  const servers = Object.entries(raw.servers ?? {}).map(([key, s]) => {
    if (!s?.url || !s?.apiKey) throw new Error(`Config: server "${key}" needs url and apiKey`)
    return { key, url: s.url.replace(/\/+$/, ''), apiKey: s.apiKey, label: s.label ?? key }
  })
  if (!servers.length) throw new Error('Config: at least one server is required')

  const users = Object.entries(raw.users ?? {}).map(([username, raw]) => {
    const u = raw ?? {}
    const libraries = u.libraries ? u.libraries.map(String) : null
    for (const rule of libraries ?? []) {
      const key = rule.split(':')[0]
      if (!rule.includes(':') || (key !== 'merged' && !servers.some((s) => s.key === key))) throw new Error(`Config: user "${username}" library rule "${rule}" must be "<serverKey|merged>:<library name, id or *>"`)
    }
    const accounts: Record<string, string> = {}
    for (const [key, v] of Object.entries(u.accounts ?? {})) {
      if (!servers.some((s) => s.key === key)) throw new Error(`Config: user "${username}" has an account for unknown server "${key}"`)
      const apiKey = typeof v === 'string' ? v : v?.apiKey
      if (!apiKey) throw new Error(`Config: user "${username}" account for "${key}" needs an apiKey`)
      accounts[key] = String(apiKey)
    }
    return { username, password: u.password === undefined || u.password === null ? null : String(u.password), admin: !!u.admin, libraries, accounts }
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
    dataDir: process.env.SHELFMERGE_DATA_DIR ?? resolveDir(raw.dataDir, 'data'),
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
