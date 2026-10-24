/**
 * The team room: one alternate-screen page that shows every member of the
 * Agent Team with the role it plays and what it is doing now, the shared task
 * board, and the exchanges the bound session logged.
 *
 * The application supplies the reads on every key and frame: the roster and
 * the tasks from the Agent Teams service, the exchanges from the bound
 * session's log, and what each child last narrated. `Enter` hands the
 * selected teammate's session back to the application, which opens it the
 * way `/team` does. Pure aside from the key state of {@link TeamPlay}.
 * @module @deepseek-ai/dsh-tui-app/team-play
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { SubagentChoice } from './catalog.ts'
import { fitLegend } from './frame.ts'
import { paintKeys } from './key-chips.ts'
import type { Palette } from './style.ts'
import { memberRoleText, teamBrowseRows, type TeamBrowseRow } from './team.ts'
import type { TeamMemberRow, TeamTaskRow } from './team-panel.ts'

/**
 * The page's legend in declared degradation steps, widest first. The page
 * is not a focus region, so it names its keys here the way the reader does.
 */
export const TEAM_PLAY_HINTS: readonly [string, ...string[]] = [
  '↑↓ member · Enter opens · f filters messages · PgUp PgDn scroll · Esc q closes',
  '↑↓ member · Enter opens · f filters · PgUp PgDn scroll · Esc closes',
  '↑↓ member · Enter opens · f filters · Esc closes',
  '↑↓ · Enter · f · Esc closes',
  'Esc q closes',
]

/** Drawn under the lead while the team has no teammate. */
export const TEAM_PLAY_EMPTY_HINT =
  'No teammates yet — ask for work that splits into independent parts and the lead will delegate it.'

/**
 * Member rows drawn before the rest fold into one `+<n> more` row. A
 * presentation choice of this terminal surface, not a deployment setting.
 */
export const TEAM_PLAY_MAX_MEMBERS = 8

/**
 * Task rows drawn before the rest fold into one `+<n> more` row. A
 * presentation choice of this terminal surface, not a deployment setting.
 */
export const TEAM_PLAY_MAX_TASKS = 8

/** Rows above the first section: the heading, then the legend or a notice. */
const HEADER_ROWS = 2

/** The `Members`, `Tasks`, and `Messages` title rows. */
const SECTION_TITLES = 3

/** Rows the exchanges keep while members and tasks share what is left. */
const MIN_MESSAGE_ROWS = 3

/** Lines the empty-team hint wraps to at most. */
const HINT_MAX_LINES = 3

/** Columns a member name keeps at most. */
const NAME_MAX_COLUMNS = 16

/** Columns a member name keeps at least, so short names still line the roles up. */
const NAME_MIN_COLUMNS = 4

/** Share of the row beyond the name that a role may take. */
const ROLE_SHARE = 0.4

/** Columns an owner name keeps at most in a task row. */
const OWNER_MAX_COLUMNS = 16

/** Columns a task row spends beside the id, the subject, and the owner: the indent, the glyph, and the spaces around it. */
const TASK_LEAD_COLUMNS = 5

/** Columns a task subject keeps however narrow the row is. */
const MIN_SUBJECT_COLUMNS = 8

/** What a task without an owner names as its owner. */
const UNOWNED = 'unowned'

/** What a session id that the roster does not list is called in a message row. */
const UNKNOWN_MEMBER = 'teammate'

/** The text of a peer message that has no text block. */
const NON_TEXT_MESSAGE = '(non-text message)'

/** Fields of a `team/` record that hold an id, which no row uses as its text. */
const IDENTIFIER_FIELDS: ReadonlySet<string> = new Set(['id', 'teamId', 'messageId', 'senderId', 'targetId', 'ownerId'])

/** The marker, its space, the status glyph, and its space. */
const MEMBER_LEAD_COLUMNS = 4

/** Columns between two cells of one row. */
const GAP = '  '

/** Glyph of each member status; a running member animates instead while motion is on. */
const MEMBER_GLYPH: Record<TeamMemberRow['status'], string> = {
  running: '●',
  inactive: '○',
  provisioning: '◌',
  failed: '✗',
}

/** Glyph of each task status; a deleted task is never drawn. */
const TASK_GLYPH: Record<TeamTaskRow['status'], string> = {
  pending: '○',
  in_progress: '◐',
  completed: '✓',
  deleted: '✗',
}

/** One exchange the page lists. */
export interface TeamBeat {
  /** Who starts the exchange. */
  readonly from: string
  /** Who receives it. */
  readonly to: string
  /** What kind of exchange it is. */
  readonly kind: 'spawn' | 'message' | 'task'
  /** The short text of the exchange. */
  readonly text: string
}

/** One log event reduced to the fields the exchange reader understands. */
export interface TeamLogEvent {
  /** The session event type. */
  type: string
  /** The session event data. */
  data: unknown
}

/** What the page reads from the application, re-read on every key and frame. */
export interface TeamRoomSource {
  /** Roster rows, the lead first. Empty when the roster cannot be read. */
  readonly members: readonly TeamMemberRow[]
  /** Shared tasks, deleted rows included; the page drops those. */
  readonly tasks: readonly TeamTaskRow[]
  /** The bound session's exchanges, oldest first. */
  readonly beats: readonly TeamBeat[]
  /**
   * What a child last narrated.
   * @param id - the member's session id.
   * @returns the narration, or undefined when the child has said nothing.
   */
  note(id: string): string | undefined
  /**
   * The spinner frame of one running member.
   * @param slot - the member's row, so the application can stagger phases.
   * @returns the glyph, or undefined where motion is reduced and the row draws a static glyph.
   */
  spinner(slot: number): string | undefined
}

/** How one frame of the room is drawn. */
export interface TeamRoomDraw {
  /** The palette the frame is styled with. */
  palette: Palette
  /** The roster, tasks, and exchanges to draw. */
  source: TeamRoomSource
  /** The selected member's session id; the first member when absent or unknown. */
  selected: string | undefined
  /** Whether the exchanges are narrowed to those involving the selected member. */
  filtered: boolean
  /** How many exchanges the list is scrolled up from the newest. */
  back: number
  /** One line that replaces the legend, such as why `Enter` opened nothing. */
  notice: string | undefined
  /** Columns the frame fits. */
  width: number
  /** Rows the frame fills. */
  rows: number
}

/** One drawn frame and what the next key needs to know about it. */
export interface TeamRoomFrame {
  /** Exactly `rows` lines, each fitting the width. */
  lines: string[]
  /** The scroll offset after clamping to the exchanges the frame has. */
  back: number
  /** Exchanges a page key scrolls. */
  page: number
  /** Whether a running member drew a spinner frame, so the next frame differs on the next tick. */
  animated: boolean
}

/** What a key asks the application to do. */
export type TeamRoomAction =
  /** Leave the page and give the conversation its screen back. */
  | { readonly kind: 'close' }
  /** Leave the page and open this teammate's session, as `/team` does. */
  | { readonly kind: 'open'; readonly entry: TeamBrowseRow; readonly choice: SubagentChoice }

/**
 * Exchanges recorded in one session log.
 *
 * A tool call is listed when its name is in `toolNames`, the names the Agent
 * Teams plugin currently scopes onto this agent, or when `toolNames` is
 * omitted and the arguments name a person or a task. Malformed tool arguments
 * still name the tool when it is in `toolNames`. A user message is listed
 * when its source is `agent-message` or its text begins `Team message from`.
 *
 * The Team Lead's `team/` records are authoritative, so they replace the rows
 * the same exchange would add from tool calls and received messages:
 * - `team/message/queued` is one message from its sender to its target; its
 *   text blocks, whitespace collapsed, are the text. While the log has one,
 *   `message` rows from tool calls and user messages are dropped.
 *   `team/message/delivered` is a receipt and adds no row.
 * - `team/member` adds one spawn row per member, from its first record, unless
 *   a spawn tool call for that name already did. A `failed` phase or an `error`
 *   adds `<member> → <speaker>` with `failed: <error>`. Later phases add nothing.
 * - `team/task` adds one row per revision that changes the status or the owner,
 *   captioned `<status> <subject>` to `board` from the owner, else from `speaker`.
 *   Identical consecutive task records collapse. While the log has one,
 *   `task` rows from tool calls are dropped.
 * - Any other `team/` type, including types a later plugin release adds, is
 *   listed with the first string field that does not hold an id.
 *
 * A teammate's own log has no `team/` records, so its tool calls and received
 * messages are all listed.
 * @param events - the log events, oldest first.
 * @param speaker - the name of the session that logged the events.
 * @param toolNames - tool names scoped by the plugin. Omitted reads exchanges from call arguments.
 * @param names - member names by session id. An id missing from it reads `teammate`.
 * @returns the exchanges in log order.
 */
export function beatsFromEvents(
  events: readonly TeamLogEvent[],
  speaker: string,
  toolNames?: ReadonlySet<string>,
  names: ReadonlyMap<string, string> = new Map(),
): TeamBeat[] {
  const calls = events.map(event => event.type === 'tool/call' ? beatFromCall(event.data, speaker, toolNames) : undefined)
  const spawnCalls = new Set<string>()
  for (const call of calls) {
    if (call?.kind === 'spawn') spawnCalls.add(call.to)
  }
  const reading: Reading = {
    speaker,
    names,
    spawnCalls,
    peersRecorded: events.some(event => event.type === 'team/message/queued'),
    tasksRecorded: events.some(event => event.type === 'team/task'),
    members: new Set(),
    taskStages: new Map(),
  }
  const beats: TeamBeat[] = []
  for (const [index, event] of events.entries()) {
    for (const beat of beatsFromEvent(event, calls[index], reading)) {
      if (event.type === 'team/task' && sameRow(beats.at(-1), beat)) continue
      beats.push(beat)
    }
  }
  return beats
}

/**
 * Draw the team room.
 *
 * Rows go to the heading and the legend first. Members and tasks keep what
 * they need up to {@link TEAM_PLAY_MAX_MEMBERS} and {@link TEAM_PLAY_MAX_TASKS}
 * rows, giving way to the exchanges, which keep at least a few rows and take
 * everything that is left. A section cut short ends in `+<n> more`; the
 * member list scrolls to keep the selected member in view.
 * @param draw - the reads, the key state, and the screen size.
 * @returns the lines, the clamped scroll offset, and the page size.
 */
export function teamRoomFrame(draw: TeamRoomDraw): TeamRoomFrame {
  const width = Math.max(draw.width, 1)
  const rows = Math.max(draw.rows, 1)
  const { palette, source } = draw
  const fit = (line: string): string => truncateToWidth(line, width, '…')
  const tasks = source.tasks.filter(task => task.status !== 'deleted')
  const selectedIndex = Math.max(source.members.findIndex(member => member.id === draw.selected), 0)
  const selected = source.members[selectedIndex]
  const hint = source.members.some(member => member.role === 'teammate')
    ? []
    : wrapTextWithAnsi(TEAM_PLAY_EMPTY_HINT, Math.max(width - 2, 1)).slice(0, HINT_MAX_LINES)
  const body = Math.max(rows - HEADER_ROWS, 0)
  const room = body - SECTION_TITLES - MIN_MESSAGE_ROWS - hint.length
  const wantedMembers = Math.min(source.members.length, TEAM_PLAY_MAX_MEMBERS)
  const wantedTasks = Math.min(Math.max(tasks.length, 1), TEAM_PLAY_MAX_TASKS)
  const taskRows = clamp(room - wantedMembers, Math.min(wantedTasks, 2), wantedTasks)
  const memberRows = clamp(room - taskRows, Math.min(wantedMembers, 2), wantedMembers)
  const members = memberLines(draw, source.members, selectedIndex, memberRows)
  const lines = [
    fit(heading(palette, source.members, tasks)),
    fit(draw.notice === undefined ? paintKeys(palette, fitLegend(TEAM_PLAY_HINTS, width)) : palette.warning(draw.notice)),
    fit(palette.heading('Members')),
    ...members.lines.map(fit),
    ...hint.map(line => fit(palette.dim(`  ${line}`))),
    fit(palette.heading('Tasks')),
    ...taskLines(palette, tasks, taskRows, width).map(fit),
  ]
  const focus = draw.filtered ? selected : undefined
  const shown = focus === undefined ? source.beats : source.beats.filter(beat => involves(beat, focus.name))
  const messageRows = Math.max(rows - lines.length - 1, 0)
  const back = clamp(draw.back, 0, Math.max(shown.length - messageRows, 0))
  const end = shown.length - back
  const start = Math.max(end - messageRows, 0)
  lines.push(fit(messagesTitle(palette, shown.length, { focus: focus?.name, earlier: start, later: back })))
  if (shown.length === 0) {
    const empty = focus === undefined ? 'No messages yet.' : `No exchanges with ${focus.name} yet.`
    lines.push(fit(palette.dim(`  ${empty}`)))
  }
  for (const beat of shown.slice(start, end)) lines.push(fit(beatLine(palette, beat)))
  while (lines.length < rows) lines.push('')
  return {
    lines: lines.slice(0, rows),
    back,
    page: Math.max(messageRows - 1, 1),
    animated: members.animated,
  }
}

/**
 * The page that shows the team on the alternate screen.
 */
export class TeamPlay {
  private selected: string | undefined
  private filtered = false
  private back = 0
  private page = 1
  private animated = false
  private notice: string | undefined

  /**
   * @param options - the palette and the reads the application supplies.
   */
  constructor(private readonly options: {
    palette: Palette
    source: () => TeamRoomSource
  }) {}

  /**
   * Whether the last frame drew a spinner, so the application keeps its tick
   * running only while a member works.
   * @returns true while a running member animates.
   */
  animates(): boolean {
    return this.animated
  }

  /**
   * Answer one key. Any key takes down the notice the previous key raised.
   * @param data - the raw key bytes.
   * @returns what the application should do, or undefined when the page handled the key itself.
   */
  handleInput(data: string): TeamRoomAction | undefined {
    this.notice = undefined
    if (matchesKey(data, 'escape') || data === 'q') return { kind: 'close' }
    if (data === 'f') {
      this.filtered = !this.filtered
      this.back = 0
      return undefined
    }
    if (matchesKey(data, 'pageUp')) {
      this.back += this.page
      return undefined
    }
    if (matchesKey(data, 'pageDown')) {
      this.back = Math.max(this.back - this.page, 0)
      return undefined
    }
    const step = matchesKey(data, 'up') ? -1 : matchesKey(data, 'down') ? 1 : 0
    if (step !== 0) {
      this.select(step)
      return undefined
    }
    return matchesKey(data, 'enter') ? this.open() : undefined
  }

  /**
   * Draw the page.
   * @param width - the terminal columns.
   * @param rows - the terminal rows; the page returns this many lines.
   * @returns the frame.
   */
  render(width: number, rows: number): string[] {
    const frame = teamRoomFrame({
      palette: this.options.palette,
      source: this.options.source(),
      selected: this.selected,
      filtered: this.filtered,
      back: this.back,
      notice: this.notice,
      width,
      rows,
    })
    this.back = frame.back
    this.page = frame.page
    this.animated = frame.animated
    return frame.lines
  }

  /**
   * Move the selection and show the exchanges from the newest again.
   * @param step - -1 for the member above, 1 for the member below.
   */
  private select(step: -1 | 1): void {
    const members = this.options.source().members
    const index = Math.max(members.findIndex(member => member.id === this.selected), 0)
    this.selected = members[clamp(index + step, 0, members.length - 1)]?.id
    this.back = 0
  }

  /**
   * Open the selected member as `/team` does, or say why nothing opens.
   * @returns the open action for a running or inactive teammate, otherwise undefined with the notice raised.
   */
  private open(): TeamRoomAction | undefined {
    const members = this.options.source().members
    const member = members.find(candidate => candidate.id === this.selected) ?? members[0]
    if (member === undefined) return undefined
    const entry = teamBrowseRows([member], [])[0]
    if (entry?.choice !== undefined) return { kind: 'open', entry, choice: entry.choice }
    this.notice = unopenable(member)
    return undefined
  }
}

/**
 * Why `Enter` opens no session for a member.
 * @param member - the lead, a provisioning member, or a failed member.
 * @returns the one-line notice.
 */
function unopenable(member: TeamMemberRow): string {
  if (member.role === 'lead') return 'the lead has no teammate session to open'
  return member.status === 'provisioning'
    ? `${member.name} is still being created`
    : `${member.name} failed to start; /team lists its diagnostics`
}

/**
 * Keep a number inside a range.
 * @param value - the number.
 * @param low - the smallest allowed value.
 * @param high - the largest allowed value; a range that ends below `low` yields `high`.
 * @returns `value` limited to the range.
 */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

/**
 * The heading row: the page name and the team's counts.
 * @param palette - the palette.
 * @param members - the roster.
 * @param tasks - the tasks that are not deleted.
 * @returns `team play · <n> teammates · <n> working · tasks <done>/<total> done`.
 */
function heading(palette: Palette, members: readonly TeamMemberRow[], tasks: readonly TeamTaskRow[]): string {
  const teammates = members.filter(member => member.role === 'teammate')
  const working = teammates.filter(member => member.status === 'running').length
  const done = tasks.filter(task => task.status === 'completed').length
  const counts = [
    `${String(teammates.length)} ${teammates.length === 1 ? 'teammate' : 'teammates'}`,
    `${String(working)} working`,
    `tasks ${String(done)}/${String(tasks.length)} done`,
  ].join(' · ')
  return `${palette.bold(palette.accent('team play'))} ${palette.dim(`· ${counts}`)}`
}

/**
 * The member rows of one frame.
 * @param draw - the frame being drawn.
 * @param members - the roster.
 * @param selectedIndex - the selected row.
 * @param allowed - rows the section may take, the `+<n> more` row included.
 * @returns the lines and whether a running member drew a spinner frame.
 */
function memberLines(
  draw: TeamRoomDraw,
  members: readonly TeamMemberRow[],
  selectedIndex: number,
  allowed: number,
): { lines: string[]; animated: boolean } {
  const { palette, source } = draw
  const view = rowWindow(members.length, allowed, selectedIndex)
  const names = members.map(member => visibleWidth(member.name))
  const nameWidth = clamp(Math.max(...names, 0), NAME_MIN_COLUMNS, NAME_MAX_COLUMNS)
  const rest = Math.max(draw.width - MEMBER_LEAD_COLUMNS - nameWidth - GAP.length, 0)
  const roles = members.map(member => visibleWidth(memberRoleText(member)))
  const roleWidth = Math.min(Math.max(...roles, 0), Math.floor(rest * ROLE_SHARE))
  let animated = false
  const lines: string[] = []
  for (const [offset, member] of members.slice(view.start, view.start + view.count).entries()) {
    const index = view.start + offset
    const frame = member.status === 'running' ? source.spinner(index) : undefined
    if (frame !== undefined) animated = true
    const work = currentWork(member, source)
    const name = truncateToWidth(member.name, nameWidth, '…', true)
    const picked = index === selectedIndex
    lines.push([
      picked ? palette.accent('▸') : ' ',
      ' ',
      paintStatus(palette, member.status, frame ?? MEMBER_GLYPH[member.status]),
      ' ',
      picked ? palette.bold(palette.accent(name)) : palette.bold(name),
      GAP,
      palette.dim(truncateToWidth(memberRoleText(member), roleWidth, '…', true)),
      GAP,
      work.task ? work.text : palette.dim(work.text),
    ].join(''))
  }
  if (view.hidden > 0) lines.push(palette.dim(`  +${String(view.hidden)} more`))
  return { lines, animated }
}

/**
 * What a member is doing: the subject of the in-progress task it owns, else
 * its last narration, else its status word.
 * @param member - the roster row.
 * @param source - the reads of this frame.
 * @returns the text, and whether it is a task subject.
 */
function currentWork(member: TeamMemberRow, source: TeamRoomSource): { text: string; task: boolean } {
  const owned = source.tasks.find(task => task.status === 'in_progress' && task.ownerName === member.name)
  if (owned !== undefined) return { text: owned.subject, task: true }
  const note = source.note(member.id)
  return { text: note === undefined || note === '' ? member.status : note, task: false }
}

/**
 * Color a member's status glyph.
 * @param palette - the palette.
 * @param status - the member's status.
 * @param glyph - the glyph to draw, the current spinner frame for a running member.
 * @returns the colored glyph.
 */
function paintStatus(palette: Palette, status: TeamMemberRow['status'], glyph: string): string {
  if (status === 'running') return palette.warning(glyph)
  if (status === 'failed') return palette.error(glyph)
  return palette.dim(glyph)
}

/**
 * The task rows of one frame.
 * @param palette - the palette.
 * @param tasks - the tasks that are not deleted.
 * @param allowed - rows the section may take, the `+<n> more` row included.
 * @param width - the columns the rows fit.
 * @returns the lines, or one placeholder line when there is no task.
 */
function taskLines(palette: Palette, tasks: readonly TeamTaskRow[], allowed: number, width: number): string[] {
  if (tasks.length === 0) return [palette.dim('  No tasks yet.')]
  const view = rowWindow(tasks.length, allowed, 0)
  const shown = tasks.slice(view.start, view.start + view.count)
  const blockers = shown.map(task => task.blockedBy.length === 0 ? '' : `blocked by ${task.blockedBy.map(id => `#${id}`).join(', ')}`)
  const idWidth = Math.max(...shown.map(task => visibleWidth(`#${task.id}`)))
  const ownerWidth = Math.min(Math.max(...shown.map(task => visibleWidth(task.ownerName ?? UNOWNED))), OWNER_MAX_COLUMNS)
  const blockedWidth = Math.max(...blockers.map(text => text === '' ? 0 : GAP.length + visibleWidth(text)))
  const subjectRoom = Math.max(width - TASK_LEAD_COLUMNS - idWidth - GAP.length - ownerWidth - blockedWidth, MIN_SUBJECT_COLUMNS)
  const subjectWidth = Math.min(Math.max(...shown.map(task => visibleWidth(task.subject))), subjectRoom)
  const lines = shown.map((task, index) => {
    const blocked = blockers[index] as string
    const owner = truncateToWidth(task.ownerName ?? UNOWNED, ownerWidth, '…', blocked !== '')
    const subject = truncateToWidth(task.subject, subjectWidth, '…', true)
    return [
      '  ',
      palette.dim(truncateToWidth(`#${task.id}`, idWidth, '…', true)),
      ' ',
      paintTaskGlyph(palette, task.status),
      ' ',
      task.status === 'completed' ? palette.dim(subject) : subject,
      GAP,
      palette.dim(owner),
      blocked === '' ? '' : `${GAP}${palette.warning(blocked)}`,
    ].join('')
  })
  if (view.hidden > 0) lines.push(palette.dim(`  +${String(view.hidden)} more`))
  return lines
}

/**
 * Color a task's status glyph.
 * @param palette - the palette.
 * @param status - the task's status.
 * @returns the colored glyph.
 */
function paintTaskGlyph(palette: Palette, status: TeamTaskRow['status']): string {
  const glyph = TASK_GLYPH[status]
  if (status === 'completed') return palette.success(glyph)
  if (status === 'in_progress') return palette.warning(glyph)
  return palette.dim(glyph)
}

/**
 * The slice of a list one section shows.
 *
 * A list that fits shows every item. A longer list shows `allowed - 1` items
 * around the selection and gives the last row to the `+<n> more` count.
 * @param total - items in the list.
 * @param allowed - rows the section may take.
 * @param selected - the item to keep in view.
 * @returns the first shown index, how many are shown, and how many the rows leave out.
 */
function rowWindow(total: number, allowed: number, selected: number): { start: number; count: number; hidden: number } {
  if (total <= allowed) return { start: 0, count: total, hidden: 0 }
  const count = Math.max(allowed - 1, 1)
  const start = clamp(selected - Math.floor(count / 2), 0, total - count)
  return { start, count, hidden: total - count }
}

/**
 * Whether an exchange has a member on either end.
 * @param beat - the exchange.
 * @param name - the member's name.
 * @returns true when the sender or the receiver is `name`, ignoring case.
 */
function involves(beat: TeamBeat, name: string): boolean {
  const wanted = name.toLowerCase()
  return beat.from.toLowerCase() === wanted || beat.to.toLowerCase() === wanted
}

/**
 * The `Messages` title with its counts.
 * @param palette - the palette.
 * @param total - exchanges after any filter.
 * @param place - the member the list is narrowed to, and how many exchanges lie above and below the view.
 * @returns the title row.
 */
function messagesTitle(
  palette: Palette,
  total: number,
  place: { focus: string | undefined; earlier: number; later: number },
): string {
  const facts = [String(total)]
  if (place.focus !== undefined) facts.unshift(`with ${place.focus}`)
  if (place.earlier > 0) facts.push(`${String(place.earlier)} earlier`)
  if (place.later > 0) facts.push(`${String(place.later)} later`)
  return `${palette.heading('Messages')} ${palette.dim(`· ${facts.join(' · ')}`)}`
}

/**
 * One exchange as a single line.
 * @param palette - the palette.
 * @param beat - the exchange.
 * @returns `<from> → <to>  <kind>: <text>` with the text on one line.
 */
function beatLine(palette: Palette, beat: TeamBeat): string {
  const text = beat.text.replace(/\s+/gu, ' ')
  return `  ${palette.accent(beat.from)} ${palette.dim('→')} ${palette.success(beat.to)}${GAP}${palette.dim(`${beat.kind}:`)} ${text}`
}

/** What one pass over a log knows before and while it reads each event. */
interface Reading {
  /** The name of the session that logged the events. */
  readonly speaker: string
  /** Member names by session id. */
  readonly names: ReadonlyMap<string, string>
  /** Names that a spawn tool call already lists a row for. */
  readonly spawnCalls: ReadonlySet<string>
  /** Whether the log has a `team/message/queued` record, which lists every peer message. */
  readonly peersRecorded: boolean
  /** Whether the log has a `team/task` record, which lists every task revision. */
  readonly tasksRecorded: boolean
  /** Members whose first `team/member` record was read, by session id or, lacking one, name. */
  readonly members: Set<string>
  /** The status and owner of each task at its latest revision read, by task id. */
  readonly taskStages: Map<string, string>
}

/**
 * The rows one event adds.
 * @param event - the log event.
 * @param call - the row `event` adds as a tool call, if any.
 * @param reading - the log-wide facts and the state of the pass.
 * @returns no row for an event that is not an exchange or that a `team/` record already lists.
 */
function beatsFromEvent(event: TeamLogEvent, call: TeamBeat | undefined, reading: Reading): TeamBeat[] {
  if (event.type === 'tool/call') return call === undefined || supersededCall(call, reading) ? [] : [call]
  if (event.type.startsWith('team/')) return beatsFromTeam(event.type, event.data, reading)
  if (event.type !== 'user/message' || reading.peersRecorded) return []
  const received = beatFromUser(event.data, reading.speaker)
  return received === undefined ? [] : [received]
}

/**
 * Whether the log's `team/` records list the exchange a tool call made.
 * @param call - the row the call adds.
 * @param reading - the log-wide facts.
 * @returns true for a message or task call while the matching record type is in the log.
 */
function supersededCall(call: TeamBeat, reading: Reading): boolean {
  return (call.kind === 'message' && reading.peersRecorded) || (call.kind === 'task' && reading.tasksRecorded)
}

/**
 * Whether two rows read the same.
 * @param previous - the row before, if any.
 * @param beat - the next row.
 * @returns true when both rows have the same sender, receiver, kind, and text.
 */
function sameRow(previous: TeamBeat | undefined, beat: TeamBeat): boolean {
  return previous?.from === beat.from && previous.to === beat.to && previous.kind === beat.kind && previous.text === beat.text
}

/**
 * The member a session id names.
 * @param id - the session id, if the record has one.
 * @param names - member names by session id.
 * @returns the name, or undefined when `id` is absent or not in `names`.
 */
function knownName(id: string | undefined, names: ReadonlyMap<string, string>): string | undefined {
  return id === undefined ? undefined : names.get(id)
}

/**
 * The member a session id names.
 * @param id - the session id, if the record has one.
 * @param names - member names by session id.
 * @returns the name, or `teammate` when `id` is absent or not in `names`.
 */
function memberName(id: string | undefined, names: ReadonlyMap<string, string>): string {
  return knownName(id, names) ?? UNKNOWN_MEMBER
}

/**
 * One tool call as an exchange.
 * @param data - the tool-call data.
 * @param speaker - the caller.
 * @param toolNames - names the plugin currently scopes onto the agent. When set, only those calls play.
 * @returns the exchange, or undefined when the call is not one this page plays.
 */
function beatFromCall(
  data: unknown,
  speaker: string,
  toolNames: ReadonlySet<string> | undefined,
): TeamBeat | undefined {
  const call = fields(data)
  const name = typeof call?.name === 'string' ? call.name : undefined
  if (name === undefined) return undefined
  const args = argumentsOf(call?.arguments)
  const scoped = toolNames !== undefined && toolNames.has(name)
  const summary = summarizeCall(name, args)
  if (!scoped && !summary.addressed) return undefined
  return { from: speaker, to: summary.to, kind: summary.kind, text: summary.text }
}

/**
 * The receiver, the caption, and the kind of one tool call.
 * Argument keys are the ones a coordination call uses; a plugin tool with
 * other string fields still captions itself with the first of those fields
 * when the tool name is in the scoped set.
 * @param name - the tool name.
 * @param args - parsed arguments, omitted when they were not a JSON object.
 * @returns the lane fields, and whether the arguments themselves name an exchange.
 */
function summarizeCall(name: string, args: Record<string, unknown> | undefined): {
  addressed: boolean
  to: string
  kind: TeamBeat['kind']
  text: string
} {
  const target = text(args?.target)
  const teammate = text(args?.name)
  const prompt = text(args?.prompt)
  const message = text(args?.message)
  const subject = text(args?.subject)
  const action = text(args?.action)
  const addressed = target !== undefined || teammate !== undefined || message !== undefined
    || prompt !== undefined || subject !== undefined || action !== undefined
  if (subject !== undefined || action !== undefined) {
    const caption = [action, subject].filter(part => part !== undefined).join(' ')
    return { addressed, to: target ?? 'board', kind: 'task', text: caption }
  }
  if (prompt !== undefined && target === undefined) {
    return { addressed, to: teammate ?? 'team', kind: 'spawn', text: prompt }
  }
  if (message !== undefined || target !== undefined) {
    return { addressed, to: target ?? teammate ?? 'team', kind: 'message', text: message ?? name }
  }
  const extra = args === undefined ? undefined : Object.entries(args).find((entry): entry is [string, string] => typeof entry[1] === 'string')
  return { addressed, to: 'team', kind: 'message', text: extra === undefined ? name : `${extra[0]}: ${extra[1]}` }
}

/**
 * The rows one `team/` event adds. Member, task, and message records keep
 * their lane; any other team event is listed with the first string it carries
 * that is not an id, or the event type.
 * @param type - the event type, including the `team/` prefix.
 * @param data - the event data.
 * @param reading - the log-wide facts and the state of the pass.
 * @returns the rows; none for a delivery receipt or a repeated member or task state.
 */
function beatsFromTeam(type: string, data: unknown, reading: Reading): TeamBeat[] {
  const label = type.slice('team/'.length)
  const root = fields(data) ?? {}
  switch (type) {
    case 'team/member':
      return memberBeats(root, label, reading)
    case 'team/task':
      return taskBeats(root, label, reading)
    case 'team/message/queued':
      return [queuedBeat(root, reading)]
    case 'team/message/delivered':
      return []
    // `SessionEventMap` is merge-extensible: a team event a later release adds is listed generically.
    default:
      return [futureBeat(root, label, reading.speaker)]
  }
}

/**
 * The rows one `team/member` record adds.
 * @param root - the record data.
 * @param label - the event type without the `team/` prefix.
 * @param reading - the log-wide facts and the state of the pass.
 * @returns the spawn row when this is the member's first record and no spawn
 *   tool call lists the member, then the failure row when the record is failed
 *   or carries an error.
 */
function memberBeats(root: Record<string, unknown>, label: string, reading: Reading): TeamBeat[] {
  const member = fields(root.member) ?? {}
  const id = text(member.id)
  const name = text(member.name) ?? memberName(id, reading.names)
  const phase = text(member.phase)
  const error = text(member.error)
  const key = id ?? name
  const first = !reading.members.has(key)
  reading.members.add(key)
  const beats: TeamBeat[] = []
  if (first && !reading.spawnCalls.has(name)) {
    beats.push({ from: reading.speaker, to: name, kind: 'spawn', text: phase ?? label })
  }
  if (phase === 'failed' || error !== undefined) {
    beats.push({ from: name, to: reading.speaker, kind: 'spawn', text: error === undefined ? 'failed' : `failed: ${error}` })
  }
  return beats
}

/**
 * The row one `team/task` record adds.
 * @param root - the record data.
 * @param label - the event type without the `team/` prefix.
 * @param reading - the log-wide facts and the state of the pass.
 * @returns the row, from the owner when the roster names it, else from the
 *   speaker; none when the revision keeps the task's status and owner.
 */
function taskBeats(root: Record<string, unknown>, label: string, reading: Reading): TeamBeat[] {
  const task = fields(root.task) ?? {}
  const id = text(task.id)
  const status = text(task.status)
  const subject = text(task.subject)
  const ownerId = text(task.ownerId)
  const stage = `${status ?? ''}/${ownerId ?? ''}`
  if (id !== undefined) {
    if (reading.taskStages.get(id) === stage) return []
    reading.taskStages.set(id, stage)
  }
  const caption = subject !== undefined && status !== undefined ? `${status} ${subject}` : subject ?? status ?? label
  return [{ from: knownName(ownerId, reading.names) ?? reading.speaker, to: 'board', kind: 'task', text: caption }]
}

/**
 * The row one `team/message/queued` record adds.
 * @param root - the record data.
 * @param reading - the log-wide facts.
 * @returns the message from its sender to its target, with the text blocks of its content on one line.
 */
function queuedBeat(root: Record<string, unknown>, reading: Reading): TeamBeat {
  const message = fields(root.message) ?? {}
  const said = textBlocks(message.content).join(' ').replace(/\s+/gu, ' ').trim()
  return {
    from: text(message.senderName) ?? memberName(text(message.senderId), reading.names),
    to: memberName(text(message.targetId), reading.names),
    kind: 'message',
    text: said === '' ? NON_TEXT_MESSAGE : said,
  }
}

/**
 * The row for a `team/` event type that this page does not know.
 * @param root - the event data.
 * @param label - the event type without the `team/` prefix.
 * @param speaker - the session that logged the event.
 * @returns a message row captioned with the first string field that does not hold an id, else the label.
 */
function futureBeat(root: Record<string, unknown>, label: string, speaker: string): TeamBeat {
  const nested = fields(root.member) ?? fields(root.task) ?? fields(root.message) ?? root
  const who = text(nested.name) ?? text(nested.senderName) ?? text(nested.subject) ?? 'team'
  const first = Object.entries(nested).find((entry): entry is [string, string] =>
    !IDENTIFIER_FIELDS.has(entry[0]) && typeof entry[1] === 'string' && entry[1].trim() !== '')?.[1]
  const detail = text(nested.phase) ?? text(nested.status) ?? text(nested.message) ?? text(nested.text) ?? first ?? label
  return { from: speaker, to: who, kind: 'message', text: detail }
}

/**
 * The text blocks of message content.
 * @param content - the logged content blocks.
 * @returns the text of each text block in order; none when `content` is not an array.
 */
function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const parts: string[] = []
  for (const block of content) {
    const row = fields(block)
    if (row?.type === 'text' && typeof row.text === 'string') parts.push(row.text)
  }
  return parts
}

/**
 * A received team message as an exchange aimed at `speaker`.
 * @param data - the user-message data.
 * @param speaker - the session that received the message.
 * @returns the exchange, or undefined when the text is not a team message.
 */
function beatFromUser(data: unknown, speaker: string): TeamBeat | undefined {
  const message = fields(fields(data)?.message)
  const body = textBlocks(message?.content).join('')
  const matched = /^Team message from ([^:]+):\s*([\s\S]*)$/u.exec(body)
  const named = matched?.[1]?.trim()
  const said = matched?.[2]?.trim()
  if (named !== undefined && named !== '' && said !== undefined && said !== '') {
    return { from: named, to: speaker, kind: 'message', text: said }
  }
  const source = fields(message?.source)
  if (source?.kind === 'agent-message' && body !== '') {
    return { from: text(source.senderName) ?? 'teammate', to: speaker, kind: 'message', text: body }
  }
  return undefined
}

/**
 * Parse tool arguments, skipping text that is not a JSON object.
 * @param value - the arguments string a tool call logged.
 * @returns the object, or undefined when it is missing or not an object.
 */
function argumentsOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return fields(JSON.parse(value))
  } catch (error: unknown) {
    // Malformed tool arguments are skipped.
    void error
    return undefined
  }
}

/**
 * A nonempty string field.
 * @param value - the candidate.
 * @returns the string, or undefined when it is blank or not a string.
 */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * The own fields of a plain object.
 * @param value - the candidate.
 * @returns those fields, or undefined for anything that is not a plain object.
 */
function fields(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) out[key] = field
  return out
}
