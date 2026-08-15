/** renderCall / renderResult: structured tool cards escape tool- and model-produced text. */

import { describe, expect, it } from 'vitest'
import { renderCall, renderResult } from '../src/tool-cards.ts'

describe('renderCall', () => {
  it('escapes the card title', () => {
    expect(renderCall({ card: 'generic', title: 'a\u009bb' })).toBe('◇ a\\x9bb')
  })
})

describe('renderResult', () => {
  it('escapes a generic card body', () => {
    const [line] = renderResult({ card: 'generic', content: [{ type: 'text', text: 'a\u009bb' }] })
    expect(line).toBe('a\\x9bb')
  })

  it('escapes terminal output and the signal name', () => {
    const [outLine] = renderResult({ card: 'terminal', output: 'o\u009b' })
    expect(outLine).toBe('o\\x9b')
    const [signalLine] = renderResult({ card: 'terminal', signal: 'SIG\u009bTERM' })
    expect(signalLine).toBe('[signal SIG\\x9bTERM]')
  })

  it('escapes every diff line while preserving added/removed coloring', () => {
    const lines = renderResult({
      card: 'diff',
      diffs: [{ path: 'f.txt', oldText: 'old\u009b', newText: 'new\u009b' }],
    })
    const joined = lines.join('\n')
    expect(joined).not.toContain('\u009b')
    expect(joined).toContain('\\x9b')
    expect(lines.some(line => line.startsWith('\x1b[32m') && line.includes('+'))).toBe(true)
    expect(lines.some(line => line.startsWith('\x1b[31m') && line.includes('-'))).toBe(true)
  })

  it('escapes a grouped search match path and line', () => {
    const [line] = renderResult({
      card: 'search',
      shape: 'matches',
      files: [{ path: 'p\u009b', matches: [{ lineNumber: 1, line: 'l\u009b' }] }],
      truncated: false,
      total: 1,
    })
    expect(line).toBe('p\\x9b:1: l\\x9b')
  })

  it('escapes a read window line', () => {
    const [line] = renderResult({
      card: 'read',
      path: 'f.txt',
      offset: 1,
      lines: [{ number: 1, text: 'x\u009b' }],
      totalLines: 1,
    })
    expect(line).toBe('   1 x\\x9b')
  })

  it('escapes web search sources and answer', () => {
    const lines = renderResult({
      card: 'web',
      kind: 'search',
      answer: 'a\u009b',
      sources: [{ url: 'https://x/\u009b' }],
      truncated: false,
    })
    expect(lines.join('\n')).not.toContain('\u009b')
    expect(lines[0]).toBe('a\\x9b')
    expect(lines[1]).toBe('· https://x/\\x9b')
  })
})
