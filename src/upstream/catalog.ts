import { v5 as uuidv5 } from 'uuid'
import type { Registry } from './registry.js'
import type { Config, UserConfig, MergedLibraryConfig } from '../config.js'
import { log } from '../logger.js'

export interface LibraryJSON {
  id: string
  name: string
  displayOrder: number
  mediaType: string
  settings?: Record<string, unknown>
  [key: string]: unknown
}

export interface LibrarySource {
  serverKey: string
  libraryId: string
}

/** A library as presented to clients: upstream JSON plus which server owns it. */
export interface FederatedLibrary extends LibraryJSON {
  /** Owning server; absent for merged libraries. */
  serverKey?: string
  /** Name without the server prefix, for allow-list matching. */
  upstreamName: string
  merged?: boolean
  sources?: LibrarySource[]
}

interface AuthorizeResponse {
  serverSettings: Record<string, unknown>
}

/** Stable ids for merged libraries: derived from the configured name. */
const MERGED_NAMESPACE = '6f3f0c7e-9a26-4c1a-9c8f-2b9b2d2d4a11'
export const mergedLibraryId = (name: string) => uuidv5(name.trim().toLowerCase(), MERGED_NAMESPACE)

const DEFAULT_BOOK_SETTINGS = {
  coverAspectRatio: 1,
  disableWatcher: false,
  autoScanCronExpression: null,
  skipMatchingMediaWithAsin: false,
  skipMatchingMediaWithIsbn: false,
  audiobooksOnly: false,
  epubsAllowScriptedContent: false,
  hideSingleBookSeries: false,
  onlyShowLaterBooksInContinueSeries: false,
  metadataPrecedence: ['folderStructure', 'audioMetatags', 'nfoFile', 'txtFiles', 'opfFile', 'absMetadata'],
  markAsFinishedPercentComplete: null,
  markAsFinishedTimeRemaining: 10
}

/**
 * The list of libraries across all servers, plus the default server's
 * settings. Clients fetch libraries constantly and the list rarely changes,
 * so it is cached here and refreshed on a timer and on library socket
 * events. A server that is down keeps its last known libraries, so browsing
 * other servers keeps working. Merged libraries come first.
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
    for (const key of [...this.byServer.keys()]) if (!this.registry.server(key)) this.byServer.delete(key)
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

  get sortingPrefixes(): string[] {
    const p = this.serverSettings.sortingPrefixes
    return Array.isArray(p) ? p.map(String) : ['the', 'a']
  }

  get sortingIgnorePrefix(): boolean {
    return !!this.serverSettings.sortingIgnorePrefix
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

  /** Upstream libraries only, in server order then display order. */
  private upstreamLibraries(): Array<{ serverKey: string; lib: LibraryJSON }> {
    const out: Array<{ serverKey: string; lib: LibraryJSON }> = []
    for (const server of this.registry.all) {
      const libs = [...(this.byServer.get(server.key) ?? [])].sort((a, b) => a.displayOrder - b.displayOrder)
      for (const lib of libs) out.push({ serverKey: server.key, lib })
    }
    return out
  }

  private sourcesFor(m: MergedLibraryConfig): LibrarySource[] {
    return this.upstreamLibraries()
      .filter(({ serverKey, lib }) => lib.mediaType === m.mediaType && m.sources.some((rule) => rule === '*' || Catalog.ruleMatches(rule, { ...lib, serverKey, upstreamName: lib.name })))
      .map(({ serverKey, lib }) => ({ serverKey, libraryId: lib.id }))
  }

  /** Merged libraries with their current source libraries resolved. */
  mergedLibraries(): FederatedLibrary[] {
    return this.cfg.merged.map((m, i) => {
      const sources = this.sourcesFor(m)
      const libs = this.upstreamLibraries().filter(({ lib }) => sources.some((s) => s.libraryId === lib.id))
      const num = (k: 'lastScan' | 'createdAt' | 'lastUpdate', pick: (a: number[]) => number) => {
        const vals = libs.map(({ lib }) => Number(lib[k]) || 0).filter(Boolean)
        return vals.length ? pick(vals) : null
      }
      return {
        id: mergedLibraryId(m.name),
        name: m.name,
        folders: [],
        displayOrder: i + 1,
        icon: 'database',
        mediaType: m.mediaType,
        provider: (libs[0]?.lib.provider as string) ?? 'audible',
        settings: { ...(m.mediaType === 'book' ? DEFAULT_BOOK_SETTINGS : {}), ...(libs[0]?.lib.settings ?? {}), hideSingleBookSeries: libs.some(({ lib }) => !!(lib.settings as { hideSingleBookSeries?: boolean })?.hideSingleBookSeries) },
        lastScan: num('lastScan', (a) => Math.max(...a)),
        lastScanVersion: (libs[0]?.lib.lastScanVersion as string) ?? null,
        createdAt: num('createdAt', (a) => Math.min(...a)) ?? Date.now(),
        lastUpdate: num('lastUpdate', (a) => Math.max(...a)) ?? Date.now(),
        upstreamName: m.name,
        merged: true,
        sources
      }
    })
  }

  /** All libraries: merged first, then per-server, display order renumbered. */
  all(): FederatedLibrary[] {
    const out: FederatedLibrary[] = this.mergedLibraries()
    for (const { serverKey, lib } of this.upstreamLibraries()) out.push(this.decorate(serverKey, lib, out.length + 1))
    return out
  }

  get(id: string): FederatedLibrary | undefined {
    return this.all().find((l) => l.id === id)
  }

  /** Merged libraries that include the given upstream library. */
  mergedContaining(libraryId: string): FederatedLibrary[] {
    return this.mergedLibraries().filter((m) => m.sources!.some((s) => s.libraryId === libraryId))
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

  static ruleMatches(rule: string, lib: Pick<FederatedLibrary, 'id' | 'serverKey' | 'upstreamName' | 'merged'>): boolean {
    const i = rule.indexOf(':')
    const key = rule.slice(0, i)
    const what = rule.slice(i + 1)
    if (lib.merged ? key !== 'merged' : key !== lib.serverKey) return false
    return what === '*' || what === lib.id || what.toLowerCase() === lib.upstreamName.toLowerCase()
  }

  get language(): string {
    return typeof this.serverSettings.language === 'string' ? this.serverSettings.language : 'en-us'
  }
}
