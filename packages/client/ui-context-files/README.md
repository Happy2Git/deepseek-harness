# @deepseek-ai/dsh-client-ui-context-files

English | [中文](README.zh.md)

Browser-side panel plugin: a right-docked floating surface registered into the layout's `shell.overlay` slot, with two views:

- **Context tab** — lists the current session's injected-context documents (workspace instructions, skill invocations, goal notices, cross-session recalls) and previews the selected one with the shared safe `MarkdownText` renderer; a "load earlier" control pages the log window back to the session-start baseline (AGENTS.md and friends).
- **Files tab** — browses the session workspace directory tree through the Host `browse` capability: directories expand lazily, files render as leaves, previewable text files (`.md`/`.markdown`/`.txt`) open in a lower preview pane through the Host's bounded read, plus a name filter and "open in file manager" rows.

The node half is deliberately empty; everything this package does is presentation over already-available runtime facts.

## Composition

The browser half registers one list-slot entry (`id: context-files`) into the layout-declared `shell.overlay` slot through `ctx.slots.inject`, with the panel's viewing-state store (`createPanelStore`) and an injected face of plain callbacks (`listDirectory`, `openPath`, `readInjectedDocs`, `sessionCwd`). The entry is additive: it sits beside any other overlay surface without replacing shipped UI.

Injected documents are projected from the session's public conversation snapshot — `context` chat nodes whose durable source is not the human — so the panel never opens files itself. The files tab lists child directories and files through the shared Host browse capability, and previews text files through its bounded read; non-text files render as inert names.

## Model Experience

None, as this browser-side panel only reads already-logged session facts and the Host directory-browse capability; it registers no prompt, tool schema, or model-visible content.

#### KV Cache effect

Independent: the panel contributes nothing to any model request prefix, so mounting, opening, or switching its tabs neither invalidates nor enables reuse of any provider cache entry.

## Known Limitations and Deferred Work

- **Text files only** — the files tab previews `.md`/`.markdown`/`.txt`; every other file renders as an inert name (no binary or unknown-format read exists). Reads are bounded at the backend's configured maximum, reported with a truncation note.
- **Manual refresh** — the context tab re-reads on session switch and on the explicit refresh control; mid-turn injections appear after the next refresh rather than live.
- **Presentation only** — clicking a directory opens it in the OS file manager; the panel never writes files.
