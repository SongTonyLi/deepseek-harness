/**
 * Pure transcript formatting: durable session facts and tool presentation
 * views become plain text rows for the terminal components to draw. Nothing
 * here touches the terminal, the palette, or the agent.
 * @module @deepseek-ai/dsh-tui-app/transcript
 */

import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { FileDiff, ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { diffLines, hunks } from './diff.ts'

/** Unchanged rows shown around each diff hunk. */
const DIFF_CONTEXT_LINES = 2

/**
 * Join the text of the text blocks in `blocks`; other block kinds are
 * summarized in brackets so a card never hides that they exist.
 * @param blocks - model or tool content.
 * @returns the readable text.
 */
export function contentText(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => {
    if (block.type === 'text') return block.text
    if (block.type === 'reasoning') return ''
    return `[${block.type}]`
  }).filter(part => part !== '').join('\n')
}

/**
 * Compact token count: `950`, `1.2k`, `3.4M`.
 * @param count - a non-negative token count.
 * @returns the formatted count.
 */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/**
 * Compact elapsed time for the live counters: `0s`, `8s`, `1m12s`, `1h04m`,
 * `26h07m`. Seconds are truncated rather than rounded, so a counter never
 * reports a second that has not passed, and a negative input — a clock that
 * moved backwards between two samples — reads `0s`. A unit under a larger one
 * is padded to two digits so the text keeps its width while a counter runs,
 * and past an hour the seconds are dropped. `formatDuration` in `status.ts`
 * reports recorded model and tool times instead: tenths under a minute, and
 * no hour unit.
 * @param ms - elapsed milliseconds.
 * @returns the formatted duration.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const seconds = total % 60
  if (hours > 0) return `${String(hours)}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${String(minutes)}m${String(seconds).padStart(2, '0')}s`
  return `${String(seconds)}s`
}

/**
 * `YYYY-MM-DD HH:MM` in UTC: how this terminal dates a recorded moment, in
 * the session picker, the subagent details, and the status bar alike.
 * @param ms - a Unix timestamp in milliseconds.
 * @returns the formatted timestamp.
 */
export function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

/** Cumulative usage across the session's committed assistant messages. */
export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** The most recent request's prompt size, the live context estimate. */
  lastInputTokens: number
}

/** The zero totals a fresh session starts from. */
export const EMPTY_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, lastInputTokens: 0 }

/**
 * Fold one committed usage record into the totals.
 * @param totals - the totals so far.
 * @param usage - the message's usage.
 * @returns the new totals.
 */
export function addUsage(totals: UsageTotals, usage: TokenUsage): UsageTotals {
  return {
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    lastInputTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0),
  }
}

/**
 * The one-line usage summary drawn in the footer.
 * @param totals - the cumulative totals.
 * @returns the summary, or an empty string before the first committed message.
 */
export function formatUsage(totals: UsageTotals): string {
  if (totals.inputTokens === 0 && totals.outputTokens === 0) return ''
  const parts = [`↑${formatTokens(totals.inputTokens)}`, `↓${formatTokens(totals.outputTokens)}`]
  if (totals.cacheReadTokens > 0) parts.push(`cache ${formatTokens(totals.cacheReadTokens)}`)
  parts.push(`ctx ${formatTokens(totals.lastInputTokens)}`)
  return parts.join(' ')
}

/**
 * The notice a closed turn earns, or undefined for an ordinary completion.
 * @param reason - the durable turn-end reason.
 * @returns the notice text.
 */
export function turnEndNotice(reason: TurnEndReason): string | undefined {
  switch (reason.kind) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'turn stopped'
    case 'blocked':
      return 'turn blocked: the model produced nothing the loop could continue'
    case 'error':
      return `turn failed: ${reason.error.code}: ${reason.error.message}`
    case 'max-tokens':
      return 'turn reached the output token ceiling'
    case 'interrupted':
      return 'turn was interrupted by an earlier process exit'
    default:
      return assertNever(reason, 'tui turn-end reason')
  }
}

/**
 * One-line text for a failure value from a handler, a service, or the host.
 * @param error - the thrown or rejected value.
 * @returns the error message, or the value rendered as a string.
 */
export function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A tool card's call half. */
export interface ToolCallText {
  /** The card headline after the tool name; empty when the tool declares no presenter. */
  title: string
  /** Detail rows under the headline; may be empty. */
  lines: string[]
}

/**
 * Parse the model's raw argument JSON for presentation.
 * @param argumentsJson - the `tool/call` event's verbatim argument string.
 * @returns the parsed value, or undefined when it is not JSON.
 */
export function parseArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown
  } catch {
    // The model may emit malformed JSON; the card then shows the raw string.
    return undefined
  }
}

/**
 * Render a diff for a card body.
 * @param diff - one file's old and new text.
 * @returns rows prefixed with `+`, `-`, or two spaces, plus `…` gap markers.
 */
export function diffRows(diff: FileDiff): string[] {
  const rows = hunks(diffLines(diff.oldText, diff.newText), DIFF_CONTEXT_LINES)
  return rows.map((row) => {
    if (row === undefined) return '  …'
    const prefix = row.kind === 'added' ? '+ ' : row.kind === 'removed' ? '- ' : '  '
    return prefix + row.text
  })
}

/**
 * Text for a tool call from its presentation view, falling back to the raw
 * arguments when the tool declares no presenter.
 * @param argumentsJson - the verbatim argument JSON.
 * @param view - the tool's `presentCall` view, when it has one.
 * @returns the card's call text.
 */
export function toolCallText(argumentsJson: string, view: ToolCallView | undefined): ToolCallText {
  if (view === undefined) {
    const parsed = parseArguments(argumentsJson)
    const summary = parsed === undefined ? argumentsJson : JSON.stringify(parsed)
    return { title: '', lines: summary === '{}' || summary === '' ? [] : [summary] }
  }
  switch (view.card) {
    case 'generic': {
      const lines: string[] = []
      if (view.content !== undefined) lines.push(...contentText(view.content).split('\n'))
      return { title: view.title, lines }
    }
    case 'terminal': {
      const lines: string[] = []
      if (view.description !== undefined) lines.push(view.description)
      if (view.cwd !== undefined) lines.push(`cwd: ${view.cwd}`)
      return { title: view.title, lines }
    }
    case 'diff':
      return { title: view.title, lines: view.diffs.flatMap(diff => [diff.path, ...diffRows(diff)]) }
    default:
      return assertNever(view, 'tui tool call view')
  }
}

/**
 * Text rows for a completed tool call from its presentation view, falling
 * back to the model-facing result content.
 * @param view - the tool's `presentResult` view, when it has one.
 * @param content - the model-facing result content.
 * @returns the rows, before any preview truncation.
 */
export function toolResultLines(view: ToolResultView | undefined, content: readonly ContentBlock[]): string[] {
  if (view === undefined) return contentText(content).split('\n').filter(line => line !== '')
  switch (view.card) {
    case 'generic':
      return contentText(view.content ?? content).split('\n').filter(line => line !== '')
    case 'terminal': {
      const lines = (view.output ?? '').split('\n')
      while (lines.length > 0 && lines.at(-1) === '') lines.pop()
      if (view.exitCode !== undefined && view.exitCode !== 0) lines.push(`exit ${String(view.exitCode)}`)
      if (view.signal !== undefined) lines.push(`signal ${view.signal}`)
      return lines
    }
    case 'diff':
      return view.diffs.flatMap(diff => [diff.path, ...diffRows(diff)])
    case 'search': {
      const lines = view.shape === 'matches'
        ? view.files.flatMap(file => file.matches.map(match => `${file.path}:${String(match.lineNumber)}: ${match.line}`))
        : [...view.paths]
      if (view.truncated) lines.push(`… ${String(view.total)} total`)
      return lines
    }
    case 'read':
      return view.lines.map(line => `${String(line.number).padStart(4)}│ ${line.text}`)
    case 'web': {
      if (view.kind === 'fetch') return [`${view.url} (${String(view.statusCode)})`]
      const lines = view.sources.map(source => source.title === undefined ? source.url : `${source.title} — ${source.url}`)
      if (view.answer !== undefined) lines.unshift(view.answer)
      return lines
    }
    default:
      return assertNever(view, 'tui tool result view')
  }
}

/**
 * Cut rows to a maximum, naming what was left out on one trailing row. Every
 * surface that shows part of something longer folds it this way - the collapsed
 * tool card, an approval's call detail, the focused-section inspector - and each
 * names the key that shows the rest.
 * @param lines - the full rows.
 * @param keep - rows kept ahead of the marker.
 * @param marker - builds the trailing row from the number of rows left out.
 * @returns the rows to draw; a copy of `lines` when they all fit.
 */
export function foldRows(lines: readonly string[], keep: number, marker: (hidden: number) => string): string[] {
  if (lines.length <= keep) return [...lines]
  return [...lines.slice(0, keep), marker(lines.length - keep)]
}

/** Where folded rows are drawn, which decides the key their marker names. */
export type FoldOpener =
  /** The transcript block the walk marks, which one press of `Space` opens. */
  | 'marked'
  /** Any other block in the conversation; `Ctrl+O` opens every one of them. */
  | 'transcript'
  /** The docked inspector, whose remaining rows the reader draws. */
  | 'inspector'

/** The key each fold marker names, the one place these words are written. */
const FOLD_KEYS: Record<FoldOpener, string> = {
  marked: 'Space expands',
  transcript: 'Ctrl+O expands',
  inspector: 'Ctrl+G reads it',
}

/**
 * The one fold grammar, on the row that stands for what a fold left out: how
 * many rows are not drawn, and the key that reaches them from where the
 * keyboard is.
 * @param hidden - rows the fold left out.
 * @param opens - where the folded rows are drawn.
 * @returns the marker row, unstyled.
 */
export function foldMarker(hidden: number, opens: FoldOpener): string {
  return `… ${String(hidden)} more row${hidden === 1 ? '' : 's'} · ${FOLD_KEYS[opens]}`
}
