# DeepSeek Harness — 分支

[English](README.md) | 中文

这是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一个分支，跟随上游 master。原先内置在本分支的右侧上下文文件面板及其 Git／目录后端，现已作为 [dsh-compass](https://github.com/Happy2Git/dsh-compass) 插件单独发布。

## 本分支保留的本地内容

- `dsh --profile headless` 上的无头驱动参数：`--jsonl`（机器可读 NDJSON 事件流与 stdin 审批）、`--mode`（权限预设）、`--session-id`（续接或新建持久会话）、`--model`（本次运行覆盖模型）。
- Web 增强：后台任务数与子代理数下方的状态点条。
- CI 与 issue 管理工作流限定为只在官方上游仓库运行。

## 安装面板

上下文文件面板现在是生态插件。安装方式：

```sh
pnpm dsh plugin --profile web add /path/to/dsh-compass
```

要求、安装选项与截图见 [dsh-compass](https://github.com/Happy2Git/dsh-compass)。

<a id="run"></a>

## 运行

### 通过 npm（上游包）

安装 `Node.js` 后运行：

```sh
npx @deepseek-ai/dsh web
```

命令默认在 `http://127.0.0.1:3080` 启动 Web 界面，并在本地启动时在默认浏览器中打开。SSH 启动只打印主机 URL，因为 SSH 客户端或编辑器持有本地转发的地址。传 `--no-open` 可在不打开浏览器的情况下运行服务器。参见 [Web 界面指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

从仓库检出运行：

```sh
git clone https://github.com/Happy2Git/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 准备仓库构件。`pnpm dsh web` 直接使用这些构件，无需重新构建。

单次无头运行：

```sh
pnpm dsh --profile headless --jsonl --mode read-only "run the tests"
```

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或缺陷。
- 给插件仓库打上 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 标签以便被发现。
- 加入 <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord 社区</a>。

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

Agent 请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
