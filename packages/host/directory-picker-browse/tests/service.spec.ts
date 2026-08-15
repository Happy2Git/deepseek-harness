/** Behavior of the browse backend over a real temporary directory tree. */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerBrowseCapability } from '@deepseek-ai/dsh-host-directory-picker'
import BrowseDirectoryPicker, { boundedInsert, fullyQualified, raceAbort } from '../src/index.ts'
import type { ListingCandidate } from '../src/index.ts'

let root: string
let capability: DirectoryPickerBrowseCapability
let dispose: () => Promise<void>

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-browse-'))
  await mkdir(join(root, 'projects'))
  await mkdir(join(root, 'projects', 'harness'))
  await mkdir(join(root, '.hidden-dir'))
  await writeFile(join(root, 'notes.txt'), 'not a directory')
  await symlink(join(root, 'projects'), join(root, 'linked'), 'junction')
  await symlink(join(root, 'gone'), join(root, 'broken'), 'junction')
  try {
    await symlink(join(root, 'notes.txt'), join(root, 'file-link'))
  } catch {
    // Windows denies unprivileged file symlinks; the file-link row only
    // feeds the POSIX lanes' coverage of the symlink-to-file arm (a file
    // row), and the assertions below branch on its presence.
  }

  const ctx = new Context()
  const fiber = ctx.plugin(BrowseDirectoryPicker)
  await fiber.await()
  const picked = ctx.get('directoryPicker')!.capability()
  if (picked.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
  capability = picked
  dispose = () => fiber.dispose()
})

afterAll(async () => {
  await dispose()
  await rm(root, { recursive: true, force: true })
})

describe('BrowseDirectoryPicker', () => {
  it('lists directories and files, flags hidden rows, follows symlinks, skips broken links, sorts directories first', async () => {
    const listing = await capability.list(root)
    expect(listing.path).toBe(root)
    expect(listing.home).toBe(homedir())
    const byName = (name: string) => listing.entries.find(entry => entry.name === name)
    const names = listing.entries.map(entry => entry.name)
    // file-link (a symlink to notes.txt) only exists where the OS permits
    // file symlinks; where it does, it joins the level as a file row.
    // Directories (including the symlinked 'linked') come first, then files.
    if (names.includes('file-link')) {
      expect(names).toEqual(['.hidden-dir', 'linked', 'projects', 'file-link', 'notes.txt'])
      expect(byName('file-link')).toMatchObject({ hidden: false, kind: 'file' })
    } else {
      expect(names).toEqual(['.hidden-dir', 'linked', 'projects', 'notes.txt'])
    }
    expect(byName('.hidden-dir')).toMatchObject({ hidden: true, kind: 'directory' })
    expect(byName('linked')).toMatchObject({ hidden: false, kind: 'directory' })
    expect(byName('notes.txt')).toMatchObject({ hidden: false, kind: 'file' })
    expect(byName('projects')).toMatchObject({ hidden: false, kind: 'directory' })
    // Every entry path is absolute and host-joined — clients never join segments.
    expect(listing.entries.every(entry => entry.path === join(root, entry.name))).toBe(true)
    // Well under the default bound: the complete level, not a cut one.
    expect(listing.truncated).toBe(false)
  })

  it('cuts a level at maxEntries keeping the name-sorted head, and flags the cut', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(BrowseDirectoryPicker, { maxEntries: 1, maxTextBytes: 262144 })
    await fiber.await()
    const bounded = ctx.get('directoryPicker')!.capability()
    if (bounded.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
    try {
      const cut = await bounded.list(root)
      expect(cut.entries.map(entry => entry.name)).toEqual(['.hidden-dir'])
      expect(cut.truncated).toBe(true)
      // Exactly at the bound is complete, not truncated.
      const exact = await bounded.list(join(root, 'projects'))
      expect(exact.entries.map(entry => entry.name)).toEqual(['harness'])
      expect(exact.truncated).toBe(false)
      // A level that fits the window but exceeds the bound (two rows, bound
      // one): the in-window extra row proves the cut without any eviction.
      await mkdir(join(root, 'projects', 'harness', 'a'))
      await mkdir(join(root, 'projects', 'harness', 'b'))
      const inWindow = await bounded.list(join(root, 'projects', 'harness'))
      expect(inWindow.entries.map(entry => entry.name)).toEqual(['a'])
      expect(inWindow.truncated).toBe(true)
    } finally {
      await fiber.dispose()
    }
  })

  it('reads bounded text, flags the cut, rejects binary and unqualified paths, honors aborts', async () => {
    const notes = join(root, 'notes.txt')
    expect(await capability.readText(notes)).toEqual({ path: notes, text: 'not a directory', truncated: false })

    // A tighter bound cuts the tail and reports it.
    const ctx = new Context()
    const fiber = ctx.plugin(BrowseDirectoryPicker, { maxTextBytes: 5, maxEntries: 1000 })
    await fiber.await()
    const bounded = ctx.get('directoryPicker')!.capability()
    if (bounded.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
    try {
      expect(await bounded.readText(notes)).toEqual({ path: notes, text: 'not a', truncated: true })
    } finally {
      await fiber.dispose()
    }

    // NUL bytes mark binary content: no text preview exists for it.
    const binary = join(root, 'blob.bin')
    await writeFile(binary, Buffer.from([0x00, 0x01, 0x02]))
    await expect(capability.readText(binary)).rejects.toMatchObject({ code: 'file-not-text' })

    // Same fully-qualified fence as list: relative values never resolve.
    await expect(capability.readText('relative/path.md')).rejects.toThrow('not a fully qualified path')

    // The caller's abort surfaces as its own reason, not as an unreadable file.
    const gone = new AbortController()
    gone.abort(new Error('caller left'))
    await expect(capability.readText(notes, gone.signal)).rejects.toThrow('caller left')
  })

  it('stops the scan with the caller: an aborted signal rejects with its own reason', async () => {
    const gone = new AbortController()
    gone.abort(new Error('caller left'))
    // The abort surfaces as-is, not dressed as an unreadable directory —
    // and rejects even before any level row is read.
    await expect(capability.list(root, gone.signal)).rejects.toThrow('caller left')
    // The abandoned open that still succeeds is closed, not leaked.
    await new Promise(resolve => setTimeout(resolve, 10))
    // Aborted against a missing target: the abandoned open rejects on its
    // own and there is nothing to close.
    await expect(capability.list(join(root, 'no-such-dir'), gone.signal)).rejects.toThrow('caller left')
    await new Promise(resolve => setTimeout(resolve, 10))
    // A live signal leaves a normal listing untouched — the reads and the
    // symlink probes race it without ever losing.
    const live = new AbortController()
    const complete = await capability.list(root, live.signal)
    expect(complete.truncated).toBe(false)
    expect(complete.entries.map(entry => entry.name)).toContain('linked')
    // A live signal changes nothing about ordinary failures.
    const missing = join(root, 'no-such-dir')
    const failure = await capability.list(missing, live.signal).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
  })

  it('raceAbort follows the operation until the signal wins, and swallows the abandoned settlement', async () => {
    // No signal / settled operations: plain passthrough, listener removed.
    await expect(raceAbort(Promise.resolve('ok'), undefined)).resolves.toBe('ok')
    const live = new AbortController()
    await expect(raceAbort(Promise.resolve('ok'), live.signal)).resolves.toBe('ok')
    // Failure passthrough keeps the operation's own error.
    await expect(raceAbort(Promise.reject(new Error('raw failure')), live.signal)).rejects.toThrow('raw failure')
    // The abort wins over a pending operation and carries its own reason;
    // the operation's late rejection is swallowed, never unhandled.
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      let rejectLate!: (reason: unknown) => void
      const pending = new Promise<never>((_resolve, reject) => { rejectLate = reject })
      const controller = new AbortController()
      const raced = raceAbort(pending, controller.signal)
      // A bare-string abort reason exercises the Error wrap.
      controller.abort('caller left')
      await expect(raced).rejects.toThrow('caller left')
      rejectLate(new Error('late read failure'))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('boundedInsert keeps the window directories-first and bounded, reporting evictions', () => {
    const dir = (name: string): ListingCandidate => ({ name, isDirectory: true, isSymbolicLink: false })
    const file = (name: string): ListingCandidate => ({ name, isDirectory: false, isSymbolicLink: false })
    const window: ListingCandidate[] = []
    expect(boundedInsert(window, dir('m'), 2)).toBe(false)
    expect(boundedInsert(window, dir('z'), 2)).toBe(false)
    // A smaller name lands in place and pushes the current largest out.
    expect(boundedInsert(window, dir('a'), 2)).toBe(true)
    expect(window.map(entry => entry.name)).toEqual(['a', 'm'])
    // A name at or beyond the full window's tail rejects on one comparison.
    expect(boundedInsert(window, dir('t'), 2)).toBe(true)
    expect(window.map(entry => entry.name)).toEqual(['a', 'm'])
    expect(boundedInsert(window, dir('m'), 2)).toBe(true)
    expect(window.map(entry => entry.name)).toEqual(['a', 'm'])
    // Directories sort before files regardless of name; each group stays
    // name-ascending, and the oversized file candidate is evicted.
    const mixed: ListingCandidate[] = []
    expect(boundedInsert(mixed, file('a.txt'), 3)).toBe(false)
    expect(boundedInsert(mixed, dir('z-dir'), 3)).toBe(false)
    expect(boundedInsert(mixed, dir('a-dir'), 3)).toBe(false)
    expect(mixed.map(entry => entry.name)).toEqual(['a-dir', 'z-dir', 'a.txt'])
    expect(boundedInsert(mixed, file('b.txt'), 3)).toBe(true)
    expect(mixed.map(entry => entry.name)).toEqual(['a-dir', 'z-dir', 'a.txt'])
  })

  it('reports the ancestry as jump-target crumbs ending at the listed directory', async () => {
    const listing = await capability.list(join(root, 'projects'))
    const tail = listing.crumbs.at(-1)!
    expect(tail).toMatchObject({ name: 'projects', path: join(root, 'projects'), hidden: false })
    expect(listing.crumbs.at(-2)!.path).toBe(root)
    expect(listing.crumbs.at(-2)!.name).toBe(basename(root))
    // The chain starts at the filesystem root, whose crumb is labeled by its full path.
    expect(listing.crumbs[0]!.name).toBe(listing.crumbs[0]!.path)
  })

  it('lists the home directory when no path is given', async () => {
    const listing = await capability.list()
    expect(listing.path).toBe(homedir())
  })

  it('throws directory-unreadable for a missing target', async () => {
    const missing = join(root, 'no-such-dir')
    const failure = await capability.list(missing).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
    expect((failure as DirectoryPickerError).path).toBe(missing)
  })

  it('classifies fully qualified paths per platform (drive-less rooted Windows forms rejected)', () => {
    expect(fullyQualified('/home/x', 'linux')).toBe(true)
    expect(fullyQualified('x/y', 'darwin')).toBe(false)
    expect(fullyQualified('C:\\projects', 'win32')).toBe(true)
    expect(fullyQualified('C:/projects', 'win32')).toBe(true)
    expect(fullyQualified('\\\\server\\share', 'win32')).toBe(true)
    expect(fullyQualified('//server/share/deep', 'win32')).toBe(true)
    // Rooted but drive-less: isAbsolute accepts these, yet resolve() would
    // inject the process's current drive.
    expect(fullyQualified('\\foo', 'win32')).toBe(false)
    expect(fullyQualified('/foo', 'win32')).toBe(false)
    expect(fullyQualified('C:relative', 'win32')).toBe(false)
    // Incomplete UNC prefixes collapse to drive-relative roots under resolve().
    expect(fullyQualified('\\\\', 'win32')).toBe(false)
    expect(fullyQualified('\\\\server', 'win32')).toBe(false)
    expect(fullyQualified('\\\\server\\', 'win32')).toBe(false)
  })

  it('rejects non-absolute paths instead of rebasing them under the process cwd', async () => {
    for (const relative of ['', 'projects', './projects', '..']) {
      const listFailure = await capability.list(relative).catch((error: unknown) => error)
      expect(listFailure).toBeInstanceOf(DirectoryPickerError)
      expect((listFailure as DirectoryPickerError).code).toBe('directory-unreadable')
      expect((listFailure as DirectoryPickerError).path).toBe(relative)
      const createFailure = await capability.createDirectory(relative, 'child').catch((error: unknown) => error)
      expect(createFailure).toBeInstanceOf(DirectoryPickerError)
      expect((createFailure as DirectoryPickerError).code).toBe('directory-create-failed')
      expect((createFailure as DirectoryPickerError).path).toBe(relative)
    }
  })

  it('creates one child directory and surfaces it in the next listing', async () => {
    const created = await capability.createDirectory(root, 'fresh')
    expect(created).toBe(join(root, 'fresh'))
    const listing = await capability.list(root)
    expect(listing.entries.map(entry => entry.name)).toContain('fresh')
  })

  it('refuses an existing child with directory-exists', async () => {
    const failure = await capability.createDirectory(root, 'projects').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-exists')
  })

  it('refuses non-segment names and other filesystem failures with directory-create-failed', async () => {
    for (const name of ['', '  ', '.', '..', 'a/b', 'a\\b']) {
      const failure = await capability.createDirectory(root, name).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-create-failed')
    }
    // Missing parent is a real failure, not a level to invent.
    const missingParent = await capability.createDirectory(join(root, 'no-such-dir'), 'child').catch((error: unknown) => error)
    expect((missingParent as DirectoryPickerError).code).toBe('directory-create-failed')
  })
})
