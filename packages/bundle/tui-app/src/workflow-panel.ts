/**
 * Rows of the `/workflows` pickers: one row per workflow run of the bound
 * session, one row per started member of a run, and a member's detail page.
 * Pure: the application reads the projections, the owning jobs, and the
 * openable children, and hands them in.
 * @module @deepseek-ai/dsh-tui-app/workflow-panel
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PickItem } from './prompts.ts'
import {
  workflowMemberName,
  workflowPhaseName,
  workflowProgress,
  type WorkflowRunMemberView,
  type WorkflowRunView,
} from './workflow.ts'

/** Dim row under the run picker's heading, naming its keys. */
export const WORKFLOWS_PICKER_HINT = 'Enter lists the members · Ctrl+K stops a background run'

/** Dim row under a member picker's heading, naming its keys. */
export const WORKFLOW_MEMBERS_HINT = 'Enter opens a running member, or shows a settled one'

/** Glyph each status row in the pickers starts with. */
const STATUS_GLYPH: Readonly<Record<WorkflowRunView['status'], string>> = {
  running: '◇',
  completed: '✓',
  failed: '✗',
  cancelled: '⊘',
  interrupted: '⊘',
}

/**
 * One run row of the run picker.
 * @param value - the run's picker value.
 * @param view - the run's newest projection.
 * @param jobId - the background job that owns the run, when one does.
 * @returns the picker row.
 */
export function workflowRunChoice(value: string, view: WorkflowRunView, jobId: string | undefined): PickItem {
  return {
    value,
    label: `${STATUS_GLYPH[view.status]} ${view.name}`,
    description: [workflowRunSummary(view), ...jobId === undefined ? [] : [`job ${jobId}`]].join(' · '),
  }
}

/**
 * The status, settled members, and phase count of one run.
 * @param view - the run's newest projection.
 * @returns e.g. `running · 2/5 members settled · 2 phases`.
 */
export function workflowRunSummary(view: WorkflowRunView): string {
  const progress = workflowProgress(view)
  const phases = view.phases.length
  return `${view.status} · ${String(progress.settled)}/${String(progress.total)} members settled · ${String(phases)} phase${phases === 1 ? '' : 's'}`
}

/**
 * One row per started member, in phase then start order.
 * @param view - the run's newest projection.
 * @param openable - direct children that are running in this process.
 * @returns the picker rows, each valued by the member's sequence number.
 */
export function workflowMemberChoices(view: WorkflowRunView, openable: ReadonlySet<SessionId>): PickItem[] {
  return view.phases.flatMap(phase => phase.members.map(member => ({
    value: String(member.seq),
    label: `${STATUS_GLYPH[member.status]} ${workflowMemberName(member.label)}`,
    description: [
      workflowPhaseName(phase.phase),
      member.status,
      ...memberOpenable(member, openable) ? ['Enter opens'] : [],
    ].join(' · '),
  })))
}

/**
 * Find one member of a run by its picker value.
 * @param view - the run's newest projection.
 * @param value - the member row's value.
 * @returns the member and its phase title, or undefined when none matches.
 */
export function findWorkflowMember(
  view: WorkflowRunView,
  value: string,
): { readonly member: WorkflowRunMemberView; readonly phase: string | null } | undefined {
  for (const phase of view.phases) {
    const member = phase.members.find(candidate => String(candidate.seq) === value)
    if (member !== undefined) return { member, phase: phase.phase }
  }
  return undefined
}

/**
 * Whether a member row can open its child Session as a live view.
 * @param member - the member.
 * @param openable - direct children that are running in this process.
 * @returns true while the member runs and its child is resident here.
 */
export function memberOpenable(member: WorkflowRunMemberView, openable: ReadonlySet<SessionId>): boolean {
  return member.status === 'running' && openable.has(member.childId)
}

/**
 * The detail page of one member.
 * @param view - the run the member belongs to.
 * @param member - the member.
 * @param phase - the member's phase title, or null when its start omitted one.
 * @returns the page rows.
 */
export function workflowMemberDetail(view: WorkflowRunView, member: WorkflowRunMemberView, phase: string | null): string[] {
  return [
    `workflow  ${view.name} (${view.status})`,
    `phase     ${workflowPhaseName(phase)}`,
    `member    #${String(member.seq)} ${workflowMemberName(member.label)}`,
    `status    ${member.status}`,
    `child     ${member.childId}`,
  ]
}
