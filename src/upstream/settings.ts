import type { Registry } from './registry.js'
import { log } from './../logger.js'

interface AuthorizeResponse {
  user: { id: string }
  userDefaultLibraryId: string | null
  serverSettings: Record<string, unknown>
}

interface LibrariesResponse {
  libraries: Array<{ id: string; name: string; mediaType: string; displayOrder: number }>
}

/**
 * Server settings and the library list are needed by the login payload and
 * /status. They come from the default upstream server and are refreshed on a
 * timer; the web client reads things like sorting prefixes and language from
 * them, so they must look real.
 */
export class SettingsCache {
  serverSettings: Record<string, unknown> = {}
  libraries: LibrariesResponse['libraries'] = []
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly registry: Registry) {}

  async start(refreshMs = 5 * 60 * 1000) {
    await this.refresh()
    this.timer = setInterval(() => this.refresh().catch(() => {}), refreshMs)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  async refresh() {
    const server = this.registry.default
    try {
      const auth = await server.post<AuthorizeResponse>('/api/authorize', {})
      this.serverSettings = auth.serverSettings ?? {}
      const libs = await server.get<LibrariesResponse>('/api/libraries')
      this.libraries = libs.libraries ?? []
      this.registry.learn(server.key, libs)
      log.debug(`[settings] refreshed from ${server.key}: ${this.libraries.length} libraries`)
    } catch (err) {
      log.warn(`[settings] refresh from ${server.key} failed:`, (err as Error).message)
    }
  }

  get defaultLibraryId(): string | null {
    const sorted = [...this.libraries].sort((a, b) => a.displayOrder - b.displayOrder)
    return sorted[0]?.id ?? null
  }

  get language(): string {
    return typeof this.serverSettings.language === 'string' ? this.serverSettings.language : 'en-us'
  }
}
