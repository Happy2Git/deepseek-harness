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

**Provider 自带 HTTP 传输。** `git-local` 在 `ctx.webServer` 上注册自己的 `/git/graph` 与 `/git/show-commit` 路由（kind `exact`），非 loopback 宿主拒绝加载——面板因此完全不需要核心 API 网关，第三方 git 插件随包携带自己的传输。每条路由都执行跨站写护栏（Content-Type 415、64 KiB 体积上限 413、严格 JSON 400），把 `cwd` 校验为完全限定路径（posix/win32 双检查）、`count`/`skip`/`hash` 校验为整数或非空字符串，客户端断开时中止子进程（`requestSignal`），并把 `GitError` 1:1 映射为 400 响应（其他失败 500）。被截断的收集流（lossy）直接抛错，绝不返回半解析记录。面板通过注入面（`routeFetch`）直接请求这些路由；此前的 apiproxy/`ctx.workspaces` 接线随本次改动删除。面板（`dsh-client-ui-context-files`）渲染第三个标签（`git`），内含新的 `GitGraph` 组件——移植自 vibe-ide 的泳道求解器（`buildGraphRows`：每条活跃分支一条泳道、循环使用 `--dsw-alias-*` token 颜色、HEAD/merge 圆点、引用徽章）——组件本地分页、点击懒加载展开提交。

**边界与策略。** 收集到的 stdout/stderr 以 `maxOutputBytes`（262144）为界，提交页以 `maxCommits`（100）为界，单个提交的文件列表以 `maxFiles`（500）为界。`cwd` 在每次调用都显式传入——宿主永远不去解析自己的工作目录。后端从不写入，`git` 失败按 stderr（`not a git repository`、`unknown revision`/`bad object`）归类为闭合错误码；spawn 级失败（二进制缺失）为 `git-unavailable`。

## 备选方案

- **扩展 `ctx.fs`。** 否决：`packages/fs/` 是模型/会话存储栈（策略事件、可换 sandbox 后端）；git 历史是无展示、只读的视图而非存储原语，把它耦合到模型禁闭后端会重蹈 directory-picker 笔记记录的权限域错误。
- **单包而不是 Service Definition + Provider 拆分。** 否决：仓库的能力 seam 规则要求词表与实现分离；directory-picker 先例（`directory-picker` + `-browse`/`-native`）就是模板，而未来的后端（sandbox 或远程 git）正是独立演进的场景。
- **搭在核心 API 网关上（第一版实现）。** 先在 apiproxy 上建了 `host.gitGraph` / `host.gitShowCommit` RPC 加上 workspaces 镜像，随后整体移除：闭合的网关契约不应为一个界面的领域方法膨胀，且面板是唯一消费方。否决，改用上述插件自有路由。
- **专门的客户端 `ctx.git` 服务。** 暂不采纳：只有一个消费方；面板的注入面直接请求插件自有路由，客户端服务抽取留到出现第二个消费方时再做。
- **写原语（提交/暂存/分支/stash/push）。** 否决：需求是只读图；写操作只有在出现消费方时才落在这里（或一个并列的写 seam），而 seam 的只读保证正是客户端无需接审批机制的原因。
- **引入 git 库（`simple-git`、`nodegit`）。** 按依赖门槛否决：`git log`/`git show` 配合 `--pretty=format:` 在 `--x00`/`--x1e` 分隔格式之上就是稳定、自足的解析面，`ctx.subprocess` 已提供有界收集输出与中止处理。引入依赖删不掉任何自有代码。
- **重命名感知的文件列表。** 首版不采纳：`-M` 输出会让文件路径变成非稳定的合并键（重命名条目带旧 + 新路径）；`--no-renames` 保持列表稳定、状态联合闭合。

## 后果

- **所得：** 已发布面板里有了只读提交图——泳道可视化、懒加载提交展开、有界分页——跑在真实 `git` 后端上，provider 自带传输，核心网关与客户端服务保持原样。
- **fork 独有的 seam。** `dsh-host-git` 与 `dsh-host-git-local` 上游都没有；独立包 `dsh-compass` 自带 seam 与后端的拷贝，因此面板可以跑在任何 dsh 组合上。
- **代价 / 暂缓：** `--name-status`/`--numstat` 输出按 git 默认 `core.quotePath` 解析，含空格或非 ASCII 的路径以引号形式到达（路径内嵌制表符未处理）；当消费方需要精确路径时改用 `-z`（NUL 结尾原始输出）。重命名显示为删除 + 新增，而不是单独的重命名行。每次调用一个仓库；无多仓库总览。无写操作。
