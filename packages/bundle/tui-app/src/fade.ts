/**
 * Streaming token fade-in for the assistant transcript: the tail state that
 * follows freshly streamed words, the background-to-foreground color ramp they
 * brighten along, the SGR encoding of one ramp level under each terminal
 * capability, and the ANSI-aware transform that recolors the tail inside lines
 * a component already rendered.
 *
 * Rendering contract. Nothing here writes to a terminal, emits a
 * cursor-movement sequence, or tracks a screen row or column. This terminal
 * renders through pi-tui's `TuiMainScreen`, whose differential renderer
 * compares the lines a component returns against the previous frame and
 * repaints only the lines that changed. {@link recolorTail} is therefore a
 * pure transform: it takes the lines the streaming block already produced and
 * returns them with the tail's trailing visible columns recolored. Settled
 * text comes back byte-identical, so the framework leaves it alone and only
 * the tail's lines reach the terminal. That is how "repaint the tail region,
 * never the full viewport" holds in this application.
 *
 * Colors are inputs. The application reads `bg` from pi-tui's
 * `queryTerminalBackgroundColor({ timeoutMs })` on the TUI, or from
 * `parseOsc11BackgroundColor` over a raw OSC 11 reply, and both return
 * pi-tui's `RgbColor`. When that query resolves `undefined` no ramp can be
 * built, so the application passes `capability: 'dim'` with an empty ramp and
 * gets the two-level mode.
 *
 * No value here is read from configuration or the environment at module load:
 * `steps`, the tick period, and every capability input are parameters, so the
 * application can supply validated config values.
 * @module @deepseek-ai/dsh-tui-app/fade
 */

import { sliceByColumn, stripTerminalSequences, visibleWidth, type RgbColor } from '@earendil-works/pi-tui'

/**
 * Brightness levels a chunk passes through. A chunk of age `a` draws at
 * `ramp[min(a, steps - 1)]`, and leaves the tail once its age reaches `steps`.
 * Fewer than two levels leaves no visible ramp, so the application's config
 * field should require at least 2.
 */
export const FADE_STEPS = 5

/** Repaint period in milliseconds: one tick per period, about 25 frames per second. */
export const FADE_TICK_MS = 40

/**
 * Consecutive ticks the fast-stream test looks back over. At
 * {@link FADE_TICK_MS} this window is 400 ms.
 */
export const FADE_FAST_WINDOW_TICKS = 10

/** Control Sequence Introducer. */
const CSI = '\u001b['

/**
 * Ends the foreground color a recolored run set. SGR 39 restores the default
 * foreground only: bold, italic, underline, inverse, and the background set by
 * enclosing markdown styling stay in force.
 */
const RESET_FOREGROUND = `${CSI}39m`

/** Faint intensity: the only ramp level the two-level mode draws. */
const DIM = `${CSI}2m`

/** Ends faint intensity. SGR 22 also ends bold, which shares the code. */
const RESET_INTENSITY = `${CSI}22m`

/** Ages the two-level mode draws faint; later ages draw as rendered. */
const DIM_AGES = 2

/** First xterm 256-color grayscale index. */
const GRAY_FIRST_INDEX = 232

/** Grayscale levels the indices 232..255 carry. */
const GRAY_LEVELS = 24

/** Gray value index 232 carries. */
const GRAY_FIRST_VALUE = 8

/** Gray value step between consecutive grayscale indices. */
const GRAY_VALUE_STEP = 10

/** Relative-luminance weights used to pick the nearest gray. */
const LUMINANCE = { r: 0.2126, g: 0.7152, b: 0.0722 }

/** Largest value one color channel encodes. */
const CHANNEL_MAX = 255

/**
 * Grapheme segmenter for the reverse column walk. pi-tui keeps its own
 * segmenter private, so this module holds one; grapheme segmentation does not
 * vary by locale.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * How far the terminal can encode one ramp level.
 *
 * - `truecolor` writes `ESC[38;2;R;G;Bm`.
 * - `ansi256` writes the nearest xterm grayscale index, `ESC[38;5;Nm` for N in 232..255.
 * - `dim` writes `ESC[2m` for the two youngest ages and nothing afterwards.
 * - `none` writes nothing, so every chunk renders as the component drew it.
 */
export type FadeCapability = 'truecolor' | 'ansi256' | 'dim' | 'none'

/** The resolved drawing settings: how far the terminal encodes, and the levels to encode. */
export interface FadeStyle {
  /** Encoding the terminal supports. */
  capability: FadeCapability
  /** Levels from {@link buildFadeRamp}; ignored by `dim` and `none`, which need no colors. */
  ramp: readonly RgbColor[]
}

/** One tail chunk as {@link recolorTail} consumes it. */
export interface FadeSpan {
  /** The text appended for this chunk, before markdown rendering. */
  text: string
  /** Ticks since the chunk arrived. */
  age: number
}

/** Everything the capability decision reads. */
export interface FadeCapabilityInput {
  /** Whether the terminal palette emits SGR at all; a disabled palette rules out the effect. */
  paletteEnabled: boolean
  /** Process environment; `NO_COLOR`, `COLORTERM`, and `TERM` are read. */
  env: NodeJS.ProcessEnv
  /** Whether the user asked for reduced motion. */
  reducedMotion: boolean
}

/**
 * Decide how far the terminal can draw the ramp.
 *
 * Reduced motion, a disabled palette, a non-empty `NO_COLOR`, and `TERM=dumb`
 * each yield `none`, which draws every chunk at the foreground with no ramp.
 * Otherwise `COLORTERM` of `truecolor` or `24bit` yields `truecolor`, a `TERM`
 * naming `256color` yields `ansi256`, and every other terminal falls back to
 * the two-level `dim` mode.
 * @param input - the palette flag, the environment, and the reduced-motion preference.
 * @returns the capability {@link fadeSgr} and {@link recolorTail} encode under.
 */
export function resolveFadeCapability(input: FadeCapabilityInput): FadeCapability {
  const { env } = input
  if (input.reducedMotion || !input.paletteEnabled) return 'none'
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none'
  const term = env.TERM ?? ''
  if (term === 'dumb') return 'none'
  const colorterm = (env.COLORTERM ?? '').toLowerCase()
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor'
  return term.includes('256color') ? 'ansi256' : 'dim'
}

/**
 * Build the brightness ramp a chunk climbs, `ramp[k] = lerp(bg, fg, (k + 1) /
 * steps)` in sRGB with each channel rounded to a byte. The last level is a
 * copy of `fg` rather than a computed value, so settled text and the last
 * faded frame carry identical color.
 * @param bg - the terminal background color.
 * @param fg - the normal foreground color.
 * @param steps - brightness levels; defaults to {@link FADE_STEPS}.
 * @returns `steps` levels, darkest first.
 */
export function buildFadeRamp(bg: RgbColor, fg: RgbColor, steps: number = FADE_STEPS): RgbColor[] {
  return Array.from({ length: steps }, (_unused, level) => {
    if (level === steps - 1) return { r: fg.r, g: fg.g, b: fg.b }
    const ratio = (level + 1) / steps
    return { r: mix(bg.r, fg.r, ratio), g: mix(bg.g, fg.g, ratio), b: mix(bg.b, fg.b, ratio) }
  })
}

/**
 * Interpolate one channel.
 * @param from - the background channel.
 * @param to - the foreground channel.
 * @param ratio - position between them, 0 at `from` and 1 at `to`.
 * @returns the channel value rounded to a byte.
 */
function mix(from: number, to: number, ratio: number): number {
  return Math.round(from + (to - from) * ratio)
}

/**
 * The SGR sequence one age draws under.
 * @param style - the capability and the ramp.
 * @param age - ticks since the chunk arrived; ages past the ramp draw its last level.
 * @returns the sequence to open the run with, or the empty string when the
 * chunk draws as the component rendered it, which is also what an empty ramp
 * yields under a color capability.
 */
export function fadeSgr(style: FadeStyle, age: number): string {
  if (style.capability === 'none') return ''
  if (style.capability === 'dim') return age < DIM_AGES ? DIM : ''
  const level = style.ramp[Math.max(0, Math.min(age, style.ramp.length - 1))]
  if (level === undefined) return ''
  return style.capability === 'truecolor' ? truecolorSgr(level) : grayscaleSgr(level)
}

/**
 * Encode one level as a 24-bit foreground.
 * @param color - the ramp level.
 * @returns `ESC[38;2;R;G;Bm` with each channel clamped to a byte.
 */
function truecolorSgr(color: RgbColor): string {
  return `${CSI}38;2;${channel(color.r)};${channel(color.g)};${channel(color.b)}m`
}

/**
 * Encode one level as the nearest xterm grayscale index.
 * @param color - the ramp level.
 * @returns `ESC[38;5;Nm` with N in 232..255.
 */
function grayscaleSgr(color: RgbColor): string {
  const luminance = LUMINANCE.r * color.r + LUMINANCE.g * color.g + LUMINANCE.b * color.b
  const step = Math.round((luminance - GRAY_FIRST_VALUE) / GRAY_VALUE_STEP)
  return `${CSI}38;5;${GRAY_FIRST_INDEX + Math.max(0, Math.min(GRAY_LEVELS - 1, step))}m`
}

/**
 * Clamp one channel to what an SGR byte carries.
 * @param value - the channel value.
 * @returns an integer in 0..255.
 */
function channel(value: number): number {
  return Math.max(0, Math.min(CHANNEL_MAX, Math.round(value)))
}

/**
 * The sequence that ends a recolored line.
 * @param capability - the encoding the runs were opened with.
 * @returns `ESC[22m` for the two-level mode, which set intensity, and
 * `ESC[39m` for the color modes, which set a foreground.
 */
function restoreFor(capability: FadeCapability): string {
  return capability === 'dim' ? RESET_INTENSITY : RESET_FOREGROUND
}

/** One chunk of streamed text and the tick it arrived on. */
interface FadeChunk {
  /** Text appended for this chunk; a word plus the whitespace that follows it. */
  text: string
  /** Tick index at arrival. */
  born: number
}

/** Settings a {@link FadeTracker} is built with. */
export interface FadeTrackerOptions {
  /** Brightness levels, and the age at which a chunk leaves the tail. Defaults to {@link FADE_STEPS}. */
  steps?: number
  /** Consecutive arrival ticks that disable the effect. Defaults to {@link FADE_FAST_WINDOW_TICKS}. */
  fastWindowTicks?: number
}

/**
 * The tail of one streaming assistant message: the chunks young enough to be
 * recolored, advanced one tick at a time.
 *
 * Deltas are split at word boundaries, which reads more smoothly than raw
 * token edges. A delta that ends mid-word leaves that word open, and the next
 * delta extends it rather than starting a second chunk, so the word keeps the
 * tick it first became visible on.
 *
 * Fast streams. While each of the last {@link FADE_FAST_WINDOW_TICKS}
 * completed ticks received at least one chunk, the stream outruns the ramp and
 * the effect turns off: the arriving chunk is not tracked and the whole tail is
 * flushed, so nothing already on screen darkens. The decision is recoverable:
 * one tick without an arrival ends it, and chunks appended afterwards fade
 * again. Recovery only affects new chunks, so it never re-darkens settled text.
 */
export class FadeTracker {
  private readonly steps: number
  private readonly fastWindowTicks: number
  private now = 0
  private chunks: FadeChunk[] = []
  private openChunk: FadeChunk | undefined = undefined
  private readonly arrivals = new Set<number>()

  constructor(options?: FadeTrackerOptions) {
    this.steps = options?.steps ?? FADE_STEPS
    this.fastWindowTicks = options?.fastWindowTicks ?? FADE_FAST_WINDOW_TICKS
  }

  /**
   * Take one stream event.
   * @param delta - the text delta; the empty string is not a stream event and is ignored.
   */
  append(delta: string): void {
    if (delta === '') return
    this.arrivals.add(this.now)
    if (this.isFastStream()) {
      this.flush()
      return
    }
    const open = this.openChunk
    const text = open === undefined ? delta : open.text + delta
    const born = open === undefined ? this.now : open.born
    if (open !== undefined) this.chunks.pop()
    this.openChunk = undefined
    const words = text.match(/\s*\S+\s*/g)
    if (words === null) {
      this.openChunk = { text, born }
      this.chunks.push(this.openChunk)
      return
    }
    for (const [index, word] of words.entries()) {
      this.chunks.push({ text: word, born: index === 0 ? born : this.now })
    }
    if (!/\s$/.test(text)) this.openChunk = this.chunks.at(-1)
  }

  /**
   * Advance one tick and drop the chunks that reached `steps`.
   * @returns whether this tick changed a chunk's color, and so needs a repaint.
   */
  tick(): boolean {
    const changing = this.needsRepaint()
    this.now += 1
    this.chunks = this.chunks.filter(chunk => this.now - chunk.born < this.steps)
    if (this.openChunk !== undefined && !this.chunks.includes(this.openChunk)) this.openChunk = undefined
    for (const arrival of this.arrivals) {
      if (arrival < this.now - this.fastWindowTicks) this.arrivals.delete(arrival)
    }
    return changing
  }

  /**
   * Whether the current frame still differs from the settled rendering.
   * @returns true while a tracked chunk draws below the last ramp level, which
   * is the only reason to keep ticking.
   */
  needsRepaint(): boolean {
    return this.chunks.some(chunk => this.now - chunk.born < this.steps - 1)
  }

  /**
   * The tail {@link recolorTail} recolors.
   * @returns one span per tracked chunk, oldest first, each with its current age.
   */
  spans(): FadeSpan[] {
    return this.chunks.map(chunk => ({ text: chunk.text, age: this.now - chunk.born }))
  }

  /**
   * Drop the whole tail so every chunk drawn so far renders at the foreground,
   * and start tracking again from the next delta. The application calls this on
   * a terminal width change and at stream end. The fast-stream window is kept:
   * a resize says nothing about the arrival rate.
   */
  flush(): void {
    this.chunks = []
    this.openChunk = undefined
  }

  /**
   * The fast-stream test.
   * @returns true while every completed tick of the window received at least one chunk.
   */
  private isFastStream(): boolean {
    let covered = 0
    for (let tick = this.now - this.fastWindowTicks; tick < this.now; tick += 1) {
      if (this.arrivals.has(tick)) covered += 1
    }
    return covered >= this.fastWindowTicks
  }
}

/** One grapheme of rendered text at the columns it occupies. */
interface Cell {
  /** Index of the rendered line it sits on. */
  line: number
  /** First visible column it occupies. */
  column: number
  /** Columns it occupies: 2 for a wide character, 0 for a zero-width cluster. */
  width: number
  /** The grapheme cluster itself, with escape sequences already removed. */
  grapheme: string
}

/** A range of visible columns on one line drawn under one sequence. */
interface LineRun {
  /** Index of the rendered line. */
  line: number
  /** First visible column of the run. */
  start: number
  /** Column after the run. */
  end: number
  /** Sequence the run opens with. */
  sgr: string
}

/**
 * Recolor the tail inside lines a component already rendered.
 *
 * The walk runs backwards over visible columns only: escape sequences, wide
 * characters, and grapheme clusters are stepped over as units, never split.
 * Whitespace is skipped on both sides while matching, so a chunk still matches
 * after the renderer turned its space into a line break or trimmed it.
 *
 * Markdown rewrites text, so a chunk may not appear in the rendered output at
 * all. Matching then stops: that chunk and every older chunk of the tail draw
 * at the foreground, unchanged. Because older chunks are already the brightest
 * levels, the degradation is the least visible one available.
 *
 * Styling inside a recolored run survives. The run reasserts the sequences in
 * force at its start, so an enclosing bold or italic continues across it; an
 * enclosing foreground color reasserted there wins over the ramp, and that run
 * simply does not fade. Each recolored line ends with `ESC[39m` (or `ESC[22m`
 * in the two-level mode, which also ends bold) after the line's own closing
 * sequences, so the recolor never leaks past the line it was applied to.
 * @param lines - the rendered lines of the streaming block, newest text last.
 * @param spans - the tail from {@link FadeTracker.spans}, oldest first.
 * @param style - the capability and the ramp.
 * @returns the lines with the tail recolored; lines the tail does not cover
 * are returned byte-identical, so the renderer leaves them alone.
 */
export function recolorTail(lines: readonly string[], spans: readonly FadeSpan[], style: FadeStyle): string[] {
  if (style.capability === 'none' || spans.length === 0 || lines.length === 0) return [...lines]
  const cells = cellsFromEnd(lines)
  const runs: LineRun[] = []
  for (const span of [...spans].reverse()) {
    const covered = consumeSpan(cells, span.text)
    if (covered === undefined) break
    const sgr = fadeSgr(style, span.age)
    if (sgr !== '') collectRuns(runs, covered, sgr)
  }
  const byLine = new Map<number, LineRun[]>()
  for (const run of runs) {
    const known = byLine.get(run.line)
    if (known === undefined) byLine.set(run.line, [run])
    else known.unshift(run)
  }
  const restore = restoreFor(style.capability)
  return lines.map((text, index) => {
    const lineRuns = byLine.get(index)
    return lineRuns === undefined ? text : paintLine(text, lineRuns, restore)
  })
}

/**
 * Walk the rendered lines backwards, one visible grapheme at a time. Lazy: a
 * line is stripped and segmented only once the walk reaches it, so a long
 * settled message costs nothing beyond the lines the tail touches.
 * @param lines - the rendered lines.
 * @returns cells from the last column of the last line towards the first.
 */
function* cellsFromEnd(lines: readonly string[]): Generator<Cell, void, void> {
  for (const [line, text] of [...lines.entries()].reverse()) {
    const cells: Cell[] = []
    let column = 0
    for (const part of GRAPHEMES.segment(stripTerminalSequences(text))) {
      const width = visibleWidth(part.segment)
      cells.push({ line, column, width, grapheme: part.segment })
      column += width
    }
    yield* cells.reverse()
  }
}

/**
 * Take the cells one chunk covers off the walk.
 * @param cells - the backwards walk, positioned at the end of the region still unclaimed.
 * @param text - the chunk's text as it was appended.
 * @returns the cells the chunk covers, whitespace included, or undefined when
 * the chunk's visible characters are not there.
 */
function consumeSpan(cells: Generator<Cell, void, void>, text: string): Cell[] | undefined {
  const wanted = Array.from(GRAPHEMES.segment(text), part => part.segment).filter(part => !isBlank(part)).reverse()
  const covered: Cell[] = []
  for (const want of wanted) {
    let step = cells.next()
    while (!step.done && isBlank(step.value.grapheme)) {
      covered.push(step.value)
      step = cells.next()
    }
    if (step.done || step.value.grapheme !== want) return undefined
    covered.push(step.value)
  }
  return covered
}

/**
 * Whether a grapheme draws nothing.
 * @param grapheme - one grapheme cluster.
 * @returns true for whitespace.
 */
function isBlank(grapheme: string): boolean {
  return grapheme.trim() === ''
}

/**
 * Turn covered cells into runs, merging each cell into the run to its right
 * when they touch on the same line under the same sequence.
 * @param runs - runs collected so far, in the walk's right-to-left order.
 * @param covered - the cells one chunk covers.
 * @param sgr - the sequence the chunk draws under.
 */
function collectRuns(runs: LineRun[], covered: readonly Cell[], sgr: string): void {
  for (const cell of covered) {
    const previous = runs.at(-1)
    if (previous !== undefined && previous.line === cell.line && previous.sgr === sgr && previous.start === cell.column + cell.width) {
      previous.start = cell.column
    } else {
      runs.push({ line: cell.line, start: cell.column, end: cell.column + cell.width, sgr })
    }
  }
}

/**
 * Rebuild one line with its runs recolored.
 * @param text - the rendered line.
 * @param runs - the line's runs, in column order.
 * @param restore - the sequence that ends the last run.
 * @returns the line with each run opened by its sequence, the text between
 * runs untouched, and the line's own trailing sequences kept ahead of `restore`.
 */
function paintLine(text: string, runs: readonly LineRun[], restore: string): string {
  let out = ''
  let cursor = 0
  for (const run of runs) {
    out += sliceByColumn(text, cursor, run.start - cursor)
    out += run.sgr + sliceByColumn(text, run.start, run.end - run.start)
    cursor = run.end
  }
  return `${out}${sliceByColumn(text, cursor, text.length + 1)}${restore}`
}
