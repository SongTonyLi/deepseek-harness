/**
 * The division of work as a tree: one node per shared task with its owner and
 * the owner's own todo list beneath it, and one branch for the bound session's
 * own todo list. Each node carries one of five states derived from the task
 * board, the roster, the todo lists, and the task revisions the bound session
 * logged. Pure: the application supplies every read as a plain value.
 * @module @deepseek-ai/dsh-tui-app/work-tree
 */

import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { LEAD_ROLE_TEXT, memberRoleText } from './team.ts'
import type { TeamMemberRow, TeamTaskRow } from './team-panel.ts'
import { fields, type TeamLogEvent } from './team-play.ts'
import type { TodoTransition } from './todos.ts'

/**
 * What a node of the tree is doing.
 * - `delivered`: a completed task or todo.
 * - `in_progress`: being worked on by an owner whose turn is running.
 * - `stuck`: a pending task with an unfinished blocker, or an in-progress task whose owner failed or stopped.
 * - `deferred`: a task released or reopened back to pending, or an item still open after the turns that could advance it ended.
 * - `pending`: ready and not started.
 */
export type WorkState = 'delivered' | 'in_progress' | 'stuck' | 'deferred' | 'pending'

/** Every state, in the order a counts row lists them. */
export const WORK_STATES: readonly WorkState[] = ['delivered', 'in_progress', 'stuck', 'deferred', 'pending']

/** Why a node is `stuck` or `deferred`. */
export type WorkReason =
  /** A pending task waits on the tasks named in {@link WorkNode.waitsOn}. */
  | 'blocked'
  /** The owner of an in-progress task failed to start. */
  | 'owner_failed'
  /** The owner of an in-progress task has no running turn. */
  | 'owner_idle'
  /** An owner released the in-progress task back to pending. */
  | 'released'
  /** A completed task was reopened. */
  | 'reopened'
  /** The item is still open and no turn that could advance it is running. */
  | 'left_open'

/** Who is responsible for a node. */
export interface WorkOwner {
  /** Session id of the member, or undefined when the roster does not list the task's owner name. */
  id?: string
  /** Model-facing name. */
  name: string
  /** The role the terminal names for the member: `orchestrator`, the teammate's description, or `teammate`. */
  role: string
  /** Runtime status of the member; undefined when the roster does not list the owner. */
  status?: TeamMemberRow['status']
}

/** One node of the tree. */
export interface WorkNode {
  /**
   * Identity that is stable across redraws, so fold state, selection, and
   * fades can follow a node: `task:<id>` for a shared task, `own` for the
   * bound session's branch, and `<parent key>/todo:<content>` for a todo.
   */
  key: string
  /** A shared task, the branch that holds the bound session's own todo list, or one todo. */
  kind: 'task' | 'own' | 'todo'
  /** The task subject, the bound member's name, or the todo content. */
  title: string
  /**
   * The node's state. The `own` branch reports the first state in the order
   * `in_progress`, `deferred`, `pending`, `delivered` that one of its todos holds.
   */
  state: WorkState
  /** Why the node is stuck or deferred; absent for every other state. */
  reason?: WorkReason
  /** The task's owner, the bound member for the `own` branch, or the owner of the list a todo belongs to; absent for an unowned task. */
  owner?: WorkOwner
  /** Todos beneath a task or the `own` branch, in write order; always empty for a todo. */
  children: WorkNode[]
  /** Team-local id of a `task` node. */
  taskId?: string
  /** Body of a `task` node. */
  description?: string
  /** Ids of the unfinished tasks a `task` node waits on, in board order. */
  waitsOn?: string[]
  /** Ids of the tasks that are not deleted and wait on a `task` node, in board order. */
  blocks?: string[]
  /** Advisory write scopes of a `task` node. */
  writeScopes?: string[]
  /** What the owner of a `task` node last narrated. */
  note?: string
  /** The turns a todo of the `own` branch first appeared in and last changed status in, when the application tracked them. */
  turns?: TodoTransition
}

/** One `team/task` record reduced to the fields the state rules read. */
export interface TaskRevision {
  /** Team-local task id. */
  id: string
  /** The status this revision recorded. */
  status: TeamTaskRow['status']
  /** Session id of the owner this revision recorded, when it had one. */
  ownerId?: string
}

/** The plain reads one tree is built from. */
export interface WorkTreeInputs {
  /** Roster rows, the lead first. Empty outside a team. */
  members: readonly TeamMemberRow[]
  /** Shared tasks, deleted rows included; the tree drops those. Empty outside a team. */
  tasks: readonly TeamTaskRow[]
  /** Session id of the bound session, whose own todo list becomes the `own` branch. */
  boundId: string
  /** What the `own` branch is titled when the roster does not list the bound session. */
  boundName: string
  /** The bound session's current todo list. */
  ownTodos: readonly TodoItem[]
  /** Whether the bound session has an open turn. */
  ownTurnOpen: boolean
  /**
   * The current todo list of another member.
   * @param id - the member's session id.
   * @returns the list, or undefined when this process holds no live session for the member.
   */
  memberTodos(id: string): readonly TodoItem[] | undefined
  /** The `team/task` records the bound session logged, oldest first. Empty in a teammate's session, whose log holds none. */
  revisions: readonly TaskRevision[]
  /**
   * What a member last narrated.
   * @param id - the member's session id.
   * @returns the narration, or undefined when the member has said nothing.
   */
  note(id: string): string | undefined
  /**
   * The turn facts the application tracked for one of the bound session's todos.
   * @param content - the todo content.
   * @returns the facts, or undefined when none were tracked.
   */
  turns(content: string): TodoTransition | undefined
}

/** The tree and its counts. */
export interface WorkTree {
  /** Top-level nodes: every shared task that is not deleted in board order, then the `own` branch when the bound session has a todo. */
  nodes: WorkNode[]
  /**
   * How many counted items hold each state. The counted items are the shared
   * tasks and the todos of the `own` branch; a teammate's todos beneath a
   * task are not counted, since their task already is.
   */
  counts: Record<WorkState, number>
  /** How many counted items the tree has. */
  total: number
}

/**
 * The role of an owner that a team roster does not list; the word
 * {@link memberRoleText} gives a teammate without a description.
 */
const UNLISTED_OWNER_ROLE = 'teammate'

/** Every status a `team/task` record can carry. */
const TASK_STATUSES: readonly TeamTaskRow['status'][] = ['pending', 'in_progress', 'completed', 'deleted']

/** A shared task that is not deleted. */
type LiveTask = TeamTaskRow & { status: Exclude<TeamTaskRow['status'], 'deleted'> }

/** The states a todo can hold; a todo is never stuck. */
type TodoState = Exclude<WorkState, 'stuck'>

/** A node's state and, for a stuck or deferred node, why. */
interface Verdict<S extends WorkState = WorkState> {
  state: S
  reason?: WorkReason
}

/** A task's verdict and, for a blocked task, the tasks it waits on. */
interface TaskVerdict extends Verdict {
  waitsOn?: string[]
}

/** Rank of each todo state in the `own` branch's state; the lowest rank one of its todos holds wins. */
const BRANCH_RANK: Record<TodoState, number> = { in_progress: 0, deferred: 1, pending: 2, delivered: 3 }

/** The board-wide facts every task node reads, computed once per tree. */
interface Board {
  /** The reads the tree is built from. */
  readonly inputs: WorkTreeInputs
  /** The tasks that are not deleted, in board order. */
  readonly tasks: readonly LiveTask[]
  /** Whether a turn that can advance a pending task runs: the bound session's, or a running or provisioning member's. */
  readonly advancing: boolean
  /** The statuses each task's revisions recorded, oldest first, by task id. */
  readonly history: ReadonlyMap<string, readonly TeamTaskRow['status'][]>
  /** The in-progress task each member's todo list goes beneath, by member session id. */
  readonly holders: ReadonlyMap<string, { readonly taskId: string; readonly claim: number }>
}

/**
 * The division of work as a tree.
 *
 * Deleted tasks are dropped everywhere. Each other task becomes a `task` node
 * in board order, in one of these states:
 * - `completed`: `delivered`.
 * - `in_progress`: when the owner is the bound session, `in_progress` while
 *   `ownTurnOpen`, else `stuck` (`owner_idle`). Otherwise by the owner's
 *   roster status: `running` or `provisioning` is `in_progress`, `failed` is
 *   `stuck` (`owner_failed`), `inactive` is `stuck` (`owner_idle`). A task
 *   without an owner, or whose owner name the roster does not list, is
 *   `in_progress`.
 * - `pending`: `stuck` (`blocked`) while `blockedBy` names a task that is not
 *   deleted; else `deferred` (`released` or `reopened`) when its newest
 *   revisions are `pending` and the revision before them is `in_progress` or
 *   `completed`; else `deferred` (`left_open`) when `ownTurnOpen` is false and
 *   no member is `running` or `provisioning`; else `pending`.
 *
 * A task node always carries `blocks` and `writeScopes`; it carries
 * `waitsOn` only while it is `stuck` for `blocked`, and `note` only when
 * its owner has a session id and has narrated. Owners are matched by
 * `ownerName` against roster names.
 *
 * A member other than the bound session gets its todo list beneath one
 * in-progress task it owns: the one whose `in_progress` revision naming the
 * member as owner comes last in `inputs.revisions`, else the first in board
 * order. The bound session's list appears only in the `own` branch. A todo is
 * `delivered` when completed; an open todo keeps its status while the owner's
 * turn runs (`running` for a member, `ownTurnOpen` for the bound session),
 * else it is `deferred` (`left_open`).
 *
 * The `own` branch follows the tasks when `ownTodos` is not empty. It is
 * titled with the bound member's roster name, else `boundName`. When the
 * roster does not list the bound session, its owner role is
 * {@link LEAD_ROLE_TEXT} for a session without a team (an empty roster) and
 * `teammate` otherwise. A `deferred` branch carries the `left_open` reason.
 * @param inputs - the reads; none is mutated.
 * @returns the nodes and the counts, in fresh arrays and objects.
 */
export function workTree(inputs: WorkTreeInputs): WorkTree {
  const tasks = inputs.tasks.filter(isLive)
  const board: Board = {
    inputs,
    tasks,
    advancing: inputs.ownTurnOpen || inputs.members.some(member => member.status === 'running' || member.status === 'provisioning'),
    history: statusHistory(inputs.revisions),
    holders: todoHolders(inputs, tasks),
  }
  const nodes = tasks.map(task => taskNode(task, board))
  const counts: Record<WorkState, number> = { delivered: 0, in_progress: 0, stuck: 0, deferred: 0, pending: 0 }
  const counted = [...nodes]
  const own = ownBranch(inputs)
  if (own !== undefined) {
    nodes.push(own)
    counted.push(...own.children)
  }
  for (const node of counted) counts[node.state] += 1
  return { nodes, counts, total: counted.length }
}

/**
 * The task revisions a session log recorded.
 *
 * Only `team/task` events are read. A record is skipped unless its `task`
 * field is an object with a non-empty string `id` and a known `status`; a
 * non-empty string `ownerId` is kept and any other value is left out.
 * @param events - the log events, oldest first.
 * @returns one revision per readable `team/task` record, oldest first.
 */
export function taskRevisions(events: readonly TeamLogEvent[]): TaskRevision[] {
  const revisions: TaskRevision[] = []
  for (const event of events) {
    if (event.type !== 'team/task') continue
    const task = fields(fields(event.data)?.task)
    if (task === undefined) continue
    const id = identifier(task.id)
    const status = TASK_STATUSES.find(candidate => candidate === task.status)
    if (id === undefined || status === undefined) continue
    const ownerId = identifier(task.ownerId)
    revisions.push({ id, status, ...ownerId === undefined ? {} : { ownerId } })
  }
  return revisions
}

/**
 * Whether a task is on the board.
 * @param task - the task row.
 * @returns true unless the task is deleted.
 */
function isLive(task: TeamTaskRow): task is LiveTask {
  return task.status !== 'deleted'
}

/**
 * The roster row an owner name names.
 * @param members - the roster.
 * @param name - the owner name, if the task has one.
 * @returns the first member with that name, or undefined when `name` is absent or not listed.
 */
function memberNamed(members: readonly TeamMemberRow[], name: string | undefined): TeamMemberRow | undefined {
  return name === undefined ? undefined : members.find(member => member.name === name)
}

/**
 * A roster row as an owner.
 * @param member - the roster row.
 * @returns the member's id, name, role text, and status.
 */
function ownerOf(member: TeamMemberRow): WorkOwner {
  return { id: member.id, name: member.name, role: memberRoleText(member), status: member.status }
}

/**
 * The statuses each task's revisions recorded.
 * @param revisions - the revisions, oldest first.
 * @returns the statuses, oldest first, by task id.
 */
function statusHistory(revisions: readonly TaskRevision[]): Map<string, TeamTaskRow['status'][]> {
  const history = new Map<string, TeamTaskRow['status'][]>()
  for (const revision of revisions) {
    const statuses = history.get(revision.id)
    if (statuses === undefined) history.set(revision.id, [revision.status])
    else statuses.push(revision.status)
  }
  return history
}

/**
 * The in-progress task each member other than the bound session gets its todo
 * list beneath.
 * @param inputs - the reads.
 * @param tasks - the tasks that are not deleted, in board order.
 * @returns by member session id, the task whose newest `in_progress` revision
 *   with that member as owner is latest in `inputs.revisions` (`claim` is its
 *   index), else the member's first in-progress task in board order (`claim` -1).
 */
function todoHolders(inputs: WorkTreeInputs, tasks: readonly LiveTask[]): Map<string, { taskId: string; claim: number }> {
  const claims = new Map<string, Map<string, number>>()
  for (const [index, revision] of inputs.revisions.entries()) {
    if (revision.status !== 'in_progress' || revision.ownerId === undefined) continue
    const owned = claims.get(revision.ownerId) ?? new Map<string, number>()
    owned.set(revision.id, index)
    claims.set(revision.ownerId, owned)
  }
  const holders = new Map<string, { taskId: string; claim: number }>()
  for (const task of tasks) {
    if (task.status !== 'in_progress') continue
    const member = memberNamed(inputs.members, task.ownerName)
    if (member === undefined || member.id === inputs.boundId) continue
    const claim = claims.get(member.id)?.get(task.id) ?? -1
    const held = holders.get(member.id)
    if (held === undefined || claim > held.claim) holders.set(member.id, { taskId: task.id, claim })
  }
  return holders
}

/**
 * One task as a node.
 * @param task - the task.
 * @param board - the board-wide facts.
 * @returns the `task` node with its owner's todo list beneath it when it holds that list.
 */
function taskNode(task: LiveTask, board: Board): WorkNode {
  const member = memberNamed(board.inputs.members, task.ownerName)
  const { owner, children } = taskOwnership(task, member, board)
  const note = member === undefined ? undefined : board.inputs.note(member.id)
  return {
    key: `task:${task.id}`,
    kind: 'task',
    title: task.subject,
    ...taskVerdict(task, member, board),
    ...owner === undefined ? {} : { owner },
    children,
    taskId: task.id,
    description: task.description,
    blocks: board.tasks.filter(other => other.blockedBy.includes(task.id)).map(other => other.id),
    writeScopes: [...task.writeScopes],
    ...note === undefined ? {} : { note },
  }
}

/**
 * A task's owner and the owner's todo list beneath it.
 * @param task - the task.
 * @param member - the roster row of the task's owner, when the roster lists it.
 * @param board - the board-wide facts.
 * @returns no owner for an unowned task; a `teammate` owner without an id or a
 *   status for an owner name the roster does not list; otherwise the member,
 *   with its todo list when this task holds that list.
 */
function taskOwnership(task: LiveTask, member: TeamMemberRow | undefined, board: Board): { owner?: WorkOwner; children: WorkNode[] } {
  if (member === undefined) {
    return task.ownerName === undefined ? { children: [] } : { owner: { name: task.ownerName, role: UNLISTED_OWNER_ROLE }, children: [] }
  }
  const owner = ownerOf(member)
  const listed = board.holders.get(member.id)?.taskId === task.id ? board.inputs.memberTodos(member.id) ?? [] : []
  const running = member.status === 'running'
  return {
    owner,
    children: listed.map(item => todoNode(item, `task:${task.id}`, owner, todoVerdict(item.status, running), undefined)),
  }
}

/**
 * A task's state.
 * @param task - the task.
 * @param member - the roster row of the task's owner, when the roster lists it.
 * @param board - the board-wide facts.
 * @returns the state, the reason when stuck or deferred, and the ids it waits on when blocked.
 */
function taskVerdict(task: LiveTask, member: TeamMemberRow | undefined, board: Board): TaskVerdict {
  switch (task.status) {
    case 'completed':
      return { state: 'delivered' }
    case 'in_progress':
      return member === undefined ? { state: 'in_progress' } : ownerVerdict(member, board.inputs)
    case 'pending':
      return pendingVerdict(task, board)
    /* v8 ignore next 2 -- LiveTask['status'] is closed and every variant is handled above. */
    default:
      return assertNever(task.status, 'work tree task status')
  }
}

/**
 * The state of an in-progress task whose owner the roster lists.
 * @param member - the owner's roster row.
 * @param inputs - the reads.
 * @returns `in_progress` while the owner's turn runs or is starting, else `stuck` with why.
 */
function ownerVerdict(member: TeamMemberRow, inputs: WorkTreeInputs): Verdict {
  if (member.id === inputs.boundId) {
    return inputs.ownTurnOpen ? { state: 'in_progress' } : { state: 'stuck', reason: 'owner_idle' }
  }
  switch (member.status) {
    case 'running':
    case 'provisioning':
      return { state: 'in_progress' }
    case 'failed':
      return { state: 'stuck', reason: 'owner_failed' }
    case 'inactive':
      return { state: 'stuck', reason: 'owner_idle' }
    /* v8 ignore next 2 -- TeamMemberRow['status'] is closed and every variant is handled above. */
    default:
      return assertNever(member.status, 'work tree member status')
  }
}

/**
 * The state of a pending task.
 * @param task - the pending task.
 * @param board - the board-wide facts.
 * @returns `stuck` with the ids it waits on, `deferred` with why, or `pending`.
 */
function pendingVerdict(task: LiveTask, board: Board): TaskVerdict {
  const blockers = new Set(task.blockedBy)
  const waitsOn = board.tasks.filter(other => blockers.has(other.id)).map(other => other.id)
  if (waitsOn.length > 0) return { state: 'stuck', reason: 'blocked', waitsOn }
  const returned = returnReason(board.history.get(task.id) ?? [])
  if (returned !== undefined) return { state: 'deferred', reason: returned }
  return board.advancing ? { state: 'pending' } : { state: 'deferred', reason: 'left_open' }
}

/**
 * Why a pending task came back to pending.
 * @param statuses - the statuses the task's revisions recorded, oldest first.
 * @returns `released` or `reopened` when the newest revisions are `pending`
 *   and the revision before them is `in_progress` or `completed`; otherwise
 *   undefined, including for a task that was always pending and for revisions
 *   whose newest status is not `pending`.
 */
function returnReason(statuses: readonly TeamTaskRow['status'][]): WorkReason | undefined {
  const settled = statuses.findLastIndex(status => status !== 'pending')
  if (settled === statuses.length - 1) return undefined
  const before = statuses[settled]
  if (before === 'in_progress') return 'released'
  return before === 'completed' ? 'reopened' : undefined
}

/**
 * A todo's state.
 * @param status - the todo's status.
 * @param running - whether the turn of the list's owner runs.
 * @returns `delivered` for a completed todo; an open todo keeps its status while the turn runs, else it is `deferred` (`left_open`).
 */
function todoVerdict(status: TodoItem['status'], running: boolean): Verdict<TodoState> {
  switch (status) {
    case 'completed':
      return { state: 'delivered' }
    case 'in_progress':
    case 'pending':
      return running ? { state: status } : { state: 'deferred', reason: 'left_open' }
    /* v8 ignore next 2 -- TodoItem['status'] is closed and every variant is handled above. */
    default:
      return assertNever(status, 'work tree todo status')
  }
}

/**
 * One todo as a node.
 * @param item - the todo.
 * @param parent - the key of the node it sits beneath.
 * @param owner - the owner of the list.
 * @param verdict - the todo's state.
 * @param turns - the turn facts tracked for the todo, if any.
 * @returns the `todo` node.
 */
function todoNode(item: TodoItem, parent: string, owner: WorkOwner, verdict: Verdict, turns: TodoTransition | undefined): WorkNode {
  return {
    key: `${parent}/todo:${item.content}`,
    kind: 'todo',
    title: item.content,
    ...verdict,
    owner,
    children: [],
    ...turns === undefined ? {} : { turns },
  }
}

/**
 * The branch that holds the bound session's own todo list.
 * @param inputs - the reads.
 * @returns the `own` node, or undefined when the list is empty.
 */
function ownBranch(inputs: WorkTreeInputs): WorkNode | undefined {
  if (inputs.ownTodos.length === 0) return undefined
  const bound = inputs.members.find(member => member.id === inputs.boundId)
  const owner: WorkOwner = bound === undefined
    ? { id: inputs.boundId, name: inputs.boundName, role: inputs.members.length === 0 ? LEAD_ROLE_TEXT : UNLISTED_OWNER_ROLE }
    : ownerOf(bound)
  const rows = inputs.ownTodos.map(item => ({ item, verdict: todoVerdict(item.status, inputs.ownTurnOpen) }))
  const lead = rows.reduce((best, next) => BRANCH_RANK[next.verdict.state] < BRANCH_RANK[best.verdict.state] ? next : best)
  return {
    key: 'own',
    kind: 'own',
    title: owner.name,
    ...lead.verdict,
    owner,
    children: rows.map(({ item, verdict }) => todoNode(item, 'own', owner, verdict, inputs.turns(item.content))),
  }
}

/**
 * A non-empty string field.
 * @param value - the candidate.
 * @returns the string unchanged, or undefined when it is empty or not a string.
 */
function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
