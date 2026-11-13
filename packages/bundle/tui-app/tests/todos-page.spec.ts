/** The todos page: the heading, the tree and detail panes, both layouts, the keys, and the motion. */

import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { createPalette } from '../src/style.ts'
import type { TeamMemberRow } from '../src/team-panel.ts'
import {
  TODOS_PAGE_CHANGE_LIFT_TICKS,
  TODOS_PAGE_DETAIL_FADE_STEPS,
  TODOS_PAGE_EMPTY,
  TODOS_PAGE_HINTS,
  TODOS_PAGE_REVEAL_LIFT_TICKS,
  TODOS_PAGE_REVEAL_STEPS,
  TODOS_PAGE_STACK_BELOW,
  TodosPage,
  WORK_GLYPH,
  todosPageFrame,
  type TodosPageDraw,
  type TodosPageOptions,
  type TodosPageSource,
} from '../src/todos-page.ts'
import type { WorkNode, WorkOwner, WorkState, WorkTree } from '../src/work-tree.ts'

const palette = createPalette(false)
const colors = createPalette(true)

/** One spinner period of the application, in milliseconds. */
const STEP = 100

/** The instant every page in these tests opens at. */
const OPENED = 1_000

const UP = '\u001b[A'
const DOWN = '\u001b[B'
const RIGHT = '\u001b[C'
const LEFT = '\u001b[D'
const PAGE_UP = '\u001b[5~'
const PAGE_DOWN = '\u001b[6~'
const ENTER = '\r'
const ESCAPE = '\u001b'

const ada: WorkOwner = { id: 'session-ada', name: 'ada', role: 'parser work', status: 'running' }
const bo: WorkOwner = { id: 'session-bo', name: 'bo', role: 'writes the docs', status: 'inactive' }
const leadOwner: WorkOwner = { id: 'session-lead', name: 'lead', role: 'orchestrator', status: 'running' }

function member(row: Pick<TeamMemberRow, 'id' | 'name' | 'role' | 'status'>): TeamMemberRow {
  return { diagnostics: [], ...row }
}

const roster: readonly TeamMemberRow[] = [
  member({ id: 'session-lead', name: 'lead', role: 'lead', status: 'running' }),
  member({ id: 'session-ada', name: 'ada', role: 'teammate', status: 'running' }),
  member({ id: 'session-bo', name: 'bo', role: 'teammate', status: 'inactive' }),
  member({ id: 'session-prep', name: 'prep', role: 'teammate', status: 'provisioning' }),
  member({ id: 'session-broken', name: 'broken', role: 'teammate', status: 'failed' }),
]

function node(parts: Pick<WorkNode, 'key' | 'kind' | 'title' | 'state'> & Partial<WorkNode>): WorkNode {
  return { children: [], ...parts }
}

function task(id: string, title: string, state: WorkState, parts: Partial<WorkNode> = {}): WorkNode {
  return node({ key: `task:${id}`, kind: 'task', title, state, taskId: id, ...parts })
}

function todo(parent: string, title: string, state: WorkState, parts: Partial<WorkNode> = {}): WorkNode {
  return node({ key: `${parent}/todo:${title}`, kind: 'todo', title, state, ...parts })
}

function own(children: WorkNode[], state: WorkState = 'in_progress', owner: WorkOwner | undefined = leadOwner): WorkNode {
  return node({ key: 'own', kind: 'own', title: 'lead', state, children, ...owner === undefined ? {} : { owner } })
}

/** A tree whose counts cover the top-level tasks and the todos of the `own` branch, as the tree builder counts them. */
function tree(nodes: WorkNode[]): WorkTree {
  const counts: Record<WorkState, number> = { delivered: 0, in_progress: 0, stuck: 0, deferred: 0, pending: 0 }
  const counted = nodes.flatMap(top => top.kind === 'own' ? top.children : [top])
  for (const item of counted) counts[item.state] += 1
  return { nodes, counts, total: counted.length }
}

const parser = task('1', 'Build the parser', 'in_progress', {
  owner: ada,
  description: 'Parse the config format into an AST and report every syntax error with its line.',
  blocks: ['3'],
  note: 'reading the grammar file',
  writeScopes: ['src/parser/**'],
  children: [
    todo('task:1', 'write tokenizer', 'delivered', { owner: ada }),
    todo('task:1', 'handle errors', 'in_progress', { owner: ada }),
    todo('task:1', 'add tests', 'pending', { owner: ada }),
  ],
})
const docs = task('2', 'Write docs', 'pending', {
  owner: bo,
  children: [todo('task:2', 'outline', 'pending', { owner: bo }), todo('task:2', 'draft', 'pending', { owner: bo })],
})
const release = task('3', 'Release', 'stuck', { reason: 'blocked', waitsOn: ['1', '2'] })
const ownBranch = own([
  todo('own', 'plan', 'delivered', { owner: leadOwner, turns: { firstTurn: 1, statusTurn: 1 } }),
  todo('own', 'implement', 'in_progress', { owner: leadOwner, turns: { firstTurn: 1, statusTurn: 3 } }),
  todo('own', 'verify', 'deferred', { owner: leadOwner, reason: 'left_open' }),
])

/** Ten visible rows while `#2` is folded, as the page opens on it. */
const board: WorkNode[] = [parser, docs, release, ownBranch]

/** The tree rows of {@link board} with `#2` folded, as the left pane draws them. */
const BOARD_ROWS = [
  '❯ ▾ ◐ #1 Build the parser  1/3',
  '      ✓ write tokenizer',
  '      ◐ handle errors',
  '      ○ add tests',
  '  ▸ ○ #2 Write docs  0/2',
  '    ⊘ #3 Release',
  '  ▾ ◐ lead · 1/3',
  '      ✓ plan',
  '      ◐ implement',
  '      ◌ verify',
]

/** Sixty tasks, the first worked on with forty todos, the rest pending without any. */
function largeBoard(): WorkNode[] {
  const todos = Array.from({ length: 40 }, (_, index) => todo('task:1', `step ${String(index + 1)}`, index < 10 ? 'delivered' : 'pending', { owner: ada }))
  return [
    task('1', 'The big one', 'in_progress', { owner: ada, children: todos }),
    ...Array.from({ length: 59 }, (_, index) => task(String(index + 2), `task number ${String(index + 2)}`, 'pending')),
  ]
}

function source(nodes: WorkNode[] = board, parts: Partial<TodosPageSource> = {}): TodosPageSource {
  return {
    tree: tree(nodes),
    spinner: () => undefined,
    member: id => roster.find(row => row.id === id),
    ...parts,
  }
}

function draw(parts: Partial<TodosPageDraw> = {}): TodosPageDraw {
  return {
    palette,
    source: source(),
    selected: undefined,
    folded: new Set(['task:2']),
    top: 0,
    notice: undefined,
    width: 100,
    rows: 24,
    motion: undefined,
    ...parts,
  }
}

/** Drop the SGR sequences, including the resets the width cutter writes around an ellipsis. */
function strip(line: string): string {
  return line.replace(/\u001b\[[0-9;]*m/gu, '')
}

function frame(parts: Partial<TodosPageDraw> = {}): string[] {
  return todosPageFrame(draw(parts)).lines.map(strip)
}

/** The left pane of each body row of a two-pane frame. */
function treeColumn(lines: readonly string[]): string[] {
  return lines.slice(2).map(line => line.slice(0, line.indexOf(' │')).trimEnd())
}

/** The right pane of each body row of a two-pane frame, trailing blank rows dropped. */
function detailColumn(lines: readonly string[]): string[] {
  const right = lines.slice(2).map(line => line.slice(line.indexOf('│') + 2))
  while (right.at(-1) === '') right.pop()
  return right
}

/** The detail of one node in a wide two-pane frame. */
function detailOf(selected: string, nodes: WorkNode[] = board, folded: ReadonlySet<string> = new Set()): string[] {
  return detailColumn(frame({ source: source(nodes), selected, folded, width: 120, rows: 60 }))
}

/** A page on a clock the test moves. */
function open(read: () => TodosPageSource, parts: Partial<TodosPageOptions> = {}): { page: TodosPage; clock: { now: number } } {
  const clock = { now: OPENED }
  const page = new TodosPage({ palette, source: read, now: () => clock.now, stepMs: STEP, motion: false, ...parts })
  return { page, clock }
}

/** The tree row the selection marker is on. */
function picked(lines: readonly string[]): string | undefined {
  return lines.map(strip).find(line => line.startsWith('❯'))?.split(' │')[0]?.trimEnd()
}

/** Render the page once per step from `start`, `steps` times. */
function playSteps(
  page: TodosPage,
  clock: { now: number },
  start: number,
  steps: number,
  size: readonly [number, number] = [100, 24],
): { frames: string[][]; animates: boolean[] } {
  const frames: string[][] = []
  const animates: boolean[] = []
  for (let step = 0; step < steps; step += 1) {
    clock.now = start + step * STEP
    frames.push(page.render(...size))
    animates.push(page.animates())
  }
  return { frames, animates }
}

/** Each line moves only forward: once it leaves a look, it never draws that look again. */
function expectMonotonic(frames: readonly (readonly string[])[]): void {
  const count = frames[0]?.length ?? 0
  for (const lines of frames) expect(lines).toHaveLength(count)
  for (let line = 0; line < count; line += 1) {
    const looks: string[] = []
    for (const lines of frames) {
      const look = lines[line] as string
      if (looks.at(-1) === look) continue
      expect(looks, `line ${String(line)} returns to an earlier look`).not.toContain(look)
      looks.push(look)
    }
  }
}

/** The frame a page without motion draws for the same reads, keys, and size. */
function stillFrame(read: () => TodosPageSource, keys: readonly string[], size: readonly [number, number] = [100, 24]): string[] {
  const { page } = open(read, { palette: colors })
  page.render(...size)
  for (const key of keys) page.handleInput(key)
  return page.render(...size)
}

describe('the heading', () => {
  it('counts the delivered items over all of them, then each other state that has any', () => {
    expect(frame()[0]).toBe('todos · 1/6 delivered · 2 in progress · 1 stuck · 1 deferred')
    expect(frame({ source: source([task('1', 'one', 'pending'), task('2', 'two', 'delivered')]) })[0]).toBe('todos · 1/2 delivered')
  })

  it('narrows the legend with the width and lets a notice take its place', () => {
    expect(frame({ width: 140 })[1]).toBe(TODOS_PAGE_HINTS[0])
    expect(frame({ width: 80 })[1]).toBe(TODOS_PAGE_HINTS[1])
    expect(frame({ width: 50 })[1]).toBe(TODOS_PAGE_HINTS[2])
    expect(frame({ width: 30 })[1]).toBe(TODOS_PAGE_HINTS[3])
    expect(frame({ width: 20 })[1]).toBe(TODOS_PAGE_HINTS[4])
    expect(frame({ notice: '#3 has no owner yet' })[1]).toBe('#3 has no owner yet')
  })

  it('says how the list fills in while the tree has no node, wrapping on a narrow screen', () => {
    const empty = todosPageFrame(draw({ source: source([]) }))
    expect(empty.lines.map(strip)).toEqual(['todos · 0/0 delivered', TODOS_PAGE_HINTS[0], `  ${TODOS_PAGE_EMPTY}`, ...Array<string>(21).fill('')])
    expect(empty).toMatchObject({ top: 0, page: 1, treeLines: 0, animated: false })
    const narrow = frame({ source: source([]), width: 40 })
    expect(narrow.slice(2, 5)).toEqual(['  No todos or shared tasks yet — the', '  list fills in when the agent plans its', '  work.'])
  })
})

describe('the tree', () => {
  it('draws one row per visible node with its marker, indent, fold marker, glyph, and title', () => {
    const lines = frame()
    expect(treeColumn(lines).slice(0, 10)).toEqual(BOARD_ROWS)
    expect(treeColumn(lines).slice(10).every(row => row === '')).toBe(true)
  })

  it('declares a glyph for every state, sharing the todo list markers where they mean the same', () => {
    expect(WORK_GLYPH).toEqual({ delivered: '✓', in_progress: '◐', stuck: '⊘', deferred: '◌', pending: '○' })
  })

  it('moves the selection marker to the selected node and falls back to the first row for an unknown key', () => {
    expect(picked(todosPageFrame(draw({ selected: 'task:3' })).lines)).toBe('❯   ⊘ #3 Release')
    expect(picked(todosPageFrame(draw({ selected: 'task:2/todo:outline' })).lines)).toBe(BOARD_ROWS[0])
  })

  it('cuts a title down to its least columns before the child count gives way to it', () => {
    const own = (width: number): string | undefined => frame({ width, rows: 30 }).slice(2, 12).find(line => line.includes('lead'))
    expect(frame({ width: 30, rows: 30 })[2]).toBe('❯ ▾ ◐ #1 Build the parser  1/3')
    expect(frame({ width: 25, rows: 30 })[2]).toBe('❯ ▾ ◐ #1 Build the …  1/3')
    expect(frame({ width: 23, rows: 30 })[2]).toBe('❯ ▾ ◐ #1 Build th…  1/3')
    expect(frame({ width: 22, rows: 30 })[2]).toBe('❯ ▾ ◐ #1 Build the pa…')
    expect(own(16)).toBe('  ▾ ◐ lead · 1/3')
    expect(own(15)).toBe('  ▾ ◐ lead')
  })

  it('collapses the whitespace of a title onto one row', () => {
    const lines = frame({ source: source([task('1', 'two\n  lines', 'pending')]) })
    expect(treeColumn(lines)[0]).toBe('❯   ○ #1 two lines')
  })

  it('scratches out a delivered todo as the activity board does, dims a delivered task, and bolds the own branch', () => {
    const nodes = [task('1', 'shipped', 'delivered', { children: [todo('task:1', 'done item', 'delivered'), todo('task:1', 'open item', 'pending')] }), own([todo('own', 'mine', 'delivered')], 'delivered')]
    const lines = todosPageFrame(draw({ palette: colors, source: source(nodes), folded: new Set(), selected: 'own', width: 60 })).lines
    const row = (text: string): string => lines.find(line => strip(line).includes(text)) as string
    expect(row('done item')).toContain(colors.dim(colors.strikethrough('done item')))
    expect(row('open item')).not.toContain('\u001b[9m')
    expect(row('#1 shipped')).toContain(colors.dim('#1 shipped'))
    expect(row('mine')).toContain(colors.dim(colors.strikethrough('mine')))
    expect(row('lead')).toContain(colors.bold(colors.accent(colors.dim('lead'))))
    const working = todosPageFrame(draw({ palette: colors, source: source([own([todo('own', 'mine', 'pending')])]), selected: 'own/todo:mine', width: 60 })).lines
    expect(working.find(line => strip(line).includes('lead'))).toContain(colors.bold('lead'))
  })
})

describe('the detail', () => {
  it('lists every block a task has, in order', () => {
    expect(detailOf('task:1')).toEqual([
      '#1 Build the parser',
      'owner  ada · parser work · running',
      'state  in progress',
      '',
      'Subtasks 1/3',
      '  ✓ write tokenizer',
      '  ◐ handle errors',
      '  ○ add tests',
      '',
      'Blocks',
      '  #3 Release',
      '',
      'Scopes',
      '  src/parser/**',
      '',
      'Now',
      '  “reading the grammar file”',
      '',
      'Parse the config format into an AST and report every syntax',
      'error with its line.',
    ])
  })

  it('names the tasks a task waits on by their subjects, and an unknown id alone', () => {
    expect(detailOf('task:3')).toEqual([
      '#3 Release',
      'owner  unowned',
      'state  stuck · waits on #1, #2',
      '',
      'Waits on',
      '  #1 Build the parser',
      '  #2 Write docs',
    ])
    const nodes = [task('4', 'later', 'stuck', { reason: 'blocked', waitsOn: ['9'], blocks: ['1'] }), parser]
    expect(detailOf('task:4', nodes).slice(3)).toEqual(['', 'Waits on', '  #9', '', 'Blocks', '  #1 Build the parser'])
  })

  it('details the own branch and its todos with the turns they were written and changed in', () => {
    expect(detailOf('own')).toEqual([
      'lead',
      'owner  lead · orchestrator · running',
      'state  in progress',
      '',
      'Subtasks 1/3',
      '  ✓ plan',
      '  ◐ implement',
      '  ◌ verify',
    ])
    expect(detailOf('own/todo:implement')).toEqual([
      'implement',
      'owner  lead · orchestrator · running',
      'state  in progress',
      '',
      'first written in turn 1',
      'status last changed in turn 3',
    ])
    expect(detailOf('own/todo:plan').slice(3)).toEqual(['', 'first written in turn 1'])
    expect(detailOf('own/todo:verify')).toEqual(['verify', 'owner  lead · orchestrator · running', 'state  deferred · left open when the turn ended'])
  })

  it('omits every block a node has nothing for', () => {
    const bare = task('5', 'bare', 'pending', { owner: { name: 'zed', role: 'reviews\n  the diff' }, note: '  ', description: '\n' })
    expect(detailOf('task:5', [bare])).toEqual(['#5 bare', 'owner  zed · reviews the diff', 'state  pending'])
  })

  it('spells out each reason a node is stuck or deferred', () => {
    const reasons: [Partial<WorkNode>, string][] = [
      [{ state: 'stuck', reason: 'blocked', waitsOn: ['2', '3'] }, 'stuck · waits on #2, #3'],
      [{ state: 'stuck', reason: 'blocked' }, 'stuck · waits on another task'],
      [{ state: 'stuck', reason: 'owner_idle' }, 'stuck · owner idle'],
      [{ state: 'stuck', reason: 'owner_failed' }, 'stuck · owner failed to start'],
      [{ state: 'deferred', reason: 'released' }, 'deferred · released by its owner'],
      [{ state: 'deferred', reason: 'reopened' }, 'deferred · reopened'],
      [{ state: 'deferred', reason: 'left_open' }, 'deferred · left open when the turn ended'],
      [{ state: 'delivered' }, 'delivered'],
    ]
    for (const [parts, sentence] of reasons) {
      expect(detailOf('task:7', [task('7', 'subject', 'pending', parts)])[2]).toBe(`state  ${sentence}`)
    }
  })

  it('wraps a long title and keeps the blocks after it', () => {
    const long = task('8', 'a subject long enough that the detail pane has to wrap it onto a second line', 'pending')
    expect(detailColumn(frame({ source: source([long]), width: 100 })).slice(0, 3)).toEqual([
      '#8 a subject long enough that the detail pane has to',
      'wrap it onto a second line',
      'owner  unowned',
    ])
  })
})

describe('the layout', () => {
  it('stacks the panes below the threshold and sets them side by side from it', () => {
    const stacked = frame({ width: TODOS_PAGE_STACK_BELOW - 1, rows: 30 })
    expect(stacked.slice(2, 12)).toEqual(BOARD_ROWS)
    expect(stacked[12]).toBe('─'.repeat(TODOS_PAGE_STACK_BELOW - 1))
    expect(stacked[13]).toBe('#1 Build the parser')
    expect(stacked.some(line => line.includes('│'))).toBe(false)
    const sideBySide = frame({ width: TODOS_PAGE_STACK_BELOW, rows: 30 })
    expect(sideBySide.slice(2).every(line => line.includes(' │'))).toBe(true)
    expect(sideBySide.some(line => line.startsWith('─'))).toBe(false)
  })

  it('gives the tree about 45% of the width between its least and most columns', () => {
    const column = (width: number): number => (frame({ width })[2] as string).indexOf('│') - 1
    expect(column(72)).toBe(34)
    expect(column(100)).toBe(45)
    expect(column(120)).toBe(54)
    expect(column(140)).toBe(60)
  })

  it('lets the stacked tree take what it needs up to its share while the detail keeps four rows', () => {
    const lines = (rows: number): string[] => frame({ width: 60, rows })
    expect(lines(30).indexOf('─'.repeat(60))).toBe(12)
    expect(lines(12).indexOf('─'.repeat(60))).toBe(7)
    expect(lines(12).slice(2, 7)).toEqual(BOARD_ROWS.slice(0, 4).concat('  +6 more'))
    expect(lines(12).slice(8)).toEqual(['#1 Build the parser', 'owner  ada · parser work · running', 'state  in progress', '+17 more'])
    expect(lines(10).indexOf('─'.repeat(60))).toBe(5)
    expect(lines(4)).toEqual([expect.any(String), expect.any(String), BOARD_ROWS[0], '─'.repeat(60)])
    expect(lines(3)[2]).toBe(BOARD_ROWS[0])
  })

  it('returns exactly the rows asked for, each line within the width, at every size', () => {
    const selections = [undefined, 'task:30', 'task:60', 'task:1/todo:step 20']
    const widths = [...Array.from({ length: 20 }, (_, index) => 1 + index * 7), 71, 72, 73, 140]
    for (const width of widths) {
      for (let rows = 1; rows <= 50; rows += 7) {
        for (const selected of selections) {
          const read = source(largeBoard(), { spinner: slot => slot % 2 === 0 ? '⠋' : undefined })
          const motion = { now: OPENED + 3 * STEP, stepMs: STEP, openedAt: OPENED, openingLines: undefined, unfolded: new Map(), changed: new Map([['task:2', OPENED + STEP]]) }
          const drawn = todosPageFrame(draw({ source: read, selected, folded: new Set(), width, rows, notice: 'a notice that is long enough to need cutting on a narrow terminal', motion, top: 5 }))
          expect(drawn.lines, `${String(width)}x${String(rows)}`).toHaveLength(rows)
          for (const line of drawn.lines) expect(visibleWidth(line), `${String(width)}x${String(rows)}`).toBeLessThanOrEqual(width)
        }
        const small = frame({ width, rows })
        expect(small).toHaveLength(rows)
        for (const line of small) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })

  it('treats a degenerate size as one cell', () => {
    expect(frame({ width: 0, rows: 0 })).toEqual(['…'])
  })

  it('keeps the selection and the folds while the terminal is resized across the threshold', () => {
    const { page } = open(() => source())
    page.render(100, 24)
    for (const key of [DOWN, DOWN, DOWN, DOWN, RIGHT, 'g', LEFT, DOWN]) page.handleInput(key)
    const before = page.render(100, 24)
    expect(treeColumn(before.map(strip)).slice(0, 5)).toEqual(['  ▸ ◐ #1 Build the parser  1/3', '❯ ▾ ○ #2 Write docs  0/2', '      ○ outline', '      ○ draft', '    ⊘ #3 Release'])
    for (const [width, rows] of [[60, 24], [140, 40], [72, 10], [71, 10], [1, 1], [30, 5], [73, 3], [100, 24]] as const) {
      const lines = page.render(width, rows)
      expect(lines).toHaveLength(rows)
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
      if (rows > 2) expect(lines.map(strip).find(line => line.startsWith('❯'))).toContain('#2 Write docs')
    }
    expect(page.render(100, 24)).toEqual(before)
  })
})

describe('the keys', () => {
  it('closes on Escape and q and ignores a key it does not know', () => {
    const { page } = open(() => source())
    expect(page.handleInput(ESCAPE)).toEqual({ kind: 'close' })
    expect(page.handleInput('q')).toEqual({ kind: 'close' })
    expect(page.handleInput('z')).toBeUndefined()
  })

  it('moves the selection with the arrows and j k, stops at the ends, and jumps with g and G', () => {
    const { page } = open(() => source())
    page.render(100, 24)
    page.handleInput(UP)
    expect(picked(page.render(100, 24))).toBe(BOARD_ROWS[0])
    page.handleInput(DOWN)
    expect(picked(page.render(100, 24))).toBe('❯     ✓ write tokenizer')
    page.handleInput('j')
    page.handleInput('j')
    page.handleInput('k')
    expect(picked(page.render(100, 24))).toBe('❯     ◐ handle errors')
    page.handleInput('G')
    expect(picked(page.render(100, 24))).toBe('❯     ◌ verify')
    page.handleInput(DOWN)
    expect(picked(page.render(100, 24))).toBe('❯     ◌ verify')
    page.handleInput('g')
    expect(picked(page.render(100, 24))).toBe(BOARD_ROWS[0])
  })

  it('unfolds with the right arrow, then steps into the first child, and does nothing on a leaf', () => {
    const { page } = open(() => source())
    page.render(100, 24)
    for (let press = 0; press < 4; press += 1) page.handleInput(DOWN)
    page.handleInput(RIGHT)
    expect(treeColumn(page.render(100, 24).map(strip)).slice(4, 7)).toEqual(['❯ ▾ ○ #2 Write docs  0/2', '      ○ outline', '      ○ draft'])
    page.handleInput(RIGHT)
    expect(picked(page.render(100, 24))).toBe('❯     ○ outline')
    page.handleInput(RIGHT)
    expect(picked(page.render(100, 24))).toBe('❯     ○ outline')
  })

  it('folds with the left arrow, or steps out to the parent of a leaf, and stays on a folded top row', () => {
    const { page } = open(() => source())
    page.render(100, 24)
    page.handleInput(DOWN)
    page.handleInput(LEFT)
    expect(picked(page.render(100, 24))).toBe(BOARD_ROWS[0])
    page.handleInput(LEFT)
    expect(treeColumn(page.render(100, 24).map(strip)).slice(0, 3)).toEqual(['❯ ▸ ◐ #1 Build the parser  1/3', '  ▸ ○ #2 Write docs  0/2', '    ⊘ #3 Release'])
    page.handleInput(LEFT)
    expect(picked(page.render(100, 24))).toBe('❯ ▸ ◐ #1 Build the parser  1/3')
  })

  it('opens the session of a running or inactive owner', () => {
    const { page } = open(() => source())
    page.render(100, 24)
    expect(page.handleInput(ENTER)).toMatchObject({ kind: 'open', entry: { heading: 'ada' }, choice: { id: 'session-ada', label: 'ada', target: 'session', mode: 'continuable' } })
    page.handleInput('j')
    expect(page.handleInput(ENTER)).toMatchObject({ kind: 'open', choice: { id: 'session-ada' } })
    page.handleInput('g')
    for (let press = 0; press < 4; press += 1) page.handleInput(DOWN)
    expect(page.handleInput(ENTER)).toMatchObject({ kind: 'open', choice: { id: 'session-bo' } })
  })

  it('says why Enter opens nothing, and the next key takes the notice down', () => {
    const owners: [WorkOwner | undefined, string][] = [
      [{ id: 'session-prep', name: 'prep', role: 'teammate', status: 'provisioning' }, 'prep is still being created'],
      [{ id: 'session-broken', name: 'broken', role: 'teammate', status: 'failed' }, 'broken failed to start; /team lists its diagnostics'],
      [{ id: 'session-lead', name: 'lead', role: 'orchestrator', status: 'running' }, 'the lead has no teammate session to open'],
      [{ name: 'zed', role: 'teammate' }, 'zed is not on the team roster'],
      [{ id: 'session-gone', name: 'gone', role: 'teammate', status: 'running' }, 'gone is not on the team roster'],
      [undefined, '#4 has no owner yet'],
    ]
    for (const [owner, notice] of owners) {
      const { page } = open(() => source([task('4', 'subject', 'pending', owner === undefined ? {} : { owner })]))
      page.render(100, 24)
      expect(page.handleInput(ENTER)).toBeUndefined()
      expect(strip(page.render(100, 24)[1] as string)).toBe(notice)
      page.handleInput('x')
      expect(strip(page.render(100, 24)[1] as string)).toBe(TODOS_PAGE_HINTS[0])
    }
  })

  it('names the session the user is in for the own branch, its todos, and a task the bound session owns', () => {
    const nodes = [task('1', 'lead work', 'pending', { owner: leadOwner }), own([todo('own', 'mine', 'pending', { owner: leadOwner })])]
    const { page } = open(() => source(nodes))
    page.render(100, 24)
    for (const key of [ENTER, 'j', 'j']) {
      page.handleInput(key)
      expect(page.handleInput(ENTER)).toBeUndefined()
      expect(strip(page.render(100, 24)[1] as string)).toBe('lead is the session you are in')
    }
    const anonymous = { name: 'me', role: 'orchestrator' }
    const unlisted = open(() => source([own([todo('own', 'mine', 'pending', { owner: anonymous })], 'pending', anonymous)]))
    unlisted.page.render(100, 24)
    unlisted.page.handleInput('j')
    unlisted.page.handleInput(ENTER)
    expect(strip(unlisted.page.render(100, 24)[1] as string)).toBe('me is the session you are in')
    const ownerless = open(() => source([task('2', 'loose', 'pending', { owner: ada }), own([todo('own', 'mine', 'pending')], 'pending', undefined)]))
    ownerless.page.render(100, 24)
    expect(ownerless.page.handleInput(ENTER)).toMatchObject({ kind: 'open', choice: { id: 'session-ada' } })
    ownerless.page.handleInput('G')
    ownerless.page.handleInput(ENTER)
    expect(strip(ownerless.page.render(100, 24)[1] as string)).toBe('this item has no owner yet')
  })

  it('scrolls the detail with PgUp and PgDn, clamps at both ends, and starts over on another row', () => {
    const { page } = open(() => source(largeBoard()))
    const first = page.render(100, 24).map(strip)
    expect(detailColumn(first).slice(0, 5)).toEqual(['#1 The big one', 'owner  ada · parser work · running', 'state  in progress', '', 'Subtasks 10/40'])
    expect(detailColumn(first).at(-1)).toBe('+24 more')
    page.handleInput(PAGE_DOWN)
    const down = detailColumn(page.render(100, 24).map(strip))
    expect(down[0]).toBe('+20 more above')
    expect(down[1]).toBe('  ○ step 16')
    expect(down.at(-1)).toBe('+5 more')
    for (let press = 0; press < 5; press += 1) page.handleInput(PAGE_DOWN)
    const end = detailColumn(page.render(100, 24).map(strip))
    expect(end.at(-1)).toBe('  ○ step 40')
    expect(end[0]).toBe('+24 more above')
    page.handleInput(PAGE_UP)
    page.handleInput(PAGE_UP)
    page.handleInput(PAGE_UP)
    expect(detailColumn(page.render(100, 24).map(strip))[0]).toBe('#1 The big one')
    page.handleInput(PAGE_DOWN)
    page.handleInput(DOWN)
    expect(detailColumn(page.render(100, 24).map(strip))[0]).toBe('step 1')
  })

  it('handles every key on an empty tree without a selection', () => {
    const { page } = open(() => source([]))
    page.render(100, 24)
    for (const key of [UP, DOWN, RIGHT, LEFT, ENTER, 'g', 'G', PAGE_UP, PAGE_DOWN]) expect(page.handleInput(key)).toBeUndefined()
    expect(page.render(100, 24).map(strip)[2]).toBe(`  ${TODOS_PAGE_EMPTY}`)
  })
})

describe('the selection and the folds across tree changes', () => {
  it('follows the selected node when rows move, and falls to the row at its place when it vanishes', () => {
    let nodes = board
    const { page } = open(() => source(nodes))
    page.render(100, 24)
    for (let press = 0; press < 5; press += 1) page.handleInput(DOWN)
    expect(picked(page.render(100, 24))).toBe('❯   ⊘ #3 Release')
    nodes = [task('0', 'Kickoff', 'pending'), ...board]
    expect(picked(page.render(100, 24))).toBe('❯   ⊘ #3 Release')
    nodes = nodes.filter(item => item !== release)
    expect(picked(page.render(100, 24))).toBe('❯ ▾ ◐ lead · 1/3')
    nodes = []
    expect(page.render(100, 24).map(strip)[2]).toBe(`  ${TODOS_PAGE_EMPTY}`)
    nodes = [parser]
    expect(picked(page.render(100, 24))).toBe('❯     ○ add tests')
  })

  it('opens worked and stuck tasks and the own branch, and folds every other task with todos', () => {
    const child = (parent: string): WorkNode[] => [todo(parent, 'item', 'pending')]
    const nodes = [
      task('1', 'worked', 'in_progress', { children: child('task:1') }),
      task('2', 'stuck', 'stuck', { reason: 'owner_idle', children: child('task:2') }),
      task('3', 'waiting', 'pending', { children: child('task:3') }),
      task('4', 'shipped', 'delivered', { children: child('task:4') }),
      task('5', 'parked', 'deferred', { reason: 'released', children: child('task:5') }),
      own(child('own'), 'pending'),
    ]
    const { page } = open(() => source(nodes))
    expect(treeColumn(page.render(100, 24).map(strip)).slice(0, 10)).toEqual([
      '❯ ▾ ◐ #1 worked  0/1',
      '      ○ item',
      '  ▾ ⊘ #2 stuck  0/1',
      '      ○ item',
      '  ▸ ○ #3 waiting  0/1',
      '  ▸ ✓ #4 shipped  0/1',
      '  ▸ ◌ #5 parked  0/1',
      '  ▾ ○ lead · 0/1',
      '      ○ item',
      '',
    ])
  })

  it('applies the same rule to a node that appears later, decided when it first has todos', () => {
    let nodes: WorkNode[] = [task('1', 'claimed later', 'pending')]
    const { page } = open(() => source(nodes))
    page.render(100, 24)
    nodes = [
      task('1', 'claimed later', 'in_progress', { children: [todo('task:1', 'first', 'pending')] }),
      task('2', 'new and waiting', 'pending', { children: [todo('task:2', 'second', 'pending')] }),
      task('3', 'new and worked', 'in_progress', { children: [todo('task:3', 'third', 'pending')] }),
    ]
    expect(treeColumn(page.render(100, 24).map(strip)).slice(0, 5)).toEqual([
      '❯ ▾ ◐ #1 claimed later  0/1',
      '      ○ first',
      '  ▸ ○ #2 new and waiting  0/1',
      '  ▾ ◐ #3 new and worked  0/1',
      '      ○ third',
    ])
  })

  it('forgets a node that vanished, so it follows the rule again when it returns', () => {
    let nodes = board
    const { page } = open(() => source(nodes))
    page.render(100, 24)
    page.handleInput(LEFT)
    expect(treeColumn(page.render(100, 24).map(strip))[0]).toBe('❯ ▸ ◐ #1 Build the parser  1/3')
    nodes = [docs]
    page.render(100, 24)
    nodes = board
    expect(treeColumn(page.render(100, 24).map(strip))[1]).toBe('      ✓ write tokenizer')
  })
})

describe('a large board', () => {
  it('scrolls the tree to keep the selection in view with a count row on each cut side', () => {
    const { page } = open(() => source(largeBoard()))
    const top = treeColumn(page.render(100, 24).map(strip))
    expect(top[0]).toBe('❯ ▾ ◐ #1 The big one  10/40')
    expect(top.at(-1)).toBe('  +79 more')
    for (let press = 0; press < 50; press += 1) page.handleInput(DOWN)
    const middle = treeColumn(page.render(100, 24).map(strip))
    expect(middle[0]).toBe('  +40 more above')
    expect(middle[11]).toBe('❯   ○ #11 task number 11')
    expect(middle.at(-1)).toBe('  +40 more')
    page.handleInput('G')
    const bottom = treeColumn(page.render(100, 24).map(strip))
    expect(bottom[0]).toBe('  +79 more above')
    expect(bottom.at(-1)).toBe('❯   ○ #60 task number 60')
  })

  it('draws a frame of the large board well inside a repaint period, even on a loaded worker', () => {
    const { page } = open(() => source(largeBoard()), { motion: true, palette: colors })
    const started = performance.now()
    for (let render = 0; render < 50; render += 1) page.render(140, 50)
    // A generous ceiling: a frame takes about a millisecond here, and the bound only catches a quadratic regression.
    expect((performance.now() - started) / 50).toBeLessThan(100)
  })
})

describe('the motion', () => {
  it('reveals the tree top to bottom, two rows a step for ten rows, then settles on the still frame', () => {
    const read = (): TodosPageSource => source()
    const { page, clock } = open(read, { motion: true, palette: colors })
    const { frames, animates } = playSteps(page, clock, OPENED, 8)
    const first = (frames[0] as string[]).map(strip)
    expect(treeColumn(first).slice(0, 3)).toEqual([BOARD_ROWS[0], BOARD_ROWS[1], ''])
    expect(treeColumn((frames[1] as string[]).map(strip)).slice(0, 5)).toEqual([BOARD_ROWS[0], BOARD_ROWS[1], BOARD_ROWS[2], BOARD_ROWS[3], ''])
    expect(treeColumn((frames[4] as string[]).map(strip)).slice(0, 10)).toEqual(BOARD_ROWS)
    expect(animates).toEqual([true, true, true, true, true, true, false, false])
    expectMonotonic(frames)
    expect(frames[6]).toEqual(stillFrame(read, []))
    expect(frames[0]?.[2]).toContain(colors.bold(colors.accent('❯ ▾ ◐ #1 Build the parser  1/3')))
    expect(frames[1]?.[2]).toContain(colors.accent('❯ ▾ ◐ #1 Build the parser  1/3'))
    expect(frames[1]?.[2]).not.toContain(colors.bold(colors.accent('❯')))
  })

  it('fades the detail in with the first row and settles it after the declared steps', () => {
    const { page, clock } = open(() => source(), { motion: true, palette: colors })
    const { frames } = playSteps(page, clock, OPENED, 2)
    expect(TODOS_PAGE_DETAIL_FADE_STEPS).toBe(1)
    expect(frames[0]?.[2]).toContain(`${colors.dim('│')} ${colors.dim('#1 Build the parser')}`)
    expect(frames[1]?.[2]).toContain(`${colors.dim('│')} ${colors.bold('#1 Build the parser')}`)
  })

  it('reveals one row a step for a short tree and caps a long one at the declared steps', () => {
    const short = open(() => source([task('1', 'one', 'pending'), task('2', 'two', 'pending'), task('3', 'three', 'pending')]), { motion: true })
    expect(playSteps(short.page, short.clock, OPENED, 6).animates).toEqual([true, true, true, true, false, false])
    const long = open(() => source(largeBoard()), { motion: true, palette: colors })
    const played = playSteps(long.page, long.clock, OPENED, TODOS_PAGE_REVEAL_STEPS + 3)
    expect(played.animates).toEqual([...Array<boolean>(TODOS_PAGE_REVEAL_STEPS + 1).fill(true), false, false])
    expect(played.frames[TODOS_PAGE_REVEAL_STEPS - 1]?.every(line => line !== '')).toBe(true)
    expect(treeColumn((played.frames[0] as string[]).map(strip)).slice(0, 4)).toEqual(['❯ ▾ ◐ #1 The big one  10/40', '      ✓ step 1', '      ✓ step 2', ''])
    expectMonotonic(played.frames)
    expect(played.frames.at(-1)).toEqual(stillFrame(() => source(largeBoard()), []))
  })

  it('never takes back a revealed row when a fold shortens the tree during the opening', () => {
    const { page, clock } = open(() => source(), { motion: true })
    page.render(100, 24)
    clock.now = OPENED + STEP
    page.handleInput(LEFT)
    const { frames } = playSteps(page, clock, OPENED + STEP, 6)
    expect(treeColumn(frames[0] as string[]).slice(0, 5)).toEqual(['❯ ▸ ◐ #1 Build the parser  1/3', '  ▸ ○ #2 Write docs  0/2', '    ⊘ #3 Release', '  ▾ ◐ lead · 1/3', ''])
    expectMonotonic(frames)
  })

  it('reveals the children of an unfolded node one a step, folds them away at once, and ends on the still frame', () => {
    const read = (): TodosPageSource => source()
    const { page, clock } = open(read, { motion: true, palette: colors })
    playSteps(page, clock, OPENED, 7)
    const unfoldAt = OPENED + 20 * STEP
    clock.now = unfoldAt
    const keys = [DOWN, DOWN, DOWN, DOWN, RIGHT]
    for (const key of keys) page.handleInput(key)
    const { frames, animates } = playSteps(page, clock, unfoldAt, 5)
    expect(treeColumn((frames[0] as string[]).map(strip)).slice(4, 8)).toEqual(['❯ ▾ ○ #2 Write docs  0/2', '      ○ outline', '', '    ⊘ #3 Release'])
    expect(treeColumn((frames[1] as string[]).map(strip))[6]).toBe('      ○ draft')
    expect(animates).toEqual([true, true, true, false, false])
    expectMonotonic(frames)
    expect(frames[3]).toEqual(stillFrame(read, keys))
    page.handleInput(LEFT)
    clock.now += STEP
    expect(treeColumn(page.render(100, 24).map(strip)).slice(4, 6)).toEqual(['❯ ▸ ○ #2 Write docs  0/2', '    ⊘ #3 Release'])
    expect(page.animates()).toBe(false)
  })

  it('spreads the children of a long unfold over the declared steps', () => {
    const many = Array.from({ length: 16 }, (_, index) => todo('task:2', `part ${String(index + 1)}`, 'pending'))
    const nodes = [task('1', 'first', 'pending'), task('2', 'second', 'pending', { children: many })]
    const { page, clock } = open(() => source(nodes), { motion: true })
    playSteps(page, clock, OPENED, 4)
    clock.now = OPENED + 10 * STEP
    page.handleInput(DOWN)
    page.handleInput(RIGHT)
    const { frames, animates } = playSteps(page, clock, OPENED + 10 * STEP, TODOS_PAGE_REVEAL_STEPS + 3)
    expect(treeColumn(frames[0] as string[]).slice(2, 5)).toEqual(['      ○ part 1', '      ○ part 2', ''])
    expect(animates.indexOf(false)).toBe(TODOS_PAGE_REVEAL_STEPS - 1 + TODOS_PAGE_REVEAL_LIFT_TICKS - 1)
    expectMonotonic(frames)
  })

  it('lifts a row whose state changed for the declared steps, but not a row that first appears', () => {
    let nodes = board
    const read = (): TodosPageSource => source(nodes)
    const { page, clock } = open(read, { motion: true, palette: colors })
    const still = open(read, { palette: colors }).page
    still.render(100, 24)
    playSteps(page, clock, OPENED, 7)
    nodes = [parser, { ...docs, state: 'stuck', reason: 'owner_idle' }, release, ownBranch, task('9', 'brand new', 'pending')]
    const changedAt = OPENED + 20 * STEP
    const { frames, animates } = playSteps(page, clock, changedAt, TODOS_PAGE_CHANGE_LIFT_TICKS)
    const row = (lines: readonly string[]): string => lines[6] as string
    expect(row(frames[0] as string[])).toContain(colors.bold(colors.accent('  ▸ ⊘ #2 Write docs  0/2')))
    expect(row(frames[2] as string[])).toContain(colors.accent('  ▸ ⊘ #2 Write docs  0/2'))
    expect(treeColumn((frames[0] as string[]).map(strip))[10]).toBe('    ○ #9 brand new')
    expect(frames[0]?.[12]).toContain(`${colors.dim('○')} #9 brand new`)
    expect(animates).toEqual([true, true, true, true, false, false])
    expectMonotonic(frames)
    expect(frames[4]).toEqual(still.render(100, 24))
  })

  it('records no change and no unfold without motion, and forgets the instants of a vanished node', () => {
    let nodes = board
    const { page } = open(() => source(nodes))
    page.render(100, 24)
    nodes = [{ ...parser, state: 'stuck' }, docs]
    page.handleInput(DOWN)
    page.handleInput(RIGHT)
    expect(page.render(100, 24)).toEqual(stillFrame(() => source(nodes), [DOWN, RIGHT]).map(strip))
    expect(page.animates()).toBe(false)
    const moving = open(() => source(nodes), { motion: true })
    moving.page.render(100, 24)
    nodes = [{ ...parser, state: 'in_progress' }, docs]
    for (const key of [DOWN, DOWN, DOWN, DOWN, RIGHT]) moving.page.handleInput(key)
    nodes = [release]
    moving.clock.now += STEP
    moving.page.render(100, 24)
    nodes = [{ ...parser, state: 'in_progress' }, docs]
    moving.clock.now = OPENED + 50 * STEP
    expect(moving.page.render(100, 24)).toEqual(stillFrame(() => source(nodes), []).map(strip))
    expect(moving.page.animates()).toBe(false)
  })

  it('spins a worked row while the source gives frames, and keeps the tick running for it', () => {
    const slots: number[] = []
    const spinner = (slot: number): string => {
      slots.push(slot)
      return '✻'
    }
    const { page, clock } = open(() => source(board, { spinner }), { motion: true })
    const { frames, animates } = playSteps(page, clock, OPENED, 10)
    expect(treeColumn(frames[9] as string[]).slice(0, 3)).toEqual(['❯ ▾ ✻ #1 Build the parser  1/3', '      ✓ write tokenizer', '      ✻ handle errors'])
    expect(new Set(slots)).toEqual(new Set([0, 2, 6, 8]))
    expect(animates.every(Boolean)).toBe(true)
  })

  it('draws the settled frame at once without motion and never asks for a spinner frame', () => {
    let asked = 0
    const spinner = (): string => {
      asked += 1
      return '✻'
    }
    const read = (): TodosPageSource => source(board, { spinner })
    const { page } = open(read, { palette: colors })
    expect(page.animates()).toBe(false)
    const still = page.render(100, 24)
    expect(page.animates()).toBe(false)
    expect(asked).toBe(0)
    expect(treeColumn(still.map(strip))[0]).toBe(BOARD_ROWS[0])
    const moving = open(() => source(), { motion: true, palette: colors })
    expect(playSteps(moving.page, moving.clock, OPENED, 7).frames[6]).toEqual(still)
  })

  it('starts the opening reveal over the first tree it draws, even after an empty or tiny first frame', () => {
    let nodes: WorkNode[] = []
    const { page, clock } = open(() => source(nodes), { motion: true })
    page.render(100, 2)
    expect(page.animates()).toBe(false)
    nodes = board
    clock.now = OPENED + 2 * STEP
    expect(treeColumn(page.render(100, 24).map(strip)).slice(0, 7)).toEqual(BOARD_ROWS.slice(0, 6).concat(''))
    const stacked = open(() => source(), { motion: true })
    stacked.page.render(60, 4)
    expect(stacked.page.animates()).toBe(true)
  })
})
