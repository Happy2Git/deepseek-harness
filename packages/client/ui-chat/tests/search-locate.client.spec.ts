// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ConversationLocateRequest } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { highlightSearchText, searchNodeKey, useSearchLocate } from '../src/client/chat/use-search-locate.ts'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('content-search locations', () => {
  it('uses the settled assistant sequence instead of a nearer tool or footer anchor', () => {
    const nodes = new Map<string, ChatNode>([
      ['answer', { kind: 'assistant-step', anchorSeq: 3, data: { finalNode: { seq: 10 } } } as ChatNode],
      ['tool', { kind: 'tool-call', anchorSeq: 8, data: {} } as ChatNode],
      ['tail', { kind: 'turn-tail', anchorSeq: 11, data: { seq: 10 } } as ChatNode],
      ['user', { kind: 'user', anchorSeq: 1, data: { seq: 1 } } as ChatNode],
    ])
    expect(searchNodeKey([...nodes.keys()], nodes, 10)).toBe('answer')
    expect(searchNodeKey([...nodes.keys()], nodes, 1)).toBe('user')
    expect(searchNodeKey([...nodes.keys()], nodes, 9)).toBeUndefined()
  })

  it('highlights Chinese, mixed case, and literal punctuation across Markdown spans', () => {
    const highlights = new Map<string, Set<Range>>()
    vi.stubGlobal('CSS', { highlights })
    vi.stubGlobal('Highlight', class extends Set<Range> {})
    const row = document.createElement('div')
    row.innerHTML = '复核预算 <strong>Plan</strong>DS<span>eArCh</span> [a+b]'
    const html = row.innerHTML
    const firstCleanup = highlightSearchText(row, '预算 Plan')
    expect([...highlights.get('dsh-search-match') ?? []].map(range => range.toString())).toEqual(['预算 Plan'])
    const secondCleanup = highlightSearchText(row, 'search')
    expect([...highlights.get('dsh-search-match') ?? []].map(range => range.toString())).toEqual(['SeArCh'])
    firstCleanup.clear()
    expect(highlights.has('dsh-search-match')).toBe(true)
    secondCleanup.clear()
    expect(highlights.size).toBe(0)
    highlightSearchText(row, '[a+b]').clear()
    expect(row.innerHTML).toBe(html)
  })

  it('keeps row navigation usable when Custom Highlight is unavailable', () => {
    vi.stubGlobal('CSS', undefined)
    expect(() => { highlightSearchText(document.createElement('div'), '中').clear() }).not.toThrow()
  })
})


describe('content-search loading', () => {
  it('waits for existing history work and ignores a superseded destination', async () => {
    const order: string[] = []
    const nodes = new Map<string, ChatNode>()
    const scroll = { listRef: { current: document.createElement('div') }, revealNode: vi.fn() }
    const completions: (() => void)[] = []
    const loadThrough = vi.fn(() => new Promise<void>(resolve => completions.push(resolve)))
    const first: ConversationLocateRequest = { seq: 1, query: '预算' }
    const second: ConversationLocateRequest = { seq: 3, query: 'plan' }
    const hook = renderHook(({ request, busy }) =>
      useSearchLocate(request, 'open', busy, order, nodes, scroll, loadThrough),
    { initialProps: { request: first, busy: true } })
    expect(loadThrough).not.toHaveBeenCalled()
    hook.rerender({ request: first, busy: false })
    expect(loadThrough).toHaveBeenCalledTimes(1)
    hook.rerender({ request: second, busy: false })
    expect(loadThrough).toHaveBeenCalledTimes(2)
    await act(async () => { completions[0]!() })
    expect(hook.result.current).toBe('loading')
    await act(async () => { completions[1]!() })
    await waitFor(() => { expect(hook.result.current).toBe('missing') })
    hook.unmount()
  })

  it('reports rejected history loading', async () => {
    const request: ConversationLocateRequest = { seq: 1, query: '预算' }
    const order: string[] = []
    const nodes = new Map<string, ChatNode>()
    const scroll = { listRef: { current: document.createElement('div') }, revealNode: vi.fn() }
    const loadThrough = vi.fn(() => Promise.reject(new Error('unavailable')))
    const hook = renderHook(() => useSearchLocate(request, 'open', false, order, nodes, scroll, loadThrough))
    await waitFor(() => { expect(hook.result.current).toBe('failed') })
    hook.unmount()
  })
})
