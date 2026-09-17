/**
 * The status bar under the editor: plain session facts become an ordered list
 * of segments, each with a stable id, the short label the bar draws, and what
 * `Enter` on it does — the rows the app prints, or the app's own navigable
 * page; a second function renders the segments as the footer's two lines, dim
 * while the editor holds focus and with the selected segment accented while
 * the bar does. Everything here is pure — no Context, no services, no
 * terminal, and no clock: elapsed values arrive already formatted.
 * @module @deepseek-ai/dsh-tui-app/footer
 */

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
  /** The key hints the unfocused second line carries. */
  hints: string
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

/** The keys the focused bar answers, replacing the usual hints. */
const FOCUS_HINTS = `← → select${SEPARATOR}Enter details${SEPARATOR}Esc back`

/** What the unfocused hints advertise as the way into the bar. */
const ENTRY_HINT = 'Shift+↑ status bar'

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
 * Build the status bar's segments in the order it draws them: model, effort,
 * permission, turn, usage, the projection facts, workspace, attachments. Only
 * the model and workspace segments are always present; every other segment
 * needs its fact.
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
  }]
  if (effort !== undefined) {
    segments.push({
      id: 'effort',
      label: `effort ${effort}`,
      detail: printed([`reasoning effort: ${effort}`, `Shift+Tab cycles it${SEPARATOR}/effort picks one`]),
    })
  }
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
 * Render the footer's two lines: the segment labels, then the key hints.
 * Unfocused the whole bar is dim and the hints advertise the entry key;
 * focused the selected segment is accented and the hints name the navigation
 * keys instead.
 * @param segments - the segments in bar order.
 * @param render - the palette, the selected index, and the unfocused hints.
 * @returns the footer text, two lines separated by a newline.
 */
export function renderFooter(segments: readonly FooterSegment[], render: FooterRender): string {
  const { palette, selected, hints } = render
  const labels = segments.map(segment => segment.label)
  if (selected === undefined) {
    return `${palette.dim(labels.join(SEPARATOR))}\n${palette.dim(`${hints}${SEPARATOR}${ENTRY_HINT}`)}`
  }
  const bar = labels
    .map((label, index) => index === selected ? palette.bold(palette.accent(label)) : palette.dim(label))
    .join(palette.dim(SEPARATOR))
  return `${bar}\n${palette.dim(FOCUS_HINTS)}`
}
