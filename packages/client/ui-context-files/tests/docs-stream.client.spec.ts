// @vitest-environment jsdom
/** The docs-stream observable: follows the current session's conversation
 * snapshot across session switches, publishes on stream moves, and tears down
 * with its last listener. */
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext, ConversationSnapshot, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { docsStreamFor } from '../src/client/docs-stream.ts'

/** A minimal pushable observable source over one value. */
function observableOf<T>(initial: T): {
  getSnapshot: () => T
  subscribe: (fn: () => void) => () => void
  set: (next: T) => void
} {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    set: (next) => {
      value = next
      for (const fn of [...listeners]) fn()
    },
  }
}

const S1 = 's1' as SessionId
const S2 = 's2' as SessionId
const SNAP_A = { sessionId: S1 } as unknown as ConversationSnapshot
const SNAP_A2 = { sessionId: S1 } as unknown as ConversationSnapshot

function listState(current: SessionId): SessionListState {
  return {
    ids: [S1, S2], byId: {}, current, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
}

/** One harness: a list source, two session faces, and a binding lookup. */
function harness() {
  const list = observableOf<SessionListState>(listState(S1))
  const faceA = observableOf<ConversationSnapshot>(SNAP_A)
  const faceB = observableOf<ConversationSnapshot>({ sessionId: S2 } as unknown as ConversationSnapshot)
  const binding = (id: SessionId) => {
    if (id === S1) return { session: faceA }
    if (id === S2) return { session: faceB }
    return undefined
  }
  const ctx = { sessions: { list, binding } } as unknown as ClientContext
  return { ctx, list, faceA, faceB }
}

describe('docsStreamFor', () => {
  it('publishes the current session snapshot on first subscribe and re-publishes on stream moves', () => {
    const { ctx, faceA } = harness()
    const stream = docsStreamFor(ctx)
    const listener = vi.fn()
    const unsub = stream.subscribe(listener)
    expect(stream.getSnapshot()).toEqual({ sessionId: S1, snapshot: SNAP_A })
    expect(listener).not.toHaveBeenCalled()
    // The session stream moves: one publish with the new reference.
    faceA.set(SNAP_A2)
    expect(stream.getSnapshot()).toEqual({ sessionId: S1, snapshot: SNAP_A2 })
    expect(listener).toHaveBeenCalledTimes(1)
    // The snapshot reference is stable between changes.
    expect(stream.getSnapshot()).toBe(stream.getSnapshot())
    unsub()
  })

  it('a list notification that changes nothing publishes nothing', () => {
    const { ctx, list } = harness()
    const stream = docsStreamFor(ctx)
    const listener = vi.fn()
    stream.subscribe(listener)
    list.set(listState(S1))
    expect(listener).not.toHaveBeenCalled()
    expect(stream.getSnapshot()).toEqual({ sessionId: S1, snapshot: SNAP_A })
  })

  it('follows the current session across selection changes, unsubscribing the departed face', () => {
    const { ctx, list, faceA, faceB } = harness()
    const stream = docsStreamFor(ctx)
    const listener = vi.fn()
    stream.subscribe(listener)
    list.set(listState(S2))
    expect(stream.getSnapshot()).toEqual({ sessionId: S2, snapshot: faceB.getSnapshot() })
    expect(listener).toHaveBeenCalledTimes(1)
    // The departed session's stream no longer publishes.
    faceA.set(SNAP_A2)
    expect(listener).toHaveBeenCalledTimes(1)
    // The followed session's stream still does.
    const SNAP_B2 = { sessionId: S2 } as unknown as ConversationSnapshot
    faceB.set(SNAP_B2)
    expect(stream.getSnapshot()).toEqual({ sessionId: S2, snapshot: SNAP_B2 })
    expect(listener).toHaveBeenCalledTimes(2)
    // A session with no binding publishes the empty snapshot.
    const S3 = 's3' as SessionId
    list.set(listState(S3))
    expect(stream.getSnapshot()).toEqual({ sessionId: S3, snapshot: undefined })
  })

  it('tears down with the last listener and resets the value', () => {
    const { ctx, faceA } = harness()
    const stream = docsStreamFor(ctx)
    const unsub = stream.subscribe(vi.fn())
    expect(stream.getSnapshot().sessionId).toBe(S1)
    unsub()
    expect(stream.getSnapshot()).toEqual({ sessionId: undefined, snapshot: undefined })
    // After teardown the departed face no longer publishes anywhere.
    faceA.set(SNAP_A2)
    expect(stream.getSnapshot()).toEqual({ sessionId: undefined, snapshot: undefined })
    // A fresh subscribe follows the current session again.
    stream.subscribe(vi.fn())
    expect(stream.getSnapshot()).toEqual({ sessionId: S1, snapshot: faceA.getSnapshot() })
  })
})
