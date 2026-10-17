import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { request, Client, type Dispatcher } from 'undici'
import type { ServerConfig } from '../config.js'
import { log } from '../logger.js'

/**
 * Bytes buffered between the upstream read and the client write while
 * relaying media. With Node's defaults (16-64 KB) the two legs of a
 * long-distance relay (origin -> proxy -> client) stall each other: every
 * hiccup on one side shrinks the other side's TCP window. A few MB lets each
 * leg run at its own pace. Memory cost is per active download.
 */
const RELAY_BUFFER = Math.max(1, Number(process.env.SHELFMERGE_RELAY_BUFFER_MB) || 8) * 1024 * 1024
const UPSTREAM_READ_BUFFER = 1024 * 1024

/**
 * A keep-alive connection the server already closed: the request never got
 * an answer. Some servers (or the proxies in front of them) drop pooled
 * connections after a few large responses; the next request on that socket
 * fails immediately with one of these.
 */
function isStaleConnection(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  return code === 'UND_ERR_SOCKET' || code === 'UND_ERR_CLOSED' || code === 'ECONNRESET' || code === 'EPIPE'
}

/** Requests that only read, so sending them a second time is harmless. */
const isReadOnly = (method: string, path: string) => method === 'GET' || method === 'HEAD' || /^\/api\/(items\/batch\/get|authorize)(\?|$)/.test(path)

/** undici request, retried once on a fresh connection if a pooled one turns out to be dead (read-only requests only). */
async function requestWithRetry(url: string, path: string, opts: NonNullable<Parameters<typeof request>[1]>): Promise<Awaited<ReturnType<typeof request>>> {
  try {
    return await request(url, opts)
  } catch (err) {
    const method = String((opts as { method?: string })?.method ?? 'GET').toUpperCase()
    const body = (opts as { body?: unknown })?.body
    const replayable = body === undefined || typeof body === 'string'
    if (!isStaleConnection(err) || !isReadOnly(method, path) || !replayable) throw err
    log.debug(`[upstream] ${method} ${path} hit a closed connection, retrying on a fresh one`)
    // A one-off client guarantees a new connection; the pool may hold more dead ones.
    const client = new Client(new URL(url).origin)
    try {
      const res = await request(url, { ...opts, dispatcher: client })
      res.body.once('close', () => client.close().catch(() => {}))
      return res
    } catch (retryErr) {
      client.close().catch(() => {})
      throw retryErr
    }
  }
}

export class UpstreamError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly serverKey: string
  ) {
    super(`Upstream ${serverKey} responded ${status}`)
  }
}

/** Request headers never forwarded upstream. */
const HOP_BY_HOP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'authorization', 'cookie', 'accept-encoding', 'content-length'])

/**
 * Body to send upstream for a client request. Express has already parsed
 * JSON and form bodies, so those are re-serialized; anything else (multipart
 * uploads) is still unread and can be piped through.
 */
function requestBody(req: IncomingMessage, headers: Record<string, string>): Readable | string | undefined {
  const method = req.method ?? 'GET'
  if (method === 'GET' || method === 'HEAD') return undefined
  const parsed = (req as IncomingMessage & { body?: unknown }).body
  const ct = String(req.headers['content-type'] ?? '')
  if (parsed !== undefined && ct.includes('application/json')) {
    headers['content-type'] = 'application/json'
    return JSON.stringify(parsed)
  }
  if (parsed !== undefined && ct.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(parsed as Record<string, string>).toString()
  }
  return req
}

/** Request headers that would let upstream answer 304 instead of sending a body. */
const CONDITIONAL_REQUEST = new Set(['if-none-match', 'if-modified-since'])

/** Response headers never relayed back to the client. */
const HOP_BY_HOP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'content-encoding', 'content-security-policy', 'referrer-policy', 'x-powered-by'])

export interface JsonResult<T = unknown> {
  status: number
  headers: Record<string, string | string[] | undefined>
  json: T | null
  text: string
}

/**
 * One federated Audiobookshelf server, accessed with a single service API key.
 * Every method here speaks plain HTTP to the upstream; the socket.io relay
 * lives in socket/relay.ts.
 */
export class UpstreamServer {
  readonly key: string
  readonly url: string
  readonly label: string
  private readonly apiKey: string

  constructor(cfg: ServerConfig) {
    this.key = cfg.key
    this.url = cfg.url
    this.label = cfg.label
    this.apiKey = cfg.apiKey
  }

  get authHeader() {
    return `Bearer ${this.apiKey}`
  }

  /** The same server, called with another credential (a user's own account). */
  withKey(apiKey: string): UpstreamServer {
    return new UpstreamServer({ key: this.key, url: this.url, label: this.label, apiKey })
  }

  /** Perform a JSON request upstream (no client request involved). */
  async json<T = unknown>(path: string, init: { method?: Dispatcher.HttpMethod; body?: unknown; headers?: Record<string, string> } = {}): Promise<JsonResult<T>> {
    const res = await requestWithRetry(this.url + path, path, {
      method: init.method ?? 'GET',
      headers: {
        authorization: this.authHeader,
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined
    })
    const text = await res.body.text()
    let json: T | null = null
    const ct = String(res.headers['content-type'] ?? '')
    if (ct.includes('application/json') && text) {
      try {
        json = JSON.parse(text) as T
      } catch {
        json = null
      }
    }
    return { status: res.statusCode, headers: res.headers, json, text }
  }

  /** Like json() but throws on non-2xx and returns the parsed body. */
  async get<T = unknown>(path: string): Promise<T> {
    const r = await this.json<T>(path)
    if (r.status < 200 || r.status >= 300) throw new UpstreamError(r.status, r.text, this.key)
    return r.json as T
  }

  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const r = await this.json<T>(path, { method: 'POST', body })
    if (r.status < 200 || r.status >= 300) throw new UpstreamError(r.status, r.text, this.key)
    return r.json as T
  }

  /**
   * Forward a client request upstream and pipe the response back untouched,
   * keeping Range / Content-Range so seeking works. `path` must include the
   * query string.
   */
  async relay(req: IncomingMessage, res: ServerResponse, path: string, opts: { body?: unknown } = {}): Promise<void> {
    const headers: Record<string, string> = { authorization: this.authHeader }
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP_REQUEST.has(name) || value === undefined) continue
      headers[name] = Array.isArray(value) ? value.join(', ') : value
    }

    const method = (req.method ?? 'GET') as Dispatcher.HttpMethod
    let body: Readable | string | undefined
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body)
      headers['content-type'] = 'application/json'
    } else {
      body = requestBody(req, headers)
    }

    let upstream: Awaited<ReturnType<typeof request>>
    try {
      upstream = await requestWithRetry(this.url + path, path, { method, headers, body, highWaterMark: UPSTREAM_READ_BUFFER })
    } catch (err) {
      log.error(`[upstream:${this.key}] ${method} ${path} failed:`, (err as Error).message)
      if (!res.headersSent) {
        res.statusCode = 502
        res.end('Upstream unavailable')
      }
      return
    }

    for (const [name, value] of Object.entries(upstream.headers)) {
      if (HOP_BY_HOP_RESPONSE.has(name) || value === undefined) continue
      res.setHeader(name, value)
    }
    res.statusCode = upstream.statusCode

    if (method === 'HEAD') {
      upstream.body.resume()
      res.end()
      return
    }

    try {
      await pipeline(upstream.body, new PassThrough({ highWaterMark: RELAY_BUFFER }), res)
    } catch (err) {
      // A client that stops listening (seek, skip, closed app) ends the pipeline; that is normal.
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ERR_STREAM_PREMATURE_CLOSE' && code !== 'UND_ERR_ABORTED' && code !== 'ECONNRESET') log.warn(`[upstream:${this.key}] stream error on ${path}:`, (err as Error).message)
      upstream.body.destroy()
      if (!res.destroyed) res.destroy()
    }
  }

  /**
   * Forward a client request upstream and buffer the response so the caller
   * can inspect or rewrite JSON before sending it. Non-JSON responses are
   * returned as text and should be sent as-is.
   */
  async forwardJson<T = unknown>(req: IncomingMessage, path: string, opts: { body?: unknown } = {}): Promise<JsonResult<T>> {
    const headers: Record<string, string> = { authorization: this.authHeader }
    for (const [name, value] of Object.entries(req.headers)) {
      // The caller may rewrite the body, so a conditional request must not
      // turn into a 304 that makes the client reuse a stale cached copy.
      if (HOP_BY_HOP_REQUEST.has(name) || CONDITIONAL_REQUEST.has(name) || value === undefined) continue
      headers[name] = Array.isArray(value) ? value.join(', ') : value
    }
    const method = (req.method ?? 'GET') as Dispatcher.HttpMethod
    let body: Readable | string | undefined
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body)
      headers['content-type'] = 'application/json'
    } else {
      body = requestBody(req, headers)
    }
    const res = await requestWithRetry(this.url + path, path, { method, headers, body })
    const text = await res.body.text()
    let json: T | null = null
    if (String(res.headers['content-type'] ?? '').includes('application/json') && text) {
      try {
        json = JSON.parse(text) as T
      } catch {
        json = null
      }
    }
    return { status: res.statusCode, headers: res.headers, json, text }
  }
}

/** Copy a buffered upstream result onto an Express response. */
export function sendResult(res: ServerResponse, result: JsonResult, bodyOverride?: unknown) {
  for (const [name, value] of Object.entries(result.headers)) {
    if (HOP_BY_HOP_RESPONSE.has(name) || name === 'content-length' || value === undefined) continue
    // Upstream's validators describe upstream's body, not the one sent here.
    if (name === 'etag' || name === 'last-modified') continue
    res.setHeader(name, value)
  }
  res.statusCode = result.status
  if (bodyOverride !== undefined) {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(bodyOverride))
  } else {
    res.end(result.text)
  }
}
