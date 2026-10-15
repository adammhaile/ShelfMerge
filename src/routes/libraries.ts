import { Router } from 'express'
import type { Context } from '../context.js'
import { sendResult } from '../upstream/server.js'
import type { LibraryJSON } from '../upstream/catalog.js'

/**
 * The library list is the one place federation is visible: every server's
 * libraries in one list, prefixed with the server label. Everything under a
 * library id is forwarded to its server; access is checked against the
 * user's allow-list first.
 */
export function libraryRoutes(ctx: Context): Router {
  const r = Router()

  r.get('/libraries', (req, res) => {
    res.json({ libraries: ctx.catalog.forUser(ctx.users.config(req.smUser)).map(({ serverKey, upstreamName, merged, sources, ...lib }) => lib) })
  })

  r.use('/libraries/:id', (req, res, next) => {
    const lib = ctx.catalog.get(req.params.id)
    if (!lib) return res.sendStatus(404)
    if (!ctx.catalog.canAccess(ctx.users.config(req.smUser), lib.id)) return res.sendStatus(403)
    ctx.lastLibrary.set(req.smUser.id, lib.id)
    next()
  })

  // With ?include=filterdata upstream wraps the library: { filterdata, issues, numUserPlaylists, library }.
  r.get('/libraries/:id', async (req, res) => {
    const lib = ctx.catalog.get(req.params.id)!
    const base = lib.serverKey ? ctx.registry.server(lib.serverKey) : undefined
    if (!base) return res.sendStatus(404)
    const server = ctx.accounts.upstream(req.smUser, base)
    const result = await server.forwardJson<LibraryJSON | { library: LibraryJSON }>(req, req.smPath)
    if (result.status !== 200 || !result.json) return sendResult(res, result)
    const present = (l: LibraryJSON) => ({ ...ctx.catalog.decorate(server.key, l, lib.displayOrder), serverKey: undefined, upstreamName: undefined })
    const json = result.json as Record<string, unknown>
    const wrapped = json.library as LibraryJSON | undefined
    const body = wrapped && typeof wrapped === 'object' && 'id' in wrapped ? { ...json, library: present(wrapped) } : present(json as LibraryJSON)
    sendResult(res, result, body)
  })

  // Mutations of library settings are an owner's job, not a guest's.
  r.patch('/libraries/:id', (_req, res) => res.sendStatus(403))
  r.delete('/libraries/:id', (_req, res) => res.sendStatus(403))
  r.post('/libraries/order', (_req, res) => res.sendStatus(403))

  return r
}
