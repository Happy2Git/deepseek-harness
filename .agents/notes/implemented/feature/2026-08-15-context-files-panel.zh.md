# Agent Note: 上下文与文件右侧面板

Status: implemented

[English](2026-08-15-context-files-panel.md) | 中文

## 问题

web GUI 没有承载工作区上下文的右侧界面：目录浏览、会话注入的上下文文档、git 历史各自需要一个固定且不遮挡对话的归宿。左侧边栏是并存的界面，但其契约（导航、会话列表）不属于面板；面板必须是自己的 slot 条目，拥有自己的视图状态。

## 决策

**一个插件包、一个 overlay 条目。** `dsh-client-ui-context-files` 在布局声明的 `shell.overlay` 里注册一个 list-slot 条目（`id: context-files`），渲染固定的右侧面板（`PanelRoot`）：三个标签——文件（惰性 `FileTree`）、上下文（投影出的注入文档，带「加载更早」分页）、git（泳道图）——外加点击文件行打开的中部预览对话框（没有底部窗格）。视图状态（标签、宽度、展开目录、过滤器、中部文件、文档游标）放在声明式 store 工厂（`createPanelStore`）里供条目共享；每层目录列表是组件本地状态。

**注入面，而不是 ctx。** 组件的一切都经四个 props 份额到达；`inject` 面闭包在 apply 上下文上，只暴露普通回调：`listDirectory`/`readText`/`openPath`/`gitGraph`/`gitShowCommit` 请求插件自有的 `/dir/*` 与 `/git/*` 路由（`routeFetch`），`readInjectedDocs`/`hasMoreDocs`/`loadOlderDocs`/`sessionCwd` 投影会话日志与会话快照。面函数以属性函数形式声明类型（正是 apply 产出的箭头闭包），让 `unbound-method` lint 在每处透传点保持安静。

**对话避让用 CSS 变量。** `PanelRoot` 在 `document.documentElement` 上写 `--dsh-context-panel-width`（收起时为 0px，否则为状态宽度）；`ConversationRoot.module.css` 以 `padding-right` 读取它，面板因此永不遮挡对话。≤720px 时面板自动收起为竖条（组件内 `matchMedia`），媒体查询以 `transition: none` 去掉避让——过渡会在中途留下动画中的测量值。

**面板头部工具槽。** 面板的 register 调用在 `children` 里声明 `panel.header.utilities`（list、root 作用域）；`dsh-session-log-export` 把会话日志下载动作注册进该槽，让下载入口落在面板界面上，而不是被面板盖住的对话头部。

## 备选方案

**在 ui-layout 里加第二栏。** 否决：slot 系统的 `shell.overlay` 就是为「你自己的界面」准备的席位，布局自有的栏会为一个特性扩宽 shell 契约。

**面板内嵌预览窗格。** 否决：用户要求点击后在中部打开；中部对话框既放大文件内容又不挤压目录树。

**面板状态只放组件里。** 否决：标签、宽度、展开状态需要跨重挂载（HMR）存活，走声明式 store；每层目录列表保持组件本地，因为没有别人读它。

## 后果

面板是纯展示性的——它只读已记录的上下文与文件系统事实，不向模型提交任何东西。`shell.overlay` 在上游就有，因此独立包 `dsh-compass` 原样复现该条目；fork 的对话避让 CSS 是 fork 独有，因此 `dsh-compass` 自带避让（`--dsh-compass-width` 加一条针对 shell `[data-shell-overlay]` 钩子的 `:has()` 规则），与 fork 规则共存时不会双重避让。

## 测试

`packages/client/ui-context-files/tests/panel.client.spec.tsx` 用驱动 store 与桩注入面渲染 `PanelRoot`：标签切换、收起/展开、文档分页、文件到中部预览、不可读文件判定、隐藏条目过滤、符号链接环护栏、卸载时中止在途列表。store 测试覆盖视图状态动作。回放的浏览器 e2e（`apps/web/tests/context-files-panel.e2e.ts`）钉住组装后的界面。
