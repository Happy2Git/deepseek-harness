/**
 * Markdown → ANSI-styled plain text for the terminal transcript. The model's
 * raw text is untrusted, so every text/code span passes through
 * {@link escapeControls} before it reaches the terminal; only the styling
 * codes this module emits are trusted.
 * @module @deepseek-ai/dsh-tui/markdown
 */

import { lexer, type Token } from 'marked'

const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

/** Escape C0/C1 controls other than LF/TAB so model text cannot inject terminal sequences. */
export function escapeControls(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '\n' || ch === '\t') {
      out += ch
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`
    } else {
      out += ch
    }
  }
  return out
}

/** Inline child tokens of a container token, or an empty list. */
function childTokens(token: Token): Token[] {
  return 'tokens' in token ? (token.tokens ?? []) : []
}

/** Render one inline token to a styled string. */
function inline(token: Token): string {
  switch (token.type) {
    case 'text':
    case 'escape':
      return escapeControls(token.text)
    case 'strong':
      return BOLD + childTokens(token).map(inline).join('') + RESET
    case 'em':
      return childTokens(token).map(inline).join('')
    case 'codespan':
      return DIM + escapeControls(token.text) + RESET
    case 'del':
      return childTokens(token).map(inline).join('')
    case 'br':
      return '\n'
    case 'link': {
      const label = childTokens(token).map(inline).join('')
      const href = escapeControls(token.href)
      return href === '' || href === label ? label : `${label} ${DIM}(${href})${RESET}`
    }
    case 'image':
      return `[image: ${escapeControls(token.href)}]`
    default:
      return ''
  }
}

/** Render one block token into zero or more lines. */
function block(token: Token): string[] {
  switch (token.type) {
    case 'space':
      return []
    case 'heading':
      return [BOLD + childTokens(token).map(inline).join('') + RESET]
    case 'paragraph':
      return [childTokens(token).map(inline).join('')]
    case 'text':
      return [escapeControls(token.text)]
    case 'code': {
      if (token.text === '') return []
      return token.text.split('\n').map((line: string) => DIM + line + RESET)
    }
    case 'list': {
      const lines: string[] = []
      let index = 1
      for (const item of token.items) {
        const marker = token.ordered ? `${index}. ` : '· '
        const itemLines = (item.tokens ?? []).flatMap(block)
        lines.push(marker + (itemLines[0] ?? ''))
        for (let i = 1; i < itemLines.length; i++) lines.push(`  ${itemLines[i]}`)
        index += 1
      }
      return lines
    }
    case 'blockquote':
      return childTokens(token).flatMap(block).map(line => `  ${line}`)
    case 'hr':
      return ['─'.repeat(32)]
    case 'html':
    case 'table':
      return []
    default:
      return []
  }
}

/** Render markdown source into ANSI-styled plain text, one line per block. */
export function formatMarkdown(source: string): string {
  return lexer(source).flatMap(block).join('\n')
}
