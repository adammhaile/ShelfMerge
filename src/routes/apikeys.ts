import { Router, type Request, type Response, type NextFunction } from 'express'
import type { Context } from '../context.js'
import type { ApiKeyRow } from '../db.js'

/** The stock API Keys settings page, in upstream's shapes. Admin only. */
export function apiKeyRoutes(ctx: Context): Router {
  const r = Router()
  const adminOnly = (req: Request, res: Response, next: NextFunction) => (ctx.users.isAdmin(req.smUser) ? next() : res.sendStatus(403))
  const brief = (id: string) => {
    const u = ctx.users.byId(id)
    return u ? { id: u.id, username: u.username, type: ctx.users.isAdmin(u) ? 'admin' : 'user' } : null
  }
  const json = (k: ApiKeyRow) => ({ ...k, isActive: !!k.isActive, user: brief(k.userId), createdByUser: brief(k.createdByUserId) })

  r.get('/api-keys', adminOnly, (_req, res) => res.json({ apiKeys: ctx.apiKeys.all().map(json) }))

  r.post('/api-keys', adminOnly, (req, res) => {
    const body = (req.body ?? {}) as { name?: unknown; userId?: unknown; expiresIn?: unknown; isActive?: unknown }
    if (!body.name || typeof body.name !== 'string') return res.sendStatus(400)
    if (body.expiresIn !== undefined && body.expiresIn !== null && (typeof body.expiresIn !== 'number' || body.expiresIn <= 0)) return res.sendStatus(400)
    if (!body.userId || typeof body.userId !== 'string' || !ctx.users.byId(body.userId)) return res.sendStatus(400)
    const { row, token } = ctx.apiKeys.create(body.name, body.userId, req.smUser.id, { expiresIn: body.expiresIn as number | null | undefined, isActive: body.isActive !== false })
    res.json({ apiKey: { apiKey: token, ...json(row) } })
  })

  r.patch('/api-keys/:id', adminOnly, (req, res) => {
    const body = (req.body ?? {}) as { isActive?: unknown; userId?: unknown }
    if (body.isActive !== undefined && typeof body.isActive !== 'boolean') return res.sendStatus(400)
    if (body.userId !== undefined && (typeof body.userId !== 'string' || !ctx.users.byId(body.userId))) return res.sendStatus(400)
    const row = ctx.apiKeys.update(req.params.id, { isActive: body.isActive as boolean | undefined, userId: body.userId as string | undefined })
    if (!row) return res.sendStatus(404)
    res.json({ apiKey: json(row) })
  })

  r.delete('/api-keys/:id', adminOnly, (req, res) => {
    if (!ctx.apiKeys.get(req.params.id)) return res.sendStatus(404)
    ctx.apiKeys.remove(req.params.id)
    res.sendStatus(200)
  })

  return r
}
