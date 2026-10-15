import { Router, type Request, type Response } from 'express'
import type { Context } from '../context.js'
import { authMiddleware } from './middleware.js'
import { authRateLimit } from './ratelimit.js'
import { log } from '../logger.js'

/**
 * Login, refresh, logout and status. Shapes copied from Audiobookshelf's
 * Auth.js so the web client and the mobile apps cannot tell the difference.
 */
export function authRoutes(ctx: Context): Router {
  const r = Router()

  const isSecure = (req: Request) => req.secure || req.headers['x-forwarded-proto'] === 'https'

  const setRefreshCookie = (req: Request, res: Response, refreshToken: string) => {
    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: isSecure(req),
      sameSite: 'lax',
      maxAge: ctx.cfg.refreshTokenExpiry * 1000,
      path: '/'
    })
  }

  const loginPayload = (user: Request['smUser']) => ({
    user: ctx.users.toOldJSON(user),
    userDefaultLibraryId: ctx.catalog.forUser(ctx.users.config(user))[0]?.id ?? null,
    serverSettings: ctx.catalog.serverSettings,
    ereaderDevices: [],
    Source: 'docker'
  })

  r.get('/status', (_req, res) => {
    res.json({
      app: 'audiobookshelf',
      serverVersion: ctx.absVersion,
      isInit: true,
      language: ctx.catalog.language,
      authMethods: ['local'],
      authFormData: {}
    })
  })
  r.get('/ping', (_req, res) => res.json({ success: true }))
  r.get('/healthcheck', (_req, res) => res.sendStatus(200))

  const limiter = authRateLimit()

  r.post('/login', limiter, (req, res) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
    const user = username && typeof password === 'string' ? ctx.users.authenticate(username, password) : null
    if (!user) {
      log.warn(`[auth] failed login for "${username ?? ''}" from ${req.ip}`)
      return res.status(401).send('Invalid user or password')
    }

    const returnTokens = req.headers['x-return-tokens'] === 'true'
    const { accessToken, refreshToken } = ctx.tokens.createSession(user, req)
    ctx.users.touch(user.id)
    ctx.accounts.pull(user).catch(() => {})

    const payload = loginPayload(user)
    const userJson = payload.user as typeof payload.user & { accessToken: string; refreshToken: string | null }
    userJson.accessToken = accessToken
    userJson.refreshToken = returnTokens ? refreshToken : null
    if (!returnTokens) setRefreshCookie(req, res, refreshToken)
    log.info(`[auth] "${user.username}" logged in (${returnTokens ? 'tokens in body' : 'cookie'})`)
    res.json(payload)
  })

  r.post('/auth/refresh', limiter, (req, res) => {
    let refreshToken = (req.cookies as Record<string, string> | undefined)?.refresh_token
    let returnRefresh = false
    const header = req.headers['x-refresh-token']
    if (typeof header === 'string' && header) {
      refreshToken = header
      returnRefresh = true
    }
    if (!refreshToken) return res.status(401).json({ error: 'No refresh token provided' })

    const result = ctx.tokens.refresh(refreshToken, req)
    if ('error' in result) return res.status(401).json({ error: result.error })

    if (!returnRefresh) setRefreshCookie(req, res, result.refreshToken)
    const payload = loginPayload(result.user)
    const userJson = payload.user as typeof payload.user & { accessToken: string; refreshToken: string | null }
    userJson.accessToken = result.accessToken
    userJson.refreshToken = returnRefresh ? result.refreshToken : null
    res.json(payload)
  })

  r.post('/logout', (req, res) => {
    const refreshToken = (req.cookies as Record<string, string> | undefined)?.refresh_token ?? (req.headers['x-refresh-token'] as string | undefined)
    res.clearCookie('refresh_token', { path: '/' })
    if (refreshToken) {
      if (req.query.allDevices === '1') ctx.tokens.invalidateAllForToken(refreshToken)
      else ctx.tokens.invalidate(refreshToken)
    }
    res.json({ redirect_url: null })
  })

  // The web client re-validates its stored token with this on every load.
  r.post('/api/authorize', authMiddleware(ctx), async (req, res) => {
    ctx.users.touch(req.smUser.id)
    // Native listening on the user's own servers since last time; quick when nothing changed.
    await ctx.accounts.pull(req.smUser).catch(() => 0)
    res.json(loginPayload(req.smUser))
  })

  return r
}
