# Agent Note: Trigram tokenizer option for the SQLite session-query index

Status: implemented

## Problem

The web sidebar content search (and any consumer of `searchSessions`) is
unusable for short Chinese terms under the default FTS5 `unicode61`
tokenizer. A space-free CJK sentence indexes as one long token, and no MATCH
operator reaches inside it, so a two-character query like `搜索` folded into
`今天讨论会话搜索功能的性能` never matches. English works because words are
space-delimited. Substring semantics existed only through the inherited
`filterEvents()` `text` clause, which is not the sidebar's path.

This is a companion to the [content-search opt-in decision]
(2026-08-13-session-content-search-opt-in.md): that note owns *whether* the
index runs (`openAt`), this one owns *how it tokenizes*.

## Decision

`SqliteSessionQueryEngine` gains `tokenize: 'unicode61' | 'trigram'`
(default `unicode61`). The value parameterizes both FTS5 DDLs, and opening a
database whose stored tokenizer differs from the configured one rebuilds the
derived tables from the logs — the same reset path as a schema-version bump,
without bumping it, because the layout itself is unchanged.

Under `trigram`, queries of three or more code points run as FTS5 phrase
MATCHes (arbitrary substring recall); shorter queries cannot be expressed as
trigram MATCHes at all, so they take a dedicated LIKE-shaped variant of the
document-selection SQL. The variant keeps the downstream CTE shape identical:
the first hit is marked by hand (`instr`/`substr` — `highlight()` requires a
MATCH query), and `match_count` still counts real occurrences via
`replace()` arithmetic, so session ranking stays comparable.

## Alternatives considered

- **Default the whole engine to `trigram`.** Rejected: it would force a
  rebuild and roughly 3x index size on every existing deployment, including
  English-heavy ones with no CJK need. Keeping `unicode61` the default
  preserves the upgrade path for all current consumers.
- **A separate `bigram` tokenizer for CJK.** Rejected: FTS5 ships no CJK
  tokenizer out of the box and `trigram` already gives substring recall at a
  bounded size; a custom tokenizer adds maintenance with no recall win.
- **Always fall back to the LIKE scan.** Rejected: it cannot use the FTS
  index, so full-document substring scans would replace indexed MATCHes even
  for long, well-formed queries.

## Consequences

- Default behavior, index size, and upgrade path are unchanged; only
  deployments that opt in pay the ~3x index size and the one-time rebuild.
- The substring scan loses MATCH-based ranking for sub-three-code-point
  queries (`match_count` still counts occurrences); acceptable for terms
  that short.
- `dsh-web-cross-session`'s composition patch sets `tokenize: trigram` so
  its sidebar search works for Chinese out of the box.
