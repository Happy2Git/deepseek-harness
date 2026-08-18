# DeepSeek Harness — 分支

[English](README.md) | 中文

这是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一个分支，跟随上游 master。原先内置在本分支的右侧上下文文件面板及其 Git／目录后端，现已作为 [dsh-compass](https://github.com/Happy2Git/dsh-compass) 插件单独发布。

## 本分支保留的本地内容

- 终端 TUI（以 `dsh-terminal` 打包）— 交互式终端入口（`dsh --profile cli`）、`/model` 选择器与 `/clear` 会话重置、推理块渲染与 `/details` 开关、结构化工具结果卡片，以及无头驱动（`--jsonl`、`--mode`、`--session-id`、`--model`）。功能完善前暂不发布。
- Web 增强：后台任务数与子代理数下方的状态点条。
- CI 与 issue 管理工作流限定为只在官方上游仓库运行。

## 安装面板

上下文文件面板现在是生态插件。安装方式：

```sh
pnpm dsh plugin --profile web add /path/to/dsh-compass
```

要求、安装选项与截图见 [dsh-compass](https://github.com/Happy2Git/dsh-compass)。

## 运行

通过 npm（上游包）：

```sh
npx @deepseek-ai/dsh web
```

从源码运行：

```sh
git clone https://github.com/Happy2Git/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

Web 界面默认运行在 `http://127.0.0.1:3080`。

## 许可证

MIT。Copyright (c) 2026 DeepSeek。本分支保留上游 [LICENSE](LICENSE)。
