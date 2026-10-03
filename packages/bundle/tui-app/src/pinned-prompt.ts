/**
 * The prompt row the reader pins in place of its top rule once the turn
 * panel scrolls past its first row: the prompt glyph and the prompt collapsed
 * to one line. The conversation's own prompt rows stay where they were drawn.
 * @module @deepseek-ai/dsh-tui-app/pinned-prompt
 */

import { truncateToWidth } from '@earendil-works/pi-tui'
import { bandRow, type Palette } from './style.ts'

/**
 * Opens a prompt wherever one is named outside the conversation's own band:
 * the reader's pinned row, its prompt band, and its list row for the turn
 * being read, as it opens a prompt in the conversation.
 */
export const PROMPT_GLYPH = '❯'

/** What ends a row the width cut short; one column, so the mark itself fits. */
const ELLIPSIS = '…'

/**
 * One prompt as a single row: the prompt glyph, then the prompt's rows joined
 * with every run of whitespace collapsed to one space, cut to `width` with an
 * ellipsis, on the prompt band.
 * @param palette - the palette the band is drawn with.
 * @param rows - the prompt's source rows.
 * @param width - the columns the row spans.
 * @returns the row: exactly `width` columns under the band on an enabled
 * palette, and the unpadded text, no wider than `width`, on a disabled one.
 */
export function pinnedPromptRow(palette: Palette, rows: readonly string[], width: number): string {
  const text = rows.join(' ').replaceAll(/\s+/gu, ' ').trim()
  return bandRow(palette, truncateToWidth(` ${PROMPT_GLYPH} ${text} `, width, ELLIPSIS), width)
}
