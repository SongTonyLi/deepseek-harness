/** Streamed assistant text fading in, and reasoning and tool cards floating out. */

import { describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
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
 * @param background - the terminal background the ramp starts at.
 * @param foreground - the foreground it climbs to.
 * @returns the SGR sequence a chunk of that age opens with.
 */
function levelSgr(
  level: number,
  steps: number = FADE_STEPS,
  background: { r: number; g: number; b: number } = { r: 0, g: 0, b: 0 },
  foreground: { r: number; g: number; b: number } = { r: 255, g: 255, b: 255 },
): string {
  const color = buildFadeRamp(background, foreground, steps)[level]
  if (color === undefined) throw new Error(`the ramp of ${String(steps)} steps has no level ${String(level)}`)
  return `\u001b[38;2;${String(color.r)};${String(color.g)};${String(color.b)}m`
}

/** Any 24-bit foreground, which only the fade emits on this surface. */
const ANY_FADE_COLOR = '\u001b[38;2;'

/** Truecolor overlays a float-out wrote. */
function fadeRgbs(text: string): { r: number; g: number; b: number }[] {
  return [...text.matchAll(/\u001b\[38;2;(\d+);(\d+);(\d+)m/g)].map(([, r, g, b]) => ({
    r: Number(r),
    g: Number(g),
    b: Number(b),
  }))
}

/** Relative luminance of one overlay color. */
function rgbLuma(color: { r: number; g: number; b: number }): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
}

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
    await fadeTick(test)
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
    expect(lineWith(drawn(test), 'hello')).toContain(levelSgr(0, undefined, { r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }))
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

  it('leaves dim reasoning in its settled faint bytes, with no color overlay', async () => {
    const test = await bench({ color: true, env: { COLORTERM: 'truecolor' } })
    await test.settle()
    test.stream.start()
    await streamReasoning(test, 'weighing the options')
    const faded = lineWith(drawn(test), 'weighing')
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

  it('floats streamed reasoning out from a lifted color and settles on the dim italic bytes', async () => {
    const test = await bench(TRUECOLOR)
    await test.settle()
    test.stream.start()
    await streamReasoning(test, 'weighing the options')
    const first = lineWith(drawn(test), 'weighing')
    const firstColor = fadeRgbs(first)[0]
    expect(firstColor).toBeDefined()
    expect(rgbLuma(firstColor ?? { r: 0, g: 0, b: 0 })).toBeGreaterThan(200)
    expect(first).not.toContain(levelSgr(0))

    for (let tick = 0; tick < FADE_STEPS - 1; tick += 1) await fadeTick(test)
    const later = lineWith(drawn(test), 'weighing')
    const laterColor = fadeRgbs(later)[0]
    expect(laterColor).toBeDefined()
    expect(rgbLuma(laterColor ?? { r: 0, g: 0, b: 0 })).toBeLessThan(rgbLuma(firstColor ?? { r: 255, g: 255, b: 255 }))
    expect(later).not.toContain(levelSgr(0))
    await fadeTick(test)
    const settled = lineWith(drawn(test), 'weighing')
    expect(settled).not.toContain(ANY_FADE_COLOR)
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
    const thinking = fadeRgbs(lineWith(output, 'thinking'))[0]
    expect(thinking).toBeDefined()
    expect(rgbLuma(thinking ?? { r: 0, g: 0, b: 0 })).toBeGreaterThan(150)
    expect(lineWith(output, 'thinking')).not.toContain(levelSgr(1))
    expect(lineWith(output, 'answering')).toContain(levelSgr(0))
  })

  it('keeps one tail per streamed region, so a later delta joins the words already fading', async () => {
    const test = await bench(TRUECOLOR)
    await test.settle()
    test.stream.start()
    await streamReasoning(test, 'thinking ')
    // Two frames lift the first word far enough to round below the second.
    await fadeTick(test)
    await fadeTick(test)
    drawn(test)
    await streamReasoning(test, 'harder')
    const reasoning = lineWith(drawn(test), 'harder')
    const reasoningColors = fadeRgbs(reasoning)
    expect(reasoningColors).toHaveLength(2)
    expect(rgbLuma(reasoningColors[0] ?? { r: 0, g: 0, b: 0 })).toBeLessThan(rgbLuma(reasoningColors[1] ?? { r: 255, g: 255, b: 255 }))
    expect(reasoning).not.toContain(levelSgr(0))

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

  it('floats a tool card out when its call is logged and its result rows when they land', async () => {
    const test = await bench(TRUECOLOR)
    await test.settle()
    test.appendToolCall('call-1', 'probe', { path: 'x' })
    await test.settle()
    const callFirst = lineWith(drawn(test), 'probe')
    const callColor = fadeRgbs(callFirst)[0]
    expect(callColor).toBeDefined()
    expect(rgbLuma(callColor ?? { r: 0, g: 0, b: 0 })).toBeGreaterThan(200)
    expect(callFirst).not.toContain(levelSgr(0))
    expect(test.tickArmed(FADE_TICK_MS)).toBe(true)

    await fadeTick(test)
    await fadeTick(test)
    const callMid = lineWith(drawn(test), 'probe')
    expect(Math.min(...fadeRgbs(callMid).map(rgbLuma))).toBeLessThan(254)
    expect(callMid).not.toContain(levelSgr(0))

    for (let tick = 2; tick < FADE_STEPS - 1; tick += 1) await fadeTick(test)
    drawn(test)
    await fadeTick(test)
    expect(lineWith(drawn(test), 'probe')).not.toContain(ANY_FADE_COLOR)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(false)

    test.appendToolResult('call-1', [{ type: 'text', text: 'result row' }])
    await test.settle()
    const landed = drawn(test)
    const resultFirst = lineWith(landed, 'result row')
    const resultColor = fadeRgbs(resultFirst)[0]
    expect(resultColor).toBeDefined()
    expect(rgbLuma(resultColor ?? { r: 0, g: 0, b: 0 })).toBeGreaterThan(150)
    expect(resultFirst).not.toContain(levelSgr(0))
    expect(lineWith(landed, 'probe')).not.toContain(ANY_FADE_COLOR)
    expect(test.tickArmed(FADE_TICK_MS)).toBe(true)

    for (let tick = 0; tick < FADE_STEPS - 1; tick += 1) await fadeTick(test)
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
    expect(fadeRgbs(lineWith(cards, 'gamma')).length).toBeGreaterThan(0)

    await fadeTick(test)
    await fadeTick(test)
    expect(fadeRgbs(lineWith(drawn(test), 'gamma')).length).toBeGreaterThan(0)
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
    expect(fadeRgbs(lineWith(drawn(test), 'alpha')).length).toBeGreaterThan(0)

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
    expect(fadeRgbs(lineWith(drawn(test), 'weighing')).length).toBeGreaterThan(0)

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

    // Three fade-in levels leave two drawn ones; the last period drops the tail.
    test.runTick(25)
    await test.settle()
    expect(lineWith(drawn(test), 'hello')).toContain(levelSgr(1, 3))
    test.runTick(25)
    await test.settle()
    expect(lineWith(drawn(test), 'hello')).not.toContain(ANY_FADE_COLOR)
    test.runTick(25)
    await test.settle()
    expect(test.tickArmed(25)).toBe(false)
  })
})

describe('syntax colour', () => {
  /** Whether a drawn line carries a colour off the fade's own gray ramp. */
  function hasSyntaxColor(line: string): boolean {
    return fadeRgbs(line).some(color => color.r !== color.g || color.g !== color.b)
  }

  it('repaints a fenced block in colour once its grammar has landed', async () => {
    const test = await bench(TRUECOLOR)
    await test.settle()
    // A committed message carries no fade, so the only colours on its lines
    // are the ones the highlighter put there. The grammar is a real import:
    // the block draws plain first and the highlighter asks for the frame
    // again once it is there.
    const since = writesFrom(test)
    test.appendAssistant([{ type: 'text', text: 'here:\n\n```ts\nconst rows = 42\n```' }])
    await test.settle()
    // Each token opens with its own colour, so the row is matched on one word.
    let line: string | undefined
    for (let pass = 0; pass < 200 && line === undefined; pass += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
      await test.settle()
      line = since().split('\n').findLast(row => row.includes('const') && hasSyntaxColor(row))
    }
    expect(line, 'the fenced block was never repainted in colour').toBeDefined()
    expect(line).toContain('rows')
  }, 20_000)

  it('repaints the file rows of a read card and an edit diff in the file\'s language', async () => {
    // Reduced motion attaches no card fade, so the only colours on the rows
    // are the highlighter's; colour is not motion, so it is still drawn.
    const test = await bench({
      ...TRUECOLOR,
      reducedMotion: true,
      toolPreviewLines: 8,
      before: async (ctx) => {
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRuntime)
        const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }] }
        ctx.tools.register({
          name: 'read', description: 'read', parameters: { type: 'object', properties: {} }, output,
          execute: () => Promise.resolve('unused'),
          presentResult: () => ({ card: 'read', path: 'a.ts', offset: 1, totalLines: 1, lang: 'ts', lines: [{ number: 1, text: 'const rows = 42' }] }),
        })
        ctx.tools.register({
          name: 'edit', description: 'edit', parameters: { type: 'object', properties: {} }, output,
          execute: () => Promise.resolve('unused'),
          presentCall: () => ({ card: 'diff', title: 'Edit b.ts', diffs: [{ path: 'b.ts', oldText: 'let old = 1\n', newText: 'const fresh = 2\n' }] }),
        })
      },
    })
    await test.settle()
    const since = writesFrom(test)
    test.appendToolCall('call-1', 'read', {})
    test.appendToolResult('call-1', [{ type: 'text', text: '1: const rows = 42' }])
    test.appendToolCall('call-2', 'edit', {})
    await test.settle()
    // The grammar is a real import, so the rows draw plain first and are
    // painted once the highlighter asks for the frame again; the line number
    // and the diff sign stay outside the language's colour.
    let read: string | undefined
    let removed: string | undefined
    let added: string | undefined
    for (let pass = 0; pass < 200 && (read === undefined || removed === undefined || added === undefined); pass += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
      await test.settle()
      const rows = since().split('\n')
      read ??= rows.findLast(row => row.includes('rows') && hasSyntaxColor(row))
      removed ??= rows.findLast(row => row.includes('old') && hasSyntaxColor(row))
      added ??= rows.findLast(row => row.includes('fresh') && hasSyntaxColor(row))
    }
    expect(read, 'the read rows were never painted').toBeDefined()
    expect(removed, 'the removed diff rows were never painted').toBeDefined()
    expect(added, 'the added diff rows were never painted').toBeDefined()
    expect(read).toMatch(/1│ \u001b\[/u)
    // The sign carries its own colour, and the file's language starts after it.
    expect(removed).toMatch(/-\u001b\[39m \u001b\[/u)
    expect(added).toMatch(/\+\u001b\[39m \u001b\[/u)
  }, 20_000)

  it('repaints a ! draft, a $ command row, and a terminal card once the shell grammar has landed', async () => {
    const test = await bench({
      ...TRUECOLOR,
      reducedMotion: true,
      before: async (ctx) => {
        ctx.provide('shell', {
          resolve: (request: { command: string }) => request,
          execute: () => ({
            result: async () => ({
              exitCode: 0,
              signal: null,
              timedOut: false,
              aborted: false,
              timeoutMs: 30_000,
              stdout: { text: 'hi\n', truncated: false },
              stderr: { text: '', truncated: false },
            }),
          }),
        } as never)
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRuntime)
        ctx.tools.register({
          name: 'bash',
          description: 'run',
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'string' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }] },
          execute: () => Promise.resolve('unused'),
          presentCall: () => ({ card: 'terminal' as const, title: 'echo hi', cwd: '/w' }),
        })
      },
    })
    await test.settle()
    const since = writesFrom(test)
    for (const char of '!echo hi') test.terminal.type(char)
    await test.settle()
    let draft: string | undefined
    for (let pass = 0; pass < 200 && draft === undefined; pass += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
      await test.settle()
      draft = since().split('\n').findLast(row => row.includes('echo') && hasSyntaxColor(row))
    }
    expect(draft, 'the ! draft was never painted').toBeDefined()
    test.terminal.type(KEY.enter)
    await test.settle()
    let submitted: string | undefined
    for (let pass = 0; pass < 200 && submitted === undefined; pass += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
      await test.settle()
      submitted = since().split('\n').findLast(row => row.includes('$') && row.includes('echo') && hasSyntaxColor(row))
    }
    expect(submitted, 'the $ command row was never painted').toBeDefined()
    expect(submitted).toMatch(/\$(?:\u001b\[39m)? \u001b\[/u)
    test.appendToolCall('call-1', 'bash', {})
    await test.settle()
    let card: string | undefined
    for (let pass = 0; pass < 200 && card === undefined; pass += 1) {
      await new Promise(resolve => setTimeout(resolve, 20))
      await test.settle()
      card = since().split('\n').findLast(row => row.includes('$') && row.includes('echo') && hasSyntaxColor(row))
    }
    expect(card, 'the terminal card command was never painted').toBeDefined()
    expect(card).toMatch(/\$ \u001b\[/u)
  }, 20_000)

  it('draws every fence plain where the setting is off', async () => {
    const test = await bench({ ...TRUECOLOR, codeHighlight: false })
    await test.settle()
    const since = writesFrom(test)
    test.appendAssistant([{ type: 'text', text: '```ts\nconst rows = 42\n```' }])
    await test.settle()
    await new Promise(resolve => setTimeout(resolve, 300))
    await test.settle()
    expect(since().split('\n').some(row => row.includes('const') && hasSyntaxColor(row))).toBe(false)
  }, 20_000)
})
