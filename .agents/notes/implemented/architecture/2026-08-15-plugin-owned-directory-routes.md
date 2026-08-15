# Agent Note: Plugin-owned directory routes and the browse readText primitive

Status: implemented

English | [中文](2026-08-15-plugin-owned-directory-routes.zh.md)

## Problem

The context-files panel lists directories and previews file text, but the browser cannot reach `ctx.directoryPicker` directly, the core API gateway is a closed contract, and the browse capability only had `list` + `createDirectory` — there was no text-read primitive anywhere on the seam. The panel needed listing, bounded text reads, and open-with-default-application on routes it owns, with the same security posture the panel's git routes got.

## Decision

**The browse capability gains `readText`.** The seam (`dsh-host-directory-picker`) adds `DirectoryRead { path, text, truncated }` and `readText(path, signal)` to `DirectoryPickerBrowseCapability`; the browse backend (`directory-picker-browse`) implements it as one bounded read (`maxTextBytes` + 1 proves the cut) with a NUL-byte binary verdict (`file-not-text`) and the same fully-qualified path fence and abort racing as `list`.

**The plugin registers its own routes.** `dsh-host-directory-routes` registers `/dir/list`, `/dir/read-text`, and `/dir/open-path` on `ctx.webServer` and answers them from the composed browse capability. The route posture mirrors git-local: loopback-only (refuse to load on a non-loopback host), Content-Type 415, 64 KiB body cap 413, strict JSON 400, fully-qualified absolute-path validation (posix/win32 dual check), and `requestSignal` abort-on-disconnect. `/dir/open-path` hands the path to the platform opener — `open(1)` on macOS, PowerShell `Invoke-Item -LiteralPath` with quote-doubling on Windows, `xdg-open` elsewhere — through `openPathNative(path, signal, internals)` whose `{ platform?, run? }` hooks make dispatch tests deterministic without rewriting `process.platform`.

**The listing sort is directories-first.** The browse backend streams each level through a bounded window (maxEntries + 1) ordered by `(isDirectory, name)`; a symlink's group is its target's kind, probed via `stat` during the stream, so a symlinked directory sorts with the directories. The truncation tail follows the same order.

## Alternatives considered

**Grow the apiproxy with `host.readText`.** Rejected (and the first cut was removed): a closed gateway contract must not grow one surface's domain methods; the git routes already set the plugin-owned transport precedent.

**Ship only the native chooser.** Rejected: remote browsers get no OS dialog; the in-app browser is the only transport that works for every client.

**Read text in the browser via a blob URL.** Impossible for the same reason listing is: the browser has no filesystem access.

## Consequences

The panel's directory data rides routes the plugin owns, so the seam change (`readText`) is the only shared-contract cost. That primitive and the routes are fork-only; the standalone `dsh-compass` package re-owns the whole browser (list + read + create implemented locally) so the panel can run on any dsh composition, including main-track profiles whose directoryPicker resolves a native chooser on desktops.

## Testing

`packages/host/directory-routes/tests/routes.spec.ts` covers registration, delegation to the browse capability, 415/413/400 paths, relative-path rejection, and open-path dispatch; `tests/open-path-native.spec.ts` covers the platform dispatch and signal pass-through through injected internals. `packages/host/directory-picker-browse/tests/service.spec.ts` covers listing bounds, the directories-first order (symlinked directories included), and the readText cut/binary verdicts.
