/** Workflow transcript block: disclosure, repaint locking, and member opening. */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ToolWorkflowAgentEndData,
  ToolWorkflowAgentStartData,
  ToolWorkflowRunEndData,
  ToolWorkflowRunStartData,
} from '@deepseek-ai/dsh-tool-workflow/types'
import { createPalette } from '../src/style.ts'
import { WorkflowBlock, progressBar } from '../src/workflow-block.ts'
import { TOOL_SPINNERS, WORKFLOW_SPINNER } from '../src/spinner.ts'
import { foldWorkflowRun, projectWorkflowRun, type WorkflowRunEvent, type WorkflowRunView } from '../src/workflow.ts'
import type { BlockTheme } from '../src/blocks.ts'

const plain: BlockTheme = { palette: createPalette(false), toolPreviewLines: 2, contextPreviewLines: 2 }
const colored: BlockTheme = { palette: createPalette(true), toolPreviewLines: 2, contextPreviewLines: 2 }
const runId = 'run-1' as ToolWorkflowRunStartData['runId']
const child = (id: string): ToolWorkflowAgentStartData['childId'] => id as ToolWorkflowAgentStartData['childId']

/** Fold events into the view a block renders. */
function view(events: readonly WorkflowRunEvent[], interrupted = false): WorkflowRunView {
  const state = events.reduce<ReturnType<typeof foldWorkflowRun>>((current, event) => foldWorkflowRun(current, event), undefined)
  if (state === undefined) throw new Error('workflow fixture never started')
  return projectWorkflowRun(state, interrupted ? { markUnfinishedInterrupted: true } : {})
}

/** One run-start. */
function started(name = 'audit'): WorkflowRunEvent {
  return { type: 'tool-workflow/run-start', data: { runId, name } }
}

/** One member start. */
function member(seq: number, label: string, phase?: string, id = `session-${String(seq)}`): WorkflowRunEvent {
  return {
    type: 'tool-workflow/agent-start',
    data: { runId, seq, label, childId: child(id), ...phase === undefined ? {} : { phase } },
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

/** Visible text of one block. */
function drawn(block: WorkflowBlock, width = 80): string {
  return block.render(width).join('\n')
}

describe('workflow block', () => {
  it('opens a running run and keeps a clean completion closed', () => {
    const running = new WorkflowBlock(plain, view([started(), member(1, 'scan-reader', 'scan')]), 1)
    expect(running.isExpanded()).toBe(true)
    expect(drawn(running)).toContain('workflow audit · 1 member · running')
    expect(drawn(running)).toContain('scan · 1 member · 1 running')
    expect(drawn(running)).toContain('scan-reader [running]')
    expect(running.parts().map(part => part.kind)).toEqual(['workflow-run', 'workflow-phase', 'workflow-member'])

    const clean = new WorkflowBlock(plain, view([started(), member(1, 'scan-reader', 'scan'), ended(1, 'completed'), stopped('completed')]), 1)
    expect(clean.isExpanded()).toBe(false)
    expect(drawn(clean)).toContain('completed')
    expect(drawn(clean)).not.toContain('scan-reader')
    expect(clean.parts()[2]?.rows).toContain('child session-1')
  })

  it('names an omitted phase, an empty phase, and an unnamed member', () => {
    const block = new WorkflowBlock(plain, view([
      started(),
      member(1, '', undefined, 'session-a'),
      member(2, 'kept', ''),
    ]), 1)
    const text = drawn(block)
    expect(text).toContain('unassigned')
    expect(text).toContain('(empty phase)')
    expect(text).toContain('(unnamed member)')
    expect(text).toContain('2 members')
  })

  it('paints each terminal status and a mixed phase summary', () => {
    const failed = new WorkflowBlock(plain, view([started(), member(1, 'broken', 'scan'), ended(1, 'failed'), stopped('error')]), 1)
    expect(drawn(failed)).toContain('broken [failed]')
    const cancelled = new WorkflowBlock(plain, view([started(), member(1, 'halted', 'scan'), ended(1, 'cancelled'), stopped('cancelled')]), 1)
    expect(drawn(cancelled)).toContain('1 cancelled')
    const mixed = new WorkflowBlock(plain, view([
      started(),
      member(1, 'done', 'scan'),
      ended(1, 'completed'),
      member(2, 'open', 'scan'),
    ], true), 1)
    expect(drawn(mixed)).toContain('1 completed · 1 interrupted')
    expect(drawn(mixed)).toContain('open [interrupted]')
  })

  it('preserves a manual choice, reopens for a new running member, and opens on the first failure', () => {
    const block = new WorkflowBlock(plain, view([started(), member(1, 'scan-reader', 'scan')]), 1)
    expect(block.togglePart(2)).toBe(false)
    expect(block.togglePart(9)).toBe(false)
    expect(block.togglePart(0)).toBe(true)
    expect(drawn(block)).not.toContain('scan-reader')

    block.setData(view([started(), member(1, 'scan-reader', 'scan'), member(2, 'second', 'scan')]))
    expect(drawn(block)).not.toContain('second')

    block.setData(view([
      started(),
      member(1, 'scan-reader', 'scan'),
      ended(1, 'failed'),
      member(2, 'second', 'scan'),
      ended(2, 'failed'),
      stopped('error'),
    ]))
    expect(drawn(block)).toContain('second')

    const closed = new WorkflowBlock(plain, view([started(), member(1, 'scan-reader', 'scan'), ended(1, 'completed'), stopped('completed')]), 1)
    closed.setData(view([started(), member(1, 'scan-reader', 'scan'), ended(1, 'completed'), member(2, 'revived', 'scan')]))
    expect(drawn(closed)).toContain('revived')
  })

  it('defers a clean collapse while focus stays, then collapses the phase focus left', () => {
    const block = new WorkflowBlock(plain, view([
      started(),
      member(1, 'scan-a', 'alpha'),
      member(2, 'scan-b', 'beta'),
    ]), 1)
    block.setHighlight(2)
    block.setData(view([
      started(),
      member(1, 'scan-a', 'alpha'),
      ended(1, 'completed'),
      member(2, 'scan-b', 'beta'),
      ended(2, 'completed'),
      stopped('completed'),
    ]))
    expect(drawn(block)).toContain('scan-a')
    expect(drawn(block)).not.toContain('scan-b')

    block.setHighlight(4)
    block.setData(view([
      started(),
      member(1, 'scan-a', 'alpha'),
      ended(1, 'completed'),
      member(2, 'scan-b', 'beta'),
      ended(2, 'completed'),
      stopped('completed'),
    ]))
    expect(drawn(block)).not.toContain('scan-a')

    block.setHighlight(undefined)
    expect(drawn(block)).not.toContain('scan-b')
    expect(block.isExpanded()).toBe(false)
  })

  it('opens a hidden run when its phase is toggled and follows Ctrl+O', () => {
    const block = new WorkflowBlock(plain, view([started(), member(1, 'scan-reader', 'scan')]), 1)
    block.togglePart(0)
    expect(block.togglePart(1)).toBe(true)
    expect(block.isExpanded()).toBe(true)
    expect(drawn(block)).toContain('scan-reader')

    block.setExpanded(false)
    expect(drawn(block)).not.toContain('scan-reader')
    block.setExpanded(true)
    expect(drawn(block)).toContain('scan-reader')
    const empty = new WorkflowBlock(plain, view([started()]), 1)
    empty.setExpanded(false)
    expect(empty.isExpanded()).toBe(false)
    expect(drawn(empty)).toContain('0 members')
  })

  it('opens only a running member whose child is currently openable', () => {
    const block = new WorkflowBlock(colored, view([started(), member(1, 'scan-reader', 'scan', 'session-live')]), 1)
    expect(block.memberTarget(2)).toBeUndefined()
    const plainRows = drawn(block)
    const ids = new Set(['session-live' as SessionId])
    block.setOpenableChildren(ids)
    block.setOpenableChildren(new Set(ids))
    expect(drawn(block)).not.toBe(plainRows)
    expect(block.memberTarget(2)).toEqual({ childId: 'session-live', label: 'scan-reader' })
    expect(block.memberTarget(0)).toBeUndefined()

    block.setData(view([started(), member(1, 'scan-reader', 'scan', 'session-live'), ended(1, 'completed'), stopped('completed')]))
    block.setExpanded(true)
    expect(block.memberTarget(2)).toBeUndefined()
  })

  it('keeps rows and disclosure unchanged while the block is above the repaint window', () => {
    const block = new WorkflowBlock(plain, view([started(), member(1, 'scan-reader', 'scan')]), 1)
    block.setHighlight(2)
    block.setHighlight(2)
    const before = drawn(block)
    expect(block.setRepaintFloor(0)).toBe(false)
    expect(block.setRepaintFloor(4)).toBe(false)
    block.setData(view([started(), member(1, 'scan-reader', 'scan'), member(2, 'later', 'scan')]))
    block.setOpenableChildren(new Set(['session-1' as SessionId]))
    block.setHighlight(undefined)
    expect(drawn(block)).toBe(before)
    expect(block.setRepaintFloor(0)).toBe(true)
    const after = drawn(block)
    expect(after).toContain('later')
    expect(after).not.toBe(before)

    block.setRepaintFloor(2)
    block.setHighlight(1)
    block.setData(view([started(), member(1, 'scan-reader', 'scan'), member(2, 'later', 'scan'), member(3, 'newest', 'scan')]))
    block.setExpanded(true)
    expect(drawn(block)).toContain('newest')
    block.invalidate()
    expect(drawn(block, 8).length).toBeGreaterThan(0)
    block.setHighlight(0, 1)
    expect(drawn(block)).toContain('┃')
    block.setHighlight(99)
    expect(drawn(block)).toContain('workflow audit')
  })

  it('applies each deferred change on its own and names plural sections', () => {
    const paired = new WorkflowBlock(plain, view([
      started(),
      member(1, 'first', 'scan'),
      member(2, 'second', 'scan'),
    ]), 1)
    expect(paired.name).toBe('audit')
    expect(paired.parts().map(part => part.rows[1])).toEqual(['2 members', '2 members', 'running', 'running'])
    paired.setHighlight(undefined)
    paired.setExpanded(true)
    expect(paired.togglePart(1)).toBe(true)
    expect(drawn(paired)).not.toContain('first')

    const held = new WorkflowBlock(plain, view([started(), member(1, 'scan-reader', 'scan')]), 1)
    held.setHighlight(2)
    held.setData(view([started(), member(1, 'scan-reader', 'scan'), ended(1, 'completed'), stopped('completed')]))
    held.setHighlight(undefined)
    expect(held.isExpanded()).toBe(false)

    const locked = new WorkflowBlock(plain, view([started(), member(1, 'scan-reader', 'scan')]), 1)
    locked.setRepaintFloor(3)
    const same = new Set(['session-1' as SessionId])
    locked.setOpenableChildren(same)
    locked.setOpenableChildren(new Set(same))
    locked.setData(view([
      started(),
      member(1, 'scan-reader', 'scan'),
      member(2, 'added', 'later'),
    ]))
    expect(locked.togglePart(3)).toBe(false)
    expect(locked.setRepaintFloor(0)).toBe(true)

    const sourceOnly = new WorkflowBlock(plain, view([started(), member(1, 'scan-reader', 'scan')]), 1)
    sourceOnly.setRepaintFloor(3)
    sourceOnly.setData(view([started(), member(1, 'scan-reader', 'scan'), member(2, 'added', 'scan')]))
    expect(sourceOnly.setRepaintFloor(0)).toBe(true)

    const linksOnly = new WorkflowBlock(plain, view([started(), member(1, 'scan-reader', 'scan', 'session-a')]), 1)
    linksOnly.setOpenableChildren(new Set(['session-a' as SessionId]))
    linksOnly.setRepaintFloor(3)
    linksOnly.setOpenableChildren(new Set(['session-b' as SessionId]))
    expect(linksOnly.setRepaintFloor(0)).toBe(true)
    expect(linksOnly.memberTarget(2)).toBeUndefined()

    const markOnly = new WorkflowBlock(plain, view([started(), member(1, 'scan-reader', 'scan')]), 1)
    markOnly.setRepaintFloor(3)
    markOnly.setHighlight(1)
    expect(markOnly.setRepaintFloor(0)).toBe(true)

    const idle = new WorkflowBlock(plain, view([started()]), 1)
    idle.setRepaintFloor(3)
    expect(idle.setRepaintFloor(0)).toBe(false)
    idle.setExpanded(true)

    const collapseOnly = new WorkflowBlock(plain, view([started(), member(1, 'scan-reader', 'scan')]), 1)
    collapseOnly.setHighlight(2)
    collapseOnly.setData(view([started(), member(1, 'scan-reader', 'scan'), ended(1, 'completed'), stopped('completed')]))
    collapseOnly.setRepaintFloor(3)
    collapseOnly.setHighlight(undefined)
    expect(collapseOnly.setRepaintFloor(0)).toBe(true)
    expect(collapseOnly.isExpanded()).toBe(false)

    const forced = new WorkflowBlock(plain, view([started(), member(1, 'scan-reader', 'scan', 'session-a')]), 1)
    forced.setHighlight(1)
    forced.setData(view([
      started(),
      member(1, 'scan-reader', 'scan', 'session-a'),
      member(2, 'added', 'later'),
    ]))
    expect(drawn(forced)).toContain('added')
    forced.setData(view([
      started(),
      member(1, 'scan-reader', 'scan', 'session-a'),
      ended(1, 'completed'),
      member(2, 'added', 'later'),
      ended(2, 'completed'),
      stopped('completed'),
    ]))
    forced.setRepaintFloor(4)
    forced.setOpenableChildren(new Set(['session-a' as SessionId]))
    forced.setHighlight(1)
    forced.setExpanded(true)
    expect(forced.isExpanded()).toBe(true)
    expect(drawn(forced)).toContain('scan-reader')
    expect(drawn(forced)).toContain('added')
  })

  it('draws a member progress bar on the run header, settled members first', () => {
    const empty = new WorkflowBlock(plain, view([started()]), 1)
    expect(drawn(empty)).toContain('workflow audit · 0 members · running')
    expect(drawn(empty)).not.toContain('0/0')

    const mixed = view([
      started(),
      member(1, 'a', 'scan'),
      member(2, 'b', 'scan'),
      member(3, 'c', 'scan'),
      member(4, 'd', 'scan'),
      member(5, 'e', 'scan'),
      ended(1, 'completed'),
      ended(2, 'completed'),
      ended(3, 'failed'),
    ])
    expect(progressBar(plain.palette, mixed)).toBe('━━━━━━──── 3/5')
    expect(drawn(new WorkflowBlock(plain, mixed, 1))).toContain('workflow audit · 5 members · running ━━━━━━──── 3/5')
    const settled = view([started(), member(1, 'a', 'scan'), ended(1, 'completed'), stopped('completed')])
    expect(progressBar(plain.palette, settled)).toBe('━━━━━━━━━━ 1/1')
    expect(progressBar(colored.palette, mixed)).toContain('━━━━')
  })

  it('spins the run and its running members on the clock, and freezes above the repaint window', () => {
    let frame = 0
    const block = new WorkflowBlock(plain, view([started(), member(1, 'a', 'scan'), member(2, 'b', 'scan'), ended(2, 'completed')]), 1)
    expect(block.spinning()).toBe(false)
    block.setSpinner(() => frame)
    expect(block.spinning()).toBe(true)
    expect(drawn(block)).toContain(`${WORKFLOW_SPINNER[0]} workflow audit`)
    expect(drawn(block)).toContain(`${TOOL_SPINNERS.subagent[1]} a [running]`)
    expect(drawn(block)).toContain('○ b [completed]')
    frame = 1
    expect(drawn(block)).toContain(`${WORKFLOW_SPINNER[1]} workflow audit`)
    expect(drawn(block)).toContain(`${TOOL_SPINNERS.subagent[2]} a [running]`)

    block.setRepaintFloor(3)
    frame = 2
    expect(drawn(block)).toContain(`${WORKFLOW_SPINNER[1]} workflow audit`)
    block.setRepaintFloor(0)
    expect(drawn(block)).toContain(`${WORKFLOW_SPINNER[2]} workflow audit`)

    block.setData(view([started(), member(1, 'a', 'scan'), ended(1, 'completed'), stopped('completed')]))
    expect(block.spinning()).toBe(false)
    expect(drawn(block)).toContain('◇ workflow audit')
    expect(block.view.status).toBe('completed')
  })

  it('draws the static glyphs when a spinner is first set above the repaint window', () => {
    const block = new WorkflowBlock(plain, view([started(), member(1, 'a', 'scan')]), 1)
    block.setRepaintFloor(2)
    block.setSpinner(() => 5)
    expect(drawn(block)).toContain('◇ workflow audit')
    expect(drawn(block)).toContain('○ a [running]')
    block.setSpinner(undefined)
    block.setRepaintFloor(0)
    expect(drawn(block)).toContain('◇ workflow audit')
  })
})
