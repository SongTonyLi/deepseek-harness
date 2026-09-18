/**
 * The status bar under the editor: plain session facts become an ordered list
 * of segments, each with a stable id, the short label the bar draws, and what
 * `Enter` on it does — the rows the app prints, or the app's own navigable
 * page; a second function renders those segments as one unfocused line of key
 * facts, or as two focused lines whose first is a sliding window that always
 * includes the selected segment. Everything here is pure — no Context, no
 * services, no terminal, and no clock: elapsed values arrive already formatted,
 * and the terminal width arrives as an input so every line fits it.
 * @module @deepseek-ai/dsh-tui-app/footer
 */

import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import {
  contextLines,
  footerStatus,
  goalLines,
  permissionLines,
  planLines,
  usageLines,
  type StatusFacts,
  type StatusPart,
} from './status.ts'
import type { Palette } from './style.ts'
import { formatTimestamp } from './transcript.ts'

/** Stable id of one status-bar segment. */
export type FooterSegmentId = 'model' | 'effort' | 'permission' | 'turn' | 'usage' | StatusPart['id'] | 'workspace' | 'attachments'

/**
 * What `Enter` on a segment does. A segment either carries the rows the app
 * prints into the transcript, or declares that the app owns a navigable page
 * for that fact — the app opens the page and this module builds no rows for
 * it. The `todo` segment is the second kind: `/todos` and the bar open the
 * same list.
 */
export type FooterSegmentDetail =
  | { readonly kind: 'rows'; readonly rows: readonly string[] }
  | { readonly kind: 'page' }

/** One status-bar segment: what the bar draws and what opening it does. */
export interface FooterSegment {
  id: FooterSegmentId
  /** The short text the bar draws. */
  label: string
  /** What `Enter` on the segment does. */
  detail: FooterSegmentDetail
}

/** One attachment waiting for the next prompt, as the bar names it. */
export interface FooterAttachment {
  /** The file's base name. */
  name: string
  /** The content-block type the prompt carries it as. */
  kind: string
}

/** The turn the bound Agent is running, as the bar reports it. */
export interface FooterTurn {
  /** The turn number the durable `turn/start` carried. */
  number: number
  /** When the turn started: the `turn/start` envelope time. */
  startedAt: number
  /** Time since `startedAt`, already formatted against the app's clock. */
  elapsed: string
  /** Messages waiting for the next turn. */
  queuedNextTurn: number
  /** Messages waiting for the next step of this turn. */
  queuedNextStep: number
}

/** The plain facts the status bar is built from. */
export interface FooterInputs {
  /** The model selection the next request uses. */
  selection: ModelSelection
  /** The session's permission preset; absent when no permission service is composed. */
  permission?: string
  /** The terminal's own token totals, already formatted; empty when nothing was billed yet. */
  usage: string
  /** The facts one status read produced. */
  facts: StatusFacts
  /** The turn the bound Agent is running; absent between turns, which is when the bar drops the segment. */
  turn?: FooterTurn
  /** The workspace root, unshortened. */
  cwd: string
  /** The home directory the workspace label is shortened against; absent leaves the path alone. */
  home?: string
  /** The attachments the next prompt carries. */
  attachments: readonly FooterAttachment[]
}

/** How the bar is drawn. */
export interface FooterRender {
  /** The palette the labels and hints are styled with. */
  palette: Palette
  /** Index of the selected segment; absent while the editor keeps focus. */
  selected?: number
  /** Terminal columns the bar must fit; pi-tui refuses any wider line. */
  width: number
}

/** The segments and selection the status-bar component reads once per render. */
export interface FooterBarView {
  /** The segments in bar order. */
  segments: readonly FooterSegment[]
  /** Palette and selection; the width arrives per render. */
  render: Omit<FooterRender, 'width'>
}

/** The segment focus enters the bar on; `buildFooterSegments` always emits it first. */
export const FIRST_FOOTER_SEGMENT: FooterSegmentId = 'model'

/** What separates two segments, and two parts inside a hint line. */
const SEPARATOR = ' · '

/**
 * Longest workspace label the bar draws in full. A wider path keeps its last
 * two segments behind `…/` so one long project path cannot crowd out the
 * facts beside it. This is a presentation choice of this terminal surface,
 * not a deployment setting.
 */
const WORKSPACE_LABEL_WIDTH = 24

/** The last two segments of a path, with the separators that precede them. */
const PATH_TAIL = /[/\\][^/\\]+[/\\][^/\\]+$/u

/** The keys the focused bar answers, drawn on the expansion line. */
const FOCUS_HINTS = `← → select${SEPARATOR}↑ ↓ regions${SEPARATOR}Enter details${SEPARATOR}Esc back`

/** The one entry key the unfocused line keeps, trailing the facts. */
const ENTRY_HINT = 'Shift+↓'

/** What ends a line the width cut short; one column, so the mark itself fits. */
const ELLIPSIS = '…'

/** Facts the unfocused line keeps; every other present segment folds into `+N`. */
const KEY_SEGMENT_IDS: ReadonlySet<FooterSegmentId> = new Set(['model', 'effort', 'turn', 'context', 'workspace'])

/** The command that prints every projection section at once. */
const STATUS_COMMAND_ROW = '/status prints all of these sections'

/** Detail rows the app prints for a segment it does not open a page for. */
const OPENED_PAGE: FooterSegmentDetail = { kind: 'page' }

/**
 * What opening each projection-fact segment does: a section builder produces
 * the rows the app prints, and `OPENED_PAGE` names a fact the app has its own
 * navigable page for. The printed `/status` report still carries a todo
 * section; the bar hands the todo list to the app instead.
 */
const STATUS_SECTIONS: Record<StatusPart['id'], ((facts: StatusFacts) => string[]) | FooterSegmentDetail> = {
  context: contextLines,
  todo: OPENED_PAGE,
  goal: goalLines,
  plan: planLines,
}

/**
 * Detail rows as the segment carries them.
 * @param rows - the rows the app prints; never empty.
 * @returns the detail.
 */
function printed(rows: readonly string[]): FooterSegmentDetail {
  return { kind: 'rows', rows }
}

/**
 * The workspace label: a home-directory prefix becomes `~`, and a path still
 * wider than the bar allows keeps only its last two segments.
 * @param cwd - the workspace root.
 * @param home - the home directory to fold into `~`; absent leaves `cwd` alone.
 * @returns the label the bar draws.
 */
export function workspaceLabel(cwd: string, home: string | undefined): string {
  const folded = home !== undefined && home !== '' && startsWithDirectory(cwd, home)
    ? `~${cwd.slice(home.length)}`
    : cwd
  if (folded.length <= WORKSPACE_LABEL_WIDTH) return folded
  const tail = PATH_TAIL.exec(folded)
  return tail === null ? folded : `…${tail[0]}`
}

/**
 * Whether `path` is `directory` itself or lies under it.
 * @param path - the path to test.
 * @param directory - the candidate prefix, without a trailing separator.
 * @returns true when `path` starts at `directory`.
 */
function startsWithDirectory(path: string, directory: string): boolean {
  if (!path.startsWith(directory)) return false
  const next = path.charAt(directory.length)
  return next === '' || next === '/' || next === '\\'
}

/**
 * The effort segment: always present, labelled `effort default` when the
 * selection leaves reasoning effort to the model.
 * @param effort - the selection's reasoning effort; absent is the model's own default.
 * @returns the segment.
 */
function effortSegment(effort: ModelSelection['reasoningEffort']): FooterSegment {
  const unset = effort === undefined
  return {
    id: 'effort',
    label: unset ? 'effort default' : `effort ${effort}`,
    detail: printed([
      unset ? 'reasoning effort: the model\'s own default' : `reasoning effort: ${effort}`,
      `Shift+Tab cycles it${SEPARATOR}/effort picks one`,
    ]),
  }
}

/**
 * Build the status bar's segments in the order it draws them: model, effort,
 * permission, turn, usage, the projection facts, workspace, attachments. The
 * model, effort, and workspace segments are always present; every other
 * segment needs its fact.
 * @param inputs - the facts the app read for the bound session.
 * @returns the segments, the model segment first.
 */
export function buildFooterSegments(inputs: FooterInputs): FooterSegment[] {
  const { selection, facts, turn } = inputs
  const effort = selection.reasoningEffort
  const segments: FooterSegment[] = [{
    id: 'model',
    label: `${selection.provider}/${selection.model}`,
    detail: printed([
      `provider: ${selection.provider}`,
      `model: ${selection.model}`,
      effort === undefined ? 'reasoning effort: the model\'s own default' : `reasoning effort: ${effort}`,
      '/model picks the provider and model for the next request',
    ]),
  }, effortSegment(effort)]
  if (inputs.permission !== undefined) {
    const projected = permissionLines(facts)
    segments.push({
      id: 'permission',
      label: `permission ${inputs.permission}`,
      detail: printed([
        // The projection is the durable source; a profile without it still
        // knows the preset the permission service reports.
        ...projected.length === 0 ? [`permission: ${inputs.permission}`] : projected,
        '/permission <preset> changes the sandbox mode and the approval policy',
      ]),
    })
  }
  if (turn !== undefined) {
    segments.push({
      id: 'turn',
      label: `turn ${turn.elapsed}`,
      detail: printed([
        `turn ${String(turn.number)}`,
        `started: ${formatTimestamp(turn.startedAt)}`,
        `elapsed: ${turn.elapsed}`,
        `queued: ${String(turn.queuedNextTurn)} for the next turn${SEPARATOR}${String(turn.queuedNextStep)} for the next step`,
      ]),
    })
  }
  if (inputs.usage !== '') {
    segments.push({
      id: 'usage',
      label: inputs.usage,
      detail: printed([`this terminal: ${inputs.usage}`, ...usageLines(facts), STATUS_COMMAND_ROW]),
    })
  }
  for (const part of footerStatus(facts)) {
    const section = STATUS_SECTIONS[part.id]
    segments.push({
      id: part.id,
      label: part.label,
      detail: typeof section === 'function' ? printed([...section(facts), STATUS_COMMAND_ROW]) : section,
    })
  }
  segments.push({
    id: 'workspace',
    label: workspaceLabel(inputs.cwd, inputs.home),
    detail: printed([`workspace: ${inputs.cwd}`]),
  })
  if (inputs.attachments.length > 0) {
    segments.push({
      id: 'attachments',
      label: `${String(inputs.attachments.length)} attached`,
      detail: printed([
        ...inputs.attachments.map(attachment => `${attachment.kind}: ${attachment.name}`),
        `/attach <path> adds one${SEPARATOR}/attach clear drops them all`,
      ]),
    })
  }
  return segments
}

/**
 * Where the bar draws its selection.
 * @param segments - the segments in bar order.
 * @param selected - the segment id the bar holds.
 * @returns that segment's index, or 0 once the fact behind it is gone.
 */
export function footerSelectionIndex(segments: readonly FooterSegment[], selected: FooterSegmentId): number {
  const index = segments.findIndex(segment => segment.id === selected)
  return index === -1 ? 0 : index
}

/**
 * Inclusive span of `widths` that contains `selected` and fits `budget`.
 * @param widths - visible width of each part, in order.
 * @param selected - the index that must stay in the span.
 * @param budget - maximum visible width of the joined span.
 * @param sep - visible width of the separator between two parts.
 * @returns start and end indices, inclusive.
 */
function windowSpan(
  widths: readonly number[],
  selected: number,
  budget: number,
  sep: number,
): { start: number; end: number } {
  let start = selected
  let end = selected
  let used = widths[selected] as number
  if (used >= budget) return { start, end }
  while (end + 1 < widths.length) {
    const next = used + sep + (widths[end + 1] as number)
    if (next > budget) break
    end += 1
    used = next
  }
  while (start > 0) {
    const next = used + sep + (widths[start - 1] as number)
    if (next > budget) break
    start -= 1
    used = next
  }
  return { start, end }
}

/**
 * Cut `line` to `width` columns.
 * @param line - the already-styled line.
 * @param width - terminal columns the line must fit; at least 1.
 * @returns the line, ellipsized when it was wider.
 */
function fitLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), ELLIPSIS)
}

/**
 * The unfocused line: key facts, a `+N` token for the rest, and the entry key.
 * @param segments - the segments in bar order.
 * @param palette - the palette the line is dimmed with.
 * @param width - terminal columns the line must fit.
 * @returns one dim line.
 */
function unfocusedLine(segments: readonly FooterSegment[], palette: Palette, width: number): string {
  const key = segments.filter(segment => KEY_SEGMENT_IDS.has(segment.id)).map(segment => segment.label)
  const folded = segments.length - key.length
  if (folded > 0) key.push(`+${String(folded)}`)
  key.push(ENTRY_HINT)
  return fitLine(palette.dim(key.join(SEPARATOR)), width)
}

/**
 * The first detail row of a printed segment, or the label of a page segment.
 * @param segment - the selected segment; absent when the bar has none.
 * @returns the expansion body.
 */
function expansionBody(segment: FooterSegment | undefined): string {
  if (segment === undefined) return ''
  if (segment.detail.kind === 'page') return segment.label
  return segment.detail.rows[0] as string
}

/**
 * The focused second line: the selected segment's summary plus the navigation keys.
 * @param segment - the selected segment.
 * @param palette - the palette the line is dimmed with.
 * @param width - terminal columns the line must fit.
 * @returns one dim line that keeps the hints when they fit.
 */
function expansionLine(segment: FooterSegment | undefined, palette: Palette, width: number): string {
  const body = expansionBody(segment)
  const suffix = palette.dim(body === '' ? FOCUS_HINTS : `${SEPARATOR}${FOCUS_HINTS}`)
  const prefix = palette.dim(body)
  const rest = width - visibleWidth(suffix)
  if (rest < 1) return fitLine(`${prefix}${suffix}`, width)
  return `${truncateToWidth(prefix, rest, ELLIPSIS)}${suffix}`
}

/**
 * The focused bar: a sliding window of segment labels, then the expansion line.
 * @param segments - the segments in bar order.
 * @param selected - index of the held segment.
 * @param palette - the palette the labels and hints are styled with.
 * @param width - terminal columns each line must fit.
 * @returns two lines, the selected label always in the first.
 */
function focusedLines(
  segments: readonly FooterSegment[],
  selected: number,
  palette: Palette,
  width: number,
): string[] {
  const held = Math.min(Math.max(0, selected), Math.max(0, segments.length - 1))
  const styled = segments.map((segment, index) =>
    index === held ? palette.bold(palette.accent(segment.label)) : palette.dim(segment.label))
  const sep = palette.dim(SEPARATOR)
  const { start, end } = windowSpan(styled.map(visibleWidth), held, width, visibleWidth(sep))
  const bar = styled.slice(start, end + 1).join(sep)
  return [fitLine(bar, width), expansionLine(segments[held], palette, width)]
}

/**
 * Render the footer. Unfocused it is one dim line of key facts with a trailing
 * `Shift+↓`; focused it is the navigable segments (windowed to `width` so the
 * selected one is never dropped) and an expansion of that segment plus the
 * navigation keys. Every returned line fits `width`.
 * @param segments - the segments in bar order.
 * @param render - the palette, optional selected index, and terminal width.
 * @returns the footer lines, one when unfocused and two when focused.
 */
export function renderFooter(segments: readonly FooterSegment[], render: FooterRender): string[] {
  const width = Math.max(1, render.width)
  if (render.selected === undefined) return [unfocusedLine(segments, render.palette, width)]
  return focusedLines(segments, render.selected, render.palette, width)
}

/**
 * The status bar as a mounted component. The view is read once per render
 * rather than pushed in, so the terminal width of that frame windows and
 * truncates the lines.
 */
export class FooterBar implements Component {
  /**
   * @param view - reads the segments and selection the bar draws.
   */
  constructor(private readonly view: () => FooterBarView) {}

  invalidate(): void {}

  /**
   * Draw the status bar at `width`.
   * @param width - the total width the bar lays out in.
   * @returns the footer lines, each no wider than `width`.
   */
  render(width: number): string[] {
    const { segments, render } = this.view()
    return renderFooter(segments, { ...render, width })
  }
}
