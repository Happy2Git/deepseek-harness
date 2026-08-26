import { existsSync, readFileSync, rmSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createCodexHome,
  LOOPBACK_ENV_KEY,
  LOOPBACK_PROVIDER_ID,
  renderCodexConfig,
  type CodexHomeTemplate,
} from '../src/codex-home.ts'
import { scrubChildEnv } from '../src/env-scrub.ts'

const baseTemplate: CodexHomeTemplate = {
  model: 'intranet-model',
  baseUrl: 'http://127.0.0.1:54321/v1',
}

describe('renderCodexConfig', () => {
  it('pins the loopback provider id and base URL', () => {
    const toml = renderCodexConfig(baseTemplate)
    expect(toml).toContain('model = "intranet-model"')
    expect(toml).toContain(`model_provider = "${LOOPBACK_PROVIDER_ID}"`)
    expect(toml).toContain('base_url = "http://127.0.0.1:54321/v1"')
  })

  it('references the DSH token env key, not a literal secret', () => {
    const toml = renderCodexConfig(baseTemplate)
    expect(toml).toContain(`env_key = "${LOOPBACK_ENV_KEY}"`)
    expect(toml).not.toContain('sk-')
    expect(toml).not.toContain('authorization')
  })

  it('disables analytics and every OTel exporter', () => {
    const toml = renderCodexConfig(baseTemplate)
    expect(toml).toContain('[analytics]')
    expect(toml).toContain('enabled = false')
    expect(toml).toContain('exporter = "none"')
    expect(toml).toContain('trace_exporter = "none"')
    expect(toml).toContain('metrics_exporter = "none"')
  })

  it('honours override wire API and sandbox mode', () => {
    const toml = renderCodexConfig({
      ...baseTemplate,
      wireApi: 'chat/completions',
      sandboxMode: 'workspace-write',
    })
    expect(toml).toContain('wire_api = "chat/completions"')
    expect(toml).toContain('sandbox_mode = "workspace-write"')
  })
})

describe('createCodexHome', () => {
  it('creates a home directory and locked config, then disposes it', async () => {
    const home = createCodexHome(baseTemplate)
    expect(existsSync(home.dir)).toBe(true)
    expect(existsSync(home.configPath)).toBe(true)
    expect(readFileSync(home.configPath, 'utf8')).toContain(
      `[model_providers.${LOOPBACK_PROVIDER_ID}]`,
    )
    await home.dispose()
    expect(existsSync(home.dir)).toBe(false)
  })

  it('is idempotent on dispose', async () => {
    const home = createCodexHome(baseTemplate)
    await home.dispose()
    await home.dispose()
    expect(existsSync(home.dir)).toBe(false)
    rmSync(home.dir, { recursive: true, force: true })
  })
})

describe('scrubChildEnv', () => {
  it('drops far-end and telemetry credentials and pins NO_PROXY', () => {
    const scrubbed = scrubChildEnv({
      OPENAI_API_KEY: 'sk-secret',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.example:4317',
      STATSIG_API_KEY: 'statsig-key',
      HTTP_PROXY: 'http://127.0.0.1:7892',
      HOME: '/tmp',
      DSH_CODEX_TOKEN: 'token',
    })
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined()
    expect(scrubbed.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined()
    expect(scrubbed.STATSIG_API_KEY).toBeUndefined()
    expect(scrubbed.HTTP_PROXY).toBe('')
    expect(scrubbed.NO_PROXY).toBe('127.0.0.1,localhost')
    expect(scrubbed.DSH_CODEX_TOKEN).toBe('token')
    expect(scrubbed.HOME).toBe('/tmp')
  })

  it('force-pins empty proxies even when the caller supplied none', () => {
    const scrubbed = scrubChildEnv({ PATH: '/usr/bin' })
    expect(scrubbed.HTTP_PROXY).toBe('')
    expect(scrubbed.HTTPS_PROXY).toBe('')
    expect(scrubbed.ALL_PROXY).toBe('')
  })
})
