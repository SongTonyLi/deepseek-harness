/** Streamed assistant text fading in: the colors it draws, the tick that ages it, and everything that settles it. */

import { describe, expect, it } from 'vitest'
import { FADE_STEPS, FADE_TICK_MS, buildFadeRamp } from '../src/fade.ts'
import { KEY, bench, type Bench } from './bench.ts'

/** A terminal that reports a black background and encodes 24-bit color. */
const TRUECOLOR = {
  color: true,
  env: { COLORTERM: 'truecolor' },
  background: 'rgb:0000/0000/0000',
} as const

/**
 * The 24-bit foreground of one brightness level over a black background, which
 * the app builds towards the white foreground it assumes there.
 * @param level - the ramp level, 0 for the darkest.
 * @param steps - brightness levels the ramp carries; the shipped default by default.
 * @returns the SGR sequence a chunk of that age opens with.
 */
function levelSgr(level: number, steps: number = FADE_STEPS): string {
  const color = buildFadeRamp({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, steps)[level]
  if (color === undefined) throw new Error(`the ramp of ${String(steps)} steps has no level ${String(level)}`)
  return `\u001b[38;2;${String(color.r)};${String(color.g)};${String(color.b)}m`
}

/** Any 24-bit foreground, which only the fade emits on this surface. */
const ANY_FADE_COLOR = '\u001b[38;2;'

/** Faint intensity, the only level the two-level mode draws. */
const DIM = '\u001b[2m'

/** Clear-scrollback sequence, which pi-tui writes only on a full redraw. */
const CLEAR_SCROLLBACK = '\u001b[3J'

/** Terminal height the specs that pin the repaint window run at. */
const SHORT_TERMINAL_ROWS = 20

/** Call arguments that wrap over several rows at the bench's width. */
const WIDE_ARGUMENTS = { path: 'x'.repeat(600) }

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
 * Stream one reasoning delta into the bound Agent and let the renderer draw it.
 * @param test - the running bench.
 * @param text - the delta.
 */
async function streamReasoning(test: Bench, text: string): Promise<void> {
  test.stream.chunk({ type: 'reasoning-delta', index: 0, text })
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
 * Everything the renderer writes from this moment on, which includes the frames
 * {@link drawn} consumes, so an invariant that must hold over a whole scenario
 * reads them too.
 * @param test - the running bench.
 * @returns a reader of the output written since this call.
 */
function writesFrom(test: Bench): () => string {
  const start = test.terminal.written.length
  return () => test.terminal.written.slice(start)
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
    // white end of the ramp, one smoothstep level down from it.
    expect(lineWith(drawn(test), 'hello')).toContain('\u001b[38;2;250;250;250m')
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

  it('fades streamed reasoning on its own tail and settles it at the dim foreground', async () => {
    const test = await bench(TRUECOLOR)
    await test.settle()
    test.stream.start()
    await streamReasoning(test, 'weighing the options')
    expect(lineWith(drawn(test), 'weighing')).toContain(levelSgr(0))

    for (let level = 1; level < FADE_STEPS - 1; level += 1) await fadeTick(test)
    expect(lineWith(drawn(test), 'weighing')).toContain(levelSgr(FADE_STEPS - 2))
    await fadeTick(test)
    const settled = lineWith(drawn(test), 'weighing')
    expect(settled).not.toContain(ANY_FADE_COLOR)
    // The ramp runs inside the faint sequence the reasoning is drawn in, so it
    // arrives at the dim foreground rather than the plain one.
    expect(settled).toContain(DIM)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('ages the reasoning tail and the text tail apart, each from the moment its own words appeared', async () => {
    const test = await bench(TRUECOLOR)
    await test.settle()
    test.stream.start()
    await streamReasoning(test, 'thinking')
    await fadeTick(test)
    await streamText(test, 'answering')
    const output = drawn(test)
    expect(lineWith(output, 'thinking')).toContain(levelSgr(1))
    expect(lineWith(output, 'answering')).toContain(levelSgr(0))
  })

  it('keeps one tail per streamed region, so a later delta joins the words already fading', async () => {
    const test = await bench(TRUECOLOR)
    await test.settle()
    test.stream.start()
    await streamReasoning(test, 'thinking ')
    await fadeTick(test)
    drawn(test)
    await streamReasoning(test, 'harder')
    const reasoning = lineWith(drawn(test), 'harder')
    expect(reasoning).toContain(levelSgr(1))
    expect(reasoning).toContain(levelSgr(0))

    await streamText(test, 'alpha ')
    await fadeTick(test)
    drawn(test)
    await streamText(test, 'beta')
    const text = lineWith(drawn(test), 'beta')
    expect(text).toContain(levelSgr(1))
    expect(text).toContain(levelSgr(0))
  })

  it('settles both tails on a width change', async () => {
    const test = await bench(TRUECOLOR)
    await test.settle()
    test.stream.start()
    await streamReasoning(test, 'thinking')
    await streamText(test, 'answering')

    test.terminal.resize(70)
    await test.settle()
    const output = drawn(test)
    expect(lineWith(output, 'thinking')).not.toContain(ANY_FADE_COLOR)
    expect(lineWith(output, 'answering')).not.toContain(ANY_FADE_COLOR)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('fades a tool card in when its call is logged and its result rows when they land', async () => {
    const test = await bench(TRUECOLOR)
    await test.settle()
    test.appendToolCall('call-1', 'probe', { path: 'x' })
    await test.settle()
    expect(lineWith(drawn(test), 'probe')).toContain(levelSgr(0))
    expect(test.tickArmed(FADE_TICK_MS)).toBe(true)

    for (let level = 1; level < FADE_STEPS - 1; level += 1) await fadeTick(test)
    drawn(test)
    await fadeTick(test)
    expect(lineWith(drawn(test), 'probe')).not.toContain(ANY_FADE_COLOR)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)

    test.appendToolResult('call-1', [{ type: 'text', text: 'result row' }])
    await test.settle()
    const landed = drawn(test)
    expect(lineWith(landed, 'result row')).toContain(levelSgr(0))
    // The call rows settled before the result arrived and keep their colors.
    expect(lineWith(landed, 'probe')).not.toContain(ANY_FADE_COLOR)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(true)

    for (let level = 1; level < FADE_STEPS - 1; level += 1) await fadeTick(test)
    drawn(test)
    await fadeTick(test)
    expect(lineWith(drawn(test), 'result row')).not.toContain(ANY_FADE_COLOR)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('draws the cards of a replayed session settled, however long ago they were logged', async () => {
    const history = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'tool/call', seq: 1, time: 2, data: { turn: 1, step: 1, callId: 'call-1', name: 'probe', arguments: '{"path":"x"}' } },
    ]
    const test = await bench({ ...TRUECOLOR, history: history as never })
    await test.settle()
    expect(lineWith(drawn(test), 'probe')).not.toContain(ANY_FADE_COLOR)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('leaves tool cards in their own colors under reduced motion', async () => {
    const test = await bench({ ...TRUECOLOR, reducedMotion: true })
    await test.settle()
    test.appendToolCall('call-1', 'probe', { path: 'x' })
    test.appendToolResult('call-1', [{ type: 'text', text: 'result row' }])
    await test.settle()
    const output = drawn(test)
    expect(lineWith(output, 'probe')).not.toContain(ANY_FADE_COLOR)
    expect(lineWith(output, 'result row')).not.toContain(ANY_FADE_COLOR)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)
  })

  it('keeps the rows above the repaint window out of a card fade, and never clears the scrollback', async () => {
    const test = await bench(TRUECOLOR)
    // A short terminal: pi-tui repaints only the last `rows` lines of the frame
    // differentially and clears the scrollback for a change above them.
    test.terminal.rows = SHORT_TERMINAL_ROWS
    await test.settle()
    const since = writesFrom(test)
    for (const key of 'run them') test.terminal.type(key)
    test.terminal.type(KEY.enter)
    await test.settle()
    // Three calls of one step, logged together, each wrapping over several
    // rows: the first card is already above the window when the frame is drawn.
    test.appendToolCall('call-1', 'alpha', WIDE_ARGUMENTS)
    test.appendToolCall('call-2', 'beta', WIDE_ARGUMENTS)
    test.appendToolCall('call-3', 'gamma', WIDE_ARGUMENTS)
    await test.settle()
    const cards = drawn(test)
    expect(lineWith(cards, 'alpha')).not.toContain(ANY_FADE_COLOR)
    expect(lineWith(cards, 'gamma')).toContain(levelSgr(0))

    await fadeTick(test)
    await fadeTick(test)
    expect(lineWith(drawn(test), 'gamma')).toContain(levelSgr(2))
    expect(since()).not.toContain(CLEAR_SCROLLBACK)
  })

  it('settles a card that later content pushed above the window, in the frame that pushed it', async () => {
    const test = await bench(TRUECOLOR)
    test.terminal.rows = SHORT_TERMINAL_ROWS
    await test.settle()
    const since = writesFrom(test)
    test.appendToolCall('call-1', 'alpha', WIDE_ARGUMENTS)
    await test.settle()
    await fadeTick(test)
    expect(lineWith(drawn(test), 'alpha')).toContain(levelSgr(1))

    test.appendToolCall('call-2', 'beta', WIDE_ARGUMENTS)
    test.appendToolCall('call-3', 'gamma', WIDE_ARGUMENTS)
    await test.settle()
    expect(lineWith(drawn(test), 'alpha')).not.toContain(ANY_FADE_COLOR)

    await fadeTick(test)
    await fadeTick(test)
    expect(since()).not.toContain(CLEAR_SCROLLBACK)
  })

  it('draws a card taller than the screen in its own colors rather than clearing the scrollback', async () => {
    const test = await bench(TRUECOLOR)
    test.terminal.rows = SHORT_TERMINAL_ROWS
    await test.settle()
    const since = writesFrom(test)
    test.appendToolCall('call-1', 'alpha', { path: 'x'.repeat(2_400) })
    await test.settle()
    expect(lineWith(drawn(test), 'alpha')).not.toContain(ANY_FADE_COLOR)

    await fadeTick(test)
    expect(since()).not.toContain(CLEAR_SCROLLBACK)
  })

  it('stops the reasoning tail at the window once the reply streamed past it', async () => {
    const test = await bench(TRUECOLOR)
    test.terminal.rows = SHORT_TERMINAL_ROWS
    await test.settle()
    const since = writesFrom(test)
    test.stream.start()
    await streamReasoning(test, 'weighing the options')
    expect(lineWith(drawn(test), 'weighing')).toContain(levelSgr(0))

    await streamText(test, Array.from({ length: 30 }, (_, line) => `reply ${String(line)}`).join('\n\n'))
    await fadeTick(test)
    expect(lineWith(drawn(test), 'weighing')).not.toContain(ANY_FADE_COLOR)
    expect(since()).not.toContain(CLEAR_SCROLLBACK)
  })

  it('honours a configured step count and period', async () => {
    const test = await bench({ ...TRUECOLOR, fadeSteps: 3, fadeStepMs: 25 })
    await test.settle()
    test.stream.start()
    await streamText(test, 'hello')
    expect(test.tickDelaysMs()).toEqual([25])
    expect(lineWith(drawn(test), 'hello')).toContain(levelSgr(0, 3))

    // Three levels leave two drawn ones, so the second period settles the chunk.
    test.runTick(25)
    await test.settle()
    expect(lineWith(drawn(test), 'hello')).toContain(levelSgr(1, 3))
    test.runTick(25)
    await test.settle()
    expect(lineWith(drawn(test), 'hello')).not.toContain(ANY_FADE_COLOR)
    expect(test.tickArmed(25)).toBe(false)
  })
})
