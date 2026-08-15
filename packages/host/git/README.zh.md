# @deepseek-ai/dsh-host-git

[English](README.md) | 中文

web GUI 宿主的只读 git 历史是一项能力 seam。抽象的 `Git` 服务（`ctx.git`）是其 Service Definition：`graph(cwd, options, signal)` 返回拓扑排序提交 DAG 的一页（带界），`showCommit(cwd, hash, signal)` 返回单个提交的元信息与变更文件列表。这里刻意不提供任何写原语——暂存、提交、分支等都不属于本 seam。唯一的实现是本地后端（[`-local`](../git-local/README.md)），它通过 `ctx.subprocess` 调用 `git` 可执行文件。两个原语都显式接收仓库路径（`cwd`），因此由客户端决定浏览哪个工作区，宿主永远不会去解析自己的工作目录。

失败时抛出带类型的 `GitError`（`git-unavailable`／`not-a-repository`／`commit-unreadable`），消费网关将其 1:1 映射为协议错误码。`GitGraphPage` 携带 `hasMore`、`GitCommitDetail` 携带 `truncated`，因此客户端无需知道后端上限即可分页浏览长历史、并对大提交做界。设计依据见 git 能力 seam Agent Note。

## 模型体验

无。该 seam 服务于 GUI 宿主的提交图面板；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **刻意只读**——该 seam 没有提交/暂存/分支原语。写操作推迟到出现需要它的消费方；它们会落在这里（或一个并列的写 seam），而不会落在客户端。
- **每次调用一个仓库**——`cwd` 限定单个仓库；未建模多仓库总览。
