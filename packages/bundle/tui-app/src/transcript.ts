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

/**
 * The source behind one card row, so the card can draw it in syntax colour:
 * the row is `prefix + source`, and only `source` is coloured.
 */
export interface CodeSpan {
  /** The language hint the highlighter resolves; unknown hints draw plain. */
  lang: string
  /** The row's own text before the source: a line number, a diff sign, an indent. */
  prefix: string
  /** The source text, one line without its newline. */
  source: string
}

/** Card body rows with, per row, the code span a highlighter may colour. */
export interface ToolBody {
  /** The plain rows, as the inspector and the keyboard walk read them. */
  lines: string[]
  /** One entry per row; absent, or undefined at an index, for a row that is not code. */
  code?: (CodeSpan | undefined)[]
}

/** A tool card's call half. */
export interface ToolCallText extends ToolBody {
  /** The card headline after the tool name; empty when the tool declares no presenter. */
  title: string
}

/**
 * The extension of a path, lowercased, as a language hint for its content.
 * @param path - a file path in either separator style.
 * @returns the extension without its dot, or undefined for a dotfile or an
 * extensionless name.
 */
function extensionOf(path: string): string | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? undefined : base.slice(dot + 1).toLowerCase()
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
  return diffBody(diff).lines
}

/**
 * Render a diff for a card body, with the code span behind each changed or
 * context row so the card can colour the file's own language.
 * @param diff - one file's old and new text.
 * @returns the rows and their spans; the `…` gap markers carry no span.
 */
export function diffBody(diff: FileDiff): Required<ToolBody> {
  const lang = extensionOf(diff.path)
  const rows = hunks(diffLines(diff.oldText, diff.newText), DIFF_CONTEXT_LINES)
  const lines: string[] = []
  const code: (CodeSpan | undefined)[] = []
  for (const row of rows) {
    if (row === undefined) {
      lines.push('  …')
      code.push(undefined)
      continue
    }
    const prefix = row.kind === 'added' ? '+ ' : row.kind === 'removed' ? '- ' : '  '
    lines.push(prefix + row.text)
    code.push(lang === undefined ? undefined : { lang, prefix, source: row.text })
  }
  return { lines, code }
}

/**
 * Concatenate bodies: a heading row per diff, then that diff's rows.
 * @param diffs - the files in display order.
 * @returns one body for the whole card half.
 */
function diffsBody(diffs: readonly FileDiff[]): ToolBody {
  const lines: string[] = []
  const code: (CodeSpan | undefined)[] = []
  for (const diff of diffs) {
    const body = diffBody(diff)
    lines.push(diff.path, ...body.lines)
    code.push(undefined, ...body.code)
  }
  return { lines, code }
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
      return { title: view.title, ...diffsBody(view.diffs) }
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
  return toolResultBody(view, content).lines
}

/**
 * {@link toolResultLines} with the code span behind each row of a `read` or
 * `diff` card, so the card draws the file's own language in colour.
 * @param view - the tool's `presentResult` view, when it has one.
 * @param content - the model-facing result content.
 * @returns the rows and, for the two code cards, their spans.
 */
export function toolResultBody(view: ToolResultView | undefined, content: readonly ContentBlock[]): ToolBody {
  if (view === undefined) return { lines: contentText(content).split('\n').filter(line => line !== '') }
  switch (view.card) {
    case 'generic':
      return { lines: contentText(view.content ?? content).split('\n').filter(line => line !== '') }
    case 'terminal': {
      const lines = (view.output ?? '').split('\n')
      while (lines.length > 0 && lines.at(-1) === '') lines.pop()
      if (view.exitCode !== undefined && view.exitCode !== 0) lines.push(`exit ${String(view.exitCode)}`)
      if (view.signal !== undefined) lines.push(`signal ${view.signal}`)
      return { lines }
    }
    case 'diff':
      return diffsBody(view.diffs)
    case 'search': {
      const lines = view.shape === 'matches'
        ? view.files.flatMap(file => file.matches.map(match => `${file.path}:${String(match.lineNumber)}: ${match.line}`))
        : [...view.paths]
      if (view.truncated) lines.push(`… ${String(view.total)} total`)
      return { lines }
    }
    case 'read': {
      const lang = view.lang
      const rows = view.lines.map(line => ({ prefix: `${String(line.number).padStart(4)}│ `, source: line.text }))
      return {
        lines: rows.map(row => `${row.prefix}${row.source}`),
        ...lang === undefined ? {} : { code: rows.map(row => ({ lang, ...row })) },
      }
    }
    case 'web': {
      if (view.kind === 'fetch') return { lines: [`${view.url} (${String(view.statusCode)})`] }
      const lines = view.sources.map(source => source.title === undefined ? source.url : `${source.title} — ${source.url}`)
      if (view.answer !== undefined) lines.unshift(view.answer)
      return { lines }
    }
    default:
      return assertNever(view, 'tui tool result view')
  }
}

/**
 * Draw card rows in syntax colour where a highlighter and a span allow it.
 * Consecutive spans of one language are coloured as one block, so a comment
 * or string that spans rows keeps its colour; a group the highlighter cannot
 * colour yet, or colours to a different row count, draws plain and is drawn
 * again once its grammar lands.
 * @param lines - the plain rows.
 * @param code - the span behind each row, aligned by index; absent rows draw plain.
 * @param highlight - the highlighter; absent draws every row plain.
 * @returns the rows to draw, same length as `lines`.
 */
export function paintCodeRows(
  lines: readonly string[],
  code: readonly (CodeSpan | undefined)[] | undefined,
  highlight: { lines(code: string, lang: string | undefined): string[] | undefined } | undefined,
): string[] {
  if (code === undefined || highlight === undefined) return [...lines]
  const out = [...lines]
  let index = 0
  while (index < lines.length) {
    const span = code[index]
    if (span === undefined) {
      index += 1
      continue
    }
    let end = index + 1
    while (end < lines.length && code[end]?.lang === span.lang) end += 1
    const group = code.slice(index, end) as CodeSpan[]
    const coloured = highlight.lines(group.map(row => row.source).join('\n'), span.lang)
    if (coloured !== undefined && coloured.length === group.length) {
      // One coloured line per row, as the length check just established.
      coloured.forEach((text, offset) => { out[index + offset] = `${(group[offset] as CodeSpan).prefix}${text}` })
    }
    index = end
  }
  return out
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
