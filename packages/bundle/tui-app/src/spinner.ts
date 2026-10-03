/**
 * Working indicators: a braille status glyph and a shimmer on the activity
 * line above the prompt, and a blooming star on running tool cards, folded
 * subagent rows, and the activity board's in-progress todo rows.
 *
 * Pure. Every animation has {@link SPINNER_CYCLE} frames, and a frame lookup
 * reads a wall-clock instant and a frame period the caller passes in, so
 * every surface drawn at the same moment steps at the same instant and the
 * application owns the one tick that redraws them. Only the activity line
 * draws braille, so its glyph never repeats a card's; star indicators spin at
 * different phases ({@link staggerPhase}).
 * @module @deepseek-ai/dsh-tui-app/spinner
 */

import type { Palette } from './style.ts'

/**
 * One working animation: eight frames, each one column wide like the glyph
 * it replaces, and every two adjacent frames, the last and the first
 * included, different.
 */
export type SpinnerFrames = readonly [string, string, string, string, string, string, string, string]

/** Frames in every working animation; one cycle lasts this many frame periods. */
export const SPINNER_CYCLE: SpinnerFrames['length'] = 8

/**
 * The activity line's animation for each working status. Every glyph is
 * braille and no card or todo row draws braille. A presentation choice of
 * this terminal surface, not a deployment setting.
 */
export const ACTIVITY_SPINNERS = {
  /** Model reasoning, and any label with no status of its own: three dots circling the cell. */
  thinking: ['⠙', '⠸', '⢰', '⣠', '⣄', '⡆', '⠇', '⠋'],
  /** Visible reply text streaming in: lines filling the cell, then streaming up out of it. */
  writing: ['⠉', '⠛', '⠿', '⣿', '⣶', '⣤', '⣀', '⣉'],
  /** A tool call streamed or running, whichever tool it names: one dot orbiting the cell. */
  calling: ['⠁', '⠈', '⠐', '⠠', '⢀', '⡀', '⠄', '⠂'],
  /** A scheduled model-request retry: a bar sliding down the cell and back. */
  retrying: ['⠉', '⠛', '⠶', '⣤', '⣀', '⣤', '⠶', '⠛'],
  /** Condensing older history into a summary: a full cell settling and refilling. */
  compacting: ['⣿', '⣷', '⣶', '⣦', '⣤', '⣦', '⣶', '⣷'],
} as const satisfies Record<string, SpinnerFrames>

/** One status of the activity line, named by what the agent is doing. */
export type ActivityStatus = keyof typeof ACTIVITY_SPINNERS

/**
 * The animation every running tool card, folded subagent row, and in-progress
 * todo row draws, whatever the tool: a star blooming from a thin four-pointed
 * outline to a full asterisk. No frame is braille and no two frames match, so
 * two indicators at different phases never draw the same glyph at the same
 * instant. A presentation choice of this terminal surface, not a deployment
 * setting.
 */
export const TOOL_SPINNER = ['✧', '✦', '✶', '✷', '✸', '✹', '✺', '✻'] as const satisfies SpinnerFrames

/** Blank steps between two shimmer passes, so the sweep pauses past the word's end. */
const SHIMMER_GAP = 6

/** The activity line's label while a compaction condenses history. */
export const COMPACTING_ACTIVITY = 'compacting'

/**
 * The activity line's label for a streamed or executing tool call.
 * @param name - the tool name when one is known.
 * @returns `calling <name>`, or `calling` when the name has not arrived.
 */
export function callingActivity(name: string | undefined): string {
  return name ? `calling ${name}` : 'calling'
}

/**
 * Whether the activity line already names a tool call.
 * @param activity - the activity line's current label.
 * @returns true for `calling` and `calling <name>`.
 */
export function isCallingActivity(activity: string): boolean {
  return activity === 'calling' || activity.startsWith('calling ')
}

/**
 * The status the activity line animates for its label.
 * @param activity - the label: `thinking`, `writing`, `calling` or
 * `calling <name>`, a scheduled retry starting with `retrying`, or
 * {@link COMPACTING_ACTIVITY}.
 * @returns the label's status; `calling` whichever tool the label names, and
 * `thinking` for any other label.
 */
export function activityStatus(activity: string): ActivityStatus {
  if (activity === 'writing') return 'writing'
  if (isCallingActivity(activity)) return 'calling'
  if (activity.startsWith('retrying')) return 'retrying'
  if (activity === COMPACTING_ACTIVITY) return 'compacting'
  return 'thinking'
}

/**
 * The frame an indicator draws at one instant. The frame index advances
 * once per `periodMs` of wall clock, so indicators drawn at the same instant
 * step together, and a change of animation keeps the beat.
 * @param frames - the animation drawn.
 * @param now - the current time in milliseconds.
 * @param periodMs - how long each frame lasts, in milliseconds; positive.
 * @param phase - how many frames the indicator runs ahead of the clock, from 0 to {@link SPINNER_CYCLE} - 1.
 * @returns the frame at that instant.
 */
export function spinnerFrame(frames: SpinnerFrames, now: number, periodMs: number, phase = 0): string {
  const index = (Math.floor(now / periodMs) + phase) % SPINNER_CYCLE
  /* v8 ignore next -- the modulo keeps the index inside the frame list */
  return frames[index] ?? frames[0]
}

/**
 * The phase a new {@link TOOL_SPINNER} indicator spins at beside the
 * indicators already spinning. No two frames of that animation match, so two
 * indicators at different phases never draw the same glyph at the same
 * instant. A phase no indicator holds is taken, the one farthest from its
 * nearest neighbour first and the lowest on a tie; once every phase is held,
 * the lowest phase held by the fewest indicators.
 * @param taken - the phases of the indicators spinning now, one per indicator.
 * @returns a phase from 0 to {@link SPINNER_CYCLE} - 1.
 */
export function staggerPhase(taken: readonly number[]): number {
  let best = 0
  let fewest = Number.POSITIVE_INFINITY
  let widest = -1
  for (let phase = 0; phase < SPINNER_CYCLE; phase += 1) {
    let holders = 0
    let gap: number = SPINNER_CYCLE
    for (const other of taken) {
      if (other === phase) holders += 1
      const distance = Math.abs(phase - other)
      gap = Math.min(gap, distance, SPINNER_CYCLE - distance)
    }
    if (holders < fewest || (holders === fewest && gap > widest)) {
      best = phase
      fewest = holders
      widest = gap
    }
  }
  return best
}

/**
 * Draw `text` dim with a bright highlight sweeping across it, one character
 * per `periodMs`: the character under the sweep is bold, its neighbours are
 * drawn at the plain foreground, and the sweep rests for {@link SHIMMER_GAP}
 * steps past the end before starting again.
 * @param palette - the palette the sweep is drawn with; a disabled palette returns `text` unchanged.
 * @param text - the plain text to draw.
 * @param now - the current time in milliseconds.
 * @param periodMs - how long the sweep rests on each character, in milliseconds; positive.
 * @returns the styled text, the same visible width as `text`.
 */
export function shimmer(palette: Palette, text: string, now: number, periodMs: number): string {
  const chars = Array.from(new Intl.Segmenter().segment(text), part => part.segment)
  const at = Math.floor(now / periodMs) % (chars.length + SHIMMER_GAP)
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
