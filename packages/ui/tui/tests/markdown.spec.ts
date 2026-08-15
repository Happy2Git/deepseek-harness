/** escapeControls and formatMarkdown: terminal-injection defense for model text. */

import { describe, expect, it } from 'vitest'
import { escapeControls, formatMarkdown } from '../src/markdown.ts'

describe('escapeControls', () => {
  it('passes LF and TAB through unchanged', () => {
    expect(escapeControls('a\nb\tc')).toBe('a\nb\tc')
  })

  it('escapes C0 controls including ESC', () => {
    expect(escapeControls('a\u001bb')).toBe('a\\x1bb')
  })

  it('escapes DEL', () => {
    expect(escapeControls('a\u007fb')).toBe('a\\x7fb')
  })

  it('escapes C1 controls (U+0080–U+009F) like the CSI introducer', () => {
    expect(escapeControls('a\u009b31mred')).toBe('a\\x9b31mred')
    expect(escapeControls('\u0085')).toBe('\\x85')
  })

  it('leaves printable text unchanged', () => {
    expect(escapeControls('plain text 123')).toBe('plain text 123')
  })
})

describe('formatMarkdown', () => {
  it('escapes model text inside a fenced code block', () => {
    const out = formatMarkdown('```\nhello\u009b31m\n```')
    expect(out).not.toContain('\u009b')
    expect(out).toContain('hello\\x9b31m')
  })

  it('wraps strong text in bold styling', () => {
    expect(formatMarkdown('**bold**')).toBe('\x1b[1mbold\x1b[0m')
  })

  it('escapes an inline code span', () => {
    // The content ESC is neutralized to a literal; the DIM/RESET styling this
    // module emits stays trusted ANSI.
    expect(formatMarkdown('`a\u001bb`')).toBe('\x1b[2ma\\x1bb\x1b[0m')
  })

  it('escapes a link href', () => {
    const out = formatMarkdown('[label](https://x/\u009b)')
    expect(out).not.toContain('\u009b')
    expect(out).toContain('\\x9b')
  })
})
