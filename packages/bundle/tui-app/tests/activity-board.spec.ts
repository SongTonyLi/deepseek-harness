/** Activity-board rows: todo glyphs, in-progress spinner frames, the completed scratch-out, the row cap, and one row per descendant. */

import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import {
  ACTIVITY_BOARD_MAX_SUBAGENTS,
  ACTIVITY_BOARD_MAX_TODOS,
  activityBoardView,
  activityNarration,
  activityTurnEndStatus,
  renderActivityBoard,
  spinningSubagents,
  spinningTodos,
  type ActivityBoardSubagent,
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
const WIDTH = 80

/** Drop the color and reset sequences a cut label carries, which leave its characters as drawn. */
function plain(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/gu, '')
}

/** One descendant row for a draw; the id doubles as the label unless one is given. */
function child(id: string, rest: Partial<ActivityBoardSubagent> = {}): ActivityBoardSubagent {
  return { id: id as SessionId, label: id, state: 'running', ...rest }
}

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
    expect(view.subagents).toEqual([])
    expect(view.hiddenSubagents).toBe(0)
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

  it('draws running descendants before settled ones and cuts the list at its own cap', () => {
    const subagents = [
      child('done-1', { state: 'done' }),
      child('run-1'),
      child('stopped-1', { state: 'stopped' }),
      child('run-2'),
      child('run-3'),
    ]
    const view = activityBoardView({ todos: [], subagents })
    expect(view.subagents.map(row => row.id)).toEqual(['run-1', 'run-2', 'run-3'])
    expect(view.subagents).toHaveLength(ACTIVITY_BOARD_MAX_SUBAGENTS)
    expect(view.hiddenSubagents).toBe(2)
    expect(spinningSubagents(view)).toEqual(['run-1', 'run-2', 'run-3'])
    const settled = activityBoardView({ todos: [], subagents: [child('done-1', { state: 'done' }), child('run-1')] })
    expect(settled.subagents.map(row => row.id)).toEqual(['run-1', 'done-1'])
    expect(spinningSubagents(settled)).toEqual(['run-1'])
  })
})

describe('activityNarration', () => {
  it('keeps the last sentence of the last line', () => {
    expect(activityNarration('I read the file. Now I will merge the sandbox profile.')).toBe('Now I will merge the sandbox profile.')
    expect(activityNarration('First line.\nSecond line. Third one!')).toBe('Third one!')
    expect(activityNarration('Updating src/foo.ts: add the hook')).toBe('Updating src/foo.ts: add the hook')
    expect(activityNarration('Bumped v1.2 to v1.3 in the manifest')).toBe('Bumped v1.2 to v1.3 in the manifest')
  })

  it('drops code blocks, headings, bullets, links, and emphasis', () => {
    expect(activityNarration('Checking.\n```ts\nconst a = 1\n```')).toBe('Checking.')
    expect(activityNarration('```ts\nconst a = 1')).toBeUndefined()
    expect(activityNarration('## Plan\n- read `app.ts`\n- **merge** the [docs](https://example.test)')).toBe('merge the docs')
    expect(activityNarration('Reading approval_text now')).toBe('Reading approval_text now')
  })

  it('has nothing to show for text without prose, and bounds a very long sentence', () => {
    expect(activityNarration('')).toBeUndefined()
    expect(activityNarration(' \n\n  ')).toBeUndefined()
    expect(activityNarration('```\ncode only\n```')).toBeUndefined()
    const long = activityNarration('x'.repeat(1000))
    expect(long).toHaveLength(240)
    expect(long?.endsWith('…')).toBe(true)
  })
})

describe('activity turn-end words', () => {
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
})

describe('renderActivityBoard', () => {
  it('draws nothing when the board has no row', () => {
    expect(renderActivityBoard(activityBoardView({ todos: [] }), { palette, width: WIDTH })).toBe('')
  })

  it('scratches out completed content and leaves the glyph', () => {
    const shown = renderActivityBoard(activityBoardView({ todos: mixed }), { palette: color, width: WIDTH })
    expect(shown).toContain('\u001b[38;5;149m✓\u001b[39m ')
    expect(shown).toContain('\u001b[9mread the spec\u001b[29m')
    expect(shown).toContain('\u001b[38;5;179m▸\u001b[39m write the data layer')
    expect(shown).toContain('\u001b[38;5;111m○\u001b[39m wire the picker')
    expect(shown.indexOf('✓')).toBeLessThan(shown.indexOf('▸'))
  })

  it('draws each in-progress todo on its own spinner frame and names the rows that spin', () => {
    const view = activityBoardView({ todos: mixed })
    expect(spinningTodos(view)).toEqual(['write the data layer'])
    const shown = renderActivityBoard(view, { palette: color, width: WIDTH, spinners: new Map([['write the data layer', '✦']]) })
    expect(shown).toContain('\u001b[38;5;179m✦\u001b[39m write the data layer')
    expect(shown).toContain('\u001b[38;5;111m○\u001b[39m wire the picker')
    expect(spinningTodos(activityBoardView({ todos: [{ content: 'wire the picker', status: 'pending' }] }))).toEqual([])

    const parallel = activityBoardView({
      todos: [
        { content: 'build the client', status: 'in_progress' },
        { content: 'build the server', status: 'in_progress' },
        { content: 'ship both', status: 'in_progress' },
        { content: 'wire the picker', status: 'pending' },
      ],
    })
    expect(spinningTodos(parallel)).toEqual(['build the client', 'build the server', 'ship both'])
    const frames = new Map([['build the client', '✧'], ['build the server', '✶'], ['wire the picker', '✸']])
    expect(renderActivityBoard(parallel, { palette, width: WIDTH, spinners: frames }).split('\n')).toEqual([
      '✧ build the client',
      '✶ build the server',
      '▸ ship both',
      '○ wire the picker',
    ])
  })

  it('appends +N more under a list past the cap and the descendant rows last', () => {
    const todos: TodoItem[] = Array.from({ length: 5 }, (_, index) => ({
      content: `item ${String(index + 1)}`,
      status: 'pending' as const,
    }))
    const shown = renderActivityBoard(activityBoardView({
      todos,
      subagents: [child('session-kid', { state: 'done', note: 'done' })],
    }), { palette, width: WIDTH })
    expect(shown).toContain('○ item 1')
    expect(shown).toContain('○ item 4')
    expect(shown).not.toContain('○ item 5')
    expect(shown).toContain('+1 more')
    expect(shown).toContain('✓ session-kid › done')
    expect(shown.indexOf('+1 more')).toBeLessThan(shown.indexOf('session-kid › done'))
  })

  it('draws one row per descendant: its spinner, label, and what it last said', () => {
    const view = activityBoardView({
      todos: [],
      subagents: [
        child('resolver', { note: 'Merging the sandbox profile now.' }),
        child('writer', { note: 'Reconciling the README sections.' }),
        child('quiet'),
        child('finished', { state: 'done', note: 'done' }),
      ],
    })
    expect(renderActivityBoard(view, {
      palette,
      width: WIDTH,
      subagentSpinners: new Map([['resolver' as SessionId, '✦'], ['writer' as SessionId, '✧'], ['quiet' as SessionId, '✶']]),
    }).split('\n')).toEqual([
      '✦ resolver › Merging the sandbox profile now.',
      '✧ writer › Reconciling the README sections.',
      '✶ quiet',
      '+1 more subagents',
    ])
    const settled = renderActivityBoard(activityBoardView({
      todos: [],
      subagents: [
        child('finished', { state: 'done', note: 'done' }),
        child('failed', { state: 'stopped', note: 'turn failed: E_TEST: boom' }),
      ],
    }), { palette, width: WIDTH })
    expect(settled.split('\n')).toEqual(['✓ finished › done', '✗ failed › turn failed: E_TEST: boom'])
    expect(renderActivityBoard(activityBoardView({ todos: [], subagents: [child('idle')] }), { palette, width: WIDTH })).toBe('▸ idle')
  })

  it('cuts a descendant row to one terminal line, giving the note the room the label leaves', () => {
    const label = 'Resolve narrative documentation merge conflicts (READMEs and Agent Notes) for the in-progress upstream sync branch.'
    const note = 'Reconciling the README sections against the rewrite upstream shipped.'
    const lines = (width: number): string[] =>
      plain(renderActivityBoard(activityBoardView({ todos: [], subagents: [child('kid', { label, note })] }), { palette, width })).split('\n')
    for (const width of [80, 60, 40, 24, 16]) {
      const [row, ...rest] = lines(width)
      expect(rest).toEqual([])
      expect(visibleWidth(row ?? '')).toBeLessThanOrEqual(width)
    }
    expect(lines(80)[0]).toBe('▸ Resolve narrative documentatio… › Reconciling the README sections against the…')
    expect(lines(24)[0]).toBe('▸ Resolve nar… › Reconc…')
    expect(lines(16)[0]).toBe('▸ Resolve narra…')
    expect(plain(renderActivityBoard(activityBoardView({ todos: [], subagents: [child('kid', { label: 'short', note })] }), { palette, width: 40 })))
      .toBe('▸ short › Reconciling the README sectio…')
  })

  it('colors the glyph by state and the stop word as an error', () => {
    const shown = renderActivityBoard(activityBoardView({
      todos: [],
      subagents: [
        child('run', { note: 'Working.' }),
        child('ok', { state: 'done', note: 'done' }),
        child('bad', { state: 'stopped', note: 'aborted' }),
      ],
    }), { palette: color, width: WIDTH })
    expect(shown).toContain('\u001b[38;5;179m▸\u001b[39m run')
    expect(shown).toContain('\u001b[38;5;149m✓\u001b[39m ')
    expect(shown).toContain('\u001b[38;5;210m✗\u001b[39m ')
    expect(shown).toContain('\u001b[38;5;210maborted\u001b[39m')
  })

  it('applies a live fade to a changed todo row and a replaced descendant row, and leaves a settled fade unmarked', () => {
    const view = activityBoardView({
      todos: [{ content: 'read the spec', status: 'completed' }],
      subagents: [child('reviewer', { note: 'Reading the diff.' })],
    })
    const live = renderActivityBoard(view, {
      palette,
      width: WIDTH,
      todoFades: new Map([['read the spec', liveFade()]]),
      subagentFades: new Map([['reviewer' as SessionId, liveFade()]]),
    })
    expect(live).toContain('✓ read the spec')
    expect(live).toContain('reviewer › Reading the diff.')
    const settled = renderActivityBoard(view, {
      palette,
      width: WIDTH,
      todoFades: new Map([['read the spec', settledFade()]]),
      subagentFades: new Map([['reviewer' as SessionId, settledFade()]]),
    })
    expect(settled).toBe(live)
  })
})
