/**
 * The prompt editor's caret, word navigation, and live `!` / `!!` syntax
 * colour. pi-tui draws the caret cell itself in reverse video; this module
 * takes that block off the rendered lines, names the DECSCUSR sequences for a
 * blinking bar, maps Shift+Left/Right to pi-tui's word movement, and paints a
 * shell draft over those lines without writing ANSI into the editor state.
 * @module @deepseek-ai/dsh-tui-app/editor
 */

import {
  CURSOR_MARKER,
  Editor,
  matchesKey,
  stripTerminalSequences,
  visibleWidth,
} from '@earendil-works/pi-tui'
import { parseUserShellDraft, type UserShellDraft } from './shell-line.ts'
import type { CodeHighlighter, Style } from './style.ts'

/**
 * DECSCUSR `CSI 5 SP q` (`\x1b[5 q`): tell the terminal to draw its text
 * cursor as a blinking vertical bar.
 */
export const SET_BLINKING_BAR_CURSOR = '\u001b[5 q'

/**
 * DECSCUSR `CSI 0 SP q` (`\x1b[0 q`): tell the terminal to draw its text
 * cursor in the shape it is configured with, for the application to write
 * before it releases the terminal.
 */
export const SET_TERMINAL_DEFAULT_CURSOR = '\u001b[0 q'

/** Canonical Ctrl+Left sequence bound to pi-tui's word-backward action. */
const WORD_LEFT = '\u001b[1;5D'

/** Canonical Ctrl+Right sequence bound to pi-tui's word-forward action. */
const WORD_RIGHT = '\u001b[1;5C'

/** SGR reverse video on, which pi-tui opens its drawn block cursor with. */
const REVERSE_VIDEO_ON = '\u001b[7m'

/** SGR reset, which pi-tui closes its drawn block cursor with. */
const REVERSE_VIDEO_OFF = '\u001b[0m'

/** Ends colour, bold, and italic a sliced token may have left open. */
const RESET_PAINT = '\u001b[39m\u001b[22m\u001b[23m'

/** Graphemes the overlay wraps at, matching the editor's default segmenter. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * How a `!` / `!!` draft is painted over the editor's own lines. The
 * highlighter colours the command; `warning` colours the bang. ANSI is never
 * written into the editor state.
 */
export interface ShellEditorPaint {
  /** Colours the command as `shellscript`; a miss leaves it plain. */
  highlight: CodeHighlighter
  /** Colours `!` / `!!`, the same role as the editor's shell-mode border. */
  warning: Style
  /** Horizontal padding the editor was constructed with. */
  paddingX: number
}

/**
 * Take pi-tui's drawn block cursor off one rendered editor line.
 *
 * The removal is anchored at `CURSOR_MARKER`, which pi-tui emits immediately
 * before the cell it draws: only the `\x1b[7m` / `\x1b[0m` pair that follows
 * the marker is deleted, so reverse video inside the text the user typed or
 * pasted is never touched. The cell's own character stays - or, past the last
 * character of the line, the space pi-tui drew instead - so the line keeps its
 * visible width and the marker keeps its column. A line with no marker, or a
 * marker the pair does not follow, comes back unchanged.
 * @param line - one line of `Editor.render` output.
 * @returns the line with the marker still in place and the block gone.
 */
export function stripBlockCursor(line: string): string {
  const marker = line.indexOf(CURSOR_MARKER)
  if (marker === -1) return line
  const block = marker + CURSOR_MARKER.length
  if (!line.startsWith(REVERSE_VIDEO_ON, block)) return line
  const cell = block + REVERSE_VIDEO_ON.length
  const close = line.indexOf(REVERSE_VIDEO_OFF, cell)
  if (close === -1) return line
  return line.slice(0, block) + line.slice(cell, close) + line.slice(close + REVERSE_VIDEO_OFF.length)
}

/**
 * Paint a `!` / `!!` draft over pi-tui's already-rendered editor lines.
 *
 * The bang uses the warning role; the command uses the shellscript grammar.
 * Borders, padding, the caret marker, and an autocomplete list stay as
 * rendered. A chunk whose painted width differs from its plain width, or
 * that cannot be matched after a scroll, is left plain.
 * @param lines - the lines after {@link stripBlockCursor}.
 * @param text - `Editor.getText()`, the unwrapped draft.
 * @param width - the width those lines were laid out in.
 * @param paint - the highlighter, the bang style, and the editor padding.
 * @returns the same number of lines, with colour on a shell draft.
 */
export function paintShellEditorLines(
  lines: readonly string[],
  text: string,
  width: number,
  paint: ShellEditorPaint,
): string[] {
  const draft = parseUserShellDraft(text)
  if (draft === undefined) return [...lines]
  const visual = visualChunks(text, paintDraftLines(draft, paint), editorLayoutWidth(width, paint.paddingX))
  const pad = editorPad(width, paint.paddingX)
  const out = [...lines]
  const bottom = out.findIndex((line, index) => index > 0 && isEditorRule(line))
  const end = bottom === -1 ? out.length : bottom
  let next = 0
  for (const [index, line] of out.entries()) {
    if (index === 0 || index >= end) continue
    const painted = overlayEditorLine(line, pad, visual, next)
    if (painted === undefined) continue
    out[index] = painted.line
    next = painted.next
  }
  return out
}

/**
 * Colour the logical lines of a shell draft: indent plain, bang in warning,
 * command in shellscript when the grammar answers.
 * @param draft - the parsed editor text.
 * @param paint - the highlighter and the bang style.
 * @returns one styled line per source line.
 */
function paintDraftLines(draft: UserShellDraft, paint: ShellEditorPaint): string[] {
  const commandLines = draft.command.split('\n')
  const coloured = paint.highlight.lines(draft.command, 'shellscript')
  const paintedCommand = coloured !== undefined && sameVisibleWidths(coloured, commandLines)
    ? coloured
    : commandLines
  const indentLines = draft.indent.split('\n')
  return [
    ...indentLines.slice(0, -1),
    `${indentLines[indentLines.length - 1] as string}${paint.warning(draft.bang)}${paintedCommand[0] as string}`,
    ...paintedCommand.slice(1),
  ]
}

/**
 * Whether two row lists have the same length and the same visible width on
 * each row, so a highlighter result can replace the source without shifting
 * columns.
 * @param coloured - the highlighter's rows.
 * @param plain - the source rows.
 * @returns true when every row can stand in for its source.
 */
function sameVisibleWidths(coloured: readonly string[], plain: readonly string[]): boolean {
  return coloured.length === plain.length
    && coloured.every((line, index) => visibleWidth(line) === visibleWidth(plain[index] as string))
}

/**
 * Wrap each logical line the way the editor does, and slice the painted
 * twin by the same source indices.
 * @param text - the unwrapped editor text.
 * @param paintedLogical - one styled line per source line.
 * @param layoutWidth - the width the editor wrapped at.
 * @returns the visible chunks, in order, including those currently scrolled away.
 */
function visualChunks(
  text: string,
  paintedLogical: readonly string[],
  layoutWidth: number,
): { plain: string; painted: string }[] {
  const logical = text.split('\n')
  const visual: { plain: string; painted: string }[] = []
  for (const [index, plainLine] of logical.entries()) {
    const paintedLine = paintedLogical[index] as string
    for (const chunk of wrapEditorLine(plainLine, layoutWidth)) {
      const painted = `${slicePaintedBySource(paintedLine, chunk.startIndex, chunk.endIndex)}${RESET_PAINT}`
      visual.push({
        plain: chunk.text,
        painted: visibleWidth(painted) === visibleWidth(chunk.text) ? painted : chunk.text,
      })
    }
  }
  return visual
}

/**
 * Overlay the next matching visual chunk onto one rendered content line.
 * @param line - one rendered line, padding included.
 * @param pad - the left padding string.
 * @param visual - the wrapped chunks in source order.
 * @param next - the first chunk that may still appear.
 * @returns the painted line and the next search index, or undefined when no
 *   remaining chunk matches.
 */
function overlayEditorLine(
  line: string,
  pad: string,
  visual: readonly { plain: string; painted: string }[],
  next: number,
): { line: string; next: number } | undefined {
  if (pad.length > 0 && !line.startsWith(pad)) return undefined
  const rest = line.slice(pad.length)
  const markerAt = rest.indexOf(CURSOR_MARKER)
  const withoutMarker = markerAt === -1
    ? rest
    : rest.slice(0, markerAt) + rest.slice(markerAt + CURSOR_MARKER.length)
  for (const [offset, chunk] of visual.slice(next).entries()) {
    if (!innerMatches(withoutMarker, chunk.plain)) continue
    const painted = markerAt === -1 ? chunk.painted : insertCursorMarker(chunk.painted, markerAt)
    return { line: `${pad}${painted}${withoutMarker.slice(chunk.plain.length)}`, next: next + offset + 1 }
  }
  return undefined
}

/**
 * Split one logical line into the visual chunks the editor wraps at
 * `maxWidth`. Word boundaries win; a run longer than the width breaks on a
 * grapheme. Paste markers are not treated as atomic, so a chunk that cannot
 * be matched after a wrap is left plain.
 * @param line - one source line, without its newline.
 * @param maxWidth - the width {@link editorLayoutWidth} computed.
 * @returns the chunks in source order, with their source indices.
 */
function wrapEditorLine(line: string, maxWidth: number): { text: string; startIndex: number; endIndex: number }[] {
  if (line === '') return [{ text: '', startIndex: 0, endIndex: 0 }]
  if (visibleWidth(line) <= maxWidth) return [{ text: line, startIndex: 0, endIndex: line.length }]
  const chunks: { text: string; startIndex: number; endIndex: number }[] = []
  const segments = [...GRAPHEMES.segment(line)]
  let currentWidth = 0
  let chunkStart = 0
  let wrapOppIndex = -1
  let wrapOppWidth = 0
  for (const [index, seg] of segments.entries()) {
    const grapheme = seg.segment
    const gWidth = visibleWidth(grapheme)
    const charIndex = seg.index
    const isWs = /\s/u.test(grapheme)
    if (currentWidth + gWidth > maxWidth) {
      if (wrapOppIndex >= 0) {
        chunks.push({ text: line.slice(chunkStart, wrapOppIndex), startIndex: chunkStart, endIndex: wrapOppIndex })
        chunkStart = wrapOppIndex
        currentWidth -= wrapOppWidth
      } else if (chunkStart < charIndex) {
        chunks.push({ text: line.slice(chunkStart, charIndex), startIndex: chunkStart, endIndex: charIndex })
        chunkStart = charIndex
        currentWidth = 0
      }
      wrapOppIndex = -1
    }
    currentWidth += gWidth
    const next = segments[index + 1]
    if (isWs && next !== undefined) {
      if (!/\s/u.test(next.segment)) {
        wrapOppIndex = next.index
        wrapOppWidth = currentWidth
      }
    }
  }
  chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length })
  return chunks
}

/**
 * Whether a rendered inner line is one wrapped chunk plus trailing pad.
 * @param inner - the line after left padding, with the caret marker removed.
 * @param plain - one wrapped chunk of the source.
 * @returns true when `inner` is that chunk followed only by spaces.
 */
function innerMatches(inner: string, plain: string): boolean {
  if (plain === '') return inner.trim() === ''
  return inner.startsWith(plain) && inner.slice(plain.length).trim() === ''
}

/**
 * Insert {@link CURSOR_MARKER} before the given source character of a painted
 * chunk, walking past SGR so the marker stays on the same character.
 * @param painted - the styled chunk.
 * @param sourceOffset - the source index the marker occupies in the plain chunk.
 * @returns the chunk with the marker inserted.
 */
function insertCursorMarker(painted: string, sourceOffset: number): string {
  let source = 0
  let index = 0
  while (index < painted.length) {
    if (painted.charCodeAt(index) === 0x1b) {
      const close = painted.indexOf('m', index + 1)
      /* v8 ignore next -- highlighter tokens close every CSI with m */
      if (close === -1) break
      index = close + 1
      continue
    }
    if (source === sourceOffset) return `${painted.slice(0, index)}${CURSOR_MARKER}${painted.slice(index)}`
    source += 1
    index += 1
  }
  return `${painted}${CURSOR_MARKER}`
}

/**
 * Take the painted characters whose source indices fall in `[start, end)`.
 * SGR that opened before `start` is kept so a wrap mid-token keeps its colour.
 * @param painted - one styled logical line.
 * @param start - the first source index to keep.
 * @param end - the source index after the last kept character.
 * @returns the sliced styled text.
 */
function slicePaintedBySource(painted: string, start: number, end: number): string {
  let source = 0
  let index = 0
  let prefix = ''
  let out = ''
  while (index < painted.length && source < end) {
    if (painted.charCodeAt(index) === 0x1b) {
      const close = painted.indexOf('m', index + 1)
      /* v8 ignore next -- highlighter tokens close every CSI with m */
      if (close === -1) break
      const seq = painted.slice(index, close + 1)
      if (source >= start) out += seq
      else prefix += seq
      index = close + 1
      continue
    }
    if (source >= start) out += painted[index]
    source += 1
    index += 1
  }
  return `${prefix}${out}`
}

/**
 * Whether a rendered line is an editor rule: the top or bottom `─` border,
 * including a scroll indicator, never a padded content row.
 * @param line - one rendered line.
 * @returns true when the visible text starts with `─`.
 */
function isEditorRule(line: string): boolean {
  return stripTerminalSequences(line).startsWith('─')
}

/**
 * The width the editor wraps content at, matching pi-tui's padding rule.
 * @param width - the total editor width.
 * @param paddingX - the configured horizontal padding.
 * @returns the wrap width.
 */
function editorLayoutWidth(width: number, paddingX: number): number {
  const pad = editorPadColumns(width, paddingX)
  const contentWidth = Math.max(1, width - pad * 2)
  return Math.max(1, contentWidth - (pad > 0 ? 0 : 1))
}

/**
 * The left (and right) padding string the editor prepends to content.
 * @param width - the total editor width.
 * @param paddingX - the configured horizontal padding.
 * @returns that many spaces, clamped as pi-tui clamps.
 */
function editorPad(width: number, paddingX: number): string {
  return ' '.repeat(editorPadColumns(width, paddingX))
}

/**
 * How many padding columns the editor takes at this width.
 * @param width - the total editor width.
 * @param paddingX - the configured horizontal padding.
 * @returns the clamped column count.
 */
function editorPadColumns(width: number, paddingX: number): number {
  const maxPadding = Math.max(0, Math.floor((width - 1) / 2))
  return Math.min(Math.max(0, Math.floor(paddingX)), maxPadding)
}

/**
 * The prompt editor drawn without pi-tui's block cursor.
 *
 * pi-tui's `Editor` always draws the caret cell in reverse video and
 * `EditorOptions` carries no switch for it, while the real terminal cursor is
 * placed from the `CURSOR_MARKER` the editor emits at the same position. This
 * subclass removes that block from the lines `render` returns so the
 * terminal's own cursor - which the application shapes with
 * `SET_BLINKING_BAR_CURSOR` - is the only caret on screen. It also gives
 * Shift+Left and Shift+Right the editor's existing word-backward and
 * word-forward actions. Text, autocomplete, padding, borders, scrolling,
 * submission, and history otherwise remain pi-tui's, and the component writes
 * to no terminal itself. {@link BarCursorEditor.shellPaint} paints a `!` /
 * `!!` draft over the content lines after the block is gone.
 *
 * pi-tui emits the marker only while the editor is focused, yet it draws the
 * block either way, so an unfocused editor would keep a caret while another
 * region holds the keyboard. `render` therefore turns the marker on for the
 * `super.render` call to anchor the removal, then drops the marker again when
 * the editor is not focused: the unfocused editor shows no caret, and the
 * terminal cursor stays with the region that owns the keyboard.
 */
export class BarCursorEditor extends Editor {
  /**
   * When set, a `!` / `!!` draft is painted over the lines `render` returns.
   * Absent, or a draft that is not a shell line, leaves the text as pi-tui
   * drew it.
   */
  shellPaint: ShellEditorPaint | undefined

  /**
   * Handle Shift+Left and Shift+Right as pi-tui's word movements.
   * @param data - the bytes the terminal sent.
   */
  override handleInput(data: string): void {
    if (matchesKey(data, 'shift+left')) {
      super.handleInput(WORD_LEFT)
      return
    }
    if (matchesKey(data, 'shift+right')) {
      super.handleInput(WORD_RIGHT)
      return
    }
    super.handleInput(data)
  }

  /**
   * Render the editor without pi-tui's drawn block cursor.
   * @param width - the total width to lay the editor out in.
   * @returns the rendered lines, carrying `CURSOR_MARKER` only while focused.
   */
  override render(width: number): string[] {
    const focused = this.focused
    this.focused = true
    let lines: string[]
    try {
      lines = super.render(width)
    } finally {
      this.focused = focused
    }
    const stripped = lines.map((line) => {
      const next = stripBlockCursor(line)
      return focused ? next : next.replaceAll(CURSOR_MARKER, '')
    })
    const paint = this.shellPaint
    return paint === undefined
      ? stripped
      : paintShellEditorLines(stripped, this.getText(), width, { ...paint, paddingX: this.getPaddingX() })
  }
}
