import type { Context } from '../context.js'
import { log } from '../logger.js'

export type LibraryItemJSON = Record<string, unknown> & { id: string; libraryId: string; mediaType: string; media: Record<string, unknown> }

/**
 * Progress rows are keyed by upstream media id (book id or episode id), the
 * same way Audiobookshelf keys them. The registry usually knows it already
 * from an item that passed through; otherwise fetch the item once.
 */
export async function resolveMediaItemId(ctx: Context, libraryItemId: string, episodeId: string | null): Promise<{ serverKey: string; mediaItemId: string } | null> {
  if (episodeId) {
    const row = ctx.registry.lookup(libraryItemId)
    return { serverKey: row?.serverKey ?? ctx.registry.default.key, mediaItemId: episodeId }
  }
  const row = ctx.registry.lookup(libraryItemId)
  if (row?.mediaId) return { serverKey: row.serverKey, mediaItemId: row.mediaId }

  const server = row ? ctx.registry.server(row.serverKey) : undefined
  for (const candidate of server ? [server] : ctx.registry.all) {
    const r = await candidate.json<LibraryItemJSON>(`/api/items/${libraryItemId}`)
    if (r.status === 200 && r.json?.media && typeof r.json.media.id === 'string') {
      ctx.registry.learn(candidate.key, r.json)
      return { serverKey: candidate.key, mediaItemId: r.json.media.id }
    }
  }
  log.warn(`[items] could not resolve media id for ${libraryItemId}`)
  return null
}

/** Fetch expanded items by id, grouped per owning server. Unknown ids are skipped. */
export async function fetchItems(ctx: Context, ids: string[]): Promise<Map<string, LibraryItemJSON>> {
  const byServer = new Map<string, string[]>()
  for (const id of ids) {
    const key = ctx.registry.lookup(id)?.serverKey ?? ctx.registry.default.key
    byServer.set(key, [...(byServer.get(key) ?? []), id])
  }
  const out = new Map<string, LibraryItemJSON>()
  await Promise.all(
    [...byServer.entries()].map(async ([key, batch]) => {
      const server = ctx.registry.server(key)
      if (!server) return
      try {
        const r = await server.post<{ libraryItems: LibraryItemJSON[] }>('/api/items/batch/get', { libraryItemIds: batch })
        ctx.registry.learn(key, r)
        for (const li of r.libraryItems ?? []) out.set(li.id, li)
      } catch (err) {
        log.warn(`[items] batch get from ${key} failed:`, (err as Error).message)
      }
    })
  )
  return out
}
