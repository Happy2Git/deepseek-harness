/**
 * Structured tool-card rendering for the six `presentCall`/`presentResult`
 * intents (generic, terminal, diff, search, read, web). All model- or
 * tool-produced text is escaped before it reaches the terminal.
 * @module @deepseek-ai/dsh-tui/tool-cards
 */

import { createTwoFilesPatch } from 'diff'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { FileDiff, ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { escapeControls } from './markdown.ts'

const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'

/** Join the text blocks of model-visible content into one plain string. */
function textOf(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined) return ''
  let out = ''
  for (const block of blocks) {
    if (block.type === 'text') out += block.text
  }
  return out.trim()
}

/** Render one file diff into colored unified-diff lines. */
function renderDiff(diffs: readonly FileDiff[]): string[] {
  const lines: string[] = []
  for (const diff of diffs) {
    const patch = createTwoFilesPatch(diff.path, diff.path, diff.oldText ?? '', diff.newText)
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) lines.push(GREEN + line + RESET)
      else if (line.startsWith('-') && !line.startsWith('---')) lines.push(RED + line + RESET)
      else if (line.startsWith('@@')) lines.push(DIM + line + RESET)
      else if (line.startsWith('---') || line.startsWith('+++')) lines.push(DIM + line + RESET)
      else lines.push(line)
    }
  }
  return lines
}

/** One-line header for a pending tool call. */
export function renderCall(view: ToolCallView): string {
  return `◇ ${escapeControls(view.title)}`
}

/** Body lines for a completed tool call. */
export function renderResult(view: ToolResultView): string[] {
  switch (view.card) {
    case 'generic': {
      const text = textOf(view.content)
      return text === '' ? [] : [escapeControls(text)]
    }
    case 'terminal': {
      const lines: string[] = []
      if (view.output !== undefined) lines.push(...view.output.split('\n').map(escapeControls))
      if (view.exitCode !== undefined) lines.push(`[exit ${view.exitCode}]`)
      else if (view.signal !== undefined) lines.push(`[signal ${view.signal}]`)
      return lines
    }
    case 'diff':
      return renderDiff(view.diffs)
    case 'search': {
      if (view.shape === 'paths') return view.paths.map(path => escapeControls(path))
      const lines: string[] = []
      for (const file of view.files) {
        for (const match of file.matches) {
          lines.push(`${escapeControls(file.path)}:${match.lineNumber}: ${escapeControls(match.line)}`)
        }
      }
      if (view.truncated) lines.push(DIM + `… ${view.total} matches` + RESET)
      return lines
    }
    case 'read': {
      return view.lines.map(line => `${String(line.number).padStart(4)} ${escapeControls(line.text)}`)
    }
    case 'web': {
      if (view.kind === 'search') {
        const lines = view.sources.map(source => `· ${escapeControls(source.title ?? source.url)}`)
        if (view.answer !== undefined) lines.unshift(escapeControls(view.answer))
        return lines
      }
      return [`[${view.statusCode}] ${escapeControls(view.url)}`]
    }
  }
}
