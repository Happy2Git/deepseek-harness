# @deepseek-ai/dsh-cli

[English](README.md) | 中文

dsh 交互式终端 profile bundle：在 [`@deepseek-ai/dsh-base`](../base/README.md) 之上的 patch 层，挂载 [`@deepseek-ai/dsh-tui`](../../ui/tui/README.md) 前门——一个 pi-tui 终端界面，只负责终端输入与呈现。agent 生命周期、持久化与工具仍在 `dsh-base` 中。

## 运行

```sh
dsh --profile cli
dsh --profile cli --resume <id>
```

`cli` profile 首次使用会像 `web`、`headless` 一样从内置模板自动初始化。本 bundle 的 `startup` 入口解析 app 自持的 `--resume` 旗标；前门经 agent 注册表恢复持久化会话。

## 已知限制与后续工作

- 终端本地的 `/model` 选择器与更丰富的 transcript 渲染（markdown、工具卡）在后续改动中落地；`/plan`、`/compact`、`/goal` 已由 base bundle 的命令插件提供。
