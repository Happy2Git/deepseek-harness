import { createServer, request as httpRequest, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  startLoopbackBridge,
  type LoopbackBridge,
} from '../src/bridge.ts'

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error: Error | undefined) => {
      if (error !== undefined) reject(error)
      else resolve()
    })
    server.closeAllConnections()
  })
}

/** Start a minimal upstream that records the request and streams a fixed body. */
async function startUpstream(
  handler?: (body: string, headers: Record<string, string | undefined>) => {
    status: number
    contentType: string
    body: string
  },
): Promise<{ baseUrl: string; requests: Array<{ body: string; authorization?: string }>; close: () => Promise<void> }> {
  const requests: Array<{ body: string; authorization?: string }> = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const authorization = request.headers.authorization
      requests.push({
        body,
        ...(authorization !== undefined ? { authorization } : {}),
      })
      const result = handler?.(body, {
        authorization: request.headers.authorization,
      }) ?? { status: 200, contentType: 'text/event-stream', body: 'data: [DONE]\n\n' }
      response.writeHead(result.status, { 'content-type': result.contentType })
      response.end(result.body)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('upstream did not acquire a port')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close() { await closeServer(server) },
  }
}

/** HTTP root of a bridge: its Codex-facing base_url minus the `/v1` suffix. */
function bridgeRoot(bridge: LoopbackBridge): string {
  return bridge.baseUrl.replace(/\/v1$/, '')
}

function post(baseUrl: string, body: string, authorization?: string): Promise<{ status: number; text: string }> {
  return fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization !== undefined ? { authorization } : {}),
    },
    body,
  }).then(async response => ({
    status: response.status,
    text: await response.text(),
  }))
}

describe('startLoopbackBridge', () => {
  it('forwards a model request to the single upstream and streams back', async () => {
    const upstream = await startUpstream()
    const bridge = await startLoopbackBridge({ upstreamBaseUrl: upstream.baseUrl })
    try {
      const result = await post(bridgeRoot(bridge), JSON.stringify({ model: 'x' }))
      expect(result.status).toBe(200)
      expect(result.text).toBe('data: [DONE]\n\n')
      expect(upstream.requests).toHaveLength(1)
      expect(JSON.parse(upstream.requests[0]!.body)).toEqual({ model: 'x' })
      expect(bridge.baseUrl.startsWith('http://127.0.0.1:')).toBe(true)
      expect(bridge.baseUrl.endsWith('/v1')).toBe(true)
    } finally {
      await bridge.close()
      await upstream.close()
    }
  })

  it('rejects a non-POST method without reaching the upstream', async () => {
    const upstream = await startUpstream()
    const bridge = await startLoopbackBridge({ upstreamBaseUrl: upstream.baseUrl })
    try {
      const result = await fetch(`${bridgeRoot(bridge)}/v1/responses`, { method: 'GET' })
      expect(result.status).toBe(405)
      expect(upstream.requests).toHaveLength(0)
    } finally {
      await bridge.close()
      await upstream.close()
    }
  })

  it('rejects a non-allowed path without reaching the upstream', async () => {
    const upstream = await startUpstream()
    const bridge = await startLoopbackBridge({ upstreamBaseUrl: upstream.baseUrl })
    try {
      const result = await fetch(`${bridgeRoot(bridge)}/v1/chat/completions`, { method: 'POST' })
      expect(result.status).toBe(404)
      expect(upstream.requests).toHaveLength(0)
    } finally {
      await bridge.close()
      await upstream.close()
    }
  })

  it('refuses a request over the byte limit', async () => {
    const upstream = await startUpstream()
    const bridge = await startLoopbackBridge({
      upstreamBaseUrl: upstream.baseUrl,
      maxRequestBytes: 8,
    })
    try {
      const result = await post(bridgeRoot(bridge), '{\"model\":\"x\"}')
      expect(result.status).toBe(413)
      expect(upstream.requests).toHaveLength(0)
    } finally {
      await bridge.close()
      await upstream.close()
    }
  })

  it('settles an aborted client instead of wedging the server', async () => {
    const upstream = await startUpstream()
    const bridge = await startLoopbackBridge({ upstreamBaseUrl: upstream.baseUrl })
    try {
      // Write half a body and destroy the socket: the client disconnect must
      // settle readBody so the handler neither leaks a socket nor wedges the
      // server, and the partial body must never reach the upstream.
      await new Promise<void>((resolve) => {
        const url = new URL(bridgeRoot(bridge) + '/v1/responses')
        const req = httpRequest({
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': '100' },
        })
        req.on('error', () => { resolve() })
        req.write('{"model":')
        setTimeout(() => { req.destroy(); resolve() }, 20)
      })
      expect(upstream.requests).toHaveLength(0)
      // A second, complete request still works, so the first handler settled.
      const result = await post(bridgeRoot(bridge), '{"model":"x"}')
      expect(result.status).toBe(200)
      expect(upstream.requests).toHaveLength(1)
    } finally {
      await bridge.close()
      await upstream.close()
    }
  })
})

describe('startLoopbackBridge credential hook', () => {
  it('replaces the Codex-supplied header with the resolved credential', async () => {
    const upstream = await startUpstream()
    const bridge = await startLoopbackBridge({
      upstreamBaseUrl: upstream.baseUrl,
      credential: async () => 'Bearer real-key',
    })
    try {
      await post(bridgeRoot(bridge), '{}', 'Bearer dummy-token')
      expect(upstream.requests[0]!.authorization).toBe('Bearer real-key')
    } finally {
      await bridge.close()
      await upstream.close()
    }
  })

  it('forwards the Codex-supplied header unchanged when no hook is set', async () => {
    const upstream = await startUpstream()
    const bridge = await startLoopbackBridge({ upstreamBaseUrl: upstream.baseUrl })
    try {
      await post(bridgeRoot(bridge), '{}', 'Bearer token')
      expect(upstream.requests[0]!.authorization).toBe('Bearer token')
    } finally {
      await bridge.close()
      await upstream.close()
    }
  })
})
