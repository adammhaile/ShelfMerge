import { Router, type Request, type Response } from 'express'
import type { Context } from '../context.js'
import { sendResult } from '../upstream/server.js'
import { resolveMediaItemId, fetchItems, type LibraryItemJSON } from './items-helpers.js'
import type { PlaybackSessionRow } from '../db.js'
import type { SessionSnapshot } from '../history.js'
import type { EditionSet } from '../index/editions.js'
import { formatDuration } from '../index/editions.js'
import { registerEditions } from './merged.js'
import { log } from '../logger.js'

interface SessionJSON extends SessionSnapshot {
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

interface SeriesRef {
  id: string
  name: string
  sequence: string | null
}

const pathWithQuery = (req: Request) => req.smPath
const b64 = (s: string) => encodeURIComponent(Buffer.from(s).toString('base64'))

/**
 * Item, playback, series and personalized routes: forwarded upstream, with
 * the service account's progress replaced by the ShelfMerge user's wherever
 * it leaks into a response.
 */
export function itemRoutes(ctx: Context): Router {
  const r = Router()

  /** Per-library auto-finish thresholds, from the upstream library settings. */
  const finishRules = (libraryId: string | null | undefined) => {
    const settings = (libraryId && (ctx.catalog.get(libraryId)?.settings as Record<string, unknown> | undefined)) || {}
    return {
      markAsFinishedTimeRemaining: typeof settings.markAsFinishedTimeRemaining === 'number' ? settings.markAsFinishedTimeRemaining : undefined,
      markAsFinishedPercentComplete: typeof settings.markAsFinishedPercentComplete === 'number' ? settings.markAsFinishedPercentComplete : undefined
    }
  }

  /**
   * When the user is browsing a merged library that contains this item's
   * source library, present the item as the merged library's so the web
   * client stays where it is.
   */
  const presentedLibraryId = (userId: string, sourceLibraryId: string | undefined): string | undefined => {
    const last = ctx.lastLibrary.get(userId)
    if (!last || !sourceLibraryId) return undefined
    const lib = ctx.catalog.get(last)
    return lib?.merged && lib.sources?.some((s) => s.libraryId === sourceLibraryId) ? lib.id : undefined
  }

  /**
   * The edition set an item belongs to: in the merged library the user is
   * browsing if that applies, else in any accessible merged library that
   * contains the item's source library (a reload on an item page fetches
   * the item before the client re-selects its library).
   */
  const editionSetFor = (req: Request, itemId: string, sourceLibraryId?: string | null): { set: EditionSet; mergedId: string } | null => {
    const userId = req.smUser.id
    const source = sourceLibraryId ?? ctx.registry.lookup(itemId)?.libraryId
    const last = ctx.lastLibrary.get(userId)
    const candidates = ctx.catalog.forUser(ctx.users.config(req.smUser)).filter((l) => l.merged && l.editions?.collapseEditions && (!source || l.sources!.some((s) => s.libraryId === source)))
    candidates.sort((a, b) => (a.id === last ? -1 : b.id === last ? 1 : 0))
    for (const lib of candidates) {
      registerEditions(ctx, lib)
      const set = ctx.indexQuery.editionSetOf(lib.sources!.map((s) => s.libraryId), itemId)
      if (set) return { set, mergedId: lib.id }
    }
    return null
  }

  /**
   * The stock clients have no edition picker, but they render the
   * description as HTML, so the other editions are listed there with links
   * to their own item pages.
   */
  const editionsBlock = (set: EditionSet, itemId: string): string => {
    const label = (key: string) => ctx.registry.server(key)?.label ?? key
    const describe = (m: EditionSet['members'][number]) => [label(m.serverKey), m.narratorName ? `narrated by ${m.narratorName}` : null, formatDuration(m.duration)].filter(Boolean).join(', ')
    const me = set.members.find((m) => m.id === itemId)
    const others = set.members.filter((m) => m.id !== itemId)
    // Unprefixed path: the mobile apps route /item/:id at their root and do not
    // intercept description links, while the web client's router accepts the
    // path with or without its /audiobookshelf base on a fresh page load.
    const lines = others.map((m) => `<li><a href="/item/${m.id}">${describe(m)}</a>${m.id === set.preferred ? ' (shown in library)' : ''}</li>`)
    const current = me ? `<p><strong>This edition:</strong> ${describe(me)}${me.id === set.preferred ? ' (shown in library)' : ''}</p>` : ''
    return `${current}<p><strong>Other editions</strong></p><ul>${lines.join('')}</ul>`
  }

  // Item detail: inject our progress when the client asked for it.
  r.get('/items/:id', async (req, res) => {
    const server = ctx.accounts.upstream(req.smUser, await ctx.registry.resolvePathAsync(req.path))
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
    const presented = presentedLibraryId(req.smUser.id, result.json.libraryId)
    if (presented) result.json.libraryId = presented
    const ed = editionSetFor(req, req.params.id, ctx.registry.lookup(req.params.id)?.libraryId)
    if (ed) {
      const meta = result.json.media.metadata as { description?: string | null }
      meta.description = `${meta.description ?? ''}${meta.description ? '<br>' : ''}${editionsBlock(ed.set, req.params.id)}`
    }
    sendResult(res, result, result.json)
  })

  // Start playback: upstream creates the session under the service account;
  // we re-own it and seed the start position from our progress.
  const play = async (req: Request, res: Response) => {
    const server = ctx.accounts.upstream(req.smUser, await ctx.registry.resolvePathAsync(req.path))
    const result = await server.forwardJson<SessionJSON>(req, pathWithQuery(req))
    if (result.status !== 200 || !result.json) return sendResult(res, result)
    const session = result.json
    ctx.registry.learn(server.key, session)

    const episodeId = req.params.episodeId ?? null
    let mp = ctx.progress.get(req.smUser.id, req.params.id, episodeId)
    // First play of an edition: carry the position over from another edition
    // of the same book (by time when the lengths match, by fraction otherwise).
    if (!mp && !episodeId) {
      const ed = editionSetFor(req, req.params.id, ctx.registry.lookup(session.libraryItemId)?.libraryId)
      const me = ed?.set.members.find((m) => m.id === req.params.id)
      const other = ed?.set.members.map((m) => ({ m, mp: ctx.progress.get(req.smUser.id, m.id) })).find((o) => o.mp && o.m.id !== req.params.id)
      if (ed && me && other?.mp) {
        const sameLength = other.m.duration && me.duration && Math.abs(other.m.duration - me.duration) / other.m.duration <= 0.02
        const currentTime = other.mp.isFinished ? 0 : sameLength ? other.mp.currentTime : (other.mp.progress || 0) * me.duration
        mp = ctx.progress.createUpdate(req.smUser.id, server.key, String(session.bookId ?? session.libraryItem?.media?.id ?? ''), {
          libraryItemId: req.params.id,
          duration: me.duration,
          currentTime,
          progress: me.duration ? currentTime / me.duration : 0,
          isFinished: other.mp.isFinished,
          finishedAt: other.mp.finishedAt
        })
        log.info(`[editions] seeded progress for ${req.params.id.slice(0, 8)} from ${other.m.id.slice(0, 8)} (${sameLength ? 'same length' : 'by fraction'})`)
      }
    }
    let startTime = 0
    if (mp && !mp.isFinished) startTime = Number(mp.currentTime) || 0
    session.userId = req.smUser.id
    session.startTime = startTime
    session.currentTime = startTime
    if (session.libraryItem) {
      ;(session.libraryItem as { userMediaProgress?: unknown }).userMediaProgress = mp
    }
    const presented = presentedLibraryId(req.smUser.id, session.libraryId)
    if (presented) {
      session.libraryId = presented
      if (session.libraryItem) session.libraryItem.libraryId = presented
    }

    const mediaItemId = episodeId ?? session.bookId ?? session.libraryItem?.media?.id
    const { libraryItem: _li, ...snapshot } = session
    const row: PlaybackSessionRow = {
      id: session.id,
      serverKey: server.key,
      userId: req.smUser.id,
      libraryId: ctx.registry.lookup(session.libraryItemId)?.libraryId ?? session.libraryId ?? '',
      libraryItemId: session.libraryItemId,
      episodeId: episodeId ?? '',
      mediaItemId: String(mediaItemId ?? ''),
      mediaType: session.mediaType,
      duration: session.duration,
      displayTitle: session.displayTitle,
      deviceDescription: session.deviceInfo?.deviceDescription ?? '',
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      snapshot: JSON.stringify(snapshot)
    }
    ctx.sessions.upsert(row)
    log.info(`[play] "${req.smUser.username}" started "${session.displayTitle}" on ${server.key} (session ${session.id})`)
    sendResult(res, result, session)
  }
  r.post('/items/:id/play', play)
  r.post('/items/:id/play/:episodeId', play)

  // Sync: keep the upstream session alive, record progress and history for our user.
  const applySync = (userId: string, row: PlaybackSessionRow, body: SyncBody) => {
    if (body.timeListened) ctx.history.addListening(row, Number(body.timeListened), body.currentTime)
    if (body.currentTime === undefined) return null
    const duration = body.duration || row.duration || 0
    const mp = ctx.progress.createUpdate(userId, row.serverKey, row.mediaItemId, {
      libraryItemId: row.libraryItemId,
      episodeId: row.episodeId || null,
      duration,
      currentTime: body.currentTime,
      progress: duration ? Math.max(0, Math.min(body.currentTime / duration, 1)) : 0,
      ...finishRules(row.libraryId)
    })
    ctx.sessions.touch(row.id)
    ctx.socket.emitToUser(userId, 'user_item_progress_updated', { id: mp.id, sessionId: row.id, deviceDescription: row.deviceDescription, data: mp })
    return mp
  }

  const sessionServer = (req: Request, row: PlaybackSessionRow) => {
    const server = ctx.registry.server(row.serverKey)
    return server ? ctx.accounts.upstream(req.smUser, server) : undefined
  }

  const sessionOwner = (req: Request, res: Response): PlaybackSessionRow | null => {
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
    const server = sessionServer(req, row)
    if (!server) return res.sendStatus(404)
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
    const server = sessionServer(req, row)
    if (server) {
      const upstream = await server.json(`/api/session/${row.id}/sync`, { method: 'POST', body }).catch(() => null)
      // Upstream may have forgotten the session (restart, stale cleanup); progress still counts.
      if (upstream?.status === 404) log.warn(`[sync] upstream ${server.key} lost session ${row.id}`)
    }
    applySync(req.smUser.id, row, body)
    res.sendStatus(200)
  })

  r.post('/session/:id/close', async (req, res) => {
    const row = sessionOwner(req, res)
    if (!row) return
    const body = (req.body ?? {}) as SyncBody
    const server = sessionServer(req, row)
    if (server) await server.json(`/api/session/${row.id}/close`, { method: 'POST', body: Object.keys(body).length ? body : undefined }).catch(() => null)
    if (body.currentTime !== undefined) applySync(req.smUser.id, row, body)
    ctx.sessions.remove(row.id)
    ctx.socket.emitToUser(req.smUser.id, 'user_session_closed', row.id)
    res.sendStatus(200)
  })

  // Offline sessions uploaded by the mobile apps.
  interface LocalSession extends SessionSnapshot {
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
    ctx.history.upsertLocal(userId, resolved.serverKey, s, resolved.mediaItemId)
    const own = ctx.registry.server(resolved.serverKey)
    if (own && ctx.accounts.hasAccount({ username: ctx.users.byId(userId)?.username ?? '' }, resolved.serverKey)) {
      ctx.accounts.upstream({ username: ctx.users.byId(userId)!.username }, own).json('/api/session/local', { method: 'POST', body: s }).catch(() => null)
    }
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
      progress: duration && s.currentTime !== undefined ? Math.max(0, Math.min(s.currentTime / duration, 1)) : undefined,
      ...finishRules(s.libraryId ?? ctx.registry.lookup(s.libraryItemId)?.libraryId)
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

  // Series detail with ?include=progress: upstream lists the series' items;
  // which of them are finished is ours to answer.
  const seriesWithProgress = async (req: Request, res: Response) => {
    const server = ctx.accounts.upstream(req.smUser, await ctx.registry.resolvePathAsync(req.path))
    const result = await server.forwardJson<{ progress?: { libraryItemIds: string[]; libraryItemIdsFinished: string[]; isFinished: boolean } }>(req, pathWithQuery(req))
    if (result.status !== 200 || !result.json) return sendResult(res, result)
    ctx.registry.learn(server.key, result.json)
    if (result.json.progress) {
      const ids = result.json.progress.libraryItemIds
      const finished = ids.filter((id) => ctx.progress.get(req.smUser.id, id)?.isFinished)
      result.json.progress = { libraryItemIds: ids, libraryItemIdsFinished: finished, isFinished: ids.length > 0 && finished.length >= ids.length }
    }
    sendResult(res, result, result.json)
  }
  r.get('/libraries/:id/series/:seriesId', seriesWithProgress)
  r.get('/series/:id', seriesWithProgress)

  /**
   * "Continue Series": series (not hidden by the user) with at least one
   * finished book, at least one unfinished book and nothing in progress; the
   * entity is the first unfinished book by sequence. Mirrors
   * libraryItemsBookFilters.getContinueSeriesLibraryItems.
   */
  const continueSeries = async (userId: string, libraryId: string, serverKey: string, finishedItems: LibraryItemJSON[], limit: number): Promise<unknown[]> => {
    const server = ctx.registry.server(serverKey)
    if (!server) return []
    const hidden = new Set(ctx.users.seriesHidden(userId))
    const onlyLater = !!(ctx.catalog.get(libraryId)?.settings as { onlyShowLaterBooksInContinueSeries?: boolean } | undefined)?.onlyShowLaterBooksInContinueSeries
    const seriesIds = new Map<string, number>() // id -> most recent progress update in that series
    for (const li of finishedItems) {
      for (const s of ((li.media.metadata as { series?: SeriesRef[] })?.series ?? []) as SeriesRef[]) {
        if (hidden.has(s.id)) continue
        const mp = ctx.progress.get(userId, li.id)
        seriesIds.set(s.id, Math.max(seriesIds.get(s.id) ?? 0, mp?.lastUpdate ?? 0))
      }
    }
    const out: Array<{ entity: unknown; recent: number }> = []
    for (const [seriesId, recent] of seriesIds) {
      let books: LibraryItemJSON[]
      try {
        const r = await server.get<{ results: LibraryItemJSON[] }>(`/api/libraries/${libraryId}/items?filter=series.${b64(seriesId)}&sort=sequence&limit=0&minified=1`)
        books = r.results ?? []
      } catch {
        continue
      }
      const seq = (li: LibraryItemJSON) => parseFloat(String((li.media.metadata as { series?: { sequence?: string } })?.series?.sequence ?? '')) || null
      const progress = books.map((li) => ({ li, mp: ctx.progress.get(userId, li.id), seq: seq(li) }))
      if (progress.some((p) => p.mp && !p.mp.isFinished && p.mp.currentTime > 0)) continue
      const finished = progress.filter((p) => p.mp?.isFinished)
      if (!finished.length) continue
      const maxSeq = Math.max(...finished.map((p) => p.seq ?? -Infinity))
      const next = progress.find((p) => !p.mp?.isFinished && (!onlyLater || (p.seq ?? Infinity) > maxSeq))
      if (!next) continue
      out.push({ entity: { ...next.li, prevBookInProgress: false }, recent })
    }
    return out
      .sort((a, b) => b.recent - a.recent)
      .slice(0, limit)
      .map((o) => o.entity)
  }

  // Home page shelves: upstream computes them for the service account, so the
  // progress-driven shelves are rebuilt from our store.
  r.get('/libraries/:id/personalized', async (req, res) => {
    const server = ctx.accounts.upstream(req.smUser, ctx.registry.resolvePath(req.path))
    const result = await server.forwardJson<Shelf[]>(req, pathWithQuery(req))
    if (result.status !== 200 || !Array.isArray(result.json)) return sendResult(res, result)
    ctx.registry.learn(server.key, result.json)

    const limit = Number(req.query.limit) || 10
    const shelves = result.json.filter((s) => !['continue-listening', 'continue-reading', 'continue-series', 'listen-again', 'read-again'].includes(s.id))
    const rows = ctx.progress.rowsForUser(req.smUser.id)
    const items = await fetchItems(ctx, [...new Set(rows.map((mp) => mp.libraryItemId))])
    const inLibrary = (id: string) => items.get(id)?.libraryId === req.params.id

    const continueListening: unknown[] = []
    const continueReading: unknown[] = []
    const listenAgain: unknown[] = []
    const finishedItems: LibraryItemJSON[] = []
    for (const mp of rows) {
      if (!inLibrary(mp.libraryItemId)) continue
      const li = items.get(mp.libraryItemId)!
      if (mp.isFinished && !mp.episodeId) finishedItems.push(li)
      if (mp.hideFromContinueListening) continue
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

    const mediaType = ctx.catalog.get(req.params.id)?.mediaType ?? 'book'
    const type = mediaType === 'podcast' ? 'episode' : 'book'
    const out: Shelf[] = []
    if (continueListening.length) out.push({ id: 'continue-listening', label: 'Continue Listening', labelStringKey: 'LabelContinueListening', type, entities: continueListening.slice(0, limit), total: continueListening.length })
    if (continueReading.length) out.push({ id: 'continue-reading', label: 'Continue Reading', labelStringKey: 'LabelContinueReading', type: 'book', entities: continueReading.slice(0, limit), total: continueReading.length })
    if (mediaType === 'book' && finishedItems.length) {
      const cs = await continueSeries(req.smUser.id, req.params.id, server.key, finishedItems, limit)
      if (cs.length) out.push({ id: 'continue-series', label: 'Continue Series', labelStringKey: 'LabelContinueSeries', type: 'book', entities: cs, total: cs.length })
    }
    out.push(...shelves)
    if (listenAgain.length) out.push({ id: 'listen-again', label: 'Listen Again', labelStringKey: 'LabelListenAgain', type, entities: listenAgain.slice(0, limit), total: listenAgain.length })
    sendResult(res, result, out)
  })

  return r
}
