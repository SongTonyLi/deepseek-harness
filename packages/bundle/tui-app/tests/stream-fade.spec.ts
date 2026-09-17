/** Streamed assistant text fading in: the colors it draws, the tick that ages it, and everything that settles it. */

import { describe, expect, it } from 'vitest'
import { FADE_FAST_WINDOW_TICKS, FADE_STEPS, FADE_TICK_MS } from '../src/fade.ts'
import { KEY, bench, type Bench } from './bench.ts'

/** A terminal that reports a black background and encodes 24-bit color. */
const TRUECOLOR = {
  color: true,
  env: { COLORTERM: 'truecolor' },
  background: 'rgb:0000/0000/0000',
} as const

/**
 * The 24-bit foreground of one brightness level over a black background. The
 * assumed foreground is white, so level `k` of five is `(k + 1) * 51` on every
 * channel.
 * @param level - the ramp level, 0 for the darkest.
 * @returns the SGR sequence a chunk of that age opens with.
 */
function levelSgr(level: number): string {
  const value = (level + 1) * 51
  return `\u001b[38;2;${String(value)};${String(value)};${String(value)}m`
}

/** Any 24-bit foreground, which only the fade emits on this surface. */
const ANY_FADE_COLOR = '\u001b[38;2;'

/** Faint intensity, the only level the two-level mode draws. */
const DIM = '\u001b[2m'

/**
 * Stream one text delta into the bound Agent and let the renderer draw it.
 * @param test - the running bench.
 * @param text - the delta.
 */
async function streamText(test: Bench, text: string): Promise<void> {
  test.stream.chunk({ type: 'text-delta', index: 0, text })
  await test.settle()
}

/**
 * What the terminal was written since the last call, so an assertion reads the
 * repaints one step caused rather than every frame of the run.
 * @param test - the running bench.
 * @returns the accumulated output, and clears it.
 */
function drawn(test: Bench): string {
  const output = test.terminal.output
  test.terminal.output = ''
  return output
}

/**
 * The repainted line carrying `text`, so an assertion reads the assistant's own
 * line and not the palette's sequences elsewhere on the screen.
 * @param output - repaints from {@link drawn}.
 * @param text - the visible text the line carries.
 * @returns the last line that carries it.
 * @throws when the renderer repainted no such line.
 */
function lineWith(output: string, text: string): string {
  const found = output.split('\n').findLast(part => part.includes(text))
  if (found === undefined) throw new Error(`no repainted line carries ${text}`)
  return found
}

/**
 * Run one fade period and let the renderer draw what it changed.
 * @param test - the running bench.
 */
async function fadeTick(test: Bench): Promise<void> {
  test.runTick(FADE_TICK_MS)
  await test.settle()
}

describe('streaming fade', () => {
  it('draws a fresh chunk at the darkest level and brightens it one level per period', async () => {
    const test = await bench(TRUECOLOR)
    await test.settle()
    test.stream.start()
    await streamText(test, 'hello')
    expect(lineWith(drawn(test), 'hello')).toContain(levelSgr(0))

    await fadeTick(test)
    expect(lineWith(drawn(test), 'hello')).toContain(levelSgr(1))
    await fadeTick(test)
    expect(lineWith(drawn(test), 'hello')).toContain(levelSgr(2))
  })

  it('settles the chunk at the terminal foreground once it passes the last drawn level', async () => {
    const test = await bench(TRUECOLOR)
    await test.settle()
    test.stream.start()
    await streamText(test, 'hello')
    expect(test.tickArmed(FADE_TICK_MS)).toBe(true)

    // The block withholds the oldest visible level, `steps - 1`, so the chunk
    // leaves the tail into the terminal's own foreground rather than into the
    // assumed one the last ramp level carries.
    for (let tick = 0; tick < FADE_STEPS - 2; tick += 1) await fadeTick(test)
    expect(lineWith(drawn(test), 'hello')).toContain(levelSgr(FADE_STEPS - 2))
    await fadeTick(test)
    const settled = lineWith(drawn(test), 'hello')
    expect(settled).not.toContain(ANY_FADE_COLOR)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('arms the fade tick only while a tail exists, and leaves an idle session with no timer at all', async () => {
    const test = await bench(TRUECOLOR)
    await test.settle()
    expect(test.tickDelaysMs()).toEqual([])

    test.stream.start()
    await streamText(test, 'hello')
    expect(test.tickDelaysMs()).toEqual([FADE_TICK_MS])

    for (let tick = 0; tick < FADE_STEPS; tick += 1) await fadeTick(test)
    expect(test.tickDelaysMs()).toEqual([])
  })

  it('ends the tail when the turn ends, so an abandoned stream leaves nothing ticking', async () => {
    const test = await bench(TRUECOLOR)
    await test.settle()
    test.stream.start()
    await streamText(test, 'hello')
    expect(test.tickArmed(FADE_TICK_MS)).toBe(true)
    drawn(test)

    test.session.append('turn/start', { turn: 1 })
    test.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await test.settle()
    expect(lineWith(drawn(test), 'hello')).not.toContain(ANY_FADE_COLOR)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('ends the tail when the session is rebound', async () => {
    const test = await bench(TRUECOLOR)
    await test.settle()
    test.stream.start()
    await streamText(test, 'hello')
    expect(test.tickArmed(FADE_TICK_MS)).toBe(true)

    for (const char of '/new') test.terminal.type(char)
    test.terminal.type('\r')
    await test.settle()
    expect(test.hostCalls).toEqual(['create'])
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('settles the tail on a width change, because the rewrapped lines no longer carry its columns', async () => {
    const test = await bench(TRUECOLOR)
    await test.settle()
    test.stream.start()
    await streamText(test, 'hello')
    expect(lineWith(drawn(test), 'hello')).toContain(levelSgr(0))

    test.terminal.resize(70)
    await test.settle()
    expect(lineWith(drawn(test), 'hello')).not.toContain(ANY_FADE_COLOR)
    // The flush reaches the tick through the same path the ageing does, so the
    // timer stops without waiting for a chunk to age out.
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('keeps the fast-stream window across a flush, so a fast stream stays unfaded after a resize', async () => {
    const test = await bench(TRUECOLOR)
    await test.settle()
    test.stream.start()
    // One arrival per completed tick over the whole window turns the effect
    // off: the stream outruns the ramp, so nothing on screen darkens.
    for (let tick = 0; tick < FADE_FAST_WINDOW_TICKS; tick += 1) {
      await streamText(test, `w${String(tick)} `)
      await fadeTick(test)
    }
    drawn(test)
    await streamText(test, 'fast ')
    expect(lineWith(drawn(test), 'fast')).not.toContain(ANY_FADE_COLOR)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)

    test.terminal.resize(70)
    await test.settle()
    drawn(test)
    await streamText(test, 'more ')
    expect(lineWith(drawn(test), 'more')).not.toContain(ANY_FADE_COLOR)
  })

  it('never fades a committed message or a block rebuilt from history', async () => {
    const history = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      {
        type: 'assistant/message',
        seq: 1,
        time: 2,
        data: {
          stream: [],
          turn: 1,
          step: 1,
          message: {
            id: 'm1',
            role: 'assistant',
            content: [{ type: 'text', text: 'from history' }],
            source: { provider: 'p', model: 'm' },
          },
        },
      },
    ]
    const test = await bench({ ...TRUECOLOR, history: history as never })
    await test.settle()
    expect(lineWith(drawn(test), 'from history')).not.toContain(ANY_FADE_COLOR)

    test.stream.start()
    await streamText(test, 'streamed')
    expect(lineWith(drawn(test), 'streamed')).toContain(levelSgr(0))

    test.appendAssistant([{ type: 'text', text: 'streamed' }])
    await test.settle()
    expect(lineWith(drawn(test), 'streamed')).not.toContain(ANY_FADE_COLOR)
    // A later full redraw of the same committed block stays plain.
    expect(await test.screen()).toContain('streamed')
    expect(test.terminal.output).not.toContain(ANY_FADE_COLOR)
  })

  it('ramps towards a dark foreground over a light background', async () => {
    const test = await bench({ color: true, env: { COLORTERM: 'truecolor' }, background: 'rgb:ffff/ffff/ffff' })
    await test.settle()
    test.stream.start()
    await streamText(test, 'hello')
    // White background, assumed black foreground: the darkest level is the
    // white end of the ramp, one fifth of the way down.
    expect(lineWith(drawn(test), 'hello')).toContain('\u001b[38;2;204;204;204m')
  })

  it('drops a background answer that arrives after the user quit', async () => {
    const test = await bench({ ...TRUECOLOR, background: false })
    await test.settle()
    test.terminal.type(KEY.ctrlD)
    await test.settle()
    expect(test.quits).toHaveLength(1)

    test.terminal.type('\u001b]11;rgb:0000/0000/0000\u0007')
    await test.settle()
    test.stream.start()
    await streamText(test, 'hello')
    expect(test.tickDelaysMs()).toEqual([])
  })

  it('draws the two-level mode when the terminal answers the background query with nothing usable', async () => {
    const test = await bench({ color: true, env: { COLORTERM: 'truecolor' } })
    await test.settle()
    test.stream.start()
    await streamText(test, 'hello')
    const faded = lineWith(drawn(test), 'hello')
    expect(faded).toContain(DIM)
    expect(faded).not.toContain(ANY_FADE_COLOR)
  })

  it('writes no sequence at all under reduced motion', async () => {
    const test = await bench({ ...TRUECOLOR, reducedMotion: true })
    await test.settle()
    test.stream.start()
    await streamText(test, 'hello')
    const plain = lineWith(drawn(test), 'hello')
    expect(plain).not.toContain(ANY_FADE_COLOR)
    expect(plain).not.toContain(DIM)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('writes no sequence at all under NO_COLOR', async () => {
    const test = await bench({ ...TRUECOLOR, env: { COLORTERM: 'truecolor', NO_COLOR: '1' } })
    await test.settle()
    test.stream.start()
    await streamText(test, 'hello')
    const plain = lineWith(drawn(test), 'hello')
    expect(plain).not.toContain(ANY_FADE_COLOR)
    expect(plain).not.toContain(DIM)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('honours a configured step count and period', async () => {
    const test = await bench({ ...TRUECOLOR, fadeSteps: 3, fadeStepMs: 25 })
    await test.settle()
    test.stream.start()
    await streamText(test, 'hello')
    expect(test.tickDelaysMs()).toEqual([25])
    // Three levels over a black background put the darkest at 85 per channel.
    expect(lineWith(drawn(test), 'hello')).toContain('\u001b[38;2;85;85;85m')

    // Three levels leave two drawn ones, so the second period settles the chunk.
    test.runTick(25)
    await test.settle()
    expect(lineWith(drawn(test), 'hello')).toContain('\u001b[38;2;170;170;170m')
    test.runTick(25)
    await test.settle()
    expect(lineWith(drawn(test), 'hello')).not.toContain(ANY_FADE_COLOR)
    expect(test.tickArmed(25)).toBe(false)
  })
})
