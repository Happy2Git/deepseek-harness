# Agent Note: Subagent Codex 内网回环桥

Status: implemented

[English](2026-08-26-subagent-codex-intranet-loopback-bridge.md) | 中文

## Problem

一个把 harness 部署到内网模型端点的环境，无法直接使用现成的 `codex` 提供方：`codex app-server` 以宿主机原生 Codex 配置启动，预期官方 OpenAI 风格凭证和可访问的公开端点，其子进程会继承环境的代理与遥测变量。仅通过环境变量指向内网 base URL，并不能阻止该产品导出遥测，也不能阻止宿主机代理把模型流量重定向或泄漏；而当前提供方把 `codex` 可执行名写死，没有任何选择内网裁剪构建的途径。

因此提供方必须能 (a) 选择不同的 Codex 可执行，以及 (b) 把所有模型流量经仅限回环的传输收敛到唯一一个部署配置的内网端点，同时不导出遥测、不被代理重定向，并把真实 API 密钥排除在子进程环境之外。

## Decision

`@deepseek-ai/dsh-subagent-codex` 新增两个可选配置面，两者默认都缺省，因此现有直接 spawn 部署不受影响。

### 二进制参数化

`binaryName` 与 `binaryPath` 选择可执行文件。两者同时设置时 `binaryPath` 优先；都未设置时提供方仍像以前一样从 `PATH` 解析 `codex`。`codexAppServerArgv(platform, binary)` 构造 argv，并为 `.cmd`/路径负载保留 Windows 的 `cmd.exe /d /s /c` 边界。

### 回环桥

`loopback` 是一个纯数据配置块，要求 `upstreamBaseUrl` 与 `model`。设置后，每次运行：

1. 在 `127.0.0.1` 的 OS 选择端口上启动一个仅限回环的反向代理，只接受 `POST /v1/responses`，在触达上游前拒绝任何其他方法或路径。
2. 写入一个全新的可丢弃 `CODEX_HOME`，其锁定的 `config.toml` 把 `base_url` 指向该桥，固定提供方 id 为 `dsh-loopback`，设置 `approval_policy = never`、`sandbox_mode = read-only`、`disable_response_storage = true`、`check_for_update_on_startup = false`，并关闭 `[analytics]` 与所有 `[otel]` 导出器。
3. 清除子进程环境：删除远端凭证与 `OPENAI_API_KEY`/遥测导出器变量，强制把每个代理变量置空，并设置 `NO_PROXY = 127.0.0.1,localhost`。
4. 以 `CODEX_HOME` 指向一次性 home 来 spawn 子进程；子进程把 `DSH_CODEX_TOKEN`（来自 `env`）作为 bearer 发送到桥，桥转发到唯一的 `upstreamBaseUrl`，并把响应流式返回，不做语义翻译。
5. 在 teardown 时串起三重释放：进程树、桥、home。

该桥只是传输层代理：仅转发那一个配置的上游，fail-closed（无回退），把请求保存在内存而不落盘模型流量。它对外暴露一个可选的 `credential(request)` 解析器，供代码级调用方按请求替换 incoming bearer，保留「真实密钥永不进入子进程环境」的升级路径；面向 yml 的配置保持纯数据，因此 `loopback` 配置本身不携带该解析器。

只有 `loopback` 模式下提供方才拥有 `CODEX_HOME`。直接 spawn 仍把 `CODEX_HOME` 留给宿主机原生 Codex 配置，与此前契约一致。

## Alternatives considered

### 仅反向代理桥，key 经 env（v1 采纳）

用 `Config.env` 把 key 作为 `DSH_CODEX_TOKEN` 承载来交付回环桥（现有带凭证的 e2e 已证明该形态），并暴露一个代码级凭据解析器用于后续注入升级。这既保持了 yml 配置可序列化，也让首个发布简单，同时可插拔解析器在无需重做传输的情况下，为「把 key 从子进程环境移除」留下了边界。

### 从第一天起就通过解析器注入凭证

经 Loader 传入的解析器无法用 yml 表达（它是活函数），因此仅 yml 的部署需要在提供方当前并不拥有的轴上新增一个注册面。这会在没有消费者需要之前就增加配置面，故推迟到桥已暴露的 run-spec 钩子。

### 不用桥：仅依赖裁剪二进制的 fail-closed 回环

裁剪后的 `dsh_inner_codex` 已强制仅回环的提供方 URL，这消除了公开端点失效模式，但并不能阻止宿主机代理重定向回环流量，也不能阻止遥测导出器经环境重新激活。桥 + 环境清洗是让回环保证与宿主机组合起来的传输与环境层，因此二者一起交付。

### 直接复用现有测试专用桥

测试专用的 Responses 到 Chat-Completions 桥会翻译线协议，且刻意不作为生产面。生产需要一个与子进程既用线协议相同的传输层代理，因此不复用测试桥。

## Consequences

- `loopback` 模式每次运行会多花一个进程（桥）和一个 `127.0.0.1` 端口；端口在 teardown 时释放。
- 即便在 `loopback` 模式，被清洗的环境也会移除 `HTTP_PROXY` 等，这是回环保证所必需，也是预期行为。
- 在内网搭建里通过 `env` 提供 `OPENAI_API_KEY` 的部署必须改用 `DSH_CODEX_TOKEN`，因为清洗会在 `loopback` 模式下删除远端键名。
- 线协议未变：桥位于 HTTP 层，app-server 的 JSON-RPC 适配器（`wire.ts`）保持零差异，从而维持 0.147.0 固定基线。
- 启用 `loopback` 却未同时提供 `upstreamBaseUrl` 与 `model` 时是 no-op（可选块为空），因此不完整配置不会静默启动桥。
