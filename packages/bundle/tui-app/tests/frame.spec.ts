/** The box drawing the framed surfaces share: rules, the mode chip, body rows, and legend steps. */

import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import {
  BODY_MARGIN,
  RULE_MARGIN,
  bodyLine,
  bottomRule,
  chip,
  fitLegend,
  legendRule,
  ruleRoom,
  topRule,
} from '../src/frame.ts'
import { createPalette } from '../src/style.ts'

const plain = createPalette(false)
const styled = createPalette(true)

/** The widths the surfaces are read at: a narrow terminal, a common one, and the live walk's. */
const WIDTHS = [20, 40, 95]

/** A line without the resets truncation wraps around its ellipsis. */
const bare = (line: string): string => line.replaceAll('\u001b[0m', '')

describe('the rules', () => {
  it('fills exactly the width it was given, with or without its texts', () => {
    for (const width of WIDTHS) {
      const lines = [
        topRule({ chip: chip(plain, 'READ'), title: '3/12 · turn 2 · reply', width, palette: plain, tone: 'focus' }),
        topRule({ title: 'turn 3 of 12', right: '45/48', width, palette: plain, tone: 'focus' }),
        topRule({ chip: chip(plain, 'READER'), width, palette: plain, tone: 'focus' }),
        bottomRule({ left: 'Esc input', width, palette: plain, tone: 'focus' }),
        bottomRule({ width, palette: plain, tone: 'muted' }),
        legendRule({ left: '↑↓ sections', right: 'row 14/212', width, palette: plain, tone: 'focus' }),
      ]
      for (const line of lines) expect(visibleWidth(bare(line))).toBe(width)
    }
  })

  it('opens and closes each rule with its own corners', () => {
    expect(topRule({ chip: chip(plain, 'READ'), title: 'hello', width: 20, palette: plain, tone: 'focus' }))
      .toBe('╭  ● READ  ─ hello ╮')
    expect(bottomRule({ left: 'Esc input', width: 20, palette: plain, tone: 'focus' })).toBe('╰ Esc input ───────╯')
    expect(legendRule({ left: 'keys', right: '2/9', width: 20, palette: plain, tone: 'focus' }))
      .toBe('├ keys ─────── 2/9 ┤')
    expect(bottomRule({ width: 8, palette: plain, tone: 'muted' })).toBe('╰──────╯')
    expect(topRule({ chip: chip(plain, 'READ'), width: 20, palette: plain, tone: 'focus' })).toBe('╭  ● READ  ────────╮')
  })

  it('cuts the title before the right-hand text, so the position survives the width', () => {
    const line = topRule({
      chip: chip(plain, 'READER'),
      title: 'grep Grep ^(<<<<<<<|=======|>>>>>>>) in /repo (*.{md,ts}) · result',
      right: '45/48',
      width: 30,
      palette: plain,
      tone: 'focus',
    })
    expect(bare(line).endsWith(' 45/48 ╮')).toBe(true)
    expect(bare(line)).toContain('…')
    expect(visibleWidth(bare(line))).toBe(30)
  })

  it('gives up its own glyphs before the readout on a width narrower than that readout', () => {
    const line = legendRule({ left: 'keys', right: 'turn 3/12 · section 2/9', width: 6, palette: plain, tone: 'muted' })
    expect(visibleWidth(bare(line))).toBe(6)
    // The corners and the legend are what a width this narrow spends first;
    // the position the surface reports is what is left.
    expect(bare(line)).toBe(' turn…')
  })

  it('draws the rules accented while the surface acts and dim while it cannot', () => {
    const focused = topRule({ title: 'reply', width: 12, palette: styled, tone: 'focus' })
    const muted = topRule({ title: 'reply', width: 12, palette: styled, tone: 'muted' })
    expect(focused).toContain('\u001b[36m╭\u001b[39m')
    expect(focused).toContain('\u001b[36m───')
    expect(muted).toContain('\u001b[2m╭\u001b[22m')
    expect(muted).not.toContain('\u001b[36m')
    expect(visibleWidth(focused)).toBe(12)
    expect(visibleWidth(muted)).toBe(12)
  })

  it('lifts its own glyphs while a landing moves, and leaves a muted frame alone', () => {
    const lifted = topRule({ title: 'reply', width: 12, palette: styled, tone: 'focus', level: 2 })
    expect(lifted).toContain('\u001b[1m\u001b[36m\u001b[36m╭')
    expect(visibleWidth(lifted)).toBe(12)
    // A dim frame says the surface cannot act on what it shows; brightening
    // it would say the opposite.
    expect(topRule({ title: 'reply', width: 12, palette: styled, tone: 'muted', level: 2 })).not.toContain('\u001b[1m')
    expect(bottomRule({ left: 'Esc input', width: 20, palette: plain, tone: 'focus', level: 1 })).toBe('╰ Esc input ───────╯')
  })

  it('leaves a disabled palette with plain text', () => {
    expect(topRule({ title: 'reply', width: 12, palette: plain, tone: 'focus' })).toBe('╭ reply ───╮')
    expect(topRule({ title: 'reply', width: 12, palette: plain, tone: 'focus' })).not.toContain('\u001b')
  })
})

describe('chip', () => {
  it('names the mode as the one inverse block the surface draws', () => {
    expect(chip(plain, 'READ')).toBe(' ● READ ')
    expect(chip(styled, 'READ')).toBe('\u001b[7m\u001b[36m ● READ \u001b[39m\u001b[27m')
  })
})

describe('ruleRoom', () => {
  it('leaves the text what the corners, the spaces, and the chip do not take', () => {
    expect(ruleRoom(40)).toBe(40 - RULE_MARGIN)
    expect(ruleRoom(40, chip(plain, 'READ'))).toBe(40 - RULE_MARGIN - visibleWidth(' ● READ ') - 3)
    expect(ruleRoom(2, chip(plain, 'READER'))).toBe(1)
  })

  it('names the room a title actually gets', () => {
    const badge = chip(plain, 'READ')
    const title = 'x'.repeat(ruleRoom(40, badge))
    expect(visibleWidth(topRule({ chip: badge, title, width: 40, palette: plain, tone: 'focus' }))).toBe(40)
    expect(topRule({ chip: badge, title, width: 40, palette: plain, tone: 'focus' })).not.toContain('…')
  })
})

describe('fitLegend', () => {
  const steps = ['↑↓ sections · ←→ parts · Space folds · Ctrl+G reader · Esc input', '↑↓ ←→ · Space folds · Esc input', 'Esc input']

  it('takes each declared step at the width that first holds it', () => {
    for (const step of steps) {
      expect(fitLegend(steps, visibleWidth(step))).toBe(step)
    }
    expect(fitLegend(steps, visibleWidth(steps[0] as string) - 1)).toBe(steps[1])
    expect(fitLegend(steps, visibleWidth(steps[1] as string) - 1)).toBe(steps[2])
  })

  it('keeps the last step below its own width, naming the way back rather than nothing', () => {
    expect(fitLegend(steps, 1)).toBe('Esc input')
    expect(fitLegend([], 80)).toBe('')
  })
})

describe('bodyLine', () => {
  it('closes the row on both sides and pads the content between them', () => {
    const line = bodyLine('clean tree', 20, plain, 'focus')
    expect(line).toBe(`│ clean tree${' '.repeat(20 - BODY_MARGIN - 'clean tree'.length)} │`)
    expect(visibleWidth(line)).toBe(20)
    expect(bodyLine('clean tree', 20, styled, 'muted')).toContain('\u001b[2m│\u001b[22m clean tree')
  })

  it('lifts both borders with the rest of the frame', () => {
    expect(bodyLine('clean tree', 40, styled, 'focus', 2)).toContain('\u001b[1m\u001b[36m\u001b[36m│')
    expect(bodyLine('clean tree', 40, styled, 'muted', 2)).toBe(bodyLine('clean tree', 40, styled, 'muted'))
    expect(bodyLine('clean tree', 40, plain, 'focus', 2)).toBe(bodyLine('clean tree', 40, plain, 'focus'))
  })

  it('cuts a row the width cannot hold', () => {
    const line = bodyLine('x'.repeat(40), 12, plain, 'focus')
    expect(visibleWidth(bare(line))).toBe(12)
    expect(bare(line)).toBe(`│ ${'x'.repeat(12 - BODY_MARGIN - 1)}… │`)
  })

  it('keeps the opening border and the text at a width too narrow to close the row', () => {
    const line = bodyLine('x'.repeat(40), 4, plain, 'focus')
    expect(visibleWidth(bare(line))).toBe(4)
    expect(bare(line).startsWith('│ ')).toBe(true)
  })
})
