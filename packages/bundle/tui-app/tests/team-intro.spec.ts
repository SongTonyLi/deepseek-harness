/** The Agent Teams start card: the settled fan-out figure, the entrance it draws once mounted, and when that entrance settles. */

import { stripVTControlCharacters } from 'node:util'
import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { BlockFade } from '../src/blocks.ts'
import type { FadeStyle } from '../src/fade.ts'
import { TOOL_SPINNERS } from '../src/spinner.ts'
import { createPalette } from '../src/style.ts'
import {
  TEAM_INTRO_LAST_STEP,
  TEAM_INTRO_SENTENCE,
  TEAM_INTRO_TITLE,
  TEAM_OFF_COMMAND,
  TeamIntro,
  agentTeamsMounted,
  teamIntroLines,
  type TeamIntroEntrance,
} from '../src/team-intro.ts'

const palette = createPalette(false)
const colored = createPalette(true)

/** A start instant on a spinner-cycle boundary, so a phase-0 slot draws the first delegation frame at step 0. */
const STARTED = 800_000

const SPINNER_MS = 100

const COMMAND_ROW = '/team-play live room · /team roster and tasks · /team off'

const SETTLED = [
  '◆ ─┬─ ●   Agent Teams',
  '   ├─ ●   The lead splits the work; each teammate takes one role.',
  `   └─ ●   ${COMMAND_ROW}`,
]

const DIM_FADE: FadeStyle = { capability: 'dim', ramp: [] }

/** The delegation spinner's frame `index` steps after the cycle start. */
function spun(index: number): string {
  return TOOL_SPINNERS.subagent[index % TOOL_SPINNERS.subagent.length]!
}

/** The glyph a figured row draws in its slot column; every figure glyph is one UTF-16 unit. */
function slot(line: string): string {
  return line.charAt(6)
}

/** The card's lines `step` spinner periods into its entrance, with no row fade. */
function at(step: number, width = 80, draw = palette): string[] {
  return teamIntroLines({ palette: draw, width, frame: { startedAt: STARTED, now: STARTED + step * SPINNER_MS, spinnerMs: SPINNER_MS } })
}

/** One entrance whose clock the spec moves. */
function entrance(options: Partial<TeamIntroEntrance> = {}): { clock: { now: number }; options: TeamIntroEntrance } {
  const clock = { now: STARTED }
  return {
    clock,
    options: {
      startedAt: STARTED,
      spinnerMs: SPINNER_MS,
      fadeStepMs: 16,
      fadeSteps: 4,
      now: () => clock.now,
      style: () => DIM_FADE,
      ...options,
    },
  }
}

describe('the settled card', () => {
  it('draws the lead branching to three teammates beside the title, the sentence, and the commands', () => {
    expect(teamIntroLines({ palette, width: 80 })).toEqual(SETTLED)
    expect(TEAM_INTRO_TITLE).toBe('Agent Teams')
    expect(TEAM_INTRO_SENTENCE).toBe('The lead splits the work; each teammate takes one role.')
    expect(TEAM_OFF_COMMAND).toBe('/team off')
  })

  it('colors the lead, the teammates, and the commands, and dims the off command', () => {
    const [lead, , commands] = teamIntroLines({ palette: colored, width: 80 })
    expect(lead).toContain(colored.bold(colored.accent('◆')))
    expect(lead).toContain(colored.accent('●'))
    expect(lead).toContain(colored.dim('─┬─'))
    expect(lead).toContain(colored.bold(colored.accent(TEAM_INTRO_TITLE)))
    expect(commands).toContain(colored.accent('/team-play'))
    expect(commands).toContain(colored.dim('live room'))
    expect(commands).toContain(colored.dim(TEAM_OFF_COMMAND))
    expect(commands).not.toContain(colored.warning(TEAM_OFF_COMMAND))
  })

  it('cuts the text column to the width and keeps the figure', () => {
    const lines = teamIntroLines({ palette, width: 50 })
    expect(lines[0]).toBe(SETTLED[0])
    expect(stripVTControlCharacters(lines[1]!)).toBe('   ├─ ●   The lead splits the work; each teammate…')
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(50)
  })

  it('drops the figure below 40 columns and keeps three text lines', () => {
    expect(teamIntroLines({ palette, width: 40 })[0]).toBe(SETTLED[0])
    const narrow = teamIntroLines({ palette, width: 39 })
    expect(narrow).toHaveLength(3)
    expect(narrow[0]).toBe(TEAM_INTRO_TITLE)
    expect(stripVTControlCharacters(narrow[1]!)).toBe('The lead splits the work; each teammat…')
    for (const line of narrow) {
      expect(line).not.toContain('●')
      expect(visibleWidth(line)).toBeLessThanOrEqual(39)
    }
    for (const line of teamIntroLines({ palette, width: 0 })) expect(visibleWidth(line)).toBeLessThanOrEqual(1)
  })
})

describe('the entrance', () => {
  it('draws the lead, then grows the trunk', () => {
    expect(at(0)).toEqual(['◆', '', ''])
    expect(at(1)).toEqual(['◆ ─┬', '', ''])
  })

  it('brightens the lead over the first two steps', () => {
    expect(at(0, 80, colored)[0]).toBe(colored.dim('◆'))
    expect(at(1, 80, colored)[0]).toContain(colored.accent('◆'))
    expect(at(2, 80, colored)[0]).toContain(colored.bold(colored.accent('◆')))
  })

  it('adds one branch per step, each with a spinning slot and its text row', () => {
    expect(at(2)).toEqual([`◆ ─┬─ ${spun(2)}   Agent Teams`, '', ''])
    expect(at(3)).toEqual([
      `◆ ─┬─ ${spun(3)}   Agent Teams`,
      `   ├─ ${spun(6)}   ${TEAM_INTRO_SENTENCE}`,
      '',
    ])
    expect(at(4)).toEqual([
      `◆ ─┬─ ${spun(4)}   Agent Teams`,
      `   ├─ ${spun(7)}   ${TEAM_INTRO_SENTENCE}`,
      `   └─ ${spun(10)}   ${COMMAND_ROW}`,
    ])
  })

  it('spins each slot in the running color at its own phase', () => {
    expect(at(2, 80, colored)[0]).toContain(colored.warning(spun(2)))
    for (const step of [4, 5]) {
      const slots = at(step).map(slot)
      expect(new Set(slots).size).toBe(3)
    }
  })

  it('lands the slots on the teammate glyph one step apart', () => {
    expect(at(6).map(slot)).toEqual(['●', spun(9), spun(12)])
    expect(at(7).map(slot)).toEqual(['●', '●', spun(13)])
    expect(at(TEAM_INTRO_LAST_STEP)).toEqual(SETTLED)
    expect(at(TEAM_INTRO_LAST_STEP + 5)).toEqual(SETTLED)
  })

  it('ends on exactly the settled drawing', () => {
    expect(at(TEAM_INTRO_LAST_STEP, 80, colored)).toEqual(teamIntroLines({ palette: colored, width: 80 }))
  })

  it('returns three lines at every step and width', () => {
    for (let step = 0; step <= TEAM_INTRO_LAST_STEP; step += 1) {
      for (const width of [80, 39]) expect(at(step, width)).toHaveLength(3)
    }
  })

  it('reveals the narrow text rows on the same steps', () => {
    expect(at(1, 39)).toEqual(['', '', ''])
    expect(at(2, 39)).toEqual([TEAM_INTRO_TITLE, '', ''])
    expect(at(3, 39).map(stripVTControlCharacters)[1]).toBe('The lead splits the work; each teammat…')
  })

  it('draws a text row at the mix its fade reports', () => {
    const fading: BlockFade = { age: () => 0, style: () => DIM_FADE }
    const settled: BlockFade = { age: () => undefined, style: () => DIM_FADE }
    const frame = { startedAt: STARTED, now: STARTED + 4 * SPINNER_MS, spinnerMs: SPINNER_MS }
    const faded = teamIntroLines({ palette, width: 80, frame: { ...frame, fades: [fading, settled] } })
    expect(faded[0]).not.toBe(at(4)[0])
    expect(stripVTControlCharacters(faded[0]!)).toBe(at(4)[0])
    expect(faded[1]).toBe(at(4)[1])
    expect(faded[2]).toBe(at(4)[2])
  })
})

describe('the card component', () => {
  it('draws the settled card at once without an entrance', () => {
    const card = new TeamIntro(palette)
    card.invalidate()
    expect(card.render(80)).toEqual(SETTLED)
    expect(card.needsRepaint()).toBe(false)
    expect(card.setRepaintFloor(3)).toBe(false)
  })

  it('plays the entrance on its clock and settles after the last step', () => {
    const { clock, options } = entrance()
    const card = new TeamIntro(palette, options)
    expect(card.render(80)).toEqual(['◆', '', ''])
    expect(card.needsRepaint()).toBe(true)
    clock.now = STARTED + 3 * SPINNER_MS
    expect(stripVTControlCharacters(card.render(80)[1]!)).toBe(at(3)[1])
    clock.now = STARTED + TEAM_INTRO_LAST_STEP * SPINNER_MS
    expect(card.needsRepaint()).toBe(false)
    expect(card.render(80)).toEqual(SETTLED)
  })

  it('fades each text row in from the step it appears', () => {
    const { clock, options } = entrance()
    const card = new TeamIntro(palette, options)
    clock.now = STARTED + 2 * SPINNER_MS
    expect(card.render(80)[0]).not.toBe(at(2)[0])
    clock.now = STARTED + 2 * SPINNER_MS + 4 * 16
    expect(card.render(80)[0]).toBe(at(2)[0])
  })

  it('keeps moving past the last step while a text row still fades', () => {
    const { clock, options } = entrance({ fadeSteps: 100 })
    const card = new TeamIntro(palette, options)
    clock.now = STARTED + TEAM_INTRO_LAST_STEP * SPINNER_MS
    expect(card.needsRepaint()).toBe(true)
    expect(card.render(80).map(stripVTControlCharacters)).toEqual(SETTLED)
  })

  it('settles at once when the renderer can no longer repaint its first line', () => {
    const { options } = entrance()
    const card = new TeamIntro(palette, options)
    expect(card.setRepaintFloor(0)).toBe(false)
    expect(card.needsRepaint()).toBe(true)
    expect(card.setRepaintFloor(1)).toBe(true)
    expect(card.needsRepaint()).toBe(false)
    expect(card.render(80)).toEqual(SETTLED)
    expect(card.setRepaintFloor(1)).toBe(false)
  })

  it('settles when told to', () => {
    const { options } = entrance()
    const card = new TeamIntro(palette, options)
    card.settle()
    expect(card.needsRepaint()).toBe(false)
    expect(card.render(80)).toEqual(SETTLED)
  })
})

describe('agentTeamsMounted', () => {
  it('is true only when the service exposes isEnabled', () => {
    expect(agentTeamsMounted({ isEnabled: () => [] })).toBe(true)
    expect(agentTeamsMounted({ isEnabled: 4 })).toBe(false)
    expect(agentTeamsMounted({})).toBe(false)
    expect(agentTeamsMounted(null)).toBe(false)
    expect(agentTeamsMounted(undefined)).toBe(false)
  })
})
