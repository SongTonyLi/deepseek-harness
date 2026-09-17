/** Todo picker rows read from the projection snapshot, and the detail rows one entered row prints. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import { TODO_GLYPH, listTodoChoices, todoDetail } from '../src/todos.ts'

const session = { id: 'session-a' } as Session

/** A projection registry whose one snapshot serves `values`, recording the keys it was asked for. */
function registryOf(values: Record<string, unknown>): { ctx: Context; asked: unknown[] } {
  const ctx = new Context()
  const asked: unknown[] = []
  ctx.provide('sessionProjections', {
    snapshot: (...args: unknown[]) => {
      asked.push(args)
      return { asOfSeq: 7, values }
    },
  } as never)
  return { ctx, asked }
}

const mixed: TodoItem[] = [
  { content: 'read the spec', status: 'completed' },
  { content: 'write the data layer', status: 'in_progress' },
  { content: 'wire the picker', status: 'pending' },
]

describe('TODO_GLYPH', () => {
  it('marks each status with the glyph every todo row leads with', () => {
    expect(TODO_GLYPH).toEqual({ completed: '✓', in_progress: '▸', pending: '○' })
  })
})

describe('listTodoChoices', () => {
  it('numbers each item in list order with its glyph, content, and status word', () => {
    const { ctx, asked } = registryOf({ todos: mixed })
    expect(listTodoChoices(ctx, session)).toEqual([
      { index: 0, label: '✓ read the spec', description: 'completed', status: 'completed' },
      { index: 1, label: '▸ write the data layer', description: 'in progress · being worked on now', status: 'in_progress' },
      { index: 2, label: '○ wire the picker', description: 'pending', status: 'pending' },
    ])
    expect(asked).toEqual([[session, ['todos']]])
  })

  it('ends a content line past the row cap in an ellipsis and keeps one exactly at it whole', () => {
    const exact = 'e'.repeat(64)
    const over = `${'o'.repeat(64)} and more`
    const { ctx } = registryOf({ todos: [{ content: exact, status: 'pending' }, { content: over, status: 'pending' }] })
    const [kept, cut] = listTodoChoices(ctx, session)
    expect(kept?.label).toBe(`○ ${exact}`)
    expect(cut?.label).toBe(`○ ${'o'.repeat(63)}…`)
  })

  it('measures the row cap in terminal columns, so wide characters reach it in half the characters', () => {
    const { ctx } = registryOf({ todos: [{ content: '你好'.repeat(40), status: 'completed' }] })
    // 31 wide characters fill 62 of the 63 columns left beside the ellipsis; a
    // 32nd would straddle the cut, so it is dropped instead of halved.
    expect(listTodoChoices(ctx, session)[0]?.label).toBe(`✓ ${'你好'.repeat(15)}你…`)
  })

  it('returns nothing without a registry, without the registered key, and before the first write', () => {
    expect(listTodoChoices(new Context(), session)).toEqual([])
    expect(listTodoChoices(registryOf({}).ctx, session)).toEqual([])
    expect(listTodoChoices(registryOf({ todos: null }).ctx, session)).toEqual([])
  })
})

describe('todoDetail', () => {
  it('names the status of each item beside its position and the list counts', () => {
    expect(todoDetail(mixed, 0)).toEqual([
      'read the spec',
      'status: completed',
      'item 1 of 3',
      '1 completed · 1 in progress · 1 pending',
    ])
    expect(todoDetail(mixed, 1)).toEqual([
      'write the data layer',
      'status: in progress',
      'item 2 of 3',
      '1 completed · 1 in progress · 1 pending',
    ])
    expect(todoDetail(mixed, 2)).toEqual([
      'wire the picker',
      'status: pending',
      'item 3 of 3',
      '1 completed · 1 in progress · 1 pending',
    ])
  })

  it('shows the full content the row truncated, wrapped into reading columns', () => {
    const content = 'Write the pure data layer for the navigable todo list so arrow keys move between items and Enter shows one item in full'
    const rows = todoDetail([{ content, status: 'in_progress' }], 0)
    expect(rows.slice(0, 2)).toEqual([
      'Write the pure data layer for the navigable todo list so arrow keys move',
      'between items and Enter shows one item in full',
    ])
    expect(rows.slice(2)).toEqual(['status: in progress', 'item 1 of 1', '0 completed · 1 in progress · 0 pending'])
    expect(rows.slice(0, 2).join(' ')).toBe(content)
  })

  it('counts a longer list by status, keeping the statuses that no item holds', () => {
    const items: TodoItem[] = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'in_progress' },
      { content: 'd', status: 'pending' },
      { content: 'e', status: 'pending' },
      { content: 'f', status: 'pending' },
      { content: 'g', status: 'pending' },
    ]
    expect(todoDetail(items, 2).slice(2)).toEqual(['item 3 of 7', '2 completed · 1 in progress · 4 pending'])
    expect(todoDetail([{ content: 'only', status: 'pending' }], 0).at(-1)).toBe('0 completed · 0 in progress · 1 pending')
  })

  it('reports both turns when the status moved after the item appeared', () => {
    expect(todoDetail(mixed, 1, { firstTurn: 4, statusTurn: 6 }).slice(3)).toEqual([
      '1 completed · 1 in progress · 1 pending',
      'first written in turn 4',
      'status last changed in turn 6',
    ])
  })

  it('reports the appearance turn alone when the item still holds the status it was written with', () => {
    expect(todoDetail(mixed, 2, { firstTurn: 3, statusTurn: 3 }).slice(3)).toEqual([
      '1 completed · 1 in progress · 1 pending',
      'first written in turn 3',
    ])
  })

  it('omits both turn rows when the caller tracked nothing for the item', () => {
    expect(todoDetail(mixed, 0)).toHaveLength(4)
  })

  it('names the missing item instead of throwing when the index is outside the list', () => {
    expect(todoDetail(mixed, 3)).toEqual(['no todo item 4 of 3'])
    expect(todoDetail(mixed, -1)).toEqual(['no todo item 0 of 3'])
    expect(todoDetail([], 0, { firstTurn: 1, statusTurn: 2 })).toEqual(['no todo item 1 of 0'])
  })
})
