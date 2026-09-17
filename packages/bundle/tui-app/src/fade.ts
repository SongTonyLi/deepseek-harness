/**
 * Streaming token fade-in for the assistant transcript: the tail state that
 * follows freshly streamed words, the background-to-foreground color ramp they
 * brighten along, the SGR encoding of one ramp level under each terminal
 * capability, the ANSI-aware transform that recolors the tail inside lines a
 * component already rendered, and the whole-line transform and clocks that
 * fade a block in as a unit.
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
 * How far up a block either transform may reach is the caller's decision, and
 * `./screen.ts` owns the rule it follows: both take a first repaintable line
 * and hand every line above it back untouched.
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
export const FADE_STEPS = 8

/** Duration of one brightness level in milliseconds, and so the repaint period of fading text: about 30 frames per second. */
export const FADE_TICK_MS = 33

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

/** Encoded sRGB value below which the transfer function is the linear segment. */
const SRGB_LINEAR_CUT = 0.04045

/** Linear intensity below which the sRGB transfer function is the linear segment. */
const LINEAR_SRGB_CUT = 0.0031308

/** Slope of the sRGB transfer function's linear segment. */
const SRGB_LINEAR_SLOPE = 12.92

/** Offset of the sRGB transfer function's power segment. */
const SRGB_OFFSET = 0.055

/** Exponent of the sRGB transfer function's power segment. */
const SRGB_GAMMA = 2.4

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
  /** Brightness levels the chunk has climbed since it became visible. */
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
 * Build the brightness ramp a chunk climbs: level `k` sits at
 * `t = (k + 1) / steps` of the way from `bg` to `fg`, eased by the smoothstep
 * `t * t * (3 - 2 * t)` and interpolated with each channel in linear light.
 * Both shape the ramp against what the eye reads rather than what the byte
 * says: sRGB bytes are gamma-encoded, so mixing them directly bunches the
 * visible change into the dark end, and an even ramp of levels arrives with a
 * hard start and stop. The last level is a copy of `fg` rather than a computed
 * value, so settled text and the last faded frame carry identical color.
 * @param bg - the terminal background color.
 * @param fg - the normal foreground color.
 * @param steps - brightness levels; defaults to {@link FADE_STEPS}.
 * @returns `steps` levels, darkest first.
 */
export function buildFadeRamp(bg: RgbColor, fg: RgbColor, steps: number = FADE_STEPS): RgbColor[] {
  return Array.from({ length: steps }, (_unused, level) => {
    if (level === steps - 1) return { r: fg.r, g: fg.g, b: fg.b }
    const position = (level + 1) / steps
    const eased = position * position * (3 - 2 * position)
    return { r: mix(bg.r, fg.r, eased), g: mix(bg.g, fg.g, eased), b: mix(bg.b, fg.b, eased) }
  })
}

/**
 * Interpolate one channel in linear light.
 * @param from - the background channel, sRGB-encoded.
 * @param to - the foreground channel, sRGB-encoded.
 * @param ratio - position between them, 0 at `from` and 1 at `to`.
 * @returns the sRGB-encoded channel value rounded to a byte.
 */
function mix(from: number, to: number, ratio: number): number {
  const linear = toLinear(from)
  return toSrgb(linear + (toLinear(to) - linear) * ratio)
}

/**
 * Decode one sRGB channel to linear light, by the sRGB transfer function.
 * @param value - the channel byte.
 * @returns the linear intensity in 0..1.
 */
function toLinear(value: number): number {
  const encoded = value / CHANNEL_MAX
  return encoded <= SRGB_LINEAR_CUT ? encoded / SRGB_LINEAR_SLOPE : ((encoded + SRGB_OFFSET) / (1 + SRGB_OFFSET)) ** SRGB_GAMMA
}

/**
 * Encode linear light back to an sRGB channel byte.
 * @param value - the linear intensity in 0..1.
 * @returns the channel byte.
 */
function toSrgb(value: number): number {
  const encoded = value <= LINEAR_SRGB_CUT
    ? SRGB_LINEAR_SLOPE * value
    : (1 + SRGB_OFFSET) * value ** (1 / SRGB_GAMMA) - SRGB_OFFSET
  return Math.round(encoded * CHANNEL_MAX)
}

/**
 * The SGR sequence one age draws under.
 * @param style - the capability and the ramp.
 * @param age - the brightness level; levels past the ramp draw its last one.
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

/** Every SGR sequence, the sequences a block's own palette styling writes. */
const SGR_SEQUENCE = /\u001b\[[0-9;]*m/g

/**
 * Draw whole rendered lines at one brightness level, for a block that fades in
 * as a unit rather than word by word.
 *
 * The level is opened at the start of the line and reasserted after every SGR
 * the line already carries, so the palette colors inside a card - the status
 * glyph, the dim body rule, the bold tool name - are overridden while the card
 * fades and come back on their own once it settles. Each line ends with the
 * sequence that undoes what the level set - the terminal's own foreground, or
 * its normal intensity in the two-level mode - so the level never leaks past
 * the line it was applied to. Empty lines come back byte-identical, so
 * the renderer leaves the blank rows around a card alone.
 * @param lines - the rendered lines of the block.
 * @param age - the brightness level to draw them at.
 * @param style - the capability and the ramp.
 * @param from - first line the level is applied to; the lines before it come
 * back byte-identical, which is how a caller keeps rows the renderer can no
 * longer repaint out of the fade.
 * @returns the lines at that level; copies when the style writes no sequence
 * for this age, which is what the `none` capability and a settled age yield.
 */
export function recolorLines(lines: readonly string[], age: number, style: FadeStyle, from = 0): string[] {
  const sgr = fadeSgr(style, age)
  if (sgr === '') return [...lines]
  const restore = restoreFor(style.capability)
  return lines.map((line, index) => index < from || line === ''
    ? line
    : `${sgr}${line.replace(SGR_SEQUENCE, match => match + sgr)}${restore}`)
}

/** One chunk of streamed text and the instant it became visible. */
interface FadeChunk {
  /** Text appended for this chunk; a word plus the whitespace that follows it. */
  text: string
  /** Wall-clock time the chunk became visible, in milliseconds. */
  bornAt: number
}

/** Settings a {@link FadeTracker} is built with. */
export interface FadeTrackerOptions {
  /** Brightness levels, and the age at which a chunk leaves the tail. Defaults to {@link FADE_STEPS}. */
  steps?: number
  /** How long one brightness level lasts, in milliseconds. Defaults to {@link FADE_TICK_MS}. */
  stepMs?: number
  /**
   * The wall clock ages are measured against.
   * @returns the current time in milliseconds.
   */
  now: () => number
}

/**
 * The tail of one streaming region - the visible text or the reasoning of one
 * message: the chunks young enough to be recolored, each ageing on the wall
 * clock from the moment it became visible.
 *
 * Deltas are split at word boundaries, which reads more smoothly than raw
 * token edges. A delta that ends mid-word leaves that word open, and the next
 * delta extends it rather than starting a second chunk, so the word keeps the
 * moment it first became visible.
 *
 * Ages are read, never counted. A chunk's age is the elapsed time since it
 * became visible divided by `stepMs`, computed at the moment a render asks for
 * it, so a render triggered by a delta between two fade periods draws every
 * word at its own level and words do not move in lockstep. That is what makes
 * the trailing edge continuous rather than banded.
 *
 * Arrival rate changes the tail's length, never its depth: whatever the rate,
 * a chunk is at the foreground `steps * stepMs` after it appeared, so a fast
 * stream leaves a longer trail of brightening words and never a darker or a
 * lasting one. The tail is bounded in time, so it stays on at any rate.
 */
export class FadeTracker {
  private readonly steps: number
  private readonly stepMs: number
  private readonly now: () => number
  private chunks: FadeChunk[] = []
  private openChunk: FadeChunk | undefined = undefined

  constructor(options: FadeTrackerOptions) {
    this.steps = options.steps ?? FADE_STEPS
    this.stepMs = options.stepMs ?? FADE_TICK_MS
    this.now = options.now
  }

  /**
   * Take one stream event.
   * @param delta - the text delta; the empty string is not a stream event and is ignored.
   */
  append(delta: string): void {
    if (delta === '') return
    const at = this.now()
    const open = this.openChunk
    const text = open === undefined ? delta : open.text + delta
    const bornAt = open === undefined ? at : open.bornAt
    if (open !== undefined) this.chunks.pop()
    this.openChunk = undefined
    const words = text.match(/\s*\S+\s*/g)
    if (words === null) {
      this.openChunk = { text, bornAt }
      this.chunks.push(this.openChunk)
      return
    }
    for (const [index, word] of words.entries()) {
      this.chunks.push({ text: word, bornAt: index === 0 ? bornAt : at })
    }
    if (!/\s$/.test(text)) this.openChunk = this.chunks.at(-1)
  }

  /**
   * Drop the chunks that reached the step count, which the application runs
   * once per fade period so a settled chunk stops being matched against the
   * rendered lines.
   * @returns whether a chunk still draws below the last brightness level, and
   * so whether the tail keeps moving after this period.
   */
  tick(): boolean {
    const moving = this.needsRepaint()
    this.chunks = this.chunks.filter(chunk => this.ageOf(chunk) < this.steps)
    if (this.openChunk !== undefined && !this.chunks.includes(this.openChunk)) this.openChunk = undefined
    return moving
  }

  /**
   * Whether the current frame still differs from the settled rendering.
   * @returns true while a tracked chunk draws below the last ramp level, which
   * is the only reason to keep ticking.
   */
  needsRepaint(): boolean {
    return this.chunks.some(chunk => this.ageOf(chunk) < this.steps - 1)
  }

  /**
   * The tail {@link recolorTail} recolors.
   * @returns one span per tracked chunk, oldest first, each with the age it
   * carries at this instant.
   */
  spans(): FadeSpan[] {
    return this.chunks.map(chunk => ({ text: chunk.text, age: this.ageOf(chunk) }))
  }

  /**
   * Drop the whole tail so every chunk drawn so far renders at the foreground,
   * and start tracking again from the next delta. The application calls this on
   * a terminal width change and at stream end.
   */
  flush(): void {
    this.chunks = []
    this.openChunk = undefined
  }

  /**
   * The brightness level one chunk draws at right now.
   * @param chunk - the tracked chunk.
   * @returns levels elapsed since it became visible, 0 for a chunk younger than one level.
   */
  private ageOf(chunk: FadeChunk): number {
    return Math.floor((this.now() - chunk.bornAt) / this.stepMs)
  }
}

/** Settings a {@link BlockFadeClock} is built with. */
export interface BlockFadeClockOptions {
  /** Wall-clock time the block became visible, in milliseconds. */
  bornAt: number
  /** How long one brightness level lasts, in milliseconds. */
  stepMs: number
  /** Brightness levels the block climbs. */
  steps: number
  /**
   * The wall clock the age is measured against.
   * @returns the current time in milliseconds.
   */
  now: () => number
}

/**
 * The age of one whole block that fades in as a unit - a tool card's rows,
 * which arrive complete rather than word by word.
 *
 * The last level is withheld the way the word tail withholds it: that level is
 * an assumed foreground, so a block one level below the end is handed back to
 * the terminal's own colors instead, and nothing jumps color as it settles.
 */
export class BlockFadeClock {
  constructor(private readonly options: BlockFadeClockOptions) {}

  /**
   * The brightness level the block draws at right now.
   * @returns the level, or undefined once the block reached the last drawn
   * level and renders in the colors the component itself produced.
   */
  age(): number | undefined {
    const { bornAt, stepMs, steps, now } = this.options
    const age = Math.floor((now() - bornAt) / stepMs)
    return age < steps - 1 ? age : undefined
  }

  /**
   * Whether this block still draws below the last brightness level.
   * @returns true while {@link BlockFadeClock.age} yields a level.
   */
  needsRepaint(): boolean {
    return this.age() !== undefined
  }
}

/** What {@link FadeRegistry} keeps: anything that reports whether it is still moving. */
export interface RegisteredFade {
  /**
   * Whether this fade still draws below the last brightness level.
   * @returns true while it keeps moving.
   */
  needsRepaint(): boolean
}

/**
 * The block fades running right now. The application arms its repaint while
 * any member still moves, so the registry holds only members that have not
 * settled: {@link FadeRegistry.tick} drops the settled ones once per period,
 * and a session change clears the whole set.
 */
export class FadeRegistry {
  private readonly members = new Set<RegisteredFade>()

  /**
   * Track one fade until it settles.
   * @param fade - the fade to follow.
   */
  add(fade: RegisteredFade): void {
    this.members.add(fade)
  }

  /**
   * Whether any tracked fade still moves.
   * @returns true while one of them needs another repaint.
   */
  needsRepaint(): boolean {
    for (const member of this.members) {
      if (member.needsRepaint()) return true
    }
    return false
  }

  /** Forget the fades that settled, so a long session accumulates none of them. */
  tick(): void {
    for (const member of this.members) {
      if (!member.needsRepaint()) this.members.delete(member)
    }
  }

  /** Forget every tracked fade, which the application does when it draws another session. */
  clear(): void {
    this.members.clear()
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
 * @param from - first line the tail may recolor; the lines before it come back
 * byte-identical, which is how a caller keeps rows the renderer can no longer
 * repaint out of the fade.
 * @returns the lines with the tail recolored; lines the tail does not cover
 * are returned byte-identical, so the renderer leaves them alone.
 */
export function recolorTail(lines: readonly string[], spans: readonly FadeSpan[], style: FadeStyle, from = 0): string[] {
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
    const lineRuns = index < from ? undefined : byLine.get(index)
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
