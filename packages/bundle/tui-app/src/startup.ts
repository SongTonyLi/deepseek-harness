/**
 * The terminal app's command-line provider: it parses the optional prompt
 * positional, `--resume`, and `--help`, then publishes
 * {@link TUI_STARTUP_SERVICE}. The runner is an ordinary consumer whose lazy
 * config waits for that service.
 * @module @deepseek-ai/dsh-tui-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-app-startup'

/** Services required before the invocation can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the terminal runner. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the runner row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** A first prompt submitted as soon as the terminal is up; absent when the invocation carried none. */
  prompt: string | undefined
  /** A persisted session id to resume instead of starting a new session. */
  resume: string | undefined
}

/**
 * This app's command: the prompt positional, `--resume`, and the help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Talk to the agent in this terminal: streamed replies, tool cards, approvals, and slash commands.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <session-id>', 'continue a persisted session instead of starting a new one')
    .argument('[prompt...]', 'an optional first prompt; multiple words are joined by spaces')
    .addHelpText('after', `
Examples:
  dsh --profile tui                          start a new session and wait for input
  dsh --profile tui "explain this repo"      start with a first prompt
  dsh --profile tui --resume <session-id>    continue an earlier session
  dsh tui                                    alias of --profile tui

Keys: Enter sends, Esc stops the running turn, Ctrl+O expands tool output,
Ctrl+C twice (or Ctrl+D on an empty input) quits. Type /help for commands.
`)
}

/**
 * Parse and provide the invocation as an ordinary Cordis service. The
 * command's action publishes the values; on `--help` or a usage error nothing
 * is provided and the launcher exits.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action((words: string[], options: { resume?: string }) => {
    const prompt = words.join(' ').trim()
    if (options.resume !== undefined && options.resume.trim() === '') program.error('error: --resume needs a session id')
    ctx.provide(TUI_STARTUP_SERVICE, {
      prompt: prompt === '' ? undefined : prompt,
      resume: options.resume,
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
