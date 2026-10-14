import type { Request, Response, NextFunction } from 'express'
import type { Context } from '../context.js'
import { sendResult } from '../upstream/server.js'
import { log } from '../logger.js'

/** Routes whose responses are byte streams: relay without buffering. */
const STREAM_PATHS = [/^\/items\/[^/]+\/(cover|file|ebook|download)/, /^\/authors\/[^/]+\/image/, /^\/libraries\/[^/]+\/download/, /^\/items\/[^/]+\/file\/[^/]+\/download/, /^\/backups\//]

/** Routes answered locally because they are about the proxy itself, not content. */
const STUBS: Record<string, unknown> = {
  '/users/online': { usersOnline: [], openSessions: [] },
  '/tasks': { tasks: [] },
  '/api-keys': { apiKeys: [] },
  '/notifications': { data: { events: [] }, settings: { id: 'notification-settings', appriseType: 'api', appriseApiUrl: null, notifications: [], maxFailedAttempts: 5, maxNotificationQueue: 20, notificationDelay: 1000 } },
  '/auth-settings': { authActiveAuthMethods: ['local'] },
  '/logger-data': { currentDailyLogs: [] }
}

/**
 * Generic /api forwarder for everything the proxy does not interpret.
 * JSON responses are buffered so the registry can learn ids from them;
 * media and files are streamed.
 */
/**
 * The only writes that may reach an upstream server. Everything else that
 * mutates (metadata edits, uploads, scans, deletes, settings) is refused here
 * so the service account's permissions never matter: ShelfMerge users have
 * `update` so the collection UI appears, but their edits stop at the proxy.
 */
const ALLOWED_WRITES = [/^\/items\/[^/]+\/play(\/|$)/, /^\/items\/batch\/get$/, /^\/session\//, /^\/authorize$/, /^\/podcasts\/feed$/, /^\/podcasts\/opml\/parse$/]

export function apiForward(ctx: Context) {
  return async (req: Request, res: Response, _next: NextFunction) => {
    if (req.method === 'GET' && req.path in STUBS) return res.json(STUBS[req.path])
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !ALLOWED_WRITES.some((p) => p.test(req.path))) {
      log.info(`[forward] refused ${req.method} ${req.path} for "${req.smUser?.username}": upstream is read-only through ShelfMerge`)
      return res.status(403).send('Not allowed through ShelfMerge')
    }

    const server = await ctx.registry.resolvePathAsync(req.path)
    const path = req.smPath

    if (STREAM_PATHS.some((p) => p.test(req.path))) {
      return server.relay(req, res, stripToken(path))
    }

    try {
      const result = await server.forwardJson(req, stripToken(path))
      if (result.json && typeof result.json === 'object') ctx.registry.learn(server.key, result.json)
      sendResult(res, result)
    } catch (err) {
      log.error(`[forward:${server.key}] ${req.method} ${path}:`, (err as Error).message)
      if (!res.headersSent) res.status(502).send('Upstream unavailable')
    }
  }
}

/** /hls/:session/:file and /public/session/:id/track/:i route by session id. */
export function sessionForward(ctx: Context, _prefix: '/hls' | '/public') {
  return (req: Request, res: Response) => {
    const path = req.smPath
    const m = /^\/(?:session\/)?([0-9a-f-]{36})/i.exec(req.path)
    const row = m ? ctx.sessions.get(m[1]) : undefined
    const server = row ? ctx.registry.server(row.serverKey) : ctx.registry.resolvePath(req.path)
    if (!server) return res.sendStatus(404)
    return server.relay(req, res, stripToken(path))
  }
}

/** Our client's token must not reach upstream as a query parameter. */
function stripToken(path: string): string {
  const q = path.indexOf('?')
  if (q === -1) return path
  const params = new URLSearchParams(path.slice(q + 1))
  params.delete('token')
  const qs = params.toString()
  return path.slice(0, q) + (qs ? `?${qs}` : '')
}
