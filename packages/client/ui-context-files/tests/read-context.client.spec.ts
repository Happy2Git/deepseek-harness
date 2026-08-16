/** The injected-document projection: context nodes become rows, the latest
 * compaction checkpoint shadows the rows at or before it, and paging flags
 * read from the snapshot. */
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { compactionBoundary, hasMoreDocs, loadOlderDocs, readInjectedDocs } from '../src/client/read-context.ts'

const S1 = 's1' as SessionId

/** One context node the projection reads (the chat fold's `ContextMessageNode`). */
function contextNode(seq: number, text: string) {
  return {
    kind: 'context' as const,
    seq,
    time: seq * 1_000,
    content: [{ type: 'text' as const, text }],
    provenance: { role: 'inject' as const, label: `producer-${seq}` },
    form: null,
  }
}

/** One compaction checkpoint node (the chat fold's `CompactionSummaryNode`). */
function compactionNode(seq: number) {
  return {
    kind: 'compaction' as const,
    seq,
    time: seq * 1_000,
    summary: null,
    summaryEventSeq: null,
    shadowedItemCount: null,
    shadowedTokenCount: null,
  }
}

/** One harness: a fake session face with the given legacy nodes, plus its snapshot facts. */
function harness(nodes: unknown[], over: { hasMore?: boolean } = {}) {
  const snapshot = {
    chat: { legacy: { nodes } },
    hasMore: over.hasMore ?? false,
  } as unknown as ConversationSnapshot
  const loadOlder = vi.fn(() => Promise.resolve())
  const face = { getSnapshot: () => snapshot, subscribe: () => () => {}, loadOlder }
  const binding = (id: SessionId) => id === S1 ? { session: face } : undefined
  const ctx = { sessions: { binding } } as unknown as ClientContext
  return { ctx, loadOlder }
}

describe('readInjectedDocs', () => {
  it('projects context nodes oldest-first with their provenance and text', () => {
    // The chat fold is log-ordered, so the projection reads it oldest-first.
    const { ctx } = harness([
      contextNode(1, '第一条注入。'),
      contextNode(2, '第二条注入。'),
    ])
    const docs = readInjectedDocs(ctx, S1)
    expect(docs.map(doc => doc.seq)).toEqual([1, 2])
    expect(docs[0]).toMatchObject({ label: 'producer-1', role: 'inject', text: '第一条注入。', active: true })
    expect(docs[1]).toMatchObject({ label: 'producer-2', text: '第二条注入。', active: true })
  })

  it('shadows documents at or before the latest compaction checkpoint', () => {
    const { ctx } = harness([
      contextNode(1, '最早。'),
      compactionNode(10),
      contextNode(12, '压缩后注入。'),
      compactionNode(20),
      contextNode(25, '最新。'),
    ])
    const docs = readInjectedDocs(ctx, S1)
    expect(docs.map(doc => [doc.seq, doc.active])).toEqual([
      [1, false],
      [12, false],
      [25, true],
    ])
  })

  it('skips non-context nodes and blank text, and answers empty without a binding', () => {
    const { ctx } = harness([
      contextNode(1, '   '),
      { kind: 'tool-result', seq: 2, time: 2_000, content: [] },
      contextNode(3, '有效。'),
    ])
    expect(readInjectedDocs(ctx, S1).map(doc => doc.seq)).toEqual([3])
    expect(readInjectedDocs(ctx, 'ghost' as SessionId)).toEqual([])
  })
})

describe('compactionBoundary', () => {
  it('returns the latest in-window checkpoint seq, or null when none is loaded', () => {
    const { ctx } = harness([compactionNode(10), compactionNode(20)])
    expect(compactionBoundary(ctx, S1)).toBe(20)
    expect(compactionBoundary(ctx, 'ghost' as SessionId)).toBeNull()
    const plain = harness([contextNode(1, 'x')])
    expect(compactionBoundary(plain.ctx, S1)).toBeNull()
  })
})

describe('hasMoreDocs and loadOlderDocs', () => {
  it('read the snapshot flag and delegate the page request to the session face', async () => {
    const { ctx, loadOlder } = harness([], { hasMore: true })
    expect(hasMoreDocs(ctx, S1)).toBe(true)
    expect(hasMoreDocs(ctx, 'ghost' as SessionId)).toBe(false)
    await loadOlderDocs(ctx, S1)
    expect(loadOlder).toHaveBeenCalledOnce()
    await loadOlderDocs(ctx, 'ghost' as SessionId)
    expect(loadOlder).toHaveBeenCalledOnce()
  })
})
