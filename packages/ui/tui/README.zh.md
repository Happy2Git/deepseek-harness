# @deepseek-ai/dsh-tui

[English](README.md) | 中文

DeepSeek Harness agent 的交互式终端（TUI）前门，基于 [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui)。它要求 stdin 与 stdout 都是 TTY；脚本与管道应改用一次性 [`dsh --profile headless`](../../bundle/headless/README.md)。

本包只负责终端输入与呈现：通过公开注册表创建一个 agent，从 `session/event` 渲染持久化的会话 transcript，并通过一个具体宿主接住 [`interaction`](../../interaction/README.md) 的三个 seam（`commands`、`approval`、`userQuestions`），不实现 agent 循环、不持久化会话、也不定义工具。

## 运行

```sh
dsh --profile cli
dsh --profile cli --resume <id>
```

## 功能

- 全屏 pi-tui 界面：欢迎横幅、transcript、状态行、footer 与输入编辑器（粘贴、撤销、历史、IME 锚点）。
- 从事件日志渲染会话 transcript：直接提问、助手回复、工具调用与回合失败。注入的上下文不作为提问文本显示。
- 空闲时提交走 followup，运行中提交在下一步边界走 steer。
- 斜杠命令经 `ctx.commands` 分发；`/help`、`/status`、`/exit` 是终端本地的，其他插件注册的命令（plan、compact、goal、feedback、permission…）接入同一分发。
- 通过共享 FIFO 提问队列接住 `ask_user_question` 与工具审批；审批 fail-closed。
- 两个扩展 seam：`ctx.tui.openOverlay()` 用于模态浮层，`ctx.tuiPrompt` 用于状态行片段。

## 模型体验

本适配器自身不添加任何模型可见内容：终端呈现、命令执行、提问/审批渲染都只在 UI 平面。用户提交仍经正常的 `followup`/`steer` 路径到达模型，具有其通常的 token 影响。

## 已知限制与后续工作

- transcript 在每次事件时整段折叠事件日志；长会话渲染应改用 projection cache。
- Markdown、reasoning 与工具卡渲染意图尚未渲染；transcript 目前是纯文本。
- 终端本地的 `/details` 选择器尚未实现；`/model`（列出或选择）与 `/clear`（重置可见 transcript）已可用，`/plan`、`/compact`、`/goal` 由其各自的命令插件提供。
