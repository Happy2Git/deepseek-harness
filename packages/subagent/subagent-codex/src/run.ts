/**
 * One-shot Codex child lifecycle: spawn the real app-server through the
 * subprocess seam, publish only after initialization and ephemeral thread
 * creation, flatten post-publication failures, and dispose to whole-tree
 * quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-codex/run
 */

import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  startLoopbackBridge,
  type BridgeCredentialResolver,
  type LoopbackBridge,
} from './bridge.ts'
import {
  createCodexHome,
  type CodexHome,
} from './codex-home.ts'
import { scrubChildEnv } from './env-scrub.ts'
import { CodexAppServerWire } from './wire.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** How to locate the Codex app-server executable. */
export interface CodexBinary {
  /**
   * Bare command name resolved from PATH. Defaults to `codex`; an intranet
   * deployment points it at `dsh_inner_codex`.
   */
  readonly name?: string
  /**
   * Explicit executable path, resolved before `name`. The path is
   * deployment-trusted configuration, never task text, so the shell boundary
   * stays constant per run.
   */
  readonly path?: string
}

/**
 * Resolve the fixed app-server command for a platform.
 *
 * Windows npm and pnpm installs expose `codex.cmd`, which requires `cmd.exe`;
 * the argv is constant so no task or configuration text enters the
 * shell boundary. A `binaryPath` carries the same deployment-trust property.
 * @param platform - host platform used to select the executable boundary.
 * @param binary - command name or explicit path, both resolved into one argv.
 * @returns argv for the fixed Codex app-server command.
 */
export function codexAppServerArgv(
  platform: NodeJS.Platform = process.platform,
  binary: CodexBinary = {},
): string[] {
  const command = binary.path ?? binary.name ?? 'codex'
  return platform === 'win32'
    ? ['cmd.exe', '/d', '/s', '/c', command, 'app-server', '--stdio']
    : [command, 'app-server', '--stdio']
}

/**
 * Loopback proxy + one-shot home to spin up for an intranet run. When present,
 * `startCodexRun` starts the bridge, writes a fresh CODEX_HOME whose
 * `base_url` is that bridge, scrubs the child environment, and releases all
 * three on teardown. Absent by default, which preserves the existing
 * direct-spawn behavior.
 */
export interface CodexLoopback {
  /** The single intranet model endpoint the bridge may reach. */
  readonly upstreamBaseUrl: string
  /** Intranet model id the app-server must use. */
  readonly model: string
  /** Responses path; defaults to `/v1/responses`. */
  readonly path?: string
  /** Wire API advertised; defaults to `responses`. */
  readonly wireApi?: string
  /** Sandbox mode; defaults to `read-only`. */
  readonly sandboxMode?: string
  /**
   * Optional Authorization replacement hook. When set, the real key stays out
   * of the child environment and the bridge injects it per upstream request.
   */
  readonly credential?: BridgeCredentialResolver
}

/** Fully resolved inputs for one Codex app-server run. */
export interface CodexRunSpec {
  /** Parent Session workspace, also supplied to `thread/start`. */
  readonly cwd: string
  /** Explicit deployment/test environment layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Codex executable location; defaults to `codex` from PATH. */
  readonly binary?: CodexBinary
  /** Loopback proxy + one-shot home; absent keeps direct-spawn behavior. */
  readonly loopback?: CodexLoopback
  /** Subprocess termination grace passed to the shared process-tree owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed subprocess/wire failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact non-empty text block sequence.
 */
export function textTask(prompt: readonly ContentBlock[]): string[] {
  if (prompt.length === 0) {
    throw new Error('subagent-codex: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-codex: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-codex: the one-shot task must not be empty')
  }
  return texts
}

/**
 * Close the private wire, terminate the managed process tree, and wait for the
 * subprocess owner to prove it is gone.
 * @param wire - private app-server protocol connection.
 * @param child - shared-service handle that owns the process tree.
 */
export async function disposeCodexChild(
  wire: CodexAppServerWire,
  child: SubprocessHandle,
): Promise<void> {
  wire.close()
  if (child.pid <= 0) {
    await child.done.catch(() => {})
    return
  }
  try {
    child.stdin?.end()
  } catch {
    // A concurrently closed stdin does not change tree ownership below.
  }
  child.terminate()
  await child.waitForExit()
  await child.done
}

/**
 * Start the real `codex app-server --stdio` child and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after initialization and ephemeral thread creation.
 */
export async function startCodexRun(
  request: SubagentStartRequest,
  spec: CodexRunSpec,
): Promise<SubagentRun> {
  const texts = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-codex: request was aborted before app-server startup')
  }

  // Spin up the loopback bridge and one-shot home before spawning the child so
  // config.toml can point at the bridge's freshly allocated port. Any partial
  // setup is released on failure.
  let bridge: LoopbackBridge | undefined
  let home: CodexHome | undefined
  if (spec.loopback !== undefined) {
    bridge = await startLoopbackBridge({
      upstreamBaseUrl: spec.loopback.upstreamBaseUrl,
      ...(spec.loopback.path !== undefined ? { path: spec.loopback.path } : {}),
      ...(spec.loopback.credential !== undefined
        ? { credential: spec.loopback.credential }
        : {}),
    })
    try {
      home = createCodexHome({
        model: spec.loopback.model,
        baseUrl: bridge.baseUrl,
        ...(spec.loopback.wireApi !== undefined
          ? { wireApi: spec.loopback.wireApi }
          : {}),
        ...(spec.loopback.sandboxMode !== undefined
          ? { sandboxMode: spec.loopback.sandboxMode }
          : {}),
      })
    } catch (error: unknown) {
      await bridge.close().catch(() => {})
      throw error
    }
  }
  const releaseLoopback = async (): Promise<void> => {
    // Release both resources even if one throws, so a failed home removal can
    // never leak the bridge's port (or vice versa) across a teardown.
    const errors: unknown[] = []
    try { await home?.dispose() } catch (error: unknown) { errors.push(error) }
    try { await bridge?.close() } catch (error: unknown) { errors.push(error) }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'subagent-codex: loopback release failed')
    }
  }

  // The scrub only applies in loopback mode; direct-spawn keeps the exact
  // environment a caller supplied so existing deployments are unchanged.
  const childEnv = spec.loopback !== undefined
    ? scrubChildEnv(spec.env)
    : spec.env
  if (home !== undefined) childEnv.CODEX_HOME = home.dir

  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: codexAppServerArgv(process.platform, spec.binary),
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: spec.disposeGraceMs,
      env: childEnv,
    })
  } catch (error: unknown) {
    await releaseLoopback()
    throw error
  }

  const wire = new CodexAppServerWire(
    child.stdout as NonNullable<SubprocessHandle['stdout']>,
    child.stdin as NonNullable<SubprocessHandle['stdin']>,
  )
  const disposeProcess = async (): Promise<void> => {
    await disposeCodexChild(wire, child)
    await releaseLoopback()
  }

  const processFailure: Promise<never> = child.done.then(
    outcome => Promise.reject(new Error(
      'subagent-codex: app-server exited before the run settled '
      + `(code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`,
    )),
    (error: unknown) => Promise.reject(thrown(error)),
  )
  // A normal post-result dispose also closes the process. Keep that expected
  // late rejection observed after the result race has already settled.
  processFailure.catch(() => {})

  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-codex: run cancelled locally'))
    wire.interrupt()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  try {
    wire.start()
    await Promise.race([wire.initialize(request.signal), processFailure])
    await Promise.race([wire.startThread(spec.cwd, request.signal), processFailure])
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    try {
      await disposeProcess()
    } catch (disposeError: unknown) {
      throw new AggregateError(
        [thrown(error), thrown(disposeError)],
        'subagent-codex: startup failed and app-server cleanup also failed',
      )
    }
    if (runAbort.signal.aborted) {
      throw new Error('subagent-codex: request was aborted before run publication')
    }
    throw thrown(error)
  }

  const collectOutput = (): ContentBlock[] => wire.collectOutput()
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: () => Promise.race([
      wire.runTurn(texts, runAbort.signal),
      processFailure,
    ]),
    collectOutput,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: SessionId(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}
