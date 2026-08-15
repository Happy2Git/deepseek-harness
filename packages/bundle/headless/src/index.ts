/**
 * @deepseek-ai/dsh-headless — one-shot direct Agent driver. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * creates one Agent through the core registry, drives the task to quiescence,
 * flushes its Session, prints the final assistant text, and exits.
 *
 * @module @deepseek-ai/dsh-headless
 */

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
// Empty type imports carry the loader Context merge for the settlement await,
// the cmdline Context merge for the appExit host value, and the
// permission-presets / approval service merges for the --mode / --jsonl paths.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-user-approval'

/** Stable Cordis plugin name. */
export const name = 'headless-runner'

/** Core services required before the one-shot turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config: the task resolved from this app's injected provider service. */
export interface Config {
  /** The prompt text for the single run. */
  task: string
  /** Persisted session id to create-or-resume; a fresh id is minted when absent. */
  sessionId?: string
  /** Model id overriding the default selection for this run. */
  model?: string
  /** Permission mode: `read-only`, `workspace-write`, `danger-full-access`, or `confirm`. */
  mode?: string
  /** Stream NDJSON session events and read approvals from stdin. */
  jsonl?: boolean
}

export const Config: z<Config> = z.object({
  task: z.string().required(),
  sessionId: z.string(),
  model: z.string(),
  mode: z.string(),
  jsonl: z.boolean(),
})

/** `--mode` name to permission-preset key; `confirm` maps to the ask-approval preset. */
const MODE_PRESET: Record<string, string> = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'danger-full-access': 'danger-full-access',
  confirm: 'workspace-write',
}

/** Outcome of one owned run interval. */
interface RunOutcome {
  text: string
  reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
}

/** Process-facing effects of one run: output streams plus the launcher's bounded exit request. */
interface HeadlessIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** The process streams the runner writes to; tests substitute captures. */
export const internals: { stdout: HeadlessIo['stdout']; stderr: HeadlessIo['stderr'] } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Aggregate the last assistant text and turn outcome in one owned interval. */
function summarize(events: readonly SessionEvent[], firstSeq: number): RunOutcome {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io: HeadlessIo, error: unknown): void {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * Run one task through a freshly created Agent and request process exit.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param task - one-shot task text.
 * @param io - process-facing effects.
 */
async function run(ctx: Context, config: Config, io: HeadlessIo): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  const agentOptions = { provider: selection.provider, model: config.model ?? selection.model }
  const setup = (agentCtx: Context): void => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
  // create-once, resume-always: a --session-id resumes the persisted session
  // and falls back to creating it with that exact id. A run without it mints a
  // fresh process-local id.
  const requestedSessionId = config.sessionId === undefined ? undefined : SessionId(config.sessionId)
  const { agent } = requestedSessionId === undefined
    ? await agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions,
      setup,
    })
    : await agents.resume({
      resumeSessionId: requestedSessionId,
      agentOptions,
      setup,
    }).catch(async () => agents.create({
      sessionId: requestedSessionId,
      meta: { cwd: process.cwd() },
      agentOptions,
      setup,
    }))
  if (config.mode !== undefined) {
    const permissionPresets = ctx.get('permissionPresets')
    const preset = MODE_PRESET[config.mode]
    if (permissionPresets === undefined || preset === undefined) {
      throw new Error(`headless: unknown --mode ${JSON.stringify(config.mode)}`)
    }
    permissionPresets.set(agent.session, preset)
  }
  // --jsonl turns stdout into a machine-readable event stream: each owned
  // session event as one JSON line, approvals as an interactive request on
  // stdout answered by an `approval/response` line on stdin.
  const rl = config.jsonl === true ? createInterface({ input: process.stdin }) : undefined
  if (config.jsonl === true) {
    let pendingApproval: ((outcome: ApprovalOutcome) => void) | undefined
    rl?.on('line', (line) => {
      try {
        const message = JSON.parse(line) as { type?: string; outcome?: ApprovalOutcome }
        if (message.type === 'approval/response' && pendingApproval !== undefined && message.outcome !== undefined) {
          const resolve = pendingApproval
          pendingApproval = undefined
          resolve(message.outcome)
        }
      } catch { /* ignore malformed input lines */ }
    })
    ctx.on('approval/request', (req) => {
      io.stdout.write(JSON.stringify({
        type: 'approval/request',
        toolName: req.toolName,
        callId: req.callId ?? null,
        reason: req.reason ?? null,
      }) + '\n')
      return new Promise<ApprovalOutcome>((resolve) => { pendingApproval = resolve })
    })
    ctx.on('session/event', (session, event) => {
      if (session.id !== agent.session.id) return
      io.stdout.write(JSON.stringify({ type: event.type, data: event.data }) + '\n')
    })
  }
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: config.task }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await sessions.flush(agent.session)
  const outcome = summarize(agent.session.events, firstSeq)
  if (config.jsonl === true) {
    io.stdout.write(JSON.stringify({ type: 'done', reason: outcome.reason?.kind ?? 'completed', text: outcome.text }) + '\n')
  } else {
    io.stdout.write(outcome.text + '\n')
  }
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  }
  rl?.close()
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
}

/**
 * Mount the one-shot direct driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated task config.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('headless-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: HeadlessIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error: unknown) => { fail(io, error) })
}
