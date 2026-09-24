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
 * Nothing here arms a timer or reads a clock: the application calls
 * {@link StreamPacer.frame} from its frame tick and {@link StreamPacer.flush}
 * wherever the stream's full text must be on screen.
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
