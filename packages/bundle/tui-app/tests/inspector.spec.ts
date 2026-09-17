/** The docked inspector's rendering of the focused transcript section. */

import { describe, expect, it } from 'vitest'
import { InspectorPane, renderInspector, type InspectorView } from '../src/inspector.ts'
import { createPalette } from '../src/style.ts'

const plain = { palette: createPalette(false), previewLines: 3, width: 20 }

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
  it('draws the heading, the parts strip, the rows, and the keys', () => {
    expect(renderInspector(view(), plain)).toEqual([
      '',
      '2/3 · turn 2 · reply',
      '‹ reasoning · reply ›',
      'done',
      '↑ ↓ blocks · ← → parts · Enter page · Esc back',
    ])
  })

  it('says when the focused block itself is not marked on screen', () => {
    expect(renderInspector(view({ highlighted: false }), plain)[1]).toBe('2/3 · turn 2 · reply · off screen')
  })

  it('accents the held label and dims the rest of the strip', () => {
    const styled = renderInspector(view(), { ...plain, palette: createPalette(true) })
    expect(styled[2]).toBe('\u001b[2m‹ \u001b[22m\u001b[2mreasoning\u001b[22m\u001b[2m · \u001b[22m\u001b[36mreply\u001b[39m\u001b[2m ›\u001b[22m')
  })

  it('omits the strip for a block that has one part', () => {
    const single = renderInspector(view({ parts: [{ label: 'you', focused: true }] }), plain)
    expect(single[2]).toBe('done')
  })

  it('wraps the rows and names how many the page would add', () => {
    const long = renderInspector(view({ rows: ['one two three four five six seven', 'tail'] }), plain)
    expect(long.slice(3)).toEqual([
      'one two three four',
      'five six seven',
      'tail',
      '↑ ↓ blocks · ← → parts · Enter page · Esc back',
    ])
    const cut = renderInspector(view({ rows: ['a', 'b', 'c', 'd', 'e'] }), plain)
    expect(cut.slice(3)).toEqual(['a', 'b', 'c', '… 2 more rows · Enter opens the page', '↑ ↓ blocks · ← → parts · Enter page · Esc back'])
    const one = renderInspector(view({ rows: ['a', 'b', 'c', 'd'] }), plain)
    expect(one[6]).toBe('… 1 more row · Enter opens the page')
  })
})

describe('InspectorPane', () => {
  it('reads the view once per render, so a section that grows reaches the screen', () => {
    let rows = ['first']
    const pane = new InspectorPane(() => view({ rows }), { palette: plain.palette, previewLines: plain.previewLines })
    pane.invalidate()
    expect(pane.render(20).at(-2)).toBe('first')
    rows = ['first', 'second']
    expect(pane.render(20).at(-2)).toBe('second')
  })

  it('draws nothing while no section is focused', () => {
    expect(new InspectorPane(() => undefined, { palette: plain.palette, previewLines: 3 }).render(20)).toEqual([])
  })
})
