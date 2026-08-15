# Agent Note: 插件自有目录路由与 browse readText 原语

Status: implemented

[English](2026-08-15-plugin-owned-directory-routes.md) | 中文

## 问题

「上下文与文件」面板要列出目录、预览文件文本，但浏览器无法直接触达 `ctx.directoryPicker`，核心 API 网关是闭合契约，而 browse 能力只有 `list` + `createDirectory`——seam 上没有任何文本读取原语。面板需要在自己拥有的路由上完成列表、有界文本读取与「用默认应用打开」，并保持与面板 git 路由相同的安全姿态。

## 决策

**browse 能力新增 `readText`。** seam（`dsh-host-directory-picker`）为 `DirectoryPickerBrowseCapability` 增加 `DirectoryRead { path, text, truncated }` 与 `readText(path, signal)`；browse 后端（`directory-picker-browse`）实现为一次有界读取（`maxTextBytes` + 1 证明截断），NUL 字节判定二进制（`file-not-text`），完全限定路径护栏与信号竞争和 `list` 一致。

**插件注册自己的路由。** `dsh-host-directory-routes` 在 `ctx.webServer` 上注册 `/dir/list`、`/dir/read-text`、`/dir/open-path`，由组合进来的 browse 能力应答。路由姿态与 git-local 对齐：仅 loopback（非 loopback 宿主拒绝加载）、Content-Type 415、64 KiB 体积上限 413、严格 JSON 400、完全限定绝对路径校验（posix/win32 双检查）、`requestSignal` 断开即中止。`/dir/open-path` 把路径交给平台打开器——macOS `open(1)`、Windows PowerShell `Invoke-Item -LiteralPath`（单引号加倍转义）、其余平台 `xdg-open`——经由 `openPathNative(path, signal, internals)`，其 `{ platform?, run? }` 钩子让分派测试无需改写 `process.platform` 即可确定运行。

**列表排序为目录优先。** browse 后端把每一层流式灌入有界窗口（maxEntries + 1），按 `(isDirectory, name)` 排序；符号链接的归属组是其目标的类型（流式过程中用 `stat` 探测），因此指向目录的符号链接与目录同组排序。截断尾巴遵循同一顺序。

## 备选方案

**给 apiproxy 增加 `host.readText`。** 否决（第一版实现已移除）：闭合的网关契约不应为一个界面的领域方法膨胀；git 路由已经确立了插件自有传输的先例。

**只发布原生选择器。** 否决：远程浏览器拿不到 OS 对话框；应用内浏览器是唯一对每个客户端都成立的传输。

**浏览器内用 blob URL 读文本。** 与列表同理不可行：浏览器没有文件系统访问权。

## 后果

面板的目录数据走插件自有路由，因此 seam 变更（`readText`）是唯一的共享契约成本。该原语与路由是 fork 独有；独立包 `dsh-compass` 在包内重新实现了整个浏览器（list + read + create 本地实现），因此面板可以跑在任何 dsh 组合上，包括桌面端 directoryPicker 解析为原生选择器的 main-track profile。

## 测试

`packages/host/directory-routes/tests/routes.spec.ts` 覆盖注册、向 browse 能力的委托、415/413/400 路径、相对路径拒绝与 open-path 分派；`tests/open-path-native.spec.ts` 通过注入的 internals 覆盖平台分派与信号透传。`packages/host/directory-picker-browse/tests/service.spec.ts` 覆盖列表边界、目录优先顺序（含指向目录的符号链接）与 readText 的截断/二进制判定。
