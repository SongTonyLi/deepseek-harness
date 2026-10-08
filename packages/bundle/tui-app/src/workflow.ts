/**
 * Pure replay and presentation for durable tool-workflow runs. Consumers keep
 * each state under its run id; this module owns no mutable run registry.
 * @module @deepseek-ai/dsh-tui-app/workflow
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  ToolWorkflowAgentEndData, ToolWorkflowAgentStartData,
  ToolWorkflowRunEndData, ToolWorkflowRunStartData,
} from '@deepseek-ai/dsh-tool-workflow/types'

/** Status shown for a workflow run or one of its members. */
export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

/** Durable state for a workflow member that started. */
export interface WorkflowRunMemberState {
  /** Sequence number assigned when the member started. */
  readonly seq: number
  /** Display label assigned when the member started. */
  readonly label: string
  /** Child Session id published when the member started. */
  readonly childId: ToolWorkflowAgentStartData['childId']
  /** Exact phase title; omitted when the durable event omitted it. */
  readonly phase?: string
  /** Terminal member outcome, omitted while the member has not ended. */
  readonly outcome?: ToolWorkflowAgentEndData['outcome']
}

/** Durable state for one externally keyed workflow run. */
export interface WorkflowRunState {
  /** Stable id used by the caller's run-state map. */
  readonly runId: ToolWorkflowRunStartData['runId']
  /** Display name recorded when the run started. */
  readonly name: string
  /** Terminal reason, omitted while the run has not ended. */
  readonly stopReason?: ToolWorkflowRunEndData['stopReason']
  /** Members in durable agent-start event order. */
  readonly members: readonly WorkflowRunMemberState[]
}

/** A durable tool-workflow event accepted by {@link foldWorkflowRun}. */
export type WorkflowRunEvent =
  | { readonly type: 'tool-workflow/run-start'; readonly data: ToolWorkflowRunStartData }
  | { readonly type: 'tool-workflow/agent-start'; readonly data: ToolWorkflowAgentStartData }
  | { readonly type: 'tool-workflow/agent-end'; readonly data: ToolWorkflowAgentEndData }
  | { readonly type: 'tool-workflow/run-end'; readonly data: ToolWorkflowRunEndData }

/** Display data for one workflow member. */
export interface WorkflowRunMemberView {
  /** Sequence number assigned when the member started. */
  readonly seq: number
  /** Display label assigned when the member started. */
  readonly label: string
  /** Child Session id published when the member started. */
  readonly childId: ToolWorkflowAgentStartData['childId']
  /** Derived member status. */
  readonly status: WorkflowRunStatus
}

/** Display data for one exact phase identity. */
export interface WorkflowRunPhaseView {
  /** Collision-free stable phase key. */
  readonly key: string
  /** Phase title, or null when the member event omitted the phase. */
  readonly phase: string | null
  /** Members in agent-start event order for this phase. */
  readonly members: readonly WorkflowRunMemberView[]
}

/** Display data for one workflow run. */
export interface WorkflowRunView {
  /** Stable id of the externally keyed run. */
  readonly runId: WorkflowRunState['runId']
  /** Display name recorded when the run started. */
  readonly name: string
  /** Derived run status. */
  readonly status: WorkflowRunStatus
  /** Phases in first-member-start order. */
  readonly phases: readonly WorkflowRunPhaseView[]
}

/** Options controlling presentation after durable replay. */
export interface WorkflowRunProjectionOptions {
  /** Show unfinished runs and members as interrupted instead of running. */
  readonly markUnfinishedInterrupted?: boolean
}

/**
 * Build a collision-free key for an exact phase identity.
 * @param phase - phase title, or null when a member event omitted it.
 * @returns a stable key distinct for null, empty, and every non-empty phase title.
 */
export function workflowPhaseKey(phase: string | null): string {
  return phase === null ? 'missing' : `value:${String(phase.length)}:${phase}`
}

/**
 * Fold one durable event into an externally owned workflow run state.
 * @param state - state stored under the event's run id, or undefined before its start.
 * @param event - durable workflow event to replay.
 * @returns the created or updated state, or undefined when an update arrives before a start.
 * Events for another run and unmatched member endings leave an existing state unchanged.
 */
export function foldWorkflowRun(
  state: WorkflowRunState | undefined,
  event: WorkflowRunEvent,
): WorkflowRunState | undefined {
  if (event.type === 'tool-workflow/run-start') {
    return state ?? {
      runId: event.data.runId,
      name: event.data.name,
      members: [],
    }
  }
  if (state === undefined || state.runId !== event.data.runId) return state
  switch (event.type) {
    case 'tool-workflow/agent-start':
      return {
        ...state,
        members: [...state.members, {
          seq: event.data.seq,
          label: event.data.label,
          childId: event.data.childId,
          ...event.data.phase === undefined ? {} : { phase: event.data.phase },
        }],
      }
    case 'tool-workflow/agent-end':
      return settleMember(state, event.data)
    case 'tool-workflow/run-end':
      return { ...state, stopReason: event.data.stopReason }
    /* v8 ignore next -- WorkflowRunEvent is closed and every update event is handled above. */
    default:
      return assertNever(event, 'workflow run event')
  }
}

/**
 * Project durable workflow state for terminal presentation.
 * @param state - replayed workflow run state.
 * @param options - caller-selected handling for unfinished records.
 * @returns ordered phase and member data with derived statuses.
 */
export function projectWorkflowRun(
  state: WorkflowRunState,
  options: WorkflowRunProjectionOptions = {},
): WorkflowRunView {
  const interrupted = state.stopReason === undefined && options.markUnfinishedInterrupted === true
  const phases = new Map<string, { phase: string | null; members: WorkflowRunMemberView[] }>()
  for (const member of state.members) {
    const phase = member.phase === undefined ? null : member.phase
    const key = workflowPhaseKey(phase)
    let group = phases.get(key)
    if (group === undefined) {
      group = { phase, members: [] }
      phases.set(key, group)
    }
    group.members.push({
      seq: member.seq,
      label: member.label,
      childId: member.childId,
      status: member.outcome === undefined
        ? interrupted ? 'interrupted' : 'running'
        : statusFromOutcome(member.outcome),
    })
  }
  return {
    runId: state.runId,
    name: state.name,
    status: state.stopReason === undefined
      ? interrupted ? 'interrupted' : 'running'
      : statusFromStopReason(state.stopReason),
    phases: [...phases].map(([key, group]) => ({
      key,
      phase: group.phase,
      members: group.members,
    })),
  }
}

/**
 * Readable terminal label for an exact phase identity.
 * @param phase - phase title, or null when the member event omitted it.
 * @returns the title, or a placeholder for an empty or omitted one.
 */
export function workflowPhaseName(phase: string | null): string {
  if (phase === null) return 'unassigned'
  return phase === '' ? '(empty phase)' : phase
}

/**
 * Readable terminal label for a workflow member label.
 * @param label - the label the member started with.
 * @returns the label, or a placeholder for an empty one.
 */
export function workflowMemberName(label: string): string {
  return label === '' ? '(unnamed member)' : label
}

/** Member counts of one workflow run, by derived status. */
export interface WorkflowRunProgress {
  /** Members that started, in every phase. */
  readonly total: number
  /** Members that reached any status other than running. */
  readonly settled: number
  /** Started members per derived status; a status no member holds counts 0. */
  readonly counts: Readonly<Record<WorkflowRunStatus, number>>
}

/**
 * Count the started members of one run by status.
 * @param view - projected workflow run.
 * @returns totals over every phase.
 */
export function workflowProgress(view: WorkflowRunView): WorkflowRunProgress {
  const counts: Record<WorkflowRunStatus, number> = { running: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 }
  let total = 0
  for (const phase of view.phases) {
    for (const member of phase.members) {
      counts[member.status] += 1
      total += 1
    }
  }
  return { total, settled: total - counts.running, counts }
}

function settleMember(state: WorkflowRunState, data: ToolWorkflowAgentEndData): WorkflowRunState {
  const index = state.members.findIndex(member => member.seq === data.seq)
  if (index === -1) return state
  return {
    ...state,
    members: state.members.map((member, memberIndex) => memberIndex === index
      ? { ...member, outcome: data.outcome }
      : member),
  }
}

function statusFromStopReason(stopReason: ToolWorkflowRunEndData['stopReason']): WorkflowRunStatus {
  switch (stopReason) {
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'error': return 'failed'
    /* v8 ignore next -- WorkflowStopReason is closed and every variant is handled above. */
    default: return assertNever(stopReason, 'workflow stop reason')
  }
}

function statusFromOutcome(outcome: ToolWorkflowAgentEndData['outcome']): WorkflowRunStatus {
  switch (outcome) {
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'failed': return 'failed'
    /* v8 ignore next -- WorkflowAgentOutcome is closed and every variant is handled above. */
    default: return assertNever(outcome, 'workflow agent outcome')
  }
}
