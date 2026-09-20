/**
 * Parse and present a user-typed `!` / `!!` shell line. The terminal runs the
 * command itself; `!` becomes next-step context and `!!` stays local.
 * @module @deepseek-ai/dsh-tui-app/shell-line
 */

import type { CollectedOutput, ShellRunResult } from '@deepseek-ai/dsh-shell'

/** A nonempty `!` or `!!` line after the prefix is stripped. */
export interface UserShellLine {
  /** The command text, already trimmed. */
  command: string
  /** True for `!!`, which must not become model-visible context. */
  excluded: boolean
}

/**
 * Read a submitted editor line as a user shell command.
 * @param text - the trimmed editor text.
 * @returns the command and whether it is excluded, or undefined when the line
 *   is not a nonempty `!` / `!!` prefix.
 */
export function parseUserShellLine(text: string): UserShellLine | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('!')) return undefined
  const excluded = trimmed.startsWith('!!')
  const command = (excluded ? trimmed.slice(2) : trimmed.slice(1)).trim()
  return command === '' ? undefined : { command, excluded }
}

/**
 * Shape one finished run as the text the next model request reads.
 * @param command - the command the user typed after `!`.
 * @param result - the completed foreground run.
 * @returns the model-facing notice body.
 */
export function userShellContextText(command: string, result: ShellRunResult): string {
  const output = combinedOutput(result)
  let text = `The user ran \`${command}\` in the terminal.\n`
  text += output === '' ? '(no output)' : `\`\`\`\n${output}\n\`\`\``
  if (result.aborted) text += '\n\n(command cancelled)'
  else if (result.timedOut) text += `\n\n[timed out after ${String(result.timeoutMs)}ms]`
  else if (result.signal !== null) text += `\n\n[killed by signal: ${result.signal}]`
  else if (result.exitCode !== null && result.exitCode !== 0) text += `\n\nCommand exited with code ${String(result.exitCode)}`
  return text
}

/**
 * Shape one finished run as the rows the transcript draws immediately.
 * @param command - the command the user typed after `!`.
 * @param result - the completed foreground run.
 * @returns `$ command`, any output, and a cancel or nonzero-exit marker.
 */
export function userShellTranscriptRows(command: string, result: ShellRunResult): string[] {
  const output = combinedOutput(result)
  const rows = [`$ ${command}`]
  if (output !== '') rows.push(output)
  if (result.aborted) rows.push('(command cancelled)')
  else if (result.exitCode !== null && result.exitCode !== 0) rows.push(`(exit ${String(result.exitCode)})`)
  return rows
}

/**
 * Join stdout and a marked stderr section, dropping a single trailing newline
 * so a fenced body does not carry a blank last line.
 * @param result - the completed foreground run.
 * @returns the combined body, or the empty string when both streams are empty.
 */
function combinedOutput(result: ShellRunResult): string {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  if (err === '') return out
  return out === '' ? `[stderr]\n${err}` : `${out}\n[stderr]\n${err}`
}

/**
 * Take one collected stream, appending its truncation marker when present.
 * @param output - one captured stream.
 * @returns the text without a single trailing newline.
 */
function streamText(output: CollectedOutput): string {
  const text = output.truncated
    ? `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`
    : output.text
  return text.replace(/\n$/u, '')
}
