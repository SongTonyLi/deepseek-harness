/**
 * The empty-session card that says Agent Teams is on, how to turn it off,
 * and a short collaboration animation.
 *
 * Pure aside from the component's frame counter. The application advances
 * that counter on the spinner tick; reduced motion draws every beat settled.
 * @module @deepseek-ai/dsh-tui-app/team-intro
 */

import type { Component } from '@earendil-works/pi-tui'
import { truncateToWidth } from '@earendil-works/pi-tui'
import type { Palette } from './style.ts'
import {
  PLAY_PHASES,
  SHOWCASE_BEATS,
  TEAM_OFF_COMMAND,
  TEAM_ON_LINE,
  TEAM_PLAY_LINE,
  laneParts,
  type TeamBeat,
} from './team-play.ts'

export { TEAM_OFF_COMMAND, TEAM_ON_LINE, TEAM_PLAY_LINE }

/**
 * Whether `service` is the Agent Teams service this terminal can read.
 * @param service - the value of `ctx.get('agentTeams')`, absent when the bundle is off.
 * @returns true when the value exposes `listMembers`.
 */
export function agentTeamsMounted(service: unknown): boolean {
  return typeof service === 'object' && service !== null && 'listMembers' in service
    && typeof service.listMembers === 'function'
}

/** How the start card is drawn. */
export interface TeamIntroDraw {
  /** The palette the title and the moving lane are styled with. */
  palette: Palette
  /** Spinner frames since the card was mounted; ignored while motion is reduced. */
  frame: number
  /** Columns the card fits. */
  width: number
  /** Draw every showcase beat settled, with the marker at the receiver. */
  reducedMotion: boolean
}

/**
 * The start card's lines.
 * @param draw - the palette, the frame, the width, and whether motion is reduced.
 * @returns one line per row, each fitting `draw.width`.
 */
export function teamIntroLines(draw: TeamIntroDraw): string[] {
  const width = Math.max(draw.width, 1)
  const fit = (line: string): string => truncateToWidth(line, width, '…')
  const palette = draw.palette
  const lines = [
    fit(palette.bold(palette.accent(TEAM_ON_LINE))),
    fit(palette.dim('Turn it off, then start dsh tui again:')),
    fit(palette.warning(TEAM_OFF_COMMAND)),
    fit(palette.dim(TEAM_PLAY_LINE)),
    '',
  ]
  const playing = SHOWCASE_BEATS[Math.floor(draw.frame / PLAY_PHASES) % SHOWCASE_BEATS.length] ?? SHOWCASE_BEATS[0]
  const beats = draw.reducedMotion || playing === undefined ? SHOWCASE_BEATS : [playing]
  for (const beat of beats) {
    const phase = draw.reducedMotion ? PLAY_PHASES - 1 : draw.frame % PLAY_PHASES
    lines.push(fit(paintLane(palette, beat, phase)))
    lines.push(fit(palette.dim(`  ${beat.text}`)))
  }
  return lines
}

/**
 * One collaboration lane with the sender and receiver colored.
 * @param palette - the palette the names are styled with.
 * @param beat - the exchange the lane shows.
 * @param phase - the marker's step, 0 at the sender through 7 at the receiver.
 * @returns the lane.
 */
function paintLane(palette: Palette, beat: TeamBeat, phase: number): string {
  const parts = laneParts(beat.from, beat.to, phase)
  return `${palette.accent(parts.from)}${palette.dim(parts.track)}${palette.success(parts.to)}`
}

/**
 * The start card mounted in an empty root transcript while Agent Teams is on.
 */
export class TeamIntro implements Component {
  private frame = 0

  /**
   * @param palette - the palette the card is styled with.
   * @param reducedMotion - draw the storyboard settled instead of stepping it.
   */
  constructor(
    private readonly palette: Palette,
    private readonly reducedMotion: boolean,
  ) {}

  /** Step the showcase to its next frame. A reduced-motion card stays settled. */
  advance(): void {
    if (!this.reducedMotion) this.frame += 1
  }

  invalidate(): void {}

  /**
   * Draw the card.
   * @param width - the columns the card fits.
   * @returns the card's lines.
   */
  render(width: number): string[] {
    return teamIntroLines({
      palette: this.palette,
      frame: this.frame,
      width,
      reducedMotion: this.reducedMotion,
    })
  }
}
