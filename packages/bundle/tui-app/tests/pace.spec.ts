/** The queue between the live stream and the frames that draw it. */

import { describe, expect, it } from 'vitest'
import { RowReveal, STREAM_PACE_FRAMES, StreamPacer, TOOL_REVEAL_FRAMES } from '../src/pace.ts'

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

describe('RowReveal', () => {
  it('draws a share of the hidden rows per frame, at least one, until it catches up', () => {
    expect(TOOL_REVEAL_FRAMES).toBeGreaterThan(0)
    const reveal = new RowReveal(4, 1)
    const counts: number[] = []
    while (reveal.frame(9)) counts.push(reveal.shown())
    counts.push(reveal.shown())
    // 8 hidden rows over 4 frames: two rows, then a single row a frame as the hidden run shrinks.
    expect(counts).toEqual([3, 4, 5, 6, 7, 8, 9])
    expect(reveal.frame(9)).toBe(false)
  })

  it('reveals rows a block gains after it caught up', () => {
    const reveal = new RowReveal(1, 2)
    expect(reveal.frame(2)).toBe(false)
    expect(reveal.frame(5)).toBe(false)
    expect(reveal.shown()).toBe(5)
  })

  it('treats a drain below one frame as one frame', () => {
    const reveal = new RowReveal(0, 0)
    expect(reveal.frame(3)).toBe(false)
    expect(reveal.shown()).toBe(3)
  })

  it('settles to every row and clamps back to the rows a block has', () => {
    const reveal = new RowReveal(8, 1)
    reveal.settle()
    expect(reveal.shown()).toBe(Number.POSITIVE_INFINITY)
    reveal.clamp(4)
    expect(reveal.shown()).toBe(4)
    reveal.clamp(6)
    expect(reveal.shown()).toBe(4)
    expect(reveal.frame(6)).toBe(true)
  })
})
