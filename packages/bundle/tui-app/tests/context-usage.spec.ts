/** The `/context` report: attribution, the cell grid, the legend, and the block's animation. */

import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SurfaceNode } from '../src/compaction.ts'
import {
  AT_REST,
  CONTEXT_CATEGORIES,
  ContextUsageBlock,
  GRID_CELLS,
  contextUsage,
  contextUsageLines,
  gridCells,
  type ContextUsage,
} from '../src/context-usage.ts'
import { createPalette } from '../src/style.ts'

const plain = createPalette(false)
const color = createPalette(true)

/** A usage whose categories carry these tokens and hot tokens; zero elsewhere. */
type Tokens = Partial<Record<(typeof CONTEXT_CATEGORIES)[number], [number, number?]>>

function usageOf(tokens: Tokens, extra: Partial<ContextUsage> = {}): ContextUsage {
  const categories = CONTEXT_CATEGORIES.map(id => ({ id, tokens: tokens[id]?.[0] ?? 0, hotTokens: tokens[id]?.[1] ?? 0 }))
  return {
    model: 'test-provider/test-model',
    used: categories.reduce((sum, category) => sum + category.tokens, 0),
    window: 100_000,
    turn: 2,
    categories,
    ...extra,
  }
}

const node = (seq: number, fact: SurfaceNode['fact'], group?: SurfaceNode['group']): SurfaceNode =>
  group === undefined ? { seq: SessionSeq(seq), fact } : { seq: SessionSeq(seq), fact, group }

describe('contextUsage', () => {
  it('attributes each priced node by what the surface mirror names it, and the newest turn to the hot region', () => {
    const usage = contextUsage({
      model: 'p/m',
      turn: 2,
      priced: [
        { seq: SessionSeq(0), tokens: 1000 },
        { seq: SessionSeq(1), tokens: 300 },
        { seq: SessionSeq(2), tokens: 200 },
        { seq: SessionSeq(3), tokens: 50 },
        { seq: SessionSeq(4), tokens: 400 },
        { seq: SessionSeq(5), tokens: 600 },
        { seq: SessionSeq(6), tokens: 70 },
        { seq: SessionSeq(7), tokens: 30 },
      ],
      surface: [
        node(0, { kind: 'system' }),
        node(1, { kind: 'context', turn: 1, title: 'instructions · AGENTS.md' }, 'instructions'),
        node(2, { kind: 'context', turn: 1, title: 'catalog · skill-catalog' }, 'skills'),
        node(3, { kind: 'context', turn: 2, title: 'notice · ! ls' }, 'context'),
        node(4, { kind: 'prompt', turn: 1, text: 'first' }),
        node(5, { kind: 'result', turn: 2, tool: 'read' }),
        node(6, { kind: 'reply', turn: 2 }),
      ],
      toolsTokens: 900,
      used: 4000,
      window: 128_000,
    })
    expect(usage.categories).toEqual([
      { id: 'system', tokens: 1000, hotTokens: 0 },
      { id: 'tools', tokens: 900, hotTokens: 0 },
      { id: 'instructions', tokens: 300, hotTokens: 0 },
      { id: 'skills', tokens: 200, hotTokens: 0 },
      { id: 'context', tokens: 50, hotTokens: 50 },
      // seq 7 is not mirrored, so it counts as conversation and is not hot.
      { id: 'messages', tokens: 1100, hotTokens: 670 },
    ])
    expect(usage).toMatchObject({ model: 'p/m', used: 4000, window: 128_000, turn: 2 })
  })

  it('falls back to the category sum without an occupancy sample, and has no hot region before the first turn', () => {
    const usage = contextUsage({
      model: 'p/m',
      turn: 0,
      priced: [{ seq: SessionSeq(0), tokens: 10 }],
      surface: [node(0, { kind: 'context', turn: 0, title: 'x' })],
      toolsTokens: 5,
    })
    expect(usage.used).toBe(15)
    expect(usage.window).toBeUndefined()
    expect(usage.categories.find(category => category.id === 'context')).toEqual({ id: 'context', tokens: 10, hotTokens: 0 })
  })
})

describe('gridCells', () => {
  it('fills the used share of the window by category, with each category\'s hot cells at its end', () => {
    const cells = gridCells(usageOf({ system: [5000], messages: [15_000, 5000] }))
    expect(cells).toHaveLength(GRID_CELLS)
    // 20k of 100k is 40 of 200 cells, split 1:3.
    expect(cells.filter(cell => cell?.category === 'system')).toHaveLength(10)
    const messages = cells.filter(cell => cell?.category === 'messages')
    expect(messages).toHaveLength(30)
    expect(messages.map(cell => cell?.hot)).toEqual([...Array<boolean>(20).fill(false), ...Array<boolean>(10).fill(true)])
    expect(cells.slice(40).every(cell => cell === undefined)).toBe(true)
  })

  it('gives every nonzero category a cell however small, without exceeding the grid', () => {
    const cells = gridCells(usageOf({ system: [10], tools: [10], skills: [1, 1], messages: [10] }, { window: 1_000_000 }))
    expect(new Set(cells.flatMap(cell => cell === undefined ? [] : [cell.category]))).toEqual(new Set(['system', 'tools', 'skills', 'messages']))
    expect(cells.filter(cell => cell?.hot === true)).toEqual([{ category: 'skills', hot: true }])
    const full = gridCells(usageOf({ system: [1], messages: [999_999] }, { window: 100, used: 1_000_000 }))
    expect(full.filter(cell => cell === undefined)).toHaveLength(0)
    expect(full.filter(cell => cell?.category === 'system')).toHaveLength(1)
  })

  it('shares every cell across the categories while the window is unknown, and draws nothing used for an empty surface', () => {
    const { window: _window, ...unknown } = usageOf({ system: [1], messages: [1] })
    expect(gridCells(unknown).every(cell => cell !== undefined)).toBe(true)
    expect(gridCells(usageOf({})).every(cell => cell === undefined)).toBe(true)
  })
})

describe('contextUsageLines', () => {
  const usage = usageOf(
    { system: [2200], tools: [5300], instructions: [100], skills: [660], messages: [4200, 1200] },
    { used: 12_500, window: 1_000_000 },
  )

  it('draws the grid beside the legend when the width allows', () => {
    const lines = contextUsageLines(usage, plain, 80)
    expect(lines[1]).toBe('Context usage')
    expect(lines[2]).toBe(`⛁ ⛁ ⛁ ⛁ ⛁ ${Array<string>(15).fill('⛶').join(' ')}   test-provider/test-model`)
    expect(lines.slice(2).map(line => line.slice(42))).toEqual([
      'test-provider/test-model',
      '12.5k/1M tokens (1%)',
      '▲ hot: +1.2k tokens in turn 2',
      '',
      'Estimated usage by category',
      '⛁ System prompt: 2.2k tokens (0.2%)',
      '⛁ System tools: 5.3k tokens (0.5%)',
      '⛁ Instructions: 100 tokens (0.0%)',
      '⛁ Skills: 660 tokens (0.1%)',
      '⛁ Injected context: 0 tokens (0.0%)',
      '⛁ Messages: 4.2k tokens (0.4%)',
      '⛶ Free space: 987.5k (98.8%)',
      '',
    ])
  })

  it('stacks the legend under a half-width grid on a narrow terminal, and never exceeds the width', () => {
    const lines = contextUsageLines(usage, plain, 30)
    expect(lines[2]).toBe(`⛁ ⛁ ⛁ ⛁ ⛁ ${Array<string>(5).fill('⛶').join(' ')}`)
    expect(lines).toContain('Estimated usage by category')
    expect(lines.every(line => visibleWidth(line) <= 30)).toBe(true)
  })

  it('keeps one line count at one width whatever the usage and the frame', () => {
    const { window: _window, ...unknown } = usageOf({ messages: [10] }, { turn: 0 })
    const counts = [
      contextUsageLines(usage, color, 80),
      contextUsageLines(usage, color, 80, { fill: 0, wave: 3, frontier: true, live: true }),
      contextUsageLines(unknown, color, 80),
      contextUsageLines(usageOf({ messages: [10] }), color, 80),
    ].map(lines => lines.length)
    expect(new Set(counts).size).toBe(1)
  })

  it('names an unknown window, an empty hot region, and a session with no turn yet', () => {
    const { window: _window, ...unknown } = usageOf({ messages: [10] }, { turn: 0 })
    const lines = contextUsageLines(unknown, plain, 60)
    expect(lines).toContain('10 tokens · window not reported yet')
    expect(lines).toContain('▲ hot: no turn yet')
    expect(lines).toContain('⛶ Free space: unknown')
    expect(lines).toContain('⛁ Messages: 10 tokens (100%)')
    expect(contextUsageLines(usageOf({ messages: [10] }), plain, 30)).toContain('▲ hot: nothing added in turn 2')
    expect(contextUsageLines(usageOf({}), plain, 30)).toContain('⛁ Messages: 0 tokens (0.0%)')
    expect(contextUsageLines(usageOf({}, { window: undefined as never }), plain, 30)).toContain('⛁ Messages: 0 tokens')
  })

  it('draws the hot region bold at rest, and sweeps an inverse head through it under the shimmer', () => {
    const hot = usageOf({ messages: [20_000, 10_000] })
    const rest = contextUsageLines(hot, color, 80).join('\n')
    expect(rest).toContain('\u001b[1m\u001b[38;5;141m⛁')
    expect(rest).not.toContain('\u001b[7m')
    const shimmer = contextUsageLines(hot, color, 80, { fill: 1, wave: 0, frontier: false, live: false }).join('\n')
    expect(shimmer.match(/\u001b\[7m/gu)).toHaveLength(1)
    // Past the region's end the head leaves no inverse cell until it starts over.
    const between = contextUsageLines(hot, color, 80, { fill: 1, wave: 22, frontier: false, live: false }).join('\n')
    expect(between).not.toContain('\u001b[7m')
  })

  it('fills the used cells over the open, and lights the first free cell while live', () => {
    const half = contextUsageLines(usage, plain, 80, { fill: 0.4, frontier: false, live: false })
    expect(half[2]?.startsWith(`⛁ ⛁ ${Array<string>(18).fill('⛶').join(' ')}`)).toBe(true)
    const lit = contextUsageLines(usage, color, 80, { fill: 1, frontier: true, live: true })
    expect(lit.join('\n')).toContain('\u001b[1m\u001b[36m⛶')
    expect(lit.join('\n')).toContain(' · live')
    expect(contextUsageLines(usage, color, 80, { fill: 0.5, frontier: true, live: true }).join('\n')).not.toContain('\u001b[1m\u001b[36m⛶')
  })
})

describe('ContextUsageBlock', () => {
  /** A block over a mutable usage and clock. */
  function setup(options: { live?: boolean; clock?: boolean } = {}) {
    const state = { now: 1000, live: options.live ?? false, reads: 0, usage: usageOf({ messages: [20_000, 10_000] }) }
    const block = new ContextUsageBlock(color, {
      read: () => { state.reads++; return state.usage },
      live: () => state.live,
      ...options.clock === false ? {} : { now: () => state.now },
    })
    return { state, block }
  }

  it('draws the resting report at once and never moves without a clock', () => {
    const { state, block } = setup({ clock: false })
    expect(block.needsRepaint()).toBe(false)
    expect(block.render(80)).toEqual(contextUsageLines(state.usage, color, 80, AT_REST))
    block.tick()
    expect(state.reads).toBe(1)
  })

  it('fills, shimmers, and settles on the resting report once the open animation ran and no turn runs', () => {
    const { state, block } = setup()
    expect(block.needsRepaint()).toBe(true)
    const opening = block.render(80)
    expect(opening).not.toEqual(contextUsageLines(state.usage, color, 80, AT_REST))
    state.now += 1000
    block.tick()
    const shimmer = block.render(80)
    expect(shimmer.join('\n')).toContain('\u001b[7m')
    // A period that moves nothing keeps the drawn lines.
    block.tick()
    expect(block.render(80)).toBe(shimmer)
    state.now += 2500
    block.tick()
    expect(block.needsRepaint()).toBe(false)
    expect(block.render(80)).toEqual(contextUsageLines(state.usage, color, 80, AT_REST))
  })

  it('re-reads while a turn runs and settles on the newest read once it ends', () => {
    const { state, block } = setup({ live: true })
    state.now += 100
    block.tick()
    expect(state.reads).toBe(1)
    state.now += 200
    state.usage = usageOf({ messages: [40_000, 30_000] })
    block.tick()
    expect(state.reads).toBe(2)
    expect(block.render(80).join('\n')).toContain('+30k tokens')
    state.now += 10_000
    block.tick()
    expect(block.needsRepaint()).toBe(true)
    state.live = false
    state.usage = usageOf({ messages: [50_000, 40_000] })
    block.tick()
    expect(block.needsRepaint()).toBe(false)
    expect(block.render(80).join('\n')).toContain('+40k tokens')
  })

  it('retires on what it last read', () => {
    const { state, block } = setup({ live: true })
    block.retire()
    expect(block.needsRepaint()).toBe(false)
    state.usage = usageOf({ messages: [1] })
    block.tick()
    expect(state.reads).toBe(1)
  })

  it('holds the rows above the repaint floor, and settles once none is repaintable', () => {
    const { state, block } = setup()
    const before = block.render(80)
    // Rows 2 and 3 are the grid rows the used cells fill.
    block.setRepaintFloor(3)
    state.now += 1000
    block.tick()
    const after = block.render(80)
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3))
    expect(after[3]).not.toEqual(before[3])
    expect(block.render(80)).toBe(after)
    block.invalidate()
    expect(block.render(80)).toEqual(after)
    block.setRepaintFloor(after.length)
    expect(block.needsRepaint()).toBe(false)
    expect(block.render(80)).toEqual(after)
  })
})
