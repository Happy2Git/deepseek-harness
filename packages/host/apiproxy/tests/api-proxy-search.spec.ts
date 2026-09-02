/**
 * Host session.search projection: list-equivalent visibility, fixed message
 * filters and result bound, cancellation mapping, and unavailable/failure
 * behavior.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { stat } from 'node:fs/promises'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import {
  SessionQueryError,
  type SessionSearchHit,
  type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: vi.fn(actual.stat) }
})

const sid = (value: string): SessionId => value as SessionId
const defaults = { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }

function request(query: string): RpcRequest<{ query: string }> {
  return { rpcId: RpcId(`search-${query}`), payload: { query } }
}

function header(id: string, cwd: string | null = '/project'): SessionHeader {
  return {
    version: 0,
    id: sid(id),
    createdAt: 100,
    ...(cwd === null ? {} : { cwd }),
  }
}

function hit(id: string, index = 0): SessionSearchHit {
  const session = header(id)
  return {
    header: session,
    live: true,
    persisted: false,
    bestMatch: {
      sessionId: session.id,
      seq: index,
      type: 'user/message',
      time: 200 + index,
      surface: 'current',
      snippet: `match ${index}`,
    },
  }
}

async function baseContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  return ctx
}

describe('session.search', () => {
  it('searches only list-visible ids and current conversation-message events', async () => {
    const ctx = await baseContext()
    const live = ctx.sessions.create(sid('live'), { meta: header('live', '/live') })
    live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'live text' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const cold = header('cold', '/cold')
    const legacy = header('legacy', null)
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([cold, legacy]),
      locate: () => undefined,
    } as never)

    const searchSessions = vi.fn((
      _request: SessionSearchRequest,
      _exec?: { signal?: AbortSignal },
    ) => Promise.resolve({
      items: [
        {
          header: legacy,
          live: false,
          persisted: true,
          bestMatch: {
            sessionId: legacy.id,
            seq: 3,
            type: 'user/message' as const,
            time: 190,
            surface: 'current' as const,
            snippet: 'must remain hidden',
          },
        },
        {
          header: cold,
          live: false,
          persisted: true,
          bestMatch: {
            sessionId: cold.id,
            seq: 4,
            type: 'assistant/message' as const,
            time: 200,
            surface: 'current' as const,
            snippet: 'the matching answer',
          },
        },
      ],
    }))
    ctx.provide('sessionQuery', { searchSessions } as never)
    const api = createApiProxy(ctx, defaults)
    const signal = new AbortController().signal

    const response = await api.sessions.search(request('matching answer'), signal)

    expect(response.result).toEqual({
      ok: true,
      value: {
        items: [{ sessionId: 'cold', snippet: 'the matching answer', seq: 4 }],
        hasMore: false,
      },
    })
    expect(searchSessions).toHaveBeenCalledOnce()
    const [query, exec] = searchSessions.mock.calls[0] as unknown as [
      SessionSearchRequest,
      { signal: AbortSignal },
    ]
    expect(query).toEqual({
      query: 'matching answer',
      eventFilters: [
        {
          kind: 'type',
          values: ['user/message', 'assistant/message'],
        },
        { kind: 'surface', values: ['current'] },
      ],
      limit: 20,
    })
    expect(exec.signal).toBe(signal)
  })

  it('returns an empty page without invoking the index when no session is visible', async () => {
    const ctx = await baseContext()
    const searchSessions = vi.fn()
    ctx.provide('sessionQuery', { searchSessions } as never)
    const api = createApiProxy(ctx, defaults)

    const response = await api.sessions.search(
      request('anything'),
      new AbortController().signal,
    )

    expect(response.result).toEqual({
      ok: true,
      value: { items: [], hasMore: false },
    })
    expect(searchSessions).not.toHaveBeenCalled()
  })

  it('rejects snippets whose recorded provider violates the Host filters', async () => {
    const ctx = await baseContext()
    const visible = hit('visible')
    ctx.sessions.create(visible.header.id, { meta: visible.header })
    const withBestMatch = (
      index: number,
      bestMatch: Partial<SessionSearchHit['bestMatch']>,
    ): SessionSearchHit => {
      const base = hit('visible', index)
      return { ...base, bestMatch: { ...base.bestMatch, ...bestMatch } }
    }
    ctx.provide('sessionQuery', {
      searchSessions: () => Promise.resolve({
        items: [
          withBestMatch(0, { sessionId: sid('hidden') }),
          withBestMatch(1, { surface: 'shadowed' }),
          withBestMatch(2, { type: 'todo/write' }),
          withBestMatch(3, { type: 'tool/result', snippet: 'a command dump' }),
          withBestMatch(4, { type: 'user/message', snippet: 'allowed snippet' }),
        ],
      }),
    } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('match'),
      new AbortController().signal,
    )

    expect(response.result).toEqual({
      ok: true,
      value: {
        items: [{ sessionId: 'visible', snippet: 'allowed snippet', seq: 4 }],
        hasMore: false,
      },
    })
  })

  it('excludes tool-result hits — search covers the conversation only', async () => {
    const ctx = await baseContext()
    const visible = hit('visible')
    ctx.sessions.create(visible.header.id, { meta: visible.header })
    ctx.provide('sessionQuery', {
      searchSessions: () => Promise.resolve({
        items: [{
          ...visible,
          bestMatch: {
            ...visible.bestMatch,
            seq: 512,
            type: 'tool/result',
            snippet: 'the failing command output',
          },
        }],
      }),
    } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('failing command'),
      new AbortController().signal,
    )

    // Tool calls and results (commands, dumps, diffs) make search noisy, so the
    // surface stays on the human conversation: the hit is dropped entirely.
    expect(response.result).toEqual({
      ok: true,
      value: { items: [], hasMore: false },
    })
  })

  it('pages the globally ranked stream until the 20-item Host boundary is known', async () => {
    const ctx = await baseContext()
    const items = Array.from({ length: 21 }, (_, index) => hit(`visible-${index}`, index))
    for (const item of items) {
      ctx.sessions.create(item.header.id, { meta: item.header })
    }
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({
        items: [hit('hidden-ranked-first'), ...items.slice(0, 19)],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({ items: items.slice(19) })
    ctx.provide('sessionQuery', {
      searchSessions,
    } as never)
    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('match'),
      new AbortController().signal,
    )

    expect(response.result).toMatchObject({
      ok: true,
      value: { hasMore: true },
    })
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.items).toHaveLength(20)
    expect(response.result.value.items.at(-1)?.sessionId).toBe('visible-19')
    expect(searchSessions).toHaveBeenCalledTimes(2)
    expect(searchSessions.mock.calls[1]?.[0]).toMatchObject({ cursor: 'page-2' })
  })

  it('learns a provider maxLimit of 10 and collects the 20-item result plus lookahead', async () => {
    const ctx = await baseContext()
    const items = Array.from({ length: 21 }, (_, index) => hit(`visible-${index}`, index))
    for (const item of items) {
      ctx.sessions.create(item.header.id, { meta: item.header })
    }
    const invalidLimit = new SessionQueryError(
      'provider accepts at most 10 items',
      'SESSION_QUERY_INVALID_LIMIT',
    )
    const searchSessions = vi.fn((providerRequest: SessionSearchRequest) => {
      const limit = providerRequest.limit
      if (limit === undefined) throw new Error('Host search must request an explicit provider limit')
      if (limit > 10) return Promise.reject(invalidLimit)
      const offset = providerRequest.cursor === undefined
        ? 0
        : Number.parseInt(providerRequest.cursor.slice('offset-'.length), 10)
      const end = Math.min(items.length, offset + limit)
      return Promise.resolve({
        items: items.slice(offset, end),
        ...end < items.length ? { nextCursor: `offset-${end}` } : {},
      })
    })
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('adaptive-page-limit'),
      new AbortController().signal,
    )

    expect(response.result).toMatchObject({
      ok: true,
      value: { hasMore: true },
    })
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.items.map(item => item.sessionId))
      .toEqual(items.slice(0, 20).map(item => item.header.id))
    expect(searchSessions.mock.calls.map(([providerRequest]) => ({
      limit: providerRequest.limit,
      cursor: providerRequest.cursor,
    }))).toEqual([
      { limit: 20, cursor: undefined },
      { limit: 10, cursor: undefined },
      { limit: 10, cursor: 'offset-10' },
      { limit: 10, cursor: 'offset-20' },
    ])
  })

  it('counts a page-limit probe inside the 100-call budget', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const invalidLimit = new SessionQueryError(
      'provider accepts at most 10 items',
      'SESSION_QUERY_INVALID_LIMIT',
    )
    const searchSessions = vi.fn((providerRequest: SessionSearchRequest) => {
      if (searchSessions.mock.calls.length === 1) {
        expect(providerRequest).toMatchObject({ limit: 20 })
        return Promise.reject(invalidLimit)
      }
      expect(providerRequest.limit).toBe(10)
      return Promise.resolve({
        items: [],
        nextCursor: `page-${searchSessions.mock.calls.length}`,
      })
    })
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('endless-pages'),
      new AbortController().signal,
    )

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error).toMatchObject({ code: 'internal' })
    expect(response.result.error.message).toContain('100-call work budget')
    expect(searchSessions).toHaveBeenCalledTimes(100)
  })

  it('restarts a stale continuation with its learned limit and original visibility snapshot', async () => {
    const ctx = await baseContext()
    const oldOnly = hit('old-only', 0)
    const shared = hit('shared', 1)
    const freshFirst = hit('fresh-first', 2)
    const freshLast = hit('fresh-last', 3)
    for (const item of [oldOnly, shared, freshFirst, freshLast]) {
      ctx.sessions.create(item.header.id, { meta: item.header })
    }
    const late = hit('late-visible', 4)
    const stale = new SessionQueryError(
      'provider generation changed',
      'SESSION_QUERY_STALE_CURSOR',
    )
    const invalidLimit = new SessionQueryError(
      'provider accepts at most 10 items',
      'SESSION_QUERY_INVALID_LIMIT',
    )
    const searchSessions = vi.fn((providerRequest: SessionSearchRequest) => {
      switch (searchSessions.mock.calls.length) {
        case 1:
          expect(providerRequest).toMatchObject({ limit: 20 })
          expect(providerRequest).not.toHaveProperty('cursor')
          return Promise.reject(invalidLimit)
        case 2:
          expect(providerRequest).toMatchObject({ limit: 10 })
          expect(providerRequest).not.toHaveProperty('cursor')
          return Promise.resolve({
            items: [oldOnly, shared],
            nextCursor: 'old-cursor',
          })
        case 3:
          expect(providerRequest).toMatchObject({ limit: 10 })
          expect(providerRequest.cursor).toBe('old-cursor')
          ctx.sessions.create(late.header.id, { meta: late.header })
          return Promise.reject(stale)
        case 4:
          expect(providerRequest).toMatchObject({ limit: 10 })
          expect(providerRequest).not.toHaveProperty('cursor')
          return Promise.resolve({
            items: [freshFirst, shared],
            nextCursor: 'old-cursor',
          })
        case 5:
          expect(providerRequest).toMatchObject({ limit: 10 })
          expect(providerRequest.cursor).toBe('old-cursor')
          return Promise.resolve({ items: [freshLast, late] })
        default:
          return Promise.reject(new Error('unexpected provider call'))
      }
    })
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('stale-restart'),
      new AbortController().signal,
    )

    expect(response.result).toEqual({
      ok: true,
      value: {
        items: [
          { sessionId: 'fresh-first', snippet: 'match 2', seq: 2 },
          { sessionId: 'shared', snippet: 'match 1', seq: 1 },
          { sessionId: 'fresh-last', snippet: 'match 3', seq: 3 },
        ],
        hasMore: false,
      },
    })
    expect(searchSessions).toHaveBeenCalledTimes(5)
  })

  it('counts continuous stale restarts against the 100-call budget', async () => {
    const ctx = await baseContext()
    const partial = hit('partial')
    ctx.sessions.create(partial.header.id, { meta: partial.header })
    const stale = new SessionQueryError(
      'provider generation changed',
      'SESSION_QUERY_STALE_CURSOR',
    )
    const searchSessions = vi.fn((providerRequest: SessionSearchRequest) => {
      if (searchSessions.mock.calls.length > 100) {
        return Promise.reject(new Error('provider was called after the shared budget'))
      }
      if (providerRequest.cursor !== undefined) return Promise.reject(stale)
      return Promise.resolve({
        items: [partial],
        nextCursor: `cursor-${searchSessions.mock.calls.length}`,
      })
    })
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('stale-churn'),
      new AbortController().signal,
    )

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.code).toBe('internal')
    expect(response.result.error.message).toContain('100-call work budget')
    expect(response.result).not.toHaveProperty('value')
    expect(searchSessions).toHaveBeenCalledTimes(100)
  })

  it('gives abort priority over a coincident stale continuation failure', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const controller = new AbortController()
    const stale = new SessionQueryError(
      'provider generation changed',
      'SESSION_QUERY_STALE_CURSOR',
    )
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({ items: [], nextCursor: 'stale-cursor' })
      .mockImplementationOnce(() => {
        controller.abort()
        return Promise.reject(stale)
      })
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('abort-stale'),
      controller.signal,
    )

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
    expect(searchSessions).toHaveBeenCalledTimes(2)
  })

  it('does not retry a stale first-page failure', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const searchSessions = vi.fn(() => Promise.reject(new SessionQueryError(
      'provider generation changed before paging',
      'SESSION_QUERY_STALE_CURSOR',
    )))
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('first-page-stale'),
      new AbortController().signal,
    )

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
    expect(response.result).not.toHaveProperty('value')
    expect(searchSessions).toHaveBeenCalledOnce()
  })

  it('does not adapt an invalid-limit continuation failure', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({ items: [], nextCursor: 'page-2' })
      .mockRejectedValueOnce(new SessionQueryError(
        'continuation limit is invalid',
        'SESSION_QUERY_INVALID_LIMIT',
      ))
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('continuation-invalid-limit'),
      new AbortController().signal,
    )

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
    expect(searchSessions).toHaveBeenCalledTimes(2)
    expect(searchSessions.mock.calls.map(([providerRequest]) => (
      providerRequest as SessionSearchRequest
    ).limit))
      .toEqual([20, 20])
  })

  it('stops page-limit adaptation at one item', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const searchSessions = vi.fn((providerRequest: SessionSearchRequest) => Promise.reject(
      new SessionQueryError(
        `provider rejects ${providerRequest.limit}`,
        'SESSION_QUERY_INVALID_LIMIT',
      ),
    ))
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('minimum-page-limit'),
      new AbortController().signal,
    )

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
    expect(searchSessions.mock.calls.map(([providerRequest]) => providerRequest.limit))
      .toEqual([20, 10, 5, 2, 1])
  })

  it('gives abort priority over a coincident invalid first-page limit', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const controller = new AbortController()
    const searchSessions = vi.fn(() => {
      controller.abort()
      return Promise.reject(new SessionQueryError(
        'provider rejects 20',
        'SESSION_QUERY_INVALID_LIMIT',
      ))
    })
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('abort-invalid-limit'),
      controller.signal,
    )

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
    expect(searchSessions).toHaveBeenCalledOnce()
  })

  it('rejects an oversized provider page', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const oversized = Array.from({ length: 21 }, (_, index) => hit(`oversized-${index}`))
    const searchSessions = vi.fn(() => Promise.resolve({ items: oversized }))
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('oversized-page'),
      new AbortController().signal,
    )

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error).toMatchObject({ code: 'internal' })
    expect(response.result.error.message).toContain('returned 21 items; maximum is 20')
  })

  it('uses the learned provider limit for the overproduction guard', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const oversized = Array.from({ length: 11 }, (_, index) => hit(`oversized-${index}`))
    const searchSessions = vi.fn((providerRequest: SessionSearchRequest) => {
      if (providerRequest.limit === 20) {
        return Promise.reject(new SessionQueryError(
          'provider accepts at most 10 items',
          'SESSION_QUERY_INVALID_LIMIT',
        ))
      }
      return Promise.resolve({ items: oversized })
    })
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('adapted-oversized-page'),
      new AbortController().signal,
    )

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error).toMatchObject({ code: 'internal' })
    expect(response.result.error.message).toContain('returned 11 items; maximum is 10')
    expect(searchSessions).toHaveBeenCalledTimes(2)
  })

  it('bounds provider snippets to 240 Unicode code points without splitting astral text', async () => {
    const ctx = await baseContext()
    const visible = hit('visible')
    ctx.sessions.create(visible.header.id, { meta: visible.header })
    const expected = `${'x'.repeat(239)}😀`
    const overlong = {
      ...visible,
      bestMatch: {
        ...visible.bestMatch,
        snippet: `${expected}${'y'.repeat(10_000)}`,
      },
    }
    ctx.provide('sessionQuery', {
      searchSessions: () => Promise.resolve({ items: [overlong] }),
    } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('bounded-snippet'),
      new AbortController().signal,
    )

    expect(response.result).toEqual({
      ok: true,
      value: {
        items: [{ sessionId: 'visible', snippet: expected, seq: 0 }],
        hasMore: false,
      },
    })
  })

  it('fails closed when the provider repeats a continuation cursor', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({ items: [], nextCursor: 'repeated' })
      .mockResolvedValueOnce({ items: [], nextCursor: 'repeated' })
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('repeated-cursor'),
      new AbortController().signal,
    )

    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error).toMatchObject({ code: 'internal' })
    expect(response.result.error.message).toContain('repeated a continuation cursor')
    expect(searchSessions).toHaveBeenCalledTimes(2)
  })

  it('validates a repeated cursor before accepting the authorized lookahead', async () => {
    const ctx = await baseContext()
    const items = Array.from({ length: 21 }, (_, index) => hit(`visible-${index}`, index))
    for (const item of items) {
      ctx.sessions.create(item.header.id, { meta: item.header })
    }
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({ items: items.slice(0, 20), nextCursor: 'repeated' })
      .mockResolvedValueOnce({ items: items.slice(20), nextCursor: 'repeated' })
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('repeated-lookahead-cursor'),
      new AbortController().signal,
    )

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
    expect(response.result).not.toHaveProperty('value')
    if (response.result.ok) throw new Error('unreachable')
    expect(response.result.error.message).toContain('repeated a continuation cursor')
    expect(searchSessions).toHaveBeenCalledTimes(2)
  })

  it('does not count duplicate session ids toward the result or lookahead boundary', async () => {
    const ctx = await baseContext()
    const items = Array.from({ length: 21 }, (_, index) => hit(`visible-${index}`, index))
    for (const item of items) {
      ctx.sessions.create(item.header.id, { meta: item.header })
    }
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({ items: items.slice(0, 20), nextCursor: 'page-2' })
      .mockResolvedValueOnce({ items: items.slice(0, 20), nextCursor: 'page-3' })
      .mockResolvedValueOnce({ items: items.slice(20) })
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('duplicate-pages'),
      new AbortController().signal,
    )

    expect(response.result).toMatchObject({
      ok: true,
      value: { hasMore: true },
    })
    if (!response.result.ok) throw new Error('unreachable')
    expect(response.result.value.items.map(item => item.sessionId)).toEqual(
      items.slice(0, 20).map(item => item.header.id),
    )
    expect(searchSessions).toHaveBeenCalledTimes(3)
  })

  it('cancels on a continuation page and passes the carrier signal to both calls', async () => {
    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const controller = new AbortController()
    const searchSessions = vi.fn()
      .mockResolvedValueOnce({ items: [], nextCursor: 'page-2' })
      .mockImplementationOnce(() => {
        controller.abort()
        return Promise.resolve({ items: [] })
      })
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('cancel-continuation'),
      controller.signal,
    )

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
    expect(searchSessions).toHaveBeenCalledTimes(2)
    for (const call of searchSessions.mock.calls) {
      expect(call[1]).toEqual({ signal: controller.signal })
    }
  })

  it('keeps visibility sets above SQLite variable limits out of provider bindings', async () => {
    const ctx = await baseContext()
    const cold = Array.from(
      { length: 32_751 },
      (_, index) => header(`cold-${index}`, `/cold-${index}`),
    )
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve(cold),
      locate: () => undefined,
    } as never)
    const searchSessions = vi.fn((_request: SessionSearchRequest) => Promise.resolve({
      items: [hit('cold-32750')],
    }))
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('large corpus'),
      new AbortController().signal,
    )

    expect(response.result).toEqual({
      ok: true,
      value: {
        items: [{ sessionId: 'cold-32750', snippet: 'match 0', seq: 0 }],
        hasMore: false,
      },
    })
    expect(searchSessions).toHaveBeenCalledOnce()
    expect(searchSessions.mock.calls[0]?.[0]).not.toHaveProperty('sessionFilters')
  })

  it('propagates cancellation through the lightweight visible-scope and stops before the index', async () => {
    const ctx = await baseContext()
    const controller = new AbortController()
    const cold = Array.from({ length: 32 }, (_, index) => header(`cold-${index}`, `/cold-${index}`))
    const list = vi.fn((signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal)
      // Abort while the header list is in flight, like a client disconnect.
      controller.abort()
      return Promise.resolve(cold)
    })
    ctx.provide('sessionPersistence', { list, locate: vi.fn() } as never)
    const searchSessions = vi.fn()
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('cancel-during-visibility'),
      controller.signal,
    )

    // The scope lists persisted headers once; cancellation surfaces cleanly.
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
    expect(list).toHaveBeenCalledOnce()
    expect(searchSessions).not.toHaveBeenCalled()
  })

  it('performs no cold-summary stat work for search (headers only)', async () => {
    // Search authorization needs only the visible session id set. The old path
    // summarized every cold session (stat/disk reads per log) on each request;
    // the lightweight scope must not touch that machinery at all.
    const ctx = await baseContext()
    const cold = Array.from({ length: 16 }, (_, index) => header(`cold-${index}`, `/cold-${index}`))
    const statMock = vi.mocked(stat)
    statMock.mockClear()
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve(cold),
      locate: (meta: SessionHeader) => ({ kind: 'jsonl', path: `/logs/${meta.id}.jsonl` }),
    } as never)
    const searchSessions = vi.fn(async () => ({ items: [] }))
    ctx.provide('sessionQuery', { searchSessions } as never)

    const response = await createApiProxy(ctx, defaults).sessions.search(
      request('no-cold-stats'),
      new AbortController().signal,
    )

    expect(response.result.ok).toBe(true)
    expect(searchSessions).toHaveBeenCalled()
    // The whole optimization: zero cold-summary stat calls for search.
    expect(statMock).not.toHaveBeenCalled()
  })

  it('serves repeated searches from the cached visible scope within the TTL', async () => {
    // The expensive part of a search is recomputing the visible session set.
    // Within the short cache window a second identical request must reuse the
    // first scope instead of re-listing persistence.
    const ctx = await baseContext()
    const live = hit('visible')
    ctx.sessions.create(live.header.id, { meta: live.header })
    const cold = Array.from({ length: 8 }, (_, index) => header(`cold-${index}`, `/cold-${index}`))
    const list = vi.fn(() => Promise.resolve(cold))
    ctx.provide('sessionPersistence', { list, locate: vi.fn() } as never)
    const searchSessions = vi.fn(async () => ({ items: [] }))
    ctx.provide('sessionQuery', { searchSessions } as never)

    const api = createApiProxy(ctx, defaults)
    const signal = new AbortController().signal
    await api.sessions.search(request('one'), signal)
    await api.sessions.search(request('two'), signal)

    expect(list).toHaveBeenCalledTimes(1)
    expect(searchSessions).toHaveBeenCalledTimes(2)
  })

  it('maps missing composition, query cancellation, and provider failure', async () => {
    const missingCtx = await baseContext()
    missingCtx.sessions.create(sid('visible'), { meta: header('visible') })
    const missingApi = createApiProxy(missingCtx, defaults)
    const preAborted = new AbortController()
    preAborted.abort()
    const cancelledBeforeLookup = await missingApi.sessions.search(
      request('cancel-before-lookup'),
      preAborted.signal,
    )
    expect(cancelledBeforeLookup.result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })

    const missing = await missingApi.sessions.search(
      request('needle'),
      new AbortController().signal,
    )
    expect(missing.result.ok).toBe(false)
    if (missing.result.ok) throw new Error('unreachable')
    expect(missing.result.error.code).toBe('internal')
    expect(missing.result.error.message).toContain('does not mount')

    const ctx = await baseContext()
    ctx.sessions.create(sid('visible'), { meta: header('visible') })
    const aborted = new SessionQueryError('provider stopped', 'SESSION_QUERY_ABORTED')
    const searchSessions = vi.fn()
      .mockRejectedValueOnce(aborted)
      .mockRejectedValueOnce(new Error('database unavailable'))
    ctx.provide('sessionQuery', { searchSessions } as never)
    const api = createApiProxy(ctx, defaults)

    const cancelled = await api.sessions.search(
      request('first'),
      new AbortController().signal,
    )
    expect(cancelled.result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })

    const failed = await api.sessions.search(
      request('second'),
      new AbortController().signal,
    )
    expect(failed.result.ok).toBe(false)
    if (failed.result.ok) throw new Error('unreachable')
    expect(failed.result.error.code).toBe('internal')
    expect(failed.result.error.message).toContain('database unavailable')
  })
})
