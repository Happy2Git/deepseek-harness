/**
 * Interactive terminal (TUI) front door for DeepSeek Harness agents.
 *
 * This package owns terminal input and presentation only: it detects a TTY,
 * creates one agent through the public registry, renders the durable session
 * transcript from `session/event`, and answers the `interaction` seams
 * (`commands`, `approval`, `userQuestions`) through one concrete host. It never
 * implements the agent loop, persists sessions, or defines tools — those stay
 * in the capability spine and their owning packages.
 *
 * @module @deepseek-ai/dsh-tui
 */

import { randomUUID } from 'node:crypto'
import {
  Editor,
  Key,
  matchesKey,
  ProcessTerminal,
  Text,
  TuiAltScreen,
  VStack,
  type Component,
  type EditorTheme,
  type OverlayHandle,
  type OverlayOptions,
} from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
// Empty type imports carry the loader Context merges for the settlement await,
// the agent-default-model service, the token meter, and the approval waterfall.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-user-approval'

/** Stable Cordis plugin name. */
export const name = 'cli-tui'

/** Status-line value registry exposed to other plugins as `ctx.tuiPrompt`. */
export interface TuiPromptService {
  /** Register one footer fragment by name; the returned disposer removes it. */
  register(name: string, fragment: string): () => void
  /** Current registered fragments in insertion order. */
  values(): ReadonlyMap<string, string>
}

/** Modal-overlay front door exposed to other plugins as `ctx.tui`. */
export interface TuiExtensionService {
  /** Open one fullscreen overlay component; the returned handle controls it. */
  openOverlay(component: Component, options?: OverlayOptions): OverlayHandle
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tui: TuiExtensionService
    tuiPrompt: TuiPromptService
  }
}

/**
 * No-styling editor theme for the current scaffold; the palette/theme system
 * from the removed TUI is reintroduced with the tool-card renderer.
 */
const EDITOR_THEME: EditorTheme = {
  borderColor: text => text,
  selectList: {
    selectedPrefix: text => text,
    selectedText: text => text,
    description: text => text,
    scrollInfo: text => text,
    noMatch: text => text,
  },
}

/** Join the text blocks of a model-visible content list into plain text. */
function contentText(blocks: readonly ContentBlock[]): string {
  let out = ''
  for (const block of blocks) {
    if (block.type === 'text') out += block.text
  }
  return out
}

/** Truncate one tool result for the collapsed tool card. */
const TOOL_RESULT_PREVIEW_CHARS = 240

/** Fold one event into transcript lines, threading the last tool-call name. */
function foldEventLines(
  event: SessionEvent,
  lastToolCall: string | undefined,
  showReasoning: boolean,
): { lines: string[]; lastToolCall: string | undefined } {
  switch (event.type) {
    case 'user/message': {
      if (event.data.source.kind === 'user') {
        const text = contentText(event.data.content).trim()
        return text === '' ? { lines: [], lastToolCall } : { lines: [`> ${text}`], lastToolCall }
      }
      return { lines: [], lastToolCall }
    }
    case 'assistant/message': {
      const lines: string[] = []
      for (const block of event.data.message.content) {
        if (block.type === 'reasoning') {
          if (showReasoning) {
            const text = block.text.trim()
            if (text !== '') lines.push(`  · ${text}`)
          }
        } else if (block.type === 'text') {
          const text = block.text.trim()
          if (text !== '') lines.push(text)
        }
      }
      return { lines, lastToolCall }
    }
    case 'tool/call':
      return { lines: [`◇ ${event.data.name}`], lastToolCall: event.data.name }
    case 'tool/result': {
      const result = contentText(event.data.message.content).trim()
      const preview = result.length > TOOL_RESULT_PREVIEW_CHARS
        ? `${result.slice(0, TOOL_RESULT_PREVIEW_CHARS)}…`
        : result
      const label = lastToolCall === undefined ? '' : ` ${lastToolCall}`
      const line = event.data.error === undefined
        ? `✓${label}${preview === '' ? '' : `: ${preview}`}`
        : `✗${label} (${event.data.error.code})${preview === '' ? '' : `: ${preview}`}`
      return { lines: [line], lastToolCall }
    }
    case 'turn/end': {
      const line = event.data.reason.kind === 'error' ? `✗ ${event.data.reason.error.message}` : undefined
      return line === undefined ? { lines: [], lastToolCall } : { lines: [line], lastToolCall }
    }
    default:
      return { lines: [], lastToolCall }
  }
}

/** A queued human prompt the editor's next submit resolves. */
interface PendingPrompt {
  prompt: string
  resolve(text: string): void
}

/**
 * Mount the terminal front door. Fails before mounting when either process
 * stream is not a TTY, so scripts and pipes get a clear error instead of a
 * blank terminal. On a TTY it starts a fullscreen pi-tui surface and, once the
 * application settles, creates one agent and renders its session transcript.
 * @param ctx - plugin context carrying the agent registry, default model, and launcher exit request.
 * @returns the disposer that releases the terminal on unload.
 */
export function apply(ctx: Context): () => void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'dsh: the interactive terminal front end requires stdin and stdout TTYs; use `dsh --profile headless "<task>"` for scripts and pipes',
    )
  }

  const terminal = new ProcessTerminal()
  const tui = new TuiAltScreen(terminal)
  const transcript = new Text('DeepSeek Harness — interactive terminal\n', 1, 0)
  const status = new Text('', 1, 0)
  const footer = new Text('', 1, 0)
  const editor = new Editor(tui, EDITOR_THEME, { paddingX: 1 })

  // Component invalidation does not schedule a redraw on its own; every
  // programmatic text change below re-requests the render explicitly.
  const setStatus = (text: string): void => { status.setText(text); tui.requestRender() }
  const setTranscriptText = (text: string): void => {
    transcript.setText(text)
    tui.requestRender()
  }
  const promptValues = new Map<string, string>()
  let footerBase = ''
  const renderFooter = (): void => {
    const extra = [...promptValues.values()].join(' · ')
    footer.setText(`${footerBase}${extra === '' ? '' : ` · ${extra}`}`)
    tui.requestRender()
  }

  // A FIFO of pending human prompts (questions and approvals) the editor's
  // next submit resolves; the removed TUI shared one such queue across
  // question dialogs, approvals, and overlays.
  const promptQueue: PendingPrompt[] = []
  let activePrompt: PendingPrompt | undefined
  const askText = (prompt: string): Promise<string> => new Promise((resolve) => {
    promptQueue.push({ prompt, resolve })
    drainPromptQueue()
  })
  const drainPromptQueue = (): void => {
    if (activePrompt !== undefined) return
    const next = promptQueue.shift()
    if (next === undefined) return
    activePrompt = next
    setStatus(next.prompt)
    editor.setText('')
    tui.setFocus(editor)
  }
  const settlePrompt = (text: string): void => {
    if (activePrompt === undefined) return
    const resolve = activePrompt.resolve
    activePrompt = undefined
    setStatus('')
    resolve(text)
    drainPromptQueue()
  }

  editor.onSubmit = (text) => {
    editor.addToHistory(text)
    if (activePrompt !== undefined) {
      settlePrompt(text)
      return
    }
    setStatus('agent not ready yet')
  }

  tui.addChild(new VStack([transcript, status, footer, editor]))
  tui.setFocus(editor)
  tui.start()

  let stopped = false
  function stop(): void {
    if (stopped) return
    stopped = true
    removeInputListener()
    tui.stop()
    const exit = ctx.get('appExit')
    exit?.(0)
  }

  const removeInputListener = tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl('d')) || matchesKey(data, Key.ctrl('c'))) {
      stop()
      return { consume: true }
    }
    return undefined
  })

  // Modal-overlay extension seam: plugins open fullscreen overlays through the
  // same pi-tui overlay stack the TUI owns.
  ctx.provide('tui', {
    openOverlay: (component: Component, options?: OverlayOptions): OverlayHandle =>
      tui.showOverlay(component, options),
  })

  // Status-line extension seam: plugins register named footer fragments the
  // terminal coalesces, so the plugin ecosystem can surface status in the TUI.
  ctx.provide('tuiPrompt', {
    register: (fragmentName: string, fragment: string): (() => void) => {
      promptValues.set(fragmentName, fragment)
      renderFooter()
      return () => {
        promptValues.delete(fragmentName)
        renderFooter()
      }
    },
    values: () => promptValues,
  })

  // Wire the agent after the whole application settles, so its scoped tools
  // and adapters are not half-composed.
  void (async () => {
    setStatus('wiring agent…')
    await ctx.get('loader')?.await()
    const agents = ctx.get('agents')
    const defaultModel = ctx.get('agentDefaultModel')
    if (agents === undefined || defaultModel === undefined) {
      setStatus('error: agent registry unavailable')
      return
    }

    const selection = defaultModel.currentSelection()
    // Mutable selection the terminal /model command switches; prompt assembly
    // snapshots it before each step so a switch takes effect on the next one.
    const modelSelection: ModelSelectionRef = { current: selection, assembled: undefined }
    const setup = (agentCtx: Context): void => {
      installModelSelection(agentCtx, modelSelection)
    }
    const agentOptions = { provider: selection.provider, model: selection.model }
    const resumeTarget = (ctx.get('cliStartup') as { resume?: string } | undefined)?.resume
    // A persisted session resumes through the registry; otherwise a fresh
    // session is created with a process-local id.
    const { agent } = resumeTarget === undefined
      ? await agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        agentOptions,
        setup,
      })
      : await agents.resume({
        resumeSessionId: SessionId(resumeTarget),
        agentOptions,
        setup,
      })

    // Append-origin incremental transcript: fold only newly appended events, so
    // a long session re-renders in O(new) instead of re-folding the whole log.
    const transcriptLines: string[] = []
    let lastFoldedSeq = -1
    let lastToolCall: string | undefined
    let showReasoning = true

    const render = (): void => {
      let changed = false
      for (const event of agent.session.events) {
        if (event.seq <= lastFoldedSeq) continue
        const folded = foldEventLines(event, lastToolCall, showReasoning)
        lastToolCall = folded.lastToolCall
        transcriptLines.push(...folded.lines)
        lastFoldedSeq = event.seq
        changed = true
      }
      if (changed) setTranscriptText(transcriptLines.join('\n'))
      const measurement = ctx.get('tokenMeter')?.measure(agent.session)
      footerBase = `${modelSelection.current?.model ?? selection.model} · ${measurement?.totalTokens ?? 0} tokens`
      renderFooter()
    }
    ctx.on('session/event', (session) => {
      if (session.id !== agent.session.id) return
      render()
    })
    render()
    setStatus('')

    // Register the terminal-local slash commands. Known commands execute in
    // the UI command plane; their result text never enters the model.
    const commands = ctx.get('commands')
    if (commands !== undefined) {
      commands.register({
        name: 'help',
        description: 'list commands',
        recordInput: false,
        handler: () => ({
          kind: 'success',
          text: commands.list(agent).map(d => `/${d.name} — ${d.description}`).join('\n'),
        }),
      })
      commands.register({
        name: 'status',
        description: 'show session and model status',
        recordInput: false,
        handler: () => {
          const measurement = ctx.get('tokenMeter')?.measure(agent.session)
          return {
            kind: 'success',
            text: [
              `session ${agent.session.id}`,
              `model ${modelSelection.current?.model ?? selection.model}`,
              `${agent.session.events.length} events`,
              `${measurement?.totalTokens ?? 0} tokens`,
            ].join('\n'),
          }
        },
      })
      commands.register({
        name: 'exit',
        description: 'exit the terminal',
        recordInput: false,
        handler: () => {
          stop()
          return { kind: 'success' }
        },
      })
      commands.register({
        name: 'clear',
        description: 'clear the visible transcript',
        recordInput: false,
        handler: () => {
          transcriptLines.length = 0
          lastFoldedSeq = agent.session.seq
          lastToolCall = undefined
          render()
          return { kind: 'success' }
        },
      })
      commands.register({
        name: 'details',
        description: 'toggle reasoning display',
        recordInput: false,
        handler: () => {
          showReasoning = !showReasoning
          // Toggling changes every assistant fold, so rebuild from scratch.
          transcriptLines.length = 0
          lastFoldedSeq = -1
          lastToolCall = undefined
          render()
          return { kind: 'success', text: `reasoning ${showReasoning ? 'on' : 'off'}` }
        },
      })
      commands.register({
        name: 'model',
        description: 'list or select the model',
        handler: async (invocation) => {
          const provider = modelSelection.current?.provider ?? selection.provider
          const currentModel = modelSelection.current?.model ?? selection.model
          const target = invocation.rawInput.trim()
          if (target === '') {
            const llm = ctx.get('llm')
            if (llm === undefined) return { kind: 'success', text: `current model: ${provider}/${currentModel}` }
            const models = await llm.listModels(provider)
            if (models.length === 0) return { kind: 'success', text: `current model: ${provider}/${currentModel}` }
            return {
              kind: 'success',
              text: models
                .map(model => `${model.id === currentModel ? '→ ' : '  '}${model.id} — ${model.name}`)
                .join('\n'),
            }
          }
          modelSelection.current = { provider, model: target }
          return { kind: 'success', text: `model set to ${provider}/${target}` }
        },
      })
    }

    // Answer the model's `ask_user_question` tool through the shared prompt queue.
    const userQuestions = ctx.get('userQuestions')
    if (userQuestions === undefined) {
      setStatus('error: userQuestions service unavailable')
      return
    }
    userQuestions.registerProvider({
      ask: async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
        const answers = []
        for (const question of request.questions) {
          const label = question.header === undefined ? question.question : `${question.header}: ${question.question}`
          const custom = await askText(label)
          answers.push({ id: question.id, selected: [], custom })
        }
        return { answers }
      },
    })

    // Answer the approval waterfall: a clear `y` grants this one call, anything
    // else rejects (fail-closed is the seam's own default).
    ctx.on('approval/request', (req) => {
      const reason = req.reason === undefined ? '' : ` — ${req.reason}`
      return askText(`Approve "${req.toolName}"${reason}? [y/n]`).then((text) => {
        const answer = text.trim().toLowerCase()
        return answer === 'y' || answer === 'yes' ? 'allowed-once' : 'rejected'
      })
    })

    const runCommand = async (line: string): Promise<void> => {
      if (commands === undefined) {
        setStatus('commands unavailable')
        return
      }
      try {
        const signal = new AbortController().signal
        const execution = await commands.execute(agent, line, signal)
        if (execution === undefined) {
          setStatus(`unknown command: ${line}`)
          return
        }
        const result = execution.result
        if (result.kind === 'error') setStatus(result.text)
        else setStatus(result.text ?? '')
      } catch (error: unknown) {
        setStatus(`command failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    editor.onSubmit = (text) => {
      editor.addToHistory(text)
      if (activePrompt !== undefined) {
        settlePrompt(text)
        return
      }
      if (text.startsWith('/')) {
        void runCommand(text)
        return
      }
      const content = text.trim()
      if (content === '') return
      const message = createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'user' } })
      // Steering joins at the next step boundary while a turn runs; an idle
      // driver opens a new turn.
      if (agent.status === 'running') agent.steer(message)
      else agent.followup(message)
    }
  })().catch((error: unknown) => {
    setStatus(`error: ${error instanceof Error ? error.message : String(error)}`)
  })

  return stop
}
