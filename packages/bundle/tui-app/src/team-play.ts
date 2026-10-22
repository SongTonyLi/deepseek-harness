/**
 * How teammates exchange work, drawn as one moving lane per exchange.
 *
 * The page plays the bound session's spawn, message, and task calls. A
 * session that has none plays a fixed example. Reduced motion parks the
 * marker on the receiver. The subagent view stays the place that opens one
 * teammate's transcript; this page is the exchange between them.
 * @module @deepseek-ai/dsh-tui-app/team-play
 */

import { matchesKey, truncateToWidth } from '@earendil-works/pi-tui'
import { paintKeys } from './key-chips.ts'
import type { Palette } from './style.ts'

/** What the start card and this page call the feature. */
export const TEAM_ON_LINE = 'Agent Teams is on by default'

/** Disable command printed on the start card and this page. */
export const TEAM_OFF_COMMAND = '/plugins disable @deepseek-ai/dsh-experimental-agent-team-profile'

/** What the start card tells the reader to open. */
export const TEAM_PLAY_LINE = '/team-play shows how each agent talks to the others'

/** Steps the marker takes from the sender to the receiver. */
export const PLAY_PHASES = 8

/** Cells in the track between two names. */
const TRACK = 16

/** One exchange the page can play. */
export interface TeamBeat {
  /** Who starts the exchange. */
  readonly from: string
  /** Who receives it. */
  readonly to: string
  /** What kind of exchange it is. */
  readonly kind: 'spawn' | 'message' | 'task'
  /** The short text under the lane. */
  readonly text: string
}

/**
 * The example played when the session has no teammate exchanges yet.
 * Three beats: the lead spawns a reviewer, asks for the diff, and gets an answer.
 */
export const SHOWCASE_BEATS: readonly TeamBeat[] = [
  { from: 'lead', to: 'reviewer', kind: 'spawn', text: 'spawn reviewer' },
  { from: 'lead', to: 'reviewer', kind: 'message', text: 'check the diff' },
  { from: 'reviewer', to: 'lead', kind: 'message', text: 'the diff is consistent' },
]

/** One log event reduced to the fields the exchange reader understands. */
export interface TeamLogEvent {
  /** The session event type. */
  type: string
  /** The session event data. */
  data: unknown
}

/**
 * Where the marker sits on a track.
 * @param phase - the step, any integer; wrapped into {@link PLAY_PHASES}.
 * @param track - how many cells the track has.
 * @returns the marker's cell, 0 at the sender.
 */
export function markerColumn(phase: number, track: number): number {
  const span = Math.max(track - 1, 0)
  const wrapped = ((phase % PLAY_PHASES) + PLAY_PHASES) % PLAY_PHASES
  return Math.round((wrapped / (PLAY_PHASES - 1)) * span)
}

/** The plain pieces of one lane, so a palette can color the names and the track apart. */
export interface LaneParts {
  /** The sender's name. */
  from: string
  /** The track, with one space on each side. */
  track: string
  /** The receiver's name. */
  to: string
}

/**
 * The sender, the track, and the receiver of one lane.
 * @param from - the sender's name.
 * @param to - the receiver's name.
 * @param phase - the marker's step.
 * @returns the three pieces.
 */
export function laneParts(from: string, to: string, phase: number): LaneParts {
  const column = markerColumn(phase, TRACK)
  let cells = ''
  for (let index = 0; index < TRACK; index += 1) cells += index === column ? '●' : '·'
  return { from, track: ` ${cells} `, to }
}

/**
 * One lane as a single plain line.
 * @param from - the sender's name.
 * @param to - the receiver's name.
 * @param phase - the marker's step.
 * @returns the line.
 */
export function lane(from: string, to: string, phase: number): string {
  const parts = laneParts(from, to, phase)
  return `${parts.from}${parts.track}${parts.to}`
}

/**
 * Exchanges recorded in one session log.
 *
 * A tool call plays when its name is in `toolNames`, the names the Agent
 * Teams plugin currently scopes onto this agent, or when `toolNames` is
 * omitted and the arguments name a person or a task. Every `team/` event
 * plays, including types a later plugin release adds. A user message plays
 * when its source is `agent-message` or its text begins `Team message from`.
 * Malformed tool arguments still name the tool when it is in `toolNames`.
 * @param events - the log events, oldest first.
 * @param speaker - the name of the session that logged the events.
 * @param toolNames - tool names scoped by the plugin. Omitted reads exchanges from call arguments.
 * @returns the exchanges in log order.
 */
export function beatsFromEvents(
  events: readonly TeamLogEvent[],
  speaker: string,
  toolNames?: ReadonlySet<string>,
): TeamBeat[] {
  const beats: TeamBeat[] = []
  for (const event of events) {
    const beat = beatFromEvent(event, speaker, toolNames)
    if (beat !== undefined) beats.push(beat)
  }
  return beats
}

/**
 * Draw the team-play page.
 * @param options - the beats, which one is moving, the palette, and the screen size.
 * @returns exactly `options.rows` lines.
 */
export function teamPlayLines(options: {
  palette: Palette
  beats: readonly TeamBeat[]
  beat: number
  phase: number
  example: boolean
  paused: boolean
  width: number
  rows: number
}): string[] {
  const width = Math.max(options.width, 1)
  const fit = (line: string): string => truncateToWidth(line, width, '…')
  const palette = options.palette
  const beats = options.beats.length > 0 ? options.beats : SHOWCASE_BEATS
  const index = ((options.beat % beats.length) + beats.length) % beats.length
  const current = beats[index]
  if (current === undefined) return Array.from({ length: options.rows }, () => '')
  const notice = options.example
    ? 'example · this session has no teammate messages yet'
    : `${String(beats.length)} ${beats.length === 1 ? 'interaction' : 'interactions'}`
  const legend = options.paused
    ? 'Esc closes  ← → step  Space pauses  paused'
    : 'Esc closes  ← → step  Space pauses'
  const lines = [
    fit(`${palette.bold(palette.accent('team play'))}  ${palette.dim(TEAM_ON_LINE)}`),
    fit(palette.warning(TEAM_OFF_COMMAND)),
    fit(paintKeys(palette, legend)),
    fit(palette.dim(notice)),
    '',
  ]
  for (const [offset, beat] of beats.entries()) {
    if (lines.length >= options.rows - 1) break
    const settled = offset !== index
    const phase = settled ? PLAY_PHASES - 1 : options.phase
    lines.push(fit(paintLane(palette, beat, phase, settled)))
    lines.push(fit(palette.dim(`  ${beat.kind}  ${beat.text}`)))
  }
  // The current beat is named again when the list was cut short, so the
  // moving lane stays on screen.
  if (!lines.some(line => line.includes(current.text)) && lines.length < options.rows) {
    lines.push(fit(paintLane(palette, current, options.phase, false)))
    lines.push(fit(palette.dim(`  ${current.kind}  ${current.text}`)))
  }
  while (lines.length < options.rows) lines.push('')
  return lines.slice(0, options.rows)
}

/**
 * The page that plays teammate exchanges on the alternate screen.
 */
export class TeamPlay {
  /** The beat whose marker is moving. */
  beat = 0
  /** The marker's step along the current beat. */
  phase = 0
  /** Whether Space has paused the play. */
  paused = false

  /**
   * @param options - the palette, the log, and whether motion is reduced.
   */
  constructor(private readonly options: {
    palette: Palette
    reducedMotion: boolean
    beats: () => readonly TeamBeat[]
    example: () => boolean
  }) {}

  /** Step the marker, and the beat once the marker arrives. */
  advance(): void {
    if (this.paused || this.options.reducedMotion) return
    const count = Math.max(this.options.beats().length, 1)
    this.phase += 1
    if (this.phase < PLAY_PHASES) return
    this.phase = 0
    this.beat = (this.beat + 1) % count
  }

  /**
   * Answer one key.
   * @param data - the raw key bytes.
   * @returns `close` when the page should leave the terminal.
   */
  handleInput(data: string): 'close' | undefined {
    if (matchesKey(data, 'escape') || data === 'q') return 'close'
    if (data === ' ') {
      this.paused = !this.paused
      return undefined
    }
    const count = Math.max(this.options.beats().length, 1)
    if (matchesKey(data, 'right')) {
      this.beat = (this.beat + 1) % count
      this.phase = PLAY_PHASES - 1
      this.paused = true
      return undefined
    }
    if (matchesKey(data, 'left')) {
      this.beat = (this.beat - 1 + count) % count
      this.phase = PLAY_PHASES - 1
      this.paused = true
      return undefined
    }
    return undefined
  }

  /**
   * Draw the page.
   * @param width - the terminal columns.
   * @param rows - the terminal rows; the page returns this many lines.
   * @returns the frame.
   */
  render(width: number, rows: number): string[] {
    const beats = this.options.beats()
    return teamPlayLines({
      palette: this.options.palette,
      beats: beats.length > 0 ? beats : SHOWCASE_BEATS,
      beat: this.beat,
      phase: this.options.reducedMotion ? PLAY_PHASES - 1 : this.phase,
      example: beats.length === 0 || this.options.example(),
      paused: this.paused,
      width,
      rows: Math.max(rows, 1),
    })
  }
}

/**
 * One event as an exchange, or undefined when the event is not one.
 * @param event - the log event.
 * @param speaker - the name of the session that logged it.
 * @returns the exchange.
 */
function beatFromEvent(
  event: TeamLogEvent,
  speaker: string,
  toolNames: ReadonlySet<string> | undefined,
): TeamBeat | undefined {
  if (event.type === 'tool/call') return beatFromCall(event.data, speaker, toolNames)
  if (event.type.startsWith('team/')) return beatFromTeam(event.type, event.data, speaker)
  if (event.type === 'user/message') return beatFromUser(event.data, speaker)
  return undefined
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
    const caption = subject !== undefined && action !== undefined ? `${action} ${subject}` : subject ?? action ?? name
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
 * One `team/` event as an exchange. Member and task records keep their lane;
 * any other team event uses the first string it carries, or the event type.
 * @param type - the event type, including the `team/` prefix.
 * @param data - the event data.
 * @param speaker - the session that logged the event.
 * @returns the exchange.
 */
function beatFromTeam(type: string, data: unknown, speaker: string): TeamBeat | undefined {
  const label = type.slice('team/'.length)
  const root = fields(data) ?? {}
  const nested = fields(root.member) ?? fields(root.task) ?? fields(root.message) ?? root
  if (root.member !== undefined) {
    const name = text(nested.name)
    if (name === undefined) return { from: speaker, to: 'team', kind: 'spawn', text: label }
    return { from: speaker, to: name, kind: 'spawn', text: text(nested.error) ?? text(nested.phase) ?? label }
  }
  if (root.task !== undefined) {
    const subject = text(nested.subject)
    const status = text(nested.status)
    const caption = subject !== undefined && status !== undefined ? `${status} ${subject}` : subject ?? status ?? label
    return { from: speaker, to: 'board', kind: 'task', text: caption }
  }
  const who = text(nested.name) ?? text(nested.senderName) ?? text(nested.subject) ?? 'team'
  const first = Object.values(nested).find((value): value is string => typeof value === 'string' && value.trim() !== '')
  const detail = text(nested.phase) ?? text(nested.status) ?? text(nested.message) ?? text(nested.text) ?? first ?? label
  return { from: speaker, to: who, kind: 'message', text: detail }
}

/**
 * A received team message as an exchange aimed at `speaker`.
 * @param data - the user-message data.
 * @param speaker - the session that received the message.
 * @returns the exchange, or undefined when the text is not a team message.
 */
function beatFromUser(data: unknown, speaker: string): TeamBeat | undefined {
  const message = fields(fields(data)?.message)
  const content = message?.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const row = fields(block)
    if (row?.type === 'text' && typeof row.text === 'string') parts.push(row.text)
  }
  const body = parts.join('')
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

/**
 * Color one lane. A settled lane is one dim span. The moving lane bolds each
 * name on its own span and dims the track, because a dim close also clears bold.
 * @param palette - the palette.
 * @param beat - the exchange.
 * @param phase - the marker's step.
 * @param settled - draw the lane dim instead of coloring the names.
 * @returns the colored lane.
 */
function paintLane(palette: Palette, beat: TeamBeat, phase: number, settled: boolean): string {
  const parts = laneParts(beat.from, beat.to, phase)
  if (settled) return palette.dim(`${parts.from}${parts.track}${parts.to}`)
  return `${palette.bold(palette.accent(parts.from))}${palette.dim(parts.track)}${palette.bold(palette.success(parts.to))}`
}
