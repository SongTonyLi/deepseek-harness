/**
 * Chrome motion: the brief lift a docked surface draws when the keyboard
 * lands on it or the mark it holds moves.
 *
 * Pure. A motion is a clock plus a three-level intensity ramp, so nothing
 * here queries a terminal, builds a color, or arms a timer: the application
 * reads {@link Motion.level} and {@link Motion.progress} while it renders and
 * drops the motion once it settles. Every motion is a {@link RegisteredFade},
 * so it rides the one fade tick the application already arms for streamed
 * text and disarms with it - an idle session runs no timer for motion.
 *
 * Two rules hold for every call site. A motion changes what a line is drawn
 * with, never how many lines a docked component returns, because each docked
 * row raises the renderer's repaint boundary for good (`./screen.ts`). And a
 * settled motion draws exactly what the surface draws at rest, so a terminal
 * that runs no motion at all - reduced motion, a disabled palette, no color -
 * loses nothing but the lift.
 * @module @deepseek-ai/dsh-tui-app/motion
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { RegisteredFade } from './fade.ts'
import type { Palette } from './style.ts'

/** Ticks the keyboard landing on a docked region lasts. */
export const LANDING_TICKS = 12

/** Ticks one step of the transcript walk lasts. */
export const STEP_TICKS = 6

/** Ticks one step of the status bar's own walk lasts. */
export const SEGMENT_TICKS = 8

/** Share of a motion drawn at its peak. */
const PEAK_SHARE = 1 / 3

/** Share of a motion drawn lifted, the peak included. */
const LIFTED_SHARE = 2 / 3

/**
 * How far above its settled drawing one surface is right now: `2` at the
 * peak, `1` on the way back, `0` once the motion settled. Three levels need
 * no ramp and no background query, so they reach a 16-color terminal.
 */
export type MotionLevel = 0 | 1 | 2

/** What one {@link Motion} is built with. */
export interface MotionOptions {
  /** Wall-clock time the motion started, in milliseconds. */
  startedAt: number
  /** How many tick periods the whole motion lasts; at least 1. */
  ticks: number
  /** How long one tick period lasts, in milliseconds. */
  stepMs: number
  /**
   * The wall clock the elapsed time is measured against.
   * @returns the current time in milliseconds.
   */
  now: () => number
}

/**
 * One chrome motion: how far through it the clock is, and how far above its
 * settled drawing the surface it belongs to is drawn right now.
 */
export class Motion implements RegisteredFade {
  /** @param options - the start, the length, the period, and the clock. */
  constructor(private readonly options: MotionOptions) {}

  /**
   * How far through the motion the clock is.
   * @returns a fraction from 0 at the start to 1 once it has run its ticks;
   * 1 at once for a motion with no length at all.
   */
  progress(): number {
    const { startedAt, ticks, stepMs, now } = this.options
    const span = ticks * stepMs
    if (span <= 0) return 1
    return Math.min(1, Math.max(0, (now() - startedAt) / span))
  }

  /**
   * How far above its settled drawing the surface is right now.
   * @returns the peak for the first third of the motion, the lifted level for
   * the second, and the settled level for the rest.
   */
  level(): MotionLevel {
    const progress = this.progress()
    if (progress < PEAK_SHARE) return 2
    if (progress < LIFTED_SHARE) return 1
    return 0
  }

  /**
   * Whether the motion still needs another repaint.
   * @returns true until it has run its ticks; the last periods draw the
   * settled level, which is what a reveal still grows through.
   */
  needsRepaint(): boolean {
    return this.progress() < 1
  }
}

/**
 * Lift one piece of chrome by a motion level.
 * @param palette - the palette the lift is drawn with.
 * @param text - the surface's own settled drawing of that piece, styling
 * included; the settled level hands it straight back.
 * @param level - how far above that drawing to lift it.
 * @returns the text at the peak, lifted, or exactly as it settles.
 */
export function pulse(palette: Palette, text: string, level: MotionLevel): string {
  switch (level) {
    case 2:
      return palette.bold(palette.accent(text))
    case 1:
      return palette.accent(text)
    case 0:
      return text
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(level, 'tui motion level')
  }
}
