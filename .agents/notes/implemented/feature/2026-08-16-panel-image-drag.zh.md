# Agent Note: 面板图片拖拽与模型能力录入

Status: implemented

[English](2026-08-16-panel-image-drag.md) | 中文

## 问题

编辑器的整页拖放录入在浏览器里读取 OS 拖入的文件，暴露的是内容而不是路径。从上下文文件面板拖出的文件行正好相反：面板知道绝对宿主路径，浏览器从没见过字节。对 OCR 能力模型（deepseek-v4-pro），设计要求模型 API 直接收到图片内容；对其他模型，拖入应退化为一句路径说明，由 agent 用自己的工具处理。任何情况下都不在工作区复制文件——原路径就是引用。

## 决策

**面板行携带路径载荷；编辑器解析能力后再惰性读取。** `FileTree` 文件行可拖拽（`draggable`），把自定义拖拽类型 `application/x-dsh-path`（字面量在 ui-context-files 与 ui-conversation 各存一份；两包不得互相导入）设为绝对路径。编辑器的 document 级 drop 处理器在 `Files` 分支之前读取该类型，然后：

- 通过新增的 `sessions.imageInput` RPC 探测会话当前模型（`boolean | null`：`ctx.llm.resolveModelInfo(...).inputModalities` 是否含 `image`；未知或不可解析的路由回答 `null`，客户端把 `null` 当作不具备能力）；
- 模型具备图片能力时，经新增的插件路由 `/dir/read-image` 读取字节，作为普通草稿图片附加，然后把「已拖入图片 <path>，图片内容已附在本条消息中。」折入草稿；
- 否则（或任何读取/能力探测失败时）只折入「已拖入图片 <path>。」；点名边界的路由失败（413）改为弹出既有的单文件上限文案。

**browse seam 上的 `readImage`，读不到即失败。** `DirectoryPickerBrowseCapability.readImage(path, signal)` 返回完整原始字节（`DirectoryImageRead { path, data }`），后端 `maxImageBytes` 配置（默认 8 MiB，高于 5 MiB 的附件准入默认值）；超过边界抛出新的封闭错误码 `file-too-large`，绝不截断读取。路由先执行已组合的 `attachments.imageLimits.maxImageBytes` 检查（413），再按魔数嗅探 PNG/JPEG/WebP/GIF 之一（否则 415——扩展名永远不作依据），回答规范 base64。准入环节仍会重新校验解码后的位图，所以路由只是传输，不是权威。

**模型可见 ⟺ 已记录。** 两种结果都通过普通草稿机（`keyboard.setDraft`）写入录入句子，消息因此是普通 `user/message`；附加的图片走既有的草稿图片路径，带持久化附件记录。

## 备选方案

**服务端按路径附加。** 否决：需要新的 prompt 内容部件类型和第二条持久化图片保存路径；把字节取回浏览器并复用草稿图片流程只多一条读取路由。

**复用 `/dir/read-text` 加 base64。** 否决：文本路由是有界*截断*读取，服务于预览；图片录入必须要么完整字节要么什么都没有。

**不管模型一律允许附加，让 provider 拒绝。** 否决：用户批准的是双模式录入；非图片模型应收到路径句子，而不是回合中途的 provider 失败。

## 后果

面板拖入的图片在任何模型上都能用：具备图片能力的路由直接多模态附加，否则给路径引用，永不复制进工作区。能力探测是 UX 降级探针（失败收敛为 `null`），不是配置。路由与其余 `/dir/*` 一样仅限回环，并随面板携带其传输，因此独立发布的 dsh-compass 包在自己的 directory-routes 里镜像 `read-image`。

## 测试

- `packages/host/directory-picker-browse/tests/service.spec.ts`：完整读取、边界处 `file-too-large`、非限定路径、中止、文件缺失。
- `packages/host/directory-routes/tests/routes.spec.ts`：base64 与逐格式魔数嗅探、未知内容 415、组合附件限制下的 413、400 校验。
- `packages/host/apiproxy/tests/api-proxy-models.spec.ts`：`imageInput` 的 true/false/null、不可解析路由、未知会话。
- `packages/client/ui-context-files/tests/panel.client.spec.tsx`：文件行拖拽设置路径载荷。
- `packages/client/ui-conversation/tests/input-bar.client.spec.tsx`：具备能力时附加加句子、不具备时只加句子、413/415 提示、传输失败降级。
- `packages/client/ui-conversation/tests/apply-inject.client.spec.tsx`：两个注入面对 connection RPC 与路由 fetch 的行为。
