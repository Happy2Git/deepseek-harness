/**
 * Real-composition acceptance for the interactive terminal front door: boot
 * `dsh --profile cli` in a PTY, drive one user turn keyless, and assert the
 * transcript renders the direct prompt and the turn failure. This is the
 * assembled-lifecycle gate for the TUI package (the four re-entry conditions'
 * transcript acceptance), not a unit test of the renderer.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

const TUI_PTY_DRIVER = String.raw`
import fcntl, json, os, pty, select, signal, struct, sys, termios, time
node, args_json, env_json, cwd, timeout_seconds = sys.argv[1:]
env = os.environ.copy()
env.update(json.loads(env_json))
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(node, [node, *json.loads(args_json)], env)
try:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 34, 100, 0, 0))
except OSError:
    pass

def drain(seconds):
    output = bytearray()
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return output
            if not chunk:
                return output
            output.extend(chunk)
    return output

output = drain(12)          # boot + agent wiring
os.write(fd, b"hello world\r")
output.extend(drain(10))    # turn runs to the keyless credential failure
os.write(fd, b"\x04")
output.extend(drain(2))
waited, _ = os.waitpid(pid, os.WNOHANG)
if waited != pid:
    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
`

describe('dsh --profile cli (keyless TUI boot)', () => {
  it('renders the direct prompt and the turn failure from the session log', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-'))
    try {
      const launch = resolveExampleLaunch({
        srcBin: dshBinScript,
        configArgs: ['--profile', 'cli'],
        tsconfigPath,
        env: {
          DEEPSEEK_API_KEY: '',
          DSH_TELEMETRY_DISABLED: '1',
        },
      })
      const result = await execa('python3', [
        '-c',
        TUI_PTY_DRIVER,
        launch.command,
        JSON.stringify(launch.args),
        JSON.stringify(launch.env),
        cwd,
        '24',
      ], { stdin: 'ignore', timeout: 40_000, reject: false, stripFinalNewline: false })
      const output = result.stdout
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\r/g, '')
      expect(output).toContain('> hello world')
      expect(output).toContain('no API key for provider route')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 60_000)
})
