/**
 * What one compaction folded into its summary and what it left verbatim, read
 * from the session log the terminal already draws.
 *
 * {@link CompactionLedger} mirrors the model-visible surface from the logged
 * `surfaceOp` of every message event it observes (an append pushes the node, a
 * replacement splices the positional span), and keeps one short fact per
 * surface node. When a `compaction/*` transaction closes, the checkpoint
 * replacement it landed names the shadowed nodes (compressed) and every other
 * node still on the surface (preserved). Live events and a replayed history go
 * through the same path, so a resumed session draws the same account the live
 * one did. Nothing here touches the terminal, the palette, or the agent.
 * @module @deepseek-ai/dsh-tui-app/compaction
 */

import { visibleWidth } from '@earendil-works/pi-tui'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import type { ToolCallId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionSeq, SurfaceEvent } from '@deepseek-ai/dsh-session'
import { isSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
// Also merges the `compaction/*` events into `SessionEventMap` and the
// checkpoint into `MessageSourceMap`.
import type { CompactionId } from '@deepseek-ai/dsh-compaction'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { injectedContextTitle } from './context.ts'
import type { SectionPart } from './navigation.ts'
import { contentText, formatTokens } from './transcript.ts'

/** One model-visible surface node, as the compaction account names it. */
export type SurfaceFact =
  | { readonly kind: 'system' }
  | { readonly kind: 'prompt'; readonly turn: number; readonly text: string }
  | { readonly kind: 'context'; readonly turn: number; readonly title: string }
  | { readonly kind: 'summary'; readonly turn: number }
  | { readonly kind: 'reply'; readonly turn: number }
  | { readonly kind: 'result'; readonly turn: number; readonly tool: string }
  | { readonly kind: 'developer'; readonly turn: number }

/** One landed compaction: its origin, the two sides of its cut, and the summary between them. */
export interface CompactionReport {
  /** Whether a human command (`/compact`) started it rather than automatic pressure or overflow recovery. */
  readonly manual: boolean
  /** The turn the transcript was in when the summary landed. */
  readonly turn: number
  /** The shadowed surface nodes, in surface order. */
  readonly compressed: readonly SurfaceFact[]
  /** Every other node still on the surface, in surface order; the checkpoint itself is not listed. */
  readonly preserved: readonly SurfaceFact[]
  /** The summary text the checkpoint carries, without its framing. */
  readonly summary: string
  /** Estimated tokens of the shadowed nodes, as `compaction/summary` prices them. */
  readonly compressedTokens: number
  /** Estimated tokens of the checkpoint that replaced them; absent when no estimator is composed. */
  readonly summaryTokens?: number
  /** The model that wrote the summary. */
  readonly model: string
  /** The seq of the `compaction/summary` event, which a `/compact` result names as its source. */
  readonly summarySeq: SessionSeq
}

/** How one observed compaction transaction closed. */
export type CompactionOutcome =
  | { readonly kind: 'compacted'; readonly report: CompactionReport }
  | {
    readonly kind: 'failed'
    /** The failed transaction, as its `compaction/start` named it. */
    readonly compactionId: CompactionId
    /** Whether a human command started the failed attempt. */
    readonly manual: boolean
    /** The logged error chain of the attempt. */
    readonly error: string
  }

/**
 * Prices one checkpoint message with the token meter's fixed heuristic, the
 * unit `compaction/summary` prices the compressed span in; undefined when the
 * running profile composes no meter.
 */
export type CheckpointEstimator = (message: UserMessage) => number | undefined

/** One mirrored surface node. */
interface SurfaceNode {
  readonly seq: SessionSeq
  readonly fact: SurfaceFact
}

/** A transaction between its `compaction/start` and `compaction/end`. */
interface OpenCompaction {
  readonly manual: boolean
  summary?: { readonly seq: SessionSeq; readonly text: string; readonly tokens: number; readonly model: string }
  landed?: {
    readonly turn: number
    readonly compressed: readonly SurfaceFact[]
    readonly preserved: readonly SurfaceFact[]
    readonly summaryTokens?: number
  }
}

/** Prompts listed one per row under `compressed` before the rest are counted. */
const LISTED_PROMPTS = 5

/** Context titles named under `compressed` before the rest are counted. */
const LISTED_CONTEXTS = 4

/**
 * Columns a listed prompt is cut to, so each takes one row of an 80-column
 * terminal beside its glyph and the block's indent. The account is pinned
 * above the fold, so a long prompt would otherwise push the summary down; the
 * reader and the transcript still hold the whole prompt. A presentation
 * bound, not a deployment setting.
 */
const PROMPT_COLUMNS = 72

/**
 * Mirrors one session's surface and reports each compaction that closes on it.
 * Feed it every event of the bound session in log order, live or replayed;
 * {@link CompactionLedger.clear} starts over for another session.
 */
export class CompactionLedger {
  private readonly nodes: SurfaceNode[] = []
  private readonly toolNames = new Map<ToolCallId, string>()
  private readonly open = new Map<CompactionId, OpenCompaction>()

  /**
   * @param estimate - prices the checkpoint that replaced the compressed span.
   */
  constructor(private readonly estimate: CheckpointEstimator) {}

  /** Forget the mirrored surface and every open transaction. */
  clear(): void {
    this.nodes.length = 0
    this.toolNames.clear()
    this.open.clear()
  }

  /**
   * Fold one event of the observed session.
   * @param event - the next event in log order.
   * @param turn - the transcript's current turn, which facts appended now belong to.
   * @returns the outcome when this event closed a compaction transaction, else undefined.
   */
  observe(event: SessionEvent, turn: number): CompactionOutcome | undefined {
    switch (event.type) {
      case 'compaction/start':
        this.open.set(event.data.compactionId, { manual: event.data.sourceCommandId !== undefined })
        return undefined
      case 'compaction/summary': {
        const open = this.open.get(event.data.compactionId)
        if (open !== undefined) {
          open.summary = {
            seq: event.seq,
            text: contentText(event.data.summary).trim(),
            tokens: event.data.shadowedTokenCount,
            model: event.data.model,
          }
        }
        return undefined
      }
      case 'compaction/end':
        return this.close(event)
      default:
        break
    }
    if (!isSurfaceEvent(event)) return undefined
    const node = { seq: event.seq, fact: this.factOf(event, turn) }
    if (event.surfaceOp === 'append') {
      this.nodes.push(node)
      return undefined
    }
    const { startSeq, endSeq } = event.surfaceOp
    const from = this.nodes.findIndex(entry => entry.seq === startSeq)
    const to = this.nodes.findIndex(entry => entry.seq === endSeq)
    // A replacement names a span this ledger saw appended unless it started
    // observing mid-log; the account then leaves that span out.
    const shadowed = from === -1 || to < from ? [] : this.nodes.splice(from, to - from + 1, node)
    if (event.type === 'user/message' && isCompactCheckpointSource(event.data.source)) {
      const open = this.open.get(event.data.source.compactionId)
      if (open !== undefined) {
        const summaryTokens = this.estimate(event.data)
        open.landed = {
          turn,
          compressed: shadowed.map(entry => entry.fact),
          preserved: this.nodes.flatMap(entry => entry === node ? [] : [entry.fact]),
          ...summaryTokens === undefined ? {} : { summaryTokens },
        }
      }
    }
    return undefined
  }

  /**
   * Settle one transaction on its closing marker.
   * @param event - the `compaction/end` event.
   * @returns the outcome, or undefined for a transaction this ledger did not see open.
   */
  private close(event: SessionEvent<'compaction/end'>): CompactionOutcome | undefined {
    const open = this.open.get(event.data.compactionId)
    if (open === undefined) return undefined
    this.open.delete(event.data.compactionId)
    if (event.data.error !== undefined) {
      return { kind: 'failed', compactionId: event.data.compactionId, manual: open.manual, error: event.data.error }
    }
    const { summary, landed } = open
    if (summary === undefined || landed === undefined) return undefined
    return {
      kind: 'compacted',
      report: {
        manual: open.manual,
        turn: landed.turn,
        compressed: landed.compressed,
        preserved: landed.preserved,
        summary: summary.text,
        compressedTokens: summary.tokens,
        ...landed.summaryTokens === undefined ? {} : { summaryTokens: landed.summaryTokens },
        model: summary.model,
        summarySeq: summary.seq,
      },
    }
  }

  /**
   * Name one surface event for the account.
   * @param event - a message event that joins the surface.
   * @param turn - the turn it belongs to.
   * @returns its fact.
   */
  private factOf(event: SurfaceEvent, turn: number): SurfaceFact {
    switch (event.type) {
      case 'system/message':
        return { kind: 'system' }
      case 'developer/message':
        return { kind: 'developer', turn }
      case 'user/message': {
        const { source, content } = event.data
        if (isCompactCheckpointSource(source)) return { kind: 'summary', turn }
        if (source.kind === 'user') return { kind: 'prompt', turn, text: firstLine(contentText(content)) }
        return { kind: 'context', turn, title: injectedContextTitle(source) ?? source.kind }
      }
      case 'assistant/message':
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') this.toolNames.set(block.id, block.name)
        }
        return { kind: 'reply', turn }
      case 'tool/result': {
        const { toolCallId } = event.data.message
        return { kind: 'result', turn, tool: this.toolNames.get(toolCallId) ?? 'tool' }
      }
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        return assertNever(event, 'surface event')
    }
  }
}

/**
 * The block title of one landed compaction.
 * @param report - the compaction.
 * @returns e.g. `context compacted by /compact · ~6.4k → ~0.9k tokens`, or
 * `… · ~6.4k tokens into one summary` when the summary is unpriced.
 */
export function compactionTitle(report: CompactionReport): string {
  const origin = report.manual ? 'by /compact' : `automatically in turn ${String(report.turn)}`
  const before = `~${formatTokens(report.compressedTokens)}`
  const change = report.summaryTokens === undefined
    ? `${before} tokens into one summary`
    : `${before} → ~${formatTokens(report.summaryTokens)} tokens`
  return `context compacted ${origin} · ${change}`
}

/**
 * The navigable sections of one landed compaction: what the summary replaced,
 * what the model still reads verbatim, and the summary itself.
 * @param report - the compaction.
 * @returns the `compressed`, `preserved`, and `summary` parts, in that order.
 */
export function compactionParts(report: CompactionReport): SectionPart[] {
  return [
    { kind: 'context', label: 'compressed', rows: compressedRows(report.compressed) },
    { kind: 'context', label: 'preserved', rows: preservedRows(report.preserved) },
    { kind: 'context', label: `summary · ${report.model}`, rows: report.summary === '' ? [''] : report.summary.split('\n') },
  ]
}

/** The count of always-drawn parts {@link compactionParts} leads with. */
export const COMPACTION_ACCOUNT_PARTS = 2

/**
 * The notice a failed `/compact` attempt earns.
 * @param outcome - the failed outcome.
 * @returns e.g. `/compact failed · summary is not smaller than the shadowed content (…)`.
 */
export function compactionFailure(outcome: Extract<CompactionOutcome, { kind: 'failed' }>): string {
  return `/compact failed · ${firstLine(outcome.error)}`
}

/**
 * Rows naming the compressed span: its size and turns, each prompt it held,
 * and a count of everything else.
 * @param facts - the shadowed nodes.
 * @returns the rows.
 */
function compressedRows(facts: readonly SurfaceFact[]): string[] {
  const turns = turnSpan(facts)
  const rows = [`${plural(facts.length, 'item')}${turns === '' ? '' : ` from ${turns}`}`]
  const prompts = facts.flatMap(fact => fact.kind === 'prompt' ? [fact.text] : [])
  for (const text of prompts.slice(0, LISTED_PROMPTS)) rows.push(`❯ ${clip(text)}`)
  if (prompts.length > LISTED_PROMPTS) rows.push(`+${plural(prompts.length - LISTED_PROMPTS, 'more prompt')}`)
  const rest = tally(facts.filter(fact => fact.kind !== 'prompt'))
  if (rest !== '') rows.push(rest)
  return rows
}

/**
 * Rows naming what stays verbatim: the system prompt, then one row per turn.
 * @param facts - the surface nodes other than the checkpoint.
 * @returns the rows.
 */
function preservedRows(facts: readonly SurfaceFact[]): string[] {
  const rows: string[] = []
  if (facts.some(fact => fact.kind === 'system')) rows.push('system prompt')
  const byTurn = new Map<number, SurfaceFact[]>()
  for (const fact of facts) {
    if (fact.kind === 'system') continue
    const group = byTurn.get(fact.turn) ?? []
    group.push(fact)
    byTurn.set(fact.turn, group)
  }
  for (const [turn, group] of byTurn) {
    const prompts = group.flatMap(fact => fact.kind === 'prompt' ? [`❯ ${clip(fact.text)}`] : [])
    const rest = tally(group.filter(fact => fact.kind !== 'prompt'))
    rows.push([`turn ${String(turn)}`, ...prompts, ...rest === '' ? [] : [rest]].join(' · '))
  }
  if (rows.length === 0) rows.push('nothing else: the summary is the whole history')
  return rows
}

/**
 * Count facts other than prompts by kind, naming tools and context blocks.
 * @param facts - facts of any kind but `prompt`.
 * @returns e.g. `2 replies · 3 tool results (read ×2, bash) · 1 context block (instructions · AGENTS.md)`.
 */
function tally(facts: readonly SurfaceFact[]): string {
  const parts: string[] = []
  const count = (kind: SurfaceFact['kind']): number => facts.filter(fact => fact.kind === kind).length
  const replies = count('reply')
  if (replies > 0) parts.push(plural(replies, 'reply', 'replies'))
  const tools = facts.flatMap(fact => fact.kind === 'result' ? [fact.tool] : [])
  if (tools.length > 0) parts.push(`${plural(tools.length, 'tool result')} (${named(tools)})`)
  const contexts = facts.flatMap(fact => fact.kind === 'context' ? [fact.title] : [])
  if (contexts.length > 0) {
    const shown = contexts.slice(0, LISTED_CONTEXTS).join(', ')
    const more = contexts.length > LISTED_CONTEXTS ? `, +${String(contexts.length - LISTED_CONTEXTS)} more` : ''
    parts.push(`${plural(contexts.length, 'context block')} (${shown}${more})`)
  }
  const summaries = count('summary')
  if (summaries > 0) parts.push(plural(summaries, 'earlier summary', 'earlier summaries'))
  const developer = count('developer')
  if (developer > 0) parts.push(plural(developer, 'developer message'))
  return parts.join(' · ')
}

/**
 * Tool names with repeat counts, in first-seen order.
 * @param tools - one name per result.
 * @returns e.g. `read ×2, bash`.
 */
function named(tools: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1)
  return [...counts].map(([tool, times]) => times === 1 ? tool : `${tool} ×${String(times)}`).join(', ')
}

/**
 * The turns a set of facts spans.
 * @param facts - the facts; the system prompt has no turn.
 * @returns `turn 3`, `turns 1–3`, or `''` when none carries a turn.
 */
function turnSpan(facts: readonly SurfaceFact[]): string {
  const turns = facts.flatMap(fact => fact.kind === 'system' ? [] : [fact.turn])
  if (turns.length === 0) return ''
  const first = Math.min(...turns)
  const last = Math.max(...turns)
  return first === last ? `turn ${String(first)}` : `turns ${String(first)}–${String(last)}`
}

/**
 * Cut one plain row to {@link PROMPT_COLUMNS}, ending on `…` when it was cut.
 * Section rows stay unstyled, so this counts columns itself rather than
 * through the renderer's truncation, which closes its ellipsis with styling.
 * @param text - one line of plain text.
 * @returns the line, at most that many columns wide.
 */
function clip(text: string): string {
  if (visibleWidth(text) <= PROMPT_COLUMNS) return text
  let kept = ''
  let width = 0
  for (const char of text) {
    const next = visibleWidth(char)
    if (width + next > PROMPT_COLUMNS - 1) break
    kept += char
    width += next
  }
  return `${kept}…`
}

/**
 * The first nonblank line of a text, read without splitting the rest of it.
 * @param text - any text.
 * @returns that line, trimmed; `''` for a blank text.
 */
function firstLine(text: string): string {
  return /\S.*/u.exec(text)?.[0].trim() ?? ''
}

/**
 * A count and its noun.
 * @param count - how many.
 * @param noun - the singular.
 * @param nouns - the plural, when it is not `noun` + `s`.
 * @returns e.g. `1 item`, `3 items`.
 */
function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${String(count)} ${count === 1 ? noun : nouns}`
}
