import { describe, it, expect } from 'vitest'
import { openDb } from '../../src/db.js'
import { ProgressStore } from '../../src/progress.js'

const make = () => new ProgressStore(openDb(':memory:'))

describe('ProgressStore.createUpdate', () => {
  it('creates and updates a row, computing progress from the payload', () => {
    const p = make()
    const first = p.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', duration: 1000, currentTime: 100, progress: 0.1 })
    expect(first.currentTime).toBe(100)
    expect(first.isFinished).toBe(false)
    const second = p.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', currentTime: 500, progress: 0.5 })
    expect(second.id).toBe(first.id)
    expect(second.currentTime).toBe(500)
    expect(p.allForUser('u')).toHaveLength(1)
  })

  it('marks finished when less than the time-remaining threshold is left', () => {
    const p = make()
    p.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', duration: 1000, currentTime: 100 })
    const r = p.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', currentTime: 995 })
    expect(r.isFinished).toBe(true)
    expect(r.progress).toBe(1)
    expect(r.finishedAt).not.toBeNull()
  })

  it('uses the percent-complete threshold when the library sets one', () => {
    const p = make()
    p.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', duration: 1000, currentTime: 100, progress: 0.1 })
    const r = p.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', currentTime: 960, progress: 0.96, markAsFinishedPercentComplete: 95 })
    expect(r.isFinished).toBe(true)
    const q = make()
    q.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', duration: 1000, currentTime: 100, progress: 0.1 })
    expect(q.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', currentTime: 960, progress: 0.96, markAsFinishedPercentComplete: 99 }).isFinished).toBe(false)
  })

  it('un-finishes when the position moves back, and resets on explicit unfinish', () => {
    const p = make()
    p.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', duration: 1000, currentTime: 100 })
    p.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', currentTime: 998 })
    expect(p.get('u', 'li1')?.isFinished).toBe(true)
    const back = p.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', currentTime: 400, progress: 0.4 })
    expect(back.isFinished).toBe(false)
    p.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', isFinished: true })
    const reset = p.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', isFinished: false, currentTime: 777 })
    // Upstream semantics: unfinishing discards the position sent with it.
    expect(reset.currentTime).toBe(0)
    expect(reset.progress).toBe(0)
  })

  it('un-hides from continue listening when the position changes', () => {
    const p = make()
    p.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', duration: 1000, currentTime: 100 })
    p.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', hideFromContinueListening: true })
    expect(p.get('u', 'li1')?.hideFromContinueListening).toBe(true)
    expect(p.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', currentTime: 200 }).hideFromContinueListening).toBe(false)
  })

  it('keeps podcast episodes apart from the item and from each other', () => {
    const p = make()
    p.createUpdate('u', 'a', 'ep1', { libraryItemId: 'pod', episodeId: 'ep1', duration: 100, currentTime: 10 })
    p.createUpdate('u', 'a', 'ep2', { libraryItemId: 'pod', episodeId: 'ep2', duration: 100, currentTime: 20 })
    expect(p.allForUser('u')).toHaveLength(2)
    expect(p.get('u', 'pod', 'ep2')?.currentTime).toBe(20)
    expect(p.get('u', 'pod')).toBeNull()
  })
})

describe('ProgressStore.importSnapshot', () => {
  it('applies an upstream snapshot verbatim, even an unfinish with a position', () => {
    const p = make()
    p.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', duration: 1000, currentTime: 100 })
    p.createUpdate('u', 'a', 'm1', { libraryItemId: 'li1', isFinished: true })
    const snap = p.importSnapshot('u', 'a', { id: 'x', userId: 'up', libraryItemId: 'li1', episodeId: null, mediaItemId: 'm1', mediaItemType: 'book', duration: 1000, progress: 0.777, currentTime: 777, isFinished: false, hideFromContinueListening: false, ebookLocation: null, ebookProgress: 0, lastUpdate: 123456, startedAt: 1, finishedAt: null })
    expect(snap.currentTime).toBe(777)
    expect(snap.isFinished).toBe(false)
    expect(snap.lastUpdate).toBe(123456)
    expect(p.allForUser('u')).toHaveLength(1)
  })
})
