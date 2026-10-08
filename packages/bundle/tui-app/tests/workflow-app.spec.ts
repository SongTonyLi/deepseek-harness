/** Workflow runs in the terminal: live drawing, replay, and opening a member. */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, createUserMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type { ToolWorkflowAgentStartData, ToolWorkflowRunStartData } from '@deepseek-ai/dsh-tool-workflow/types'
import { KEY, bench, type Bench } from './bench.ts'

const PARENT = 'session-tui-test' as SessionId
const LIVE = 'session-live' as SessionId
const runId = 'run-kept' as ToolWorkflowRunStartData['runId']

/** A listed direct child of the bench session. */
function childRow(id: string, depth = 1): SubagentDescendantListEntry {
  return {
    kind: 'child',
    id: id as SessionId,
    activity: 'running',
    mode: 'one-shot',
    hasChildren: false,
    parentId: PARENT,
    depth,
    label: 'member',
  }
}

/** A catalog row that is not a child, so the openable walk skips it. */
function diagnosticRow(): SubagentDescendantListEntry {
  return {
    kind: 'diagnostic',
    id: 'session-bad' as SessionId,
    reason: 'unavailable',
    parentId: PARENT,
    depth: 1,
  }
}

/** One durable history record. */
function recorded(type: SessionEvent['type'], data: SessionEvent['data'], seq: number): SessionEvent {
  return { type, seq, time: seq, data } as SessionEvent
}

/** Arguments of one workflow tool call. */
function workflowArgs(name: string, background: boolean): string {
  return JSON.stringify({
    script: 'line one\nline two',
    meta: { name, description: 'check' },
    ...background ? { run_in_background: true } : {},
  })
}

/** The sentence the workflow tool writes when a background launch succeeds. */
function backgroundResult(name: string, jobId: string): string {
  return `workflow "${name}" started in the background as job ${jobId}. Its return value arrives with the completion notice; check on it with job_output, stop it with job_kill.`
}

/** A jobs registry whose `get` answers one status, or throws. */
function jobsStub(status: 'running' | 'completed' | 'throw'): (ctx: Context) => void {
  return (ctx) => {
    ctx.provide('jobs', {
      events: { subscribe: () => () => {} },
      list: () => [],
      get: () => {
        if (status === 'throw') throw new Error('missing job')
        return { status }
      },
    } as never)
  }
}

/** A presenter that puts the script on the generic card. */
function scriptPresenter(ctx: Context): void {
  ctx.provide('tools', {
    get: () => ({
      presentCall: (args: unknown) => ({
        card: 'generic',
        title: 'workflow: audit',
        rawInput: (args as { script?: string }).script,
      }),
    }),
  } as never)
}

/** Draw one live run with a single member. */
function showRun(test: Bench, id: ToolWorkflowRunStartData['runId'], name: string, label: string, childId: string): void {
  test.session.append('tool-workflow/run-start', { runId: id, name })
  test.session.append('tool-workflow/agent-start', {
    runId: id,
    seq: 1,
    label,
    phase: 'scan',
    childId: childId as ToolWorkflowAgentStartData['childId'],
  })
}

describe('workflow runs in the terminal', () => {
  it('draws the script on the tool card and folds the run from the keyboard', async () => {
    const test = await bench({ before: scriptPresenter })
    test.appendToolCall('call-script', 'workflow', {
      script: 'line one\nline two',
      meta: { name: 'audit', description: 'check' },
    })
    for (const [callId, args] of [
      ['call-text', '"not-json"'],
      ['call-number', '1'],
      ['call-null', 'null'],
      ['call-meta', '{"meta":null}'],
      ['call-name', '{"meta":{"name":1}}'],
      ['call-flag', '{"meta":{"name":"audit"},"run_in_background":"yes"}'],
      ['call-bare', '{"script":"x"}'],
    ] as const) {
      test.session.append('tool/call', {
        turn: 1,
        step: 1,
        callId: callId as ToolCallId,
        name: 'workflow',
        arguments: args,
      })
    }
    showRun(test, runId, 'audit', 'scan-reader', 'session-live')
    const screen = await test.screen()
    expect(screen).toContain('workflow: audit')
    expect(screen).toContain('line one')
    expect(screen).toContain('line two')
    expect(screen).not.toContain('line one\\nline two')
    expect(screen).toContain('scan-reader')

    test.terminal.type(KEY.shiftUp)
    await test.settle()
    test.terminal.type(KEY.up)
    await test.settle()
    test.terminal.type(KEY.up)
    await test.settle()
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(await test.screen()).not.toContain('○ scan-reader')
  })

  it('opens a live direct child and refuses one that is not running here', async () => {
    const test = await bench({
      subagents: () => Promise.resolve([
        diagnosticRow(),
        childRow('session-other'),
        childRow('session-grand', 2),
        childRow('session-idle'),
        childRow('session-foreign'),
        childRow(LIVE),
      ]),
    })
    const live = await test.createChild({ id: LIVE })
    const idle = await test.createChild({ id: 'session-idle' })
    const foreign = await test.createChild({ id: 'session-foreign', parent: 'session-elsewhere' as SessionId })
    const grand = await test.createChild({ id: 'session-grand', depth: 2 })
    live.setStatus('running')
    idle.setStatus('idle')
    foreign.setStatus('running')
    grand.setStatus('running')
    await test.settle()
    showRun(test, runId, 'audit', 'scan-reader', LIVE)
    await test.settle()

    test.terminal.type(KEY.shiftUp)
    await test.settle()
    expect(await test.screen()).toContain('workflow audit · member scan-reader')
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.hostCalls).toContain(`observe-resident:${LIVE}`)
    expect(test.hostCalls.some(call => call.startsWith('observe:'))).toBe(false)
  })

  it('does not resume a member that finishes between the key and the open', async () => {
    const test = await bench({ subagents: () => Promise.resolve([childRow(LIVE)]) })
    const live = await test.createChild({ id: LIVE })
    live.setStatus('running')
    await test.settle()
    showRun(test, runId, 'audit', 'scan-reader', LIVE)
    await test.settle()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    let reads = 0
    Object.defineProperty(live.agent, 'status', {
      configurable: true,
      get() {
        reads += 1
        return reads === 1 ? 'running' : 'idle'
      },
    })
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.hostCalls).toContain(`observe-live-refused:${LIVE}`)
    expect(test.hostCalls.some(call => call.startsWith('observe:'))).toBe(false)
    expect(await test.screen()).toContain('that session is not running in this process')
  })

  it('does not resume a listed child that is idle, nested, parented elsewhere, or absent', async () => {
    const cases = [
      { id: 'session-idle', status: 'idle' as const, depth: 1, parent: undefined },
      { id: 'session-grand', status: 'running' as const, depth: 2, parent: undefined },
      { id: 'session-foreign', status: 'running' as const, depth: 1, parent: 'session-elsewhere' as SessionId },
      { id: 'session-missing', status: undefined, depth: 1, parent: undefined },
    ]
    for (const item of cases) {
      const test = await bench({ subagents: () => Promise.resolve([diagnosticRow(), childRow(item.id, item.depth)]) })
      if (item.status !== undefined) {
        const child = await test.createChild({
          id: item.id,
          depth: item.depth,
          ...item.parent === undefined ? {} : { parent: item.parent },
        })
        child.setStatus(item.status)
      }
      await test.settle()
      showRun(test, runId, 'audit', 'scan-reader', item.id)
      await test.settle()
      test.terminal.type(KEY.shiftUp)
      await test.settle()
      test.terminal.type(KEY.enter)
      await test.settle()
      expect(test.hostCalls.filter(call => call.startsWith('observe'))).toEqual([])
      expect(await test.screen()).toContain('READER')
    }
  })

  it('says when a listed member is gone or idle before Enter can open it', async () => {
    const rows = [childRow(LIVE)]
    const listed = await bench({ subagents: () => Promise.resolve(rows) })
    const listedChild = await listed.createChild({ id: LIVE })
    listedChild.setStatus('running')
    await listed.settle()
    showRun(listed, runId, 'audit', 'scan-reader', LIVE)
    await listed.settle()
    rows.length = 0
    listed.terminal.type(KEY.shiftUp)
    await listed.settle()
    listed.terminal.type(KEY.enter)
    await listed.settle()
    expect(await listed.screen()).toContain('that workflow member is no longer running here')
    expect(listed.hostCalls.filter(call => call.startsWith('observe'))).toEqual([])

    const idle = await bench({ subagents: () => Promise.resolve([childRow(LIVE)]) })
    const idleChild = await idle.createChild({ id: LIVE })
    idleChild.setStatus('running')
    await idle.settle()
    showRun(idle, runId, 'audit', 'scan-reader', LIVE)
    await idle.settle()
    Object.defineProperty(idleChild.agent, 'status', { configurable: true, get: () => 'idle' })
    idle.terminal.type(KEY.shiftUp)
    await idle.settle()
    idle.terminal.type(KEY.enter)
    await idle.settle()
    expect(await idle.screen()).toContain('that workflow member is no longer running here')
    expect(idle.hostCalls.filter(call => call.startsWith('observe'))).toEqual([])
  })

  it('draws a workflow update that arrived above the repaint window once the block is visible again', async () => {
    const test = await bench()
    test.terminal.rows = 12
    await test.settle()
    showRun(test, runId, 'audit', 'scan-reader', LIVE)
    await test.settle()
    for (let index = 0; index < 40; index += 1) {
      test.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `pad ${String(index)}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    await test.settle()
    test.session.append('tool-workflow/agent-end', { runId, seq: 1, outcome: 'completed' })
    test.session.append('tool-workflow/run-end', { runId, stopReason: 'completed' })
    await test.settle()
    test.terminal.resize(100, 200)
    await test.settle()
    expect(await test.screen()).toContain('completed')
  })

  it('reports a live-only observe failure without leaving the parent', async () => {
    const test = await bench({
      hostFailure: 'host refused',
      subagents: () => Promise.resolve([childRow(LIVE)]),
    })
    const live = await test.createChild({ id: LIVE })
    live.setStatus('running')
    await test.settle()
    showRun(test, runId, 'audit', 'scan-reader', LIVE)
    await test.settle()
    test.terminal.type(KEY.shiftUp)
    await test.settle()
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(await test.screen()).toContain(`opening subagent ${LIVE} failed: host refused`)
    expect(await test.screen()).toContain('workflow audit')
  })

  it('keeps a live background job running on replay and interrupts every other unfinished run', async () => {
    const kept = 'run-kept' as ToolWorkflowRunStartData['runId']
    const dropped = 'run-dropped' as ToolWorkflowRunStartData['runId']
    const early = 'run-early' as ToolWorkflowRunStartData['runId']
    const history: SessionEvent[] = [
      recorded('turn/start', { turn: 1 }, 0),
      recorded('tool/call', { turn: 1, step: 1, callId: 'call-early' as ToolCallId, name: 'workflow', arguments: workflowArgs('early', true) }, 1),
      recorded('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: 'call-early' as ToolCallId,
          content: [{ type: 'text', text: backgroundResult('early', 'workflow-7') }],
          isError: false,
        }),
      }, 2),
      recorded('tool-workflow/run-start', { runId: early, name: 'early' }, 3),
      recorded('tool-workflow/agent-start', { runId: early, seq: 1, label: 'early-member', phase: 'scan', childId: 'session-early' as ToolWorkflowAgentStartData['childId'] }, 4),
      recorded('tool/call', { turn: 1, step: 1, callId: 'call-kept' as ToolCallId, name: 'workflow', arguments: workflowArgs('kept', true) }, 5),
      recorded('tool/call', { turn: 1, step: 1, callId: 'call-dropped' as ToolCallId, name: 'workflow', arguments: workflowArgs('dropped', false) }, 6),
      recorded('tool/call', { turn: 1, step: 1, callId: 'call-shared-a' as ToolCallId, name: 'workflow', arguments: workflowArgs('shared', true) }, 22),
      recorded('tool/call', { turn: 1, step: 1, callId: 'call-shared-b' as ToolCallId, name: 'workflow', arguments: workflowArgs('shared', false) }, 23),
      recorded('tool-workflow/run-start', { runId: kept, name: 'kept' }, 7),
      recorded('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: 'call-kept' as ToolCallId,
          content: [{ type: 'text', text: backgroundResult('kept', 'workflow-1') }],
          isError: false,
        }),
      }, 8),
      recorded('tool-workflow/agent-start', { runId: kept, seq: 1, label: 'kept-live', phase: 'scan', childId: 'session-kept' as ToolWorkflowAgentStartData['childId'] }, 9),
      recorded('tool-workflow/run-start', { runId: dropped, name: 'dropped' }, 10),
      recorded('tool-workflow/agent-start', { runId: dropped, seq: 1, label: 'became-interrupted', phase: 'scan', childId: 'session-dropped' as ToolWorkflowAgentStartData['childId'] }, 11),
      recorded('tool-workflow/run-start', { runId: kept, name: 'kept-again' }, 12),
      recorded('tool-workflow/agent-end', { runId: dropped, seq: 9, outcome: 'failed' }, 13),
      recorded('tool/call', { turn: 1, step: 1, callId: 'call-error' as ToolCallId, name: 'workflow', arguments: workflowArgs('error-run', true) }, 14),
      recorded('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: 'call-error' as ToolCallId,
          content: [{ type: 'text', text: backgroundResult('error-run', 'workflow-9') }],
          isError: true,
        }),
      }, 15),
      recorded('tool/call', { turn: 1, step: 1, callId: 'call-plain' as ToolCallId, name: 'workflow', arguments: workflowArgs('plain-run', true) }, 16),
      recorded('tool-workflow/run-start', { runId: 'run-plain' as ToolWorkflowRunStartData['runId'], name: 'plain-run' }, 17),
      recorded('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: 'call-plain' as ToolCallId,
          content: [{ type: 'text', text: 'workflow started without a job id' }],
          isError: false,
        }),
      }, 18),
      recorded('tool-workflow/agent-start', { runId: 'run-plain' as ToolWorkflowRunStartData['runId'], seq: 1, label: 'plain-member', phase: 'scan', childId: 'session-plain' as ToolWorkflowAgentStartData['childId'] }, 19),
      recorded('tool-workflow/agent-end', { runId: 'run-missing', seq: 1, outcome: 'failed' }, 20),
      recorded('tool-workflow/run-start', { runId: 'run-shared-a' as ToolWorkflowRunStartData['runId'], name: 'shared' }, 24),
      recorded('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: 'call-shared-a' as ToolCallId,
          content: [{ type: 'text', text: backgroundResult('shared', 'workflow-3') }],
          isError: false,
        }),
      }, 25),
      recorded('tool-workflow/agent-start', { runId: 'run-shared-a' as ToolWorkflowRunStartData['runId'], seq: 1, label: 'shared-live', phase: 'scan', childId: 'session-shared-a' as ToolWorkflowAgentStartData['childId'] }, 26),
      recorded('tool-workflow/run-start', { runId: 'run-shared-b' as ToolWorkflowRunStartData['runId'], name: 'shared' }, 27),
      recorded('tool-workflow/agent-start', { runId: 'run-shared-b' as ToolWorkflowRunStartData['runId'], seq: 1, label: 'shared-cold', phase: 'scan', childId: 'session-shared-b' as ToolWorkflowAgentStartData['childId'] }, 28),
      recorded('turn/end', { turn: 1, reason: { kind: 'completed' } }, 21),
    ]

    const live = await bench({ history, before: jobsStub('running') })
    const liveScreen = await live.screen()
    expect(liveScreen).toContain('workflow kept · 1 member · running')
    expect(liveScreen).toContain('workflow early · 1 member · running')
    expect(liveScreen).toContain('workflow dropped · 1 member · interrupted')
    expect(liveScreen).toContain('workflow plain-run · 1 member · interrupted')
    expect(liveScreen).toContain('workflow shared · 1 member · running')
    expect(liveScreen).toContain('shared-cold')
    expect(liveScreen).toMatch(/workflow shared · 1 member · interrupted/)
    expect(liveScreen).not.toContain('workflow error-run')

    const settled = await bench({ history, before: jobsStub('completed') })
    expect(await settled.screen()).toContain('workflow kept · 1 member · interrupted')
    const missing = await bench({ history, before: jobsStub('throw') })
    expect(await missing.screen()).toContain('workflow kept · 1 member · interrupted')
    const absent = await bench({ history })
    expect(await absent.screen()).toContain('workflow kept · 1 member · interrupted')
  })

  it('leaves a clean replay closed and applies the global fold to a later run', async () => {
    const done = 'run-done' as ToolWorkflowRunStartData['runId']
    const test = await bench({
      history: [
        recorded('turn/start', { turn: 1 }, 0),
        recorded('tool-workflow/run-start', { runId: done, name: 'done' }, 1),
        recorded('tool-workflow/agent-start', { runId: done, seq: 1, label: 'finished-member', phase: 'scan', childId: 'session-done' as ToolWorkflowAgentStartData['childId'] }, 2),
        recorded('tool-workflow/agent-end', { runId: done, seq: 1, outcome: 'completed' }, 3),
        recorded('tool-workflow/run-end', { runId: done, stopReason: 'completed' }, 4),
        recorded('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
      ],
    })
    expect(await test.screen()).not.toContain('finished-member')
    expect(await test.screen()).toContain('workflow done · 1 member · completed')

    test.terminal.type(KEY.ctrlO)
    await test.settle()
    test.terminal.type(KEY.ctrlO)
    await test.settle()
    showRun(test, 'run-later' as ToolWorkflowRunStartData['runId'], 'later', 'later-member', 'session-later')
    expect(await test.screen()).toContain('workflow later')
    expect(await test.screen()).not.toContain('later-member')
  })
})
