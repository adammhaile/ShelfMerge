import type { Server as HttpServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client'
import type { TokenManager } from '../auth/tokens.js'
import type { UserStore } from '../users.js'
import type { Registry } from '../upstream/registry.js'
import { TokenManager as TM } from '../auth/tokens.js'
import { log } from '../logger.js'

interface Client {
  socket: Socket
  userId?: string
  username?: string
}

/**
 * Events from upstream that are about the service account or the upstream
 * server itself and must never reach our clients. Everything else (items,
 * series, authors, collections, playlists, libraries, episodes, tasks...) is
 * catalog state and is relayed to every authenticated client.
 */
const DROP_UPSTREAM = /^(init|auth_failed|user_|users_online|admin_message|log|backup_|pong)/

/**
 * socket.io server for our clients plus one socket.io client per upstream
 * server. Clients authenticate with their ShelfMerge access token exactly
 * as they would against Audiobookshelf.
 */
export class SocketHub {
  private readonly servers: Server[] = []
  private readonly clients = new Map<string, Client>()
  private readonly upstreams: ClientSocket[] = []
  /** Optional hook to rewrite an upstream event's payload before it is relayed. */
  onUpstreamEvent: ((serverKey: string, event: string, payload: unknown) => unknown) | null = null

  constructor(
    private readonly tokens: TokenManager,
    private readonly users: UserStore,
    private readonly registry: Registry
  ) {}

  /**
   * Like upstream: one socket.io server at /socket.io for the mobile apps and
   * one at <basePath>/socket.io for the web client.
   */
  attach(httpServer: HttpServer, basePath: string) {
    const paths = ['/socket.io', ...(basePath ? [`${basePath}/socket.io`] : [])]
    for (const path of paths) {
      const io = new Server(httpServer, { path, cors: { origin: '*', methods: ['GET', 'POST'] } })
      io.on('connection', (socket) => {
        this.clients.set(socket.id, { socket })
        log.debug(`[socket] connected ${socket.id} on ${path}`)

        socket.on('auth', (token: unknown) => this.authenticate(socket, token))
        socket.on('ping', () => socket.emit('pong'))
        socket.on('disconnect', (reason) => {
          const c = this.clients.get(socket.id)
          log.debug(`[socket] ${c?.username ?? 'unauth'} disconnected (${reason})`)
          this.clients.delete(socket.id)
        })
      })
      this.servers.push(io)
    }
    this.connectUpstreams()
  }

  private authenticate(socket: Socket, token: unknown) {
    const payload = typeof token === 'string' ? this.tokens.verify(token) : null
    if (!TM.isAccess(payload)) {
      log.warn(`[socket] auth failed for ${socket.id}`)
      return socket.emit('auth_failed', { message: 'Invalid token' })
    }
    const user = this.users.byId(payload.userId)
    if (!user) return socket.emit('auth_failed', { message: 'Invalid token' })
    const client = this.clients.get(socket.id)
    if (!client) return
    client.userId = user.id
    client.username = user.username
    this.users.touch(user.id)
    log.info(`[socket] "${user.username}" authenticated (${socket.id})`)
    socket.emit('init', { userId: user.id, username: user.username })
  }

  /** Drop every upstream connection and connect to the registry's current server set. */
  reconnectUpstreams() {
    for (const s of this.upstreams) s.close()
    this.upstreams.length = 0
    this.connectUpstreams()
  }

  private connectUpstreams() {
    for (const server of this.registry.all) {
      const s = ioClient(server.url, { path: '/socket.io', transports: ['websocket'], reconnection: true, reconnectionDelayMax: 30_000 })
      s.on('connect', () => {
        log.info(`[socket:${server.key}] connected, authenticating`)
        s.emit('auth', server.authHeader.slice('Bearer '.length))
      })
      s.on('init', () => log.info(`[socket:${server.key}] upstream accepted service account`))
      s.on('auth_failed', (d: unknown) => log.error(`[socket:${server.key}] upstream auth failed:`, d))
      s.on('disconnect', (reason) => log.warn(`[socket:${server.key}] disconnected: ${reason}`))
      s.on('connect_error', (err) => log.debug(`[socket:${server.key}] connect error: ${err.message}`))
      s.onAny((event: string, ...args: unknown[]) => {
        if (DROP_UPSTREAM.test(event)) return
        if (args.length && args[0] && typeof args[0] === 'object') this.registry.learn(server.key, args[0])
        if (this.onUpstreamEvent && args.length) args[0] = this.onUpstreamEvent(server.key, event, args[0])
        this.broadcast(event, ...args)
      })
      this.upstreams.push(s)
    }
  }

  /** Send to every authenticated client. */
  broadcast(event: string, ...args: unknown[]) {
    for (const c of this.clients.values()) if (c.userId) c.socket.emit(event, ...args)
  }

  /** Send to all sockets belonging to one ShelfMerge user. */
  emitToUser(userId: string, event: string, data: unknown) {
    for (const c of this.clients.values()) if (c.userId === userId) c.socket.emit(event, data)
  }

  async close() {
    for (const s of this.upstreams) s.close()
    await Promise.all(this.servers.map((io) => new Promise<void>((resolve) => io.close(() => resolve()))))
  }
}
