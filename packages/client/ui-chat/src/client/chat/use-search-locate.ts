/** Content-search navigation and browser-owned text highlights. */
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ConversationLocateRequest } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'

/**
 * Resolve the message's exact durable sequence, independent of its visual anchor.
 * @param order - loaded Chat node order.
 * @param nodes - loaded node reader.
 * @param seq - matched durable message sequence.
 * @returns matching message key, or undefined when the message is unavailable.
 */
export function searchNodeKey(order: readonly string[], nodes: Pick<ChatSnapshot['nodes'], 'get'>, seq: number): string | undefined {
  return order.find((key) => {
    const node = nodes.get(key) as ChatNode | undefined
    if (node?.kind === 'assistant-step') return node.data.finalNode?.seq === seq
    return (node?.kind === 'user' || node?.kind === 'steering' || node?.kind === 'context' || node?.kind === 'turn-trigger')
      && node.data.seq === seq
  })
}

/**
 * Highlight literal matches across inline Markdown text without mutating React's DOM.
 * @param row - the matched message row.
 * @param query - literal search phrase.
 * @returns first match for viewport alignment and cleanup scoped to this highlight.
 */
export function highlightSearchText(row: HTMLElement, query: string): { firstMatch: Range | undefined; clear: () => void } {
  const registry = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights
  if (registry === undefined || typeof Highlight === 'undefined' || query.trim() === '') {
    return { firstMatch: undefined, clear: () => {} }
  }
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  const parts: { node: Node; start: number; end: number }[] = []
  let text = ''
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const start = text.length
    text += node.textContent ?? ''
    parts.push({ node, start, end: text.length })
  }
  const literal = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const highlight = new Highlight()
  let firstMatch: Range | undefined
  for (const match of text.matchAll(new RegExp(literal, 'giu'))) {
    const start = parts.find(part => part.end > match.index)
    const endOffset = match.index + match[0].length
    const end = parts.find(part => part.end >= endOffset)
    if (start === undefined || end === undefined) continue
    const range = document.createRange()
    range.setStart(start.node, match.index - start.start)
    range.setEnd(end.node, endOffset - end.start)
    firstMatch ??= range
    highlight.add(range)
  }
  registry.set('dsh-search-match', highlight)
  return {
    firstMatch,
    clear: () => {
      if (registry.get('dsh-search-match') === highlight) registry.delete('dsh-search-match')
    },
  }
}

/**
 * Load a search destination, reveal folded content, and yield scroll ownership to the reader.
 * @param request - binding-local search destination; a newer request supersedes the old one.
 * @param openState - history readiness.
 * @param loadingOlder - another history operation currently owns the loader.
 * @param order - current Chat order, including prepended history.
 * @param nodes - current Chat node reader.
 * @param scroll - existing Chat viewport and scroll policy.
 * @param loadThrough - shared history loader; failures remain visible in the search notice.
 * @returns loading or failure notice, or null after landing.
 */
export function useSearchLocate(
  request: ConversationLocateRequest | null,
  openState: string,
  loadingOlder: boolean,
  order: readonly string[],
  nodes: Pick<ChatSnapshot['nodes'], 'get'>,
  scroll: { listRef: RefObject<HTMLDivElement>; revealNode: (key: string, match?: Range) => void },
  loadThrough: ChatViewSlotProps['loadThrough'],
): 'loading' | 'failed' | 'missing' | null {
  const [loaded, setLoaded] = useState<ConversationLocateRequest | null>(null)
  const [failed, setFailed] = useState<ConversationLocateRequest | null>(null)
  const [missing, setMissing] = useState<ConversationLocateRequest | null>(null)
  const currentRequest = useRef<ConversationLocateRequest | null>(request)
  const started = useRef<ConversationLocateRequest | null>(null)
  useEffect(() => {
    currentRequest.current = request
    return () => { currentRequest.current = null }
  }, [request])
  useEffect(() => {
    if (request === null || openState !== 'open' || loadingOlder || started.current === request) return
    started.current = request
    void loadThrough(SessionSeq(request.seq)).then(() => {
      if (currentRequest.current === request) setLoaded(request)
    }, () => {
      if (currentRequest.current === request) setFailed(request)
    })
  }, [request, openState, loadingOlder, loadThrough])

  const revealNode = scroll.revealNode
  const listRef = scroll.listRef
  useEffect(() => {
    if (request === null || loaded !== request) return
    const key = searchNodeKey(order, nodes, request.seq)
    const row = key === undefined ? undefined : [...(listRef.current?.querySelectorAll<HTMLElement>('[data-chat-node-key]') ?? [])]
      .find(element => element.dataset.chatNodeKey === key && element.dataset.chatGroupPart !== 'process')
    if (row === undefined || key === undefined) {
      setMissing(request)
      return
    }
    setMissing(null)
    // beforematch uses the same disclosure path as browser Find, including folded process groups.
    for (const hidden of row.querySelectorAll<HTMLElement>('[hidden]')) hidden.dispatchEvent(new Event('beforematch'))
    for (let ancestor: HTMLElement | null = row; ancestor !== null; ancestor = ancestor.parentElement) {
      if (ancestor.hasAttribute('hidden')) ancestor.dispatchEvent(new Event('beforematch'))
    }
    let clearHighlight = () => {}
    const frame = requestAnimationFrame(() => {
      const highlight = highlightSearchText(row, request.query)
      clearHighlight = highlight.clear
      revealNode(key, highlight.firstMatch)
      row.dataset.searchLocated = ''
    })
    return () => {
      cancelAnimationFrame(frame)
      clearHighlight()
      delete row.dataset.searchLocated
    }
  }, [request, loaded, order, nodes, listRef, revealNode])
  if (request === null) return null
  if (failed === request) return 'failed'
  if (missing === request) return 'missing'
  return loaded === request ? null : 'loading'
}
