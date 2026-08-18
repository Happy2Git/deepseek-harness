# 交互式终端前门

[English](tui.md) | 中文

来自 [`dsh-tui`](../../packages/ui/tui) 的终端前门。它通过公开注册表创建一个 agent，从 `session/event` 渲染持久化的会话 transcript，并通过一个具体宿主接住 `interaction` 的三个 seam（`commands`、`approval`、`userQuestions`）——不实现 agent 循环、不持久化会话、也不定义工具。

Source: [`packages/ui/tui/src/index.ts`](../../packages/ui/tui/src/index.ts)

## 扩展 seam

两个面向插件的服务扩展终端界面。`ctx.tui` 打开全屏浮层组件（`openOverlay`）；`ctx.tuiPrompt` 按名称注册状态行片段，并按插入顺序列出当前值。两者都声明在本包的 Context merge 中；完整界面由 [包 README](../../packages/ui/tui/README.md) 负责，profile 组合由 [CLI bundle](../../packages/bundle/cli/README.md) 负责。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtui--tuiextensionservice"></a>

### `ctx.tui` — `TuiExtensionService`

Modal-overlay front door exposed to other plugins as `ctx.tui`.

```ts cordis-catalog
/**
 * Open one fullscreen overlay component; the returned handle controls it.
 * @param component - the fullscreen overlay component to open.
 * @param options - optional overlay presentation options.
 * @returns the handle that controls the opened overlay.
 */
openOverlay(component: Component, options?: OverlayOptions): OverlayHandle
```

Source: [`packages/ui/tui/src/index.ts:66`](../../packages/ui/tui/src/index.ts)

<a id="ctxtuiprompt--tuipromptservice"></a>

### `ctx.tuiPrompt` — `TuiPromptService`

Status-line value registry exposed to other plugins as `ctx.tuiPrompt`.

```ts cordis-catalog
/**
 * Register one footer fragment by name; the returned disposer removes it.
 * @param name - the fragment's name.
 * @param fragment - the status-line fragment text to register.
 * @returns a disposer that removes the registered fragment.
 */
register(name: string, fragment: string): () => void

/**
 * Current registered fragments in insertion order.
 * @returns the registered fragments keyed by name, in insertion order.
 */
values(): ReadonlyMap<string, string>
```

Source: [`packages/ui/tui/src/index.ts:50`](../../packages/ui/tui/src/index.ts)
<!-- END GENERATED cordis-surface -->
