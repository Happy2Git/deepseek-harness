# Agent Note: 面向 web GUI 提交图的只读 git 能力 seam

Status: implemented

[English](2026-08-15-git-capability-seam.md) | 中文

## 问题

web GUI 的「上下文与文件」面板无法展示工作区的 git 历史。期望的功能是一个只读提交图——以拓扑排序提交 DAG 画成彩色泳道（分支分出新泳道、合并汇合），点击展开查看变更文件——参照 vibe-ide 的 `GitGraph`。整个 harness 此前没有任何 git 能力：没有 Service Definition、没有 provider、没有 wire 路由、也没有客户端面。实现它需要新建一条能力 seam，而不是扩展现有 seam。

## 决策

`packages/host/` 下两个包的宿主 seam——`git`（Service Definition，抽象的 `Git` 服务 + `GitError`）与 `git-local`（唯一后端，通过 `ctx.subprocess` 以收集输出模式运行 `git` 可执行文件）。该 seam **从构造上就是只读的**：只暴露两个原语，没有写动词。

- `graph(cwd, options, signal)` → `GitGraphPage { entries, hasMore }`。运行 `git -C <cwd> log --all --topo-order --date-order --skip=N --max-count=N+1 --pretty=format:%H%x00%P%x00%D%x00%s%x00%aN%x00%aI%x1e`——`%x00` 分隔字段、`%x1e` 分隔记录，多请求一个提交即可判定 `hasMore`，无需第二次往返。
- `showCommit(cwd, hash, signal)` → `GitCommitDetail { hash, message, author, date, files, truncated }`。运行 `git show -m --first-parent --no-renames --format=%H%x00%B%x00%aN%x00%aI%x1e --name-status <hash>`（元信息 + 状态合在一次调用里，`%x1e` 记录结束符把头部与状态流隔开）和 `git show -m --first-parent --no-renames --format= --numstat <hash>`，再按路径合并两者。

`-m --first-parent` 组合让三种提交的 diff 都定义明确：普通提交相对第一父提交，合并提交相对第一父提交（而不是 `git show` 默认的空 combined diff），根提交相对空树。`--no-renames` 把重命名摊平为一个删除 + 一个新增对，因此文件路径是稳定的合并键，闭合的状态联合只有 `added | modified | deleted`。

**接线完全照搬 directory-picker seam。** `dsh-host-apiproxy` 提供 `host.gitGraph` / `host.gitShowCommit`（rpc-map、host 契约 + zod schema、fetch client/handler 路由），通过 `ctx.get('git')` 读取服务（可选组合——缺失时回答 `git-unavailable`），并把 `GitError`（`git-unavailable` / `not-a-repository` / `commit-unreadable`）1:1 映射为 wire 错误码。客户端搭在 `ctx.workspaces` 上（`IWorkspaces` 与 `WorkspaceRuntime` 新增 `gitGraph`/`gitShowCommit`），而不是新建客户端服务——因为 git 浏览与 `listDirectory`/`readText` 同属「浏览工作区」一族，且只有一个消费方（面板）；出现第二个消费方时再抽出一个专门的 `ctx.git` 客户端服务。面板（`dsh-client-ui-context-files`）新增第三个标签（`git`），渲染新的 `GitGraph` 组件——移植自 vibe-ide 的泳道求解器（`buildGraphRows`：每条活跃分支一条泳道、循环使用 `--dsw-alias-*` token 颜色、HEAD/merge 圆点、引用徽章）——组件本地分页、点击懒加载展开提交。

**边界与策略。** 收集到的 stdout/stderr 以 `maxOutputBytes`（262144）为界，提交页以 `maxCommits`（100）为界，单个提交的文件列表以 `maxFiles`（500）为界。`cwd` 在每次调用都显式传入——宿主永远不去解析自己的工作目录。后端从不写入，`git` 失败按 stderr（`not a git repository`、`unknown revision`/`bad object`）归类为闭合错误码；spawn 级失败（二进制缺失）为 `git-unavailable`。

## 备选方案

- **扩展 `ctx.fs`。** 否决：`packages/fs/` 是模型/会话存储栈（策略事件、可换 sandbox 后端）；git 历史是无展示、只读的视图而非存储原语，把它耦合到模型禁闭后端会重蹈 directory-picker 笔记记录的权限域错误。
- **单包而不是 Service Definition + Provider 拆分。** 否决：仓库的能力 seam 规则要求词表与实现分离；directory-picker 先例（`directory-picker` + `-browse`/`-native`）就是模板，而未来的后端（sandbox 或远程 git）正是独立演进的场景。
- **专门的客户端 `ctx.git` 服务。** 暂不采纳：只有一个消费方、wire 形态又与既有工作区浏览原语一致；在 `ctx.workspaces` 上加两个方法是最小且正确的改动，笔记记录了暂缓的抽取。
- **写原语（提交/暂存/分支/stash/push）。** 否决：需求是只读图；写操作只有在出现消费方时才落在这里（或一个并列的写 seam），而 seam 的只读保证正是客户端无需接审批机制的原因。
- **引入 git 库（`simple-git`、`nodegit`）。** 按依赖门槛否决：`git log`/`git show` 配合 `--pretty=format:` 在 `--x00`/`--x1e` 分隔格式之上就是稳定、自足的解析面，`ctx.subprocess` 已提供有界收集输出与中止处理。引入依赖删不掉任何自有代码。
- **重命名感知的文件列表。** 首版不采纳：`-M` 输出会让文件路径变成非稳定的合并键（重命名条目带旧 + 新路径）；`--no-renames` 保持列表稳定、状态联合闭合。

## 后果

- **所得：** 已发布面板里有了只读提交图——泳道可视化、懒加载提交展开、有界分页——跑在真实 `git` 后端上，端到端走既有 seam 机制，无需新增客户端服务。
- **代价 / 暂缓：** `--name-status`/`--numstat` 输出按 git 默认 `core.quotePath` 解析，含空格或非 ASCII 的路径以引号形式到达（路径内嵌制表符未处理）；当消费方需要精确路径时改用 `-z`（NUL 结尾原始输出）。重命名显示为删除 + 新增，而不是单独的重命名行。每次调用一个仓库；无多仓库总览。无写操作。
