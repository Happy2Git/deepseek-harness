/** Behavior of the plugin-owned /git/* HTTP routes: registration, body validation, and failure mapping. */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GitError } from '@deepseek-ai/dsh-host-git'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import LocalGit from '../src/index.ts'

/** A minimal ServerResponse double capturing what writeJson emits, plus the close/writableEnded the abort signal reads. */
function makeResponse(): ServerResponse {
  const emitter = new EventEmitter()
  const res = emitter as unknown as {
    status: number
    headers: Record<string, string | string[] | undefined>
    body: string
    writableEnded: boolean
    writeHead: (status: number, headers: Record<string, string | string[] | undefined>) => unknown
    end: (chunk?: string) => unknown
  }
  res.status = 0
  res.headers = {}
  res.body = ''
  res.writableEnded = false
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
    return res
  }
  res.end = (chunk) => {
    res.body = chunk ?? ''
    res.writableEnded = true
    emitter.emit('close')
    return res
  }
  return res as unknown as ServerResponse
}

/** A request double streaming one JSON body (or nothing) as a single chunk. */
function makeRequest(body: string | Buffer | undefined, contentType = 'application/json'): IncomingMessage {
  const chunks = body === undefined ? [] : [body]
  const stream = Readable.from(chunks) as unknown as { headers: Record<string, string | string[] | undefined> }
  stream.headers = { 'content-type': contentType }
  return stream as unknown as IncomingMessage
}

/** The decoded body of a captured response, when one was written. */
function responseBody(res: ServerResponse): unknown {
  const captured = res as unknown as { body: string }
  return captured.body === '' ? undefined : JSON.parse(captured.body)
}

function responseStatus(res: ServerResponse): number {
  return (res as unknown as { status: number }).status
}

let ctx: Context
let routes: WebRoute[]
let local: LocalGit
let graphMock: ReturnType<typeof vi.fn>
let showCommitMock: ReturnType<typeof vi.fn>
let workspaceMock: ReturnType<typeof vi.fn>
let showDiffMock: ReturnType<typeof vi.fn>
let workspaceDiffMock: ReturnType<typeof vi.fn>
let statusMock: ReturnType<typeof vi.fn>
let fiber: { dispose: () => Promise<void> }

beforeEach(async () => {
  ctx = new Context()
  // The service methods are spied per test, so the subprocess seam is never
  // reached here; a stub that fails loud guards against an unmocked call.
  ctx.provide('subprocess', { spawn: () => { throw new Error('unexpected git spawn in route test') } })
  routes = []
  ctx.provide('webServer', {
    host: '127.0.0.1' as const,
    register: (route: WebRoute) => {
      routes.push(route)
      return () => {}
    },
  })
  const instance = ctx.plugin(LocalGit)
  await instance.await()
  fiber = instance
  local = ctx.get('git') as LocalGit
  graphMock = vi.spyOn(local, 'graph').mockResolvedValue({ entries: [], hasMore: false })
  showCommitMock = vi.spyOn(local, 'showCommit').mockResolvedValue({
    hash: '', message: '', author: '', date: '', files: [], truncated: false,
  })
  workspaceMock = vi.spyOn(local, 'workspaceStatus').mockResolvedValue({
    branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, files: [], truncated: false,
  })
  showDiffMock = vi.spyOn(local, 'showFileDiff').mockResolvedValue({
    path: 'README.md', diff: '', truncated: false,
  })
  workspaceDiffMock = vi.spyOn(local, 'showWorkspaceDiff').mockResolvedValue({
    path: 'README.md', diff: '', truncated: false,
  })
  statusMock = vi.spyOn(local, 'directoryStatus').mockResolvedValue([])
})

afterEach(async () => {
  await fiber.dispose()
})

/** Resolve one registered route by pathname. */
function routeAt(path: string): WebRoute {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`no registered route at ${path}`)
  return route
}

describe('route registration', () => {
  it('registers the five exact git routes', () => {
    expect(routes.map(route => route.path).sort()).toEqual(['/git/graph', '/git/show-commit', '/git/show-diff', '/git/status', '/git/workspace', '/git/workspace-diff'])
    for (const route of routes) expect(route.kind).toBe('exact')
  })
})

describe('loopback guard', () => {
  it('refuses to load when the webserver host is not loopback', async () => {
    const guarded = new Context()
    guarded.provide('subprocess', { spawn: () => { throw new Error('unexpected') } })
    guarded.provide('webServer', { host: '0.0.0.0' as const, register: () => () => {} })
    await expect(guarded.plugin(LocalGit)).rejects.toThrow(/loopback-only/)
  })
})

describe('/git/graph', () => {
  it('delegates the pagination body to graph', async () => {
    const res = makeResponse()
    await routeAt('/git/graph').handler(makeRequest(JSON.stringify({ cwd: '/repo', count: 10, skip: 2 })), res)
    expect(graphMock).toHaveBeenCalledWith('/repo', { count: 10, skip: 2 }, expect.any(AbortSignal))
    expect(responseStatus(res)).toBe(200)
  })

  it('delegates an empty options object when no pagination is sent', async () => {
    const res = makeResponse()
    await routeAt('/git/graph').handler(makeRequest(JSON.stringify({ cwd: '/repo' })), res)
    expect(graphMock).toHaveBeenCalledWith('/repo', {}, expect.any(AbortSignal))
    expect(responseStatus(res)).toBe(200)
  })

  it('answers 400 for a missing body', async () => {
    const res = makeResponse()
    await routeAt('/git/graph').handler(makeRequest(undefined), res)
    expect(responseStatus(res)).toBe(400)
    expect(responseBody(res)).toEqual({ error: { message: 'missing cwd' } })
    expect(graphMock).not.toHaveBeenCalled()
  })

  it('answers 400 for a malformed JSON body', async () => {
    const res = makeResponse()
    await routeAt('/git/graph').handler(makeRequest('{oops'), res)
    expect(responseStatus(res)).toBe(400)
    expect(responseBody(res)).toEqual({ error: { message: 'body is not JSON' } })
    expect(graphMock).not.toHaveBeenCalled()
  })

  it('answers 415 for a non-JSON content type', async () => {
    const res = makeResponse()
    await routeAt('/git/graph').handler(makeRequest(JSON.stringify({ cwd: '/repo' }), 'text/plain'), res)
    expect(responseStatus(res)).toBe(415)
    expect(graphMock).not.toHaveBeenCalled()
  })

  it('answers 413 for an oversized body', async () => {
    const res = makeResponse()
    await routeAt('/git/graph').handler(makeRequest(JSON.stringify({ cwd: `/${'a'.repeat(70 * 1024)}` })), res)
    expect(responseStatus(res)).toBe(413)
    expect(responseBody(res)).toEqual({ error: { message: 'request body too large' } })
    expect(graphMock).not.toHaveBeenCalled()
  })

  it('answers 400 for a relative cwd', async () => {
    const res = makeResponse()
    await routeAt('/git/graph').handler(makeRequest(JSON.stringify({ cwd: 'relative/repo' })), res)
    expect(responseStatus(res)).toBe(400)
    expect(responseBody(res)).toEqual({ error: { message: 'cwd must be an absolute path' } })
    expect(graphMock).not.toHaveBeenCalled()
  })

  it('answers 400 for a non-positive-integer count', async () => {
    for (const count of [0, -1, 1.5, '5']) {
      const res = makeResponse()
      await routeAt('/git/graph').handler(makeRequest(JSON.stringify({ cwd: '/repo', count })), res)
      expect(responseStatus(res)).toBe(400)
      expect(responseBody(res)).toEqual({ error: { message: 'count must be a positive integer' } })
    }
    expect(graphMock).not.toHaveBeenCalled()
  })

  it('answers 400 for a negative or fractional skip', async () => {
    for (const skip of [-1, 1.5, '0']) {
      const res = makeResponse()
      await routeAt('/git/graph').handler(makeRequest(JSON.stringify({ cwd: '/repo', skip })), res)
      expect(responseStatus(res)).toBe(400)
      expect(responseBody(res)).toEqual({ error: { message: 'skip must be a non-negative integer' } })
    }
    expect(graphMock).not.toHaveBeenCalled()
  })

  it('answers 400 with the git failure message on a GitError', async () => {
    graphMock.mockRejectedValueOnce(new GitError('not-a-repository', 'not a git repo'))
    const res = makeResponse()
    await routeAt('/git/graph').handler(makeRequest(JSON.stringify({ cwd: '/repo' })), res)
    expect(responseStatus(res)).toBe(400)
    expect(responseBody(res)).toEqual({ error: { message: 'not a git repo' } })
  })

  it('answers 500 for a non-git failure', async () => {
    graphMock.mockRejectedValueOnce('plain failure')
    const res = makeResponse()
    await routeAt('/git/graph').handler(makeRequest(JSON.stringify({ cwd: '/repo' })), res)
    expect(responseStatus(res)).toBe(500)
    expect(responseBody(res)).toEqual({ error: { message: 'plain failure' } })
  })
})

describe('/git/show-commit', () => {
  it('delegates cwd and hash to showCommit', async () => {
    const res = makeResponse()
    await routeAt('/git/show-commit').handler(makeRequest(JSON.stringify({ cwd: '/repo', hash: 'abc123' })), res)
    expect(showCommitMock).toHaveBeenCalledWith('/repo', 'abc123', expect.any(AbortSignal))
    expect(responseStatus(res)).toBe(200)
  })

  it('answers 400 for a missing hash', async () => {
    const res = makeResponse()
    await routeAt('/git/show-commit').handler(makeRequest(JSON.stringify({ cwd: '/repo' })), res)
    expect(responseStatus(res)).toBe(400)
    expect(responseBody(res)).toEqual({ error: { message: 'missing hash' } })
    expect(showCommitMock).not.toHaveBeenCalled()
  })

  it('answers 400 for a relative cwd', async () => {
    const res = makeResponse()
    await routeAt('/git/show-commit').handler(makeRequest(JSON.stringify({ cwd: 'repo', hash: 'abc' })), res)
    expect(responseStatus(res)).toBe(400)
    expect(responseBody(res)).toEqual({ error: { message: 'cwd must be an absolute path' } })
    expect(showCommitMock).not.toHaveBeenCalled()
  })
})

describe('/git/workspace', () => {
  it('delegates the cwd to workspaceStatus', async () => {
    const res = makeResponse()
    await routeAt('/git/workspace').handler(makeRequest(JSON.stringify({ cwd: '/repo' })), res)
    expect(workspaceMock).toHaveBeenCalledWith('/repo', expect.any(AbortSignal))
    expect(responseStatus(res)).toBe(200)
    expect(responseBody(res)).toMatchObject({ branch: 'main' })
  })

  it('answers 400 for a relative cwd', async () => {
    const res = makeResponse()
    await routeAt('/git/workspace').handler(makeRequest(JSON.stringify({ cwd: 'repo' })), res)
    expect(responseStatus(res)).toBe(400)
    expect(workspaceMock).not.toHaveBeenCalled()
  })

  it('answers 400 for a missing body', async () => {
    const res = makeResponse()
    await routeAt('/git/workspace').handler(makeRequest(undefined), res)
    expect(responseStatus(res)).toBe(400)
    expect(workspaceMock).not.toHaveBeenCalled()
  })
})

describe('/git/show-diff', () => {
  it('delegates cwd, hash, and path to showFileDiff', async () => {
    const res = makeResponse()
    await routeAt('/git/show-diff').handler(makeRequest(JSON.stringify({ cwd: '/repo', hash: 'abc', path: 'README.md' })), res)
    expect(showDiffMock).toHaveBeenCalledWith('/repo', 'abc', 'README.md', expect.any(AbortSignal))
    expect(responseStatus(res)).toBe(200)
  })

  it('answers 400 for a missing path', async () => {
    const res = makeResponse()
    await routeAt('/git/show-diff').handler(makeRequest(JSON.stringify({ cwd: '/repo', hash: 'abc' })), res)
    expect(responseStatus(res)).toBe(400)
    expect(responseBody(res)).toEqual({ error: { message: 'missing path' } })
    expect(showDiffMock).not.toHaveBeenCalled()
  })

  it('answers 400 for a relative cwd', async () => {
    const res = makeResponse()
    await routeAt('/git/show-diff').handler(makeRequest(JSON.stringify({ cwd: 'repo', hash: 'abc', path: 'x' })), res)
    expect(responseStatus(res)).toBe(400)
    expect(showDiffMock).not.toHaveBeenCalled()
  })
})

describe('/git/workspace-diff', () => {
  it('delegates cwd and path to showWorkspaceDiff', async () => {
    const res = makeResponse()
    await routeAt('/git/workspace-diff').handler(makeRequest(JSON.stringify({ cwd: '/repo', path: 'README.md' })), res)
    expect(workspaceDiffMock).toHaveBeenCalledWith('/repo', 'README.md', expect.any(AbortSignal))
    expect(responseStatus(res)).toBe(200)
  })

  it('answers 400 for a missing path', async () => {
    const res = makeResponse()
    await routeAt('/git/workspace-diff').handler(makeRequest(JSON.stringify({ cwd: '/repo' })), res)
    expect(responseStatus(res)).toBe(400)
    expect(responseBody(res)).toEqual({ error: { message: 'missing path' } })
    expect(workspaceDiffMock).not.toHaveBeenCalled()
  })

  it('answers 400 for a relative cwd', async () => {
    const res = makeResponse()
    await routeAt('/git/workspace-diff').handler(makeRequest(JSON.stringify({ cwd: 'repo', path: 'x' })), res)
    expect(responseStatus(res)).toBe(400)
    expect(workspaceDiffMock).not.toHaveBeenCalled()
  })
})

describe('/git/status', () => {
  it('delegates the directory to directoryStatus', async () => {
    const res = makeResponse()
    await routeAt('/git/status').handler(makeRequest(JSON.stringify({ dir: '/repo/sub' })), res)
    expect(statusMock).toHaveBeenCalledWith('/repo/sub', expect.any(AbortSignal))
    expect(responseStatus(res)).toBe(200)
    expect(responseBody(res)).toEqual({ files: [] })
  })

  it('answers 400 for a relative dir', async () => {
    const res = makeResponse()
    await routeAt('/git/status').handler(makeRequest(JSON.stringify({ dir: 'repo' })), res)
    expect(responseStatus(res)).toBe(400)
    expect(statusMock).not.toHaveBeenCalled()
  })
})
