import { Router, type Request, type Response } from 'express'
import type { Context } from '../context.js'
import type { CollectionRow, PlaylistRow } from '../db.js'
import { fetchItems, type LibraryItemJSON } from './items-helpers.js'
import type { PlaylistItemRef } from '../collections.js'
import { log } from '../logger.js'

const stripTags = (s: unknown) => (typeof s === 'string' ? s.replace(/<[^>]*>/g, '').trim() : '')

/**
 * Collections and playlists, served from ShelfMerge's own store in the
 * shapes of upstream's CollectionController and PlaylistController.
 */
export function collectionRoutes(ctx: Context): Router {
  const r = Router()

  const canAccessLibrary = (req: Request, libraryId: string) => ctx.catalog.canAccess(ctx.users.config(req.smUser), libraryId)

  // ---- Collections ----

  const expandCollection = async (c: CollectionRow, include: string[] = []): Promise<Record<string, unknown>> => {
    const ids = ctx.collections.collectionBooks(c.id)
    const items = await fetchItems(ctx, ids)
    const json: Record<string, unknown> = {
      id: c.id,
      libraryId: c.libraryId,
      name: c.name,
      description: c.description,
      books: ids.map((id) => items.get(id)).filter(Boolean),
      lastUpdate: c.updatedAt,
      createdAt: c.createdAt
    }
    if (include.includes('rssfeed')) json.rssFeed = null
    return json
  }

  const emitCollection = async (event: string, c: CollectionRow) => ctx.socket.broadcast(event, await expandCollection(c))

  const collectionFor = (req: Request, res: Response): CollectionRow | null => {
    const c = ctx.collections.collection(req.params.id)
    if (!c || !canAccessLibrary(req, c.libraryId)) {
      res.status(404).send('Collection not found')
      return null
    }
    return c
  }

  const validBooks = async (ids: unknown, libraryId: string): Promise<string[] | null> => {
    const list = (Array.isArray(ids) ? ids : []).filter((b): b is string => typeof b === 'string' && !!b)
    if (!list.length) return null
    const items = await fetchItems(ctx, list)
    const ok = list.filter((id) => items.get(id)?.libraryId === libraryId && items.get(id)?.mediaType === 'book')
    return ok.length === list.length ? ok : null
  }

  r.post('/collections', async (req, res) => {
    const body = (req.body ?? {}) as { name?: string; libraryId?: string; description?: string; books?: unknown }
    const name = stripTags(body.name)
    if (!name || !body.libraryId) return res.status(400).send('Invalid collection data')
    if (body.description && typeof body.description !== 'string') return res.status(400).send('Invalid collection description')
    if (!canAccessLibrary(req, body.libraryId)) return res.sendStatus(403)
    const books = await validBooks(body.books, body.libraryId)
    if (!books) return res.status(400).send('Invalid collection data. Invalid books')
    const c = ctx.collections.createCollection(body.libraryId, name, body.description || null, books)
    const json = await expandCollection(c)
    ctx.socket.broadcast('collection_added', json)
    res.json(json)
  })

  r.get('/collections', async (req, res) => {
    const all = ctx.collections.collections().filter((c) => canAccessLibrary(req, c.libraryId))
    res.json({ collections: await Promise.all(all.map((c) => expandCollection(c))) })
  })

  r.get('/libraries/:id/collections', async (req, res) => {
    const include = String(req.query.include ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
    const limit = Number(req.query.limit) || 0
    const page = Number(req.query.page) || 0
    let list = ctx.collections.collections(req.params.id)
    const total = list.length
    if (limit) list = list.slice(page * limit, (page + 1) * limit)
    res.json({ results: await Promise.all(list.map((c) => expandCollection(c, include))), total, limit: req.query.limit || 0, page: req.query.page || 0, sortBy: req.query.sort, sortDesc: req.query.desc === '1', filterBy: req.query.filter, minified: req.query.minified === '1', include: include.join(',') })
  })

  r.get('/collections/:id', async (req, res) => {
    const c = collectionFor(req, res)
    if (!c) return
    res.json(await expandCollection(c, String(req.query.include ?? '').split(',')))
  })

  r.patch('/collections/:id', async (req, res) => {
    const c = collectionFor(req, res)
    if (!c) return
    const body = (req.body ?? {}) as { name?: unknown; description?: unknown; books?: unknown }
    let updated = false
    const patch: { name?: string; description?: string | null } = {}
    if (body.description !== undefined && (typeof body.description === 'string' || body.description === null)) patch.description = body.description
    if (typeof body.name === 'string' && stripTags(body.name)) patch.name = stripTags(body.name)
    if (ctx.collections.updateCollection(c.id, patch)) updated = true
    if (Array.isArray(body.books) && body.books.length) {
      const current = ctx.collections.collectionBooks(c.id)
      const order = body.books.filter((b): b is string => typeof b === 'string')
      const reordered = [...current].sort((a, b) => order.indexOf(a) - order.indexOf(b))
      if (ctx.collections.setCollectionBooks(c.id, reordered)) updated = true
    }
    const fresh = ctx.collections.collection(c.id)!
    const json = await expandCollection(fresh)
    if (updated) ctx.socket.broadcast('collection_updated', json)
    res.json(json)
  })

  r.delete('/collections/:id', async (req, res) => {
    const c = collectionFor(req, res)
    if (!c) return
    const json = await expandCollection(c)
    ctx.collections.deleteCollection(c.id)
    ctx.socket.broadcast('collection_removed', json)
    res.sendStatus(200)
  })

  r.post('/collections/:id/book', async (req, res) => {
    const c = collectionFor(req, res)
    if (!c) return
    const id = (req.body as { id?: string })?.id
    if (!id) return res.status(400).send('Book not found')
    const item = (await fetchItems(ctx, [id])).get(id)
    if (!item) return res.status(404).send('Book not found')
    if (item.libraryId !== c.libraryId) return res.status(400).send('Book in different library')
    const books = ctx.collections.collectionBooks(c.id)
    if (books.includes(id)) return res.status(400).send('Book already in collection')
    ctx.collections.setCollectionBooks(c.id, [...books, id])
    await emitCollection('collection_updated', ctx.collections.collection(c.id)!)
    res.json(await expandCollection(ctx.collections.collection(c.id)!))
  })

  // :bookId is a library item id, as in upstream.
  r.delete('/collections/:id/book/:bookId', async (req, res) => {
    const c = collectionFor(req, res)
    if (!c) return
    const books = ctx.collections.collectionBooks(c.id)
    if (books.includes(req.params.bookId)) {
      ctx.collections.setCollectionBooks(
        c.id,
        books.filter((b) => b !== req.params.bookId)
      )
      await emitCollection('collection_updated', ctx.collections.collection(c.id)!)
    }
    res.json(await expandCollection(ctx.collections.collection(c.id)!))
  })

  r.post('/collections/:id/batch/add', async (req, res) => {
    const c = collectionFor(req, res)
    if (!c) return
    const ids = ((req.body as { books?: unknown })?.books as unknown[] | undefined)?.filter((b): b is string => typeof b === 'string' && !!b) ?? []
    if (!ids.length) return res.status(400).send('Invalid request body')
    const items = await fetchItems(ctx, ids)
    const valid = ids.filter((id) => items.get(id)?.libraryId === c.libraryId && items.get(id)?.mediaType === 'book')
    if (!valid.length) return res.status(400).send('Invalid request body. No valid books')
    const books = ctx.collections.collectionBooks(c.id)
    const toAdd = valid.filter((id) => !books.includes(id))
    if (toAdd.length) {
      ctx.collections.setCollectionBooks(c.id, [...books, ...toAdd])
      await emitCollection('collection_updated', ctx.collections.collection(c.id)!)
    }
    res.json(await expandCollection(ctx.collections.collection(c.id)!))
  })

  r.post('/collections/:id/batch/remove', async (req, res) => {
    const c = collectionFor(req, res)
    if (!c) return
    const ids = ((req.body as { books?: unknown })?.books as unknown[] | undefined)?.filter((b): b is string => typeof b === 'string' && !!b) ?? []
    if (!ids.length) return res.status(500).send('Invalid request body')
    const books = ctx.collections.collectionBooks(c.id)
    if (ctx.collections.setCollectionBooks(c.id, books.filter((b) => !ids.includes(b)))) await emitCollection('collection_updated', ctx.collections.collection(c.id)!)
    res.json(await expandCollection(ctx.collections.collection(c.id)!))
  })

  // ---- Playlists ----

  const expandPlaylist = async (p: PlaylistRow): Promise<Record<string, unknown>> => {
    const refs = ctx.collections.playlistItems(p.id)
    const items = await fetchItems(ctx, [...new Set(refs.map((r) => r.libraryItemId))])
    const expanded: unknown[] = []
    for (const ref of refs) {
      const li = items.get(ref.libraryItemId)
      if (!li) continue
      if (ref.episodeId) {
        const episodes = (li.media as { podcastEpisodes?: Array<Record<string, unknown>> }).podcastEpisodes ?? []
        const episode = episodes.find((e) => e.id === ref.episodeId)
        if (!episode) continue
        expanded.push({ episodeId: ref.episodeId, episode, libraryItemId: li.id, libraryItem: { ...li, media: { ...li.media, podcastEpisodes: undefined } } })
      } else {
        expanded.push({ libraryItemId: li.id, libraryItem: li })
      }
    }
    return { id: p.id, name: p.name, libraryId: p.libraryId, userId: p.userId, description: p.description, items: expanded, lastUpdate: p.updatedAt, createdAt: p.createdAt }
  }

  const playlistFor = (req: Request, res: Response): PlaylistRow | null => {
    const p = ctx.collections.playlist(req.params.id)
    if (!p) {
      res.status(404).send('Playlist not found')
      return null
    }
    if (p.userId !== req.smUser.id) {
      res.sendStatus(403)
      return null
    }
    if (!canAccessLibrary(req, p.libraryId)) {
      res.status(404).send('Playlist not found')
      return null
    }
    return p
  }

  const parseItems = (raw: unknown): PlaylistItemRef[] | null => {
    if (!Array.isArray(raw)) return null
    const out: PlaylistItemRef[] = []
    for (const i of raw as Array<{ libraryItemId?: unknown; episodeId?: unknown }>) {
      if (!i || typeof i.libraryItemId !== 'string' || (i.episodeId && typeof i.episodeId !== 'string')) return null
      out.push({ libraryItemId: i.libraryItemId, episodeId: (i.episodeId as string | undefined) || null })
    }
    return out
  }

  /** Items must exist, be in the playlist's library, and match its media type. */
  const validateItems = async (items: PlaylistItemRef[], libraryId: string): Promise<boolean> => {
    const fetched = await fetchItems(ctx, [...new Set(items.map((i) => i.libraryItemId))])
    for (const i of items) {
      const li = fetched.get(i.libraryItemId)
      if (!li || li.libraryId !== libraryId) return false
      if (i.episodeId) {
        if (li.mediaType !== 'podcast') return false
        const eps = (li.media as { podcastEpisodes?: Array<{ id: string }> }).podcastEpisodes ?? []
        if (!eps.some((e) => e.id === i.episodeId)) return false
      } else if (li.mediaType !== 'book') return false
    }
    return true
  }

  const finishPlaylistChange = async (p: PlaylistRow, res: Response, changed: boolean) => {
    const fresh = ctx.collections.playlist(p.id)
    if (!fresh) return res.sendStatus(404)
    const json = await expandPlaylist(fresh)
    if (changed) {
      if (!ctx.collections.playlistItems(p.id).length) {
        log.info(`[playlists] "${p.name}" has no more items, removing it`)
        ctx.collections.deletePlaylist(p.id)
        ctx.socket.emitToUser(p.userId, 'playlist_removed', json)
      } else ctx.socket.emitToUser(p.userId, 'playlist_updated', json)
    }
    res.json(json)
  }

  r.post('/playlists', async (req, res) => {
    const body = (req.body ?? {}) as { name?: unknown; libraryId?: string; description?: unknown; items?: unknown }
    const name = stripTags(body.name)
    if (!name || !body.libraryId) return res.status(400).send('Invalid playlist data')
    if (body.description && typeof body.description !== 'string') return res.status(400).send('Invalid playlist description')
    if (!canAccessLibrary(req, body.libraryId)) return res.sendStatus(403)
    const items = parseItems(body.items ?? [])
    if (!items) return res.status(400).send('Invalid playlist item')
    if (!(await validateItems(items, body.libraryId))) return res.status(400).send('Invalid playlist data. Invalid items')
    const p = ctx.collections.createPlaylist(req.smUser.id, body.libraryId, name, (body.description as string) || null, items)
    const json = await expandPlaylist(p)
    ctx.socket.emitToUser(p.userId, 'playlist_added', json)
    res.json(json)
  })

  r.get('/playlists', async (req, res) => {
    const list = ctx.collections.playlists(req.smUser.id).filter((p) => canAccessLibrary(req, p.libraryId))
    res.json({ playlists: await Promise.all(list.map(expandPlaylist)) })
  })

  r.get('/libraries/:id/playlists', async (req, res) => {
    const limit = Number(req.query.limit) || 0
    const page = Number(req.query.page) || 0
    let list = ctx.collections.playlists(req.smUser.id, req.params.id)
    const total = list.length
    if (limit) list = list.slice(page * limit, (page + 1) * limit)
    res.json({ results: await Promise.all(list.map(expandPlaylist)), total, limit: req.query.limit || 0, page: req.query.page || 0 })
  })

  r.get('/playlists/:id', async (req, res) => {
    const p = playlistFor(req, res)
    if (!p) return
    res.json(await expandPlaylist(p))
  })

  r.patch('/playlists/:id', async (req, res) => {
    const p = playlistFor(req, res)
    if (!p) return
    const body = (req.body ?? {}) as { libraryId?: unknown; userId?: unknown; name?: unknown; description?: unknown; items?: unknown }
    if (body.libraryId || body.userId) return res.status(400).send('Invalid playlist data. Cannot update libraryId or userId')
    if (body.name && typeof body.name !== 'string') return res.status(400).send('Invalid playlist name')
    if (body.description && typeof body.description !== 'string') return res.status(400).send('Invalid playlist description')
    let changed = false
    const patch: { name?: string; description?: string } = {}
    if (stripTags(body.name)) patch.name = stripTags(body.name)
    if (body.description) patch.description = body.description as string
    if (ctx.collections.updatePlaylist(p.id, patch)) changed = true
    if (Array.isArray(body.items) && body.items.length) {
      const order = parseItems(body.items)
      if (!order) return res.status(400).send('Invalid playlist items')
      const current = ctx.collections.playlistItems(p.id)
      if (current.length !== order.length) return res.status(400).send('Invalid playlist items. Length mismatch')
      const key = (i: PlaylistItemRef) => `${i.libraryItemId}/${i.episodeId ?? ''}`
      const keys = order.map(key)
      const reordered = [...current].sort((a, b) => keys.indexOf(key(a)) - keys.indexOf(key(b)))
      if (ctx.collections.setPlaylistItems(p.id, reordered)) changed = true
    }
    const json = await expandPlaylist(ctx.collections.playlist(p.id)!)
    if (changed) ctx.socket.emitToUser(p.userId, 'playlist_updated', json)
    res.json(json)
  })

  r.delete('/playlists/:id', async (req, res) => {
    const p = playlistFor(req, res)
    if (!p) return
    const json = await expandPlaylist(p)
    ctx.collections.deletePlaylist(p.id)
    ctx.socket.emitToUser(p.userId, 'playlist_removed', json)
    res.sendStatus(200)
  })

  r.post('/playlists/:id/item', async (req, res) => {
    const p = playlistFor(req, res)
    if (!p) return
    const item = parseItems([req.body])?.[0]
    if (!item) return res.status(400).send('Request body has no libraryItemId')
    if (!(await validateItems([item], p.libraryId))) return res.status(400).send('Invalid item to add for this library type')
    const current = ctx.collections.playlistItems(p.id)
    if (current.some((c) => c.libraryItemId === item.libraryItemId && (c.episodeId ?? null) === item.episodeId)) return res.status(400).send('Item already in playlist')
    ctx.collections.setPlaylistItems(p.id, [...current, item])
    await finishPlaylistChange(p, res, true)
  })

  r.delete('/playlists/:id/item/:libraryItemId/:episodeId?', async (req, res) => {
    const p = playlistFor(req, res)
    if (!p) return
    const current = ctx.collections.playlistItems(p.id)
    const remaining = current.filter((c) => !(c.libraryItemId === req.params.libraryItemId && (c.episodeId ?? null) === (req.params.episodeId ?? null)))
    if (remaining.length === current.length) return res.status(404).send('Media item not found in playlist')
    ctx.collections.setPlaylistItems(p.id, remaining)
    await finishPlaylistChange(p, res, true)
  })

  r.post('/playlists/:id/batch/add', async (req, res) => {
    const p = playlistFor(req, res)
    if (!p) return
    const items = parseItems((req.body as { items?: unknown })?.items)
    if (!items?.length) return res.status(400).send('Invalid request body items')
    if (!(await validateItems(items, p.libraryId))) return res.status(400).send('Invalid request body items')
    const current = ctx.collections.playlistItems(p.id)
    const key = (i: PlaylistItemRef) => `${i.libraryItemId}/${i.episodeId ?? ''}`
    const have = new Set(current.map(key))
    const toAdd = items.filter((i) => !have.has(key(i)))
    const changed = toAdd.length > 0 && ctx.collections.setPlaylistItems(p.id, [...current, ...toAdd])
    await finishPlaylistChange(p, res, changed)
  })

  r.post('/playlists/:id/batch/remove', async (req, res) => {
    const p = playlistFor(req, res)
    if (!p) return
    const items = parseItems((req.body as { items?: unknown })?.items)
    if (!items?.length) return res.status(400).send('Invalid request body items')
    const key = (i: PlaylistItemRef) => `${i.libraryItemId}/${i.episodeId ?? ''}`
    const drop = new Set(items.map(key))
    const current = ctx.collections.playlistItems(p.id)
    const remaining = current.filter((c) => !drop.has(key(c)))
    const changed = remaining.length !== current.length && ctx.collections.setPlaylistItems(p.id, remaining)
    await finishPlaylistChange(p, res, changed)
  })

  r.post('/playlists/collection/:collectionId', async (req, res) => {
    const c = ctx.collections.collection(req.params.collectionId)
    if (!c || !canAccessLibrary(req, c.libraryId)) return res.status(404).send('Collection not found')
    const books = ctx.collections.collectionBooks(c.id)
    if (!books.length) return res.status(400).send('Collection has no books')
    const p = ctx.collections.createPlaylist(
      req.smUser.id,
      c.libraryId,
      c.name,
      c.description,
      books.map((b) => ({ libraryItemId: b, episodeId: null }))
    )
    const json = await expandPlaylist(p)
    ctx.socket.emitToUser(p.userId, 'playlist_added', json)
    res.json(json)
  })

  return r
}

export type { LibraryItemJSON }
