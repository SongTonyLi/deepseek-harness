/** The docked inspector's framed rendering of the focused transcript section. */

import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { InspectorPane, renderInspector, type InspectorView } from '../src/inspector.ts'
import { HINTS } from '../src/keys.ts'
import { createPalette } from '../src/style.ts'

const plain = { palette: createPalette(false), previewLines: 3, width: 60 }

/** A line without the resets truncation wraps around its ellipsis. */
const bare = (line: string | undefined): string => (line ?? '').replaceAll('\u001b[0m', '')

/** The content of one framed body row, without its two borders and the padding between them. */
const rowText = (line: string | undefined): string => bare(line).replace(/^│ /u, '').replace(/│$/u, '').trimEnd()

/** The peak of a lift: the one moment a piece of chrome is drawn bold. */
const PEAK = '\u001b[1m\u001b[36m'

/**
 * A focused section as the inspector receives it.
 * @param over - the fields this case cares about.
 * @returns the view.
 */
function view(over: Partial<InspectorView> = {}): InspectorView {
  return {
    heading: '2/3 · turn 2 · reply',
    parts: [{ label: 'reasoning', focused: false }, { label: 'reply', focused: true }],
    rows: ['done'],
    highlighted: true,
    ...over,
  }
}

describe('renderInspector', () => {
  it('frames the section with the mode chip, the parts strip, the rows, and the legend', () => {
    const lines = renderInspector(view(), plain)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain(' ● READ ')
    expect(lines[0]).toContain('2/3 · turn 2 · reply')
    expect(lines[0]?.startsWith('╭')).toBe(true)
    expect(lines[0]?.endsWith('╮')).toBe(true)
    // Every body row is closed on both sides, so the frame reads as one box.
    expect(lines[1]).toBe(`│ ← 1 reasoning · [2 reply] →${' '.repeat(plain.width - 4 - '← 1 reasoning · [2 reply] →'.length)} │`)
    expect(rowText(lines[2])).toBe('done')
    expect(lines[3]).toContain('↑↓ ←→ · Space folds · Esc input')
    expect(lines[3]?.startsWith('╰')).toBe(true)
    expect(lines[3]?.endsWith('╯')).toBe(true)
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(plain.width)
  })

  it('spends two rows on its own chrome, whatever the strip and the body hold', () => {
    const strip = renderInspector(view({ rows: ['a', 'b', 'c', 'd', 'e'] }), plain)
    // Two rules, one strip line, three preview rows, and the marker that names
    // what the reader still has.
    expect(strip).toHaveLength(2 + 1 + plain.previewLines + 1)
    const single = renderInspector(view({ parts: [{ label: 'you', focused: true }], rows: ['a'] }), plain)
    expect(single).toHaveLength(3)
    expect(rowText(single[1])).toBe('a')
  })

  it('takes the widest legend step the width holds', () => {
    expect(renderInspector(view(), { ...plain, width: 95 }).at(-1)).toContain(HINTS.transcript[0])
    expect(renderInspector(view(), { ...plain, width: 40 }).at(-1)).toContain(HINTS.transcript[1])
    expect(bare(renderInspector(view(), { ...plain, width: 20 }).at(-1))).toContain('Esc input')
  })

  it('says when the focused block itself is not marked on screen, and dims the frame with it', () => {
    const off = renderInspector(view({ highlighted: false }), plain)
    expect(off[0]).toContain('2/3 · turn 2 · reply · off screen')
    const styled = renderInspector(view({ highlighted: false }), { ...plain, palette: createPalette(true) })
    expect(styled[0]).toContain('\u001b[2m╭\u001b[22m')
    expect(styled.at(-1)).toContain('\u001b[2m╰\u001b[22m')
    const marked = renderInspector(view(), { ...plain, palette: createPalette(true) })
    expect(marked[0]).toContain('\u001b[36m╭\u001b[39m')
    expect(marked.at(-1)).toContain('\u001b[36m╰\u001b[39m')
  })

  it('lifts the whole outline and the chip together, and settles on the same lines', () => {
    const styled = { ...plain, palette: createPalette(true) }
    const settled = renderInspector(view(), styled)
    const lifted = renderInspector(view({ level: 2 }), styled)
    // The lift reaches the rules, the body border, and the chip as one, and
    // takes exactly the rows the settled frame takes.
    expect(lifted).toHaveLength(settled.length)
    expect(lifted[0]).toContain(`${PEAK}\u001b[36m\u256d`)
    expect(lifted[0]).toContain(`${PEAK}\u001b[7m`)
    expect(lifted[1]).toContain(`${PEAK}\u001b[36m\u2502`)
    expect(lifted.at(-1)).toContain(`${PEAK}\u001b[36m\u2570`)
    expect(renderInspector(view({ level: 0 }), styled)).toEqual(settled)
  })

  it('takes no lift at all while the block it names is not marked on screen', () => {
    const styled = { ...plain, palette: createPalette(true) }
    const off = renderInspector(view({ highlighted: false, level: 2 }), styled)
    // A dim frame says the mark is out of the renderer's reach; brightening
    // any part of it, the chip included, would say the opposite.
    expect(off).toEqual(renderInspector(view({ highlighted: false }), styled))
    expect(off[0]).not.toContain(`${PEAK}\u001b[7m`)
  })

  it('brackets the held label and dims the rest of the strip', () => {
    const styled = renderInspector(view(), { ...plain, palette: createPalette(true) })
    expect(styled[1]).toContain(
      '\u001b[36m│\u001b[39m \u001b[2m← \u001b[22m\u001b[2m1 reasoning\u001b[22m\u001b[2m · \u001b[22m\u001b[36m[2 reply]\u001b[39m\u001b[2m →\u001b[22m',
    )
    // The brackets carry the selection where no color is drawn at all.
    expect(renderInspector(view(), plain)[1]).toContain('[2 reply]')
  })

  it('omits the strip for a block that has one part', () => {
    const single = renderInspector(view({ parts: [{ label: 'you', focused: true }] }), plain)
    expect(rowText(single[1])).toBe('done')
    expect(single).toHaveLength(3)
  })

  it('cuts a heading the width cannot hold and keeps the off-screen mark whole', () => {
    const wide = view({
      heading: '44/44 · turn 1 · grep Grep ^(<<<<<<<|=======|>>>>>>>) in /repo (*.{md,ts}) · result',
      highlighted: false,
    })
    const lines = renderInspector(wide, { ...plain, width: 40 })
    expect(bare(lines[0])).toContain('44/44 · tur… · off screen')
    for (const line of lines) expect(visibleWidth(bare(line))).toBeLessThanOrEqual(40)
    expect(bare(renderInspector(view({ ...wide, highlighted: true }), { ...plain, width: 40 })[0]))
      .toContain('44/44 · turn 1 · grep Gre…')
  })

  it('keeps every line inside a narrow terminal and every part label on screen', () => {
    const narrow = renderInspector(view({ rows: ['a', 'b', 'c', 'd', 'e'] }), { ...plain, width: 20 })
    const shown = narrow.map(bare).join('\n')
    expect(shown.replaceAll(/\s+/gu, ' ')).toContain('1 reasoning')
    expect(shown.replaceAll(/\s+/gu, ' ')).toContain('[2 reply]')
    expect(shown).toContain('… 2 more')
    for (const line of narrow) expect(visibleWidth(bare(line))).toBeLessThanOrEqual(20)
  })

  it('wraps the rows inside the frame and names how many the reader still has', () => {
    const long = renderInspector(view({ rows: ['one two three four five six seven', 'tail'] }), { ...plain, width: 22 })
    expect(long.map(rowText).join('\n')).toContain('one two three four\nfive six seven\ntail')
    const cut = renderInspector(view({ rows: ['a', 'b', 'c', 'd', 'e'] }), plain)
    expect(cut.slice(2, -1).map(rowText)).toEqual(['a', 'b', 'c', '… 2 more rows · Ctrl+G reads it'])
    const one = renderInspector(view({ rows: ['a', 'b', 'c', 'd'] }), plain)
    expect(rowText(one.at(-2))).toBe('… 1 more row · Ctrl+G reads it')
  })

  it('folds a context section too, instead of drawing every model-facing row', () => {
    const context = renderInspector(view({
      heading: '1/2 · turn 0 · system prompt',
      parts: [{ label: 'system', focused: true }],
      rows: ['a', 'b', 'c', 'd'],
    }), plain)
    expect(context.slice(1, -1).map(rowText)).toEqual(['a', 'b', 'c', '… 1 more row · Ctrl+G reads it'])
  })

  it('wraps a long part label across lines instead of cutting it', () => {
    const strip = renderInspector(view({
      parts: [
        { label: 'workspace-sandbox-policy', focused: true },
        { label: 'git', focused: false },
      ],
    }), { ...plain, width: 16 })
    const shown = strip.map(bare).join('\n')
    expect(shown.replaceAll(/[\s│]+/gu, '')).toContain('workspace-sandbox-policy')
    expect(shown).toContain('2 git')
    for (const line of strip) expect(visibleWidth(bare(line))).toBeLessThanOrEqual(16)
  })

  it('wraps the numbered strip so every part stays visible', () => {
    const many = renderInspector(view({
      parts: [
        { label: 'sandbox', focused: true },
        { label: 'git', focused: false },
        { label: 'todos', focused: false },
        { label: 'env', focused: false },
      ],
    }), { ...plain, width: 24 })
    const strip = many.slice(1, -2).map(bare)
    expect(strip.join('\n')).toContain('[1 sandbox]')
    expect(strip.join('\n')).toContain('2 git')
    expect(strip.join('\n')).toContain('3 todos')
    expect(strip.join('\n')).toContain('4 env')
    expect(strip.length).toBeGreaterThan(1)
  })
})

describe('InspectorPane', () => {
  it('reads the view once per render, so a section that grows reaches the screen', () => {
    let rows = ['first']
    const pane = new InspectorPane(() => view({ rows }), { palette: plain.palette, previewLines: plain.previewLines })
    pane.invalidate()
    expect(rowText(pane.render(30).at(-2))).toBe('first')
    rows = ['first', 'second']
    expect(rowText(pane.render(30).at(-2))).toBe('second')
  })

  it('draws nothing while no section is focused', () => {
    expect(new InspectorPane(() => undefined, { palette: plain.palette, previewLines: 3 }).render(20)).toEqual([])
  })
})
