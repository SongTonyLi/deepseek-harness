/** Durable workflow folding and the status projection the transcript renders. */

import { describe, expect, it } from 'vitest'
import type {
  ToolWorkflowAgentEndData,
  ToolWorkflowAgentStartData,
  ToolWorkflowRunEndData,
  ToolWorkflowRunStartData,
} from '@deepseek-ai/dsh-tool-workflow/types'
import {
  foldWorkflowRun,
  projectWorkflowRun,
  workflowPhaseKey,
  type WorkflowRunEvent,
  type WorkflowRunState,
} from '../src/workflow.ts'

const runId = 'run-1' as ToolWorkflowRunStartData['runId']
const otherId = 'run-2' as ToolWorkflowRunStartData['runId']

/** One run-start record. */
function started(name = 'audit', id: ToolWorkflowRunStartData['runId'] = runId): WorkflowRunEvent {
  return { type: 'tool-workflow/run-start', data: { runId: id, name } }
}

/** One member start. An omitted phase stays omitted; an empty string is kept. */
function member(
  seq: number,
  label: string,
  phase?: string,
  childId: ToolWorkflowAgentStartData['childId'] = `session-${String(seq)}` as ToolWorkflowAgentStartData['childId'],
): WorkflowRunEvent {
  return {
    type: 'tool-workflow/agent-start',
    data: {
      runId,
      seq,
      label,
      childId,
      ...phase === undefined ? {} : { phase },
    },
  }
}

/** One member settlement. */
function ended(seq: number, outcome: ToolWorkflowAgentEndData['outcome']): WorkflowRunEvent {
  return { type: 'tool-workflow/agent-end', data: { runId, seq, outcome } }
}

/** One run settlement. */
function stopped(stopReason: ToolWorkflowRunEndData['stopReason']): WorkflowRunEvent {
  return { type: 'tool-workflow/run-end', data: { runId, stopReason } }
}

/** Fold a sequence, starting from nothing. */
function fold(events: readonly WorkflowRunEvent[]): WorkflowRunState | undefined {
  return events.reduce<WorkflowRunState | undefined>((state, event) => foldWorkflowRun(state, event), undefined)
}

describe('workflow run folding', () => {
  it('keeps an omitted phase distinct from an empty one and preserves start order', () => {
    expect(workflowPhaseKey(null)).toBe('missing')
    expect(workflowPhaseKey('')).toBe('value:0:')
    expect(workflowPhaseKey('scan')).toBe('value:4:scan')

    const state = fold([
      started(),
      member(1, 'first', 'scan'),
      member(2, 'second'),
      member(3, 'third', ''),
      member(4, 'fourth', 'scan'),
    ])
    expect(state?.members.map(item => item.phase)).toEqual(['scan', undefined, '', 'scan'])
    expect(state?.members[1]).not.toHaveProperty('phase')

    const view = projectWorkflowRun(state!)
    expect(view.phases.map(phase => phase.phase)).toEqual(['scan', null, ''])
    expect(view.phases[0]?.members.map(item => item.label)).toEqual(['first', 'fourth'])
    expect(view.phases[1]?.members.map(item => item.seq)).toEqual([2])
    expect(view.status).toBe('running')
    expect(view.phases[0]?.members[0]?.status).toBe('running')
  })

  it('projects a run with no members as still running', () => {
    const view = projectWorkflowRun(fold([started()])!)
    expect(view.phases).toEqual([])
    expect(view.status).toBe('running')
    expect(projectWorkflowRun(fold([started()])!, { markUnfinishedInterrupted: true }).status).toBe('interrupted')
  })

  it('maps member outcomes and run stop reasons', () => {
    const state = fold([
      started(),
      member(1, 'done'),
      ended(1, 'completed'),
      member(2, 'stopped'),
      ended(2, 'cancelled'),
      member(3, 'broken'),
      ended(3, 'failed'),
      member(4, 'open'),
      stopped('completed'),
    ])
    const view = projectWorkflowRun(state!)
    expect(view.status).toBe('completed')
    expect(view.phases[0]?.members.map(item => item.status)).toEqual(['completed', 'cancelled', 'failed', 'running'])

    expect(projectWorkflowRun(fold([started(), stopped('cancelled')])!).status).toBe('cancelled')
    expect(projectWorkflowRun(fold([started(), stopped('error')])!).status).toBe('failed')
  })

  it('interrupts only the unfinished records a caller opts in', () => {
    const state = fold([
      started(),
      member(1, 'done'),
      ended(1, 'completed'),
      member(2, 'open'),
    ])!
    const live = projectWorkflowRun(state)
    expect(live.status).toBe('running')
    expect(live.phases[0]?.members.map(item => item.status)).toEqual(['completed', 'running'])
    const replayed = projectWorkflowRun(state, { markUnfinishedInterrupted: true })
    expect(replayed.status).toBe('interrupted')
    expect(replayed.phases[0]?.members.map(item => item.status)).toEqual(['completed', 'interrupted'])
  })

  it('ignores a second start, another run, an unmatched ending, and an update before start', () => {
    const state = fold([started('first'), member(1, 'kept')])!
    expect(foldWorkflowRun(state, started('renamed'))).toBe(state)
    expect(foldWorkflowRun(state, { type: 'tool-workflow/agent-end', data: { runId: otherId, seq: 1, outcome: 'failed' } })).toBe(state)
    expect(foldWorkflowRun(state, ended(9, 'failed'))).toBe(state)
    expect(foldWorkflowRun(undefined, ended(1, 'failed'))).toBeUndefined()
    expect(foldWorkflowRun(undefined, stopped('error'))).toBeUndefined()
    expect(state.name).toBe('first')
    expect(state.members).toHaveLength(1)
  })
})
