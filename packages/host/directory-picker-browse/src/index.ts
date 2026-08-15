/**
 * Browse backend of the directory-picker seam: registers `ctx.directoryPicker`
 * with the `browse` capability — one-level directory listing and child-directory
 * creation over the host filesystem via Node's stdlib (which already carries
 * the per-OS adaptation). Nothing renders on the host display, so this backend
 * serves remote clients the dialog backend cannot. Policy decisions (hidden
 * entries flagged but returned, symlinks followed, whole-filesystem scope) are
 * recorded in the directory-picker seam Agent Note.
 * @module @deepseek-ai/dsh-host-directory-picker-browse
 */

import { mkdir, open, opendir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DirectoryPicker, DirectoryPickerError,
} from '@deepseek-ai/dsh-host-directory-picker'
import type {
  DirectoryEntry, DirectoryImageRead, DirectoryListing, DirectoryPickerCapability, DirectoryRead,
} from '@deepseek-ai/dsh-host-directory-picker'

/**
 * Ancestor chain from the filesystem root to `target` inclusive — the
 * breadcrumb rows of a listing, every one a jump target.
 */
function ancestryCrumbs(target: string): DirectoryEntry[] {
  const crumbs: DirectoryEntry[] = []
  let current = target
  for (;;) {
    const parent = dirname(current)
    // basename of a root is '' — label the root crumb by its full path ('/', 'C:\').
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false, kind: 'directory' })
    if (parent === current) return crumbs
    current = parent
  }
}

/**
 * True when the path names one fixed filesystem location regardless of
 * process state: POSIX-absolute on POSIX; on Windows only drive-qualified
 * (`C:\…`) or complete UNC (`\\server\share…`) forms. Rooted drive-less
 * forms (`\foo`, `/foo`) and incomplete UNC prefixes (`\\`, `\\server`)
 * pass `isAbsolute` yet still resolve against the process's current drive.
 * @param path - candidate path.
 * @param platform - replaces `process.platform` for deterministic tests.
 * @returns whether the path is fully qualified on the platform.
 */
export function fullyQualified(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : posix.isAbsolute(path)
}

/** One streamed listing candidate: the dirent facts a row needs, nothing else retained. */
export interface ListingCandidate {
  /** Base name within the streamed level. */
  name: string
  /** Dirent says directory (no probe needed). */
  isDirectory: boolean
  /** Dirent says symlink (enterability needs a stat probe). */
  isSymbolicLink: boolean
}

/**
 * Order two listing candidates: directories first, then files — each group
 * name-ascending. A symlink's group is its target's kind, probed by the
 * caller before the insert.
 */
function compareCandidates(a: ListingCandidate, b: ListingCandidate): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
  return a.name.localeCompare(b.name)
}

/**
 * Insert a streamed candidate into the directories-first bounded window,
 * evicting the largest candidate when the window exceeds `keep`. Memory over
 * an arbitrarily large level therefore stays O(keep) regardless of how many
 * children the directory holds.
 * @param window - the directories-first name-ascending window, mutated in place.
 * @param candidate - the streamed candidate to place.
 * @param keep - the window bound.
 * @returns true when an eviction happened (the level has candidates beyond the window).
 */
export function boundedInsert(window: ListingCandidate[], candidate: ListingCandidate, keep: number): boolean {
  // Full window, candidate at or beyond the tail: one comparison rejects, so
  // an oversized level costs O(1) per candidate past the head instead of a
  // window scan (100k children against a 1,001 window must not approach
  // 10^8 comparisons).
  // oxlint-disable-next-line typescript/no-non-null-assertion -- a full window (length === keep >= 1) has a tail
  if (window.length === keep && compareCandidates(candidate, window[window.length - 1]!) >= 0) return true
  // Binary insertion keeps a retained candidate at O(log keep) comparisons.
  let lo = 0
  let hi = window.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    if (compareCandidates(candidate, window[mid]!) < 0) hi = mid
    else lo = mid + 1
  }
  window.splice(lo, 0, candidate)
  if (window.length <= keep) return false
  window.pop()
  return true
}

/**
 * Await `operation`, but reject with the signal's reason the moment it
 * aborts. Node's filesystem reads are not retractable, so the operation
 * itself keeps running against a handle the caller then closes — its late
 * settlement is swallowed here so an abandoned read cannot surface as an
 * unhandled rejection.
 * @param operation - the in-flight filesystem step.
 * @param signal - caller lifetime; absent means plain awaiting.
 * @returns the operation's value.
 */
export function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      operation.catch(() => {
        // Abandoned read: its handle is being closed by the aborting caller,
        // and the abort reason already carried the outcome.
      })
      reject(asError(signal.reason))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (reason: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(reason))
      },
    )
  })
}

/** The thrown value as an Error (wire/abort reasons may be anything). */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

/* v8 ignore start -- a close failure of an abandoned handle has no consumer, and forcing one needs a filesystem torn down mid-request. */
/** Swallow the close failure of a handle its caller already departed. */
function swallowCloseFailure(): void {}
/* v8 ignore stop */

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  /* v8 ignore next -- node:fs rejects with Error instances; the String arm only satisfies the unknown narrowing. */
  return error instanceof Error ? error.message : String(error)
}

/**
 * One listing row for a dirent, following symlinks: a directory (or a symlink
 * to one) becomes an enterable directory row, a file (or a symlink to one)
 * becomes a file row, and broken/cyclic links or exotic targets return null
 * (skipped silently — the browser shows what exists, and a broken link is not
 * a row anyone can act on).
 */
async function entryRow(
  parent: string, name: string, isDirectory: boolean, isSymbolicLink: boolean, signal: AbortSignal | undefined,
): Promise<DirectoryEntry | null> {
  const path = join(parent, name)
  let kind: 'directory' | 'file' = isDirectory ? 'directory' : 'file'
  if (isSymbolicLink) {
    try {
      // The probe races the caller too: a symlink target on a stalled
      // network filesystem must not keep a departed caller's request alive.
      const target = await raceAbort(stat(path), signal)
      if (target.isDirectory()) kind = 'directory'
      else if (target.isFile()) kind = 'file'
      else return null
    } catch {
      /* v8 ignore next 2 -- an abort landing mid-probe needs a stalled stat; the per-candidate check in list covers the settled path. */
      if (signal?.aborted) throw asError(signal.reason)
      // Broken or cyclic symlink: stat is the probe, failure means "no row".
      return null
    }
  }
  // POSIX hidden convention; Windows' hidden attribute is not exposed by
  // dirents (Known Limitations). The client owns whether hidden rows show.
  return { name, path, hidden: name.startsWith('.'), kind }
}

/** Validated plugin configuration. */
export interface Config {
  /** Complete-result bound of one listing level; see {@link BrowseDirectoryPicker.Config}. */
  maxEntries: number
  /** Complete-read bound of one text file, in bytes. */
  maxTextBytes: number
  /** Fail-closed read bound of one image file, in bytes (never cut; past it the read refuses). */
  maxImageBytes: number
}

/** The `ctx.directoryPicker` browse implementation (stable capability object per service life). */
export default class BrowseDirectoryPicker extends DirectoryPicker {
  /**
   * `maxEntries` bounds the complete listing level a single `list` call may
   * materialize and put on the wire: at most this many child rows (files and
   * directories, hidden rows included), with `truncated` flagging a cut
   * level. The default follows GitHub's web UI, which truncates directory
   * listings at 1,000 entries. `maxImageBytes` defaults above the attachment
   * admission default (5 MiB) because the attachment limit is the
   * authoritative per-file bound; this transport cap only fails closed when
   * no attachment policy is composed.
   */
  static Config: z<Config> = z.object({
    maxEntries: z.natural().min(1).default(1000),
    maxTextBytes: z.natural().min(1).default(262144),
    maxImageBytes: z.natural().min(1).default(8 * 1024 * 1024),
  })

  private readonly browseCapability: DirectoryPickerCapability = {
    kind: 'browse',
    list: (path, signal) => this.list(path, signal),
    readText: (path, signal) => this.readText(path, signal),
    readImage: (path, signal) => this.readImage(path, signal),
    createDirectory: (path, name) => this.createDirectory(path, name),
  }

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
  }

  /**
   * The browse interaction capability.
   * @returns the stable `browse` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.browseCapability
  }

  private async list(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const home = homedir()
    // The seam contract takes fully qualified paths only; resolve() would
    // silently rebase a relative or empty wire value under the host process
    // cwd (or, for rooted drive-less Windows forms, its current drive).
    if (path !== undefined && !fullyQualified(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`)
    }
    const target = resolve(path ?? home)
    // Stream the level (opendir, one dirent at a time) into a directories-first
    // window of maxEntries + 1 candidates: memory stays bounded no matter how
    // many children the directory holds, the window keeps the directories-first
    // head, and the +1 slot lets an in-window extra row prove the cut. A
    // window candidate that turns out unrowable (broken symlink) is not
    // backfilled from beyond the window — an eviction already marks the
    // level truncated, which stays the honest answer.
    const keep = this.config.maxEntries + 1
    const window: ListingCandidate[] = []
    let evicted = false
    try {
      // Every filesystem await races the caller's signal: a stalled
      // opendir/read on a network filesystem must not keep a departed
      // caller's scan alive, and an already-aborted request rejects even
      // when the level is empty.
      const opening = opendir(target)
      const level = await raceAbort(opening, signal).catch((error: unknown) => {
        // The abandoned open can still mint a handle after the abort won;
        // close it so a departed caller cannot leak a descriptor. (A lost
        // race against opendir's own rejection has nothing to close, and
        // the close's own failure is swallowed — the request already
        // returned, so a cleanup error has no consumer.)
        void opening.then(dir => dir.close().catch(swallowCloseFailure), () => {
          // Already rejected: raceAbort surfaced or swallowed it.
        })
        throw error
      })
      try {
        for (;;) {
          const dirent = await raceAbort(level.read(), signal)
          if (dirent === null) break
          // Rows a browser could act on contend for the window; dirent says
          // "directory" or "file" outright, a symlink needs the stat probe.
          if (!dirent.isDirectory() && !dirent.isFile() && !dirent.isSymbolicLink()) continue
          // A symlink's sort group is its target's kind: probe it during the
          // stream (racing the caller like every other filesystem await), so
          // a symlinked directory sorts with the directories.
          let isDirectory = dirent.isDirectory()
          if (dirent.isSymbolicLink()) {
            try {
              const targetStat = await raceAbort(stat(join(target, dirent.name)), signal)
              isDirectory = targetStat.isDirectory()
            } catch {
              // Broken or cyclic symlink: keep the dirent kind for the sort;
              // entryRow drops the row later.
              if (signal?.aborted) throw asError(signal.reason)
            }
          }
          const candidate = { name: dirent.name, isDirectory, isSymbolicLink: dirent.isSymbolicLink() }
          if (boundedInsert(window, candidate, keep)) evicted = true
        }
      } finally {
        // Manual read() never auto-closes; close on every exit. The aborted
        // exit must not await it — Node queues close behind any in-flight
        // read, so awaiting would chain the departed caller back onto the
        // very stall the abort escaped (the abandoned read's settlement is
        // already swallowed by raceAbort).
        const closing = level.close()
        /* v8 ignore next 3 -- an abort between open and close needs a stalled read; the abandoned-close arm has no observable outcome. */
        if (signal?.aborted) {
          closing.catch(swallowCloseFailure)
        } else {
          await closing
        }
      }
    } catch (error: unknown) {
      // An abort is the caller's own reason, not an unreadable directory.
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
    }
    const entries: DirectoryEntry[] = []
    let truncated = evicted
    for (const candidate of window) {
      // A caller that departed between reads and probes stops before the
      // next probe (each probe's own await is raced inside entryRow).
      signal?.throwIfAborted()
      const row = await entryRow(target, candidate.name, candidate.isDirectory, candidate.isSymbolicLink, signal)
      if (row === null) continue
      if (entries.length === this.config.maxEntries) {
        truncated = true
        break
      }
      entries.push(row)
    }
    return { path: target, home, crumbs: ancestryCrumbs(target), entries, truncated }
  }

  private async readText(path: string, signal?: AbortSignal): Promise<DirectoryRead> {
    // Same fully-qualified fence as list: never resolve a wire value against
    // the host cwd or the current drive.
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError('file-unreadable', path, `cannot read "${path}": not a fully qualified path`)
    }
    const target = resolve(path)
    try {
      // The handle and every read race the caller, so a stalled network
      // filesystem cannot outlive a departed caller.
      const opening = open(target, 'r')
      const handle = await raceAbort(opening, signal).catch((error: unknown) => {
        /* v8 ignore next -- a lost race can still mint a handle; close it so a departed caller leaks no descriptor. */
        void opening.then(h => h.close().catch(swallowCloseFailure), () => {})
        throw error
      })
      try {
        // One bounded read: maxTextBytes + 1 proves the cut without holding
        // more than the bound plus one byte in memory.
        const buffer = Buffer.allocUnsafe(this.config.maxTextBytes + 1)
        const { bytesRead } = await raceAbort(handle.read(buffer, 0, buffer.length, 0), signal)
        const content = buffer.subarray(0, bytesRead)
        // A NUL byte marks binary content: decoding it would hand the browser
        // mojibake where a preview cannot exist.
        if (content.includes(0)) {
          throw new DirectoryPickerError('file-not-text', target, `${target} is not a text file`)
        }
        const truncated = bytesRead > this.config.maxTextBytes
        return {
          path: target,
          text: content.subarray(0, this.config.maxTextBytes).toString('utf8'),
          truncated,
        }
      } finally {
        const closing = handle.close()
        /* v8 ignore next 3 -- an abort between open and close needs a stalled read; the abandoned-close arm has no observable outcome. */
        if (signal?.aborted) {
          closing.catch(swallowCloseFailure)
        } else {
          await closing
        }
      }
    } catch (error: unknown) {
      // An abort is the caller's own reason, not an unreadable file; the
      // binary verdict is already dressed above.
      signal?.throwIfAborted()
      if (error instanceof DirectoryPickerError) throw error
      throw new DirectoryPickerError('file-unreadable', target, `cannot read ${target}: ${messageOf(error)}`)
    }
  }

  private async readImage(path: string, signal?: AbortSignal): Promise<DirectoryImageRead> {
    // Same fully-qualified fence as readText: never resolve a wire value
    // against the host cwd or the current drive.
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError('file-unreadable', path, `cannot read "${path}": not a fully qualified path`)
    }
    const target = resolve(path)
    try {
      // Same handle/read discipline as readText: every await races the
      // caller, and one bounded read of maxImageBytes + 1 proves an
      // oversized file without holding more than the bound plus one byte.
      const opening = open(target, 'r')
      const handle = await raceAbort(opening, signal).catch((error: unknown) => {
        /* v8 ignore next -- a lost race can still mint a handle; close it so a departed caller leaks no descriptor. */
        void opening.then(h => h.close().catch(swallowCloseFailure), () => {})
        throw error
      })
      try {
        const buffer = Buffer.allocUnsafe(this.config.maxImageBytes + 1)
        const { bytesRead } = await raceAbort(handle.read(buffer, 0, buffer.length, 0), signal)
        if (bytesRead > this.config.maxImageBytes) {
          throw new DirectoryPickerError('file-too-large', target, `${target} exceeds the image byte bound`)
        }
        return { path: target, data: new Uint8Array(buffer.subarray(0, bytesRead)) }
      } finally {
        const closing = handle.close()
        /* v8 ignore next 3 -- an abort between open and close needs a stalled read; the abandoned-close arm has no observable outcome. */
        if (signal?.aborted) {
          closing.catch(swallowCloseFailure)
        } else {
          await closing
        }
      }
    } catch (error: unknown) {
      // An abort is the caller's own reason, not an unreadable file; the
      // oversized verdict is already dressed above.
      signal?.throwIfAborted()
      if (error instanceof DirectoryPickerError) throw error
      throw new DirectoryPickerError('file-unreadable', target, `cannot read ${target}: ${messageOf(error)}`)
    }
  }

  private async createDirectory(path: string, name: string): Promise<string> {
    // Same fully-qualified fence as list: never rebase a parent under the
    // cwd or the current drive.
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": not a fully qualified parent path`)
    }
    const parent = resolve(path)
    // The backend owns segment validation (the wire schema also refuses these,
    // but direct service consumers must hit the same fence).
    if (name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
      throw new DirectoryPickerError('directory-create-failed', join(parent, name), `"${name}" is not a single path segment`)
    }
    const target = join(parent, name)
    try {
      // Non-recursive: the parent is the directory the browser is showing, so
      // a missing parent is a real failure, not a level to invent.
      await mkdir(target)
      return target
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
        throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
      }
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`)
    }
  }
}
