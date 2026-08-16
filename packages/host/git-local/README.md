# @deepseek-ai/dsh-host-git-local

English | [中文](README.zh.md)

The local backend of the git seam: it registers `ctx.git` and serves the read-only primitives by shelling out to the `git` binary over `ctx.subprocess` in collected-output mode. `graph(cwd, options)` runs `git log --all --topo-order --date-order` with a `--pretty=format:` string whose fields are `%x00`-separated and records `%x1e`-separated, requesting one extra commit to prove `hasMore`. `showCommit(cwd, hash)` runs `git show -m --first-parent` twice — once for the metadata + `--name-status`, once for `--numstat` — and merges the two by path. `-m --first-parent` makes the diff well-defined for merge commits (first-parent diff) and root commits (diff against the empty tree) alike. `showFileDiff(cwd, hash, path)` runs `git show --format= --unified=3`; `showWorkspaceDiff(cwd, path)` diffs the working tree against HEAD for tracked files and against an empty temp file (`--no-index`, whose exit 1 is the difference) for untracked files. The plugin also serves the panel's routes on `ctx.webServer`: `/git/graph`, `/git/show-commit`, `/git/workspace`, `/git/show-diff`, `/git/workspace-diff`, `/git/status`.

Collected stdout and stderr are capped at `maxOutputBytes`, the commit page at `maxCommits`, and one commit's file list at `maxFiles`. Failures use the typed `GitError`: a spawn-level failure (the binary cannot run) is `git-unavailable`, a `not a git repository` stderr is `not-a-repository`, and an unknown revision is `commit-unreadable`. The policy decisions (read-only scope, path quoting, single-repository `cwd`) live in the git capability seam Agent Note.

## Model Experience

None, as the seam serves the GUI host's commit-graph panel; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Path quoting** — `--name-status`/`--numstat` output is parsed with git's default `core.quotePath`; paths with spaces or non-ASCII characters arrive quoted, and a tab inside a path is not handled. `-z` (NUL-terminated raw output) is the fix when a consumer needs exact paths.
- **No rename detection** — `--no-renames` flattens a rename into a delete + add pair.
