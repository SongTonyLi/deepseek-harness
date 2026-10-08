/** `/workflows` picker rows: run rows, member rows, and a member's detail page. */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolWorkflowAgentStartData, ToolWorkflowRunStartData } from '@deepseek-ai/dsh-tool-workflow/types'
import {
  findWorkflowMember,
  memberOpenable,
  workflowMemberChoices,
  workflowMemberDetail,
  workflowRunChoice,
  workflowRunSummary,
} from '../src/workflow-panel.ts'
import { foldWorkflowRun, projectWorkflowRun, workflowProgress, type WorkflowRunEvent, type WorkflowRunView } from '../src/workflow.ts'

const runId = 'run-1' as ToolWorkflowRunStartData['runId']
const child = (id: string): ToolWorkflowAgentStartData['childId'] => id as ToolWorkflowAgentStartData['childId']

/** Fold events into a projected run. */
function view(events: readonly WorkflowRunEvent[]): WorkflowRunView {
  const state = events.reduce<ReturnType<typeof foldWorkflowRun>>((current, event) => foldWorkflowRun(current, event), undefined)
  if (state === undefined) throw new Error('workflow fixture never started')
  return projectWorkflowRun(state)
}

const run = view([
  { type: 'tool-workflow/run-start', data: { runId, name: 'audit' } },
  { type: 'tool-workflow/agent-start', data: { runId, seq: 1, label: 'reader', phase: 'scan', childId: child('session-1') } },
  { type: 'tool-workflow/agent-start', data: { runId, seq: 2, label: '', childId: child('session-2') } },
  { type: 'tool-workflow/agent-start', data: { runId, seq: 3, label: 'fixer', phase: 'scan', childId: child('session-3') } },
  { type: 'tool-workflow/agent-end', data: { runId, seq: 3, outcome: 'failed' } },
])

describe('workflow picker rows', () => {
  it('summarizes a run with its settled members, phases, and owning job', () => {
    expect(workflowProgress(run)).toEqual({
      total: 3,
      settled: 1,
      counts: { running: 2, completed: 0, failed: 1, cancelled: 0, interrupted: 0 },
    })
    expect(workflowRunSummary(run)).toBe('running · 1/3 members settled · 2 phases')
    expect(workflowRunChoice('0', run, 'workflow-1')).toEqual({
      value: '0',
      label: '◇ audit',
      description: 'running · 1/3 members settled · 2 phases · job workflow-1',
    })
    const single = view([{ type: 'tool-workflow/run-start', data: { runId, name: 'solo' } }, { type: 'tool-workflow/run-end', data: { runId, stopReason: 'error' } }])
    expect(workflowRunChoice('1', single, undefined)).toEqual({ value: '1', label: '✗ solo', description: 'failed · 0/0 members settled · 0 phases' })
    const phased = view([
      { type: 'tool-workflow/run-start', data: { runId, name: 'one' } },
      { type: 'tool-workflow/agent-start', data: { runId, seq: 1, label: 'a', phase: 'p', childId: child('session-a') } },
    ])
    expect(workflowRunSummary(phased)).toBe('running · 0/1 members settled · 1 phase')
  })

  it('lists members by phase and marks the ones a running child can open', () => {
    const openable: ReadonlySet<SessionId> = new Set([child('session-1'), child('session-3')])
    expect(workflowMemberChoices(run, openable)).toEqual([
      { value: '1', label: '◇ reader', description: 'scan · running · Enter opens' },
      { value: '3', label: '✗ fixer', description: 'scan · failed' },
      { value: '2', label: '◇ (unnamed member)', description: 'unassigned · running' },
    ])
    const found = findWorkflowMember(run, '3')
    expect(found?.phase).toBe('scan')
    expect(found !== undefined && memberOpenable(found.member, openable)).toBe(false)
    expect(findWorkflowMember(run, '9')).toBeUndefined()
  })

  it('details one member with its run, phase, status, and child', () => {
    const found = findWorkflowMember(run, '2')
    if (found === undefined) throw new Error('member 2 missing')
    expect(workflowMemberDetail(run, found.member, found.phase)).toEqual([
      'workflow  audit (running)',
      'phase     unassigned',
      'member    #2 (unnamed member)',
      'status    running',
      'child     session-2',
    ])
  })
})
