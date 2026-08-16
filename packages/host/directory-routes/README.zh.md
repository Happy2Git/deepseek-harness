# @deepseek-ai/dsh-host-directory-routes

[English](README.md) | 中文

为上下文文件面板的目录浏览提供的插件自有 HTTP 路由。浏览器侧面板无法直接访问 `ctx.directoryPicker`，而核心 API 网关是一个封闭契约，因此本插件把面板的传输一并携带：它在 `ctx.webServer` 上注册五条精确路由，并全部由已组合的 `ctx.directoryPicker` browse 能力应答。

- `/dir/list`（`{ path? }`）——某一目录层的列举、祖先链与 `truncated` 上限。省略 path 时列举主目录。
- `/dir/read-text`（`{ path }`）——某个文件的有界、已解码文本。
- `/dir/read-image`（`{ path }`）——某个图片文件的原始字节（规范 base64）加按魔数嗅探出的媒体类型；超过已组合的附件单文件上限时读取失败（413），内容不是 PNG/JPEG/WebP/GIF 时回答 415。
- `/dir/injected-docs`（`{ sessionId }`）——从完整持久化日志中筛出某个会话的注入文档源事件（持久化存储 + 活跃会话未落盘事件，按 seq 去重）；只含文本块，工具载荷绝不跨线。可选服务（`sessionPersistence`/`sessions`）缺失时退化为空折叠。
- `/dir/open-path`（`{ path }`）——用操作系统默认应用（macOS 为 `open`，Windows 为 `Invoke-Item`，其他为 `xdg-open`）通过 `dsh-native-command` 无 shell 打开某个宿主路径。

路由会明确失败：非 `browse` 后端以 400 应答并附上其组合 kind，字段缺失以 400 应答，抛出的失败以 400 应答并附上其消息。路由处理函数从不拼接路径片段，也不相对宿主工作目录解析；每个路径都是 browse 能力的绝对、完全限定值。

## 模型体验

无。这些路由服务于 GUI 宿主的目录浏览面板；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **最小化打开**——`open-path` 只使用平台默认应用（`open`/`Invoke-Item`/`xdg-open`），忽略文本编辑器意图。完整且感知意图的打开器仍在核心 `native-path-opener` 中；面板其余部分并不需要它。
