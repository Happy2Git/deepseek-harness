/**
 * The interactive app's command-line provider: it parses the optional
 * `--resume` session id and `--help`, then publishes {@link CLI_STARTUP_SERVICE}.
 * The terminal front door is an ordinary consumer whose lazy mount waits for
 * that service.
 * @module @deepseek-ai/dsh-cli/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'cli-startup'

/** Services required before the invocation can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the terminal front door. */
export const CLI_STARTUP_SERVICE = 'cliStartup'

/** What the front door reads from {@link CLI_STARTUP_SERVICE}. */
export interface CliStartupValues {
  /** Persisted session id to resume, or `undefined` for a fresh session. */
  resume?: string
}

/**
 * This app's command: the `--resume` option and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function cliCommand(): Command {
  return new Command()
    .name('dsh --profile cli')
    .description('Start an interactive terminal session.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <session-id>', 'resume a persisted session')
    .addHelpText('after', `
Examples:
  dsh --profile cli                 start a session in the current directory
  dsh --profile cli --resume <id>   resume a persisted session
`)
}

/**
 * Parse and provide the interactive invocation as an ordinary Cordis service.
 * The command's action publishes the resume target; on `--help` or a parse
 * error nothing is provided, so the front door never mounts.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = cliCommand()
  program.action(() => {
    const options = program.opts<{ resume?: string }>()
    const values: CliStartupValues = options.resume === undefined ? {} : { resume: options.resume }
    ctx.provide(CLI_STARTUP_SERVICE, values)
  })
  parseCmdline(ctx, program)
}
