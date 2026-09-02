# Agent Note: Remove per-event copying and eager hashing from session-query indexing

Status: implemented

English | [中文](2026-08-26-session-query-cold-index-cost.zh.md)

## Problem

Building the SQLite session-query index from cold took 41s over a real 127-log corpus (7.46M events, 41k documents, 54M indexed characters), and that cost is paid inside the first `searchSessions` call under `openAt: 'first-search'`. Phase timing attributed it to `observeSession`, not to I/O or SQLite: 30.8s of the 41s was event observation, of which 18.3s was `events.map(event => structuredClone(event))` and 5.3s was a SHA-256 over `JSON.stringify` of the whole log.

Neither cost bought anything. `ObservedSession` exposes only `header`, `documents`, and `fingerprint` — the cloned event array was never retained, and `buildSessionEventSearchDocuments` takes `readonly SessionEvent[]` and copies out every field it keeps. The fingerprint is read at exactly two places, both on the live path (the `liveChanges` comparison and the `temp.live_sessions` insert); persisted sessions are change-detected by their persistence revision and the `persisted_sessions` table has no fingerprint column, so the hash computed while indexing 127 persisted logs was discarded.

## Decision

`observeSession` reads the caller's event log directly and computes the fingerprint through a caching getter.

Dropping the copy is safe because the whole function body is synchronous: the projection and the hash both finish before any `await` can let a live session append. The copy could only have protected against a consumer retaining or mutating the log, and the one consumer does neither. `header` is still cloned — it is one small object, and the observation stores it.

Making the fingerprint lazy keeps its value identical. Both readers run in the synchronous continuation of the same `_observeStable` result that produced the observation, so no append can intervene between observing a live session and hashing it; the persisted path never reads the property and now never hashes.

## Alternatives considered

**`PRAGMA synchronous = NORMAL` on the derived index.** Measured and rejected: reconciliation already commits in one transaction, so there is one fsync either way, and the measurement confirmed no change (19.11s to 19.14s). Correct-sounding but inert.

**Bounded-concurrency `persistence.inspect` during reconciliation.** Implemented and reverted: 41.1s to 41.2s. The bottleneck is main-thread CPU, which promise concurrency does not divide. This also would have activated the previously unconsumed `persistedInspectConcurrency` config on the sqlite reconcile path; leaving it unused is preferable to shipping a knob that buys nothing.

**Batching the per-document FTS5 inserts.** Measured and rejected: a synthetic 41k-row batch inserts in 250ms against 7.2s for the real corpus, so the cost is trigram tokenization of 54M characters, not statement dispatch. Multi-row `VALUES` does not reduce tokenizer work.

**Storing a fingerprint for persisted sessions too, for symmetry.** Rejected: persistence revisions already answer the question the fingerprint answers, and hashing every durable log to duplicate that answer is the cost this note removes.

## Consequences

Cold index build over the same corpus drops from 41.1s to 20.6s; warm search is unchanged at ~230ms and results are identical. The remaining cold cost is ~8s reading and decoding logs and ~8.8s of FTS5 trigram tokenization, both of which are real work. Deployments that opt into [`tokenize: trigram`](../architecture/2026-08-22-session-query-trigram-tokenizer.md) pay that one-time rebuild at half the previous price.

`ObservedSession.fingerprint` is now an accessor. Serializing or structured-cloning an `ObservedSession` would force the hash; nothing does, and the two live readers access the property directly.

A regression test appends to a live session between two searches and asserts the second search sees the new event. Replacing the fingerprint with a constant makes it fail, which is what pins the change-detection contract that the removed copy and eager hash used to obscure.
