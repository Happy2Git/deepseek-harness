# @deepseek-ai/dsh-client-ui-context-files

[English](README.md) | 中文

浏览器侧面板插件:在布局的 `shell.overlay` 槽位注册一个右侧停靠的浮动面板,包含两个视图:

- **上下文标签页** — 列出当前会话已注入的上下文文档(工作区指令、技能调用、目标通知、跨会话召回),并用共享的安全 `MarkdownText` 渲染器预览选中文档全文;"加载更早"控件把日志窗口翻回会话开头的基线指令(AGENTS.md 等)。
- **文件夹标签页** — 通过主机的 `browse` 能力浏览会话工作区的目录树:目录惰性展开、文件显示为叶节点,可预览的文本文件(`.md`/`.markdown`/`.txt`)经主机有界读取在下部预览窗打开,支持名称过滤和"在文件管理器中打开"。

node 侧刻意留空:本包所做的全部工作都是对既有运行时事实的呈现。

## 组装

浏览器侧通过 `ctx.slots.inject` 在布局声明的 `shell.overlay` 槽位注册一个列表槽条目(`id: context-files`),附带面板的视图状态 store(`createPanelStore`)和一组普通回调(`listDirectory`、`openPath`、`readInjectedDocs`、`sessionCwd`)。该条目是加法性的:与其他浮层表面共存,不替换任何出厂 UI。

注入文档从会话的公开对话快照投影而来——持久化来源不是人类的 `context` 聊天节点——因此面板从不自行打开文件。文件夹标签页通过共享的主机 browse 能力列出子目录与文件,并经其有界读取预览文本文件;非文本文件只显示名称。

## Model Experience

None, as this browser-side panel only reads already-logged session facts and the Host directory-browse capability; it registers no prompt, tool schema, or model-visible content.

#### KV Cache effect

Independent: the panel contributes nothing to any model request prefix, so mounting, opening, or switching its tabs neither invalidates nor enables reuse of any provider cache entry.

## Known Limitations and Deferred Work

- **仅文本文件** — 文件夹标签页预览 `.md`/`.markdown`/`.txt`;其他文件只显示名称(无二进制或未知格式读取)。读取受后端配置上限约束,截断时给出提示。
- **窗口内投影** — 上下文标签页实时重投影(会话切换、事件流前进或显式点击刷新都会触发),但只覆盖已加载的历史窗口;更早的注入文档需翻页后进入。
- **仅呈现** — 点击目录会在系统文件管理器中打开;面板从不写入文件。
