// @vitest-environment jsdom
/** Locate handoff ordering across the service seam. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ConversationController } from '../src/client/service.ts'

function controller(): ConversationController {
  const ctx = new Context()
  ctx.provide('sessions', {
    scopeOf: () => 's1',
    binding: () => ({ session: {} }),
  } as never)
  return new ConversationController(ctx as never, { input: {} as never, blocks: {} as never })
}

describe('locate handoff ordering', () => {
  it('holds a request until the mounted view takes it', async () => {
    const svc = controller()
    const writes: Array<{ seq: number; query?: string }> = []
    svc.bindLocate('s1' as never, (request) => { writes.push(request) })
    // The request is held, never written through a possibly-stale writer.
    svc.locate(42, '搜索词')
    expect(writes).toEqual([])
    // The mounted view pulls the held request into its own store instance.
    expect(svc.takePendingLocate('s1' as never)).toEqual({ seq: 42, query: '搜索词' })
    expect(writes).toEqual([])
    // A second take has nothing left.
    expect(svc.takePendingLocate('s1' as never)).toBeUndefined()
  })

  it('carries an absent query without the field', () => {
    const svc = controller()
    svc.locate(42)
    expect(svc.takePendingLocate('s1' as never)).toEqual({ seq: 42 })
  })

  it('replays a held request on the view bind', async () => {
    const svc = controller()
    svc.locate(42, 'q')
    const writes: Array<{ seq: number; query?: string }> = []
    svc.bindLocate('s1' as never, (request) => { writes.push(request) })
    // Deferred out of the render phase: the store write lands on a microtask
    // so the freshly-mounted chat view has subscribed before it fires.
    expect(writes).toEqual([])
    await Promise.resolve()
    expect(writes).toEqual([{ seq: 42, query: 'q' }])
  })

  it('does not replay the same held request to a later rebind', async () => {
    const svc = controller()
    svc.locate(42)
    const first: Array<{ seq: number }> = []
    svc.bindLocate('s1' as never, (request) => { first.push(request) })
    await Promise.resolve()
    expect(first).toEqual([{ seq: 42 }])
    const second: Array<{ seq: number }> = []
    svc.bindLocate('s1' as never, (request) => { second.push(request) })
    await Promise.resolve()
    expect(second).toEqual([])
  })

  it('routes each session request to its own slot', () => {
    const ctx = new Context()
    let scope = 's1'
    ctx.provide('sessions', { scopeOf: () => scope, binding: () => ({ session: {} }) } as never)
    const svc = new ConversationController(ctx as never, { input: {} as never, blocks: {} as never })
    svc.locate(1)
    scope = 's2'
    svc.locate(2)
    scope = 's1'
    expect(svc.takePendingLocate('s1' as never)).toEqual({ seq: 1 })
    scope = 's2'
    expect(svc.takePendingLocate('s2' as never)).toEqual({ seq: 2 })
  })

  it('notifies subscribers when a request lands', () => {
    const svc = controller()
    let notified = 0
    const dispose = svc.subscribePendingLocate(() => { notified += 1 })
    svc.locate(7)
    expect(notified).toBe(1)
    dispose()
    svc.locate(8)
    expect(notified).toBe(1)
  })
})
