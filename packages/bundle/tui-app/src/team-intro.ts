/**
 * The empty-session card that says Agent Teams is on, what it does, which
 * commands show the team, and how to turn it off.
 *
 * Static text: the card draws the same lines at every frame, so it needs no
 * spinner tick and has no reduced-motion variant.
 * @module @deepseek-ai/dsh-tui-app/team-intro
 */

import type { Component } from '@earendil-works/pi-tui'
import { truncateToWidth } from '@earendil-works/pi-tui'
import type { Palette } from './style.ts'

/** What the start card and the header call the feature. */
export const TEAM_ON_LINE = 'Agent Teams is on'

/** What the lead and its teammates do, in one sentence. */
export const TEAM_EXPLAIN_LINE = 'The lead plans the work and delegates independent subtasks to teammates, each with one role.'

/** Disable command printed on the start card. */
export const TEAM_OFF_COMMAND = '/plugins disable @deepseek-ai/dsh-experimental-agent-team-profile'

/** What the start card says about turning the feature off. */
export const TEAM_OFF_LINE = 'Turn it off, then start dsh tui again:'

/** The commands the start card names, with what each shows. */
export const TEAM_COMMAND_LINES: readonly (readonly [command: string, summary: string])[] = [
  ['/team-play', 'live team room: roles, current work, tasks, and messages'],
  ['/team', 'roster and shared task board'],
]

/** Columns the command column takes, so the summaries line up. */
const COMMAND_COLUMNS = 13

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
  /** The palette the title and the commands are styled with. */
  palette: Palette
  /** Columns the card fits. */
  width: number
}

/**
 * The start card's lines.
 * @param draw - the palette and the width.
 * @returns one line per row, each fitting `draw.width`.
 */
export function teamIntroLines(draw: TeamIntroDraw): string[] {
  const width = Math.max(draw.width, 1)
  const fit = (line: string): string => truncateToWidth(line, width, '…')
  const palette = draw.palette
  return [
    fit(palette.bold(palette.accent(TEAM_ON_LINE))),
    fit(TEAM_EXPLAIN_LINE),
    ...TEAM_COMMAND_LINES.map(([command, summary]) =>
      fit(`${palette.accent(command.padEnd(COMMAND_COLUMNS))}${palette.dim(summary)}`)),
    fit(palette.dim(TEAM_OFF_LINE)),
    fit(palette.warning(TEAM_OFF_COMMAND)),
  ]
}

/**
 * The start card mounted in an empty root transcript while Agent Teams is on.
 */
export class TeamIntro implements Component {
  /**
   * @param palette - the palette the card is styled with.
   */
  constructor(private readonly palette: Palette) {}

  invalidate(): void {}

  /**
   * Draw the card.
   * @param width - the columns the card fits.
   * @returns the card's lines.
   */
  render(width: number): string[] {
    return teamIntroLines({ palette: this.palette, width })
  }
}
