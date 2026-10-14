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
}

export interface Config {
  port: number
  dataDir: string
  clientDir: string
  servers: ServerConfig[]
  users: UserConfig[]
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
  users?: Record<string, { password: string }>
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
    return { username, password: String(u.password) }
  })
  if (!users.length) throw new Error('Config: at least one user is required')

  const resolveDir = (d: string | undefined, fallback: string) => path.resolve(baseDir, '..', d ?? fallback)

  return {
    port: Number(process.env.PORT ?? raw.port ?? 3333),
    dataDir: resolveDir(raw.dataDir, 'data'),
    clientDir: process.env.SHELFMERGE_CLIENT_DIR ?? resolveDir(raw.clientDir, 'client-dist'),
    servers,
    users,
    accessTokenExpiry: raw.accessTokenExpiry ?? 60 * 60,
    refreshTokenExpiry: raw.refreshTokenExpiry ?? 30 * 24 * 60 * 60,
    refreshTokenGracePeriod: raw.refreshTokenGracePeriod ?? 10 * 60
  }
}
