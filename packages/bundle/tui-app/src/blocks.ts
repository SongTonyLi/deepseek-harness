/**
 * Transcript components: one pi-tui component per rendered fact (a user
 * prompt, an assistant reply, a tool card, a system prompt or injected
 * context, a notice). Each owns its display state and re-renders from it at
 * any width.
 *
 * The prompt, the reply, the tool card, and the compact context row are also
 * the navigable blocks the keyboard walks (`./navigation.ts`): each reports
 * its sections as plain source rows and draws a two-column gutter beside them
 * while it holds the focus - accented on the focused section's own lines and
 * dim on the rest of the block. The gutter narrows the width the block's
 * content wraps at and is prepended after any fade recoloring, so the fade
 * keeps matching the block's own text and the gutter's styling never enters
 * that match.
 * @module @deepseek-ai/dsh-tui-app/blocks
 */

import { Markdown, Text, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui'
import { recolorLines, recolorTail, type FadeSpan, type FadeStyle } from './fade.ts'
import { pulse, type MotionLevel } from './motion.ts'
import type { AssistantSection, ContextSection, SectionPart, ToolSection, UserSection } from './navigation.ts'
import { markdownTheme, type Palette } from './style.ts'
import { foldMarker, foldRows, type ToolCallText } from './transcript.ts'

/** Columns the focus gutter takes from the width a block's content wraps at. */
const GUTTER_WIDTH = 2

/** The gutter beside the lines of a focused block that are not the focused section. */
const BLOCK_GUTTER = '│ '

/** The gutter beside the lines of the focused section itself. */
const PART_GUTTER = '┃ '

/** Body rows a system prompt or an injected context block draws while it is folded. */
export const CONTEXT_PREVIEW_LINES = 4

/** What the call section reports for a tool the model called with no arguments. */
const NO_ARGUMENTS = '(no arguments)'

/** What the result section reports for a tool that answered with nothing. */
const NO_OUTPUT = '(no output)'

/** Shared presentation settings every block reads. */
export interface BlockTheme {
  palette: Palette
  /** Collapsed tool-card body rows. */
  toolPreviewLines: number
  /** Collapsed body rows of a system prompt or an injected context block. */
  contextPreviewLines: number
}

/**
 * A block whose body the keyboard folds and unfolds: the tool card and the
 * context block today. `Ctrl+O` sets every one of them at once and `Space`
 * turns the one the transcript focus holds, so a kind that starts folding
 * joins both keys by carrying the marker.
 */
export interface Foldable {
  /** Marks a transcript child as foldable; {@link isFoldable} tests it. */
  readonly foldable: true
  /**
   * Whether the whole body is drawn right now.
   * @returns true while this block is unfolded.
   */
  isExpanded(): boolean
  /**
   * Fold or unfold the body.
   * @param expanded - whether the full body is shown.
   */
  setExpanded(expanded: boolean): void
}

/**
 * Whether one transcript child folds.
 * @param child - a child of the transcript container.
 * @returns true when the child carries the foldable marker.
 */
export function isFoldable(child: unknown): child is Foldable {
  return typeof child === 'object' && child !== null && (child as { foldable?: unknown }).foldable === true
}

/** The room one block draws in, once the focus gutter has taken its own columns. */
interface FocusFrame {
  /** Whether the block draws the focus gutter at all. */
  marked: boolean
  /** Columns left for the block's own rows. */
  content: number
}

/**
 * How one block draws while the keyboard holds it, or does not.
 * @param width - the width the transcript container gave the block.
 * @param highlight - the index of the focused section, or undefined while the keyboard is elsewhere.
 * @returns whether the gutter is drawn, and the columns it leaves the block.
 */
function focusFrame(width: number, highlight: number | undefined): FocusFrame {
  const marked = highlight !== undefined
  return { marked, content: marked ? Math.max(1, width - GUTTER_WIDTH) : width }
}

/**
 * Prepend the focus gutter to every line of a block that holds the focus.
 * @param palette - the palette the gutter marks are styled with.
 * @param lines - the block's final rendered lines, fades already applied.
 * @param focused - whether the line at one index belongs to the focused section.
 * @param level - how far above its settled accent the focused section's own
 * mark is lifted, so a step of the walk is seen where it landed; the gutter
 * beside the block's other lines stays dim throughout.
 * @returns the lines behind their gutter.
 */
function withGutter(
  palette: Palette,
  lines: readonly string[],
  focused: (index: number) => boolean,
  level: MotionLevel,
): string[] {
  const mark = pulse(palette, palette.accent(PART_GUTTER), level)
  return lines.map((line, index) => `${focused(index) ? mark : palette.dim(BLOCK_GUTTER)}${line}`)
}

/** A run of a block's rendered lines: the first, and the one after the last. */
interface LineRange {
  from: number
  to: number
}

/**
 * Which lines of a folded block the focus mark is drawn beside: the focused
 * section's own drawn rows, or the fold marker when the fold left that
 * section out of the transcript entirely. The marker stands for the rows the
 * fold took, so it is the line the mark belongs on once they include every
 * row the keyboard holds - a block drawn as focused always marks a line, and
 * the docked inspector's report that the block carries the mark stays true.
 * @param section - the focused section's drawn rows.
 * @param marker - the fold marker's rows; an empty run while the block folds nothing.
 * @returns the run the gutter accents.
 */
function markedRange(section: LineRange, marker: LineRange): LineRange {
  return section.to > section.from ? section : marker
}

/** A prompt the user submitted, drawn with a leading `›`. */
export class UserBlock implements Component, UserSection {
  readonly navigable = true as const
  readonly blockKind = 'user' as const
  /** The section drawn as focused; absent while the keyboard is elsewhere. */
  private highlight: number | undefined
  /** How far above its settled accent the focus mark is drawn right now. */
  private highlightLevel: MotionLevel = 0

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
   * @param part - the index of the focused section, or undefined to clear the mark.
   */
  setHighlight(part: number | undefined, level: MotionLevel = 0): void {
    this.highlight = part
    this.highlightLevel = level
  }

  invalidate(): void {}

  render(width: number): string[] {
    const palette = this.theme.palette
    const { marked, content: inner } = focusFrame(width, this.highlight)
    const body = wrapTextWithAnsi(this.text, Math.max(1, inner - 2))
    const lines = ['', ...body.map((line, index) => `${palette.accent(index === 0 ? '›' : ' ')} ${palette.bold(line)}`)]
    // The prompt is one section, so every line of a focused prompt is its own.
    return marked ? withGutter(palette, lines, () => true, this.highlightLevel) : lines
  }
}

/** What a compact context row uses in place of the user prompt's `›`. */
const CONTEXT_GLYPH = '⬡'

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
 * A system prompt or injected context under a dim title, folded to
 * `contextPreviewLines` body rows until it is opened.
 *
 * One injection can carry more rows than the conversation around it, so the
 * transcript shows its head and names the key that draws the rest. What the
 * model was given is never cut from what the keyboard reads: `parts()` stays
 * complete, so the walk, the inspector, and any reader see every row whatever
 * the transcript draws. Snapshot contributions keep their names above their
 * own rows, and the Left/Right walk still addresses one contribution at a time.
 */
export class ContextBlock implements Component, ContextSection, Foldable {
  readonly navigable = true as const
  readonly blockKind = 'context' as const
  readonly foldable = true as const
  /** The section drawn as focused; absent while the keyboard is elsewhere. */
  private highlight: number | undefined
  /** How far above its settled accent the focus mark is drawn right now. */
  private highlightLevel: MotionLevel = 0
  private expanded = false

  /**
   * @param theme - the palette the glyph and title are styled with.
   * @param title - form and producer, a notice summary, or `system prompt`.
   * @param sectionParts - the model-facing rows, one part per snapshot contribution.
   * @param turn - the turn the message was appended in.
   */
  constructor(
    private readonly theme: BlockTheme,
    readonly title: string,
    private readonly sectionParts: readonly SectionPart[],
    readonly turn: number,
  ) {}

  /**
   * The injection as navigable sections.
   * @returns the parts the constructor was given.
   */
  parts(): readonly SectionPart[] {
    return this.sectionParts
  }

  /**
   * Draw this row with the focus gutter, or without it.
   * @param part - the index of the focused section, or undefined to clear the mark.
   */
  setHighlight(part: number | undefined, level: MotionLevel = 0): void {
    this.highlight = part
    this.highlightLevel = level
  }

  /**
   * Whether every model-facing row is drawn right now.
   * @returns true while the block is unfolded.
   */
  isExpanded(): boolean {
    return this.expanded
  }

  /**
   * Fold or unfold the body under the title.
   * @param expanded - whether every row is shown.
   */
  setExpanded(expanded: boolean): void {
    this.expanded = expanded
  }

  invalidate(): void {}

  render(width: number): string[] {
    const palette = this.theme.palette
    const { marked, content: inner } = focusFrame(width, this.highlight)
    const textWidth = Math.max(1, inner - 2)
    const indent = (line: string): string => `  ${line}`
    // Every row the body draws - a contribution's text, its label, and the
    // marker that stands for the rows the fold left out - is wrapped to the
    // same width: pi-tui refuses to write a line wider than the terminal.
    const dimRows = (text: string): string[] => wrapTextWithAnsi(text, textWidth).map(line => indent(palette.dim(line)))
    const title = wrapTextWithAnsi(this.title, textWidth)
    // The title says what was injected, so it is never folded away; the fold
    // takes only the body, and the ranges address it on its own.
    const head = ['', ...title.map((line, index) => `${palette.dim(index === 0 ? CONTEXT_GLYPH : ' ')} ${palette.dim(line)}`)]
    const body: string[] = []
    const ranges: { from: number; to: number }[] = []
    for (const part of this.sectionParts) {
      const from = body.length
      if (part.label !== undefined) {
        body.push(...wrapTextWithAnsi(part.label, textWidth).map(line => indent(palette.bold(line))))
      }
      const empty = part.rows.length === 1 && part.rows[0] === ''
      if (!empty) {
        for (const row of part.rows) body.push(...dimRows(row))
      }
      ranges.push({ from, to: body.length })
    }
    const kept = this.theme.contextPreviewLines
    const cut = !this.expanded && body.length > kept
    const shown = cut ? [...body.slice(0, kept), ...dimRows(foldMarker(body.length - kept, marked ? 'marked' : 'transcript'))] : body
    const lines = [...head, ...shown]
    if (this.highlight === undefined) return lines
    const section = ranges[this.highlight]
    if (section === undefined) return withGutter(palette, lines, () => true, this.highlightLevel)
    // The fold marker stands for the rows every part lost, so it keeps the
    // block's own gutter while the held part still has a row of its own here.
    const drawn = Math.min(section.to, cut ? kept : body.length)
    const held = markedRange(
      { from: head.length + section.from, to: head.length + drawn },
      { from: head.length + (cut ? kept : body.length), to: lines.length },
    )
    return withGutter(palette, lines, line => line >= held.from && line < held.to, this.highlightLevel)
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
  private highlight: number | undefined
  /** How far above its settled accent the focus mark is drawn right now. */
  private highlightLevel: MotionLevel = 0

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
   * reply once visible text has arrived. An empty reply is kept only while the
   * message has no reasoning, so a tool-call step does not add a blank section.
   */
  parts(): readonly SectionPart[] {
    const parts: SectionPart[] = []
    if (this.reasoning.trim() !== '') parts.push({ kind: 'reasoning', rows: this.reasoning.split('\n') })
    if (this.text !== '' || parts.length === 0) parts.push({ kind: 'reply', rows: this.text.split('\n') })
    return parts
  }

  /**
   * Draw this message with the focus gutter, or without it.
   * @param part - the index of the focused section, or undefined to clear the mark.
   */
  setHighlight(part: number | undefined, level: MotionLevel = 0): void {
    this.highlight = part
    this.highlightLevel = level
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
    const { content: inner } = focusFrame(width, this.highlight)
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
    if (this.highlight === undefined) return lines
    const focused = this.parts()[this.highlight]
    const section = focused?.kind === 'reasoning' ? reasoning : reply
    return withGutter(this.theme.palette, lines, index => index >= section.from && index < section.to, this.highlightLevel)
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
export class ToolBlock implements Component, ToolSection, Foldable {
  readonly navigable = true as const
  readonly blockKind = 'tool' as const
  readonly foldable = true as const
  private status: ToolCardStatus = 'running'
  private resultLines: string[] = []
  private expanded = false
  private fade: BlockFade | undefined
  private resultFade: BlockFade | undefined
  /** First line of this card either fade may still recolor. */
  private repaintFloor = 0
  /** The section drawn as focused; absent while the keyboard is elsewhere. */
  private highlight: number | undefined
  /** How far above its settled accent the focus mark is drawn right now. */
  private highlightLevel: MotionLevel = 0

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
   * @param part - the index of the focused section, or undefined to clear the mark.
   */
  setHighlight(part: number | undefined, level: MotionLevel = 0): void {
    this.highlight = part
    this.highlightLevel = level
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
   * Whether the whole body is drawn right now.
   * @returns true while the card is unfolded.
   */
  isExpanded(): boolean {
    return this.expanded
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
    const { marked, content: outer } = focusFrame(width, this.highlight)
    const glyph = this.status === 'running'
      ? palette.warning('●')
      : this.status === 'done' ? palette.success('●') : palette.error('●')
    const header = `${glyph} ${palette.bold(this.name)}${this.call.title === '' ? '' : ` ${palette.dim(this.call.title)}`}`
    const body = [...this.call.lines, ...this.resultLines]
    // Truncation runs over the whole body, so the kept rows can stop inside
    // the call rows; how many of them survived splits the two fade groups.
    const shown = this.expanded
      ? body
      : foldRows(body, this.theme.toolPreviewLines, hidden => foldMarker(hidden, marked ? 'marked' : 'transcript'))
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
    if (this.highlight === undefined) return lines
    // The truncation marker belongs to the card rather than to either section:
    // it stands for the rows both of them left out, so it keeps the block's own
    // gutter while the held section still has a row of its own. It is the last
    // row the fold produced.
    const cut = !this.expanded && body.length > this.theme.toolPreviewLines
    const sections = lines.length - (cut ? rows(shown.slice(-1)).length : 0)
    const focused = this.parts()[this.highlight]
    const section = focused?.kind === 'result'
      ? { from: 1 + callLines.length, to: lines.length }
      : { from: 1, to: 1 + callLines.length }
    const held = markedRange(
      { from: section.from, to: Math.min(section.to, sections) },
      { from: sections, to: lines.length },
    )
    return withGutter(palette, lines, index => index >= held.from && index < held.to, this.highlightLevel)
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
