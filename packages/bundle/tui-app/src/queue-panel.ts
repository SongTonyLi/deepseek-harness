/**
 * The pending-prompt panel above the editor. It presents the Agent inbox as a
 * framed, selectable list without mutating the messages it displays.
 * @module @deepseek-ai/dsh-tui-app/queue-panel
 */

import { wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { InboxTarget } from '@deepseek-ai/dsh-agent'
import { bodyLine, bottomRule, chip, fitLegend, ruleRoom, topRule, type FrameTone } from './frame.ts'
import { HINTS } from './keys.ts'
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
 * Build the panel rows in claim order: next-step input before ordinary turns.
 * @param nextStep - messages waiting for the nearest step boundary.
 * @param nextTurn - messages waiting for separate turns.
 * @returns selectable pending-prompt rows.
 */
export function queuePanelRows(nextStep: readonly UserMessage[], nextTurn: readonly UserMessage[]): QueuePanelRow[] {
  const row = (target: InboxTarget, message: UserMessage): QueuePanelRow => ({
    message,
    target,
    text: contentText(message.content).split('\n', 1)[0] ?? '',
  })
  return [
    ...nextStep.map(message => row('next-step', message)),
    ...nextTurn.map(message => row('next-turn', message)),
  ]
}

/**
 * Render the pending prompts inside a frame. A focused panel accents its held
 * row and names its actions; an unfocused panel names the key that enters it.
 * @param rows - pending prompts in claim order.
 * @param render - palette, terminal width, and optional selection.
 * @returns panel text, or the empty string when no prompt waits.
 */
export function renderQueuePanel(rows: readonly QueuePanelRow[], render: QueuePanelRender): string {
  if (rows.length === 0) return ''
  const { palette, selected } = render
  const width = Math.max(1, render.width)
  const tone: FrameTone = selected === undefined ? 'muted' : 'focus'
  const title = `${String(rows.length)} pending`
  const lines = [topRule({ chip: chip(palette, 'QUEUE'), title: palette.bold(title), width, palette, tone })]
  const room = Math.max(1, width - 2)
  for (const [index, row] of rows.entries()) {
    const label = row.target === 'next-step' ? 'next step' : 'next turn'
    const marker = selected === index ? palette.accent('▸ ') : '  '
    const text = `${marker}${palette.dim(`${label} ·`)} ${row.text}`
    for (const wrapped of wrapTextWithAnsi(text, room)) lines.push(bodyLine(wrapped, width, palette, tone))
  }
  const hints = selected === undefined ? ['Shift+↓ manages'] : HINTS.queue
  lines.push(bottomRule({ left: palette.dim(fitLegend(hints, ruleRoom(width))), width, palette, tone }))
  return lines.join('\n')
}
