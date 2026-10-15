/**
 * Stream pacing: the queue between the live assistant stream and what the
 * transcript draws.
 *
 * Deltas arrive in network bursts: a provider may hold a dozen tokens and
 * deliver them in one read, then nothing for a hundred milliseconds. Drawing
 * each delta as it lands makes text jump by whole bursts. The pacer takes each
 * delta the moment it arrives, which costs one string append and never waits
 * on the renderer, and hands text on to the transcript a few graphemes per
 * frame on the application's frame tick.
 *
 * The release rate follows the backlog: every frame releases
 * `backlog / drainFrames` graphemes, at least one, with the fractional part
 * carried to the next frame. A burst therefore drains within about
 * `drainFrames` frames however large it is, and a slow stream is drawn at
 * the rate it arrives. Entries leave in arrival order. A finished thinking
 * block is released through {@link StreamPacer.flushChannel} instead of
 * staying ahead of the reply.
 *
 * {@link CardFlow} draws a tool card the other way: not a share of a backlog
 * per frame but a front that crosses the card's columns at a constant pace,
 * so the card flows out row after row, word after word.
 *
 * Nothing here arms a timer: the application calls {@link StreamPacer.frame}
 * and {@link CardFlow.frame} from its frame tick and {@link StreamPacer.flush}
 * wherever the stream's full text must be on screen. Only {@link CardFlow}
 * reads a clock, the one it is given.
 * @module @deepseek-ai/dsh-tui-app/pace
 */

/**
 * Frames a backlog takes to drain by default. Eight frames at the 16 ms frame
 * tick hold the drawn text at most about 130 ms behind the stream while a
 * burst spreads over several frames.
 */
export const STREAM_PACE_FRAMES = 8

/**
 * Grapheme segmenter for release cuts, so a frame never splits a surrogate
 * pair, a combining sequence, or a joined emoji.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** One queued run of text and where its released parts go. */
interface PacedEntry {
  /** Consecutive pushes with the same channel merge into one entry. */
  channel: string
  /** Text not released yet. */
  text: string
  /**
   * Hand part of the text on to the transcript.
   * @param text - the released part; empty only for an entry pushed empty.
   */
  release: (text: string) => void
}

/** Settings a {@link StreamPacer} is built with. */
export interface StreamPacerOptions {
  /** Frames a backlog takes to drain; at least 1. */
  drainFrames: number
}

/** The ordered queue of streamed text waiting for a frame. */
export class StreamPacer {
  private readonly drainFrames: number
  private readonly entries: PacedEntry[] = []
  /** Graphemes the next frame may release beyond its own share. */
  private credit = 0
  /** UTF-16 length of the queued text, used as the backlog estimate. */
  private backlog = 0

  /** @param options - the drain length in frames. */
  constructor(options: StreamPacerOptions) {
    this.drainFrames = Math.max(1, options.drainFrames)
  }

  /**
   * Queue one delta.
   * @param channel - what the text belongs to; a push onto the same channel
   * as the newest entry extends that entry and keeps its `release`.
   * @param text - the delta. An empty delta still queues an entry, released
   * on the next frame at no cost, so a tool name that arrives without
   * arguments reaches the transcript in order.
   * @param release - receives the released parts of this entry, in order.
   */
  push(channel: string, text: string, release: (text: string) => void): void {
    const last = this.entries.at(-1)
    if (last !== undefined && last.channel === channel) {
      last.text += text
    } else {
      this.entries.push({ channel, text, release })
    }
    this.backlog += text.length
  }

  /**
   * Whether text is still waiting for a frame.
   * @returns true while any entry is queued.
   */
  pending(): boolean {
    return this.entries.length > 0
  }

  /**
   * Release one frame's share of the backlog.
   * @returns whether text is still queued after this frame.
   */
  frame(): boolean {
    this.credit += Math.max(1, this.backlog / this.drainFrames)
    let budget = Math.floor(this.credit)
    this.credit -= budget
    for (let entry = this.entries[0]; entry !== undefined; entry = this.entries[0]) {
      const cut = cutGraphemes(entry.text, budget)
      if (cut.graphemes === 0 && entry.text !== '') break
      budget -= cut.graphemes
      this.backlog -= cut.length
      const head = entry.text.slice(0, cut.length)
      entry.text = entry.text.slice(cut.length)
      if (entry.text === '') this.entries.shift()
      entry.release(head)
    }
    if (this.entries.length === 0) this.credit = 0
    return this.entries.length > 0
  }

  /** Release everything queued, in order, at once. */
  flush(): void {
    const entries = this.entries.splice(0)
    this.backlog = 0
    this.credit = 0
    for (const entry of entries) entry.release(entry.text)
  }

  /**
   * Release every queued entry of one channel now, and keep every other
   * entry in arrival order. A finished thinking block uses this so its
   * remainder is drawn before later reply text is paced.
   * @param channel - the channel to release.
   * @returns whether any entry of that channel was queued.
   */
  flushChannel(channel: string): boolean {
    const pending = this.entries.splice(0)
    const kept: PacedEntry[] = []
    const release: PacedEntry[] = []
    let backlog = 0
    for (const entry of pending) {
      if (entry.channel === channel) release.push(entry)
      else {
        kept.push(entry)
        backlog += entry.text.length
      }
    }
    this.entries.push(...kept)
    this.backlog = backlog
    if (this.entries.length === 0) this.credit = 0
    for (const entry of release) entry.release(entry.text)
    return release.length > 0
  }

  /** Drop everything queued without releasing it. */
  clear(): void {
    this.entries.length = 0
    this.backlog = 0
    this.credit = 0
  }
}

/**
 * Frames one full-width row of a tool card takes to flow out by default. Six
 * frames at the 16 ms frame tick draw a row in about 100 ms, so an eight-row
 * card of half-filled rows is out in about 400 ms and its pace stays the same
 * whatever the card holds.
 */
export const TOOL_REVEAL_FRAMES = 6

/**
 * Longest stretch of wall-clock time one {@link CardFlow.frame} advances the
 * front by, in frames. A frame that ran late draws a few columns more, and a
 * stalled event loop does not make the card jump to its end.
 */
const MAX_ADVANCE_FRAMES = 4

/** Settings a {@link CardFlow} is built with. */
export interface CardFlowOptions {
  /** Frames one full-width row takes to flow out; at least 1. */
  rowFrames: number
  /** How long one frame lasts, in milliseconds. */
  stepMs: number
  /** Brightness levels a drawn column passes through; it leaves the trail after `steps * stepMs`. */
  steps: number
  /**
   * The wall clock the front and the trail are measured against.
   * @returns the current time in milliseconds.
   */
  now: () => number
}

/** A run of freshly drawn columns and how old it is. */
export interface FlowBand {
  /** First column of the run, counted over the card's rows from the first. */
  start: number
  /** Column after the run. */
  end: number
  /** Elapsed time since the run was drawn, in units of `stepMs`. */
  age: number
}

/** The columns one frame drew and the instant it drew them. */
interface DrawnBand {
  start: number
  end: number
  /** When the frame ran, in milliseconds. */
  bornAt: number
  /** How long the frame's advance lasted, in milliseconds. */
  span: number
}

/**
 * The front of a tool card that flows out: how many columns of its rows are
 * drawn, counted row after row from the first, and the columns drawn lately,
 * which the card brightens from the terminal background by age. The front moves a fixed number of columns per
 * unit of wall-clock time, so rows and the words in them come out at one pace
 * however much the card holds and however late a frame runs.
 *
 * The pace is `width / (rowFrames * stepMs)` columns per millisecond, so a
 * full-width row takes `rowFrames` frames. The front reads only the clock and
 * the card's current column count; the call or result that grew the card never
 * waits for it, and a card that grows while it flows is caught up with at the
 * same pace.
 */
export class CardFlow {
  private readonly options: CardFlowOptions
  private front: number
  /** When the front last advanced; absent while it has nothing to draw. */
  private last: number | undefined
  private bands: DrawnBand[] = []

  /**
   * @param options - the pace, the trail length, and the clock.
   * @param shown - columns drawn before the first frame.
   */
  constructor(options: CardFlowOptions, shown: number) {
    this.options = { ...options, rowFrames: Math.max(1, options.rowFrames) }
    this.front = shown
    this.last = options.now()
  }

  /**
   * Columns drawn right now.
   * @returns the whole columns, which may exceed the card's columns after {@link CardFlow.settle}.
   */
  shown(): number {
    return Math.floor(this.front)
  }

  /**
   * The drawn columns still colored toward their settled colors.
   * @returns one run per frame that drew columns lately, oldest first.
   */
  trail(): FlowBand[] {
    const at = this.options.now()
    const live: FlowBand[] = []
    for (const band of this.bands) {
      const age = this.ageOf(band, at)
      if (age < this.options.steps) live.push({ start: Math.floor(band.start), end: Math.floor(band.end), age })
    }
    return live
  }

  /**
   * Whether a drawn run is still climbing toward its settled color.
   * @returns true while the trail holds a run.
   */
  receding(): boolean {
    return this.trail().length > 0
  }

  /**
   * Move the front by the time elapsed since the previous frame, and drop the
   * runs that reached their settled color. The first frame after the card
   * grew again starts the clock without moving the front.
   * @param total - the card's column count at its last render.
   * @param width - the terminal width the pace is measured against.
   * @returns whether columns are still hidden after this frame.
   */
  frame(total: number, width: number): boolean {
    const at = this.options.now()
    this.bands = this.bands.filter(band => this.ageOf(band, at) < this.options.steps)
    if (this.front >= total) {
      this.last = undefined
      return false
    }
    const previous = this.last
    if (previous === undefined) {
      this.last = at
      return true
    }
    const { rowFrames, stepMs } = this.options
    const span = Math.min(Math.max(0, at - previous), MAX_ADVANCE_FRAMES * stepMs)
    const next = Math.min(total, this.front + span * Math.max(1, width) / (rowFrames * stepMs))
    if (next > this.front) this.bands.push({ start: this.front, end: next, bornAt: at, span })
    this.front = next
    // A front that caught up has nothing to time until the card grows again.
    this.last = next < total ? at : undefined
    return next < total
  }

  /**
   * Hold the front at the card's column count, so columns the card loses later
   * are not owed again when it grows back.
   * @param total - the card's column count at this render.
   */
  clamp(total: number): void {
    if (this.front > total) this.front = total
  }

  /** Draw every column the card has at its next render, with no trail. */
  settle(): void {
    this.front = Number.POSITIVE_INFINITY
    this.bands = []
    this.last = undefined
  }

  /**
   * The age a run draws at: its midpoint, which the frame drew over the
   * `span` before `bornAt`.
   * @param band - the run.
   * @param at - the current time in milliseconds.
   * @returns elapsed time in units of `stepMs`.
   */
  private ageOf(band: DrawnBand, at: number): number {
    return (at - band.bornAt + band.span / 2) / this.options.stepMs
  }
}

/**
 * Measure the longest prefix of `text` that holds at most `limit` graphemes.
 * @param text - the queued text.
 * @param limit - graphemes the frame may still release.
 * @returns the prefix's grapheme count and UTF-16 length.
 */
function cutGraphemes(text: string, limit: number): { graphemes: number; length: number } {
  if (limit <= 0) return { graphemes: 0, length: 0 }
  let graphemes = 0
  let length = 0
  for (const part of GRAPHEMES.segment(text)) {
    if (graphemes === limit) break
    graphemes += 1
    length += part.segment.length
  }
  return { graphemes, length }
}
