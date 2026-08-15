/** Behavior of the native path opener: platform dispatch and shell-free quoting, driven by injected internals. */

import { afterEach, describe, expect, it, vi } from 'vitest'

const { runMock } = vi.hoisted(() => ({
  runMock: vi.fn<
    (command: string, args: readonly string[], signal: AbortSignal) => Promise<{ stdout: string; stderr: string }>
  >(async () => ({ stdout: '', stderr: '' })),
}))

import { openPathNative } from '../src/index.ts'

afterEach(() => {
  runMock.mockClear()
})

describe('openPathNative', () => {
  it('opens with open(1) on macOS', async () => {
    await openPathNative('/tmp/a.txt', new AbortController().signal, { platform: 'darwin', run: runMock })
    expect(runMock).toHaveBeenCalledWith('open', ['/tmp/a.txt'], expect.any(AbortSignal))
  })

  it('opens with Invoke-Item on Windows, escaping single quotes', async () => {
    await openPathNative("C:\\o'reilly.txt", new AbortController().signal, { platform: 'win32', run: runMock })
    expect(runMock).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-Command', "Invoke-Item -LiteralPath 'C:\\o''reilly.txt'"],
      expect.any(AbortSignal),
    )
  })

  it('opens with xdg-open on Linux', async () => {
    await openPathNative('/tmp/a.txt', new AbortController().signal, { platform: 'linux', run: runMock })
    expect(runMock).toHaveBeenCalledWith('xdg-open', ['/tmp/a.txt'], expect.any(AbortSignal))
  })

  it('falls through to xdg-open on unknown platforms', async () => {
    await openPathNative('/tmp/a.txt', new AbortController().signal, { platform: 'aix', run: runMock })
    expect(runMock).toHaveBeenCalledWith('xdg-open', ['/tmp/a.txt'], expect.any(AbortSignal))
  })

  it('passes the caller signal through to the command', async () => {
    const controller = new AbortController()
    await openPathNative('/tmp/a.txt', controller.signal, { platform: 'darwin', run: runMock })
    expect(runMock.mock.calls[0]![2]).toBe(controller.signal)
  })
})
