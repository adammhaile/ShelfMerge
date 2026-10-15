import { Router, type Request, type Response, type NextFunction } from 'express'
import type { Context } from '../context.js'

/**
 * The stock Users settings page, backed by ShelfMerge's own user table.
 * Admins (`admin: true` in the config) can list users, create them, reset
 * passwords, rename and deactivate. Users from the config keep their
 * allow-lists and own-account keys there, so renaming or deleting those is
 * refused with a pointer to the file.
 */
export function userRoutes(ctx: Context): Router {
  const r = Router()

  const adminOnly = (req: Request, res: Response, next: NextFunction) => (ctx.users.isAdmin(req.smUser) ? next() : res.sendStatus(403))
  const emitAdmins = (event: string, data: unknown) => {
    for (const u of ctx.users.all()) if (ctx.users.isAdmin(u)) ctx.socket.emitToUser(u.id, event, data)
  }
  const target = (req: Request, res: Response) => {
    const user = ctx.users.byId(req.params.id)
    if (!user) res.sendStatus(404)
    return user
  }

  r.get('/users', adminOnly, (req, res) => {
    const users = ctx.users.all().map((u) => ctx.users.toOldJSON(u, true)) as unknown as Array<Record<string, unknown>>
    if (String(req.query.include ?? '').split(',').includes('latestSession')) {
      for (const u of users) u.latestSession = ctx.history.forUser(u.id as string)[0] ?? null
    }
    res.json({ users })
  })

  r.get('/users/:id', adminOnly, (req, res) => {
    const user = target(req, res)
    if (!user) return
    const json = ctx.users.toOldJSON(user) as unknown as Record<string, unknown>
    // The user page lists progress with titles and covers; the index knows most of them.
    json.mediaProgress = ctx.progress.allForUser(user.id).map((mp) => {
      const it = ctx.indexStore.getItem(mp.libraryItemId)
      return { ...mp, displayTitle: it?.media.metadata.title ?? null, coverPath: it?.media.coverPath ?? null, mediaUpdatedAt: it?.updatedAt ?? null }
    })
    res.json(json)
  })

  const paged = (req: Request, sessions: unknown[]) => {
    const itemsPerPage = Number(req.query.itemsPerPage) || 10
    const page = Number(req.query.page) || 0
    return { total: sessions.length, numPages: Math.ceil(sessions.length / itemsPerPage), page, itemsPerPage, sessions: sessions.slice(page * itemsPerPage, (page + 1) * itemsPerPage) }
  }
  r.get('/users/:id/listening-sessions', adminOnly, (req, res) => {
    const user = target(req, res)
    if (!user) return
    res.json(paged(req, ctx.history.forUser(user.id)))
  })
  r.get('/users/:id/listening-stats', adminOnly, (req, res) => {
    const user = target(req, res)
    if (!user) return
    res.json(ctx.history.stats(user.id))
  })

  r.post('/users', adminOnly, (req, res) => {
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown }
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') return res.status(400).send('Username and password are required')
    if (!/^[\w.@+-]{1,64}$/.test(username)) return res.status(400).send('Invalid username')
    let user
    try {
      user = ctx.users.create(username.trim(), password)
    } catch (err) {
      return res.status(400).send((err as Error).message)
    }
    const json = ctx.users.toOldJSON(user)
    emitAdmins('user_added', json)
    res.json({ user: json })
  })

  r.patch('/users/:id', adminOnly, (req, res) => {
    const user = target(req, res)
    if (!user) return
    const body = (req.body ?? {}) as { password?: unknown; username?: unknown; isActive?: unknown }
    if (body.username !== undefined && body.username !== user.username) {
      if (typeof body.username !== 'string' || !/^[\w.@+-]{1,64}$/.test(body.username)) return res.status(400).send('Invalid username')
      if (user.source === 'config') return res.status(400).send('This user is defined in the config file; rename them there')
      if (ctx.users.byUsername(body.username)) return res.status(400).send('Username already taken')
      ctx.users.rename(user.id, body.username)
    }
    if (typeof body.password === 'string' && body.password) {
      ctx.users.setPassword(user.id, body.password)
      ctx.tokens.invalidateAllForUser(user.id)
    }
    if (typeof body.isActive === 'boolean' && body.isActive !== !!user.isActive) {
      if (user.id === req.smUser.id && !body.isActive) return res.status(400).send('You cannot deactivate yourself')
      ctx.users.setActive(user.id, body.isActive)
    }
    // Type, permissions and library access are governed by the config, not the form.
    const fresh = ctx.users.byId(user.id) ?? user
    const json = ctx.users.toOldJSON(fresh)
    emitAdmins('user_updated', json)
    res.json({ success: true, user: json })
  })

  r.delete('/users/:id', adminOnly, (req, res) => {
    const user = target(req, res)
    if (!user) return
    if (user.id === req.smUser.id) return res.status(400).send('You cannot delete yourself')
    if (user.source === 'config') return res.status(400).send('This user is defined in the config file; remove them there')
    const json = ctx.users.toOldJSON(user, true)
    ctx.users.remove(user.id)
    emitAdmins('user_removed', json)
    res.json({ success: true })
  })

  r.patch('/users/:id/openid-unlink', adminOnly, (_req, res) => res.sendStatus(400))

  return r
}
