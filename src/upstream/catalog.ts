import type { Registry } from './registry.js'
import type { Config, UserConfig } from '../config.js'
import { log } from '../logger.js'

export interface LibraryJSON {
  id: string
  name: string
  displayOrder: number
  mediaType: string
  [key: string]: unknown
}

/** A library as presented to clients: upstream JSON plus which server owns it. */
export interface FederatedLibrary extends LibraryJSON {
  serverKey: string
  /** Name without the server prefix, for allow-list matching. */
  upstreamName: string
}

interface AuthorizeResponse {
  serverSettings: Record<string, unknown>
}

/**
 * The list of libraries across all servers, plus the default server's
 * settings. Clients fetch libraries constantly and the list rarely changes,
 * so it is cached here and refreshed on a timer and on library socket
 * events. A server that is down keeps its last known libraries, so browsing
 * other servers keeps working.
 */
export class Catalog {
  serverSettings: Record<string, unknown> = {}
  private byServer = new Map<string, LibraryJSON[]>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly registry: Registry,
    private readonly cfg: Config
  ) {}

  async start(refreshMs = 5 * 60 * 1000) {
    await this.refreshAll()
    this.timer = setInterval(() => this.refreshAll().catch(() => {}), refreshMs)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  async refreshAll() {
    await Promise.all(this.registry.all.map((s) => this.refreshServer(s.key)))
    const def = this.registry.default
    try {
      const auth = await def.post<AuthorizeResponse>('/api/authorize', {})
      this.serverSettings = auth.serverSettings ?? {}
    } catch (err) {
      log.warn(`[catalog] settings from ${def.key} failed:`, (err as Error).message)
    }
  }

  async refreshServer(key: string) {
    const server = this.registry.server(key)
    if (!server) return
    try {
      const r = await server.get<{ libraries: LibraryJSON[] }>('/api/libraries')
      this.byServer.set(key, r.libraries ?? [])
      this.registry.learn(key, r)
      log.debug(`[catalog] ${key}: ${r.libraries?.length ?? 0} libraries`)
    } catch (err) {
      log.warn(`[catalog] libraries from ${key} failed (keeping last known):`, (err as Error).message)
      if (!this.byServer.has(key)) this.byServer.set(key, [])
    }
  }

  /** Present an upstream library JSON the way clients should see it. */
  decorate(serverKey: string, lib: LibraryJSON, displayOrder?: number): FederatedLibrary {
    const label = this.registry.server(serverKey)?.label ?? serverKey
    return {
      ...lib,
      name: this.cfg.prefixLibraryNames ? `${label}: ${lib.name}` : lib.name,
      displayOrder: displayOrder ?? lib.displayOrder,
      serverKey,
      upstreamName: lib.name
    }
  }

  /** All libraries in server order, then upstream display order, renumbered. */
  all(): FederatedLibrary[] {
    const out: FederatedLibrary[] = []
    for (const server of this.registry.all) {
      const libs = [...(this.byServer.get(server.key) ?? [])].sort((a, b) => a.displayOrder - b.displayOrder)
      for (const lib of libs) out.push(this.decorate(server.key, lib, out.length + 1))
    }
    return out
  }

  get(id: string): FederatedLibrary | undefined {
    return this.all().find((l) => l.id === id)
  }

  /** Libraries a user may see, per their config allow-list. */
  forUser(user: Pick<UserConfig, 'libraries'> | undefined): FederatedLibrary[] {
    const rules = user?.libraries
    if (!rules) return this.all()
    return this.all().filter((lib) => rules.some((rule) => Catalog.ruleMatches(rule, lib)))
  }

  canAccess(user: Pick<UserConfig, 'libraries'> | undefined, libraryId: string): boolean {
    return this.forUser(user).some((l) => l.id === libraryId)
  }

  static ruleMatches(rule: string, lib: FederatedLibrary): boolean {
    const i = rule.indexOf(':')
    const key = rule.slice(0, i)
    const what = rule.slice(i + 1)
    if (key !== lib.serverKey) return false
    return what === '*' || what === lib.id || what.toLowerCase() === lib.upstreamName.toLowerCase()
  }

  get language(): string {
    return typeof this.serverSettings.language === 'string' ? this.serverSettings.language : 'en-us'
  }
}
