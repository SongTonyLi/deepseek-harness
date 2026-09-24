/** Streamed reasoning, reply text, and tool arguments reaching the screen on the frame tick. */

import { describe, expect, it } from 'vitest'
import { createToolResultMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
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

  it('keeps an open thinking block paced until a frame', async () => {
    const test = await bench({ streamPaceFrames: 8 })
    await test.settle()
    test.stream.start()
    test.stream.chunk({ type: 'reasoning-delta', index: 0, text: 'pondering the whole question carefully' })
    await test.settle()
    expect(await test.screen()).not.toContain('pondering the whole question carefully')

    await frame(test)
    const screen = await test.screen()
    expect(screen).toContain('pond')
    expect(screen).not.toContain('pondering the whole question carefully')
  })

  it('draws finished thinking at once and paces the reply and tool card after it', async () => {
    const test = await bench({ streamPaceFrames: 8 })
    await test.settle()
    test.stream.start()
    test.stream.chunk({ type: 'reasoning-delta', index: 0, text: 'pondering' })
    test.stream.chunk({ type: 'text-delta', index: 1, text: REPLY })
    test.stream.chunk({ type: 'tool-call-delta', index: 2, id: 'call-1' as never, name: 'read', argumentsDelta: '' })
    test.stream.chunk({ type: 'tool-call-delta', index: 2, id: 'call-1' as never, argumentsDelta: '{"path":"a.txt"}' })
    await test.settle()
    const queued = await test.screen()
    expect(queued).toContain('pondering')
    expect(queued).not.toContain(REPLY)
    expect(queued).not.toContain('a.txt')

    await frame(test)
    const screen = await test.screen()
    expect(screen).toContain('pondering')
    expect(screen).not.toContain(REPLY)
    expect(screen.indexOf('pondering')).toBeLessThan(screen.indexOf('The'))
  })

  it('labels writing and calling when those blocks start, before their text is paced', async () => {
    const test = await bench({ streamPaceFrames: 8, running: true })
    await test.settle()
    test.stream.start()
    test.stream.chunk({ type: 'reasoning-delta', index: 0, text: 'pondering the whole question carefully' })
    test.stream.chunk({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'pondering the whole question carefully' } })
    test.stream.chunk({ type: 'block-start', index: 1, blockType: 'text' })
    test.stream.chunk({ type: 'text-delta', index: 1, text: REPLY })
    await test.settle()
    const writing = await test.screen()
    expect(writing).toContain('writing')
    expect(writing).not.toContain('thinking ↑')
    expect(writing).not.toContain(REPLY)

    test.stream.chunk({ type: 'block-start', index: 2, blockType: 'tool-call' })
    await test.settle()
    const calling = await test.screen()
    expect(calling).toContain('calling')
    expect(calling).not.toContain('writing')

    test.stream.chunk({ type: 'tool-call-delta', index: 2, id: 'call-1' as never, name: 'read', argumentsDelta: '' })
    test.stream.chunk({ type: 'block-start', index: 3, blockType: 'text' })
    test.stream.chunk({ type: 'block-start', index: 4, blockType: 'tool-call' })
    test.stream.chunk({ type: 'block-start', index: 5, blockType: 'image' })
    await test.settle()
    const named = await test.screen()
    expect(named).toContain('calling read')
    expect(named).not.toContain('writing')
  })

  it('draws a finished thinking block at once and keeps pacing the reply', async () => {
    const test = await bench({ streamPaceFrames: 8 })
    await test.settle()
    test.stream.start()
    test.stream.chunk({ type: 'reasoning-delta', index: 0, text: 'pondering the whole question carefully' })
    test.stream.chunk({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'pondering the whole question carefully' } })
    await test.settle()
    expect(await test.screen()).toContain('pondering the whole question carefully')

    test.stream.chunk({ type: 'text-delta', index: 1, text: REPLY })
    await test.settle()
    const answering = await test.screen()
    expect(answering).toContain('pondering the whole question carefully')
    expect(answering).not.toContain(REPLY)
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

describe('tool card reveal', () => {
  const OUTPUT = [{ type: 'text' as const, text: 'row-a\nrow-b\nrow-c\nrow-d' }]

  it('unrolls a card and its result over the following frames', async () => {
    const test = await bench({ toolRevealFrames: 2, toolPreviewLines: 8 })
    await test.settle()
    test.appendToolCall('call-1', 'bash', { command: 'ls' })
    await test.settle()
    expect(test.tickArmed(FADE_TICK_MS)).toBe(true)
    await frame(test)
    expect(await test.screen()).toContain('◆ bash')

    test.appendToolResult('call-1', OUTPUT)
    await test.settle()
    const landed = await test.screen()
    expect(landed).not.toContain('row-d')
    for (let index = 0; index < 10 && test.tickArmed(FADE_TICK_MS); index += 1) await frame(test)
    expect(await test.screen()).toContain('row-d')
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('draws a replayed card whole', async () => {
    const history = [
      { type: 'tool/call', seq: 1, time: 1, data: { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/result', seq: 2, time: 1, data: { turn: 1, step: 1, message: createToolResultMessage({ callId: 'c' as ToolCallId, content: OUTPUT, isError: false }) } },
    ] as never[]
    const test = await bench({ history, toolRevealFrames: 2, toolPreviewLines: 8 })
    await test.settle()
    expect(await test.screen()).toContain('row-d')
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('draws a card whole under reduced motion', async () => {
    const test = await bench({ toolRevealFrames: 2, toolPreviewLines: 8, reducedMotion: true })
    await test.settle()
    test.appendToolCall('call-1', 'bash', { command: 'ls' })
    test.appendToolResult('call-1', OUTPUT)
    await test.settle()
    expect(await test.screen()).toContain('row-d')
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('stops unrolling a streamed card the stream abandoned', async () => {
    const test = await bench({ toolRevealFrames: 8 })
    await test.settle()
    test.stream.start()
    test.stream.chunk({ type: 'tool-call-delta', index: 0, id: 'call-1' as never, name: 'bash', argumentsDelta: '{"command":"ls"}' })
    await test.settle()
    expect(await test.screen()).toContain('◆ bash')
    test.stream.end({ kind: 'abandoned' })
    await test.settle()
    expect(await test.screen()).not.toContain('◆ bash')
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })
})
