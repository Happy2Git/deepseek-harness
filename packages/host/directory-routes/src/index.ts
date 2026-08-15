/**
 * Plugin-owned HTTP routes for the context-files panel's directory browsing.
 * The browser panel cannot reach `ctx.directoryPicker` directly, and the core
 * API gateway is a closed contract, so this plugin registers its own routes
 * (`/dir/list`, `/dir/read-text`, `/dir/open-path`) over `ctx.webServer` and
 * answers them from the composed `ctx.directoryPicker` browse capability. A
 * third-party panel therefore carries its transport with it.
 * @module @deepseek-ai/dsh-host-directory-routes
 */

import { isAbsolute as isAbsolutePosix } from 'node:path/posix'
import { isAbsolute as isAbsoluteWin32 } from 'node:path/win32'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { DirectoryPickerBrowseCapability } from '@deepseek-ai/dsh-host-directory-picker'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'

/** Byte cap for one request body; the routes carry only `{ path }` payloads. */
const MAX_BODY_BYTES = 64 * 1024

/** HTTP failure with a status, answered as a structured JSON error. */
class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'RouteError'
  }
}

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** HTTP status for a thrown route failure. */
function statusOf(error: unknown): number {
  return error instanceof RouteError ? error.status : 400
}

/**
 * Read one JSON request body, enforcing the cross-site write fence (only the
 * `application/json` media type is accepted, forcing a browser preflight) and
 * a size cap. Empty body is `undefined`; a malformed body is a typed 400.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    throw new RouteError(415, 'content type must be application/json')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new RouteError(413, 'request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new RouteError(400, 'body is not JSON')
  }
}

/** Write one JSON response body. */
function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/**
 * One request-bound abort signal: a client that disconnects before the
 * response finishes aborts the host work. `res` emits `close` on completion
 * too, so only the not-yet-finished case (the client actually left) aborts.
 */
function requestSignal(res: ServerResponse): AbortSignal {
  const controller = new AbortController()
  res.once('close', () => {
    if (!res.writableEnded) controller.abort(new Error('client disconnected'))
  })
  return controller.signal
}

/**
 * True when the path names one fixed filesystem location on this platform,
 * aligned with the browse backend's `fullyQualified`: POSIX-absolute on
 * POSIX; drive-qualified or full-UNC on Windows (rooted drive-less forms
 * like `\foo`/`/foo` still resolve against the process's current drive).
 */
function fullyQualified(path: string): boolean {
  return process.platform === 'win32'
    ? isAbsoluteWin32(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : isAbsolutePosix(path)
}

/** Validate one `{ path }` payload as an absolute host path. */
function readAbsolutePath(body: unknown): string {
  if (typeof body !== 'object' || body === null) throw new RouteError(400, 'missing path')
  const path = (body as { path?: unknown }).path
  if (typeof path !== 'string' || path === '') throw new RouteError(400, 'missing path')
  if (!fullyQualified(path)) throw new RouteError(400, 'path must be absolute')
  return path
}

/** Open one host path with its default application (minimal, no-shell). */
async function openPathNative(path: string, signal: AbortSignal): Promise<void> {
  if (process.platform === 'darwin') {
    await runNativeCommand('open', [path], signal)
    return
  }
  if (process.platform === 'win32') {
    const literal = `'${path.replace(/'/g, "''")}'`
    await runNativeCommand('powershell.exe', ['-NoProfile', '-Command', `Invoke-Item -LiteralPath ${literal}`], signal)
    return
  }
  await runNativeCommand('xdg-open', [path], signal)
}

/** Wrap one route body in the read-validate-answer shape. */
async function serve(res: ServerResponse, run: () => Promise<unknown>): Promise<void> {
  try {
    writeJson(res, 200, await run())
  } catch (error: unknown) {
    writeJson(res, statusOf(error), { error: { message: messageOf(error) } })
  }
}

/** The route-registration plugin body. */
export default class DirectoryRoutes {
  static inject = ['webServer', 'directoryPicker']

  constructor(ctx: Context) {
    // Loopback-only: these routes read and open arbitrary host paths, so they
    // must never be reachable from a network interface. Fail loud instead of
    // serving them on a non-loopback host.
    if (ctx.webServer.host !== '127.0.0.1') {
      throw new Error('directory-routes: /dir/* is loopback-only; refuse to serve on a non-loopback host')
    }
    /** The composed browse capability, or throw when a non-browse backend is mounted. */
    const browse = (): DirectoryPickerBrowseCapability => {
      const capability = ctx.directoryPicker.capability()
      if (capability.kind !== 'browse') {
        throw new Error(`directory browsing is not composed (serves "${capability.kind}")`)
      }
      return capability
    }
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dir/list',
      handler: async (req, res) => {
        const signal = requestSignal(res)
        await serve(res, async () => {
          const body = await readJsonBody(req) as { path?: string } | undefined
          const path = body === undefined ? undefined : readAbsolutePath(body)
          return await browse().list(path, signal)
        })
      },
    }), 'directory-routes: /dir/list')
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dir/read-text',
      handler: async (req, res) => {
        const signal = requestSignal(res)
        await serve(res, async () => {
          const path = readAbsolutePath(await readJsonBody(req))
          return await browse().readText(path, signal)
        })
      },
    }), 'directory-routes: /dir/read-text')
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dir/open-path',
      handler: async (req, res) => {
        const signal = requestSignal(res)
        await serve(res, async () => {
          const path = readAbsolutePath(await readJsonBody(req))
          await openPathNative(path, signal)
          return { opened: true }
        })
      },
    }), 'directory-routes: /dir/open-path')
  }
}
