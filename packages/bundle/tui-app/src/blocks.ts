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
 *
 * pi-tui asks every component for its lines on every frame, and the
 * transcript is never pruned, so each block keeps the lines it last drew
 * ({@link LastDrawn}) and hands them back until its width, fold, focus, or
 * content changes - a settled block costs a frame one key comparison. What
 * changes per frame - a fade's level, the focus mark's lift - is drawn over
 * those kept lines. Fenced code is the expensive part of a reply, so a reply
 * also keeps the coloured fences of its last Markdown parse
 * ({@link FenceMemo}): a stream delta re-lexes only the open tail after the
 * last closed fence and colours only the fence that changed. `invalidate()`
 * drops all of it, which the application calls on every block when a grammar
 * lands; a new terminal width needs no call, because it misses every key on
 * its own.
 * @module @deepseek-ai/dsh-tui-app/blocks
 */

import { Markdown, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui'
import { maskCredentialText } from '@deepseek-ai/dsh-client-ui-secret-mask'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { sliceColumns } from './columns.ts'
import { fadeInSlice, recolorTail, type FadeSpan, type FadeStyle } from './fade.ts'
import { jsonTreeText, paintJsonRows, type JsonRowStyle } from './json-tree.ts'
import { paintKeys } from './key-chips.ts'
import { pulse, type MotionLevel } from './motion.ts'
import type { AssistantSection, ContextSection, SectionPart, ToolSection, UserSection } from './navigation.ts'
import type { DiffMark } from './diff.ts'
import type { CardFlow, FlowBand } from './pace.ts'
import { TailWrappedText } from './tail-wrap.ts'
import { bandDiffRows, bandRow, markdownTheme, type CodeHighlighter, type Palette } from './style.ts'
import { foldMarker, foldRows, paintCodeRows, SHELL_COMMAND_PREFIX, shellCommandBody, type CodeSpan, type SubagentRowFacts, type ToolCallText } from './transcript.ts'

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

/** Body row a running tool card draws until the result lands. */
export const TOOL_RUNNING_ROW = '…'

/** Glyph a tool card header opens with, coloured by the card's status. */
const TOOL_GLYPH = '◆'

/** Glyph a subagent row opens with, coloured by status like {@link TOOL_GLYPH}. */
export const SUBAGENT_RUNNING_GLYPH = TOOL_GLYPH


/** Glyph a user prompt opens with. */
const USER_GLYPH = '❯'

/** Glyph the reasoning header opens with; the reader marks reasoning sections with the same one. */
const REASONING_GLYPH = '✻'

/**
 * The header above a message's reasoning rows. It is one fixed string for a
 * streaming and a committed message alike, so committing never rewrites a row
 * that may already sit above the repaint floor.
 */
const REASONING_TITLE = 'Thinking'

/** Columns the reasoning rows are indented under their header. */
const REASONING_INDENT = '  '

/** Shared presentation settings every block reads. */
export interface BlockTheme {
  palette: Palette
  /** Collapsed tool-card body rows. */
  toolPreviewLines: number
  /** Collapsed body rows of a system prompt or an injected context block. */
  contextPreviewLines: number
  /** Colours fenced code, `read` / `diff` file rows, and shell commands; absent draws them plain. */
  codeHighlight?: CodeHighlighter
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

/**
 * The last drawing of one block and the key it was built for. One entry, so a
 * block holds exactly one drawing however many frames ask for it, and a key
 * that names every input the drawing depends on is what keeps it current.
 */
class LastDrawn<T> {
  private entry: { key: string; value: T } | undefined

  /**
   * The drawing for `key`, built once per key change.
   * @param key - every input the drawing depends on, joined.
   * @param build - builds the drawing when the key differs from the last one.
   * @returns the same value for the same key until {@link LastDrawn.clear}.
   */
  get(key: string, build: () => T): T {
    if (this.entry?.key !== key) this.entry = { key, value: build() }
    return this.entry.value
  }

  /** Forget the drawing, so the next frame builds it again. */
  clear(): void {
    this.entry = undefined
  }
}

/**
 * The coloured fences of one reply, kept from one Markdown parse to the next.
 *
 * pi-tui's `Markdown` re-parses whenever its text changes and asks the theme
 * to colour every fence it finds, so a streaming reply that already carries
 * three fences would colour all three on every delta of the open tail.
 * This keeps what the last parse asked for: a fence that is asked for again
 * is answered from memory, and a fence the last parse did not ask for is
 * dropped at the next {@link FenceMemo.settle}, so the memo never holds more
 * than the reply shows. A fence the highlighter left plain is not kept, so
 * the grammar that lands is asked for it.
 */
class FenceMemo implements CodeHighlighter {
  /** What the previous parse asked for. */
  private previous = new Map<string, string[]>()
  /** What the parse in progress has asked for so far. */
  private current = new Map<string, string[]>()
  /** Whether a parse asked for anything since the last settle. */
  private asked = false

  /** @param inner - the highlighter that colours a fence this memo does not hold. */
  constructor(private readonly inner: CodeHighlighter) {}

  lines(code: string, lang: string | undefined): string[] | undefined {
    this.asked = true
    // The language is part of the key: the same source under two fence
    // labels colours differently. A bare fence keys under `undefined`.
    const key = `${String(lang)} ${code}`
    const known = this.current.get(key) ?? this.previous.get(key)
    if (known !== undefined) {
      this.current.set(key, known)
      return known
    }
    const coloured = this.inner.lines(code, lang)
    if (coloured !== undefined) this.current.set(key, coloured)
    return coloured
  }

  /**
   * Close the parse that just ran: what it asked for is kept for the next
   * one, and what only the parse before it asked for goes. A render that
   * parsed nothing - `Markdown` served its own cache - changes nothing.
   */
  settle(): void {
    if (!this.asked) return
    this.asked = false
    this.previous = this.current
    this.current = new Map()
  }

  /** Forget every fence, so the next parse colours each one afresh. */
  clear(): void {
    this.previous = new Map()
    this.current = new Map()
    this.asked = false
  }
}

/**
 * A finished `!` / `!!` run: `$ command` in shellscript colour, then dimmed
 * output rows or a semantic-colour JSON tree. Re-paints when a grammar lands
 * because {@link LastDrawn} drops on `invalidate()`.
 */
export class UserShellBlock implements Component {
  /** The wrapped rows, by width. */
  private readonly drawn = new LastDrawn<string[]>()

  /**
   * @param theme - the highlighter that colours the command row.
   * @param command - the text after `!` / `!!`.
   * @param rows - the transcript rows of the finished run, `$ command` first.
   */
  constructor(
    private readonly theme: BlockTheme,
    private readonly command: string,
    private readonly rows: readonly string[],
  ) {}

  invalidate(): void {
    this.drawn.clear()
  }

  /**
   * Draw the run, colouring `$ command` when the grammar answers and the `$` in the accent.
   * @param width - the columns the block lays out in.
   * @returns a blank line, the wrapped rows, and a trailing blank line.
   */
  render(width: number): string[] {
    return this.drawn.get(String(width), () => {
      const extra = this.rows.slice(1)
      const tree = extra[0] === undefined ? undefined : jsonTreeText(extra[0])
      const displayed = tree === undefined ? extra : [...tree.lines, ...extra.slice(1)]
      const { lines, code } = shellCommandBody(this.command, displayed)
      const json: (JsonRowStyle | undefined)[] | undefined = tree === undefined
        ? undefined
        : [undefined, ...tree.json, ...extra.slice(1).map(() => undefined)]
      const highlighted = paintCodeRows(lines, code, this.theme.codeHighlight)
      const painted = paintJsonRows(highlighted, json, lines.map((_, index) => index > 0), this.theme.palette)
      const inner = Math.max(1, width)
      const [command = '', ...output] = painted
      const prompt = `${this.theme.palette.accent(SHELL_COMMAND_PREFIX.trimEnd())} ${command.slice(SHELL_COMMAND_PREFIX.length)}`
      const body = [prompt, ...output].flatMap(row => wrapTextWithAnsi(row, inner))
      return ['', ...body, '']
    })
  }
}

/**
 * How a user prompt entered the conversation: `prompt` opened its turn, and
 * `injected` was steered or injected into a turn that had already stepped.
 */
export type UserPromptKind = 'prompt' | 'injected'

/**
 * A prompt the user submitted, drawn with a leading {@link USER_GLYPH} on a
 * background band that spans every row of the prompt: the palette's band and
 * bold text for a prompt that opened its turn, and the darker
 * {@link Palette.injectedBand} with dim text for one steered or injected into
 * a running turn, so it recedes behind the turn it joined.
 */
export class UserBlock implements Component, UserSection {
  readonly navigable = true as const
  readonly blockKind = 'user' as const
  /** The section drawn as focused; absent while the keyboard is elsewhere. */
  private highlight: number | undefined
  /** How far above its settled accent the focus mark is drawn right now. */
  private highlightLevel: MotionLevel = 0
  /** The wrapped prompt, by width and whether the gutter narrowed it. */
  private readonly drawn = new LastDrawn<string[]>()
  /** The prompt's one section, built on the first read; the text never changes. */
  private sections: readonly SectionPart[] | undefined

  constructor(
    private readonly theme: BlockTheme,
    private readonly text: string,
    readonly turn: number,
    private readonly kind: UserPromptKind = 'prompt',
  ) {}

  /**
   * The prompt as one navigable section.
   * @returns the single `user` part, carrying the submitted text.
   */
  parts(): readonly SectionPart[] {
    this.sections ??= [{ kind: 'user', rows: this.text.split('\n') }]
    return this.sections
  }

  /**
   * Draw this prompt with the focus gutter, or without it.
   * @param part - the index of the focused section, or undefined to clear the mark.
   */
  setHighlight(part: number | undefined, level: MotionLevel = 0): void {
    this.highlight = part
    this.highlightLevel = level
  }

  invalidate(): void {
    this.drawn.clear()
  }

  render(width: number): string[] {
    const palette = this.theme.palette
    const { marked, content: inner } = focusFrame(width, this.highlight)
    const lines = this.drawn.get(`${String(width)}:${String(marked)}`, () => {
      // Recognized credentials draw masked; the section rows keep the sent text for copying.
      const body = wrapTextWithAnsi(maskCredentialText(this.text), Math.max(1, inner - 2))
      if (this.kind === 'injected') {
        return ['', ...body.map((line, index) => bandRow(palette, palette.dim(`${index === 0 ? USER_GLYPH : ' '} ${line}`), inner, palette.injectedBand))]
      }
      return ['', ...body.map((line, index) => bandRow(palette, `${palette.accent(index === 0 ? USER_GLYPH : ' ')} ${palette.bold(line)}`, inner))]
    })
    // The prompt is one section, so every line of a focused prompt is its own.
    return marked ? withGutter(palette, lines, () => true, this.highlightLevel) : lines
  }
}

/**
 * What a compact context row uses in place of the user prompt's
 * {@link USER_GLYPH}; the reader marks context sections with the same one.
 */
const CONTEXT_GLYPH = '⬡'

/** A dim one-line notice about the session (a stopped turn, a command result, a model switch). */
export class NoticeBlock implements Component {
  private readonly text: Text

  constructor(theme: BlockTheme, text: string, tone: 'dim' | 'error' | 'success' = 'dim') {
    const palette = theme.palette
    this.text = new Text(paintKeys(palette, `· ${text}`, palette[tone], 'prose'), 0, 0)
  }

  invalidate(): void {
    this.text.invalidate()
  }

  render(width: number): string[] {
    return this.text.render(width)
  }
}

/** How one {@link ContextBlock} departs from a routine injection's drawing. */
export interface ContextBlockOptions {
  /** Draw the glyph and title in the accent color rather than dim, for context the user should notice. */
  readonly accent?: boolean
  /** How many leading parts the fold never takes; the preview rows count from the first part after them. */
  readonly pinnedParts?: number
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
 * A compaction checkpoint draws as one of these with an accent title and its
 * compressed and preserved account pinned above the folded summary.
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
  /** The wrapped block, by width, fold, and whether the gutter narrowed it. */
  private readonly drawn = new LastDrawn<ContextLayout>()

  /**
   * @param theme - the palette the glyph and title are styled with.
   * @param title - form and producer, a notice summary, or `system prompt`.
   * @param sectionParts - the model-facing rows, one part per snapshot contribution.
   * @param turn - the turn the message was appended in.
   * @param options - the accent title and the pinned leading parts; a routine injection passes none.
   */
  constructor(
    private readonly theme: BlockTheme,
    readonly title: string,
    private readonly sectionParts: readonly SectionPart[],
    readonly turn: number,
    private readonly options: ContextBlockOptions = {},
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

  invalidate(): void {
    this.drawn.clear()
  }

  render(width: number): string[] {
    const palette = this.theme.palette
    const { marked, content: inner } = focusFrame(width, this.highlight)
    const layout = this.drawn.get(
      `${String(width)}:${String(marked)}:${String(this.expanded)}`,
      () => this.layout(inner, marked),
    )
    const { lines, head, ranges, cut, kept, body } = layout
    if (this.highlight === undefined) return lines
    const section = ranges[this.highlight]
    if (section === undefined) return withGutter(palette, lines, () => true, this.highlightLevel)
    // The fold marker stands for the rows every part lost, so it keeps the
    // block's own gutter while the held part still has a row of its own here.
    const drawn = Math.min(section.to, cut ? kept : body)
    const held = markedRange(
      { from: head + section.from, to: head + drawn },
      { from: head + (cut ? kept : body), to: lines.length },
    )
    return withGutter(palette, lines, line => line >= held.from && line < held.to, this.highlightLevel)
  }

  /**
   * Wrap the title and every body row, then fold the body.
   * @param inner - the columns the block's own rows lay out in.
   * @param marked - whether the block draws the focus gutter, which names the fold key.
   * @returns the lines and where the head, each part, and the fold fall in them.
   */
  private layout(inner: number, marked: boolean): ContextLayout {
    const palette = this.theme.palette
    const textWidth = Math.max(1, inner - 2)
    const indent = (line: string): string => `  ${line}`
    // Every row the body draws - a contribution's text, its label, and the
    // marker that stands for the rows the fold left out - is wrapped to the
    // same width: pi-tui refuses to write a line wider than the terminal.
    const dimRows = (text: string): string[] => wrapTextWithAnsi(text, textWidth).map(line => indent(palette.dim(line)))
    const title = wrapTextWithAnsi(this.title, textWidth)
    const tone = this.options.accent === true ? palette.accent : palette.dim
    // The title says what was injected, so it is never folded away; the fold
    // takes only the body, and the ranges address it on its own.
    const head = ['', ...title.map((line, index) => `${tone(index === 0 ? CONTEXT_GLYPH : ' ')} ${tone(line)}`)]
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
    // Every row of the pinned parts is kept; the preview counts from the part after them.
    const pinned = ranges[(this.options.pinnedParts ?? 0) - 1]?.to ?? 0
    const kept = pinned + this.theme.contextPreviewLines
    const cut = !this.expanded && body.length > kept
    const marker = (): string[] =>
      wrapTextWithAnsi(paintKeys(palette, foldMarker(body.length - kept, marked ? 'marked' : 'transcript')), textWidth).map(indent)
    const shown = cut ? [...body.slice(0, kept), ...marker()] : body
    return { lines: [...head, ...shown], head: head.length, ranges, cut, kept, body: body.length }
  }
}

/** One drawing of a {@link ContextBlock}, with the positions the focus gutter is placed by. */
interface ContextLayout {
  /** The lines drawn, gutter not yet applied. */
  lines: string[]
  /** How many lines the blank row and the title take. */
  head: number
  /** Each part's body rows, as offsets into the unfolded body. */
  ranges: LineRange[]
  /** Whether the fold left rows out. */
  cut: boolean
  /** Body rows drawn when the fold cut. */
  kept: number
  /** Body rows before the fold. */
  body: number
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
 * Source through the last closed fenced block, including the newline that
 * follows the closer when the message still has one. An unclosed fence, or a
 * reply with no fence, yields an empty prefix so the whole message is lexed.
 * @param text - the live Markdown source.
 * @returns the closed prefix, or the empty string.
 */
function closedFencePrefix(text: string): string {
  let last = 0
  let index = 0
  let open: { char: string; length: number } | undefined
  while (index <= text.length) {
    const newline = text.indexOf('\n', index)
    const end = newline === -1 ? text.length : newline
    const line = text.slice(index, end)
    let indent = 0
    while (indent < 3 && line[indent] === ' ') indent += 1
    const rest = line.slice(indent)
    const marker = /^(`{3,}|~{3,})/.exec(rest)?.[1]
    if (marker !== undefined) {
      const info = rest.slice(marker.length)
      if (open === undefined) {
        if (!(marker.startsWith('`') && info.includes('`'))) {
          open = { char: marker[0] as string, length: marker.length }
        }
      } else if (marker[0] === open.char && marker.length >= open.length && info.trim() === '') {
        last = newline === -1 ? text.length : newline + 1
        open = undefined
      }
    }
    if (newline === -1) break
    index = newline + 1
  }
  return text.slice(0, last)
}

/**
 * Stack a closed-fence drawing and the open tail the way one Markdown parse
 * would: a fence adds a blank line before the next block unless that block
 * is a blank-line token (the tail then starts with a newline).
 * @param prefixLines - the cached prefix drawing.
 * @param tail - the unparsed tail source.
 * @param tailLines - the tail drawing.
 * @returns the combined Markdown lines.
 */
function joinFencePrefix(prefixLines: readonly string[], tail: string, tailLines: readonly string[]): string[] {
  if (tail.startsWith('\n')) return [...prefixLines, ...tailLines]
  return [...prefixLines, '', ...tailLines]
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
  /** Closed-fence prefix, parsed only when that prefix or the width changes. */
  private readonly prefixMarkdown: Markdown
  /** Last prefix drawing, reused while the closed fences and width hold. */
  private prefixCache: { text: string; width: number; lines: string[] } | undefined
  /** Last text handed to {@link AssistantBlock.markdown}, so fade ticks do not re-lex. */
  private appliedTail: string | undefined
  /** Last text handed to {@link AssistantBlock.prefixMarkdown}. */
  private appliedPrefix: string | undefined
  /** The reasoning rows; a growing block rewraps only its last paragraph. */
  private readonly reasoningText: TailWrappedText
  private fade: FadeRender | undefined
  /** Width of the last render that drew a text tail; absent before the first one. */
  private fadeWidth: number | undefined
  private reasoningFade: FadeRender | undefined
  /** The live Thinking header's bloom; absent draws the settled glyph. */
  private reasoningSpinner: (() => string) | undefined
  /** Whether the message is still streaming, which the header spinner requires; commit settles it. */
  private streaming = false
  /** Width of the last render that drew a reasoning tail; absent before the first one. */
  private reasoningFadeWidth: number | undefined
  /** First line of this block either tail may still recolor. */
  private repaintFloor = 0
  /** The section drawn as focused; absent while the keyboard is elsewhere. */
  private highlight: number | undefined
  /** How far above its settled accent the focus mark is drawn right now. */
  private highlightLevel: MotionLevel = 0
  /** The coloured fences of the last parse; absent when the theme colours none. */
  private readonly fences: FenceMemo | undefined
  /** The settled message, by width, focus, and content; a streaming message is drawn afresh each frame. */
  private readonly drawn = new LastDrawn<AssistantLayout>()
  /** Counts every change to the text, the reasoning, or the committed state. */
  private revision = 0
  /** The sections last read, and the revision they were built at. */
  private sections: { revision: number; parts: readonly SectionPart[] } | undefined

  constructor(private readonly theme: BlockTheme, readonly turn: number) {
    const palette = theme.palette
    this.fences = theme.codeHighlight === undefined ? undefined : new FenceMemo(theme.codeHighlight)
    const themeForMarkdown = markdownTheme(palette, this.fences)
    this.markdown = new Markdown('', 0, 0, themeForMarkdown)
    this.prefixMarkdown = new Markdown('', 0, 0, themeForMarkdown)
    this.reasoningText = new TailWrappedText()
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
    if (this.sections?.revision === this.revision) return this.sections.parts
    const parts: SectionPart[] = []
    if (this.reasoning.trim() !== '') parts.push({ kind: 'reasoning', rows: this.reasoning.split('\n') })
    if (this.text !== '' || parts.length === 0) parts.push({ kind: 'reply', rows: this.text.split('\n') })
    this.sections = { revision: this.revision, parts }
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
   * Animate the live Thinking header on the application's spinner clock.
   * @param frame - the current bloom glyph, or undefined to settle the header;
   * a settled message or a header above the repaint window keeps the static glyph.
   */
  setReasoningSpinner(frame: (() => string) | undefined): void {
    this.reasoningSpinner = this.streaming && this.repaintFloor <= 1 ? frame : undefined
  }

  /**
   * Whether the live Thinking header still spins in the repaint window.
   * @returns true while the message streams with an attached spinner.
   */
  spinning(): boolean {
    return this.reasoningSpinner !== undefined && this.streaming
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
    const spinning = this.spinning() && floor > 1
    if (spinning) this.reasoningSpinner = undefined
    return spinning || (this.fade !== undefined && fadingInSpans(this.fade).length > 0)
      || (this.reasoningFade !== undefined && floatingOutSpans(this.reasoningFade).length > 0)
  }

  /**
   * Append streamed visible text.
   * @param delta - the text delta.
   */
  appendText(delta: string): void {
    this.text += delta
    this.streaming = true
    this.revision += 1
  }

  /**
   * Append streamed reasoning text.
   * @param delta - the reasoning delta.
   */
  appendReasoning(delta: string): void {
    this.reasoning += delta
    this.streaming = true
    this.revision += 1
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
    this.streaming = false
    this.revision += 1
    // The committed content replaces what was streamed, so neither tail
    // describes anything on screen and this block is settled for good.
    this.fade = undefined
    this.reasoningFade = undefined
    this.reasoningSpinner = undefined
    this.prefixCache = undefined
    this.appliedPrefix = undefined
    this.appliedTail = undefined
    this.reasoningText.setText(this.theme.palette.dim(this.theme.palette.italic(reasoning.trimEnd())))
  }

  invalidate(): void {
    this.markdown.invalidate()
    this.prefixMarkdown.invalidate()
    this.prefixCache = undefined
    this.appliedPrefix = undefined
    this.appliedTail = undefined
    this.reasoningText.invalidate()
    this.fences?.clear()
    this.drawn.clear()
  }

  render(width: number): string[] {
    const { marked, content: inner } = focusFrame(width, this.highlight)
    // A tail recolours the newest words by their age, which changes every
    // frame, so a streaming message is composed each time it is asked for.
    const streaming = this.fade !== undefined || this.reasoningFade !== undefined || this.spinning()
    const { lines, reasoning, reply } = streaming
      ? this.compose(inner)
      : this.drawn.get(`${String(width)}:${String(marked)}:${String(this.revision)}`, () => this.compose(inner))
    if (this.highlight === undefined) return lines
    const focused = this.parts()[this.highlight]
    const section = focused?.kind === 'reasoning' ? reasoning : reply
    return withGutter(this.theme.palette, lines, index => index >= section.from && index < section.to, this.highlightLevel)
  }

  /**
   * Stack the reasoning, under its {@link REASONING_TITLE} header and
   * indented, over the reply, each through its own tail.
   * @param inner - the columns the message lays out in.
   * @returns the lines, gutter not yet applied, and where each section falls.
   */
  private compose(inner: number): AssistantLayout {
    const lines: string[] = ['']
    const reasoning = { from: 0, to: 0 }
    const reply = { from: 0, to: 0 }
    if (this.reasoning.trim() !== '') {
      const palette = this.theme.palette
      reasoning.from = lines.length
      const glyph = this.reasoningSpinner?.() ?? REASONING_GLYPH
      lines.push(truncateToWidth(`${palette.heading(glyph)} ${palette.dim(REASONING_TITLE)}`, inner, '…'))
      const width = Math.max(1, inner - REASONING_INDENT.length)
      lines.push(...this.renderReasoning(width, lines.length).map(line => `${REASONING_INDENT}${line}`))
      reasoning.to = lines.length
      lines.push('')
    }
    if (this.text !== '') {
      reply.from = lines.length
      lines.push(...this.renderText(inner, lines.length))
      reply.to = lines.length
    }
    if (this.interrupted) lines.push(this.theme.palette.dim('[interrupted]'))
    return { lines, reasoning, reply }
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
    const lines = this.renderMarkdown(width)
    // The parse, if the render ran one, asked for its fences synchronously.
    this.fences?.settle()
    if (fade === undefined) return lines
    if (this.fadeWidth !== undefined && this.fadeWidth !== width) fade.flush()
    this.fadeWidth = width
    return recolorTail(lines, fadingInSpans(fade), fade.style(), this.repaintFloor - at)
  }

  /**
   * Lex the open tail and reuse the closed-fence prefix at this width.
   * @param width - the width the Markdown lays out in.
   * @returns the Markdown lines, fade not yet applied.
   */
  private renderMarkdown(width: number): string[] {
    const prefix = closedFencePrefix(this.text)
    if (prefix.length === 0) {
      this.prefixCache = undefined
      this.appliedPrefix = undefined
      this.applyMarkdown(this.markdown, this.text, 'tail')
      return this.markdown.render(width)
    }
    const tail = this.text.slice(prefix.length)
    let prefixLines = this.prefixCache
    if (prefixLines === undefined || prefixLines.text !== prefix || prefixLines.width !== width) {
      this.applyMarkdown(this.prefixMarkdown, prefix, 'prefix')
      prefixLines = { text: prefix, width, lines: this.prefixMarkdown.render(width) }
      this.prefixCache = prefixLines
    }
    if (tail.trim() === '') return prefixLines.lines
    this.applyMarkdown(this.markdown, tail, 'tail')
    return joinFencePrefix(prefixLines.lines, tail, this.markdown.render(width))
  }

  /**
   * Hand `text` to `markdown` only when it differs, so a fade tick does not re-lex.
   * @param markdown - the prefix or tail instance.
   * @param text - the source that instance should hold.
   * @param which - which applied-text slot to update.
   */
  private applyMarkdown(markdown: Markdown, text: string, which: 'prefix' | 'tail'): void {
    if (which === 'prefix') {
      if (this.appliedPrefix === text) return
      markdown.setText(text)
      this.appliedPrefix = text
      return
    }
    if (this.appliedTail === text) return
    markdown.setText(text)
    this.appliedTail = text
  }
}

/** One drawing of an {@link AssistantBlock}, with where its two sections fall. */
interface AssistantLayout {
  /** The lines drawn, gutter not yet applied. */
  lines: string[]
  /** The reasoning lines. */
  reasoning: LineRange
  /** The reply lines. */
  reply: LineRange
}

/**
 * Lifecycle of one tool card. `background` is a call the user moved to a
 * background job: the call's own result only names the job, and the job's
 * outcome arrives later as a completion notice.
 */
export type ToolCardStatus = 'running' | 'done' | 'error' | 'background'

/**
 * A tool call card: the status-coloured {@link TOOL_GLYPH}, the bold tool
 * name, the headline in the link colour, then a foldable body.
 *
 * The card arrives in two pieces: the header and the call rows when the model
 * starts the call (a stream delta, or the logged `tool/call`), the result rows
 * when the tool answers. While it runs the body carries
 * {@link TOOL_RUNNING_ROW} in place of a result, and a card given a spinner
 * ({@link ToolBlock.setSpinner}) cycles its glyph until the result lands or
 * its header leaves the renderer's repaint window, then draws the static
 * glyph.
 *
 * A card given a {@link CardFlow} ({@link ToolBlock.setFlow}) flows out: the
 * flow's front decides how many columns of its rows are drawn, row after row,
 * and the columns drawn lately brighten from the terminal background toward
 * their settled colors by their own age. The flow is advanced from the application's
 * frame tick and never by a call or result, which only change what the card
 * holds. A card rebuilt from history carries neither flow nor spinner.
 */
export class ToolBlock implements Component, ToolSection, Foldable {
  readonly navigable = true as const
  readonly blockKind = 'tool' as const
  readonly foldable = true as const
  private status: ToolCardStatus = 'running'
  private resultLines: string[] = []
  /** The code span behind each result row, for a `read` or `diff` result; absent otherwise. */
  private resultCode: (CodeSpan | undefined)[] | undefined
  /** JSON token ranges behind result rows that form a tree; absent otherwise. */
  private resultJson: (JsonRowStyle | undefined)[] | undefined
  /** Which result rows are diff additions or removals, for a `diff` result; absent otherwise. */
  private resultDiff: (DiffMark | undefined)[] | undefined
  /** Whether non-JSON result rows are shell output, dimmed apart from the command. */
  private shellOutput = false
  /** The facts a folded subagent card draws as one row; absent for every other tool. */
  private subagent: SubagentRowFacts | undefined
  private expanded = false
  /** The glyph a running card draws right now; absent draws {@link TOOL_GLYPH}. */
  private spinner: (() => string) | undefined
  /** First line of this card either fade may still recolor. */
  private repaintFloor = 0
  /** The section drawn as focused; absent while the keyboard is elsewhere. */
  private highlight: number | undefined
  /** How far above its settled accent the focus mark is drawn right now. */
  private highlightLevel: MotionLevel = 0
  /** The coloured, folded, wrapped body, by width, fold, focus, status, and result. */
  private readonly drawn = new LastDrawn<ToolLayout>()
  /** Counts every call or result the card was given. */
  private revision = 0
  /** The sections last read, and the revision they were built at. */
  private sections: { revision: number; parts: readonly SectionPart[] } | undefined
  /** How many columns of the card's rows are drawn while it flows out; absent draws every column. */
  private flow: CardFlow | undefined
  /** The drawing settings the flow's trail is colored with; absent flows without color. */
  private flowStyle: (() => FadeStyle) | undefined
  /** The card's visible columns over all rows, the leading blank line excluded, at its last render. */
  private columns = 0
  /** Lines the last render drew, the leading blank line included. */
  private drawnLines = 0
  /** The width the last render was given, which the flow measures its pace against. */
  private flowWidth = 1
  /** Whether {@link columns} was measured after the last call, result, or fold change. */
  private measured = false
  private toolName: string
  private call: ToolCallText

  constructor(
    private readonly theme: BlockTheme,
    name: string,
    call: ToolCallText,
    readonly turn: number,
  ) {
    this.toolName = name
    this.call = call
  }

  /** The tool the model called. */
  get name(): string {
    return this.toolName
  }

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
    if (this.sections?.revision === this.revision) return this.sections.parts
    const title = this.call.title === '' ? [] : [this.call.title]
    const call = [...title, ...this.call.lines]
    const parts: SectionPart[] = [call.length === 0
      ? { kind: 'call', rows: [NO_ARGUMENTS] }
      : {
        kind: 'call',
        rows: call,
        ...this.call.code === undefined ? {} : { code: [...title.map(() => undefined), ...this.call.code] },
        ...this.call.json === undefined ? {} : { json: [...title.map(() => undefined), ...this.call.json] },
      }]
    if (this.status !== 'running') {
      parts.push(this.resultLines.length === 0
        ? { kind: 'result', rows: [NO_OUTPUT] }
        : {
          kind: 'result',
          rows: this.resultLines,
          ...this.resultCode === undefined ? {} : { code: this.resultCode },
          ...this.resultJson === undefined ? {} : { json: this.resultJson },
          ...this.shellOutput ? { shellOutput: true } : {},
        })
    }
    this.sections = { revision: this.revision, parts }
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
   * Replace the call half as streamed arguments arrive or the logged call
   * confirms them.
   * @param name - the tool the model called.
   * @param call - the headline and rows for those arguments.
   */
  setCall(name: string, call: ToolCallText): void {
    this.toolName = name
    this.call = call
    this.revision += 1
    this.measured = false
  }

  /**
   * Draw this card, while folded, as one subagent row: the task description
   * and its route, with the tool name while it runs and the outcome tag once
   * it settled. Unfolding draws the full card.
   * @param facts - the row's description and dim facts.
   */
  setSubagent(facts: SubagentRowFacts): void {
    this.subagent = facts
    this.revision += 1
    this.measured = false
  }

  /**
   * Cycle the header glyph while the card runs.
   * @param frame - the glyph to draw at the moment of a render.
   */
  setSpinner(frame: () => string): void {
    this.spinner = frame
  }

  /**
   * Whether a render right now may draw a different glyph than the last one.
   * @returns true while the card runs with a spinner its header can still show.
   */
  spinning(): boolean {
    return this.spinner !== undefined && this.status === 'running'
  }

  /**
   * Hand the rows the renderer can no longer repaint back to the colors this
   * card drew them in, so a fade that is still moving never rewrites them.
   * @param floor - this card's own first repaintable line; the application
   * raises it as the frame grows and never lowers it.
   * @returns whether the floor took rows away from a fade or a spinner that
   * is drawing right now, and so whether the frame differs from the one just
   * built.
   */
  setRepaintFloor(floor: number): boolean {
    // The header is line 1, under the leading blank line; a spinner redrawing
    // it above the floor would force a full redraw on every frame.
    if (this.spinning() && floor > 1) {
      this.spinner = undefined
      this.repaintFloor = Math.max(this.repaintFloor, floor)
      return true
    }
    // The row the front is drawing changes on every frame; one below a line the
    // renderer can no longer repaint would force a full redraw each time, so
    // such a card draws its columns at once.
    const flow = this.flow
    if (flow !== undefined && flow.shown() < this.columns && floor >= this.drawnLines) {
      flow.settle()
      this.repaintFloor = Math.max(this.repaintFloor, floor)
      return true
    }
    if (floor <= this.repaintFloor) return false
    this.repaintFloor = floor
    return flow !== undefined && this.flowColors() !== undefined && flow.receding()
  }

  /**
   * Attach the result rows and settle the status. A diff result replaces the
   * rows of a diff call.
   * @param lines - the result rows before preview truncation.
   * @param isError - whether the tool reported failure.
   * @param code - the span behind each row, for a result the card colours as code.
   * @param diff - which rows are diff additions or removals, for a result the card boxes as a diff.
   * @param presentation - JSON token ranges and whether the rows are shell output.
   */
  setResult(
    lines: string[],
    isError: boolean,
    code?: (CodeSpan | undefined)[],
    diff?: (DiffMark | undefined)[],
    presentation: Pick<ToolCallText, 'json' | 'shellOutput'> = {},
  ): void {
    // The applied hunks say everything the call-time diff did, with file
    // lines and context, so they take its place in the card.
    if (diff !== undefined && this.call.diff !== undefined) this.call = { title: this.call.title, lines: [] }
    this.resultLines = lines
    this.resultCode = code
    this.resultJson = presentation.json
    this.resultDiff = diff
    this.shellOutput = presentation.shellOutput === true
    this.status = isError ? 'error' : 'done'
    this.revision += 1
    this.measured = false
  }

  /**
   * Settle the card as moved to the background: the glyph takes the accent
   * colour and the body ends on `lines` instead of a result.
   * @param lines - the rows naming the job that took the call over.
   */
  setBackground(lines: string[]): void {
    this.resultLines = lines
    this.resultCode = undefined
    this.resultJson = undefined
    this.resultDiff = undefined
    this.shellOutput = false
    this.status = 'background'
    this.revision += 1
    this.measured = false
  }

  /**
   * Flow the card's rows out on the application's frame tick instead of
   * drawing them all in one frame: now, and again whenever a call or a result
   * makes the card grow.
   * @param flow - the front that decides how many columns are drawn; the card
   * draws that many columns of its rows after the leading blank line.
   * @param style - the settings the freshly drawn columns are colored with,
   * read per render because the terminal background query settles after the
   * card is mounted; absent draws the flow without color.
   */
  setFlow(flow: CardFlow, style?: () => FadeStyle): void {
    this.flow = flow
    this.flowStyle = style
    this.measured = false
  }

  /**
   * Whether columns of this card are still hidden or still brightening, or
   * the card changed since its last render and may have gained columns.
   * @returns true while the flow still has a frame to draw.
   */
  revealing(): boolean {
    return this.flow !== undefined && (!this.measured || this.flowDrawing(this.flow))
  }

  /**
   * Move the flow's front by the time elapsed since the previous frame.
   * @returns whether the flow still has a frame to draw after this one.
   */
  revealFrame(): boolean {
    const flow = this.flow
    if (flow === undefined) return false
    // A change the card has not rendered yet has no column count to flow
    // towards; the render that follows this frame measures it.
    if (!this.measured) return true
    flow.frame(this.columns, this.flowWidth)
    return this.flowDrawing(flow)
  }

  /**
   * Whether another frame of `flow` changes what the card draws: columns are
   * hidden, or drawn ones are brightening in a terminal that draws the color.
   * @param flow - the card's flow.
   * @returns true while a frame is still owed.
   */
  private flowDrawing(flow: CardFlow): boolean {
    return flow.shown() < this.columns || (this.flowColors() !== undefined && flow.receding())
  }

  /**
   * The colors the flow's trail is drawn with right now.
   * @returns the style, or undefined when the card has none or the terminal draws no color.
   */
  private flowColors(): FadeStyle | undefined {
    const style = this.flowStyle?.()
    return style?.capability === 'none' ? undefined : style
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
    // Unfolding answers a key, so the rows it adds are drawn at once.
    if (expanded !== this.expanded) this.flow?.settle()
    this.expanded = expanded
  }

  invalidate(): void {
    this.drawn.clear()
  }

  render(width: number): string[] {
    const palette = this.theme.palette
    const { marked, content: outer } = focusFrame(width, this.highlight)
    const layout = this.drawn.get(
      `${String(width)}:${String(marked)}:${String(this.expanded)}:${this.status}:${String(this.revision)}`,
      () => this.layout(outer, marked),
    )
    // The leading blank line is index 0 of the card, so the call group starts
    // at 1 and the result group where the call group ended.
    const call = this.spun(layout.call)
    const full = call === layout.call ? layout.lines : ['', ...call, ...layout.result]
    const widths = layout.widths ??= layout.lines.slice(1).map(line => visibleWidth(line))
    this.columns = widths.reduce((sum, columns) => sum + columns, 0)
    this.flowWidth = width
    this.measured = true
    this.flow?.clamp(this.columns)
    const visible = this.flow === undefined ? full : this.flowed(full, widths)
    this.drawnLines = visible.length
    if (this.highlight === undefined) return visible
    // The truncation marker belongs to the card rather than to either section:
    // it stands for the rows both of them left out, so it keeps the block's own
    // gutter while the held section still has a row of its own. It is the last
    // row the fold produced.
    const sections = full.length - layout.marker
    const focused = this.parts()[this.highlight]
    const section = focused?.kind === 'result'
      ? { from: 1 + layout.call.length, to: full.length }
      : { from: 1, to: 1 + layout.call.length }
    const held = markedRange(
      { from: section.from, to: Math.min(section.to, sections) },
      { from: sections, to: full.length },
    )
    return withGutter(palette, visible, index => index >= held.from && index < held.to, this.highlightLevel)
  }

  /**
   * The card with only the columns the flow has reached, the last row cut
   * where the front stands, and the columns drawn lately colored by age.
   * @param full - the card's lines, the leading blank line first.
   * @param widths - the visible columns of each line after the blank one.
   * @returns the lines to draw, which are `full` itself once the flow has drawn
   * every column and its trail has receded.
   */
  private flowed(full: string[], widths: readonly number[]): string[] {
    const flow = this.flow as CardFlow
    const shown = flow.shown()
    const style = this.flowColors()
    const trail = style === undefined ? [] : flow.trail()
    if (shown >= this.columns && trail.length === 0) return full
    const lines = ['']
    let start = 0
    for (const [index, columns] of widths.entries()) {
      if (start >= shown) break
      const line = full[1 + index] as string
      const drawn = Math.min(columns, shown - start)
      const cut = drawn >= columns ? line : sliceColumns(line, [drawn])[0] as string
      // A row above the first repaintable line keeps the colors it settled in.
      const settled = style === undefined || trail.length === 0 || 1 + index < this.repaintFloor
      lines.push(settled ? cut : floatedRow(cut, start, drawn, trail, style))
      start += columns
    }
    return lines
  }

  /**
   * Colour, fold, and wrap the card body.
   * @param outer - the columns the card lays out in.
   * @param marked - whether the card draws the focus gutter, which names the fold key.
   * @returns the header with the call rows, the result rows, both stacked
   * under the blank line, and how many lines the fold marker took.
   */
  private layout(outer: number, marked: boolean): ToolLayout {
    const palette = this.theme.palette
    if (this.subagent !== undefined && !this.expanded) {
      const row = this.subagentRow(this.subagent, outer)
      return { call: [row], result: [], lines: ['', row], marker: 0 }
    }
    const header = `${this.statusStyle()(TOOL_GLYPH)} ${palette.bold(palette.tool(this.toolName))}${this.call.title === '' ? '' : ` ${palette.subject(this.call.title)}`}`
    const loading = this.status === 'running' ? [TOOL_RUNNING_ROW] : []
    const body = [...this.call.lines, ...loading, ...this.resultLines]
    // The spans align with the body by index; a half with no code gets a
    // run of undefined so the result spans keep their offsets. The loading
    // row is never code.
    const code = this.call.code === undefined && this.resultCode === undefined
      ? undefined
      : [
        ...this.call.code ?? new Array<undefined>(this.call.lines.length).fill(undefined),
        ...new Array<undefined>(loading.length).fill(undefined),
        ...this.resultCode ?? new Array<undefined>(this.resultLines.length).fill(undefined),
      ]
    const json = this.call.json === undefined && this.resultJson === undefined
      ? undefined
      : [
        ...this.call.json ?? new Array<undefined>(this.call.lines.length).fill(undefined),
        ...new Array<undefined>(loading.length).fill(undefined),
        ...this.resultJson ?? new Array<undefined>(this.resultLines.length).fill(undefined),
      ]
    const output = body.map((_, index) => this.shellOutput && index >= this.call.lines.length + loading.length)
    // Truncation runs over the whole body, so the kept rows can stop inside
    // the call rows; how many of them survived splits the two fade groups.
    // The fold marker is past every span, so it always draws plain. The
    // loading row fades with the call, because it is the call's pending half.
    const kept = this.expanded
      ? body
      : foldRows(body, this.theme.toolPreviewLines, hidden => foldMarker(hidden, marked ? 'marked' : 'transcript'))
    const cut = !this.expanded && body.length > this.theme.toolPreviewLines
    // A changed row keeps its own syntax colour and takes the tint filling it
    // from the mark instead, so nothing paints it twice. The fold marker keeps
    // the terminal's own colour around the key it names.
    const presentationLength = cut ? kept.length - 1 : kept.length
    const highlighted = paintCodeRows(kept, code, this.theme.codeHighlight)
    const painted = paintJsonRows(highlighted, json?.slice(0, presentationLength), output.slice(0, presentationLength), palette)
    const shown = cut ? [...painted.slice(0, -1), paintKeys(palette, kept.at(-1) as string, text => text)] : painted
    const callCount = Math.min(this.call.lines.length + loading.length, shown.length)
    // Marks align with the body like the spans; the fold marker, the last
    // kept row of a cut body, is never filled.
    const marks = [
      ...this.call.diff ?? new Array<undefined>(this.call.lines.length).fill(undefined),
      ...new Array<undefined>(loading.length).fill(undefined),
      ...this.resultDiff ?? new Array<undefined>(this.resultLines.length).fill(undefined),
    ].slice(0, cut ? kept.length - 1 : kept.length)
    const inner = Math.max(1, outer - 4)
    const rows = (from: number, to: number): string[] =>
      bandDiffRows(shown.slice(from, to), kept.slice(from, to), marks.slice(from, to), inner, palette)
        .map(part => `  ${palette.dim('│')} ${part}`)
    const call = [...wrapTextWithAnsi(header, outer), ...rows(0, callCount)]
    const result = rows(callCount, shown.length)
    return { call, result, lines: ['', ...call, ...result], marker: cut ? rows(shown.length - 1, shown.length).length : 0 }
  }

  /**
   * The call rows with the header's running glyph replaced by the spinner's
   * current frame. The kept layout draws the static glyph, so a spinner frame
   * rewrites one prefix instead of laying the card out again.
   * @param call - the header and call rows as the kept layout draws them.
   * @returns `call` itself when nothing spins, or a copy with the frame drawn.
   */
  private spun(call: string[]): string[] {
    if (this.spinner === undefined || !this.spinning()) return call
    const palette = this.theme.palette
    const settled = palette.warning(TOOL_GLYPH)
    const [header, ...rows] = call
    /* v8 ignore next -- a running card's header and subagent row both open on the warning glyph */
    if (header?.startsWith(settled) !== true) return call
    return [`${palette.warning(this.spinner())}${header.slice(settled.length)}`, ...rows]
  }

  /**
   * The colour of this card's status glyph.
   * @returns warning while running, success once done, error once failed, accent once moved to the background.
   */
  private statusStyle(): (text: string) => string {
    const palette = this.theme.palette
    switch (this.status) {
      case 'running':
        return palette.warning
      case 'done':
        return palette.success
      case 'error':
        return palette.error
      case 'background':
        return palette.accent
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        return assertNever(this.status, 'tool card status')
    }
  }

  /**
   * The one row a folded subagent card draws, led by the status-coloured
   * {@link SUBAGENT_RUNNING_GLYPH}. A running row carries the cyan tool
   * name; a settled row is dim and ends on its outcome tag at the right edge:
   * `[failed]` for an error, `[started]` for a call that handed the child to
   * the background, whose result reads `started …` and whose glyph is dim,
   * and `[done]` for a call that returned the child's answer.
   * @param facts - the description and the dim facts.
   * @param width - the columns the row fits.
   * @returns the row, no wider than `width`.
   */
  private subagentRow(facts: SubagentRowFacts, width: number): string {
    const palette = this.theme.palette
    const meta = facts.meta.length === 0 ? '' : ` ${palette.dim(facts.meta.join(' · '))}`
    const description = facts.description === '' ? '' : `  ${facts.description}`
    if (this.status === 'running') {
      const name = palette.bold(palette.tool(this.toolName))
      return truncateToWidth(`${palette.warning(SUBAGENT_RUNNING_GLYPH)} ${name}${description}${meta}`, width, '…')
    }
    const started = this.status === 'done' && this.resultLines[0]?.startsWith('started ') === true
    const tag = this.status === 'error'
      ? palette.error('[failed]')
      : this.status === 'background'
        ? palette.accent('[background]')
        : started ? palette.dim('[started]') : palette.success('[done]')
    const glyph = started ? palette.dim(SUBAGENT_RUNNING_GLYPH) : this.statusStyle()(SUBAGENT_RUNNING_GLYPH)
    const left = `${glyph} ${palette.dim(facts.description === '' ? this.toolName : facts.description)}${meta}`
    const cut = truncateToWidth(left, Math.max(1, width - visibleWidth(tag) - 1), '…')
    const gap = ' '.repeat(Math.max(1, width - visibleWidth(cut) - visibleWidth(tag)))
    return truncateToWidth(`${cut}${gap}${tag}`, width, '…')
  }
}

/** One drawing of a {@link ToolBlock}, in the two groups its fades recolour. */
interface ToolLayout {
  /** The header and the call rows. */
  call: string[]
  /** The result rows, the fold marker included. */
  result: string[]
  /** The blank line, then both groups, as the card draws with every fade settled. */
  lines: string[]
  /** Lines the fold marker took at the end of `result`; 0 while nothing was folded away. */
  marker: number
  /** The visible columns of each line after the blank one, measured when the card first needs them. */
  widths?: number[]
}

/**
 * Float out the freshly drawn columns of one row, each run at its own age.
 * @param row - the row as drawn, already cut at the front.
 * @param start - the first column of this row over the card's rows.
 * @param drawn - the columns of this row that are drawn.
 * @param trail - the runs drawn lately, oldest first, in columns over the card's rows.
 * @param style - the capability and the ramp.
 * @returns the row with each run it holds recolored, or `row` when none reaches it.
 */
function floatedRow(row: string, start: number, drawn: number, trail: readonly FlowBand[], style: FadeStyle): string {
  const runs: { from: number; to: number; age: number }[] = []
  for (const band of trail) {
    const from = Math.max(band.start - start, 0)
    const to = Math.min(band.end - start, drawn)
    if (to > from) runs.push({ from, to, age: band.age })
  }
  if (runs.length === 0) return row
  const pieces = sliceColumns(row, runs.flatMap(run => [run.from, run.to]))
  let out = pieces[0] as string
  runs.forEach((run, index) => {
    out += `${fadeInSlice(pieces[2 * index + 1] as string, run.age, style)}${pieces[2 * index + 2] as string}`
  })
  return out
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
