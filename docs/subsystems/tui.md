# Interactive Terminal Front Door

English | [中文](tui.zh.md)

The terminal front door from [`dsh-tui`](../../packages/ui/tui). It creates one agent through the public registry, renders the durable session transcript from `session/event`, and answers the `interaction` seams (`commands`, `approval`, `userQuestions`) through one concrete host — without implementing the agent loop, persisting sessions, or defining tools.

Source: [`packages/ui/tui/src/index.ts`](../../packages/ui/tui/src/index.ts)

## Extension seams

Two plugin-facing services extend the terminal surface. `ctx.tui` opens fullscreen overlay components (`openOverlay`); `ctx.tuiPrompt` registers status-line fragments by name and lists the current values in insertion order. Both are declared in this package's Context merge; the [package README](../../packages/ui/tui/README.md) owns the full surface, and the [CLI bundle](../../packages/bundle/cli/README.md) owns the profile composition.

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
