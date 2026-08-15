# Agent Note: A read-only git capability seam for the web-GUI commit graph

Status: implemented

English | [中文](2026-08-15-git-capability-seam.zh.md)

## Problem

The web GUI's context-and-files panel had no way to show a workspace's git history. The desired feature is a read-only commit graph — the topo-ordered commit DAG drawn as colored lanes (branches fork new lanes, merges join them), with click-to-expand changed files — modelled on vibe-ide's `GitGraph`. There was no existing git capability anywhere in the harness: no Service Definition, no provider, no wire route, and no client face. Building it required a new capability seam, not an extension of an existing one.

## Decision

A two-package host seam in `packages/host/` — `git` (Service Definition, the abstract `Git` service + `GitError`) and `git-local` (the only backend, which runs the `git` binary over `ctx.subprocess` in collected-output mode). The seam is **read-only by construction**: it exposes exactly two primitives and no write verbs.

- `graph(cwd, options, signal)` → `GitGraphPage { entries, hasMore }`. Runs `git -C <cwd> log --all --topo-order --date-order --skip=N --max-count=N+1 --pretty=format:%H%x00%P%x00%D%x00%s%x00%aN%x00%aI%x1e` — `%x00` separates fields, `%x1e` separates records, and one extra commit proves `hasMore` without a second round trip.
- `showCommit(cwd, hash, signal)` → `GitCommitDetail { hash, message, author, date, files, truncated }`. Runs `git show -m --first-parent --no-renames --format=%H%x00%B%x00%aN%x00%aI%x1e --name-status <hash>` (metadata + status in one invocation, the `%x1e` record end separating the header from the status stream) and `git show -m --first-parent --no-renames --format= --numstat <hash>`, merging the two by path.

The `-m --first-parent` pair makes the diff well-defined for all three commit kinds at once: a normal commit diffs its first parent, a merge commit diffs its first parent (rather than `git show`'s default empty combined diff), and a root commit diffs the empty tree. `--no-renames` flattens a rename into a delete + add pair, so a file's path is a stable merge key and the closed status union is `added | modified | deleted`.

**Wiring follows the directory-picker seam exactly.** `dsh-host-apiproxy` serves `host.gitGraph` / `host.gitShowCommit` (rpc-map, host contract + zod schema, fetch client/handler routes), reads the service via `ctx.get('git')` (optional composition — absent answers `git-unavailable`), and maps `GitError` (`git-unavailable` / `not-a-repository` / `commit-unreadable`) 1:1 onto wire error codes. The client rides `ctx.workspaces` (`gitGraph`/`gitShowCommit` added to `IWorkspaces` and `WorkspaceRuntime`) rather than a new client service, because git browsing is the same "browse the workspace" family as `listDirectory`/`readText` and has one consumer (the panel); a dedicated `ctx.git` client service is the deferred home if a second consumer appears. The panel (`dsh-client-ui-context-files`) gains a third tab (`git`) rendering a new `GitGraph` component — a lane solver ported from vibe-ide (`buildGraphRows`: each active branch a lane with a cycled `--dsw-alias-*` token color, head/merge dots, ref badges) — with component-local pagination and lazy commit expansion.

**Bounds and policy.** Collected stdout/stderr cap at `maxOutputBytes` (262144), the page at `maxCommits` (100), one commit's file list at `maxFiles` (500). `cwd` is explicit on every call — the host never resolves against its own working directory. The backend never writes, and `git` failures are classified from stderr (`not a git repository`, `unknown revision`/`bad object`) into the closed codes; a spawn-level failure (binary missing) is `git-unavailable`.

## Alternatives considered

- **Extend `ctx.fs`.** Rejected: `packages/fs/` is the model/session storage stack (policy events, sandbox-swappable backends); git history is a presentation-free read view, not a storage primitive, and coupling it to the model's confinement backend would be the same authority-domain mistake the directory-picker note records.
- **One package instead of Service Definition + Provider.** Rejected: the repo's capability-seam rule wants the vocabulary split from the implementation; the directory-picker precedent (`directory-picker` + `-browse`/`-native`) is the template, and a future backend (a sandboxed or remote git) is the independent-evolution case.
- **A dedicated client `ctx.git` service.** Rejected for now: one consumer and the same wire shape as the existing workspace-browse primitives; adding two methods to `ctx.workspaces` is the smallest correct change, and the note records the deferred extraction.
- **Write primitives (commit/stage/branch/stash/push).** Rejected: the requested feature is a read-only graph; write operations would land here (or a sibling write seam) only when a consumer asks, and the seam's read-only guarantee is the reason the client needs no approval wiring.
- **Adopting a git library (`simple-git`, `nodegit`).** Rejected per the dependency bar: `git log`/`git show` with `--pretty=format:` is a stable, self-contained parsing surface over a `--x00`/`--x1e` delimited format, and `ctx.subprocess` already provides bounded collected output and abort handling. A dependency would delete no owned code.
- **A rename-aware file list.** Rejected for the first cut: `-M` output would make a file's path a non-stable merge key (rename entries carry old + new); `--no-renames` keeps the list stable and the status union closed.

## Consequences

- **Bought:** a read-only commit graph in the shipped panel — lane visualization, lazy commit expansion, bounded paging — over a real `git` backend, wired end-to-end through the existing seam machinery with no new client service.
- **Cost / deferred:** `--name-status`/`--numstat` output is parsed with git's default `core.quotePath`, so paths with spaces or non-ASCII arrive quoted (a tab inside a path is not handled); `-z` (NUL-terminated raw output) is the fix when a consumer needs exact paths. Renames show as delete + add, not a single renamed row. Single repository per call; no multi-repo overview. No writes.
