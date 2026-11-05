/**
 * The empty-session card that says Agent Teams is on: a lead branching to
 * three teammates beside the feature name, what the team does, and the
 * commands that show it or turn it off.
 *
 * The card plays an entrance once it is mounted, measured in spinner periods
 * from that instant: the lead brightens, the trunk grows, each branch arrives
 * with a slot spinning the delegation animation at its own phase and its text
 * row fading in, and the slots land on the teammate glyph one step apart. The
 * entrance never changes how many lines the card returns, and its last frame
 * is the settled card. A card built without an entrance draws the settled
 * card from the first render.
 * @module @deepseek-ai/dsh-tui-app/team-intro
 */

import type { Component } from '@earendil-works/pi-tui'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { fadedLine, type BlockFade } from './blocks.ts'
import { BlockFadeClock, type FadeStyle, type RegisteredFade } from './fade.ts'
import { TOOL_SPINNERS, spinnerFrame } from './spinner.ts'
import type { Palette } from './style.ts'

/** The card's title: the feature's name. */
export const TEAM_INTRO_TITLE = 'Agent Teams'

/** What the lead and its teammates do, in one sentence. */
export const TEAM_INTRO_SENTENCE = 'The lead splits the work; each teammate takes one role.'

/** The commands the card names before the off command, with what each shows. */
export const TEAM_INTRO_COMMANDS: readonly (readonly [command: string, summary: string])[] = [
  ['/team-play', 'live room'],
  ['/team', 'roster and tasks'],
]

/** The command that turns Agent Teams off for the session, last on the card's command row. */
export const TEAM_OFF_COMMAND = '/team off'

/**
 * The entrance step at which the last slot lands; from this step on the
 * figure is the settled one. A presentation choice of this terminal surface,
 * not a deployment setting.
 */
export const TEAM_INTRO_LAST_STEP = 8

/** The lead's glyph. */
const LEAD = '◆'

/** A teammate's glyph once its slot has landed. */
const TEAMMATE = '●'

/** Columns the figure column takes, so the text rows line up. */
const FIGURE_COLUMNS = 10

/** The narrowest width that still draws the figure beside the text. */
const MIN_FIGURE_WIDTH = 40

/** The rows the card draws, one teammate slot each. */
const ROW_COUNT = 3

/** One row of the card. */
interface CardRow {
  /** The row's text, styled. */
  text: string
  /** The branch from the trunk to the row's slot; the first row's starts at the lead. */
  branch: string
  /** The phase the row's slot spins at, so no two slots draw the same frame at one instant. */
  phase: number
}

/** The step the trunk starts growing at. */
const TRUNK_STEP = 1

/** The step row 0's branch, slot, and text arrive at; each later row arrives one step after the row above it. */
const FIRST_ROW_STEP = 2

/** How many steps a slot spins before it lands. */
const SPIN_STEPS = 4

/**
 * Whether `service` is the Agent Teams service this terminal can read.
 * @param service - the value of `ctx.get('agentTeams')`, absent when the bundle is off.
 * @returns true when the value exposes `isEnabled`.
 */
export function agentTeamsMounted(service: unknown): boolean {
  return typeof service === 'object' && service !== null && 'isEnabled' in service
    && typeof service.isEnabled === 'function'
}

/** One instant of the entrance. */
export interface TeamIntroFrame {
  /** Wall-clock time the entrance started, in milliseconds. */
  startedAt: number
  /** The wall-clock instant drawn, in milliseconds. */
  now: number
  /** How long one entrance step and one spinner frame last, in milliseconds; positive. */
  spinnerMs: number
  /** Each text row's fade by row index; a row without one draws in its own colors. */
  fades?: readonly (BlockFade | undefined)[]
}

/** How the card is drawn. */
export interface TeamIntroDraw {
  /** The palette the figure, the title, and the commands are styled with. */
  palette: Palette
  /** Columns the card fits. */
  width: number
  /** The entrance instant to draw; absent draws the settled card. */
  frame?: TeamIntroFrame | undefined
}

/**
 * The card's lines.
 * @param draw - the palette, the width, and the entrance instant, if any.
 * @returns three lines, each fitting `draw.width`; a row the entrance has not
 * reached yet is empty.
 */
export function teamIntroLines(draw: TeamIntroDraw): string[] {
  const { palette, frame } = draw
  const width = Math.max(draw.width, 1)
  const figured = width >= MIN_FIGURE_WIDTH
  const step = frame === undefined ? TEAM_INTRO_LAST_STEP : Math.floor((frame.now - frame.startedAt) / frame.spinnerMs)
  const rows: readonly CardRow[] = [
    { text: palette.bold(palette.accent(TEAM_INTRO_TITLE)), branch: '─┬─', phase: 0 },
    { text: TEAM_INTRO_SENTENCE, branch: '├─', phase: 3 },
    { text: commandRow(palette), branch: '└─', phase: 6 },
  ]
  return rows.map((shape, row) => {
    const arrived = step >= FIRST_ROW_STEP + row
    const shown = arrived ? fadedLine(truncateToWidth(shape.text, figured ? width - FIGURE_COLUMNS : width, '…'), frame?.fades?.[row]) : ''
    if (!figured) return shown
    const figure = figureRow(palette, shape, row, step, frame)
    if (shown === '') return figure
    return `${figure}${' '.repeat(FIGURE_COLUMNS - visibleWidth(figure))}${shown}`
  })
}

/**
 * One row of the figure at one entrance step.
 * @param palette - the palette the figure is styled with.
 * @param shape - the row's branch and slot phase.
 * @param row - the row index: 0 holds the lead and the trunk.
 * @param step - spinner periods since the entrance started; the last step and later draw the settled row.
 * @param frame - the entrance instant whose clock the spinning slots read; absent draws landed slots.
 * @returns the figure cells of that row, without trailing padding.
 */
function figureRow(palette: Palette, shape: CardRow, row: number, step: number, frame: TeamIntroFrame | undefined): string {
  const arrives = FIRST_ROW_STEP + row
  const slot = step >= arrives + SPIN_STEPS || frame === undefined
    ? palette.accent(TEAMMATE)
    : palette.warning(spinnerFrame(TOOL_SPINNERS.subagent, frame.now, frame.spinnerMs, shape.phase))
  if (row > 0) return step >= arrives ? `   ${palette.dim(shape.branch)} ${slot}` : ''
  const lead = step <= 0 ? palette.dim(LEAD) : step === TRUNK_STEP ? palette.accent(LEAD) : palette.bold(palette.accent(LEAD))
  if (step < TRUNK_STEP) return lead
  if (step < arrives) return `${lead} ${palette.dim('─┬')}`
  return `${lead} ${palette.dim(shape.branch)} ${slot}`
}

/**
 * The command row: each command with its summary, then the off command.
 * @param palette - the palette the commands are styled with.
 * @returns the row, separators and the off command dim.
 */
function commandRow(palette: Palette): string {
  const separator = palette.dim(' · ')
  const commands = TEAM_INTRO_COMMANDS.map(([command, summary]) => `${palette.accent(command)} ${palette.dim(summary)}`)
  return [...commands, palette.dim(TEAM_OFF_COMMAND)].join(separator)
}

/** What one card's entrance is timed and faded with. */
export interface TeamIntroEntrance {
  /** Wall-clock time the card was mounted, in milliseconds. */
  startedAt: number
  /** How long one entrance step and one spinner frame last, in milliseconds; positive. */
  spinnerMs: number
  /** How long one fade level of a text row lasts, in milliseconds. */
  fadeStepMs: number
  /** How many fade levels a text row climbs. */
  fadeSteps: number
  /**
   * The wall clock the entrance is measured against.
   * @returns the current time in milliseconds.
   */
  now: () => number
  /**
   * The fade settings, read per render because the terminal background query settles after the card may have mounted.
   * @returns the capability and the ramp the text rows fade along.
   */
  style: () => FadeStyle
}

/** The entrance a card is still playing. */
interface Playing {
  /** The timing and the fade settings. */
  entrance: TeamIntroEntrance
  /** Each text row's fade, born at the step the row arrives. */
  fades: readonly BlockFade[]
}

/**
 * The start card mounted in an empty root transcript while Agent Teams is
 * on. It is a {@link RegisteredFade}, so the application's fade tick
 * repaints it until the entrance settles.
 */
export class TeamIntro implements Component, RegisteredFade {
  private playing: Playing | undefined

  /**
   * @param palette - the palette the card is styled with.
   * @param entrance - the timing of the entrance to play; absent draws the settled card from the first render.
   */
  constructor(private readonly palette: Palette, entrance?: TeamIntroEntrance) {
    this.playing = entrance === undefined ? undefined : {
      entrance,
      fades: Array.from({ length: ROW_COUNT }, (_, row) => {
        const clock = new BlockFadeClock({
          bornAt: entrance.startedAt + (FIRST_ROW_STEP + row) * entrance.spinnerMs,
          stepMs: entrance.fadeStepMs,
          steps: entrance.fadeSteps,
          now: entrance.now,
        })
        return { age: () => clock.age(), style: entrance.style }
      }),
    }
  }

  invalidate(): void {}

  /**
   * Draw the card at the entrance instant the clock reads now.
   * @param width - the columns the card fits.
   * @returns the card's three lines.
   */
  render(width: number): string[] {
    return teamIntroLines({ palette: this.palette, width, frame: this.frame() })
  }

  /**
   * Whether the entrance still differs from the settled card.
   * @returns true until the last slot landed and every text row's fade settled.
   */
  needsRepaint(): boolean {
    return this.frame() !== undefined
  }

  /**
   * Settle the entrance when the renderer can no longer repaint the card's
   * first line, so no line above the repaint window changes.
   * @param floor - how many of the card's lines sit above the repaint window.
   * @returns true when this call settled a playing entrance, so the frame is built again.
   */
  setRepaintFloor(floor: number): boolean {
    if (floor === 0 || this.playing === undefined) return false
    this.settle()
    return true
  }

  /** Stop the entrance; every later render draws the settled card. */
  settle(): void {
    this.playing = undefined
  }

  /**
   * The entrance instant to draw, settling the entrance once it has run.
   * @returns the instant, or undefined once the card draws settled.
   */
  private frame(): TeamIntroFrame | undefined {
    const playing = this.playing
    if (playing === undefined) return undefined
    const { entrance, fades } = playing
    const now = entrance.now()
    if (now - entrance.startedAt >= TEAM_INTRO_LAST_STEP * entrance.spinnerMs && fades.every(fade => fade.age() === undefined)) {
      this.settle()
      return undefined
    }
    return { startedAt: entrance.startedAt, now, spinnerMs: entrance.spinnerMs, fades }
  }
}
