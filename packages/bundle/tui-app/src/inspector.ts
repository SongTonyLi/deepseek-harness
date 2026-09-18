/**
 * The docked inspector above the editor: while the keyboard walks the
 * transcript it shows the focused section in full - what it is, which part of
 * its block is held, and the start of that part's own rows.
 *
 * It is the focus indicator that is always on screen. A block is also marked
 * in place, but only while the renderer can still repaint its first line
 * (`./navigation.ts`), so the heading says when the marked block itself has
 * scrolled out of reach. Rows arrive as the block's source text with no fade
 * and no palette styling of their own, so a section that is still streaming
 * grows here as it arrives.
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

/** Brackets the parts strip, so the strip reads as one row of choices. */
const STRIP_ENDS = ['‹ ', ' ›'] as const

/** What the heading appends while the focused block lies outside the repaint window. */
const OFF_SCREEN = ' · off screen'

/** The keys the inspector answers, drawn dim under its rows. */
const HINT = '↑ ↓ blocks · ← → parts · Enter page · Esc back'

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
 * the heading, the parts strip when the block has more than one part, the
 * folded rows, and the hints.
 */
export function renderInspector(view: InspectorView, render: InspectorRender): string[] {
  const { palette } = render
  const width = Math.max(1, render.width)
  const lines = ['', heading(view, palette, width)]
  // One part is its own block: the strip would offer nothing to move to.
  if (view.parts.length > 1) lines.push(partsStrip(view.parts, palette))
  const wrapped = view.rows.flatMap(row => wrapTextWithAnsi(row, width))
  lines.push(...foldRows(wrapped, render.previewLines, hidden =>
    palette.dim(`… ${String(hidden)} more row${hidden === 1 ? '' : 's'} · Enter opens the page`)))
  lines.push(palette.dim(HINT))
  // pi-tui refuses a frame holding a line wider than the terminal. The rows
  // are wrapped above; every line the inspector composes itself is cut here.
  return lines.map(line => truncateToWidth(line, width, ELLIPSIS))
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
 * Draw the parts of the focused block as one row of choices.
 * @param parts - the labels in reading order, the held one marked.
 * @param palette - the palette the labels are styled with.
 * @returns the strip line.
 */
function partsStrip(parts: readonly PartLabel[], palette: Palette): string {
  const labels = parts
    .map(part => part.focused ? palette.accent(part.label) : palette.dim(part.label))
    .join(palette.dim(SEPARATOR))
  return `${palette.dim(STRIP_ENDS[0])}${labels}${palette.dim(STRIP_ENDS[1])}`
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
