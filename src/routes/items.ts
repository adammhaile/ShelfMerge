import { Router, type Request } from 'express'
import type { Context } from '../context.js'
import { sendResult } from '../upstream/server.js'
import { resolveMediaItemId, fetchItems, type LibraryItemJSON } from './items-helpers.js'
import type { PlaybackSessionRow } from '../db.js'
import { log } from '../logger.js'

interface SessionJSON {
  id: string
  userId: string
  libraryId: string
  libraryItemId: string
  bookId: string | null
  episodeId: string | null
  mediaType: string
  displayTitle: string
  duration: number
  deviceInfo: { deviceDescription?: string } | null
  startTime: number
  currentTime: number
  startedAt: number
  updatedAt: number
  libraryItem: LibraryItemJSON | null
}

interface SyncBody {
  currentTime?: number
  timeListened?: number
  duration?: number
}

interface Shelf {
  id: string
  label: string
  labelStringKey: string
  type: string
  entities: unknown[]
  total?: number
}

const pathWithQuery = (req: Request) => req.smPath

/**
 * Item, playback and personalized routes: forwarded upstream, with the
 * service account's progress replaced by the ShelfMerge user's wherever it
 * leaks into a response.
 */
export function itemRoutes(ctx: Context): Router {
  const r = Router()

  // Item detail: inject our progress when the client asked for it.
  r.get('/items/:id', async (req, res) => {
    const server = ctx.registry.resolvePath(req.path)
    const result = await server.forwardJson<LibraryItemJSON & { userMediaProgress?: unknown }>(req, pathWithQuery(req))
    if (result.status !== 200 || !result.json) return sendResult(res, result)
    ctx.registry.learn(server.key, result.json)
    const include = String(req.query.include ?? '')
      .split(',')
      .map((s) => s.trim())
    if (include.includes('progress')) {
      const episodeId = typeof req.query.episode === 'string' ? req.query.episode : null
      result.json.userMediaProgress = ctx.progress.get(req.smUser.id, req.params.id, episodeId)
    }
    sendResult(res, result, result.json)
  })

  // Start playback: upstream creates the session under the service account;
  // we re-own it and seed the start position from our progress.
  const play = async (req: Request, res: import('express').Response) => {
    const server = ctx.registry.resolvePath(req.path)
    const result = await server.forwardJson<SessionJSON>(req, pathWithQuery(req))
    if (result.status !== 200 || !result.json) return sendResult(res, result)
    const session = result.json
    ctx.registry.learn(server.key, session)

    const episodeId = req.params.episodeId ?? null
    const mp = ctx.progress.get(req.smUser.id, req.params.id, episodeId)
    let startTime = 0
    if (mp && !mp.isFinished) startTime = Number(mp.currentTime) || 0
    session.userId = req.smUser.id
    session.startTime = startTime
    session.currentTime = startTime
    if (session.libraryItem) {
      ;(session.libraryItem as { userMediaProgress?: unknown }).userMediaProgress = mp
    }

    const mediaItemId = episodeId ?? session.bookId ?? session.libraryItem?.media?.id
    const row: PlaybackSessionRow = {
      id: session.id,
      serverKey: server.key,
      userId: req.smUser.id,
      libraryItemId: session.libraryItemId,
      episodeId: episodeId ?? '',
      mediaItemId: String(mediaItemId ?? ''),
      mediaType: session.mediaType,
      duration: session.duration,
      displayTitle: session.displayTitle,
      deviceDescription: session.deviceInfo?.deviceDescription ?? '',
      startedAt: session.startedAt,
      updatedAt: session.updatedAt
    }
    ctx.sessions.upsert(row)
    log.info(`[play] "${req.smUser.username}" started "${session.displayTitle}" on ${server.key} (session ${session.id})`)
    sendResult(res, result, session)
  }
  r.post('/items/:id/play', play)
  r.post('/items/:id/play/:episodeId', play)

  // Sync: keep the upstream session alive and record progress for our user.
  const applySync = (userId: string, row: PlaybackSessionRow, body: SyncBody) => {
    if (body.currentTime === undefined) return null
    const duration = body.duration || row.duration || 0
    const mp = ctx.progress.createUpdate(userId, row.serverKey, row.mediaItemId, {
      libraryItemId: row.libraryItemId,
      episodeId: row.episodeId || null,
      duration,
      currentTime: body.currentTime,
      progress: duration ? Math.max(0, Math.min(body.currentTime / duration, 1)) : 0
    })
    ctx.sessions.touch(row.id)
    ctx.socket.emitToUser(userId, 'user_item_progress_updated', { id: mp.id, sessionId: row.id, deviceDescription: row.deviceDescription, data: mp })
    return mp
  }

  const sessionOwner = (req: Request, res: import('express').Response): PlaybackSessionRow | null => {
    const row = ctx.sessions.get(req.params.id)
    if (!row) {
      res.sendStatus(404)
      return null
    }
    if (row.userId !== req.smUser.id) {
      res.sendStatus(403)
      return null
    }
    return row
  }

  r.get('/session/:id', async (req, res) => {
    const row = sessionOwner(req, res)
    if (!row) return
    const server = ctx.registry.server(row.serverKey)!
    const result = await server.forwardJson<SessionJSON>(req, pathWithQuery(req))
    if (result.status === 200 && result.json) {
      result.json.userId = req.smUser.id
      return sendResult(res, result, result.json)
    }
    sendResult(res, result)
  })

  r.post('/session/:id/sync', async (req, res) => {
    const row = sessionOwner(req, res)
    if (!row) return
    const body = req.body as SyncBody
    const server = ctx.registry.server(row.serverKey)!
    const upstream = await server.json(`/api/session/${row.id}/sync`, { method: 'POST', body })
    if (upstream.status === 404) {
      // Upstream forgot the session (restart, stale cleanup); progress still counts.
      log.warn(`[sync] upstream ${server.key} lost session ${row.id}`)
    }
    applySync(req.smUser.id, row, body)
    res.sendStatus(200)
  })

  r.post('/session/:id/close', async (req, res) => {
    const row = sessionOwner(req, res)
    if (!row) return
    const body = (req.body ?? {}) as SyncBody
    const server = ctx.registry.server(row.serverKey)!
    await server.json(`/api/session/${row.id}/close`, { method: 'POST', body: Object.keys(body).length ? body : undefined })
    if (body.currentTime !== undefined) applySync(req.smUser.id, row, body)
    ctx.sessions.remove(row.id)
    ctx.socket.emitToUser(req.smUser.id, 'user_session_closed', row.id)
    res.sendStatus(200)
  })

  // Offline sessions uploaded by the mobile apps.
  interface LocalSession {
    id: string
    libraryItemId: string
    episodeId?: string | null
    displayTitle?: string
    duration?: number
    currentTime?: number
    timeListening?: number
    updatedAt?: number
  }

  const applyLocal = async (userId: string, s: LocalSession) => {
    const resolved = await resolveMediaItemId(ctx, s.libraryItemId, s.episodeId ?? null)
    if (!resolved) return { id: s.id, success: false, error: 'Media item not found' }
    const existing = ctx.progress.get(userId, s.libraryItemId, s.episodeId ?? null)
    // Like upstream: only apply when the local session is newer than what we have.
    if (existing && s.updatedAt && existing.lastUpdate > s.updatedAt) {
      return { id: s.id, success: true, progressSynced: false }
    }
    const duration = s.duration || existing?.duration || 0
    const mp = ctx.progress.createUpdate(userId, resolved.serverKey, resolved.mediaItemId, {
      libraryItemId: s.libraryItemId,
      episodeId: s.episodeId ?? null,
      duration,
      currentTime: s.currentTime,
      progress: duration && s.currentTime !== undefined ? Math.max(0, Math.min(s.currentTime / duration, 1)) : undefined
    })
    ctx.socket.emitToUser(userId, 'user_item_progress_updated', { id: mp.id, sessionId: s.id, deviceDescription: 'local', data: mp })
    return { id: s.id, success: true, progressSynced: true }
  }

  r.post('/session/local', async (req, res) => {
    const s = req.body as LocalSession
    if (!s?.libraryItemId) return res.status(400).send('Invalid session')
    const result = await applyLocal(req.smUser.id, s)
    if (!result.success) return res.status(500).send(result.error)
    res.sendStatus(200)
  })

  r.post('/session/local-all', async (req, res) => {
    const sessions = ((req.body as { sessions?: LocalSession[] })?.sessions ?? []).filter((s) => s?.libraryItemId)
    const results = []
    for (const s of sessions) results.push(await applyLocal(req.smUser.id, s))
    res.json({ results })
  })

  // Home page shelves: upstream computes them for the service account, so the
  // progress-driven shelves are rebuilt from our store.
  r.get('/libraries/:id/personalized', async (req, res) => {
    const server = ctx.registry.resolvePath(req.path)
    const result = await server.forwardJson<Shelf[]>(req, pathWithQuery(req))
    if (result.status !== 200 || !Array.isArray(result.json)) return sendResult(res, result)
    ctx.registry.learn(server.key, result.json)

    const limit = Number(req.query.limit) || 10
    const shelves = result.json.filter((s) => !['continue-listening', 'continue-reading', 'listen-again', 'read-again'].includes(s.id))
    const rows = ctx.progress.rowsForUser(req.smUser.id)
    const items = await fetchItems(ctx, [...new Set(rows.map((mp) => mp.libraryItemId))])
    const inLibrary = (id: string) => items.get(id)?.libraryId === req.params.id

    const continueListening: unknown[] = []
    const continueReading: unknown[] = []
    const listenAgain: unknown[] = []
    for (const mp of rows) {
      if (!inLibrary(mp.libraryItemId) || mp.hideFromContinueListening) continue
      const li = items.get(mp.libraryItemId)!
      const entity = { ...li, progressLastUpdate: mp.updatedAt, userMediaProgress: ctx.progress.getById(req.smUser.id, mp.id) }
      if (mp.episodeId) {
        const ep = (li.media.podcastEpisodes as Array<Record<string, unknown>> | undefined)?.find((e) => e.id === mp.episodeId)
        if (!ep) continue
        Object.assign(entity, { recentEpisode: ep })
      }
      if (mp.isFinished) {
        if (mp.finishedAt && Date.now() - mp.finishedAt < 60 * 24 * 60 * 60 * 1000) listenAgain.push({ ...entity, finishedAt: mp.finishedAt })
      } else if (mp.currentTime > 0) continueListening.push(entity)
      else if (mp.ebookProgress > 0) continueReading.push(entity)
    }

    const mediaType = (items.values().next().value as LibraryItemJSON | undefined)?.mediaType ?? 'book'
    const type = mediaType === 'podcast' ? 'episode' : 'book'
    const out: Shelf[] = []
    if (continueListening.length) out.push({ id: 'continue-listening', label: 'Continue Listening', labelStringKey: 'LabelContinueListening', type, entities: continueListening.slice(0, limit), total: continueListening.length })
    if (continueReading.length) out.push({ id: 'continue-reading', label: 'Continue Reading', labelStringKey: 'LabelContinueReading', type: 'book', entities: continueReading.slice(0, limit), total: continueReading.length })
    out.push(...shelves)
    if (listenAgain.length) out.push({ id: 'listen-again', label: 'Listen Again', labelStringKey: 'LabelListenAgain', type, entities: listenAgain.slice(0, limit), total: listenAgain.length })
    sendResult(res, result, out)
  })

  return r
}
