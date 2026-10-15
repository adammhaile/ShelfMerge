import type { Request, Response, NextFunction } from 'express'
import type { Context } from '../context.js'

/** GET routes Audiobookshelf serves without auth (cover images, author images). */
const NO_AUTH_GET = [/^\/items\/[^/]+\/cover$/, /^\/authors\/[^/]+\/image$/]

export function extractToken(req: Request): string | null {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7)
  const q = req.query.token
  if (typeof q === 'string' && q) return q
  return null
}

/**
 * Bearer or ?token= JWT auth, same extractor order as Audiobookshelf's
 * passport-jwt setup. Attaches the ShelfMerge user as req.smUser.
 */
export function authMiddleware(ctx: Context) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' && NO_AUTH_GET.some((p) => p.test(req.path))) return next()

    const token = extractToken(req)
    const userId = token ? ctx.tokens.userIdForToken(token) : null
    const user = userId ? ctx.users.byId(userId) : undefined
    if (!user || !user.isActive) return res.sendStatus(401)
    req.smUser = user
    next()
  }
}
