// @vitest-environment jsdom
/** The docs-stream observable: follows the current session's injected-document
 * signature, publishes only when the fold actually moves, and tears down with
 * its last listener. */
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext, ConversationSnapshot, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { docsStreamFor } from '../src/client/docs-stream.ts'

const S1 = 's1' as SessionId
const S2 = 's2' as SessionId

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

/** One context node the fold projects. */
function contextNode(seq: number): unknown {
  return {
    kind: 'context' as const,
    seq,
    time: seq * 1_000,
    content: [{ type: 'text' as const, text: `doc-${seq}` }],
    provenance: { role: 'inject' as const, label: `doc-${seq}` },
    form: null,
  }
}

/** The fold signature for the given context-node seqs. */
function signatureOf(seqs: readonly number[]): string {
  return seqs.map(seq => `${seq}:1`).join(',')
}

function listState(current: SessionId): SessionListState {
  return {
    ids: [S1, S2], byId: {}, current, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  } as SessionListState
}

/** One harness: a list source, two session faces with foldable nodes, and a binding lookup. */
function harness() {
  const list = observableOf<SessionListState>(listState(S1))
  const faceA = observableOf<ConversationSnapshot>(
    { chat: { legacy: { nodes: [contextNode(1)] } } } as unknown as ConversationSnapshot)
  const faceB = observableOf<ConversationSnapshot>(
    { chat: { legacy: { nodes: [contextNode(9)] } } } as unknown as ConversationSnapshot)
  const binding = (id: SessionId) => {
    if (id === S1) return { session: faceA }
    if (id === S2) return { session: faceB }
    return undefined
  }
  const ctx = { sessions: { list, binding } } as unknown as ClientContext
  return { ctx, list, faceA, faceB }
}

describe('docsStreamFor', () => {
  it('publishes the fold signature on first subscribe and re-publishes only when the fold moves', () => {
    const { ctx, faceA } = harness()
    const stream = docsStreamFor(ctx)
    const listener = vi.fn()
    const unsub = stream.subscribe(listener)
    expect(stream.getSnapshot()).toEqual({ sessionId: S1, signature: signatureOf([1]) })
    expect(listener).not.toHaveBeenCalled()
    // A new document lands: one publish with the new signature.
    faceA.set({ chat: { legacy: { nodes: [contextNode(1), contextNode(2)] } } } as unknown as ConversationSnapshot)
    expect(stream.getSnapshot()).toEqual({ sessionId: S1, signature: signatureOf([1, 2]) })
    expect(listener).toHaveBeenCalledTimes(1)
    // Ordinary stream batches (same fold) publish nothing.
    faceA.set({ chat: { legacy: { nodes: [contextNode(1), contextNode(2)] } } } as unknown as ConversationSnapshot)
    expect(listener).toHaveBeenCalledTimes(1)
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
    expect(stream.getSnapshot()).toEqual({ sessionId: S1, signature: signatureOf([1]) })
  })

  it('follows the current session across selection changes, unsubscribing the departed face', () => {
    const { ctx, list, faceA, faceB } = harness()
    const stream = docsStreamFor(ctx)
    const listener = vi.fn()
    stream.subscribe(listener)
    list.set(listState(S2))
    expect(stream.getSnapshot()).toEqual({ sessionId: S2, signature: signatureOf([9]) })
    expect(listener).toHaveBeenCalledTimes(1)
    // The departed session's stream no longer publishes.
    faceA.set({ chat: { legacy: { nodes: [contextNode(1), contextNode(2)] } } } as unknown as ConversationSnapshot)
    expect(listener).toHaveBeenCalledTimes(1)
    // The followed session's stream still does.
    faceB.set({ chat: { legacy: { nodes: [contextNode(9), contextNode(10)] } } } as unknown as ConversationSnapshot)
    expect(stream.getSnapshot()).toEqual({ sessionId: S2, signature: signatureOf([9, 10]) })
    expect(listener).toHaveBeenCalledTimes(2)
    // A session with no binding publishes the empty signature.
    const S3 = 's3' as SessionId
    list.set(listState(S3))
    expect(stream.getSnapshot()).toEqual({ sessionId: S3, signature: null })
  })

  it('tears down with the last listener and resets the value', () => {
    const { ctx, faceA } = harness()
    const stream = docsStreamFor(ctx)
    const unsub = stream.subscribe(vi.fn())
    expect(stream.getSnapshot().sessionId).toBe(S1)
    unsub()
    expect(stream.getSnapshot()).toEqual({ sessionId: undefined, signature: null })
    // After teardown the departed face no longer publishes anywhere.
    faceA.set({ chat: { legacy: { nodes: [contextNode(1), contextNode(2)] } } } as unknown as ConversationSnapshot)
    expect(stream.getSnapshot()).toEqual({ sessionId: undefined, signature: null })
    // A fresh subscribe follows the current session again.
    stream.subscribe(vi.fn())
    expect(stream.getSnapshot()).toEqual({ sessionId: S1, signature: signatureOf([1, 2]) })
  })
})
