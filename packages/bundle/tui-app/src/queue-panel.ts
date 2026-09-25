/**
 * The follow-up panel above the editor. It presents the Agent inbox as a
 * boxed pending-prompt list without mutating the messages it displays.
 * @module @deepseek-ai/dsh-tui-app/queue-panel
 */

import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { InboxTarget } from '@deepseek-ai/dsh-agent'
import { BODY_MARGIN, bodyLine, bottomRule, fitLegend, topRule, type FrameTone } from './frame.ts'
import { HINTS, QUEUE_ENTRY_HINT } from './keys.ts'
import type { Palette } from './style.ts'
import { contentText } from './transcript.ts'

/** One pending prompt and the inbox boundary where it waits. */
export interface QueuePanelRow {
  /** Pending message acted on by the selected-row commands. */
  message: UserMessage
  /** Whether the message waits for another turn or the current turn's next step. */
  target: InboxTarget
  /** First text line shown in the compact panel. */
  text: string
}

/** Settings for one queue-panel draw. */
export interface QueuePanelRender {
  /** The active terminal palette. */
  palette: Palette
  /** Terminal columns available to the panel. */
  width: number
  /** Selected row while the panel owns the keyboard; absent while unfocused. */
  selected?: number
}

/**
 * The first content line a row shows.
 * @param content - the message's full text.
 * @returns the text before the first newline, or all of `content` when it is one line.
 */
function firstLine(content: string): string {
  const breakAt = content.indexOf('\n')
  return breakAt === -1 ? content : content.slice(0, breakAt)
}

/** Pending-row marker; the same glyph the todo list uses for an unstarted item. */
const FOLLOW_UP_GLYPH = '○'

/** Columns the glyph and its trailing space occupy on the first wrapped line. */
const FOLLOW_UP_PREFIX = `${FOLLOW_UP_GLYPH} `

/** Indent that lines up wrapped follow-up text under the first line's content. */
const FOLLOW_UP_INDENT = '  '

/**
 * Build the panel rows in claim order: next-step input before ordinary turns.
 * Messages whose source is not `user` are omitted: a `!` notice waiting for
 * the next prompt is context, not a prompt the keyboard can steer or edit.
 * @param nextStep - messages waiting for the nearest step boundary.
 * @param nextTurn - messages waiting for separate turns.
 * @returns selectable pending-prompt rows.
 */
export function queuePanelRows(nextStep: readonly UserMessage[], nextTurn: readonly UserMessage[]): QueuePanelRow[] {
  const row = (target: InboxTarget, message: UserMessage): QueuePanelRow => ({
    message,
    target,
    text: firstLine(contentText(message.content)),
  })
  const pending = (target: InboxTarget, messages: readonly UserMessage[]): QueuePanelRow[] => messages
    .filter(message => message.source.kind === 'user')
    .map(message => row(target, message))
  return [...pending('next-step', nextStep), ...pending('next-turn', nextTurn)]
}

/**
 * One follow-up's text wrapped under the pending glyph, hanging the
 * continuation so it lines up with the first line's content.
 * @param text - the row's first content line.
 * @param room - columns inside the frame.
 * @param glyph - the pending marker, already styled.
 * @returns one or more body contents, never wider than `room`.
 */
function followUpLines(text: string, room: number, glyph: string): string[] {
  const inner = Math.max(1, room - visibleWidth(FOLLOW_UP_PREFIX))
  return wrapTextWithAnsi(text, inner).map((line, index) => (
    index === 0 ? `${glyph} ${line}` : `${FOLLOW_UP_INDENT}${line}`
  ))
}

/**
 * Render the pending prompts as a boxed follow-ups list. A focused panel
 * accents its held row and names enter, select/edit, and cancel; an unfocused
 * panel names the key that enters it.
 * @param rows - pending prompts in claim order.
 * @param render - palette, terminal width, and optional selection.
 * @returns panel text, or the empty string when no prompt waits.
 */
export function renderQueuePanel(rows: readonly QueuePanelRow[], render: QueuePanelRender): string {
  if (rows.length === 0) return ''
  const { palette, selected } = render
  const width = Math.max(1, render.width)
  const tone: FrameTone = selected === undefined ? 'muted' : 'focus'
  const heading = tone === 'focus' ? palette.accent('follow-ups') : palette.dim('follow-ups')
  const lines = [heading, topRule({ width, palette, tone })]
  const room = Math.max(1, width - BODY_MARGIN)
  for (const [index, row] of rows.entries()) {
    const glyph = selected === index ? palette.accent(FOLLOW_UP_GLYPH) : FOLLOW_UP_GLYPH
    for (const content of followUpLines(row.text, room, glyph)) {
      lines.push(bodyLine(content, width, palette, tone))
    }
  }
  const hints = selected === undefined ? [QUEUE_ENTRY_HINT] : HINTS.queue
  lines.push(bodyLine(palette.dim(fitLegend(hints, room)), width, palette, tone))
  lines.push(bottomRule({ width, palette, tone }))
  return lines.join('\n')
}
