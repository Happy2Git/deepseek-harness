/**
 * Fixed Codex one-shot subagent provider. Every accepted run starts a fresh
 * official `codex app-server --stdio` process in the delegating Session's
 * workspace and publishes only after an ephemeral thread exists.
 *
 * @module @deepseek-ai/dsh-subagent-codex
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  startCodexRun,
  type CodexRunSpec,
} from './run.ts'

export const name = 'subagent-codex'
export const inject = ['subagents', 'subprocess']

/** Deployment-owned environment and process-release bound. */
export interface Config {
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /** Grace in milliseconds for app-server process-tree termination. */
  disposeGraceMs?: number
  /**
   * Bare Codex app-server command name resolved from PATH. Defaults to
   * `codex`; an intranet build of the trimmed binary is `dsh_inner_codex`.
   * `binaryPath` wins when both are set.
   */
  binaryName?: string
  /**
   * Explicit Codex app-server executable path, resolved before `binaryName`.
   * Lets an intranet deployment point at `dsh_inner_codex` without polluting
   * PATH. Prefer this over `binaryName` when the executable is in a known
   * build directory.
   */
  binaryPath?: string
  /**
   * Loopback bridge + one-shot CODEX_HOME. When set, the plugin starts a
   * loopback-only reverse proxy, points the child's config.toml at it, and
   * converges every model request at `upstreamBaseUrl`. The API key still
   * travels via `env` under `DSH_CODEX_TOKEN`; a code-level caller may
   * additionally supply a credential resolver through the run spec.
   */
  loopback?: ConfigLoopback
}

/** Deployment-facing loopback bridge values (all data, serializable from yml). */
export interface ConfigLoopback {
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
}

export const Config: z<Config> = z.object({
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  binaryName: z.string().required(false),
  binaryPath: z.string().required(false),
  loopback: z.object({
    upstreamBaseUrl: z.string(),
    model: z.string(),
    path: z.string().required(false),
    wireApi: z.string().required(false),
    sandboxMode: z.string().required(false),
  }).required(false),
})

type ResolvedConfig = Required<Omit<Config, 'binaryName' | 'binaryPath' | 'loopback'>> & Config

class CodexProvider implements SubagentProvider {
  readonly name = 'codex'
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-codex: no working directory for the child — delegate from a parent session that has one',
      )
    }
    const binary = this.config.binaryPath !== undefined
      || this.config.binaryName !== undefined
      ? {
        ...(this.config.binaryName !== undefined
          ? { name: this.config.binaryName }
          : {}),
        ...(this.config.binaryPath !== undefined
          ? { path: this.config.binaryPath }
          : {}),
      }
      : undefined
    // schemastery turns an absent optional object into an empty object, so the
    // loopback bridge is only enabled when both required data fields are present.
    const loopbackConfig = this.config.loopback
    const loopback = 'upstreamBaseUrl' in (loopbackConfig ?? {})
      ? loopbackConfig
      : undefined
    const spec: CodexRunSpec = {
      cwd: resolveChildCwd(
        'subagent-codex',
        undefined,
        parentCwd,
      ),
      env: this.config.env,
      ...(binary !== undefined ? { binary } : {}),
      ...(loopback !== undefined ? { loopback } : {}),
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-codex: child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startCodexRun(request, spec)
  }
}

/**
 * Register the fixed `codex` provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - explicit child environment and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite(
    'subagent-codex',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-codex: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  for (const key of ['binaryName', 'binaryPath'] as const) {
    const value = resolved[key]
    if (value !== undefined && value.trim().length === 0) {
      throw new Error(`subagent-codex: ${key} must not be empty`)
    }
  }
  ctx.subagents.registerProvider(new CodexProvider(ctx, resolved))
}
