# ui/ — 交互式呈现前端

[English](README.md) | 中文

DeepSeek Harness agent 的交互式（非浏览器）呈现前端。这些包只负责终端输入与呈现：渲染会话事件，并通过一个具体宿主接住 [`interaction`](../interaction/README.md) 的三个 seam（`commands`、`approval`、`userQuestions`）。它们从不驱动 agent 循环、不持久化会话、也不定义工具。

| 包 | 角色 | ctx key |
|---|---|---|
| [`tui/`](tui/README.md) | 交互式终端前门（pi-tui） | 挂载 `cli-tui` |
