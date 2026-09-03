/**
 * @deepseek-ai/dsh-headless — one-shot direct Agent driver. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * creates one Agent through the core registry, drives the task to quiescence,
 * streams provider reasoning to stderr, flushes its Session, prints the final
 * assistant text to stdout, and exits. Driver flags parameterize the run:
 * `--model` overrides the default model, `--session-id` resumes or creates a
 * persisted session, `--mode` applies a permission preset, and `--jsonl`
 * streams NDJSON session events and reads approvals from stdin.
 *
 * @module @deepseek-ai/dsh-headless
 */

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'

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

/** `--mode` name to permission-preset key; `confirm` resolves dynamically. */
const MODE_PRESET: Record<string, string> = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'danger-full-access': 'danger-full-access',
}

/**
 * Resolve a `--mode` value to a composed permission-preset name. `confirm`
 * selects the write preset whose approval policy asks (workspace-write
 * sandbox + ask approval), so it tracks the composed table instead of
 * hardcoding a preset name. A first-match on `approval === 'ask'` alone is
 * not enough: dsh-base's table lists `read-only` (read-only + ask) before the
 * write presets, so `confirm` must constrain the sandbox too.
 * @param presets - the mounted permission-preset service.
 * @param mode - the validated `--mode` flag value.
 * @returns the preset name to apply.
 * @throws when the mode has no matching composed preset.
 */
function resolveModePreset(presets: PermissionPresetService, mode: string): string {
  if (mode === 'confirm') {
    for (const name of presets.names) {
      const spec = presets.resolve(name)
      if (spec.sandbox === 'workspace-write' && spec.approval === 'ask') return name
    }
    throw new Error('headless: --mode confirm requires a workspace-write preset with ask approval in the composed permission table')
  }
  const name = MODE_PRESET[mode]
  if (name === undefined || !presets.names.includes(name)) {
    throw new Error(`headless: unknown --mode ${JSON.stringify(mode)}`)
  }
  return name
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
function summarize(session: Session, firstSeq: SessionLogOffset): RunOutcome {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  const length = session.seq
  for (let seq = firstSeq; seq < length; seq++) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) {
      throw new Error(`headless summary cannot read seq ${String(seq)} below captured length ${String(length)}`)
    }
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

/**
 * Project provider-reported reasoning from one owned run to stderr as it is
 * appended, while keeping final outcome derivation on the durable log.
 * @param ctx - plugin context carrying the Session event feed.
 * @param agent - the exact Agent whose reasoning belongs to this invocation.
 * @param stderr - progress output sink.
 * @returns a disposer that also terminates an unterminated reasoning line.
 */
function streamReasoning(
  ctx: Context,
  agent: Agent,
  stderr: HeadlessIo['stderr'],
): () => void {
  let started = false
  let open = false
  let endsWithNewline = true
  const close = (): void => {
    if (!open) return
    if (!endsWithNewline) stderr.write('\n')
    open = false
    endsWithNewline = true
  }
  const dispose = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'turn/start') {
      close()
      started = true
      return
    }
    if (!started || event.type !== 'assistant/chunk') return
    const chunk = event.data.chunk
    switch (chunk.type) {
      case 'reasoning-delta':
        if (chunk.text === '') return
        if (!open) {
          stderr.write('dsh: reasoning:\n')
          open = true
        }
        stderr.write(chunk.text)
        endsWithNewline = chunk.text.endsWith('\n')
        return
      case 'block-start':
        if (chunk.blockType !== 'reasoning') close()
        return
      case 'block-end':
        if (chunk.block.type !== 'reasoning') close()
        return
      case 'usage':
        return
      case 'text-delta':
      case 'tool-call-delta':
      case 'finish':
        close()
        return
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(chunk, 'headless reasoning stream')
    }
  })
  return () => {
    dispose()
    close()
  }
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io: HeadlessIo, error: unknown): void {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * Wire `--jsonl` machine-readable event output. Streams every owned session
 * event as one NDJSON line and answers `approval/request` from stdin lines of
 * the form `{"type":"approval/response","outcome":"allowed-once","callId":"…"}`.
 * @param ctx - plugin context carrying the Session event feed.
 * @param agent - the owned agent whose session is streamed.
 * @param io - process-facing effects.
 * @returns the stdin readline to close on teardown, or undefined outside jsonl.
 */
function wireJsonl(
  ctx: Context,
  agent: Agent,
  io: HeadlessIo,
): ReturnType<typeof createInterface> | undefined {
  const rl = createInterface({ input: process.stdin })
  // One pending settlement per request, keyed by call id so parallel tool
  // calls cannot overwrite each other. A Map preserves insertion order, so
  // its first key is the oldest outstanding request; a response without a
  // call id answers that one, and deleting a call-id hit keeps the remaining
  // order intact.
  const pendingApprovals = new Map<string, (outcome: ApprovalOutcome) => void>()
  let syntheticId = 0
  rl.on('line', (line) => {
    try {
      const message = JSON.parse(line) as { type?: string; outcome?: ApprovalOutcome; callId?: string | null }
      if (message.type !== 'approval/response' || message.outcome === undefined) return
      let key: string | undefined
      if (message.callId === undefined || message.callId === null) {
        // No call id: answer the oldest outstanding request (the simplest
        // stdin consumer does not echo back the call id it was handed).
        key = pendingApprovals.keys().next().value
      } else if (pendingApprovals.has(message.callId)) {
        key = message.callId
      } else {
        // A non-empty call id that matches nothing is stale or unknown;
        // answering the oldest request would mis-route it, so drop it.
        return
      }
      if (key === undefined) return
      const resolve = pendingApprovals.get(key)
      pendingApprovals.delete(key)
      resolve?.(message.outcome)
    } catch { /* ignore malformed input lines */ }
  })
  // Claim every approval request in this process; a caller that wants the
  // composed answerer chain must not mount --jsonl.
  ctx.on('approval/request', (request: ApprovalRequest, next) => {
    io.stdout.write(JSON.stringify({
      type: 'approval/request',
      toolName: request.toolName,
      callId: request.callId ?? null,
      reason: request.reason ?? null,
    }) + '\n')
    return new Promise<ApprovalOutcome>((resolve) => {
      pendingApprovals.set(request.callId ?? `approval-${syntheticId++}`, resolve)
    }).catch(() => next())
  })
  ctx.on('session/event', (session, event) => {
    if (session.id !== agent.session.id) return
    io.stdout.write(JSON.stringify({ type: event.type, data: event.data }) + '\n')
  })
  return rl
}

/**
 * Run one task through a freshly created or resumed Agent and request process
 * exit.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param config - validated task and driver flags.
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
  // --model overrides the default for BOTH the agent options and the installed
  // model selection, so the request waterfall cannot revert it to the default.
  const runSelection: ModelSelection = { ...selection, model: config.model ?? selection.model }
  const agentOptions = { provider: runSelection.provider, model: runSelection.model }
  const setup = (agentCtx: Context): void => {
    const selected: ModelSelectionRef = { current: runSelection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
  // create-once, resume-always: a --session-id resumes the persisted session
  // and falls back to creating it with that exact id only when the identity is
  // absent; every other resume failure (corruption, unsupported version, no
  // persistence backend) propagates instead of being downgraded to a create.
  const requestedSessionId = config.sessionId === undefined ? undefined : brandString<SessionId>(config.sessionId)
  const { agent } = requestedSessionId === undefined
    ? await agents.create({
      sessionId: brandString<SessionId>(`session-${randomUUID()}`),
      meta: { cwd: process.cwd() },
      agentOptions,
      setup,
    })
    : await agents.resume({
      resumeSessionId: requestedSessionId,
      agentOptions,
      setup,
    }).catch(async (error: unknown) => {
      if (error instanceof SessionPersistenceNotFoundError) {
        return agents.create({
          sessionId: requestedSessionId,
          meta: { cwd: process.cwd() },
          agentOptions,
          setup,
        })
      }
      throw error
    })
  // --jsonl registers its event feed and approval channel BEFORE --mode so
  // the owned permission events the preset set emits are captured too.
  const rl = config.jsonl === true ? wireJsonl(ctx, agent, io) : undefined
  try {
    if (config.mode !== undefined) {
      const permissionPresets = ctx.get('permissionPresets')
      if (permissionPresets === undefined) {
        throw new Error('headless: --mode requires the permission-presets service')
      }
      permissionPresets.set(agent.session, resolveModePreset(permissionPresets, config.mode))
    }
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    const stopReasoning = streamReasoning(ctx, agent, io.stderr)
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: config.task }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
    } finally {
      stopReasoning()
    }
    await sessions.flush(agent.session)
    const outcome = summarize(agent.session, firstSeq)
    if (config.jsonl === true) {
      io.stdout.write(JSON.stringify({ type: 'done', reason: outcome.reason?.kind ?? 'completed', text: outcome.text }) + '\n')
    } else {
      io.stdout.write(outcome.text + '\n')
    }
    if (outcome.reason?.kind === 'error') {
      io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
    }
    io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)
  } finally {
    // Close the approval readline even when a wait/flush/summarize throws, so
    // the process is not pinned by a dangling stdin interface.
    rl?.close()
  }
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
