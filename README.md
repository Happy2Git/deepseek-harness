# DeepSeek Harness — fork

English | [中文](README.zh.md)

A fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that tracks upstream master. The right-side context-and-files panel and its git/directory backends, formerly built into this fork, are now published separately as the [dsh-compass](https://github.com/Happy2Git/dsh-compass) plugin.

## What this fork keeps local

- Headless driver flags on `dsh --profile headless`: `--jsonl` (machine-readable NDJSON events and stdin approvals), `--mode` (permission presets), `--session-id` (create-or-resume a persisted session), and `--model` (override the model for one run).
- Web extras: status-dot strips under the background-task and subagent counts.
- CI and issue-management workflows scoped so they only run on the canonical upstream repo.

## Install the panel

The context-and-files panel is now an ecosystem plugin. Install it with:

```sh
pnpm dsh plugin --profile web add /path/to/dsh-compass
```

See [dsh-compass](https://github.com/Happy2Git/dsh-compass) for requirements, install options, and screenshots.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/Happy2Git/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

For one headless run:

```sh
pnpm dsh --profile headless --jsonl --mode read-only "run the tests"
```

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
