/**
 * Transcript components: one pi-tui component per rendered fact (a user
 * prompt, an assistant reply, a tool card, a notice). Each owns its display
 * state and re-renders from it at any width.
 * @module @deepseek-ai/dsh-tui-app/blocks
 */

import { Markdown, Text, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui'
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

/**
 * An assistant reply: streamed reasoning above streamed Markdown text. The
 * durable `assistant/message` replaces both with the committed content.
 */
export class AssistantBlock implements Component {
  private reasoning = ''
  private text = ''
  private interrupted = false
  private readonly markdown: Markdown
  private readonly reasoningText: Text

  constructor(private readonly theme: BlockTheme) {
    const palette = theme.palette
    this.markdown = new Markdown('', 0, 0, markdownTheme(palette))
    this.reasoningText = new Text('', 0, 0)
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
    if (this.text !== '') lines.push(...this.markdown.render(width))
    if (this.interrupted) lines.push(this.theme.palette.dim('[interrupted]'))
    return lines
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
