# @deepseek-ai/dsh-host-git-local

[English](README.md) | 中文

git 能力 seam 的本地后端：注册 `ctx.git`，通过 `ctx.subprocess` 以收集输出模式调用 `git` 可执行文件，提供只读原语。`graph(cwd, options)` 运行 `git log --all --topo-order --date-order`，其 `--pretty=format:` 字段以 `%x00` 分隔、记录以 `%x1e` 分隔，并多请求一个提交以判定 `hasMore`。`showCommit(cwd, hash)` 运行两次 `git show -m --first-parent`——一次取元信息 + `--name-status`，一次取 `--numstat`，再按路径合并。`-m --first-parent` 让合并提交（相对第一父提交）与根提交（相对空树）的 diff 都定义明确。`showFileDiff(cwd, hash, path)` 运行 `git show --format= --unified=3`；`showWorkspaceDiff(cwd, path)` 对已跟踪文件比较工作区与 HEAD，对未跟踪文件用空临时文件做 `--no-index` 比较（其退出码 1 即表示存在差异）。插件同时在 `ctx.webServer` 上服务面板路由：`/git/graph`、`/git/show-commit`、`/git/workspace`、`/git/show-diff`、`/git/workspace-diff`、`/git/status`。

收集到的 stdout/stderr 以 `maxOutputBytes` 为界，提交页以 `maxCommits` 为界，单个提交的文件列表以 `maxFiles` 为界。失败使用带类型的 `GitError`：spawn 级失败（二进制无法运行）为 `git-unavailable`，stderr 出现 `not a git repository` 为 `not-a-repository`，未知 revision 为 `commit-unreadable`。策略裁决（只读范围、路径引号、单仓库 `cwd`）见 git 能力 seam Agent Note。

## 模型体验

无。该 seam 服务于 GUI 宿主的提交图面板；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **路径引号**——`--name-status`/`--numstat` 输出按 git 默认的 `core.quotePath` 解析；含空格或非 ASCII 字符的路径会以引号形式出现，路径内嵌制表符未被处理。当消费方需要精确路径时，改用 `-z`（NUL 结尾的原始输出）。
- **不检测重命名**——`--no-renames` 把重命名摊平为一个删除 + 一个新增对。
