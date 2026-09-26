/**
 * Working indicators: the braille frames a running tool card, a folded
 * subagent row, and an in-progress todo cycle through in place of their static
 * glyph, and the shimmer the working spinner's activity word carries.
 *
 * Pure. Both read a wall-clock instant the caller passes in, so every surface
 * drawing at the same moment draws the same frame, and the application owns
 * the tick that redraws them.
 * @module @deepseek-ai/dsh-tui-app/spinner
 */

import type { Palette } from './style.ts'

/**
 * The frames a running glyph cycles through: the braille frames pi-tui's
 * working spinner draws, each one column wide like the glyph it replaces.
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** How long one spinner frame or shimmer step is drawn, in milliseconds; pi-tui's working spinner period. */
export const SPINNER_MS = 80

/** Blank steps between two shimmer passes, so the sweep pauses past the word's end. */
const SHIMMER_GAP = 6

/**
 * The spinner frame drawn at one instant.
 * @param now - the current time in milliseconds.
 * @returns one frame of {@link SPINNER_FRAMES}.
 */
export function spinnerFrame(now: number): string {
  const index = Math.floor(now / SPINNER_MS) % SPINNER_FRAMES.length
  /* v8 ignore next -- the modulo keeps the index inside the frame list */
  return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0]
}

/**
 * Draw `text` dim with a bright highlight sweeping across it, one character
 * per {@link SPINNER_MS}: the character under the sweep is bold, its
 * neighbours are drawn at the plain foreground, and the sweep rests for
 * {@link SHIMMER_GAP} steps past the end before starting again.
 * @param palette - the palette the sweep is drawn with; a disabled palette returns `text` unchanged.
 * @param text - the plain text to draw.
 * @param now - the current time in milliseconds.
 * @returns the styled text, the same visible width as `text`.
 */
export function shimmer(palette: Palette, text: string, now: number): string {
  const chars = Array.from(new Intl.Segmenter().segment(text), part => part.segment)
  const at = Math.floor(now / SPINNER_MS) % (chars.length + SHIMMER_GAP)
  const tone = (index: number): 'bright' | 'plain' | 'dim' => {
    const distance = Math.abs(index - at)
    return distance === 0 ? 'bright' : distance === 1 ? 'plain' : 'dim'
  }
  let out = ''
  let run = ''
  let current: ReturnType<typeof tone> | undefined
  const flush = (): void => {
    if (current === undefined || run === '') return
    out += current === 'bright' ? palette.bold(run) : current === 'plain' ? run : palette.dim(run)
    run = ''
  }
  for (const [index, char] of chars.entries()) {
    const next = tone(index)
    if (next !== current) {
      flush()
      current = next
    }
    run += char
  }
  flush()
  return out
}
