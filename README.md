# DeepSeek Harness — context-panel fork

English | [中文](README.zh.md)

A fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that adds a right-side context-and-files panel, panel-file drag into the conversation, and conversation reserve. Everything else tracks upstream.

## What this fork adds

### Right-side context and files panel

A persistent, resizable panel pinned to the right edge of the Web UI, with three tabs:

- **Files (文件夹)** — browse the session's workspace directory with directories-first order, a basename filter, git working-tree status badges, and per-row open/copy actions.
- **Context (上下文)** — the injected-context documents read from the session log, split into the live window (当前有效) and the compaction history stream (历史流水), with search over both. The view re-projects itself as the session streams and auto-walks the session history on activation (up to 1,000 messages), so both sections hold the complete log without manual paging.
- **Git** — a framed working-tree block (branch position, uncommitted files) above a read-only commit graph in IDE-history style, with a refresh control; expand a commit to see its changed files, click a workspace row or a commit file to open its diff in the centered pop-out. Diff previews are colored by line role (additions, deletions, hunk headers).

![Files tab](screenshots/01-files-tab.png)
![Git tab](screenshots/02-git-tab.png)
![Context tab](screenshots/03-context-tab.png)
![Files tab, directories first](screenshots/04-files-tab-dirs-first.png)
![Working-tree diff preview](screenshots/06-workspace-diff.png)

### Drag panel files onto the conversation

File rows in the panel drag their absolute path into the conversation. For image files on an image-capable model, the image content is read and attached to the message directly; any other model (or a read failure) receives the path sentence, which the agent can act on with its tools. Nothing is copied into the workspace.

![Panel file drag](screenshots/05-drag-image.png)

### Text-file drop intake

Dropping text files anywhere on the page attaches them as chips; their content is folded into the message at submit, never pasted into the text box.

### Conversation reserve

The conversation reserves right-side space for the panel, so the panel never overlaps the chat.

## Run

From npm (upstream package):

```sh
npx @deepseek-ai/dsh web
```

From source:

```sh
git clone https://github.com/Happy2Git/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

The Web UI is served at `http://127.0.0.1:3080` by default.

## The extractable plugins

The panel and its git/directory backends are published separately as ecosystem plugins — see [dsh-compass](https://github.com/Happy2Git/dsh-compass). A terminal TUI (`dsh-terminal`) is packaged the same way and stays local until its feature set grows.

## License

MIT. Copyright (c) 2026 DeepSeek. This fork keeps the upstream [LICENSE](LICENSE).
