/**
 * Environment scrub for the one-shot Codex child.
 *
 * The scrub is a second defense behind the trimmed binary's own fail-closed
 * contract: it removes every proxy and telemetry variable that could redirect
 * loopback model traffic or reactivate an exporter, points CODEX_HOME at the
 * disposable home, and clears any OpenAI credential so the child never holds a
 * far-end key it does not need.
 *
 * @module @deepseek-ai/dsh-subagent-codex/env-scrub
 */

/** Variables deleted outright (never inherited by the child). */
const DELETED = new Set([
  'OPENAI_API_KEY',
  'OPENAI_ORG_ID',
  'OPENAI_BASE_URL',
  'CHATGPT_CUSTOM_STORAGE',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_SERVICE_NAME',
  'STATSIG_API_KEY',
])

/** Variables forced to an empty value. */
const EMPTIED = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'FTP_PROXY',
])

/** Normalized NO_PROXY so loopback and localhost are never proxied. */
const NO_PROXY_VALUE = '127.0.0.1,localhost'

/**
 * Scrub the explicit deployment-override layer for one run.
 *
 * The subprocess seam already scrubs credential-shaped names from the ambient
 * parent; this pass removes telemetry/proxy names that would otherwise
 * activate regardless, pins `NO_PROXY` so loopback model traffic is never
 * proxied, and drops any far-end credential the one-shot child does not need.
 * Callers layer run-specific values (e.g. `CODEX_HOME`) on the result.
 * @param overrides - the deployment's explicit `Config.env` entries.
 * @returns the scrubbed override layer handed to the child.
 */
export function scrubChildEnv(
  overrides: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(overrides)) {
    if (DELETED.has(key)) continue
    env[key] = EMPTIED.has(key) ? '' : value
  }
  // Force-proxy pins win regardless of whether the caller supplied them, so a
  // host proxy can never redirect the child's loopback model traffic.
  for (const key of EMPTIED) env[key] = ''
  env.NO_PROXY = NO_PROXY_VALUE
  return env
}
