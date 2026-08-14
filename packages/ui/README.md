# ui/ — interactive presentation frontends

English | [中文](README.zh.md)

Interactive (non-browser) presentation frontends for DeepSeek Harness agents. These packages own terminal/input presentation only: they render session events and answer the [`interaction`](../interaction/README.md) seams (`commands`, `approval`, `userQuestions`) through one concrete host. They never drive the agent loop, persist sessions, or define tools.

| Package | Role | ctx key |
|---|---|---|
| [`tui/`](tui/README.md) | Interactive terminal front door (pi-tui) | mounts `cli-tui` |
