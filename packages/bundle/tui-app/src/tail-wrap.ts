/**
 * A text component that rewraps only the last paragraph of a growing text.
 *
 * pi-tui's `Text` wraps its whole text again whenever the text changes, so a
 * streaming thinking block that grows a few graphemes per frame costs a full
 * rewrap of everything it already holds on every frame. `wrapTextWithAnsi`
 * wraps each `\n`-separated line on its own, carrying over only the styling
 * that earlier lines left open, so the lines before the last one keep their
 * wrap while text is appended. {@link TailWrappedText} keeps that wrap per
 * width and wraps the last line alone, and draws exactly what `Text` with no
 * padding draws for the same text.
 * @module @deepseek-ai/dsh-tui-app/tail-wrap
 */

import { visibleWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui'

/** The SGR sequences a styled text opens with. */
const LEADING_STYLE = /^(?:\u001b\[[0-9;]*m)*/u

/** Draws a text like pi-tui's `Text` with no padding, rewrapping only its last line. */
export class TailWrappedText implements Component {
  private text = ''
  /** The wrap of every line before the last one, at one width. */
  private head: { width: number; text: string; lines: string[] } | undefined
  /** The last drawing. */
  private drawn: { width: number; text: string; lines: string[] } | undefined

  /**
   * Replace the text.
   * @param text - the text, styled or plain.
   */
  setText(text: string): void {
    this.text = text
  }

  invalidate(): void {
    this.head = undefined
    this.drawn = undefined
  }

  /**
   * Draw the text.
   * @param width - the columns every line is padded to.
   * @returns the wrapped lines padded to `width`; none for blank text.
   */
  render(width: number): string[] {
    if (this.drawn?.width === width && this.drawn.text === this.text) return this.drawn.lines
    const lines = this.text.trim() === ''
      ? []
      : this.wrap(this.text.replace(/\t/gu, '   '), Math.max(1, width))
        .map(line => `${line}${' '.repeat(Math.max(0, width - visibleWidth(line)))}`)
    this.drawn = { width, text: this.text, lines }
    return lines
  }

  /**
   * Wrap the text, reusing the wrap of every line before the last one while
   * those lines carry no styling beyond the sequences the text opens with.
   * @param text - the text with tabs expanded.
   * @param width - the columns to wrap at.
   * @returns the wrapped lines, unpadded.
   */
  private wrap(text: string, width: number): string[] {
    const cut = text.lastIndexOf('\n')
    const open = text.slice(0, text.length - text.replace(LEADING_STYLE, '').length)
    const styled = text.indexOf('\u001b', open.length)
    if (cut === -1 || (styled !== -1 && styled < cut)) return wrapTextWithAnsi(text, width)
    const head = text.slice(0, cut)
    if (this.head?.width !== width || this.head.text !== head) this.head = { width, text: head, lines: wrapTextWithAnsi(head, width) }
    // The line of opening sequences alone leaves the same styling open as
    // every line before the last one does, and wraps to one line of its own.
    const tail = wrapTextWithAnsi(`${open}\n${text.slice(cut + 1)}`, width).slice(1)
    return [...this.head.lines, ...tail]
  }
}
