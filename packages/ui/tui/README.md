# @deepseek-ai/dsh-tui

English | [中文](README.zh.md)

The interactive terminal (TUI) front door for DeepSeek Harness agents, built on [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui). It requires stdin and stdout TTYs; scripts and pipes should use the one-shot [`dsh --profile headless`](../../bundle/headless/README.md) surface instead.

This package owns terminal input and presentation only. It creates one agent through the public registry, renders the durable session transcript from `session/event`, and answers the [`interaction`](../../interaction/README.md) seams (`commands`, `approval`, `userQuestions`) through one concrete host, without implementing the agent loop, persisting sessions, or defining tools.

## Run it

```sh
dsh --profile cli
dsh --profile cli --resume <id>
```

## Features

- Fullscreen pi-tui surface: welcome banner, transcript, status line, footer, and an input editor (paste, undo, history, IME anchor).
- Renders the session transcript from the event log: direct user prompts, assistant messages, tool calls, and turn failures. Injected context is not shown as prompt text.
- Submissions follow up while idle and steer at the next step boundary while a turn runs.
- Slash commands dispatch through `ctx.commands`; `/help`, `/status`, and `/exit` are terminal-local, and every other command a plugin registers (plan, compact, goal, feedback, permission, …) joins the same dispatch.
- Answers `ask_user_question` and tool-approval requests through a shared FIFO prompt queue; approvals are fail-closed.
- Two extension seams: `ctx.tui.openOverlay()` for modal overlays and `ctx.tuiPrompt` for status-line fragments.

## Model Experience

This adapter adds no model-visible content of its own: terminal presentation, command execution, and question/approval rendering are UI-plane only. Submissions the user makes still reach the model through the normal `followup`/`steer` paths with their usual token effect.

## Known Limitations and Deferred Work

- The transcript renders incrementally (append-origin), but a resumed cold session still folds its whole history once; moving to the projection cache would bound that replay too.
- Tool cards honor the tool's `presentCall`/`presentResult` intents (diff/terminal/search/read/web), with a raw-text fallback when no presenter is mounted; styling uses a small fixed ANSI set rather than a full theme palette.
