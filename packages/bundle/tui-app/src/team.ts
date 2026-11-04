/**
 * Agent Teams as terminal rows: tool visibility, the roster picker, and the
 * task-board mode and subagent catalog. The panel text lives in `./team-panel.ts`.
 * @module @deepseek-ai/dsh-tui-app/team
 */

import { truncateToWidth } from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-team'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
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

/** Current Team presentation rows, or the reason the view is unavailable. */
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
 * @param type - the session event type.
 * @returns true for a Team mode, task, or historical Team event.
 */
export function isTeamPanelEvent(type: string): boolean {
  return type.startsWith('team/')
}

/**
 * Read Team mode, current task owners, and continuable catalog descendants.
 * The catalog carries names and descriptions; a separate Team roster is not maintained.
 * @param ctx - context carrying the task board and subagent runtime.
 * @param agent - exact live caller.
 * @param entries - the terminal's latest descendant listing.
 * @returns current presentation rows, or the reason Team rows are unavailable.
 */
export function readTeamSnapshot(
  ctx: Context,
  agent: Agent,
  entries: readonly SubagentDescendantListEntry[] = [],
): TeamSnapshot {
  const teams = ctx.get('agentTeams')
  const subagents = ctx.get('subagents')
  if (teams === undefined || subagents === undefined) return { kind: 'absent' }
  try {
    if (!teams.isEnabled(agent)) return { kind: 'not-member' }
    const root = subagents.rootOf(agent)
    const row = (live: Agent | undefined, id: string, name: string, role: TeamMemberRow['role']): TeamMemberRow => {
      const model = live?.model.current()?.model
      return {
        id, name, role,
        status: live?.status === 'running' ? 'running' : 'inactive',
        ...model === undefined ? {} : { model },
        diagnostics: [],
      }
    }
    const members = [row(root, root.id, 'lead', 'lead')]
    for (const entry of entries) {
      if (entry.kind !== 'child' || entry.mode !== 'continuable') continue
      members.push({
        ...row(ctx.get('agents')?.get(entry.id), entry.id, entry.path ?? entry.label, 'teammate'),
        ...entry.path === undefined ? {} : { description: entry.label },
      })
    }
    const names = new Map(members.map(member => [member.id, member.name]))
    const tasks = teams.listTasks(agent).map(task => ({
      ...task,
      ...task.ownerId === undefined ? {} : { ownerName: names.get(task.ownerId) ?? task.ownerName ?? task.ownerId },
    }))
    return { kind: 'team', members, tasks }
  } catch (error: unknown) {
    // A missing root or failed projection cannot supply a current Team view.
    void error
    return { kind: 'not-member' }
  }
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

/** What the lead's role reads as; the lead plans the work and delegates subtasks. */
export const LEAD_ROLE_TEXT = 'orchestrator'

/**
 * The role a roster row plays, as the terminal names it.
 * @param member - the roster row.
 * @returns the lead's {@link LEAD_ROLE_TEXT}, a teammate's description (the responsibility
 * the lead gave it), or `teammate` when it has none.
 */
export function memberRoleText(member: Pick<TeamMemberRow, 'role' | 'description'>): string {
  if (member.role === 'lead') return LEAD_ROLE_TEXT
  const description = member.description?.trim()
  return description === undefined || description === '' ? 'teammate' : description
}

/**
 * Columns of a teammate's role that a view title keeps. The role is the
 * responsibility text the lead wrote, so it can be a paragraph; `/team` prints
 * it whole. A presentation choice of this terminal surface, not a deployment setting.
 */
export const TEAMMATE_TITLE_ROLE_COLUMNS = 28

/**
 * A member's role on one line.
 * @param member - the roster row.
 * @returns {@link memberRoleText} with every run of whitespace, line breaks included, collapsed to one space.
 */
function roleOneLine(member: Pick<TeamMemberRow, 'role' | 'description'>): string {
  return memberRoleText(member).replace(/\s+/gu, ' ')
}

/**
 * How the activity board labels a roster member.
 * @param member - the roster row.
 * @returns `<name> · <role>`; the board cuts it to its own width.
 */
export function memberLabel(member: Pick<TeamMemberRow, 'name' | 'role' | 'description'>): string {
  return `${member.name} · ${roleOneLine(member)}`
}

/**
 * What the header and the view banner call an open teammate session.
 * @param member - the teammate's roster row.
 * @returns `teammate <name> · <role>`, with the role cut to {@link TEAMMATE_TITLE_ROLE_COLUMNS} columns and `…`.
 */
export function teammateViewTitle(member: Pick<TeamMemberRow, 'name' | 'role' | 'description'>): string {
  return `teammate ${member.name} · ${truncateToWidth(roleOneLine(member), TEAMMATE_TITLE_ROLE_COLUMNS, '…')}`
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
