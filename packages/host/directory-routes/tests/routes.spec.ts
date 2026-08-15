/** Behavior of the directory-routes backend: route registration and delegation to the browse capability. */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { DirectoryListing, DirectoryPickerBrowseCapability, DirectoryRead } from '@deepseek-ai/dsh-host-directory-picker'

const { runNativeCommandMock } = vi.hoisted(() => ({ runNativeCommandMock: vi.fn(async () => undefined) }))
vi.mock('@deepseek-ai/dsh-native-command', () => ({ runNativeCommand: runNativeCommandMock }))

import DirectoryRoutes from '../src/index.ts'

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
let capability: DirectoryPickerBrowseCapability
let currentCapability: { kind: string }
let listMock: Mock<(path?: string, signal?: AbortSignal) => Promise<DirectoryListing>>
let readTextMock: Mock<(path: string, signal?: AbortSignal) => Promise<DirectoryRead>>
let fiber: { dispose: () => Promise<void> }

beforeAll(async () => {
  ctx = new Context()
  listMock = vi.fn<(path?: string, signal?: AbortSignal) => Promise<DirectoryListing>>(async path => ({
    path: path ?? '/home/u', home: '/home/u', crumbs: [], entries: [], truncated: false,
  }))
  readTextMock = vi.fn<(path: string, signal?: AbortSignal) => Promise<DirectoryRead>>(async path => ({ path, text: 'hello', truncated: false }))
  capability = {
    kind: 'browse',
    list: listMock,
    readText: readTextMock,
    createDirectory: vi.fn(async () => '/x'),
  }
  currentCapability = capability
  routes = []
  ctx.provide('directoryPicker', { capability: () => currentCapability })
  ctx.provide('webServer', {
    host: '127.0.0.1' as const,
    register: (route: WebRoute) => {
      routes.push(route)
      return () => {}
    },
  })
  const instance = ctx.plugin(DirectoryRoutes)
  await instance.await()
  fiber = instance
})

afterEach(() => {
  // A test may switch the composed capability to a non-browse backend; restore
  // the browse capability before the next test.
  currentCapability = capability
  runNativeCommandMock.mockClear()
  listMock.mockClear()
  readTextMock.mockClear()
})

afterAll(async () => {
  await fiber.dispose()
})

/** Resolve one registered route by pathname. */
function routeAt(path: string): WebRoute {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`no registered route at ${path}`)
  return route
}

describe('route registration', () => {
  it('registers the three exact directory routes', () => {
    expect(routes.map(route => route.path).sort()).toEqual(['/dir/list', '/dir/open-path', '/dir/read-text'])
    for (const route of routes) expect(route.kind).toBe('exact')
  })
})

describe('/dir/list', () => {
  it('lists the requested directory through the browse capability', async () => {
    const res = makeResponse()
    await routeAt('/dir/list').handler(makeRequest(JSON.stringify({ path: '/tmp/x' })), res)
    expect(listMock).toHaveBeenCalledWith('/tmp/x', expect.any(AbortSignal))
    expect(responseStatus(res)).toBe(200)
    expect(responseBody(res)).toMatchObject({ path: '/tmp/x' })
  })

  it('lists the home directory when no path is sent', async () => {
    const res = makeResponse()
    await routeAt('/dir/list').handler(makeRequest(undefined), res)
    expect(listMock).toHaveBeenCalledWith(undefined, expect.any(AbortSignal))
    expect(responseStatus(res)).toBe(200)
    expect(responseBody(res)).toMatchObject({ path: '/home/u' })
  })

  it('answers 400 when the composed capability is not browse', async () => {
    currentCapability = { kind: 'native' }
    const res = makeResponse()
    await routeAt('/dir/list').handler(makeRequest(JSON.stringify({ path: '/tmp/x' })), res)
    expect(responseStatus(res)).toBe(400)
    expect(responseBody(res)).toMatchObject({ error: { message: 'directory browsing is not composed (serves "native")' } })
  })

  it('answers 400 with the failure message when listing throws', async () => {
    listMock.mockRejectedValueOnce(new Error('boom'))
    const res = makeResponse()
    await routeAt('/dir/list').handler(makeRequest(JSON.stringify({ path: '/tmp/x' })), res)
    expect(responseStatus(res)).toBe(400)
    expect(responseBody(res)).toEqual({ error: { message: 'boom' } })
  })

  it('stringifies a non-Error failure into the error message', async () => {
    listMock.mockRejectedValueOnce('plain failure')
    const res = makeResponse()
    await routeAt('/dir/list').handler(makeRequest(JSON.stringify({ path: '/tmp/x' })), res)
    expect(responseStatus(res)).toBe(400)
    expect(responseBody(res)).toEqual({ error: { message: 'plain failure' } })
  })
})

describe('/dir/read-text', () => {
  it('reads the requested file through the browse capability', async () => {
    const res = makeResponse()
    await routeAt('/dir/read-text').handler(makeRequest(JSON.stringify({ path: '/tmp/a.txt' })), res)
    expect(readTextMock).toHaveBeenCalledWith('/tmp/a.txt', expect.any(AbortSignal))
    expect(responseStatus(res)).toBe(200)
    expect(responseBody(res)).toMatchObject({ text: 'hello' })
  })

  it('reads a Buffer body', async () => {
    const res = makeResponse()
    await routeAt('/dir/read-text').handler(makeRequest(Buffer.from(JSON.stringify({ path: '/tmp/b.txt' }))), res)
    expect(readTextMock).toHaveBeenCalledWith('/tmp/b.txt', expect.any(AbortSignal))
    expect(responseStatus(res)).toBe(200)
  })

  it('answers 400 for a missing path', async () => {
    const res = makeResponse()
    await routeAt('/dir/read-text').handler(makeRequest(JSON.stringify({})), res)
    expect(responseStatus(res)).toBe(400)
    expect(responseBody(res)).toEqual({ error: { message: 'missing path' } })
    expect(readTextMock).not.toHaveBeenCalled()
  })

  it('answers 400 for an empty body', async () => {
    const res = makeResponse()
    await routeAt('/dir/read-text').handler(makeRequest(undefined), res)
    expect(responseStatus(res)).toBe(400)
    expect(readTextMock).not.toHaveBeenCalled()
  })

  it('answers 400 for a malformed JSON body', async () => {
    const res = makeResponse()
    await routeAt('/dir/read-text').handler(makeRequest('{oops'), res)
    expect(responseStatus(res)).toBe(400)
    expect(responseBody(res)).toEqual({ error: { message: 'body is not JSON' } })
  })

  it('answers 415 for a non-JSON content type', async () => {
    const res = makeResponse()
    await routeAt('/dir/read-text').handler(makeRequest(JSON.stringify({ path: '/tmp/a.txt' }), 'text/plain'), res)
    expect(responseStatus(res)).toBe(415)
    expect(readTextMock).not.toHaveBeenCalled()
  })

  it('answers 413 for an oversized body', async () => {
    const res = makeResponse()
    await routeAt('/dir/read-text').handler(makeRequest(JSON.stringify({ path: `/tmp/${'a'.repeat(70 * 1024)}` })), res)
    expect(responseStatus(res)).toBe(413)
    expect(readTextMock).not.toHaveBeenCalled()
  })

  it('answers 400 for a relative path', async () => {
    const res = makeResponse()
    await routeAt('/dir/read-text').handler(makeRequest(JSON.stringify({ path: 'relative/path.txt' })), res)
    expect(responseStatus(res)).toBe(400)
    expect(responseBody(res)).toEqual({ error: { message: 'path must be absolute' } })
    expect(readTextMock).not.toHaveBeenCalled()
  })
})

describe('/dir/open-path', () => {
  it('hands the path to the ambient platform opener', async () => {
    const res = makeResponse()
    await routeAt('/dir/open-path').handler(makeRequest(JSON.stringify({ path: '/tmp/a.txt' })), res)
    expect(runNativeCommandMock).toHaveBeenCalledWith(expect.any(String), ['/tmp/a.txt'], expect.any(AbortSignal))
    expect(responseStatus(res)).toBe(200)
    expect(responseBody(res)).toEqual({ opened: true })
  })

  it('answers 400 for a missing path', async () => {
    const res = makeResponse()
    await routeAt('/dir/open-path').handler(makeRequest(JSON.stringify({})), res)
    expect(responseStatus(res)).toBe(400)
    expect(runNativeCommandMock).not.toHaveBeenCalled()
  })

  it('answers 400 for an empty body', async () => {
    const res = makeResponse()
    await routeAt('/dir/open-path').handler(makeRequest(undefined), res)
    expect(responseStatus(res)).toBe(400)
    expect(runNativeCommandMock).not.toHaveBeenCalled()
  })
})
