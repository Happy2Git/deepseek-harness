# DeepSeek Harness — fork

English | [中文](README.zh.md)

A fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that tracks upstream master. The right-side context-and-files panel and its git/directory backends, formerly built into this fork, are now published separately as the [dsh-compass](https://github.com/Happy2Git/dsh-compass) plugin.

## What this fork keeps local

- A terminal TUI (packaged as `dsh-terminal`) — interactive front door (`dsh --profile cli`), `/model` selector and `/clear` transcript reset, reasoning-block rendering with a `/details` toggle, structured tool-result cards, and headless drivers (`--jsonl`, `--mode`, `--session-id`, `--model`). It stays in-repo until its feature set grows.
- Web extras: status-dot strips under the background-task and subagent counts.
- CI and issue-management workflows scoped so they only run on the canonical upstream repo.

## Install the panel

The context-and-files panel is now an ecosystem plugin. Install it with:

```sh
pnpm dsh plugin --profile web add /path/to/dsh-compass
```

See [dsh-compass](https://github.com/Happy2Git/dsh-compass) for requirements, install options, and screenshots.

## Run

### From npm (upstream package)

```sh
npx @deepseek-ai/dsh web
```

### Run from source

```sh
git clone https://github.com/Happy2Git/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

The Web UI is served at `http://127.0.0.1:3080` by default.

## License

MIT. Copyright (c) 2026 DeepSeek. This fork keeps the upstream [LICENSE](LICENSE).
