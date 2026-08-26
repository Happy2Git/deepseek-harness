/**
 * One-shot CODEX_HOME generation with a locked config.toml.
 *
 * The trimmed `dsh_inner_codex` fail-closes every provider to a loopback base
 * URL, so this module writes a config whose `base_url` is the loopback bridge
 * endpoint. Each run gets a fresh home so no config, session, or rollout state
 * survives the run; the caller is responsible for disposing it after teardown.
 *
 * @module @deepseek-ai/dsh-subagent-codex/codex-home
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The fixed provider id the CODEX_HOME config uses for the loopback bridge. */
export const LOOPBACK_PROVIDER_ID = 'dsh-loopback'

/** Environment variable name that carries the (dummy or real) token. */
export const LOOPBACK_ENV_KEY = 'DSH_CODEX_TOKEN'

/** Values that drive one locked config.toml. */
export interface CodexHomeTemplate {
  /** Model id the app-server must use, e.g. an intranet model name. */
  readonly model: string
  /** Loopback endpoint handed to Codex, always `http://127.0.0.1:<port>/v1`. */
  readonly baseUrl: string
  /** Sandbox mode applied to every one-shot run. Defaults to \`read-only\`. */
  readonly sandboxMode?: string
  /** Wire API advertised to Codex; default is the Responses protocol. */
  readonly wireApi?: string
}

/** A freshly generated, disposable CODEX_HOME. */
export interface CodexHome {
  /** Absolute path of the one-shot home directory. */
  readonly dir: string
  /** Absolute path of the locked `config.toml` within it. */
  readonly configPath: string
  /** Remove the directory and all rolled-out session state. */
  dispose(): Promise<void>
}

/**
 * Render the locked config.toml for a one-shot run.
 *
 * Keys are pinned to the fail-closed contract of the trimmed binary: the
 * provider id is fixed, the base URL is the loopback bridge, analytics and
 * every OTel exporter are disabled. No key material is written here — the
 * value for `env_key` is injected through the child environment.
 * @param template - model, upstream loopback endpoint, and run policy.
 * @returns the exact TOML text to write to the home's `config.toml`.
 */
export function renderCodexConfig(template: CodexHomeTemplate): string {
  const wireApi = template.wireApi ?? 'responses'
  const sandboxMode = template.sandboxMode ?? 'read-only'
  return [
    `model = "${template.model}"`,
    `model_provider = "${LOOPBACK_PROVIDER_ID}"`,
    'approval_policy = "never"',
    `sandbox_mode = "${sandboxMode}"`,
    'disable_response_storage = true',
    'check_for_update_on_startup = false',
    '',
    `[model_providers.${LOOPBACK_PROVIDER_ID}]`,
    `name = "${LOOPBACK_PROVIDER_ID} bridge"`,
    `base_url = "${template.baseUrl}"`,
    `env_key = "${LOOPBACK_ENV_KEY}"`,
    `wire_api = "${wireApi}"`,
    'requires_openai_auth = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[otel]',
    'exporter = "none"',
    'trace_exporter = "none"',
    'metrics_exporter = "none"',
    '',
  ].join('\n')
}

/**
 * Create a fresh one-shot CODEX_HOME and write its locked config.
 *
 * The directory and `config.toml` are created synchronously so the caller can
 * reference them before spawning the child. Disposal is idempotent.
 * @param template - the locked config values.
 * @returns the created home and its config path.
 */
export function createCodexHome(template: CodexHomeTemplate): CodexHome {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-codex-home-'))
  // Rollout/session state stays inside the disposable tree even when the
  // run's sandbox policy normally suppresses it.
  mkdirSync(join(dir, 'rollout'), { recursive: true })
  const configPath = join(dir, 'config.toml')
  writeFileSync(configPath, renderCodexConfig(template))
  let disposed = false
  return {
    dir,
    configPath,
    dispose(): Promise<void> {
      if (disposed) return Promise.resolve()
      disposed = true
      rmSync(dir, { recursive: true, force: true })
      return Promise.resolve()
    },
  }
}
