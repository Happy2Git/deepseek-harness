# Agent Note: Drag-file text intake with whole-batch bounds

Status: implemented

English | [中文](2026-08-15-drag-file-text-intake.zh.md)

## Problem

A browser drag exposes file *content*, not paths — an OS-dragged file handed to the model must be read in the browser, but parking a large body in the input box (or pasting it straight into the draft) bloats the composer and freezes the textarea. The feature needs bounded reads, chips that fold into the message only at submit, and the repo's model-visible ⟺ logged invariant.

## Decision

**Whole-page drop intake with parked chips.** The composer registers document-level drag/drop listeners (the composer slot is `kind: 'single'`, so at most one bar binds them); text files (non-image MIME) are read in the browser and parked as chips (`PendingTextFile { name, content, size }`). The draft stays empty until submit: `foldPendingFiles` then appends fenced blocks (` ```name\ncontent\n``` `) to the draft and clears the chips.

**Bounds, checked before any read, on the complete batch.** Per file ≤ 256 KiB (`MAX_TEXT_FILE_BYTES`), total ≤ 1 MiB (`MAX_TEXT_FILES_TOTAL_BYTES`), count ≤ 20 (`MAX_TEXT_FILES`); a NUL byte marks binary and drops the file. An oversized batch is refused whole with product copy (toast), nothing added. The pre-checks read a ref (`pendingFilesRef`) that reserves each accepted batch's bytes and count *before* the async reads — a rapid second drop whose pre-check lands while the first batch is still reading must count that batch, or two drops could both pass and exceed the caps; an unreadable batch rolls its reservation back. `removePendingFile` and `foldPendingFiles` update the ref and state together (no effect-sync).

**Model-visible ⟺ logged.** The chips only become model input at submit, when folding writes them into `session.prompt` as an ordinary durable `user/message` — the same path as typed text, so replay reconstructs them.

## Alternatives considered

**Paste content into the draft on drop.** Rejected: a 256 KiB body in the textarea freezes editing, and dropping into a live draft makes the drop-undo story one giant text mutation.

**Read lazily at submit.** Rejected: the file snapshot must be read while the OS drag still guarantees it; a later read can miss changes or vanish (the drag exposes content, not a path).

**Bound check against state only.** Rejected: the state updates a render late; two drops in one tick would both pass the pre-check (the ref reserves synchronously, which is the fix).

## Consequences

Dropped text files behave like typed input for logging and replay but cost the composer nothing until submit. Refusal is whole-batch, so a drop that exceeds any bound contributes no partial chips. The intake reads file contents the OS already exposed to the page — no new trust surface, and the bounds are the complete-result envelope.

## Testing

`packages/client/ui-conversation/tests/input-bar.client.spec.tsx` covers chip parking and submit folding, binary refusal, per-file/whole-batch/total-byte/total-count refusals with product copy, the rapid-second-drop race (second batch refused against the first batch's reservation), and the projected-limits overlay copy.
