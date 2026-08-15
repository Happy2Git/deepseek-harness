/**
 * The one-shot app's command-line provider: it parses the task positional,
 * the `--session-id`/`--model` driver flags, and `--help`, then publishes
 * {@link HEADLESS_STARTUP_SERVICE}. The runner is an ordinary consumer whose
 * lazy config waits for that service.
 * @module @deepseek-ai/dsh-headless/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'headless-startup'

/** Services required before the task can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the one-shot runner. */
export const HEADLESS_STARTUP_SERVICE = 'headlessStartup'

/** What the runner row reads from {@link HEADLESS_STARTUP_SERVICE}. */
export interface HeadlessStartupValues {
  /** The task text this invocation asked for. */
  task: string
  /** Persisted session id to create-or-resume, or `undefined` for a fresh id. */
  sessionId?: string
  /** Model id overriding the default selection for this run. */
  model?: string
  /** Permission mode: `read-only`, `workspace-write`, `danger-full-access`, or `confirm`. */
  mode?: string
}

/**
 * This app's command: the task positional, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function headlessCommand(): Command {
  return new Command()
    .name('dsh --profile headless')
    .description('Answer one task, print the final assistant message, and exit.')
    .helpOption('-h, --help', 'show this help')
    .argument('[task...]', 'the task text; multiple words are joined by spaces')
    .option('--session-id <id>', 'create-or-resume the session with this exact id')
    .option('--model <model>', 'override the model for this run')
    .option('--mode <mode>', 'permission mode: read-only, workspace-write, danger-full-access, or confirm')
    .addHelpText('after', `
Examples:
  dsh --profile headless "run the tests"                 answer one task and exit
  dsh --profile headless --session-id ci-fix "fix it"    resume ci-fix or create it
  dsh --profile headless --model deepseek-v4-flash "x"   run once on a chosen model
`)
}

/**
 * Parse and provide the one-shot invocation as an ordinary Cordis service. The
 * command's action publishes the task and driver flags; a missing or
 * whitespace-only task is a usage error, so on rejection (and on `--help`)
 * nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = headlessCommand()
  program.action(() => {
    const task = program.args.join(' ')
    if (task.trim() === '') program.error('error: a task is required, for example: dsh --profile headless "run the tests"')
    const options = program.opts<{ sessionId?: string; model?: string; mode?: string }>()
    const values: HeadlessStartupValues = {
      task,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    }
    ctx.provide(HEADLESS_STARTUP_SERVICE, values)
  })
  parseCmdline(ctx, program)
}
