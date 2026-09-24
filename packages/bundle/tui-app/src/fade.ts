/**
 * Streaming token fade for the assistant transcript: the tail state that
 * follows freshly streamed words, the background-to-foreground color ramp
 * visible reply text brightens along, the SGR encoding of one ramp level
 * under each terminal capability, the ANSI-aware transform that recolors a
 * tail inside lines a component already rendered, and the whole-line
 * transform and clocks that float a block out as a unit.
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
 * Visible reply text fades in along {@link buildFadeRamp}. Streamed reasoning
 * and tool cards float out: they start at a lifted mix toward the assumed
 * foreground and recede to the colors the component already drew, and the
 * last frame is those original bytes.
 *
 * No value here is read from configuration or the environment at module load:
 * `steps`, the tick period, and every capability input are parameters, so the
 * application can supply validated config values.
 * @module @deepseek-ai/dsh-tui-app/fade
 */

import { stripTerminalSequences, visibleWidth, type RgbColor } from '@earendil-works/pi-tui'
import { sliceColumns } from './columns.ts'

/**
 * Brightness levels a chunk passes through. A chunk of age `a` draws between
 * `ramp[floor(a)]` and the level after it, and leaves the tail once its age
 * reaches `steps`. Fewer than two levels leaves no visible ramp, so the
 * application's config field should require at least 2.
 *
 * Twenty-four at {@link FADE_TICK_MS} is a ramp of about four hundred
 * milliseconds, one level per frame: enough levels that a word climbs rather
 * than steps, and short enough that a settled line is never waited for.
 */
export const FADE_STEPS = 24

/** Duration of one brightness level in milliseconds, and so the repaint period of fading text: about 60 frames per second. */
export const FADE_TICK_MS = 16

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

/** Channel scale SGR faint applies when a float-out reads a dim run. */
const DIM_CHANNEL = 0.5

/** How far a float-out lifts a color that is already brighter than `fg` toward white. */
const LIFT_TOWARD_WHITE = 0.5

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
  /**
   * Elapsed time since the chunk became visible, in units of `stepMs`.
   * Reply-text fade-in floors this onto a ramp slot; float-out mixes with the
   * fractional value.
   */
  age: number
}

/** Whether {@link recolorTail} climbs the fade-in ramp or recedes toward settled colors. */
export type RecolorMode = 'in' | 'out'

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
 * Mix `from` toward `to` with the same smoothstep-in-linear-light interpolation
 * {@link buildFadeRamp} uses. Positions at or below 0 and at or above 1 return
 * that endpoint's bytes, so a float-out's last computed mix can match the
 * settled color it recedes toward.
 * @param from - the color at t = 0.
 * @param to - the color at t = 1.
 * @param t - position along the mix; values outside 0..1 clamp to an endpoint.
 * @returns the mixed sRGB color.
 */
export function mixFadeColor(from: RgbColor, to: RgbColor, t: number): RgbColor {
  if (t <= 0) return { r: from.r, g: from.g, b: from.b }
  if (t >= 1) return { r: to.r, g: to.g, b: to.b }
  const eased = t * t * (3 - 2 * t)
  return { r: mix(from.r, to.r, eased), g: mix(from.g, to.g, eased), b: mix(from.b, to.b, eased) }
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
 *
 * Truecolor draws a fractional age between its two neighbouring ramp levels,
 * mixed in linear light, so a word brightens continuously however the frames
 * fall against the level boundaries. The grayscale encoding has fewer values
 * than the ramp has levels and draws the level the age floors onto.
 * @param style - the capability and the ramp.
 * @param age - the brightness level; levels past the ramp draw its last one.
 * @returns the sequence to open the run with, or the empty string when the
 * chunk draws as the component rendered it, which is also what an empty ramp
 * yields under a color capability.
 */
export function fadeSgr(style: FadeStyle, age: number): string {
  if (style.capability === 'none') return ''
  if (style.capability === 'dim') return age < DIM_AGES ? DIM : ''
  const last = style.ramp.length - 1
  const floor = Math.max(0, Math.min(Math.floor(age), last))
  const level = style.ramp[floor]
  if (level === undefined) return ''
  if (style.capability !== 'truecolor') return grayscaleSgr(level)
  const next = style.ramp[floor + 1]
  const fraction = age - floor
  if (next === undefined || fraction <= 0) return truecolorSgr(level)
  return truecolorSgr({ r: mix(level.r, next.r, fraction), g: mix(level.g, next.g, fraction), b: mix(level.b, next.b, fraction) })
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
 * Draw whole rendered lines as a float-out: each SGR run starts at a lifted
 * mix toward the assumed foreground and recedes to the run's own settled
 * color. At `age >= ramp.length` the lines come back byte-identical, so the
 * palette sequences win without a snap. The two-level mode overlays faint for
 * the whole flight; the caller stops invoking this once the clock settles.
 *
 * The mix is opened after every SGR the line already carries, so the status
 * glyph, the dim body rule, and the bold tool name each recede toward their
 * own color. Each line ends with the sequence that undoes the overlay, so the
 * mix never leaks past the line it was applied to. Empty lines come back
 * byte-identical, so the renderer leaves the blank rows around a card alone.
 * @param lines - the rendered lines of the block.
 * @param age - elapsed time in units of `stepMs`; `ramp.length` is t = 1.
 * @param style - the capability and the ramp whose last level is the assumed foreground.
 * @param from - first line the mix is applied to; the lines before it come
 * back byte-identical, which is how a caller keeps rows the renderer can no
 * longer repaint out of the fade.
 * @returns the lines at that mix; copies when the style writes no sequence,
 * which is what the `none` capability and a settled age yield.
 */
export function recolorLines(lines: readonly string[], age: number, style: FadeStyle, from = 0): string[] {
  const capability = style.capability
  if (capability === 'none') return [...lines]
  if (capability === 'dim') {
    return lines.map((line, index) => index < from || line === '' ? line : `${DIM}${line}${RESET_INTENSITY}`)
  }
  const steps = style.ramp.length
  const fg = style.ramp[steps - 1]
  if (fg === undefined || age >= steps) return [...lines]
  const t = age / steps
  return lines.map((line, index) => index < from || line === '' ? line : floatOutLine(line, t, capability, fg))
}

/** Assumed terminal white, used only to lift a settled color that is already brighter than `fg`. */
const WHITE_RGB: RgbColor = { r: CHANNEL_MAX, g: CHANNEL_MAX, b: CHANNEL_MAX }

/** xterm 16-color palette, indices 0..15. */
const ANSI16: readonly RgbColor[] = [
  { r: 0, g: 0, b: 0 },
  { r: 205, g: 0, b: 0 },
  { r: 0, g: 205, b: 0 },
  { r: 205, g: 205, b: 0 },
  { r: 0, g: 0, b: 238 },
  { r: 205, g: 0, b: 205 },
  { r: 0, g: 205, b: 205 },
  { r: 229, g: 229, b: 229 },
  { r: 127, g: 127, b: 127 },
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 92, g: 92, b: 255 },
  { r: 255, g: 0, b: 255 },
  { r: 0, g: 255, b: 255 },
  { r: 255, g: 255, b: 255 },
]

/** Foreground a float-out reads off a run of palette SGR. */
interface FgState {
  /** Explicit foreground, or undefined for the terminal default. */
  color: RgbColor | undefined
  /** Whether SGR 2 is in force. */
  dim: boolean
}

/**
 * Relative luminance of one sRGB color, using the same weights as the grayscale encoder.
 * @param color - the color.
 * @returns the weighted sum of the channels.
 */
function colorLuminance(color: RgbColor): number {
  return LUMINANCE.r * color.r + LUMINANCE.g * color.g + LUMINANCE.b * color.b
}

/**
 * The color a float-out starts from: the assumed foreground when that is
 * brighter than the settle, otherwise a mix toward white.
 * @param settled - the run's color at t = 1.
 * @param fg - the assumed terminal foreground.
 * @returns the lifted color at t = 0.
 */
function liftColor(settled: RgbColor, fg: RgbColor): RgbColor {
  return colorLuminance(fg) >= colorLuminance(settled) ? fg : mixFadeColor(settled, WHITE_RGB, LIFT_TOWARD_WHITE)
}

/**
 * Apply SGR faint as a channel scale, matching what a dim palette run looks like.
 * @param color - the undimmed RGB.
 * @returns the dimmed RGB.
 */
function dimColor(color: RgbColor): RgbColor {
  return {
    r: Math.round(color.r * DIM_CHANNEL),
    g: Math.round(color.g * DIM_CHANNEL),
    b: Math.round(color.b * DIM_CHANNEL),
  }
}

/**
 * The RGB a run settles at, given the SGR in force and the assumed default foreground.
 * @param state - the SGR foreground and dim flag.
 * @param fg - the assumed default foreground.
 * @returns the settled color the mix recedes toward.
 */
function settledRgb(state: FgState, fg: RgbColor): RgbColor {
  const base = state.color ?? fg
  return state.dim ? dimColor(base) : base
}

/**
 * Encode one mixed color under a color capability.
 * @param capability - `truecolor` or `ansi256`.
 * @param color - the mixed RGB.
 * @returns the SGR sequence, or empty when the capability cannot encode a mix.
 */
function encodeMix(capability: 'truecolor' | 'ansi256', color: RgbColor): string {
  return capability === 'truecolor' ? truecolorSgr(color) : `${CSI}38;5;${String(nearestAnsi256(color))}m`
}

/**
 * Rebuild one card row as a per-run float-out mix.
 * @param line - the rendered line.
 * @param t - 0 at lift, 1 at settle.
 * @param capability - how the mix is encoded.
 * @param fg - the assumed default foreground.
 * @returns the line with each run overlaid, closed by {@link RESET_FOREGROUND}.
 */
function floatOutLine(line: string, t: number, capability: 'truecolor' | 'ansi256', fg: RgbColor): string {
  let out = ''
  let last = 0
  const state: FgState = { color: undefined, dim: false }
  for (const match of line.matchAll(SGR_SEQUENCE)) {
    const start = match.index
    if (start > last) out += paintSegment(line.slice(last, start), state, t, capability, fg)
    applySgr(state, match[0])
    out += match[0]
    last = start + match[0].length
  }
  if (last < line.length) out += paintSegment(line.slice(last), state, t, capability, fg)
  return `${out}${RESET_FOREGROUND}`
}

/**
 * Overlay one text run with the float-out mix for the SGR in force.
 * @param text - the run's characters, with no SGR.
 * @param state - the SGR in force.
 * @param t - 0 at lift, 1 at settle.
 * @param capability - how the mix is encoded.
 * @param fg - the assumed default foreground.
 * @returns the run prefixed by intensity-reset and the mixed color.
 */
function paintSegment(text: string, state: FgState, t: number, capability: 'truecolor' | 'ansi256', fg: RgbColor): string {
  const settled = settledRgb(state, fg)
  const mixed = mixFadeColor(liftColor(settled, fg), settled, t)
  return `${RESET_INTENSITY}${encodeMix(capability, mixed)}${text}`
}

/**
 * The float-out sequence one reasoning span draws under, toward dimmed `fg`.
 * @param style - the capability and the ramp.
 * @param age - elapsed time in units of `stepMs`.
 * @returns the sequence, or empty once `age` reaches the ramp length.
 */
function floatOutSpanSgr(style: FadeStyle, age: number): string {
  if (style.capability === 'dim') return DIM
  if (style.capability !== 'truecolor' && style.capability !== 'ansi256') return ''
  const steps = style.ramp.length
  const fg = style.ramp[steps - 1]
  if (fg === undefined || age >= steps) return ''
  const settled = dimColor(fg)
  const mixed = mixFadeColor(liftColor(settled, fg), settled, age / steps)
  return `${RESET_INTENSITY}${encodeMix(style.capability, mixed)}`
}

/**
 * Apply one SGR sequence to the float-out foreground state.
 * @param state - the state to update.
 * @param sequence - a CSI SGR including the trailing `m`.
 */
function applySgr(state: FgState, sequence: string): void {
  const body = sequence.slice(2, -1)
  const parts = body === '' ? [0] : body.split(';').map(part => part === '' ? 0 : Number(part))
  for (let index = 0; index < parts.length; index += 1) {
    const code = colorParam(parts, index)
    if (code === 0) {
      state.color = undefined
      state.dim = false
    } else if (code === 2) {
      state.dim = true
    } else if (code === 22) {
      state.dim = false
    } else if (code === 39) {
      state.color = undefined
    } else if (code >= 30 && code <= 37) {
      state.color = ANSI16[code - 30]
    } else if (code >= 90 && code <= 97) {
      state.color = ANSI16[code - 90 + 8]
    } else if (code === 38) {
      const read = readExtendedColor(parts, index)
      state.color = read.color
      index += read.skip
    } else if (code === 48) {
      index += readExtendedColor(parts, index).skip
    }
  }
}

/**
 * Consume an ITU T.416 extended color (`38`/`48` plus `2;R;G;B` or `5;N`).
 * @param parts - the SGR parameter list.
 * @param index - index of the `38` or `48` code.
 * @returns the RGB for a foreground read, and how many following parameters were consumed.
 */
function readExtendedColor(parts: readonly number[], index: number): { color: RgbColor | undefined; skip: number } {
  const mode = parts[index + 1]
  if (mode === 2) {
    return {
      color: {
        r: channel(colorParam(parts, index + 2)),
        g: channel(colorParam(parts, index + 3)),
        b: channel(colorParam(parts, index + 4)),
      },
      skip: 4,
    }
  }
  if (mode === 5) return { color: ansi256Rgb(colorParam(parts, index + 2)), skip: 2 }
  return { color: undefined, skip: mode === undefined ? 0 : 1 }
}

/**
 * Read one SGR numeric parameter, defaulting a missing slot to 0.
 * @param parts - the SGR parameter list.
 * @param index - the slot to read.
 * @returns the parameter, or 0 when it is absent.
 */
function colorParam(parts: readonly number[], index: number): number {
  return parts[index] ?? 0
}

/**
 * RGB for one xterm 256-color index.
 * @param index - 0..255.
 * @returns the palette color, clamped onto the table.
 */
function ansi256Rgb(index: number): RgbColor {
  const n = Math.max(0, Math.min(255, Math.floor(index)))
  if (n < 16) {
    const color = ANSI16[n]
    /* v8 ignore next -- ANSI16 has 16 entries and n is already clamped to 0..15 */
    if (color === undefined) return { r: 0, g: 0, b: 0 }
    return color
  }
  if (n >= GRAY_FIRST_INDEX) {
    const value = GRAY_FIRST_VALUE + (n - GRAY_FIRST_INDEX) * GRAY_VALUE_STEP
    return { r: value, g: value, b: value }
  }
  const cube = n - 16
  const r = Math.floor(cube / 36)
  const g = Math.floor((cube % 36) / 6)
  const b = cube % 6
  const level = (step: number): number => step === 0 ? 0 : 55 + step * 40
  return { r: level(r), g: level(g), b: level(b) }
}

/**
 * Nearest xterm 256-color index to one RGB, by squared channel distance.
 * @param color - the mixed RGB.
 * @returns an index in 0..255.
 */
export function nearestAnsi256(color: RgbColor): number {
  let best = 0
  let bestDist = Infinity
  for (let n = 0; n < 256; n += 1) {
    const candidate = ansi256Rgb(n)
    const dist = (candidate.r - color.r) ** 2 + (candidate.g - color.g) ** 2 + (candidate.b - color.b) ** 2
    if (dist < bestDist) {
      bestDist = dist
      best = n
    }
  }
  return best
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
 * word at its own mix and words do not move in lockstep. Fade-in floors that
 * age onto a ramp slot; float-out uses the fractional value.
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
   * @returns whether a chunk is still younger than `steps * stepMs`, and
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
   * @returns true while a tracked chunk is younger than `steps * stepMs`.
   */
  needsRepaint(): boolean {
    return this.chunks.some(chunk => this.ageOf(chunk) < this.steps)
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
   * The brightness age one chunk draws at right now.
   * @param chunk - the tracked chunk.
   * @returns elapsed time since it became visible, in units of `stepMs`.
   */
  private ageOf(chunk: FadeChunk): number {
    return (this.now() - chunk.bornAt) / this.stepMs
  }
}

/** Settings a {@link BlockFadeClock} is built with. */
export interface BlockFadeClockOptions {
  /** Wall-clock time the block became visible, in milliseconds. */
  bornAt: number
  /** How long one brightness level lasts, in milliseconds. */
  stepMs: number
  /** Brightness levels that set the fade duration as `steps * stepMs`. */
  steps: number
  /**
   * The wall clock the age is measured against.
   * @returns the current time in milliseconds.
   */
  now: () => number
}

/**
 * The age of one whole block that floats out as a unit - a tool card's rows,
 * which arrive complete rather than word by word.
 *
 * Progress is `elapsed / (steps * stepMs)`, eased by the same smoothstep the
 * ramp uses. {@link BlockFadeClock.age} stays defined until that progress
 * reaches 1, so the last overlay frame can sit near the settled colors and
 * the next frame is the component's own bytes.
 */
export class BlockFadeClock {
  constructor(private readonly options: BlockFadeClockOptions) {}

  /**
   * How far through the float-out this block is.
   * @returns 0 at birth, 1 at or after `steps * stepMs`.
   */
  progress(): number {
    const { bornAt, stepMs, steps, now } = this.options
    return Math.min(1, Math.max(0, (now() - bornAt) / (steps * stepMs)))
  }

  /**
   * The fractional age the block draws at right now, in units of `stepMs`.
   * @returns `progress * steps`, or undefined once progress has reached 1 and
   * the block renders in the colors the component itself produced.
   */
  age(): number | undefined {
    const t = this.progress()
    return t >= 1 ? undefined : t * this.options.steps
  }

  /**
   * Whether this block still draws below the settled colors.
   * @returns true while {@link BlockFadeClock.age} yields a value.
   */
  needsRepaint(): boolean {
    return this.age() !== undefined
  }
}

/** What {@link FadeRegistry} keeps: anything that reports whether it is still moving. */
export interface RegisteredFade {
  /**
   * Whether this fade still differs from its settled rendering.
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
 * Markdown rewrites text, so a chunk's characters may reach the screen without
 * the syntax around them, or not at all. The rendered text is therefore matched
 * as a subsequence of what was streamed: a character the renderer consumed is
 * skipped and the columns keep their alignment, so a delta that closes a bold
 * run or a code span no longer drops the whole tail to the foreground for one
 * frame. Matching stops at a chunk fewer than half of whose characters are
 * there at all - text this tail never reached; that chunk and every older one
 * then draw at the foreground, unchanged.
 *
 * Styling inside a recolored run survives. The run reasserts the sequences in
 * force at its start, so an enclosing bold or italic continues across it; an
 * enclosing foreground color reasserted there wins over the fade-in ramp, and
 * that run simply does not fade. Each recolored line ends with `ESC[39m` (or
 * `ESC[22m` in the two-level mode, which also ends bold) after the line's own
 * closing sequences, so the recolor never leaks past the line it was applied
 * to. Float-out resets intensity before the mixed color so a dim wrapper does
 * not stack on the overlay, and at t >= 1 the original lines come back
 * unchanged.
 * @param lines - the rendered lines of the streaming block, newest text last.
 * @param spans - the tail from {@link FadeTracker.spans}, oldest first.
 * @param style - the capability and the ramp.
 * @param from - first line the tail may recolor; the lines before it come back
 * byte-identical, which is how a caller keeps rows the renderer can no longer
 * repaint out of the fade.
 * @param mode - `in` climbs {@link buildFadeRamp}; `out` recedes toward the
 * dim foreground reasoning settles in. Defaults to `in`.
 * @returns the lines with the tail recolored; lines the tail does not cover
 * are returned byte-identical, so the renderer leaves them alone.
 */
export function recolorTail(
  lines: readonly string[],
  spans: readonly FadeSpan[],
  style: FadeStyle,
  from = 0,
  mode: RecolorMode = 'in',
): string[] {
  if (spans.length === 0 || lines.length === 0) return [...lines]
  const cells = new CellWalk(cellsFromEnd(lines))
  const runs: LineRun[] = []
  for (const span of [...spans].reverse()) {
    const covered = consumeSpan(cells, span.text)
    if (covered === undefined) break
    const sgr = mode === 'out' ? floatOutSpanSgr(style, span.age) : fadeSgr(style, span.age)
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
 * The backwards cell walk with one cell of pushback, so a chunk that hands a
 * cell back leaves it for the chunk before it rather than eating it.
 */
class CellWalk {
  private pending: Cell | undefined

  /**
   * @param cells - the backwards walk over the rendered lines.
   */
  constructor(private readonly cells: Generator<Cell, void, void>) {}

  /**
   * The next cell towards the start of the text.
   * @returns the cell, or undefined once the walk is spent.
   */
  next(): Cell | undefined {
    const held = this.pending
    if (held !== undefined) {
      this.pending = undefined
      return held
    }
    const step = this.cells.next()
    return step.done ? undefined : step.value
  }

  /**
   * Put one cell back for the next read.
   * @param cell - the cell the caller did not claim.
   */
  back(cell: Cell): void {
    this.pending = cell
  }
}

/**
 * Take the cells one chunk covers off the walk.
 *
 * Markdown is rendered, not echoed: `**bold**` reaches the screen as `bold`,
 * a fence and a bullet disappear, and a link keeps its text and drops its
 * target. A character of the chunk that the renderer consumed therefore has no
 * cell, and it is skipped rather than failing the whole tail - the rendered
 * text is matched as a subsequence of what was streamed. Only a chunk whose
 * cells have run out ends the walk, because past that point the columns
 * belong to text this tail never appended.
 * @param cells - the backwards walk, positioned at the end of the region still unclaimed.
 * @param text - the chunk's text as it was appended.
 * @returns the cells the chunk covers, whitespace included, or undefined when
 * the walk reached the start of the rendered text mid-chunk.
 */
function consumeSpan(cells: CellWalk, text: string): Cell[] | undefined {
  const wanted = Array.from(GRAPHEMES.segment(text), part => part.segment).filter(part => !isBlank(part)).reverse()
  const covered: Cell[] = []
  let index = 0
  let matched = 0
  while (index < wanted.length) {
    let cell = cells.next()
    while (cell !== undefined && isBlank(cell.grapheme)) {
      covered.push(cell)
      cell = cells.next()
    }
    // The rendered text ran out. Whether this chunk still claims its columns
    // is the same question as for any other partial match, one rule below.
    if (cell === undefined) break
    /* v8 ignore next -- the loop condition holds the index inside the list */
    const want = wanted[index] ?? ''
    if (cell.grapheme === want) {
      covered.push(cell)
      matched += 1
      index += 1
    } else if (wanted.includes(cell.grapheme, index + 1) || MARKDOWN_SYNTAX.test(want)) {
      // Either this cell belongs to a character further along, or the
      // character in hand is syntax the renderer consumed: drop the character
      // and keep the cell.
      cells.back(cell)
      index += 1
    } else {
      // The cell is the renderer's own - a bullet, a rule, a quote mark - so
      // it belongs to this chunk's columns and the character still stands.
      covered.push(cell)
    }
  }
  // Half the chunk's own characters must be there. Rendering drops syntax and
  // adds marks of its own, but it does not replace a word: a chunk matched
  // below that is text this tail never reached, and colouring the columns it
  // landed on would paint a neighbour's brightness onto them.
  return matched * 2 >= wanted.length ? covered : undefined
}

/**
 * Characters a Markdown renderer consumes rather than draws: emphasis and code
 * fences, headings and rules, list and quote markers, and link brackets. A
 * chunk's own character that the rendered text does not carry is one of these
 * far more often than it is text the renderer dropped outright.
 */
const MARKDOWN_SYNTAX = /^[*_`~#>[\]()|\\!+=-]$/u

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
  const pieces = sliceColumns(text, runs.flatMap(run => [run.start, run.end]))
  let out = pieces[0] as string
  runs.forEach((run, index) => {
    out += `${run.sgr}${pieces[2 * index + 1] as string}${pieces[2 * index + 2] as string}`
  })
  return `${out}${restore}`
}
