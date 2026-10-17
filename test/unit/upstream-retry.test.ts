import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { UpstreamServer } from '../../src/upstream/server.js'

/**
 * A server that, like some proxies in front of Audiobookshelf, kills a pooled
 * keep-alive connection when a second request arrives on it.
 */
let server: http.Server
let url = ''
let served = 0
const hits = new Map<string, number>()
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const socket = req.socket as typeof req.socket & { requests?: number }
    socket.requests = (socket.requests ?? 0) + 1
    hits.set(req.url ?? '', (hits.get(req.url ?? '') ?? 0) + 1)
    if (socket.requests > 1) return socket.destroy()
    served++
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
  server.keepAliveTimeout = 60_000
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('upstream requests on a connection the server closed', () => {
  it('retries read-only requests on a fresh connection', async () => {
    const up = new UpstreamServer({ key: 'x', url, apiKey: 'k', label: 'X' })
    for (let i = 0; i < 4; i++) expect(await up.get<{ ok: boolean }>(`/api/libraries/lib/items?page=${i}`)).toMatchObject({ ok: true })
    // batch/get is a POST but only reads, so it is retried too
    expect(await up.post<{ ok: boolean }>('/api/items/batch/get', { libraryItemIds: ['a'] })).toMatchObject({ ok: true })
    expect(await up.post<{ ok: boolean }>('/api/items/batch/get', { libraryItemIds: ['b'] })).toMatchObject({ ok: true })
  })

  it('never sends a state-changing request twice', async () => {
    const up = new UpstreamServer({ key: 'y', url, apiKey: 'k', label: 'Y' })
    for (let i = 0; i < 3; i++) {
      await up.get('/api/me').catch(() => null) // leaves pooled connections behind
      await up.json(`/api/session/s${i}/sync`, { method: 'POST', body: { currentTime: i } }).catch(() => null)
      expect(hits.get(`/api/session/s${i}/sync`) ?? 0).toBeLessThanOrEqual(1)
    }
  })
})
