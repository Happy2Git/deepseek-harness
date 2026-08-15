# @deepseek-ai/dsh-host-git

English | [中文](README.zh.md)

The web GUI host's read-only git history is a capability seam. The abstract `Git` service (`ctx.git`) is its Service Definition: `graph(cwd, options, signal)` returns one bounded page of the topo-ordered commit DAG, and `showCommit(cwd, hash, signal)` returns one commit's metadata and changed-file list. There are deliberately no write primitives — staging, committing, branching, and their kin stay out of this seam. The only implementation is the local backend ([`-local`](../git-local/README.md)), which shells out to the `git` binary over `ctx.subprocess`. Both primitives take the repository path explicitly (`cwd`), so the client drives which workspace is browsed and the host never resolves against its own working directory.

Failures use the typed `GitError` (`git-unavailable` / `not-a-repository` / `commit-unreadable`), which the consuming gateway maps 1:1 onto wire error codes. `GitGraphPage` carries `hasMore` and `GitCommitDetail` carries `truncated` so the client can page a large history and bound a large commit without knowing the backend's limits. Design rationale lives in the git capability seam Agent Note.

## Model Experience

None, as the seam serves the GUI host's commit-graph panel; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Read-only by design** — the seam has no commit/stage/branch primitives. Write operations are deferred until a consumer asks for them; they would land here (or in a sibling write seam) rather than in the client.
- **Single repository per call** — `cwd` scopes one repository; a multi-repo overview is not modeled.
