# Agent Note: The context-and-files right panel

Status: implemented

English | [中文](2026-08-15-context-files-panel.zh.md)

## Problem

The web GUI had no right-side surface for workspace context: directory browsing, the session's injected-context documents, and git history each needed a home that stays fixed and never covers the conversation. The left sidebar exists as a sibling surface, but its contract (navigation, session list) is not the panel's; the panel had to be its own slot entry with its own viewing state.

## Decision

**One plugin package, one overlay entry.** `dsh-client-ui-context-files` registers one list-slot entry (`id: context-files`) into the layout-declared `shell.overlay`, rendering the fixed right panel (`PanelRoot`): three tabs — files (lazy `FileTree`), context (projected injected documents with "load older" paging), git (lane graph) — plus a centered preview dialog that opens when a file row is clicked (no lower pane). Viewing state (tab, width, expanded dirs, filter, center file, docs cursor) lives in a declared store factory (`createPanelStore`) shared across the entry; per-directory listings are component-local.

**The injected face, not ctx.** Components receive everything through the four props shares; the `inject` face closes over the apply context and exposes plain callbacks: `listDirectory`/`readText`/`openPath`/`gitGraph`/`gitShowCommit` fetch the plugin-owned `/dir/*` and `/git/*` routes (`routeFetch`), while `readInjectedDocs`/`hasMoreDocs`/`loadOlderDocs`/`sessionCwd` project the session log and the sessions snapshot. The face functions are typed as property functions (the arrow closures apply produces), which keeps `unbound-method` lint silent at every pass-through site.

**Conversation reserve via a CSS variable.** `PanelRoot` writes `--dsh-context-panel-width` (0px when collapsed, the state width otherwise) on `document.documentElement`; `ConversationRoot.module.css` reads it as `padding-right`, so the panel never overlaps chat. At ≤720px the panel auto-collapses to its rail (`matchMedia` in the component) and the media query drops the reserve with `transition: none` — the transition would otherwise leave a mid-animation measurement.

**The header utilities slot.** The panel's register call declares `panel.header.utilities` (list, root scope) in its `children`; `dsh-session-log-export` registers the session-log download action into it, so the download affordance lives on the panel surface instead of the conversation header the panel covers.

## Alternatives considered

**A second sidebar column in ui-layout.** Rejected: the slot system's `shell.overlay` is the shipped seat for a surface of your own, and a layout-owned column would widen the shell contract for one feature.

**Preview pane inside the panel.** Rejected: the user asked for click-to-open in the center; a centered dialog keeps the file content large without squeezing the tree.

**Panel state in the component only.** Rejected: tab selection, width, and expansion survive remounts (HMR) through the declared store; per-directory listings stay component-local because nothing else reads them.

## Consequences

The panel is purely presentational — it reads logged context and filesystem facts, and submits nothing to the model. `shell.overlay` is upstream, so the standalone `dsh-compass` package reproduces this entry verbatim; the fork's conversation reserve CSS is fork-only, so `dsh-compass` ships its own reserve (`--dsh-compass-width` plus a `:has()` rule against the shell's `[data-shell-overlay]` hook) that never double-pads beside the fork rule.

## Testing

`packages/client/ui-context-files/tests/panel.client.spec.tsx` renders `PanelRoot` with a driven store and stub face: tab switching, collapse/expand, document paging, file-to-center-preview, unreadable-file verdict, hidden-entry filtering, the symlink cycle guard, and abort-on-unmount of in-flight listings. Store tests cover the viewing-state actions. The replayed browser e2e (`apps/web/tests/context-files-panel.e2e.ts`) pins the assembled surface.
