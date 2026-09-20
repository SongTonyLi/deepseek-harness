/** Pending-prompt panel rows and framed rendering. */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createPalette } from '../src/style.ts'
import { queuePanelRows, renderQueuePanel } from '../src/queue-panel.ts'

/** One ordinary user prompt for the panel. */
function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' as const } })
}

describe('queued-prompt panel', () => {
  it('lists next-step input first and frames the unfocused rows without an emoji marker', () => {
    const rows = queuePanelRows([message('steer now')], [message('later\nsecond line')])
    expect(rows.map(row => [row.target, row.text])).toEqual([
      ['next-step', 'steer now'],
      ['next-turn', 'later'],
    ])
    const shown = renderQueuePanel(rows, { palette: createPalette(false), width: 60 })
    expect(shown).toContain('● QUEUE')
    expect(shown).toContain('next step · steer now')
    expect(shown).toContain('next turn · later')
    expect(shown).toContain('Shift+↓ manages')
    expect(shown).not.toContain('⏳')
  })

  it('marks the selected row and names each focused action', () => {
    const shown = renderQueuePanel(queuePanelRows([], [message('revise this')]), {
      palette: createPalette(false),
      width: 72,
      selected: 0,
    })
    expect(shown).toContain('▸ next turn · revise this')
    expect(shown).toContain('S steer · I inject · E edit')
  })

  it('draws nothing for an empty inbox', () => {
    expect(renderQueuePanel([], { palette: createPalette(true), width: 40 })).toBe('')
  })

  it('omits plugin notices so a ! result waiting for the next prompt is not a queued prompt', () => {
    const notice = createUserMessage({
      content: [{ type: 'text', text: 'The user ran `ls` in the terminal.' }],
      source: { kind: 'plugin', plugin: 'tui-app', form: 'notice', summary: '! ls' },
    })
    expect(queuePanelRows([notice], [message('ask about it')]).map(row => row.text)).toEqual(['ask about it'])
  })
})
