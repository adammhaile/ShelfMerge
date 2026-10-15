import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { authRateLimit } from '../../src/auth/ratelimit.js'

/** Run the middleware once and simulate the route answering with `status`. */
function attempt(limiter: ReturnType<typeof authRateLimit>, ip: string, status: number): number {
  const req = { ip } as Request
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v
    },
    status(code: number) {
      this.statusCode = code
      return this
    },
    send() {
      return this
    }
  }) as unknown as Response & EventEmitter
  let passed = false
  limiter(req, res, () => {
    passed = true
  })
  if (!passed) return res.statusCode
  res.statusCode = status
  res.emit('finish')
  return status
}

describe('authRateLimit', () => {
  it('blocks after the allowed number of failures and only counts failures', () => {
    const limiter = authRateLimit({ max: 3, windowMs: 60_000 })
    for (let i = 0; i < 10; i++) expect(attempt(limiter, '1.1.1.1', 200)).toBe(200)
    expect(attempt(limiter, '1.1.1.1', 401)).toBe(401)
    expect(attempt(limiter, '1.1.1.1', 401)).toBe(401)
    expect(attempt(limiter, '1.1.1.1', 401)).toBe(401)
    expect(attempt(limiter, '1.1.1.1', 200)).toBe(429)
    // Other addresses are unaffected.
    expect(attempt(limiter, '2.2.2.2', 401)).toBe(401)
  })

  it('can be disabled', () => {
    const limiter = authRateLimit({ max: 0 })
    for (let i = 0; i < 5; i++) expect(attempt(limiter, '1.1.1.1', 401)).toBe(401)
  })
})
