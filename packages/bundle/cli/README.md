# @deepseek-ai/dsh-cli

English | [中文](README.zh.md)

The dsh interactive terminal profile bundle: a patch layer over [`@deepseek-ai/dsh-base`](../base/README.md) that mounts the [`@deepseek-ai/dsh-tui`](../../ui/tui/README.md) front door, a pi-tui terminal surface that owns terminal input and presentation only. Agent lifecycle, persistence, and tools stay in `dsh-base`.

## Run it

```sh
dsh --profile cli
dsh --profile cli --resume <id>
```

The `cli` profile auto-initializes on first use from the shipped template, like `web` and `headless`. The bundle's `startup` entry parses the app-owned `--resume` flag; the front door resumes the persisted session through the agent registry.

## Known Limitations and Deferred Work

- The terminal-local `/model` selector and richer transcript rendering (markdown, tool cards) land in later changes; `/plan`, `/compact`, and `/goal` already arrive through the base bundle's command plugins.
