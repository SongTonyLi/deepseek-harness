/** Follow-up panel rows and framed listing. */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createPalette } from '../src/style.ts'
import { queuePanelRows, renderQueuePanel } from '../src/queue-panel.ts'
import { testContextSource } from './message-sources.ts'

/** One ordinary user prompt for the panel. */
function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' as const } })
}

describe('follow-up panel', () => {
  it('lists next-step input first as pending rows under a follow-ups title', () => {
    const rows = queuePanelRows([message('steer now')], [message('later\nsecond line')])
    expect(rows.map(row => [row.target, row.text])).toEqual([
      ['next-step', 'steer now'],
      ['next-turn', 'later'],
    ])
    const shown = renderQueuePanel(rows, { palette: createPalette(false), width: 60 })
    expect(shown).toContain('follow-ups')
    expect(shown).not.toContain('QUEUE')
    expect(shown).toContain('○ steer now')
    expect(shown).toContain('○ later')
    expect(shown).not.toContain('next step ·')
    expect(shown).not.toContain('next turn ·')
    expect(shown).toContain('↑ edit · Shift+↑ select')
    expect(shown).not.toContain('shift+↓ select')
    expect(shown.indexOf('○ steer now')).toBeLessThan(shown.indexOf('○ later'))
  })

  it('marks the selected row and names select, steer, edit, inject, and the way back', () => {
    const shown = renderQueuePanel(queuePanelRows([], [message('revise this')]), {
      palette: createPalette(false),
      width: 72,
      selected: 0,
    })
    expect(shown).toContain('○ revise this')
    expect(shown).toContain('↑↓ select · Enter steer · E edit · I inject · Esc input')
    expect(shown).not.toContain('S steer · I inject · E edit')
  })

  it('wraps a long follow-up under the pending glyph', () => {
    const text = 'also implement similar scratch out, listing effect exactly like in the image'
    const shown = renderQueuePanel(queuePanelRows([], [message(text)]), {
      palette: createPalette(false),
      width: 44,
      selected: 0,
    })
    expect(shown).toContain('○ also implement')
    expect(shown).toMatch(/│ {3}\S/u)
    expect(shown).toContain('↑↓ · Enter steer · E edit · Esc input')
  })

  it('draws nothing for an empty inbox', () => {
    expect(renderQueuePanel([], { palette: createPalette(true), width: 40 })).toBe('')
  })

  it('omits injected notices so a ! result waiting for the next prompt is not a queued prompt', () => {
    const notice = createUserMessage({
      content: [{ type: 'text', text: 'The user ran `ls` in the terminal.' }],
      source: testContextSource({ form: 'notice', summary: '! ls' }),
    })
    expect(queuePanelRows([notice], [message('ask about it')]).map(row => row.text)).toEqual(['ask about it'])
  })
})
