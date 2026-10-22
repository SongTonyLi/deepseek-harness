/**
 * Agent Teams as terminal rows: tool visibility, the roster picker, and the
 * read of the optional `agentTeams` service. The service is absent from the
 * typed Context, so `ctx.get('agentTeams')` is `any` until a type guard
 * narrows it. The panel text lives in `./team-panel.ts`.
 * @module @deepseek-ai/dsh-tui-app/team
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentChoice } from './catalog.ts'
import type { TeamMemberRow, TeamTaskRow } from './team-panel.ts'

/** One tool schema the terminal prints. The tools registry supplies these. */
export interface VisibleTool {
  /** Registered tool name. */
  readonly name: string
  /** Model-facing description, when the schema carries a string. */
  readonly description?: unknown
}

/** Shown when this composition has no Agent Teams service. */
export const TEAM_ABSENT_NOTICE = 'Agent Teams are not enabled in this composition'

/** Shown when the service is mounted and this session is not a team member. */
export const TEAM_NOT_MEMBER_NOTICE = 'this session is not on a team'

/** Shown when `/team` has no member and no shared task to list. */
export const TEAM_EMPTY_NOTICE = 'no teammates or shared tasks yet'

/** Shown when `/team-panel` is given an argument other than `on` or `off`. */
export const TEAM_PANEL_USAGE = 'usage: /team-panel · /team-panel on · /team-panel off'

/** Fields the member detail page already prints, so a plugin field is not repeated. */
const MEMBER_FIELDS = new Set(['id', 'name', 'role', 'status', 'description', 'model', 'diagnostics'])

/** Fields the task detail page already prints, so a plugin field is not repeated. */
const TASK_FIELDS = new Set([
  'id', 'revision', 'subject', 'description', 'status', 'blockedBy', 'writeScopes', 'ownerName', 'ready', 'writeScopeWarnings',
])

/**
 * The optional service the terminal reads when membership and both lists are functions.
 * `readTeam` still accepts a service that has not grown a `listTasks` method yet.
 */
export interface AgentTeamsReader {
  /**
   * Membership of one agent, or undefined when that agent is not on a team.
   * @param agent - the bound agent.
   * @returns a membership value, or undefined.
   */
  tryMembership(agent: Agent): unknown
  /**
   * Roster rows visible to one member.
   * @param agent - the bound agent.
   * @returns the member rows.
   */
  listMembers(agent: Agent): unknown
  /**
   * Shared tasks visible to one member.
   * @param agent - the bound agent.
   * @returns the task rows.
   */
  listTasks(agent: Agent): unknown
}

/**
 * What a command or the summary can do with the service.
 * `absent` means the service is missing, or `tryMembership` or `listMembers` is not a function.
 * `not-member` means membership is undefined or a list read threw.
 */
export type TeamSnapshot =
  | { kind: 'absent' }
  | { kind: 'not-member' }
  | { kind: 'team'; members: readonly TeamMemberRow[]; tasks: readonly TeamTaskRow[] }

/** One `/team` picker row: the list line, the detail lines, and the session it opens when it has one. */
export interface TeamBrowseRow {
  /** Picker row. `value` stays stable across the list. */
  item: { value: string; label: string; description: string }
  /** Detail-page heading. */
  heading: string
  /** Detail-page lines. */
  lines: readonly string[]
  /**
   * Present when `Enter` opens a teammate session. The lead, a provisioning
   * member, a failed member, and every task omit it and stay on the detail page.
   */
  choice?: SubagentChoice
}

/**
 * Whether a logged event should redraw the team summary.
 * @param type - the session event type, widened because team events are not on this package's `SessionEvent` union.
 * @returns true for a roster, task, or team-message event.
 */
export function isTeamPanelEvent(type: string): boolean {
  return type.startsWith('team/')
}

/**
 * Narrow a service value to a reader that exposes membership and both lists.
 * @param value - the raw `ctx.get('agentTeams')` value.
 * @returns true when membership and both lists are functions.
 */
function isAgentTeamsReader(value: unknown): value is AgentTeamsReader {
  if (typeof value !== 'object' || value === null) return false
  return 'tryMembership' in value && typeof value.tryMembership === 'function'
    && 'listMembers' in value && typeof value.listMembers === 'function'
    && 'listTasks' in value && typeof value.listTasks === 'function'
}

/**
 * The Agent Teams service when this composition mounted a reader with both lists.
 * @param ctx - plugin context. `agentTeams` is not a typed Context property.
 * @returns the reader, or undefined when the service is missing or has no reader methods.
 */
export function readAgentTeams(ctx: Context): AgentTeamsReader | undefined {
  const service: unknown = ctx.get('agentTeams')
  return isAgentTeamsReader(service) ? service : undefined
}

/**
 * Whether a value is a non-null object the reader can look up methods on.
 * @param value - the raw `ctx.get('agentTeams')` value.
 * @returns true for an object the method checks can read.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Whether a list read returned an array. Element fields are the reader's own
 * rows; this only rejects a missing list.
 * @param value - the value a list method returned.
 * @returns true when `value` is an array.
 */
function isRowList<T>(value: unknown): value is T[] {
  return Array.isArray(value)
}

/**
 * Call one service method with the service as `this`.
 * @param service - the Agent Teams service.
 * @param name - `tryMembership`, `listMembers`, or `listTasks`.
 * @param agent - the bound agent.
 * @returns the method's return value. The caller only passes a name whose value is a function.
 */
function callTeam(service: Record<string, unknown>, name: string, agent: Agent): unknown {
  const method = service[name] as (this: Record<string, unknown>, agent: Agent) => unknown
  return method.call(service, agent)
}

/**
 * Read the roster for one agent.
 * A missing service, or a service whose `tryMembership` or `listMembers` is
 * not a function, is `absent`. A membership of `undefined`, or a
 * `listMembers` call that throws, is `not-member`. `listTasks` is optional:
 * a missing method yields an empty task list, and a throw or a non-array is
 * `not-member`.
 * @param service - `ctx.get('agentTeams')`, absent when the bundle is off.
 * @param agent - the bound agent.
 * @returns the snapshot the commands and the summary share.
 */
export function readTeam(service: unknown, agent: Agent): TeamSnapshot {
  if (!isRecord(service) || typeof service.listMembers !== 'function' || typeof service.tryMembership !== 'function') {
    return { kind: 'absent' }
  }
  let membership: unknown
  try {
    membership = callTeam(service, 'tryMembership', agent)
  } catch (error: unknown) {
    // A membership read that throws cannot place this session on the team.
    void error
    return { kind: 'not-member' }
  }
  if (membership === undefined) return { kind: 'not-member' }
  let members: unknown
  try {
    members = callTeam(service, 'listMembers', agent)
  } catch (error: unknown) {
    // listMembers throws when this agent cannot read the roster.
    void error
    return { kind: 'not-member' }
  }
  if (!isRowList<TeamMemberRow>(members)) return { kind: 'not-member' }
  let tasks: unknown
  if (typeof service.listTasks !== 'function') {
    tasks = []
  } else {
    try {
      tasks = callTeam(service, 'listTasks', agent)
    } catch (error: unknown) {
      // A task-board read that throws leaves the roster unread as well.
      void error
      return { kind: 'not-member' }
    }
  }
  if (!isRowList<TeamTaskRow>(tasks)) return { kind: 'not-member' }
  return { kind: 'team', members, tasks }
}

/**
 * Read the roster for one agent from plugin context.
 * @param ctx - plugin context carrying the optional service.
 * @param agent - the bound agent.
 * @returns the snapshot {@link readTeam} produces for `ctx.get('agentTeams')`.
 */
export function readTeamSnapshot(ctx: Context, agent: Agent): TeamSnapshot {
  return readTeam(ctx.get('agentTeams'), agent)
}

/**
 * Lines for the tools this agent can call that the global registry does not
 * list. Those are the tools the Agent Teams plugin scoped onto the member.
 * A tool the plugin adds later appears here without a terminal change; a
 * tool it removes disappears. Names are sorted.
 * @param visible - schemas visible to the agent. Undefined yields no lines.
 * @param globalNames - tool names visible without a member scope.
 * @returns one line per scoped tool: `name  description` when the description is a string, otherwise the name.
 */
export function teamToolRows(
  visible: readonly VisibleTool[] | undefined,
  globalNames: ReadonlySet<string> = new Set(),
): string[] {
  if (visible === undefined) return []
  return visible
    .filter(tool => !globalNames.has(tool.name))
    .map((tool) => {
      const description = tool.description
      return typeof description === 'string' && description !== '' ? `${tool.name}  ${description}` : tool.name
    })
    .sort((left, right) => left.localeCompare(right))
}

/**
 * Whether `Enter` opens this member as a continuable session.
 * @param member - the roster row.
 * @returns true for a running or inactive teammate.
 */
function teammateEnterable(member: TeamMemberRow): boolean {
  return member.role === 'teammate' && (member.status === 'running' || member.status === 'inactive')
}

/**
 * Picker description of one member.
 * @param member - the roster row.
 * @returns role, status, and the model when one is present.
 */
function memberDescription(member: TeamMemberRow): string {
  const role = `${member.role} · ${member.status}`
  return member.model === undefined ? role : `${role} · ${member.model}`
}

/**
 * Detail lines of one member: name, role, status, model when present,
 * description when present, then each diagnostic.
 * @param member - the roster row.
 * @returns the detail page lines.
 */
function memberLines(member: TeamMemberRow): string[] {
  const lines = [member.name, member.role, member.status]
  if (member.model !== undefined) lines.push(member.model)
  if (member.description !== undefined) lines.push(member.description)
  lines.push(...member.diagnostics)
  lines.push(...pluginFields(member, MEMBER_FIELDS))
  return lines
}

/**
 * Detail lines of one task: id, revision, status, owner or `unowned`,
 * `ready` or `blocked`, description, each blocker, each write scope, and
 * each write-scope warning.
 * @param task - the task row.
 * @returns the detail page lines.
 */
function taskLines(task: TeamTaskRow): string[] {
  return [
    task.id,
    String(task.revision),
    task.status,
    task.ownerName ?? 'unowned',
    task.ready ? 'ready' : 'blocked',
    task.description,
    ...task.blockedBy,
    ...task.writeScopes,
    ...task.writeScopeWarnings,
    ...pluginFields(task, TASK_FIELDS),
  ]
}

/**
 * Plugin fields the detail page does not already print.
 * @param value - one roster or task row, including fields a later plugin release added.
 * @param known - keys this page already printed.
 * @returns `key: value` lines for the remaining string, number, and boolean fields, in key order.
 */
function pluginFields(value: object, known: ReadonlySet<string>): string[] {
  const lines: string[] = []
  for (const key of Object.keys(value).sort()) {
    if (known.has(key)) continue
    const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value
    if (typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean') {
      lines.push(`${key}: ${String(field)}`)
    }
  }
  return lines
}

/**
 * The session choice `Enter` opens for one teammate.
 * @param member - a running or inactive teammate.
 * @returns a continuable session choice at depth 1.
 */
function teammateChoice(member: TeamMemberRow): SubagentChoice {
  return {
    id: SessionId(member.id),
    depth: 1,
    label: member.name,
    description: memberDescription(member),
    target: 'session',
    mode: 'continuable',
    enterable: true,
  }
}

/**
 * Picker rows for `/team`. Members come first. A running or inactive
 * teammate carries a session choice; the lead, a provisioning member, and a
 * failed member do not. Deleted tasks are omitted. Every other task is a
 * detail row.
 * @param members - roster rows in list order.
 * @param tasks - task rows in list order, deleted rows included.
 * @returns the picker rows.
 */
export function teamBrowseRows(members: readonly TeamMemberRow[], tasks: readonly TeamTaskRow[]): TeamBrowseRow[] {
  const rows: TeamBrowseRow[] = members.map((member) => {
    const enterable = teammateEnterable(member)
    return {
      item: { value: `member:${member.id}`, label: member.name, description: memberDescription(member) },
      heading: member.name,
      lines: memberLines(member),
      ...enterable ? { choice: teammateChoice(member) } : {},
    }
  })
  for (const task of tasks) {
    if (task.status === 'deleted') continue
    const owner = task.ownerName ?? 'unowned'
    const readiness = task.ready ? 'ready' : 'blocked'
    rows.push({
      item: {
        value: `task:${task.id}`,
        label: task.subject,
        description: `${task.status} · ${owner} · ${readiness}`,
      },
      heading: task.subject,
      lines: taskLines(task),
    })
  }
  return rows
}
