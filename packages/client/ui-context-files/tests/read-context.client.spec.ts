/** The injected-document projection: context nodes become rows, the latest
 * compaction checkpoint shadows the rows at or before it, and paging flags
 * read from the snapshot. */
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { compactionBoundary, foldDocEvents, hasMoreDocs, loadOlderDocs, mergeDocs, readInjectedDocs } from '../src/client/read-context.ts'

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

/** One raw wire event the fold reads. */
function docEvent(seq: number, source: unknown, text: string, surfaceOp?: { op: string }) {
  return {
    seq,
    time: seq * 1_000,
    ...surfaceOp === undefined ? {} : { surfaceOp },
    data: { source, content: [{ type: 'text' as const, text }] },
  }
}

describe('foldDocEvents', () => {
  it('folds non-user messages into documents with provenance and the page boundary', () => {
    const folded = foldDocEvents([
      docEvent(1, { kind: 'agent-instructions', form: 'instructions', changes: [{ path: 'AGENTS.md' }] }, '规则'),
      docEvent(2, { kind: 'user' }, '人类消息,不折叠'),
      docEvent(3, { kind: 'skill-invocation', name: 'skill-a', form: 'catalog' }, ''),
      docEvent(4, { kind: 'session-reference', references: [{ label: '旧会话' }], form: 'recall' }, '回忆'),
      docEvent(5, { kind: 'plugin', plugin: 'compact', compactionId: 'c-1' }, '', { op: 'replace' }),
      docEvent(6, { kind: 'plugin', plugin: 'dsh-goal', form: 'notice' }, '目标'),
    ])
    expect(folded.boundary).toBe(5)
    expect(folded.docs.map(doc => [doc.seq, doc.label, doc.role, doc.form, doc.active])).toEqual([
      [1, 'AGENTS.md', 'inject', 'instructions', false],
      [4, '旧会话', 'recall', 'recall', false],
      [6, 'dsh-goal', 'inject', 'notice', true],
    ])
  })

  it('keeps every document active when the page holds no checkpoint', () => {
    const folded = foldDocEvents([docEvent(1, { kind: 'plugin', plugin: 'x' }, '内容')])
    expect(folded.boundary).toBe(-1)
    expect(folded.docs[0]?.active).toBe(true)
  })
})

describe('mergeDocs', () => {
  it('dedups by seq with the live fold winning, sorts, and re-derives active', () => {
    const older = [
      { seq: 1, time: 1_000, role: 'inject' as const, label: 'old', form: null, text: '旧', active: false },
      { seq: 2, time: 2_000, role: 'inject' as const, label: 'dup', form: null, text: '旧副本', active: false },
    ]
    const live = [
      { seq: 2, time: 2_000, role: 'inject' as const, label: 'dup-live', form: 'notice' as const, text: '权威副本', active: true },
      { seq: 3, time: 3_000, role: 'inject' as const, label: 'new', form: null, text: '新', active: true },
    ]
    const merged = mergeDocs(older, live, 2)
    expect(merged.map(doc => [doc.seq, doc.label, doc.active])).toEqual([
      [1, 'old', false],
      [2, 'dup-live', false],
      [3, 'new', true],
    ])
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
