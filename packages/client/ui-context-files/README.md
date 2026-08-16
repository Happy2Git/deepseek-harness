# @deepseek-ai/dsh-client-ui-context-files

English | [中文](README.zh.md)

Browser-side panel plugin: a right-docked floating surface registered into the layout's `shell.overlay` slot, with three tabs plus centered pop-outs:

- **Context tab** — the session's injected-context documents (workspace instructions, skill invocations, goal notices, cross-session recalls) split into the live window and the compaction history stream, with search over both; the view re-projects as the session streams and auto-pages one history batch when a checkpoint lands. A click opens a document in the centered pop-out.
- **Files tab** — browses the session workspace directory tree through the Host `browse` capability: directories expand lazily, files render as leaves with git working-tree status badges, previewable text files (`.md`/`.markdown`/`.txt`) open in the centered pop-out, plus a name filter and "open in file manager" rows.
- **Git tab** — a framed working-tree block (branch position, uncommitted files — each row opens the file's working-tree diff) above a read-only commit graph with lanes, ref badges, lazy commit expansion, and a refresh control; a commit file opens its diff in the centered pop-out.

Diff pop-outs render the unified diff colored by line role (additions, deletions, hunk headers, file headers) and truncated with a note at the backend's byte bound. The node half is deliberately empty; everything this package does is presentation over already-available runtime facts.

## Composition

The browser half registers one list-slot entry (`id: context-files`) into the layout-declared `shell.overlay` slot through `ctx.slots.inject`, with the panel's viewing-state store (`createPanelStore`) and an injected face of plain callbacks (`listDirectory`, `openPath`, `readInjectedDocs`, `sessionCwd`). The entry is additive: it sits beside any other overlay surface without replacing shipped UI.

Injected documents are projected from the session's public conversation snapshot — `context` chat nodes whose durable source is not the human — so the panel never opens files itself. The files tab lists child directories and files through the shared Host browse capability, and previews text files through its bounded read; non-text files render as inert names.

## Model Experience

None, as this browser-side panel only reads already-logged session facts and the Host directory-browse capability; it registers no prompt, tool schema, or model-visible content.

#### KV Cache effect

Independent: the panel contributes nothing to any model request prefix, so mounting, opening, or switching its tabs neither invalidates nor enables reuse of any provider cache entry.

## Known Limitations and Deferred Work

- **Text files only** — the files tab previews `.md`/`.markdown`/`.txt`; every other file renders as an inert name (no binary or unknown-format read exists). Reads are bounded at the backend's configured maximum, reported with a truncation note.
- **Bounded history walk** — the context tab re-projects live (session switch, stream advance, or the explicit refresh control) and auto-walks the session history on activation — up to 20 older batches (1,000 messages) — so both sections hold the complete log; anything deeper stays behind the manual paging control.
- **Presentation only** — clicking a directory opens it in the OS file manager; the panel never writes files.
