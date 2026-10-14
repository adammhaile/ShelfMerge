import { Router } from 'express'
import type { Context } from '../context.js'
import { resolveMediaItemId, fetchItems } from './items-helpers.js'
import { log } from '../logger.js'

const isNullOrNaN = (v: unknown) => v === null || v === undefined || Number.isNaN(Number(v))

/**
 * /api/me/* is answered locally: progress, bookmarks and auth sessions belong
 * to the ShelfMerge user, never to the upstream service account.
 */
export function meRoutes(ctx: Context): Router {
  const r = Router()

  const emitUserUpdated = (userId: string) => {
    const user = ctx.users.byId(userId)
    if (user) ctx.socket.emitToUser(userId, 'user_updated', ctx.users.toOldJSON(user))
  }

  r.get('/me', (req, res) => res.json(ctx.users.toOldJSON(req.smUser)))

  r.get('/me/sessions', (req, res) => {
    const page = Math.max(0, Number(req.query.page) || 0)
    const itemsPerPage = Math.max(1, Number(req.query.itemsPerPage) || 10)
    const current = (req.cookies as Record<string, string> | undefined)?.refresh_token ?? req.headers['x-refresh-token']
    const rows = ctx.db.prepare('SELECT * FROM auth_sessions WHERE userId = ? AND expiresAt > ? ORDER BY updatedAt DESC').all(req.smUser.id, Date.now()) as Array<Record<string, unknown>>
    const slice = rows.slice(page * itemsPerPage, (page + 1) * itemsPerPage)
    res.json({
      total: rows.length,
      numPages: Math.ceil(rows.length / itemsPerPage),
      page,
      itemsPerPage,
      sessions: slice.map((s) => ({
        id: s.id,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        deviceInfo: { userAgent: s.userAgent },
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        current: !!current && (s.refreshToken === current || s.lastRefreshToken === current)
      }))
    })
  })

  r.delete('/me/sessions/:id', (req, res) => {
    const changes = ctx.db.prepare('DELETE FROM auth_sessions WHERE id = ? AND userId = ?').run(req.params.id, req.smUser.id).changes
    res.sendStatus(changes ? 200 : 404)
  })

  r.get('/me/progress', (req, res) => res.json({ mediaProgress: ctx.progress.allForUser(req.smUser.id) }))

  r.get('/me/bookmarks', (req, res) => res.json({ bookmarks: ctx.progress.bookmarksForUser(req.smUser.id) }))

  r.get('/me/bookmarks/:libraryItemId', (req, res) => {
    res.json({ bookmarks: ctx.progress.bookmarksForUser(req.smUser.id).filter((b) => b.libraryItemId === req.params.libraryItemId) })
  })

  const paged = (req: import('express').Request, sessions: unknown[]) => {
    const itemsPerPage = Number(req.query.itemsPerPage) || 10
    const page = Number(req.query.page) || 0
    return { total: sessions.length, numPages: Math.ceil(sessions.length / itemsPerPage), page, itemsPerPage, sessions: sessions.slice(page * itemsPerPage, (page + 1) * itemsPerPage) }
  }
  r.get('/me/listening-sessions', (req, res) => res.json(paged(req, ctx.history.forUser(req.smUser.id))))
  r.get('/me/item/listening-sessions/:libraryItemId/:episodeId?', (req, res) => res.json(paged(req, ctx.history.forItem(req.smUser.id, req.params.libraryItemId, req.params.episodeId ?? null))))
  r.get('/me/listening-stats', (req, res) => res.json(ctx.history.stats(req.smUser.id)))
  r.get('/me/stats/year/:year', async (req, res) => {
    const year = Number(req.params.year)
    if (Number.isNaN(year) || year < 2000 || year > 9999) return res.status(400).send('Invalid year')
    const from = new Date(year, 0, 1).valueOf()
    const to = new Date(year + 1, 0, 1).valueOf()
    const finishedRows = ctx.progress.rowsForUser(req.smUser.id).filter((mp) => mp.isFinished && mp.mediaItemType === 'book' && mp.finishedAt && mp.finishedAt >= from && mp.finishedAt < to)
    const items = await fetchItems(ctx, [...new Set(finishedRows.map((mp) => mp.libraryItemId))])
    const finished = finishedRows.map((mp) => {
      const li = items.get(mp.libraryItemId)
      const meta = (li?.media.metadata ?? {}) as { title?: string }
      return { libraryItemId: mp.libraryItemId, mediaItemId: mp.mediaItemId, duration: mp.duration, finishedAt: mp.finishedAt!, title: meta.title ?? '', hasCover: !!li?.media.coverPath }
    })
    res.json(ctx.history.yearStats(req.smUser.id, year, finished))
  })

  r.get('/me/progress/:id/remove-from-continue-listening', (req, res) => {
    const mp = ctx.progress.getById(req.smUser.id, req.params.id)
    if (!mp) return res.sendStatus(404)
    ctx.progress.createUpdate(req.smUser.id, ctx.registry.lookup(mp.libraryItemId)?.serverKey ?? ctx.registry.default.key, mp.mediaItemId, {
      libraryItemId: mp.libraryItemId,
      episodeId: mp.episodeId,
      hideFromContinueListening: true
    })
    emitUserUpdated(req.smUser.id)
    res.json(ctx.users.toOldJSON(req.smUser))
  })

  r.get('/me/progress/:id/:episodeId?', (req, res) => {
    const mp = ctx.progress.get(req.smUser.id, req.params.id, req.params.episodeId ?? null)
    if (!mp) return res.sendStatus(404)
    res.json(mp)
  })

  r.patch('/me/progress/batch/update', async (req, res) => {
    const payloads = req.body as Array<Record<string, unknown>>
    if (!Array.isArray(payloads) || !payloads.length) return res.status(400).send('Missing request payload')
    let updated = false
    for (const p of payloads) {
      if (typeof p.libraryItemId !== 'string') continue
      const resolved = await resolveMediaItemId(ctx, p.libraryItemId, (p.episodeId as string | null) ?? null)
      if (!resolved) {
        log.warn(`[me] batch progress: item ${p.libraryItemId} not found`)
        continue
      }
      ctx.progress.createUpdate(req.smUser.id, resolved.serverKey, resolved.mediaItemId, { ...p, libraryItemId: p.libraryItemId, episodeId: (p.episodeId as string | null) ?? null } as never)
      updated = true
    }
    if (updated) emitUserUpdated(req.smUser.id)
    res.sendStatus(200)
  })

  r.patch('/me/progress/:libraryItemId/:episodeId?', async (req, res) => {
    const resolved = await resolveMediaItemId(ctx, req.params.libraryItemId, req.params.episodeId ?? null)
    if (!resolved) return res.status(404).send('Library item not found')
    const settings = (ctx.catalog.get(ctx.registry.lookup(req.params.libraryItemId)?.libraryId ?? '')?.settings ?? {}) as Record<string, unknown>
    ctx.progress.createUpdate(req.smUser.id, resolved.serverKey, resolved.mediaItemId, {
      ...(req.body as object),
      libraryItemId: req.params.libraryItemId,
      episodeId: req.params.episodeId ?? null,
      markAsFinishedTimeRemaining: typeof settings.markAsFinishedTimeRemaining === 'number' ? settings.markAsFinishedTimeRemaining : undefined,
      markAsFinishedPercentComplete: typeof settings.markAsFinishedPercentComplete === 'number' ? settings.markAsFinishedPercentComplete : undefined
    })
    emitUserUpdated(req.smUser.id)
    res.sendStatus(200)
  })

  r.delete('/me/progress/:id', (req, res) => {
    if (!ctx.progress.removeById(req.smUser.id, req.params.id)) return res.sendStatus(404)
    emitUserUpdated(req.smUser.id)
    res.sendStatus(200)
  })

  r.post('/me/item/:id/bookmark', (req, res) => {
    const { time, title } = req.body as { time?: number; title?: string }
    if (isNullOrNaN(time)) return res.status(400).send('Invalid time')
    if (!title || typeof title !== 'string') return res.status(400).send('Invalid title')
    const bookmark = ctx.progress.createBookmark(req.smUser.id, req.params.id, Number(time), title)
    emitUserUpdated(req.smUser.id)
    res.json(bookmark)
  })

  r.patch('/me/item/:id/bookmark', (req, res) => {
    const { time, title } = req.body as { time?: number; title?: string }
    if (isNullOrNaN(time)) return res.status(400).send('Invalid time')
    if (!title || typeof title !== 'string') return res.status(400).send('Invalid title')
    const bookmark = ctx.progress.updateBookmark(req.smUser.id, req.params.id, Number(time), title)
    if (!bookmark) return res.sendStatus(404)
    emitUserUpdated(req.smUser.id)
    res.json(bookmark)
  })

  r.delete('/me/item/:id/bookmark/:time', (req, res) => {
    const time = Number(req.params.time)
    if (Number.isNaN(time)) return res.status(400).send('Invalid time')
    if (!ctx.progress.findBookmark(req.smUser.id, req.params.id, time)) return res.sendStatus(404)
    ctx.progress.removeBookmark(req.smUser.id, req.params.id, time)
    emitUserUpdated(req.smUser.id)
    res.sendStatus(200)
  })

  r.patch('/me/password', (req, res) => {
    const { password, newPassword } = req.body as { password?: string; newPassword?: string }
    if (typeof password !== 'string' || typeof newPassword !== 'string') return res.status(400).json({ error: 'Invalid request' })
    if (!ctx.users.authenticate(req.smUser.username, password)) return res.status(403).json({ error: 'Invalid password' })
    ctx.users.setPassword(req.smUser.id, newPassword)
    res.json({ success: true })
  })

  r.get('/me/items-in-progress', async (req, res) => {
    const limit = Number(req.query.limit) || 25
    const inProgress = ctx.progress.rowsForUser(req.smUser.id).filter((mp) => !mp.isFinished && (mp.currentTime > 0 || mp.ebookProgress > 0))
    const items = await fetchItems(ctx, [...new Set(inProgress.map((mp) => mp.libraryItemId))])
    const result: Array<Record<string, unknown>> = []
    for (const mp of inProgress) {
      const li = items.get(mp.libraryItemId)
      if (!li) continue
      if (mp.episodeId) {
        const media = li.media as { podcastEpisodes?: Array<Record<string, unknown>> } | undefined
        const ep = media?.podcastEpisodes?.find((e) => e.id === mp.episodeId)
        if (ep) result.push({ ...li, recentEpisode: ep, progressLastUpdate: mp.updatedAt })
      } else {
        result.push({ ...li, progressLastUpdate: mp.updatedAt })
      }
    }
    result.sort((a, b) => (b.progressLastUpdate as number) - (a.progressLastUpdate as number))
    res.json({ libraryItems: result.slice(0, limit) })
  })

  r.get('/me/series/:id/remove-from-continue-listening', (req, res) => {
    const hidden = ctx.users.seriesHidden(req.smUser.id)
    if (!hidden.includes(req.params.id)) ctx.users.setSeriesHidden(req.smUser.id, [...hidden, req.params.id])
    emitUserUpdated(req.smUser.id)
    res.json(ctx.users.toOldJSON(req.smUser))
  })

  r.get('/me/series/:id/readd-to-continue-listening', (req, res) => {
    ctx.users.setSeriesHidden(
      req.smUser.id,
      ctx.users.seriesHidden(req.smUser.id).filter((id) => id !== req.params.id)
    )
    emitUserUpdated(req.smUser.id)
    res.json(ctx.users.toOldJSON(req.smUser))
  })

  r.post('/me/ereader-devices', (_req, res) => res.sendStatus(403))

  return r
}
