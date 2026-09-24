/** Activity-board rows: todo glyphs, the completed scratch-out, the row cap, and the one-line descendant summary. */

import { describe, expect, it } from 'vitest'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import {
  ACTIVITY_BOARD_MAX_TODOS,
  activityBoardView,
  activityResultParts,
  activityTurnEndStatus,
  formatActivitySubagentLine,
  renderActivityBoard,
} from '../src/activity-board.ts'
import type { BlockFade } from '../src/blocks.ts'
import { createPalette } from '../src/style.ts'

const mixed: TodoItem[] = [
  { content: 'read the spec', status: 'completed' },
  { content: 'write the data layer', status: 'in_progress' },
  { content: 'wire the picker', status: 'pending' },
]

const palette = createPalette(false)
const color = createPalette(true)

/** A fade that still draws below the settled colors. */
function liveFade(): BlockFade {
  return { age: () => 1, style: () => ({ capability: 'none', ramp: [] }) }
}

/** A fade that has already settled. */
function settledFade(): BlockFade {
  return { age: () => undefined, style: () => ({ capability: 'none', ramp: [] }) }
}

describe('activityBoardView', () => {
  it('keeps write order and the glyph each status leads with', () => {
    const view = activityBoardView({ todos: mixed })
    expect(view.todos.map(row => row.text)).toEqual([
      '✓ read the spec',
      '▸ write the data layer',
      '○ wire the picker',
    ])
    expect(view.todos.map(row => row.status)).toEqual(['completed', 'in_progress', 'pending'])
    expect(view.hidden).toBe(0)
    expect(view.subagent).toBeUndefined()
  })

  it('cuts the list at the presentation cap and names how many rows were left out', () => {
    const todos: TodoItem[] = Array.from({ length: ACTIVITY_BOARD_MAX_TODOS + 3 }, (_, index) => ({
      content: `item ${String(index + 1)}`,
      status: 'pending',
    }))
    const view = activityBoardView({ todos })
    expect(view.todos).toHaveLength(ACTIVITY_BOARD_MAX_TODOS)
    expect(view.todos[0]?.content).toBe('item 1')
    expect(view.todos.at(-1)?.content).toBe(`item ${String(ACTIVITY_BOARD_MAX_TODOS)}`)
    expect(view.hidden).toBe(3)
  })

  it('formats the descendant line as label, status, and an optional summary', () => {
    expect(formatActivitySubagentLine({ label: 'reviewer', status: 'calling bash', summary: 'git status' }))
      .toBe('reviewer · calling bash · git status')
    expect(formatActivitySubagentLine({ label: 'reviewer', status: 'calling bash' }))
      .toBe('reviewer · calling bash')
    expect(activityBoardView({
      todos: [],
      subagent: { label: 'reviewer', status: 'calling bash', summary: 'git status' },
    }).subagent).toBe('reviewer · calling bash · git status')
  })
})

describe('activity result and turn-end words', () => {
  it('uses the first result row, or error, and never an assistant reply', () => {
    expect(activityResultParts('listed files', false)).toEqual({ status: 'listed files' })
    expect(activityResultParts('permission denied', true)).toEqual({ status: 'error', summary: 'permission denied' })
    expect(activityResultParts(undefined, true)).toEqual({ status: 'error' })
    expect(activityResultParts('', false)).toEqual({ status: 'done' })
  })

  it('uses the existing turn-end notice, or done for an ordinary completion', () => {
    expect(activityTurnEndStatus({ kind: 'completed' })).toBe('done')
    expect(activityTurnEndStatus({ kind: 'aborted', reason: { kind: 'user' } })).toBe('turn stopped')
    expect(activityTurnEndStatus({ kind: 'blocked' }))
      .toBe('turn blocked: the model produced nothing the loop could continue')
    expect(activityTurnEndStatus({ kind: 'error', error: { code: 'E_TEST', message: 'boom' } }))
      .toBe('turn failed: E_TEST: boom')
    expect(activityTurnEndStatus({ kind: 'max-tokens' })).toBe('turn reached the output token ceiling')
    expect(activityTurnEndStatus({ kind: 'interrupted' })).toBe('turn was interrupted by an earlier process exit')
  })

  it('prints only the stop-reason word on the descendant line', () => {
    expect(formatActivitySubagentLine({ label: 'reviewer', status: 'completed' })).toBe('reviewer · completed')
    expect(formatActivitySubagentLine({ label: 'reviewer', status: 'aborted' })).not.toContain('last assistant')
  })
})

describe('renderActivityBoard', () => {
  it('draws nothing when the board has no row', () => {
    expect(renderActivityBoard(activityBoardView({ todos: [] }), { palette })).toBe('')
  })

  it('scratches out completed content and leaves the glyph', () => {
    const shown = renderActivityBoard(activityBoardView({ todos: mixed }), { palette: color })
    expect(shown).toContain('\u001b[32m✓\u001b[39m ')
    expect(shown).toContain('\u001b[9mread the spec\u001b[29m')
    expect(shown).toContain('\u001b[33m▸\u001b[39m write the data layer')
    expect(shown).toContain('\u001b[36m○\u001b[39m wire the picker')
    expect(shown.indexOf('✓')).toBeLessThan(shown.indexOf('▸'))
  })

  it('appends +N more under a list past the cap and the descendant line last', () => {
    const todos: TodoItem[] = Array.from({ length: 5 }, (_, index) => ({
      content: `item ${String(index + 1)}`,
      status: 'pending' as const,
    }))
    const shown = renderActivityBoard(activityBoardView({
      todos,
      subagent: { label: 'session-kid', status: 'done' },
    }), { palette })
    expect(shown).toContain('○ item 1')
    expect(shown).toContain('○ item 4')
    expect(shown).not.toContain('○ item 5')
    expect(shown).toContain('+1 more')
    expect(shown).toContain('session-kid · done')
    expect(shown.indexOf('+1 more')).toBeLessThan(shown.indexOf('session-kid · done'))
  })

  it('applies a live fade to a changed todo row and a replaced descendant line, and leaves a settled fade unmarked', () => {
    const view = activityBoardView({
      todos: [{ content: 'read the spec', status: 'completed' }],
      subagent: { label: 'reviewer', status: 'running' },
    })
    const live = renderActivityBoard(view, {
      palette,
      todoFades: new Map([['read the spec', liveFade()]]),
      subagentFade: liveFade(),
    })
    expect(live).toContain('✓ read the spec')
    expect(live).toContain('reviewer · running')
    const settled = renderActivityBoard(view, {
      palette,
      todoFades: new Map([['read the spec', settledFade()]]),
      subagentFade: settledFade(),
    })
    expect(settled).toBe(live)
  })
})
