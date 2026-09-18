/**
 * Transcript components: one pi-tui component per rendered fact (a user
 * prompt, an assistant reply, a tool card, a notice). Each owns its display
 * state and re-renders from it at any width.
 *
 * The prompt, the reply, and the tool card are also the navigable blocks the
 * keyboard walks (`./navigation.ts`): each reports its sections as plain source
 * rows and draws a two-column gutter beside them while it holds the focus -
 * accented on the focused section's own lines and dim on the rest of the
 * block. The gutter narrows the width the block's content wraps at and is
 * prepended after any fade recoloring, so the fade keeps matching the block's
 * own text and the gutter's styling never enters that match.
 * @module @deepseek-ai/dsh-tui-app/blocks
 */

import { Markdown, Text, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui'
import { recolorLines, recolorTail, type FadeSpan, type FadeStyle } from './fade.ts'
import type { AssistantSection, SectionKind, SectionPart, ToolSection, UserSection } from './navigation.ts'
import { markdownTheme, type Palette } from './style.ts'
import { previewLines, type ToolCallText } from './transcript.ts'

/** Columns the focus gutter takes from the width a block's content wraps at. */
const GUTTER_WIDTH = 2

/** The gutter beside the lines of a focused block that are not the focused section. */
const BLOCK_GUTTER = '│ '

/** The gutter beside the lines of the focused section itself. */
const PART_GUTTER = '┃ '

/** What the call section reports for a tool the model called with no arguments. */
const NO_ARGUMENTS = '(no arguments)'

/** What the result section reports for a tool that answered with nothing. */
const NO_OUTPUT = '(no output)'

/** Shared presentation settings every block reads. */
export interface BlockTheme {
  palette: Palette
  /** Collapsed tool-card body rows. */
  toolPreviewLines: number
}

/**
 * Prepend the focus gutter to every line of a block that holds the focus.
 * @param palette - the palette the gutter marks are styled with.
 * @param lines - the block's final rendered lines, fades already applied.
 * @param focused - whether the line at one index belongs to the focused section.
 * @returns the lines behind their gutter.
 */
function withGutter(palette: Palette, lines: readonly string[], focused: (index: number) => boolean): string[] {
  return lines.map((line, index) => `${focused(index) ? palette.accent(PART_GUTTER) : palette.dim(BLOCK_GUTTER)}${line}`)
}

/** A prompt the user submitted, drawn with a leading `›`. */
export class UserBlock implements Component, UserSection {
  readonly navigable = true as const
  readonly blockKind = 'user' as const
  /** The section drawn as focused; absent while the keyboard is elsewhere. */
  private highlight: SectionKind | undefined

  constructor(private readonly theme: BlockTheme, private readonly text: string, readonly turn: number) {}

  /**
   * The prompt as one navigable section.
   * @returns the single `user` part, carrying the submitted text.
   */
  parts(): readonly SectionPart[] {
    return [{ kind: 'user', rows: this.text.split('\n') }]
  }

  /**
   * Draw this prompt with the focus gutter, or without it.
   * @param part - the focused section, or undefined to clear the mark.
   */
  setHighlight(part: SectionKind | undefined): void {
    this.highlight = part
  }

  invalidate(): void {}

  render(width: number): string[] {
    const palette = this.theme.palette
    const marked = this.highlight !== undefined
    const inner = marked ? Math.max(1, width - GUTTER_WIDTH) : width
    const body = wrapTextWithAnsi(this.text, Math.max(1, inner - 2))
    const lines = ['', ...body.map((line, index) => `${palette.accent(index === 0 ? '›' : ' ')} ${palette.bold(line)}`)]
    // The prompt is one section, so every line of a focused prompt is its own.
    return marked ? withGutter(palette, lines, () => true) : lines
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

/** The live fade of one block that floats out as a unit rather than word by word. */
export interface BlockFade {
  /**
   * The fractional age the block's rows draw at. Read per render, not
   * captured: the application ages it on the wall clock.
   * @returns elapsed `stepMs` units, or undefined once the block draws in the
   * colors it rendered itself.
   */
  age(): number | undefined
  /**
   * The resolved capability and ramp. Read per render, not captured: the
   * terminal background query settles after the application has started.
   * @returns the settings the rows draw under right now.
   */
  style(): FadeStyle
}

/**
 * An assistant reply: streamed reasoning above streamed Markdown text. The
 * durable `assistant/message` replaces both with the committed content.
 *
 * A block that is streaming right now can carry a {@link FadeRender} for its
 * text and another for its reasoning. Visible text draws newest words dimmed
 * and brightening; reasoning floats out from a lifted color toward the dim
 * italic it settles in. A block rebuilt from history carries neither, and
 * {@link AssistantBlock.commit} drops the ones a streaming block had, so
 * settled text is never recolored.
 */
export class AssistantBlock implements Component, AssistantSection {
  readonly navigable = true as const
  readonly blockKind = 'assistant' as const
  private reasoning = ''
  private text = ''
  private interrupted = false
  private readonly markdown: Markdown
  private readonly reasoningText: Text
  private fade: FadeRender | undefined
  /** Width of the last render that drew a text tail; absent before the first one. */
  private fadeWidth: number | undefined
  private reasoningFade: FadeRender | undefined
  /** Width of the last render that drew a reasoning tail; absent before the first one. */
  private reasoningFadeWidth: number | undefined
  /** First line of this block either tail may still recolor. */
  private repaintFloor = 0
  /** The section drawn as focused; absent while the keyboard is elsewhere. */
  private highlight: SectionKind | undefined

  constructor(private readonly theme: BlockTheme, readonly turn: number) {
    const palette = theme.palette
    this.markdown = new Markdown('', 0, 0, markdownTheme(palette))
    this.reasoningText = new Text('', 0, 0)
  }

  /**
   * The message as navigable sections, carrying the model's own text: the
   * reasoning as it was streamed or committed, and the reply as Markdown
   * source rather than the rendering the transcript draws.
   * @returns the reasoning part while the message has reasoning, then the
   * reply, which is present from the start and empty until text arrives.
   */
  parts(): readonly SectionPart[] {
    const parts: SectionPart[] = []
    if (this.reasoning.trim() !== '') parts.push({ kind: 'reasoning', rows: this.reasoning.split('\n') })
    parts.push({ kind: 'reply', rows: this.text.split('\n') })
    return parts
  }

  /**
   * Draw this message with the focus gutter, or without it.
   * @param part - the focused section, or undefined to clear the mark.
   */
  setHighlight(part: SectionKind | undefined): void {
    this.highlight = part
  }

  /**
   * Draw this block's newest text through `fade` until it commits.
   * @param fade - the tail and drawing settings of the running stream.
   */
  setFade(fade: FadeRender): void {
    this.fade = fade
  }

  /**
   * Draw this block's newest reasoning through `fade` until it commits.
   * @param fade - the tail and drawing settings of the running stream.
   */
  setReasoningFade(fade: FadeRender): void {
    this.reasoningFade = fade
  }

  /**
   * Hand the rows the renderer can no longer repaint back to the colors this
   * block drew them in, so a tail that is still moving never rewrites them.
   * @param floor - this block's own first repaintable line; the application
   * raises it as the frame grows and never lowers it.
   * @returns whether the floor took rows away from a tail that is drawing
   * right now, and so whether the frame differs from the one just built.
   */
  setRepaintFloor(floor: number): boolean {
    if (floor <= this.repaintFloor) return false
    this.repaintFloor = floor
    return (this.fade !== undefined && fadingInSpans(this.fade).length > 0)
      || (this.reasoningFade !== undefined && floatingOutSpans(this.reasoningFade).length > 0)
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
    // The committed content replaces what was streamed, so neither tail
    // describes anything on screen and this block is settled for good.
    this.fade = undefined
    this.reasoningFade = undefined
    this.markdown.setText(text)
    this.reasoningText.setText(this.theme.palette.dim(this.theme.palette.italic(reasoning.trimEnd())))
  }

  invalidate(): void {
    this.markdown.invalidate()
    this.reasoningText.invalidate()
  }

  render(width: number): string[] {
    const marked = this.highlight !== undefined
    const inner = marked ? Math.max(1, width - GUTTER_WIDTH) : width
    const lines: string[] = ['']
    const reasoning = { from: 0, to: 0 }
    const reply = { from: 0, to: 0 }
    if (this.reasoning.trim() !== '') {
      reasoning.from = lines.length
      lines.push(...this.renderReasoning(inner, lines.length))
      reasoning.to = lines.length
      lines.push('')
    }
    if (this.text !== '') {
      reply.from = lines.length
      lines.push(...this.renderText(inner, lines.length))
      reply.to = lines.length
    }
    if (this.interrupted) lines.push(this.theme.palette.dim('[interrupted]'))
    if (!marked) return lines
    const section = this.highlight === 'reasoning' ? reasoning : reply
    return withGutter(this.theme.palette, lines, index => index >= section.from && index < section.to)
  }

  /**
   * The reasoning lines, with the streaming tail floated out toward dim italic.
   *
   * The mix starts at a lifted color and recedes to the faint foreground the
   * settled reasoning already carries. At full age the original dim italic
   * bytes come back unchanged.
   * @param width - the width the reasoning lays out in.
   * @param at - index of the region's first line in this block's render.
   * @returns the lines to draw.
   */
  private renderReasoning(width: number, at: number): string[] {
    const fade = this.reasoningFade
    const lines = this.reasoningText.render(width)
    if (fade === undefined) return lines
    if (this.reasoningFadeWidth !== undefined && this.reasoningFadeWidth !== width) fade.flush()
    this.reasoningFadeWidth = width
    return recolorTail(lines, floatingOutSpans(fade), fade.style(), this.repaintFloor - at, 'out')
  }

  /**
   * The Markdown lines, with the streaming tail recolored.
   *
   * `recolorTail` matches the tail backwards from the end of what it is
   * given, so it gets the Markdown lines alone: the reasoning above them and
   * any marker below them would put the newest chunk somewhere other than the
   * end and drop the whole tail to the plain foreground.
   * @param width - the width the Markdown lays out in.
   * @param at - index of the region's first line in this block's render.
   * @returns the lines to draw.
   */
  private renderText(width: number, at: number): string[] {
    const fade = this.fade
    const lines = this.markdown.render(width)
    if (fade === undefined) return lines
    if (this.fadeWidth !== undefined && this.fadeWidth !== width) fade.flush()
    this.fadeWidth = width
    return recolorTail(lines, fadingInSpans(fade), fade.style(), this.repaintFloor - at)
  }
}

/** Lifecycle of one tool card. */
export type ToolCardStatus = 'running' | 'done' | 'error'

/**
 * A tool call card: status glyph, tool name, headline, then a foldable body.
 *
 * The card arrives in two pieces, and each floats out on its own: the header
 * and the call rows when the call is logged, the result rows when the tool
 * answers. A card rebuilt from history carries neither fade.
 */
export class ToolBlock implements Component, ToolSection {
  readonly navigable = true as const
  readonly blockKind = 'tool' as const
  private status: ToolCardStatus = 'running'
  private resultLines: string[] = []
  private expanded = false
  private fade: BlockFade | undefined
  private resultFade: BlockFade | undefined
  /** First line of this card either fade may still recolor. */
  private repaintFloor = 0
  /** The section drawn as focused; absent while the keyboard is elsewhere. */
  private highlight: SectionKind | undefined

  constructor(
    private readonly theme: BlockTheme,
    readonly name: string,
    private readonly call: ToolCallText,
    readonly turn: number,
  ) {}

  /** The card headline, as the section heading names this call. */
  get title(): string {
    return this.call.title
  }

  /**
   * The card as navigable sections, carrying its untruncated rows whatever the
   * collapsed body shows.
   * @returns the call section, then the result section once the tool answered.
   */
  parts(): readonly SectionPart[] {
    const call = [...this.call.title === '' ? [] : [this.call.title], ...this.call.lines]
    const parts: SectionPart[] = [{ kind: 'call', rows: call.length === 0 ? [NO_ARGUMENTS] : call }]
    if (this.status !== 'running') {
      parts.push({ kind: 'result', rows: this.resultLines.length === 0 ? [NO_OUTPUT] : this.resultLines })
    }
    return parts
  }

  /**
   * Draw this card with the focus gutter, or without it.
   * @param part - the focused section, or undefined to clear the mark.
   */
  setHighlight(part: SectionKind | undefined): void {
    this.highlight = part
  }

  /**
   * Draw the header and the call rows through `fade` until it settles.
   * @param fade - the level and drawing settings of this card's own fade.
   */
  setFade(fade: BlockFade): void {
    this.fade = fade
  }

  /**
   * Draw the result rows through `fade` until it settles.
   * @param fade - the level and drawing settings of the result's own fade.
   */
  setResultFade(fade: BlockFade): void {
    this.resultFade = fade
  }

  /**
   * Hand the rows the renderer can no longer repaint back to the colors this
   * card drew them in, so a fade that is still moving never rewrites them.
   * @param floor - this card's own first repaintable line; the application
   * raises it as the frame grows and never lowers it.
   * @returns whether the floor took rows away from a fade that is drawing
   * right now, and so whether the frame differs from the one just built.
   */
  setRepaintFloor(floor: number): boolean {
    if (floor <= this.repaintFloor) return false
    this.repaintFloor = floor
    return this.fade?.age() !== undefined || this.resultFade?.age() !== undefined
  }

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
    const marked = this.highlight !== undefined
    const outer = marked ? Math.max(1, width - GUTTER_WIDTH) : width
    const glyph = this.status === 'running'
      ? palette.warning('●')
      : this.status === 'done' ? palette.success('●') : palette.error('●')
    const header = `${glyph} ${palette.bold(this.name)}${this.call.title === '' ? '' : ` ${palette.dim(this.call.title)}`}`
    const body = [...this.call.lines, ...this.resultLines]
    // Truncation runs over the whole body, so the kept rows can stop inside
    // the call rows; how many of them survived splits the two fade groups.
    const shown = previewLines(body, this.theme.toolPreviewLines, this.expanded)
    const callCount = Math.min(this.call.lines.length, shown.length)
    const inner = Math.max(1, outer - 4)
    const rows = (lines: readonly string[]): string[] =>
      lines.flatMap(line => wrapTextWithAnsi(line, inner).map(part => `  ${palette.dim('│')} ${part}`))
    const callLines = [...wrapTextWithAnsi(header, outer), ...rows(shown.slice(0, callCount))]
    const resultLines = rows(shown.slice(callCount))
    // The leading blank line is index 0 of the card, so the call group starts
    // at 1 and the result group where the call group ended.
    const call = faded(callLines, this.fade, this.repaintFloor - 1)
    const result = faded(resultLines, this.resultFade, this.repaintFloor - 1 - callLines.length)
    const lines = ['', ...call, ...result]
    if (!marked) return lines
    // The truncation marker belongs to the card rather than to either section:
    // it stands for the rows both of them left out, so it keeps the block's own
    // gutter. It is the last row `previewLines` produced.
    const cut = !this.expanded && body.length > this.theme.toolPreviewLines
    const sections = lines.length - (cut ? rows(shown.slice(-1)).length : 0)
    const section = this.highlight === 'result'
      ? { from: 1 + callLines.length, to: lines.length }
      : { from: 1, to: 1 + callLines.length }
    return withGutter(palette, lines, index => index >= section.from && index < section.to && index < sections)
  }
}

/**
 * Draw one group of a card's rows at the mix its fade reports.
 * @param lines - the group's final rendered lines.
 * @param fade - the group's fade; absent for a card that never faded.
 * @param from - first line of the group the fade may recolor.
 * @returns the lines at that mix, or the lines themselves once the fade
 * settled or was never attached.
 */
function faded(lines: readonly string[], fade: BlockFade | undefined, from: number): readonly string[] {
  if (fade === undefined) return lines
  const age = fade.age()
  return age === undefined ? lines : recolorLines(lines, age, fade.style(), from)
}

/**
 * The tail chunks one streaming reply still draws below the terminal's own
 * foreground.
 *
 * The last ramp level is an assumed foreground - pi-tui reports the terminal
 * background but not its foreground - so a chunk that reached it is left to
 * draw in the terminal's own foreground, which is also what it draws in once it
 * leaves the tail. No chunk can therefore jump color as it settles.
 * @param fade - the region's fade.
 * @returns the spans to recolor, oldest first.
 */
function fadingInSpans(fade: FadeRender): readonly FadeSpan[] {
  return fade.spans().filter(span => span.age < fade.steps - 1)
}

/**
 * The tail chunks one streaming reasoning region still floats out.
 *
 * Overlay continues until `age >= steps`, which is `steps * stepMs` after the
 * word appeared. The last overlay sits near the dim settle; the next frame is
 * the original dim italic bytes.
 * @param fade - the region's fade.
 * @returns the spans to recolor, oldest first.
 */
function floatingOutSpans(fade: FadeRender): readonly FadeSpan[] {
  return fade.spans().filter(span => span.age < fade.steps)
}
