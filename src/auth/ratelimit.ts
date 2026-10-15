import type { Request, Response, NextFunction } from 'express'

export interface RateLimitOptions {
  /** Window length in ms (default 10 min; env SHELFMERGE_AUTH_RATE_LIMIT_WINDOW). */
  windowMs?: number
  /** Failed attempts allowed per IP per window (default 20; env SHELFMERGE_AUTH_RATE_LIMIT, 0 disables). */
  max?: number
}

/**
 * Per-IP brute-force guard for the authentication routes. Only responses
 * with a 4xx status count against the limit, so normal logins and token
 * refreshes from one address never lock it out.
 */
export function authRateLimit(opts: RateLimitOptions = {}) {
  const envMax = process.env.SHELFMERGE_AUTH_RATE_LIMIT
  const envWindow = process.env.SHELFMERGE_AUTH_RATE_LIMIT_WINDOW
  const max = envMax !== undefined && !Number.isNaN(Number(envMax)) ? Number(envMax) : (opts.max ?? 20)
  const windowMs = envWindow !== undefined && Number(envWindow) > 0 ? Number(envWindow) : (opts.windowMs ?? 10 * 60 * 1000)
  const failures = new Map<string, { count: number; resetAt: number }>()
  let sweep = 0

  return (req: Request, res: Response, next: NextFunction) => {
    if (max <= 0) return next()
    const now = Date.now()
    if (++sweep % 500 === 0) for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k)
    const ip = req.ip ?? 'unknown'
    const entry = failures.get(ip)
    if (entry && entry.resetAt > now && entry.count >= max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)))
      return res.status(429).send('Too many failed attempts, please try again later')
    }
    res.on('finish', () => {
      if (res.statusCode < 400 || res.statusCode >= 500) return
      const cur = failures.get(ip)
      if (!cur || cur.resetAt <= Date.now()) failures.set(ip, { count: 1, resetAt: Date.now() + windowMs })
      else cur.count++
    })
    next()
  }
}
