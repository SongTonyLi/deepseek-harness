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
import { diffLines, hunks, type DiffLine, type DiffMark } from './diff.ts'

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
 * Compact token count with a thousands/millions/billions unit: `950`, `1.2k`,
 * `12.3k`, `3.4M`, `1.2B`. A trailing `.0` is dropped so `1000` reads `1k`.
 * @param count - a non-negative token count.
 * @returns the formatted count.
 */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return formatScaled(count / 1000, 'k')
  if (count < 1_000_000_000) return formatScaled(count / 1_000_000, 'M')
  return formatScaled(count / 1_000_000_000, 'B')
}

/**
 * One decimal place and a unit letter, dropping a trailing `.0`.
 * @param value - the count already divided by the unit's base.
 * @param unit - `k`, `M`, or `B`.
 * @returns the compact count.
 */
function formatScaled(value: number, unit: string): string {
  const fixed = value.toFixed(1)
  return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed}${unit}`
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

/** Characters treated as one token when the provider has not yet reported usage. */
const CHARS_PER_TOKEN = 4

/**
 * Approximate a token count from streamed character length, the same 4-chars
 * rule the Cursor adapter uses when a provider omits prompt usage.
 * @param chars - non-negative character count; a negative value counts as 0.
 * @returns `ceil(chars / 4)`.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN)
}

/** Prompt tokens occupying the context window: uncached input plus cache read. */
function promptTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0)
}

/**
 * Billed prompt tokens of one usage record: uncached input plus cache read
 * and cache write.
 * @param usage - one model call's usage.
 * @returns the billed send count.
 */
export function billedInputTokens(usage: TokenUsage): number {
  return promptTokens(usage) + (usage.cacheWriteTokens ?? 0)
}

/**
 * Fold an in-flight model call into the session totals for the footer.
 * @param totals - committed totals so far.
 * @param live - the current call; absent leaves `totals` unchanged.
 * @returns the totals the footer should draw right now.
 */
export function withLiveUsage(totals: UsageTotals, live: TokenUsage | undefined): UsageTotals {
  if (live === undefined) return totals
  const prompt = promptTokens(live)
  return {
    inputTokens: totals.inputTokens + live.inputTokens,
    outputTokens: totals.outputTokens + live.outputTokens,
    cacheReadTokens: totals.cacheReadTokens + (live.cacheReadTokens ?? 0),
    lastInputTokens: prompt > 0 ? prompt : totals.lastInputTokens,
  }
}

/**
 * The ↑send ↓receive suffix the working spinner draws for the current call.
 * @param usage - the in-flight call; absent or zero draws nothing.
 * @returns the suffix without a leading space, or the empty string.
 */
export function formatLiveUsage(usage: TokenUsage | undefined): string {
  if (usage === undefined) return ''
  const send = billedInputTokens(usage)
  const parts: string[] = []
  if (send > 0) parts.push(`↑${formatTokens(send)}`)
  if (usage.outputTokens > 0) parts.push(`↓${formatTokens(usage.outputTokens)}`)
  return parts.length === 0 ? '' : `${parts.join(' ')} tokens`
}

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
    lastInputTokens: promptTokens(usage),
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
      return `turn ended: ${reason.kind}`
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

/** The prompt drawn before a user-typed or model-run shell command. */
export const SHELL_COMMAND_PREFIX = '$ '

/**
 * The transcript row for one shell command, with the prompt outside the source.
 * @param command - the command text, one logical line or the first of several.
 * @returns `$ ${command}`.
 */
export function shellCommandRow(command: string): string {
  return `${SHELL_COMMAND_PREFIX}${command}`
}

/**
 * The span that colours one shell command after {@link SHELL_COMMAND_PREFIX}.
 * @param command - the command text the highlighter tokenises.
 * @returns the span; an unknown or unloaded grammar leaves the row plain.
 */
export function shellCommandSpan(command: string): CodeSpan {
  return { lang: 'shellscript', prefix: SHELL_COMMAND_PREFIX, source: command }
}

/**
 * One `$ command` row plus any following plain rows, with the span only on
 * the command so output, a cwd, or a description stays uncoloured.
 * @param command - the command text.
 * @param extra - rows drawn under the command.
 * @returns the body the card or the user-shell block paints.
 */
export function shellCommandBody(command: string, extra: readonly string[] = []): { lines: string[]; code: (CodeSpan | undefined)[] } {
  return {
    lines: [shellCommandRow(command), ...extra],
    code: [shellCommandSpan(command), ...extra.map(() => undefined)],
  }
}

/** Card body rows with, per row, the code span a highlighter may colour. */
export interface ToolBody {
  /** The plain rows, as the inspector and the keyboard walk read them. */
  lines: string[]
  /** One entry per row; absent, or undefined at an index, for a row that is not code. */
  code?: (CodeSpan | undefined)[]
  /** One entry per row; absent, or undefined at an index, for a row that is not a diff addition or removal. */
  diff?: (DiffMark | undefined)[]
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
 * Whether a tool delegates to a subagent, by the same name rule the browser's
 * process view applies: the `subagent` tool and every `subagent_*` tool.
 * @param name - the tool name.
 * @returns true for a tool whose card draws as one compact subagent row.
 */
export function isSubagentTool(name: string): boolean {
  return name === 'subagent' || name.startsWith('subagent_')
}

/** What a compact subagent row draws: the delegated task and its route. */
export interface SubagentRowFacts {
  /** The call's short task description; empty until the arguments carry one. */
  description: string
  /** Dim facts after the description: the requested model and the background mode, when the call names them. */
  meta: string[]
}

/**
 * Read a subagent call's arguments into the facts its compact row draws.
 * @param args - the parsed arguments, or undefined while they do not parse yet.
 * @returns the description and the dim facts; empty ones for arguments that carry none.
 */
export function subagentRowFacts(args: unknown): SubagentRowFacts {
  const record: Partial<Record<string, unknown>> = typeof args === 'object' && args !== null ? { ...args } : {}
  const text = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined
  const meta: string[] = []
  const model = text(record.model)
  if (model !== undefined) meta.push(model)
  if (record.run_in_background === true) meta.push('background')
  return { description: text(record.description) ?? '', meta }
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
 * context row so the card can colour the file's own language. A diff that
 * names where its sides start in the file leads each row with its file line:
 * the new side's for an added or context row, the old side's for a removed one.
 * @param diff - one file's old and new text.
 * @returns the rows and their spans; the `…` gap markers carry no span.
 */
export function diffBody(diff: FileDiff): Required<ToolBody> {
  const lang = extensionOf(diff.path)
  const rows = hunks(numberDiffLines(diffLines(diff.oldText, diff.newText), diff.oldStart, diff.newStart), DIFF_CONTEXT_LINES)
  const digits = rows.reduce((widest, row) => Math.max(widest, row?.number === undefined ? 0 : String(row.number).length), 0)
  const lines: string[] = []
  const code: (CodeSpan | undefined)[] = []
  const marks: (DiffMark | undefined)[] = []
  for (const row of rows) {
    if (row === undefined) {
      lines.push(`${' '.repeat(digits === 0 ? 0 : digits + 1)}  …`)
      code.push(undefined)
      marks.push(undefined)
      continue
    }
    const sign = row.kind === 'added' ? '+ ' : row.kind === 'removed' ? '- ' : '  '
    const gutter = digits === 0 ? '' : `${(row.number === undefined ? '' : String(row.number)).padStart(digits)} `
    const prefix = gutter + sign
    lines.push(prefix + row.text)
    code.push(lang === undefined ? undefined : { lang, prefix, source: row.text })
    marks.push(row.kind === 'context' ? undefined : row.kind)
  }
  return { lines, code, diff: marks }
}

/** One aligned diff row with the file line it sits on, when the diff names one. */
interface NumberedDiffLine extends DiffLine {
  number?: number
}

/**
 * Number aligned diff rows from where each side starts in the file.
 * @param lines - the aligned rows, in order.
 * @param oldStart - the old side's first file line; absent leaves removed rows unnumbered.
 * @param newStart - the new side's first file line; absent leaves added and context rows unnumbered.
 * @returns the rows, each carrying its file line when its side has a start.
 */
function numberDiffLines(lines: readonly DiffLine[], oldStart: number | undefined, newStart: number | undefined): NumberedDiffLine[] {
  let previous = oldStart
  let next = newStart
  return lines.map((line) => {
    const number = line.kind === 'removed' ? previous : next
    if (line.kind !== 'added' && previous !== undefined) previous += 1
    if (line.kind !== 'removed' && next !== undefined) next += 1
    return number === undefined ? line : { ...line, number }
  })
}

/**
 * Concatenate bodies: a heading row per diff, then that diff's rows.
 * @param diffs - the files in display order.
 * @returns one body for the whole card half.
 */
function diffsBody(diffs: readonly FileDiff[]): ToolBody {
  const lines: string[] = []
  const code: (CodeSpan | undefined)[] = []
  const marks: (DiffMark | undefined)[] = []
  for (const diff of diffs) {
    const body = diffBody(diff)
    lines.push(diff.path, ...body.lines)
    code.push(undefined, ...body.code)
    marks.push(undefined, ...body.diff)
  }
  return { lines, code, diff: marks }
}

/**
 * One tool name as a headline opens with it: lowercase, with `_` and `-` read
 * as spaces, so `web_search` matches a `Web search …` headline.
 * @param text - the tool name or the headline's opening run.
 * @returns the comparable form.
 */
function headlineWord(text: string): string {
  return text.toLowerCase().replaceAll(/[_-]+/gu, ' ')
}

/**
 * The headline drawn after a tool's own name, without the name a presenter
 * repeated. A view titled `Read src/app.ts` under the `read` tool draws
 * `src/app.ts`, so the name is read once wherever the two are drawn together.
 * @param toolName - the tool the call names.
 * @param title - the presenter's title.
 * @returns the title, or what follows the repeated name; empty when the title
 * is the name alone.
 */
export function cardHeadline(toolName: string, title: string): string {
  const name = headlineWord(toolName)
  if (name === '' || headlineWord(title.slice(0, name.length)) !== name) return title
  const rest = title.slice(name.length)
  if (rest === '') return ''
  return rest.startsWith(' ') ? rest.trimStart() : title
}

/**
 * Text for a tool call from its presentation view, falling back to the raw
 * arguments when the tool declares no presenter.
 * @param argumentsJson - the verbatim argument JSON.
 * @param view - the tool's `presentCall` view, when it has one.
 * @param toolName - the tool the call names, whose repeat the headline drops.
 * @returns the card's call text.
 */
export function toolCallText(argumentsJson: string, view: ToolCallView | undefined, toolName: string): ToolCallText {
  if (view === undefined) {
    const parsed = parseArguments(argumentsJson)
    const summary = parsed === undefined ? argumentsJson : JSON.stringify(parsed)
    return { title: '', lines: summary === '{}' || summary === '' ? [] : [summary] }
  }
  switch (view.card) {
    case 'generic': {
      const lines: string[] = []
      if (view.content !== undefined) lines.push(...contentText(view.content).split('\n'))
      return { title: cardHeadline(toolName, view.title), lines }
    }
    case 'terminal': {
      // The command is the card's own `$` row, so the headline carries the
      // call's summary instead and no card draws the command twice.
      const title = cardHeadline(toolName, view.description ?? '')
      const extra = view.cwd === undefined ? [] : [`cwd: ${view.cwd}`]
      if (view.title === '') return { title, lines: extra }
      return { title, ...shellCommandBody(view.title, extra) }
    }
    case 'diff':
      return { title: cardHeadline(toolName, view.title), ...diffsBody(view.diffs) }
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
