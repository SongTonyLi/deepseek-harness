/** Streamed reasoning, reply text, and tool arguments reaching the screen on the frame tick. */

import { describe, expect, it } from 'vitest'
import { FADE_TICK_MS } from '../src/fade.ts'
import { bench, type Bench } from './bench.ts'

/** A reply long enough that one frame of a four-frame drain cannot draw all of it. */
const REPLY = 'The quick brown fox jumps over the lazy dog.'

/**
 * Run one frame and let the renderer draw it.
 * @param test - the running bench.
 */
async function frame(test: Bench): Promise<void> {
  test.runTick(FADE_TICK_MS)
  await test.settle()
}

describe('stream pacing', () => {
  it('queues a burst as it arrives and draws it over the following frames', async () => {
    const test = await bench({ streamPaceFrames: 4 })
    await test.settle()
    test.stream.start()
    test.stream.chunk({ type: 'text-delta', index: 0, text: REPLY })
    await test.settle()
    expect(await test.screen()).not.toContain('The quick')
    expect(test.tickArmed(FADE_TICK_MS)).toBe(true)

    await frame(test)
    const first = await test.screen()
    expect(first).toContain('The')
    expect(first).not.toContain(REPLY)

    for (let index = 0; index < REPLY.length && test.tickArmed(FADE_TICK_MS); index += 1) await frame(test)
    expect(await test.screen()).toContain(REPLY)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('draws reasoning, reply text, and a tool card in the order the stream sent them', async () => {
    const test = await bench({ streamPaceFrames: 1 })
    await test.settle()
    test.stream.start()
    test.stream.chunk({ type: 'reasoning-delta', index: 0, text: 'pondering' })
    test.stream.chunk({ type: 'text-delta', index: 1, text: 'answering' })
    test.stream.chunk({ type: 'tool-call-delta', index: 2, id: 'call-1' as never, name: 'read', argumentsDelta: '' })
    test.stream.chunk({ type: 'tool-call-delta', index: 2, id: 'call-1' as never, argumentsDelta: '{"path":"a.txt"}' })
    await test.settle()
    expect(await test.screen()).not.toContain('pondering')

    await frame(test)
    const screen = await test.screen()
    expect(screen).toContain('pondering')
    expect(screen).toContain('answering')
    expect(screen).toContain('a.txt')
    expect(screen.indexOf('pondering')).toBeLessThan(screen.indexOf('answering'))
    expect(screen.indexOf('answering')).toBeLessThan(screen.indexOf('a.txt'))
  })

  it('draws everything still queued when the stream ends', async () => {
    const test = await bench({ streamPaceFrames: 8 })
    await test.settle()
    test.stream.start()
    test.stream.chunk({ type: 'text-delta', index: 0, text: REPLY })
    test.stream.end({ kind: 'abandoned' })
    await test.settle()
    expect(await test.screen()).toContain(REPLY)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('draws everything still queued before a logged event', async () => {
    const test = await bench({ streamPaceFrames: 8 })
    await test.settle()
    test.stream.start()
    test.stream.chunk({ type: 'text-delta', index: 0, text: REPLY })
    test.appendPrompt('next question')
    await test.settle()
    const screen = await test.screen()
    expect(screen).toContain(REPLY)
    expect(screen.indexOf(REPLY)).toBeLessThan(screen.indexOf('next question'))
  })

  it('draws each delta as it arrives under reduced motion', async () => {
    const test = await bench({ streamPaceFrames: 8, reducedMotion: true })
    await test.settle()
    test.stream.start()
    test.stream.chunk({ type: 'text-delta', index: 0, text: REPLY })
    await test.settle()
    expect(await test.screen()).toContain(REPLY)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })
})
