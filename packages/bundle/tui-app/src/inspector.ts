/**
 * The docked inspector above the editor: while the keyboard walks the
 * transcript it shows the focused section in full - what it is, which part of
 * its block is held, and that part's own rows. Context sections draw every
 * row; other sections fold at `focusPreviewLines` with Enter opening the rest.
 *
 * It is the focus indicator that is always on screen. A block is also marked
 * in place, but only while the renderer can still repaint its first line
 * (`./navigation.ts`), so the heading says when the marked block itself has
 * scrolled out of reach. Rows arrive as the block's source text with no fade
 * and no palette styling of their own, so a section that is still streaming
 * grows here as it arrives. A block with several parts draws them as a numbered
 * wrapping strip `← 1 reasoning · 2 reply →` so Left/Right walk is visible
 * and every part label stays on screen.
 * @module @deepseek-ai/dsh-tui-app/inspector
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui'
import type { PartLabel } from './navigation.ts'
import type { Palette } from './style.ts'
import { foldRows } from './transcript.ts'

/** Rows of the focused section the inspector shows before `Enter` opens the whole of it. */
export const FOCUS_PREVIEW_LINES = 12

/** What separates two labels of the parts strip. */
const SEPARATOR = ' · '

/** What the heading appends while the focused block lies outside the repaint window. */
const OFF_SCREEN = ' · off screen'

/** The keys the inspector answers, drawn dim under its rows. */
const HINT = '↑ ↓ sections · ← → parts · Enter page · Esc back'

/** Opens the numbered parts strip, so Left/Right read as a walk along this row. */
const STRIP_START = '← '

/** Closes the numbered parts strip. */
const STRIP_END = ' →'

/** What ends a line the width cut short; one column, so the mark itself fits. */
const ELLIPSIS = '…'

/** The focused section as the inspector draws it. */
export interface InspectorView {
  /** The section heading: position, turn, and what the section is. */
  heading: string
  /** One label per part of the focused block, the held one marked. */
  parts: readonly PartLabel[]
  /** The focused part's full source rows. */
  rows: readonly string[]
  /** Whether the focused block itself carries the in-place mark right now. */
  highlighted: boolean
  /**
   * When true, every source row is drawn. Context sections use this so a
   * system prompt or snapshot contribution is not folded behind Enter.
   */
  complete?: boolean
}

/** How the inspector is drawn. */
export interface InspectorRender {
  /** The palette the heading, the strip, and the hints are styled with. */
  palette: Palette
  /** Rows of the focused section drawn before the fold marker. */
  previewLines: number
  /** The width the rows wrap at. */
  width: number
}

/**
 * Draw the focused section.
 * @param view - the section to show.
 * @param render - the palette, the row budget, and the width.
 * @returns the inspector's lines, none wider than `width`: a blank separator,
 * the heading, the numbered parts strip when the block has more than one part
 * (wrapped so every part stays on screen), the rows, and the hints.
 */
export function renderInspector(view: InspectorView, render: InspectorRender): string[] {
  const { palette } = render
  const width = Math.max(1, render.width)
  const chrome = ['', heading(view, palette, width)]
  // One part is its own block: the strip would offer nothing to move to.
  if (view.parts.length > 1) chrome.push(...partsStrip(view.parts, palette, width))
  const wrapped = view.rows.flatMap(row => wrapTextWithAnsi(row, width))
  const body = view.complete === true
    ? wrapped
    : foldRows(wrapped, render.previewLines, hidden =>
      palette.dim(`… ${String(hidden)} more row${hidden === 1 ? '' : 's'} · Enter opens the page`))
  // pi-tui refuses a frame holding a line wider than the terminal. Content
  // rows are already wrapped; chrome and the fold marker are cut here so a
  // complete context section is never ellipsized.
  const cut = (line: string): string => truncateToWidth(line, width, ELLIPSIS)
  return [
    ...chrome.map(cut),
    ...view.complete === true ? body : body.map(cut),
    cut(palette.dim(HINT)),
  ]
}

/**
 * The heading line. A tool title can run past any terminal, so the subject is
 * cut first and the off-screen mark stays whole: where the marked block went
 * must never be what the width hides.
 * @param view - the section to show.
 * @param palette - the palette the heading is styled with.
 * @param width - the width the line must fit; at least 1.
 * @returns the heading, with the mark when the block is not on screen.
 */
function heading(view: InspectorView, palette: Palette, width: number): string {
  const subject = palette.bold(palette.accent(view.heading))
  if (view.highlighted) return subject
  const suffix = palette.dim(OFF_SCREEN)
  return `${truncateToWidth(subject, Math.max(1, width - visibleWidth(suffix)), ELLIPSIS)}${suffix}`
}

/**
 * Draw the parts of the focused block as numbered choices that wrap rather
 * than disappearing past the width. `Left` / `Right` move along this list:
 * each label is `N name`, the held one is accented, and the arrows mark that
 * the walk stays inside this block.
 * @param parts - the labels in reading order, the held one marked.
 * @param palette - the palette the labels are styled with.
 * @param width - the width each line must fit; at least 1.
 * @returns the strip lines, every part present.
 */
function partsStrip(parts: readonly PartLabel[], palette: Palette, width: number): string[] {
  const tokens = parts.map((part, index) => {
    const text = `${String(index + 1)} ${part.label}`
    return part.focused ? palette.accent(text) : palette.dim(text)
  })
  const sep = palette.dim(SEPARATOR)
  const indent = palette.dim('  ')
  const end = palette.dim(STRIP_END)
  const indentWidth = visibleWidth('  ')
  const endWidth = visibleWidth(STRIP_END)
  const lines: string[] = []
  let current = palette.dim(STRIP_START)
  let used = visibleWidth(STRIP_START)
  const startLine = (): void => {
    lines.push(current)
    current = indent
    used = indentWidth
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    /* v8 ignore next -- the loop bound is tokens.length */
    if (token === undefined) continue
    const last = index === tokens.length - 1
    const extra = last ? endWidth : 0
    let leading = index === 0 || current === indent ? '' : sep
    let leadingWidth = leading === '' ? 0 : visibleWidth(SEPARATOR)
    const tokenWidth = visibleWidth(token)
    if (used + leadingWidth + tokenWidth + extra > width && used > indentWidth) {
      startLine()
      leading = ''
      leadingWidth = 0
    }
    const room = Math.max(1, width - used - extra)
    if (tokenWidth > room) {
      const wrapped = wrapTextWithAnsi(token, room)
      const first = wrapped[0]
      /* v8 ignore next -- wrapTextWithAnsi returns a line for nonempty text */
      if (first === undefined) continue
      current += leading + first
      used += leadingWidth + visibleWidth(first)
      for (const more of wrapped.slice(1)) {
        startLine()
        current += more
        used += visibleWidth(more)
      }
    } else {
      current += leading + token
      used += leadingWidth + tokenWidth
    }
  }
  lines.push(`${current}${end}`)
  return lines
}

/**
 * The inspector as a mounted component.
 *
 * The view is read once per render rather than pushed in, so a section that is
 * still streaming and a tool result that has just landed reach the screen with
 * the frame that draws them, without the application refreshing the pane.
 */
export class InspectorPane implements Component {
  /**
   * @param view - reads the section to draw; undefined draws nothing at all,
   * which is what an unmounted moment and a transcript with no cursor yield.
   * @param settings - the palette and the row budget; the width arrives per render.
   */
  constructor(
    private readonly view: () => InspectorView | undefined,
    private readonly settings: Omit<InspectorRender, 'width'>,
  ) {}

  invalidate(): void {}

  /**
   * Draw the focused section at `width`.
   * @param width - the total width the pane lays out in.
   * @returns the inspector's lines, or none when no section is focused.
   */
  render(width: number): string[] {
    const view = this.view()
    return view === undefined ? [] : renderInspector(view, { ...this.settings, width })
  }
}
