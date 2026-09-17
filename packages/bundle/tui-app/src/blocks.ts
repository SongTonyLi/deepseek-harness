/**
 * Transcript components: one pi-tui component per rendered fact (a user
 * prompt, an assistant reply, a tool card, a notice). Each owns its display
 * state and re-renders from it at any width.
 * @module @deepseek-ai/dsh-tui-app/blocks
 */

import { Markdown, Text, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui'
import { recolorTail, type FadeSpan, type FadeStyle } from './fade.ts'
import { markdownTheme, type Palette } from './style.ts'
import { previewLines, type ToolCallText } from './transcript.ts'

/** Shared presentation settings every block reads. */
export interface BlockTheme {
  palette: Palette
  /** Collapsed tool-card body rows. */
  toolPreviewLines: number
}

/** A prompt the user submitted, drawn with a leading `›`. */
export class UserBlock implements Component {
  constructor(private readonly theme: BlockTheme, private readonly text: string) {}

  invalidate(): void {}

  render(width: number): string[] {
    const palette = this.theme.palette
    const body = wrapTextWithAnsi(this.text, Math.max(1, width - 2))
    return ['', ...body.map((line, index) => `${palette.accent(index === 0 ? '›' : ' ')} ${palette.bold(line)}`)]
  }
}

/** A dim one-line notice about the session (a stopped turn, a command result, a model switch). */
export class NoticeBlock implements Component {
  private readonly text: Text

  constructor(theme: BlockTheme, text: string, tone: 'dim' | 'error' | 'success' = 'dim') {
    const palette = theme.palette
    this.text = new Text(palette[tone](`· ${text}`), 0, 0)
  }

  invalidate(): void {
    this.text.invalidate()
  }

  render(width: number): string[] {
    return this.text.render(width)
  }
}

/** The live fade of the one message streaming right now. */
export interface FadeRender {
  /**
   * The tail to recolor. Read per render, not captured: the application ages
   * it once per fade period and empties it when the message settles.
   * @returns one span per tracked chunk, oldest first, with its current age.
   */
  spans(): readonly FadeSpan[]
  /**
   * The resolved capability and ramp. Read per render, not captured: the
   * terminal background query settles after the application has started.
   * @returns the settings the tail draws under right now.
   */
  style(): FadeStyle
  /** Brightness levels the ramp carries, as the application built it. */
  steps: number
  /**
   * Drop the tail, which the block asks for when the render width changed:
   * the columns the tail was matched against no longer describe the
   * rewrapped lines. The application keeps what it knows about the arrival
   * rate, because a resize says nothing about it.
   */
  flush(): void
}

/**
 * An assistant reply: streamed reasoning above streamed Markdown text. The
 * durable `assistant/message` replaces both with the committed content.
 *
 * A block that is streaming right now can carry a {@link FadeRender}, which
 * draws its newest text dimmed and brightening. A block rebuilt from history
 * carries none, and {@link AssistantBlock.commit} drops the one a streaming
 * block had, so settled text is never recolored.
 */
export class AssistantBlock implements Component {
  private reasoning = ''
  private text = ''
  private interrupted = false
  private readonly markdown: Markdown
  private readonly reasoningText: Text
  private fade: FadeRender | undefined
  /** Width of the last render that drew a tail; absent before the first one. */
  private fadeWidth: number | undefined

  constructor(private readonly theme: BlockTheme) {
    const palette = theme.palette
    this.markdown = new Markdown('', 0, 0, markdownTheme(palette))
    this.reasoningText = new Text('', 0, 0)
  }

  /**
   * Draw this block's newest text through `fade` until it commits.
   * @param fade - the tail and drawing settings of the running stream.
   */
  setFade(fade: FadeRender): void {
    this.fade = fade
  }

  /**
   * Append streamed visible text.
   * @param delta - the text delta.
   */
  appendText(delta: string): void {
    this.text += delta
    this.markdown.setText(this.text)
  }

  /**
   * Append streamed reasoning text.
   * @param delta - the reasoning delta.
   */
  appendReasoning(delta: string): void {
    this.reasoning += delta
    this.reasoningText.setText(this.theme.palette.dim(this.theme.palette.italic(this.reasoning.trimEnd())))
  }

  /**
   * Replace the streamed content with the committed message.
   * @param text - the committed visible text.
   * @param reasoning - the committed reasoning text.
   * @param interrupted - whether the message was cut short.
   */
  commit(text: string, reasoning: string, interrupted: boolean): void {
    this.text = text
    this.reasoning = reasoning
    this.interrupted = interrupted
    // The committed content replaces what was streamed, so the tail no longer
    // describes anything on screen and this block is settled for good.
    this.fade = undefined
    this.markdown.setText(text)
    this.reasoningText.setText(this.theme.palette.dim(this.theme.palette.italic(reasoning.trimEnd())))
  }

  invalidate(): void {
    this.markdown.invalidate()
    this.reasoningText.invalidate()
  }

  render(width: number): string[] {
    const lines: string[] = ['']
    if (this.reasoning.trim() !== '') lines.push(...this.reasoningText.render(width), '')
    if (this.text !== '') lines.push(...this.renderText(width))
    if (this.interrupted) lines.push(this.theme.palette.dim('[interrupted]'))
    return lines
  }

  /**
   * The Markdown lines, with the streaming tail recolored.
   *
   * `recolorTail` matches the tail backwards from the end of what it is
   * given, so it gets the Markdown lines alone: the reasoning above them and
   * any marker below them would put the newest chunk somewhere other than the
   * end and drop the whole tail to the plain foreground.
   *
   * Only chunks younger than `steps - 1` are handed over. The last ramp level
   * is an assumed foreground - pi-tui reports the terminal background but not
   * its foreground - so the oldest visible level is left to draw in the
   * terminal's own foreground, which is also what the chunk draws in once it
   * settles. No chunk can therefore jump color as it leaves the tail.
   * @param width - the width the Markdown lays out in.
   * @returns the lines to draw.
   */
  private renderText(width: number): string[] {
    const fade = this.fade
    const lines = this.markdown.render(width)
    if (fade === undefined) return lines
    if (this.fadeWidth !== undefined && this.fadeWidth !== width) fade.flush()
    this.fadeWidth = width
    return recolorTail(lines, fade.spans().filter(span => span.age < fade.steps - 1), fade.style())
  }
}

/** Lifecycle of one tool card. */
export type ToolCardStatus = 'running' | 'done' | 'error'

/** A tool call card: status glyph, tool name, headline, then a foldable body. */
export class ToolBlock implements Component {
  private status: ToolCardStatus = 'running'
  private resultLines: string[] = []
  private expanded = false

  constructor(
    private readonly theme: BlockTheme,
    readonly name: string,
    private readonly call: ToolCallText,
  ) {}

  /**
   * Attach the result rows and settle the status.
   * @param lines - the result rows before preview truncation.
   * @param isError - whether the tool reported failure.
   */
  setResult(lines: string[], isError: boolean): void {
    this.resultLines = lines
    this.status = isError ? 'error' : 'done'
  }

  /**
   * Fold or unfold the body.
   * @param expanded - whether the full body is shown.
   */
  setExpanded(expanded: boolean): void {
    this.expanded = expanded
  }

  invalidate(): void {}

  render(width: number): string[] {
    const palette = this.theme.palette
    const glyph = this.status === 'running'
      ? palette.warning('●')
      : this.status === 'done' ? palette.success('●') : palette.error('●')
    const header = `${glyph} ${palette.bold(this.name)}${this.call.title === '' ? '' : ` ${palette.dim(this.call.title)}`}`
    const body = [...this.call.lines, ...this.resultLines]
    const shown = previewLines(body, this.theme.toolPreviewLines, this.expanded)
    const inner = Math.max(1, width - 4)
    const rows = shown.flatMap(line => wrapTextWithAnsi(line, inner).map(part => `  ${palette.dim('│')} ${part}`))
    return ['', ...wrapTextWithAnsi(header, width), ...rows]
  }
}
