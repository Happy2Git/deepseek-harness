/**
 * Loopback-only reverse proxy for the private Codex app-server.
 *
 * The trimmed `dsh_inner_codex` fail-closes every provider to a literal
 * loopback base URL, so all model traffic lands here. This module forwards
 * that traffic to exactly one deployment-configured upstream model endpoint
 * and streams the response back. It deliberately performs no semantic
 * translation: the Codex provider already speaks the configured wire API
 * (Responses by default), so the bridge is a transport-level proxy.
 *
 * @module @deepseek-ai/dsh-subagent-codex/bridge
 */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'

const DEFAULT_MAX_REQUEST_BYTES = 1_048_576
const DEFAULT_PATH = '/v1/responses'

/** Origin of a request the bridge refuses before it reaches the upstream. */
export type BridgeRejectReason =
  | 'method'
  | 'path'
  | 'byteLimit'

/**
 * Optional credential resolver that lets a deployment keep the real API key
 * out of the Codex child environment. When present, the bridge inspects each
 * incoming request's Authorization header and replaces it with the value this
 * resolver returns for the upstream call. Without it, the bridge forwards the
 * Codex-supplied header unchanged.
 */
export type BridgeCredentialResolver = (
  request: IncomingMessage,
) => Promise<string | undefined>

/** Configuration for one loopback bridge instance. */
export interface LoopbackBridgeOptions {
  /**
   * The single upstream model endpoint the bridge is allowed to reach. The
   * bridge fails closed: any non-matching scheme/host/port is refused, and no
   * fallback endpoint exists.
   */
  readonly upstreamBaseUrl: string
  /**
   * Path prefix accepted from Codex and forwarded to the upstream. Defaults to
   * `/v1/responses`.
   */
  readonly path?: string
  /** Maximum accepted request body bytes; larger requests are refused. */
  readonly maxRequestBytes?: number
  /**
   * Optional Authorization replacement hook (see {@link BridgeCredentialResolver}).
   * Absent by default, which forwards the Codex-supplied header unchanged.
   */
  readonly credential?: BridgeCredentialResolver
}

/** A single running loopback bridge instance. */
export interface LoopbackBridge {
  /**
   * The loopback endpoint Codex is pointed at, e.g.
   * `http://127.0.0.1:54321/v1`. Note the port is allocated by the OS, so a
   * fresh CODEX_HOME config must be written after the bridge starts.
   */
  readonly baseUrl: string
  /** Number of requests accepted and forwarded to the upstream. */
  readonly completedRequests: number
  /** Stop accepting connections, destroy live streams, and release the port. */
  close(): Promise<void>
}

interface ParsedUpstream {
  readonly protocol: 'http:' | 'https:'
  readonly hostname: string
  readonly port: string
}

function parseUpstream(baseUrl: string): ParsedUpstream {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error(`loopback bridge: invalid upstream base URL ${JSON.stringify(baseUrl)}`)
  }
  const protocol = url.protocol
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`loopback bridge: upstream base URL must be http or https, got ${protocol}`)
  }
  return {
    protocol,
    hostname: url.hostname,
    port: url.port !== '' ? url.port : (protocol === 'https:' ? '443' : '80'),
  }
}

/** Sentinel distinguishing a refused body from a transport error. */
const BYTE_LIMIT_EXCEEDED = Symbol('dsh-bridge-byte-limit-exceeded')

function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('aborted', onAborted)
      request.off('error', onError)
      if (error !== undefined) reject(error)
      else resolve(Buffer.concat(chunks))
    }
    const onData = (chunk: Buffer): void => {
      if (settled) return
      total += chunk.length
      if (total > maxBytes) {
        settle(new Error(String(BYTE_LIMIT_EXCEEDED)))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => { settle() }
    const onAborted = (): void => {
      settle(new Error('loopback bridge: client aborted before the request body completed'))
    }
    const onError = (error: Error): void => { settle(error) }
    request.on('data', onData)
    request.on('end', onEnd)
    request.on('aborted', onAborted)
    request.on('error', onError)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error: Error | undefined) => {
      if (error !== undefined) reject(error)
      else resolve()
    })
    server.closeAllConnections()
  })
}

/**
 * Start a loopback-only reverse proxy for the Codex model endpoint.
 *
 * The bridge binds `127.0.0.1` on an OS-chosen port and accepts only the
 * configured method/path. Each accepted request is forwarded to the single
 * configured upstream; the upstream response (a Streaming SSE body for the
 * Responses wire) is piped back to the caller. Rejections respond with
 * `404`/`413`/`405` and are never forwarded.
 * @param options - upstream destination and proxy policy.
 * @returns the running bridge with its loopback endpoint and close operation.
 */
export async function startLoopbackBridge(
  options: LoopbackBridgeOptions,
): Promise<LoopbackBridge> {
  const acceptedPath = options.path ?? DEFAULT_PATH
  const maxBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
  const upstream = parseUpstream(options.upstreamBaseUrl)
  const credential = options.credential
  let completedRequests = 0
  const openResponses = new Set<ServerResponse>()
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    openResponses.add(response)
    response.on('close', () => { openResponses.delete(response) })
    void (async () => {
      if (request.method !== 'POST') {
        response.writeHead(405)
        response.end()
        return
      }
      if (request.url !== acceptedPath) {
        response.writeHead(404)
        response.end()
        return
      }
      let body: Buffer
      try {
        body = await readBody(request, maxBytes)
      } catch {
        // Refused bodies still send their remaining bytes; drain them so the
        // 413 response can flush, then reply without forwarding upstream.
        request.resume()
        response.writeHead(413)
        response.end(JSON.stringify({ error: { message: 'request exceeded its byte limit' } }))
        return
      }
      const headers: Record<string, string | string[] | undefined> = {
        'content-type': request.headers['content-type'] ?? 'application/json',
      }
      const incomingAuth = request.headers.authorization
      if (credential !== undefined) {
        const replacement = await credential(request)
        if (replacement !== undefined) {
          headers.authorization = replacement
        } else if (incomingAuth !== undefined) {
          headers.authorization = incomingAuth
        }
      } else if (incomingAuth !== undefined) {
        headers.authorization = incomingAuth
      }
      const requestFn = upstream.protocol === 'https:' ? httpsRequest : httpRequest
      const upstreamRequest = requestFn({
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        path: acceptedPath,
        method: 'POST',
        headers,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, {
          'content-type': upstreamResponse.headers['content-type'] ?? 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        // Respect backpressure: a slow Codex client must never buffer the whole
        // stream in memory, so pause the upstream until the response drains.
        response.on('drain', () => { upstreamResponse.resume() })
        upstreamResponse.on('data', (chunk: Buffer) => {
          if (response.writableEnded) return
          if (!response.write(chunk)) upstreamResponse.pause()
        })
        upstreamResponse.on('end', () => {
          response.end()
          completedRequests += 1
        })
        upstreamResponse.on('error', () => {
          if (!response.headersSent) response.writeHead(502)
          if (!response.writableEnded) response.end()
        })
      })
      // A client disconnect mid-stream must tear down the upstream too, or the
      // model socket keeps streaming into a response nobody is reading.
      response.on('close', () => { upstreamRequest.destroy() })
      upstreamRequest.on('error', () => {
        if (!response.headersSent) response.writeHead(502)
        if (!response.writableEnded) response.end()
      })
      upstreamRequest.end(body)
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502)
      if (!response.writableEnded) response.end()
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
    throw new Error('loopback bridge did not acquire a TCP port')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get completedRequests(): number { return completedRequests },
    async close(): Promise<void> {
      for (const response of openResponses) response.destroy()
      await closeServer(server)
    },
  }
}
