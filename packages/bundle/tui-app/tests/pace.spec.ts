/** The queue between the live stream and the frames that draw it. */

import { describe, expect, it } from 'vitest'
import { CardFlow, STREAM_PACE_FRAMES, StreamPacer, TOOL_REVEAL_FRAMES } from '../src/pace.ts'

/**
 * A pacer whose released parts are recorded per channel.
 * @param drainFrames - frames a backlog drains over.
 * @returns the pacer, the release log, and a push that records into it.
 */
function paced(drainFrames: number): {
  pacer: StreamPacer
  released: [string, string][]
  push: (channel: string, text: string) => void
} {
  const pacer = new StreamPacer({ drainFrames })
  const released: [string, string][] = []
  return {
    pacer,
    released,
    push: (channel, text) => { pacer.push(channel, text, (part) => { released.push([channel, part]) }) },
  }
}

describe('StreamPacer', () => {
  it('ships an eight-frame drain', () => {
    expect(STREAM_PACE_FRAMES).toBe(8)
  })

  it('releases nothing until a frame runs', () => {
    const { pacer, released, push } = paced(4)
    push('text', 'abcdefgh')
    expect(released).toEqual([])
    expect(pacer.pending()).toBe(true)
  })

  it('spreads a burst over the drain frames, a share of the backlog per frame', () => {
    const { pacer, released, push } = paced(4)
    push('text', 'abcdefgh')
    expect(pacer.frame()).toBe(true)
    expect(released).toEqual([['text', 'ab']])
    let frames = 1
    while (pacer.frame()) frames += 1
    expect(frames).toBe(6)
    expect(released.map(([, text]) => text).join('')).toBe('abcdefgh')
    expect(pacer.pending()).toBe(false)
  })

  it('releases at least one grapheme per frame, so a trickle is drawn as it arrives', () => {
    const { pacer, released, push } = paced(100)
    push('text', 'ab')
    pacer.frame()
    expect(released).toEqual([['text', 'a']])
    expect(pacer.frame()).toBe(false)
    expect(released).toEqual([['text', 'a'], ['text', 'b']])
  })

  it('merges consecutive pushes of one channel and keeps channels in arrival order', () => {
    const { pacer, released, push } = paced(1)
    push('reasoning', 'thin')
    push('reasoning', 'k')
    push('text', 'ok')
    expect(pacer.frame()).toBe(false)
    expect(released).toEqual([['reasoning', 'think'], ['text', 'ok']])
  })

  it('releases an empty entry at no cost and in order', () => {
    const { pacer, released, push } = paced(1)
    push('tool:a:read', '')
    push('text', 'x')
    expect(pacer.frame()).toBe(false)
    expect(released).toEqual([['tool:a:read', ''], ['text', 'x']])
  })

  it('never cuts a grapheme apart', () => {
    const { pacer, released, push } = paced(100)
    push('text', '👩‍💻é')
    pacer.frame()
    expect(released).toEqual([['text', '👩‍💻']])
    pacer.frame()
    expect(released.at(-1)).toEqual(['text', 'é'])
  })

  it('flushes everything in order at once', () => {
    const { pacer, released, push } = paced(8)
    push('reasoning', 'why')
    push('text', 'because')
    pacer.flush()
    expect(released).toEqual([['reasoning', 'why'], ['text', 'because']])
    expect(pacer.pending()).toBe(false)
    expect(pacer.frame()).toBe(false)
  })

  it('releases one channel immediately and keeps the others queued', () => {
    const { pacer, released, push } = paced(8)
    push('reasoning', 'why this')
    push('text', 'because')
    expect(pacer.flushChannel('reasoning')).toBe(true)
    expect(released).toEqual([['reasoning', 'why this']])
    expect(pacer.pending()).toBe(true)
    expect(pacer.flushChannel('missing')).toBe(false)
    pacer.flush()
    expect(released).toEqual([['reasoning', 'why this'], ['text', 'because']])
    expect(pacer.pending()).toBe(false)
  })

  it('clears the queue when the flushed channel is all that was queued', () => {
    const { pacer, released, push } = paced(8)
    push('reasoning', 'done')
    expect(pacer.flushChannel('reasoning')).toBe(true)
    expect(released).toEqual([['reasoning', 'done']])
    expect(pacer.pending()).toBe(false)
    expect(pacer.frame()).toBe(false)
  })

  it('drops everything on clear without releasing it', () => {
    const { pacer, released, push } = paced(8)
    push('text', 'gone')
    pacer.clear()
    expect(pacer.pending()).toBe(false)
    pacer.frame()
    expect(released).toEqual([])
  })

  it('treats a drain shorter than one frame as one frame', () => {
    const { pacer, released, push } = paced(0)
    push('text', 'all')
    expect(pacer.frame()).toBe(false)
    expect(released).toEqual([['text', 'all']])
  })
})

/** Milliseconds one frame lasts in the flow tests. */
const STEP_MS = 10

/**
 * A flow on a clock the test moves, drawing a 40-column row in four 10 ms
 * frames: ten columns per frame at width 40.
 * @param shown - columns drawn before the first frame.
 * @returns the flow and a function that moves its clock.
 */
function flowing(shown = 0): { flow: CardFlow; advance: (ms: number) => void } {
  let now = 1000
  const flow = new CardFlow({ rowFrames: 4, stepMs: STEP_MS, steps: 5, now: () => now }, shown)
  return { flow, advance: (ms) => { now += ms } }
}

describe('CardFlow', () => {
  it('ships a flow of a full-width row over a few frames', () => {
    expect(TOOL_REVEAL_FRAMES).toBeGreaterThan(0)
  })

  it('moves the front the same number of columns every frame, however much is left', () => {
    const { flow, advance } = flowing()
    const shown: number[] = []
    for (let frame = 0; frame < 6; frame += 1) {
      advance(STEP_MS)
      flow.frame(500, 40)
      shown.push(flow.shown())
    }
    expect(shown).toEqual([10, 20, 30, 40, 50, 60])

    const short = flowing()
    const small: number[] = []
    for (let frame = 0; frame < 3; frame += 1) {
      short.advance(STEP_MS)
      short.flow.frame(25, 40)
      small.push(short.flow.shown())
    }
    expect(small).toEqual([10, 20, 25])
  })

  it('records no run for a frame that ran at the same instant as the one before', () => {
    const { flow, advance } = flowing()
    advance(STEP_MS)
    flow.frame(500, 40)
    flow.frame(500, 40)
    expect(flow.shown()).toBe(10)
    expect(flow.trail()).toHaveLength(1)
  })

  it('follows the time that passed rather than the number of frames', () => {
    const { flow, advance } = flowing()
    advance(5)
    flow.frame(500, 40)
    expect(flow.shown()).toBe(5)
    advance(20)
    flow.frame(500, 40)
    expect(flow.shown()).toBe(25)
  })

  it('takes a frame longer as the terminal gets wider', () => {
    const { flow, advance } = flowing()
    advance(STEP_MS)
    flow.frame(500, 80)
    expect(flow.shown()).toBe(20)
  })

  it('does not jump to the end after a stall', () => {
    const { flow, advance } = flowing()
    advance(60_000)
    expect(flow.frame(500, 40)).toBe(true)
    // Four frames at ten columns each, however long the loop was away.
    expect(flow.shown()).toBe(40)
  })

  it('starts the clock on the first frame after the card grew, without moving', () => {
    const { flow, advance } = flowing(8)
    advance(STEP_MS)
    flow.frame(10, 40)
    expect(flow.shown()).toBe(10)
    // Caught up: the card sat still, then gained columns.
    advance(60_000)
    flow.frame(10, 40)
    expect(flow.shown()).toBe(10)
    flow.frame(50, 40)
    expect(flow.shown()).toBe(10)
    advance(STEP_MS)
    flow.frame(50, 40)
    expect(flow.shown()).toBe(20)
  })

  it('never recedes on a clock that steps backward', () => {
    const { flow, advance } = flowing()
    advance(STEP_MS)
    flow.frame(500, 40)
    expect(flow.shown()).toBe(10)
    advance(-30)
    flow.frame(500, 40)
    expect(flow.shown()).toBe(10)
    advance(STEP_MS)
    flow.frame(500, 40)
    expect(flow.shown()).toBe(20)
  })

  it('starts the clock afresh when a card grows right after the front caught up', () => {
    const { flow, advance } = flowing()
    advance(STEP_MS)
    expect(flow.frame(15, 40)).toBe(true)
    expect(flow.shown()).toBe(10)
    advance(STEP_MS)
    expect(flow.frame(15, 40)).toBe(false)
    expect(flow.shown()).toBe(15)
    // The time that passed while nothing was left to draw is not owed to the columns that arrive later.
    advance(2 * STEP_MS)
    expect(flow.frame(80, 40)).toBe(true)
    expect(flow.shown()).toBe(15)
    advance(STEP_MS)
    flow.frame(80, 40)
    expect(flow.shown()).toBe(25)
  })

  it('keeps the freshly drawn columns in a trail that ages with the clock and then empties', () => {
    const { flow, advance } = flowing()
    expect(flow.trail()).toEqual([])
    advance(STEP_MS)
    flow.frame(500, 40)
    advance(STEP_MS)
    flow.frame(500, 40)
    // Each frame's run is aged from the middle of its own advance: half a step more than the clock moved.
    expect(flow.trail()).toEqual([
      { start: 0, end: 10, age: 1.5 },
      { start: 10, end: 20, age: 0.5 },
    ])
    // The run that reached the five steps leaves the trail; the newer one is still receding.
    advance(STEP_MS * 4)
    expect(flow.trail()).toEqual([
      { start: 10, end: 20, age: 4.5 },
    ])
    expect(flow.frame(20, 40)).toBe(false)
    expect(flow.receding()).toBe(true)
    advance(STEP_MS * 3)
    expect(flow.trail()).toEqual([])
    expect(flow.receding()).toBe(false)
  })

  it('reports hidden columns from the frame, and the runs still brightening apart from them', () => {
    const { flow, advance } = flowing()
    advance(STEP_MS)
    expect(flow.frame(20, 40)).toBe(true)
    advance(STEP_MS)
    expect(flow.frame(20, 40)).toBe(false)
    expect(flow.receding()).toBe(true)
    advance(STEP_MS * 10)
    expect(flow.receding()).toBe(false)
  })

  it('treats fewer than one frame per row as one frame per row', () => {
    let now = 0
    const flow = new CardFlow({ rowFrames: 0, stepMs: STEP_MS, steps: 5, now: () => now }, 0)
    now += STEP_MS
    flow.frame(500, 40)
    expect(flow.shown()).toBe(40)
  })

  it('settles to every column and clamps back to the columns a card has', () => {
    const { flow, advance } = flowing()
    advance(STEP_MS)
    flow.frame(500, 40)
    flow.settle()
    expect(flow.shown()).toBe(Number.POSITIVE_INFINITY)
    expect(flow.trail()).toEqual([])
    flow.clamp(30)
    expect(flow.shown()).toBe(30)
    flow.clamp(60)
    expect(flow.shown()).toBe(30)
    // Columns the card gains later flow again from where it ended.
    flow.frame(60, 40)
    advance(STEP_MS)
    flow.frame(60, 40)
    expect(flow.shown()).toBe(40)
  })
})
