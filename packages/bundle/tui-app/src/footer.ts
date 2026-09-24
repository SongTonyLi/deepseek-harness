/**
 * The status bar under the editor: plain session facts become an ordered list
 * of segments, each with a stable id, the short label the bar draws, and what
 * `Enter` on it does — the rows the app prints, or the app's own navigable
 * page with the one-line summary the focused bar expands; a second function
 * renders those segments as one unfocused line whose two ends are reserved
 * for the model and the entry keys, or as two focused lines whose first is
 * that same anchored model plus a sliding window around the selected
 * segment. Everything here is pure — no Context, no
 * services, no terminal, and no clock: elapsed values arrive already formatted,
 * and the terminal width arrives as an input so every line fits it.
 * @module @deepseek-ai/dsh-tui-app/footer
 */

import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { fitLegend } from './frame.ts'
import { HINTS, entryHints } from './keys.ts'
import { pulse, type MotionLevel } from './motion.ts'
import {
  contextLines,
  footerStatus,
  goalLines,
  permissionLines,
  planLines,
  todoSummary,
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
 * same list, and the focused bar expands the counts and the item being worked
 * on.
 */
export type FooterSegmentDetail =
  | { readonly kind: 'rows'; readonly rows: readonly string[] }
  | { readonly kind: 'page'; readonly summary: string }

/** One status-bar segment: what the bar draws and what opening it does. */
export interface FooterSegment {
  id: FooterSegmentId
  /** The short text the bar draws. */
  label: string
  /**
   * What the bar draws instead once {@link FooterSegment.label} outgrows its
   * budget; absent leaves the label to be ellipsized. The model segment
   * carries the bare model name, so the bar drops the provider rather than the
   * end of the model's own name.
   */
  short?: string
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
  /**
   * How far above its settled drawing the selected label is lifted right now,
   * which is what makes a walk along the bar visible; omitted and `0` both
   * draw the settled label. The lift never changes the line count.
   */
  level?: MotionLevel
  /** Terminal columns the bar must fit; pi-tui refuses any wider line. */
  width: number
  /**
   * True while the follow-ups list is drawn above the editor, so Shift+↑
   * selects a waiting prompt instead of reading the conversation.
   */
  queue?: boolean
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

/**
 * Longest model label the bar draws in full. A wider `provider/model` pair
 * falls back to the bare model name and only then is ellipsized, so the fact
 * the next request depends on is never the one the width eats. A presentation
 * choice of this terminal surface, not a deployment setting.
 */
const MODEL_LABEL_WIDTH = 20

/** Narrowest line that still names an entry key; below it the facts take the whole width. */
const HINT_MIN_WIDTH = 40

/** The most of the line one entry hint takes, as a divisor: a third, so the facts keep the rest. */
const HINT_WIDTH_SHARE = 3

/** Columns kept clear between the last fact and the entry hint, so they never read as one list. */
const HINT_GAP = 2

/** What marks that the focused window starts after the segment next to the anchor. */
const WINDOW_START = '‹'

/** What marks that the focused window ends before the last segment. */
const WINDOW_END = '›'

/** Columns the closing window mark takes, the space before it included. */
const WINDOW_MARK_WIDTH = 2

/** Columns the brackets around the selected label take. */
const BRACKET_WIDTH = 2

/** What ends a line the width cut short; one column, so the mark itself fits. */
const ELLIPSIS = '…'

/** Facts the unfocused line keeps; every other present segment folds into `+N`. */
const KEY_SEGMENT_IDS: ReadonlySet<FooterSegmentId> = new Set(['model', 'effort', 'turn', 'context', 'todo', 'workspace'])

/** The command that prints every projection section at once. */
const STATUS_COMMAND_ROW = '/status prints all of these sections'

/**
 * What opening each projection-fact segment does: a section builder produces
 * the rows the app prints. The `todo` segment is a page instead: the bar
 * expands its counts on line 2 and the app opens the same list `/todos` opens.
 */
const STATUS_SECTIONS: Record<Exclude<StatusPart['id'], 'todo'>, (facts: StatusFacts) => string[]> = {
  context: contextLines,
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
 * A segment the app opens as a page, with the one-line summary the bar expands.
 * @param summary - the expansion the focused bar draws.
 * @returns the detail.
 */
function openedPage(summary: string): FooterSegmentDetail {
  return { kind: 'page', summary }
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
      'Shift+Tab or /effort opens the effort list',
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
    short: selection.model,
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
        '/permission opens the permission list',
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
    if (part.id === 'todo') {
      segments.push({ id: 'todo', label: part.label, detail: openedPage(todoSummary(facts)) })
      continue
    }
    const section = STATUS_SECTIONS[part.id]
    segments.push({
      id: part.id,
      label: part.label,
      detail: printed([...section(facts), STATUS_COMMAND_ROW]),
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
 * The label the bar draws for the segment it anchors on, which
 * `buildFooterSegments` always emits first: the full one while it fits its
 * budget, then the segment's own shorter form, and only then an ellipsis.
 * @param segment - the anchored segment; absent for an empty bar.
 * @returns the label, never wider than {@link MODEL_LABEL_WIDTH}.
 */
function anchorLabel(segment: FooterSegment | undefined): string {
  if (segment === undefined) return ''
  if (visibleWidth(segment.label) <= MODEL_LABEL_WIDTH) return segment.label
  return truncateToWidth(segment.short ?? segment.label, MODEL_LABEL_WIDTH, ELLIPSIS)
}

/**
 * The entry keys this width names.
 * @param width - terminal columns the line must fit.
 * @param queue - whether follow-ups are drawn, which rewrites Shift+↑.
 * @returns the widest step that keeps the facts the majority of the line, and
 * the empty string on a terminal too narrow to spare the columns.
 */
function entryHint(width: number, queue: boolean): string {
  if (width < HINT_MIN_WIDTH) return ''
  return fitLegend(entryHints({ queue }), Math.floor(width / HINT_WIDTH_SHARE))
}

/**
 * The key facts that fit the middle of the unfocused line.
 * @param facts - the key labels after the anchor, in bar order.
 * @param hidden - segments the bar folds away whatever the width, because
 * they are not among its key facts.
 * @param room - columns the middle has, the anchor and the hint already taken.
 * @returns the labels to draw, the `+N` token last when anything is folded.
 */
function middleFacts(facts: readonly string[], hidden: number, room: number): string[] {
  const drawn: string[] = []
  let used = 0
  for (const label of facts) {
    const cost = visibleWidth(SEPARATOR) + visibleWidth(label)
    if (used + cost > room) break
    used += cost
    drawn.push(label)
  }
  let folded = hidden + facts.length - drawn.length
  if (folded === 0) return drawn
  const token = (): string => `+${String(folded)}`
  const fits = (): boolean => used + visibleWidth(SEPARATOR) + visibleWidth(token()) <= room
  // The count itself is a fact: a drawn label gives way so the line can say
  // how much it is not showing.
  while (!fits() && drawn.length > 0) {
    used -= visibleWidth(SEPARATOR) + visibleWidth(drawn.pop() as string)
    folded += 1
  }
  if (fits()) drawn.push(token())
  return drawn
}

/**
 * The unfocused line, built from both ends inward: the anchored model label,
 * the entry keys reserved at the right edge, and the key facts filling
 * whatever middle is left, every segment they cannot hold folded into `+N`.
 * @param segments - the segments in bar order.
 * @param palette - the palette that distinguishes the model, live facts, and entry keys.
 * @param width - terminal columns the line must fit.
 * @param queue - whether follow-ups are drawn, which rewrites Shift+↑.
 * @returns one line with colored key facts and dim secondary facts.
 */
function unfocusedLine(segments: readonly FooterSegment[], palette: Palette, width: number, queue: boolean): string {
  const [anchor, ...rest] = segments
  const model = anchorLabel(anchor)
  const hint = entryHint(width, queue)
  const reserved = hint === '' ? 0 : visibleWidth(hint) + HINT_GAP
  const facts = rest.filter(segment => KEY_SEGMENT_IDS.has(segment.id)).map((segment) => {
    if (segment.id === 'turn') return palette.warning(segment.label)
    if (segment.id === 'context') return palette.link(segment.label)
    if (segment.id === 'todo') return palette.success(segment.label)
    return palette.dim(segment.label)
  })
  const drawn = middleFacts(facts, rest.length - facts.length, width - visibleWidth(model) - reserved)
  const left = [model === '' ? '' : palette.accent(model), ...drawn]
    .filter(token => token !== '').join(palette.dim(SEPARATOR))
  if (hint === '') return fitLine(left, width)
  const padding = ' '.repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(hint)))
  return fitLine(`${left}${padding}${palette.link(hint)}`, width)
}

/**
 * The first detail row of a printed segment, or the summary of a page segment.
 * @param segment - the selected segment; absent when the bar has none.
 * @returns the expansion body.
 */
function expansionBody(segment: FooterSegment | undefined): string {
  if (segment === undefined) return ''
  if (segment.detail.kind === 'page') return segment.detail.summary
  return segment.detail.rows[0] as string
}

/**
 * The focused second line: the selected segment's summary plus the keys the
 * bar answers. The legend takes the width's own step before the summary is
 * measured, so a narrow terminal drops legend words instead of cutting the
 * way back to the input off the end of the line.
 * @param segment - the selected segment.
 * @param palette - the palette the line is dimmed with.
 * @param width - terminal columns the line must fit.
 * @returns one dim line.
 */
function expansionLine(segment: FooterSegment | undefined, palette: Palette, width: number): string {
  const body = expansionBody(segment)
  const legend = fitLegend(HINTS.bar, width)
  const suffix = palette.dim(body === '' ? legend : `${SEPARATOR}${legend}`)
  const prefix = palette.dim(body)
  const rest = width - visibleWidth(suffix)
  if (rest < 1) return fitLine(`${prefix}${suffix}`, width)
  return `${truncateToWidth(prefix, rest, ELLIPSIS)}${suffix}`
}

/**
 * One segment label as the focused bar draws it. The selected one is
 * bracketed as well as accented, so which segment `Enter` opens is legible
 * without color, and a walk that just reached it draws it lifted until the
 * motion settles back onto the accent.
 * @param text - the label.
 * @param selected - whether the bar holds this segment.
 * @param palette - the palette the label is styled with.
 * @param level - how far above the settled label to lift it.
 * @returns the styled label.
 */
function segmentLabel(text: string, selected: boolean, palette: Palette, level: MotionLevel): string {
  return selected ? pulse(palette, palette.accent(`[${text}]`), level) : palette.dim(text)
}

/**
 * The text a selected label keeps where the window cannot hold all of it. The
 * brackets are what says which segment `Enter` opens on a terminal without
 * color, so the label's own text is what gives way rather than the bracket
 * that closes it.
 * @param text - the label.
 * @param room - columns the bracketed label may take.
 * @returns the text, cut so that it and both brackets fit `room`.
 */
function fitSelected(text: string, room: number): string {
  const inside = room - BRACKET_WIDTH
  if (visibleWidth(text) <= inside) return text
  return truncateToWidth(text, Math.max(1, inside), ELLIPSIS)
}

/**
 * The segments after the anchor, windowed around the selection. `‹` and `›`
 * mark the side the window is cut on, so a walk that slid past a fact says so
 * rather than appearing to have lost it.
 * @param rest - the segments after the anchored one, in bar order.
 * @param held - index of the selected segment within them; negative while the
 * anchor itself is selected, which draws no selection here.
 * @param palette - the palette the labels and marks are styled with.
 * @param room - columns left after the anchor.
 * @param level - how far above its settled drawing the selected label is lifted.
 * @returns the window, opening with its connector, or the empty string when
 * the bar draws nothing but its anchor.
 */
function focusedWindow(rest: readonly FooterSegment[], held: number, palette: Palette, room: number, level: MotionLevel): string {
  if (rest.length === 0) return ''
  const sep = palette.dim(SEPARATOR)
  const sepWidth = visibleWidth(SEPARATOR)
  const selected = Math.max(0, held)
  // The connector takes the separator's own columns, whether it reads as one
  // or as the mark of a window that starts further along.
  const budget = room - sepWidth
  // The end mark takes its columns before the selected label is measured, so
  // a window narrow enough to cut that label cuts it inside its brackets
  // rather than losing the bracket to the mark.
  const cap = budget - (selected < rest.length - 1 ? WINDOW_MARK_WIDTH : 0)
  const styled = rest.map((segment, index) =>
    segmentLabel(index === held ? fitSelected(segment.label, cap) : segment.label, index === held, palette, level))
  const widths = styled.map(visibleWidth)
  const last = rest.length - 1
  const opened = windowSpan(widths, selected, budget, sepWidth)
  const span = opened.end < last ? windowSpan(widths, selected, budget - WINDOW_MARK_WIDTH, sepWidth) : opened
  const lead = span.start > 0 ? palette.dim(` ${WINDOW_START} `) : sep
  const trail = span.end < last ? palette.dim(` ${WINDOW_END}`) : ''
  return `${lead}${styled.slice(span.start, span.end + 1).join(sep)}${trail}`
}

/**
 * The focused bar: the anchored model label, a sliding window of the segments
 * after it, then the expansion line.
 * @param segments - the segments in bar order.
 * @param selected - index of the held segment.
 * @param palette - the palette the labels and hints are styled with.
 * @param width - terminal columns each line must fit.
 * @param level - how far above its settled drawing the selected label is lifted.
 * @returns two lines, the anchor and the selected label always in the first.
 */
function focusedLines(
  segments: readonly FooterSegment[],
  selected: number,
  palette: Palette,
  width: number,
  level: MotionLevel,
): string[] {
  const held = Math.min(Math.max(0, selected), Math.max(0, segments.length - 1))
  const [anchor, ...rest] = segments
  const model = anchor === undefined ? '' : segmentLabel(anchorLabel(anchor), held === 0, palette, level)
  const windowed = focusedWindow(rest, held - 1, palette, width - visibleWidth(model), level)
  return [fitLine(`${model}${windowed}`, width), expansionLine(segments[held], palette, width)]
}

/**
 * Render the footer. Unfocused it is one dim line built from both ends: the
 * model anchored left, the entry keys anchored right, and the key facts in
 * between. Focused it is the anchored model, the navigable segments (windowed
 * to `width` so the selected one is never dropped) and an expansion of that
 * segment plus the navigation keys. Every returned line fits `width`.
 * @param segments - the segments in bar order.
 * @param render - the palette, optional selected index, and terminal width.
 * @returns the footer lines, one when unfocused and two when focused.
 */
export function renderFooter(segments: readonly FooterSegment[], render: FooterRender): string[] {
  const width = Math.max(1, render.width)
  if (render.selected === undefined) return [unfocusedLine(segments, render.palette, width, render.queue === true)]
  return focusedLines(segments, render.selected, render.palette, width, render.level ?? 0)
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
