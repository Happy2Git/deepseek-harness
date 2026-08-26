# Agent Note: Subagent Codex intranet loopback bridge

Status: implemented

English | [中文](2026-08-26-subagent-codex-intranet-loopback-bridge.zh.md)

## Problem

A deployment that runs the harness against an intranet model endpoint cannot use the stock `codex` provider as-is: `codex app-server` launches with the host's native Codex configuration, which expects official OpenAI-style credentials and a reachable public endpoint, and its child process inherits the ambient proxy and telemetry environment. Pointing the product at an intranet base URL through environment alone does not stop the product from exporting telemetry or honoring a host proxy that could redirect or leak model traffic, and the provider currently hardcodes the `codex` executable name with no way to select a trimmed intranet build.

The provider must be able to (a) select a different Codex executable, and (b) converge all model traffic onto exactly one deployment-configured intranet endpoint over a loopback-only transport, with no telemetry export and no proxy redirection, while keeping the real API key out of the child's environment.

## Decision

`@deepseek-ai/dsh-subagent-codex` gains two opt-in configuration surfaces, both absent by default so existing direct-spawn deployments are unchanged.

### Binary parameterization

`binaryName` and `binaryPath` select the executable. `binaryPath` wins when both are set; when neither is set the provider keeps resolving `codex` from `PATH` as before. `codexAppServerArgv(platform, binary)` builds the argv, and the Windows `cmd.exe /d /s /c` boundary is preserved for `.cmd`/path workloads.

### Loopback bridge

`loopback` is a data-only config block requiring `upstreamBaseUrl` and `model`. When set, each run:

1. Starts a loopback-only reverse proxy on `127.0.0.1` at an OS-chosen port that accepts only `POST /v1/responses` and refuses any other method or path before touching the upstream.
2. Writes a fresh disposable `CODEX_HOME` whose locked `config.toml` points `base_url` at that bridge, pins the provider id to `dsh-loopback`, sets `approval_policy = never`, `sandbox_mode = read-only`, `disable_response_storage = true`, `check_for_update_on_startup = false`, and disables `[analytics]` and every `[otel]` exporter.
3. Scrubs the child environment: deletes far-end credentials and `OPENAI_API_KEY`/telemetry exporter vars, force-pins every proxy var empty, and sets `NO_PROXY = 127.0.0.1,localhost`.
4. Spawns the child with `CODEX_HOME` set to the one-shot home; the child sends `DSH_CODEX_TOKEN` (from `env`) as the bearer to the bridge, the bridge forwards to the single `upstreamBaseUrl`, and it streams the response back without semantic translation.
5. Chains all three releases on teardown: process tree, bridge, home.

The bridge is a transport-level proxy only: it forwards exactly one configured upstream, fails closed (no fallback), and holds the request in memory without persisting model traffic. It exposes an optional `credential(request)` resolver for code callers to replace the incoming bearer per request, reserving the upgrade path where the real key never enters the child environment; yml-facing configuration stays data-only, so the `loopback` config itself does not carry the resolver.

The provider owns `CODEX_HOME` only in `loopback` mode. Direct spawn still leaves `CODEX_HOME` with the host's native Codex configuration, matching the prior contract.

## Alternatives considered

### Reverse-proxy bridge only, key via env (adopted for v1)

Ship the loopback bridge with the key carried through `Config.env` as `DSH_CODEX_TOKEN` (the existing credentialed e2e already proves this shape), and expose a code-level credential resolver for the later injection upgrade. This keeps yml configuration serializable and the first release simple, while the pluggable resolver leaves the boundary where the key is removed from the child environment without reworking the transport.

### Inject the credential through a resolver from day one

A resolver passed through the Loader cannot be expressed in yml (it is a live function), so a yml-only deployment would need a separate registration surface on axes the provider does not own today. This adds configuration surface before a consumer needs it, so it is deferred to the run-spec hook the bridge already exposes.

### No bridge: rely on the trimmed binary's fail-closed loopback

The trimmed `dsh_inner_codex` already enforces loopback-only provider URLs, which removes the public-endpoint failure mode but does not stop an ambient host proxy from redirecting loopback traffic or a telemetry exporter from re-activating through environment. The bridge plus env scrub are the transport and environment layer that makes the loopback guarantee compose with the host, so both are shipped together.

### Direct mapping through the existing test-only bridge

The test-private Responses-to-Chat-Completions bridge translates wire protocols and is deliberately not a production surface. Production needs a transport-only proxy that speaks the same wire the child already uses, so the test bridge is not reused.

## Consequences

- `loopback` mode spends one extra process (the bridge) and one OS port per run on `127.0.0.1`; the port is released on teardown.
- The scrubbed environment removes `HTTP_PROXY` etc. even in loopback mode, which is required for the loopback guarantee and is the intended behavior.
- A deployment that supplies `OPENAI_API_KEY` via `env` in an intranet setup must switch to `DSH_CODEX_TOKEN`, because the scrub deletes the far-end-key names in loopback mode.
- The wire protocol is untouched: the bridge lives at the HTTP layer and the app-server JSON-RPC adapter (`wire.ts`) keeps zero diff, preserving the 0.147.0 pin.
- Enabling `loopback` without both `upstreamBaseUrl` and `model` is a no-op (the optional block is empty), so a partial config does not silently start a bridge.
