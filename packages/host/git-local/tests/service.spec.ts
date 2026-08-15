/** Behavior of the local git backend over a real temporary repository. */

import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GitError } from '@deepseek-ai/dsh-host-git'
import LocalGit from '../src/index.ts'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

/** Run a git command in `cwd` for test setup. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

let repo: string
let outside: string
let ctx: Context
let local: LocalGit
let dispose: () => Promise<void>

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-git-'))
  repo = join(root, 'repo')
  outside = join(root, 'outside')
  await mkdir(repo)
  await mkdir(outside)
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  // Two commits: a root commit (one file added) and a second modifying it.
  await writeFile(join(repo, 'README.md'), 'first\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-m', 'first commit'])
  await writeFile(join(repo, 'README.md'), 'changed\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-m', 'second commit'])

  ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  // The backend now owns its HTTP routes; a stub registry satisfies the
  // webServer inject (the route handlers are not exercised by these tests).
  ctx.provide('webServer', { host: '127.0.0.1', register: () => () => {} } as never)
  const fiber = ctx.plugin(LocalGit)
  await fiber.await()
  local = ctx.get('git') as LocalGit
  dispose = () => fiber.dispose()
})

afterAll(async () => {
  await dispose()
  await rm(join(repo, '..'), { recursive: true, force: true })
})

describe('LocalGit.graph', () => {
  it('returns the topo-ordered commit page with parents and refs', async () => {
    const page = await local.graph(repo, {})
    expect(page.hasMore).toBe(false)
    expect(page.entries).toHaveLength(2)
    // Newest first under topo/date order.
    expect(page.entries[0]!.message).toBe('second commit')
    expect(page.entries[0]!.parents).toHaveLength(1)
    expect(page.entries[0]!.refs).toContain('HEAD -> main')
    expect(page.entries[1]!.message).toBe('first commit')
    expect(page.entries[1]!.parents).toHaveLength(0)
  })

  it('pages with skip/count and reports hasMore', async () => {
    const first = await local.graph(repo, { count: 1 })
    expect(first.entries).toHaveLength(1)
    expect(first.hasMore).toBe(true)
    const second = await local.graph(repo, { count: 1, skip: 1 })
    expect(second.entries).toHaveLength(1)
    expect(second.hasMore).toBe(false)
    expect(second.entries[0]!.message).toBe('first commit')
  })

  it('reports not-a-repository for a non-repo directory', async () => {
    await expect(local.graph(outside, {})).rejects.toMatchObject({ code: 'not-a-repository' })
  })
})

describe('LocalGit.showCommit', () => {
  it('returns the changed files with statuses and counts', async () => {
    const page = await local.graph(repo, {})
    const head = page.entries[0]!
    const detail = await local.showCommit(repo, head.hash)
    expect(detail.hash).toBe(head.hash)
    expect(detail.message).toContain('second commit')
    expect(detail.files).toEqual([
      { path: 'README.md', status: 'modified', additions: 1, deletions: 1 },
    ])
  })

  it('reports the root commit files as added', async () => {
    const page = await local.graph(repo, { count: 2 })
    const root = page.entries[1]!
    const detail = await local.showCommit(repo, root.hash)
    expect(detail.files[0]).toMatchObject({ path: 'README.md', status: 'added' })
  })

  it('reports commit-unreadable for an unknown hash', async () => {
    await expect(local.showCommit(repo, '0'.repeat(40))).rejects.toMatchObject({ code: 'commit-unreadable' })
  })
})

describe('GitError classification', () => {
  it('exposes the closed codes on thrown failures', () => {
    const notRepo = new GitError('not-a-repository', 'x')
    expect(notRepo.code).toBe('not-a-repository')
    expect(notRepo.name).toBe('GitError')
  })
})

describe('output bounding', () => {
  it('fails closed when collected git output exceeds the byte cap', async () => {
    const lossyCtx = new Context()
    await lossyCtx.plugin(LocalSubprocessRuntime)
    lossyCtx.provide('webServer', { host: '127.0.0.1', register: () => () => {} } as never)
    const lossyFiber = lossyCtx.plugin(LocalGit, { maxOutputBytes: 64, graceMs: 1000, maxCommits: 100, maxFiles: 500 })
    await lossyFiber.await()
    const lossy = lossyCtx.get('git') as LocalGit
    const failure = await lossy.graph(repo, {}).then(
      () => { throw new Error('graph unexpectedly resolved') },
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ code: 'git-unavailable' })
    expect(failure instanceof GitError ? failure.message : '').toContain('exceeded')
    await lossyFiber.dispose()
  })
})
