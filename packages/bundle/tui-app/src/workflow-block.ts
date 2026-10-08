/**
 * Foldable terminal rendering for one durable workflow run. It keeps run and
 * phase disclosure choices local while the application owns durable replay and
 * child-session liveness.
 * @module @deepseek-ai/dsh-tui-app/workflow-block
 */

import { wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { BlockTheme, Foldable } from './blocks.ts'
import { pulse, type MotionLevel } from './motion.ts'
import type { SectionPart, WorkflowSection } from './navigation.ts'
import type {
  WorkflowRunMemberView,
  WorkflowRunPhaseView,
  WorkflowRunStatus,
  WorkflowRunView,
} from './workflow.ts'

/** Columns the focus gutter takes from this block's content. */
const GUTTER_WIDTH = 2
/** Gutter beside an unfocused section of a focused workflow block. */
const BLOCK_GUTTER = '│ '
/** Gutter beside the focused workflow section. */
const PART_GUTTER = '┃ '

/** Disclosure mode shared by a run and each of its phase groups. */
type DisclosureMode = 'clean' | 'running' | 'abnormal'

/** Facts that decide the default and automatic disclosure behavior. */
interface DisclosureFacts {
  readonly mode: DisclosureMode
  readonly activityCount: number
}

/** Local disclosure state retained while durable records update. */
interface DisclosureState extends DisclosureFacts {
  readonly open: boolean
  readonly pendingCleanCollapse: boolean
}

/** A run, phase, or member section in the flat transcript cursor order. */
type WorkflowPartRef =
  | { readonly kind: 'run' }
  | { readonly kind: 'phase'; readonly key: string }
  | { readonly kind: 'member'; readonly key: string; readonly member: WorkflowRunMemberView }

/** A contiguous run of already-rendered block lines. */
interface LineRange {
  readonly from: number
  readonly to: number
}

/** One cached rendering and the ranges each source part occupies in it. */
interface WorkflowLayout {
  readonly lines: readonly string[]
  readonly ranges: readonly (LineRange | undefined)[]
  readonly fallbacks: readonly (LineRange | undefined)[]
}

/**
 * One workflow run in the transcript. The block's source state can advance
 * while its already-written scrollback stays frozen; reader and inspector rows
 * always read the newest durable projection.
 */
export class WorkflowBlock implements Component, WorkflowSection, Foldable {
  readonly navigable = true as const
  readonly blockKind = 'workflow' as const
  readonly foldable = true as const
  /** Data used by reader, inspector, navigation, and child opening. */
  private source: WorkflowRunView
  /** Data currently safe to rewrite in the terminal transcript. */
  private displayed: WorkflowRunView
  private runDisclosure: DisclosureState
  private phaseDisclosures = new Map<string, DisclosureState>()
  private openableChildren = new Set<SessionId>()
  private highlight: number | undefined
  private highlightLevel: MotionLevel = 0
  private repaintLocked = false
  /** Child ids received while the block cannot safely redraw. */
  private pendingOpenable: ReadonlySet<SessionId> | undefined
  /** Clean collapse deferred until the block can be redrawn. */
  private pendingCollapse = false
  /** Focus mark received while the block cannot safely redraw. */
  private pendingHighlight: { readonly part: number | undefined; readonly level: MotionLevel } | undefined
  private revision = 0
  private drawn: { key: string; layout: WorkflowLayout } | undefined

  /**
   * @param theme - terminal palette shared with transcript blocks.
   * @param initial - durable run projection at insertion.
   * @param turn - turn that recorded the run start.
   */
  constructor(
    private readonly theme: BlockTheme,
    initial: WorkflowRunView,
    readonly turn: number,
  ) {
    this.source = initial
    this.displayed = initial
    this.runDisclosure = initialDisclosure(runFacts(initial))
    this.syncPhaseDisclosures(initial)
  }

  /** Durable name read by transcript navigation. */
  get name(): string {
    return this.source.name
  }

  /**
   * Replace the durable rendering projection. A block above the repaint window
   * keeps its earlier transcript rows until the next safe redraw.
   * @param next - latest folded workflow data.
   */
  setData(next: WorkflowRunView): void {
    this.source = next
    if (this.repaintLocked) return
    this.reconcileDisclosures(next)
    this.displayed = next
    this.changed()
  }

  /**
   * Replace the direct child ids that may be opened from currently running
   * member rows.
   * @param ids - locally resident direct children of the bound session.
   */
  setOpenableChildren(ids: ReadonlySet<SessionId>): void {
    if (this.repaintLocked) {
      const current = this.pendingOpenable ?? this.openableChildren
      if (sameIds(current, ids)) return
      this.pendingOpenable = ids
      return
    }
    this.pendingOpenable = undefined
    if (sameIds(this.openableChildren, ids)) return
    this.openableChildren = new Set(ids)
    this.changed()
  }

  /**
   * Keep presentation updates out of immutable terminal scrollback, then apply
   * deferred updates when the whole block can be redrawn safely.
   * @param floor - first block line the renderer may repaint.
   * @returns true when a deferred projection became drawable.
   */
  setRepaintFloor(floor: number): boolean {
    if (floor > 0) {
      this.repaintLocked = true
      return false
    }
    if (!this.repaintLocked) return false
    this.repaintLocked = false
    return this.applyDeferred()
  }

  /** Whether the run body is currently visible. */
  isExpanded(): boolean {
    return this.runDisclosure.open
  }

  /**
   * Expand or collapse the run and every currently known phase. This is the
   * all-block action used by `Ctrl+O`.
   * @param expanded - whether every level should draw its members.
   */
  setExpanded(expanded: boolean): void {
    this.repaintLocked = false
    this.pendingCollapse = false
    let changed = false
    if (this.pendingOpenable !== undefined) {
      this.openableChildren = new Set(this.pendingOpenable)
      this.pendingOpenable = undefined
      changed = true
    }
    if (this.pendingHighlight !== undefined) {
      this.highlight = this.pendingHighlight.part
      this.highlightLevel = this.pendingHighlight.level
      this.pendingHighlight = undefined
      changed = true
    }
    if (this.displayed !== this.source) {
      this.reconcileDisclosures(this.source)
      this.displayed = this.source
      changed = true
    }
    changed ||= this.runDisclosure.open !== expanded || this.runDisclosure.pendingCleanCollapse
    this.runDisclosure = { ...this.runDisclosure, open: expanded, pendingCleanCollapse: false }
    const phases = new Map<string, DisclosureState>()
    for (const phase of this.source.phases) {
      /* v8 ignore next -- setExpanded reconciles every source phase before this lookup. */
      const current = this.phaseDisclosures.get(phase.key) ?? initialDisclosure(phaseFacts(phase))
      changed ||= current.open !== expanded || current.pendingCleanCollapse
      phases.set(phase.key, { ...current, open: expanded, pendingCleanCollapse: false })
    }
    this.phaseDisclosures = phases
    if (changed) this.changed()
  }

  /**
   * Toggle the run or phase represented by one source part.
   * @param part - source part index held by the transcript cursor.
   * @returns true when the part owns a disclosure.
   */
  togglePart(part: number): boolean {
    const ref = this.sourceParts()[part]
    if (ref === undefined || ref.kind === 'member') return false
    if (ref.kind === 'run') {
      this.runDisclosure = { ...this.runDisclosure, open: !this.runDisclosure.open, pendingCleanCollapse: false }
      this.changed()
      return true
    }
    const current = this.phaseDisclosures.get(ref.key)
    if (current === undefined) return false
    const openingHiddenRun = !this.runDisclosure.open
    if (openingHiddenRun) this.runDisclosure = { ...this.runDisclosure, open: true, pendingCleanCollapse: false }
    this.phaseDisclosures.set(ref.key, {
      ...current,
      open: openingHiddenRun ? true : !current.open,
      pendingCleanCollapse: false,
    })
    this.changed()
    return true
  }

  /**
   * Return a member's child only while this block and the app both consider it
   * locally openable.
   * @param part - source part index held by the transcript cursor.
   * @returns the direct child target, or undefined for every other part.
   */
  memberTarget(part: number): { readonly childId: SessionId; readonly label: string } | undefined {
    const ref = this.sourceParts()[part]
    if (ref === undefined || ref.kind !== 'member' || ref.member.status !== 'running') return undefined
    if (!this.openableChildren.has(ref.member.childId)) return undefined
    return { childId: ref.member.childId, label: memberName(ref.member.label) }
  }

  /** Build full source rows for the inspector and reader. */
  parts(): readonly SectionPart[] {
    const rows: SectionPart[] = [{
      kind: 'workflow-run',
      label: 'run',
      rows: [
        `workflow ${this.source.name}`,
        `${String(memberCount(this.source))} member${memberCount(this.source) === 1 ? '' : 's'}`,
        statusText(this.source.status),
      ],
    }]
    for (const phase of this.source.phases) {
      rows.push({
        kind: 'workflow-phase',
        label: `phase ${phaseName(phase.phase)}`,
        rows: [phaseName(phase.phase), `${String(phase.members.length)} member${phase.members.length === 1 ? '' : 's'}`, phaseSummary(phase)],
      })
      for (const member of phase.members) {
        rows.push({
          kind: 'workflow-member',
          label: `member ${memberName(member.label)}`,
          rows: [memberName(member.label), statusText(member.status), `child ${member.childId}`],
        })
      }
    }
    return rows
  }

  /**
   * Draw the in-place focus marker for one source part.
   * @param part - source part index, or undefined when the keyboard leaves it.
   * @param level - current keyboard-landing motion level.
   */
  setHighlight(part: number | undefined, level: MotionLevel = 0): void {
    if (this.repaintLocked) {
      this.pendingHighlight = { part, level }
      if (part === undefined) this.pendingCollapse = true
      return
    }
    this.commitHighlight(part, level)
  }

  invalidate(): void {
    this.drawn = undefined
  }

  /**
   * Draw the run, nested phases, and started members at one width.
   * @param width - transcript columns available to the block.
   * @returns terminal rows, including its separating leading blank line.
   */
  render(width: number): string[] {
    const highlight = this.highlight
    const content = Math.max(1, width - (highlight === undefined ? 0 : GUTTER_WIDTH))
    const layout = this.layout(content)
    if (highlight === undefined) return [...layout.lines]
    const focused = layout.ranges[highlight] ?? layout.fallbacks[highlight] ?? layout.ranges[0]
    /* v8 ignore next -- buildLayout always records a range for the run header, and highlight falls back to it. */
    if (focused === undefined) return [...layout.lines]
    const marker = pulse(this.theme.palette, this.theme.palette.accent(PART_GUTTER), this.highlightLevel)
    return layout.lines.map((line, index) => `${index >= focused.from && index < focused.to ? marker : this.theme.palette.dim(BLOCK_GUTTER)}${line}`)
  }

  /**
   * Apply source, child links, and a deferred clean collapse once the block
   * can be redrawn. Disclosure is reconciled here so a locked update cannot
   * change the height of rows already written.
   * @returns true when the drawn rows changed.
   */
  private applyDeferred(): boolean {
    const openable = this.pendingOpenable
    const highlight = this.pendingHighlight
    const openableChanged = openable !== undefined && !sameIds(this.openableChildren, openable)
    const sourceChanged = this.displayed !== this.source
    const collapse = this.pendingCollapse
    if (!openableChanged && !sourceChanged && !collapse && highlight === undefined) return false
    if (openable !== undefined) {
      this.openableChildren = new Set(openable)
      this.pendingOpenable = undefined
    }
    if (highlight !== undefined) {
      this.highlight = highlight.part
      this.highlightLevel = highlight.level
      this.pendingHighlight = undefined
    }
    if (sourceChanged) {
      this.reconcileDisclosures(this.source)
      this.displayed = this.source
    }
    this.pendingCollapse = false
    if (collapse) this.collapsePending()
    this.changed()
    return true
  }

  /**
   * Apply a focus mark and collapse a clean group when focus leaves it.
   * @param part - source part index, or undefined when the keyboard leaves it.
   * @param level - current keyboard-landing motion level.
   */
  private commitHighlight(part: number | undefined, level: MotionLevel): void {
    const changed = this.highlight !== part || this.highlightLevel !== level
    this.highlight = part
    this.highlightLevel = level
    if (part === undefined) this.collapsePending()
    if (changed) this.changed()
  }

  /** Preserve disclosure choices and apply status-driven automatic changes. */
  private reconcileDisclosures(next: WorkflowRunView): void {
    const held = this.highlight === undefined ? undefined : this.sourceParts()[this.highlight]
    const phases = new Map<string, DisclosureState>()
    for (const phase of next.phases) {
      const focusWithin = held?.kind === 'phase' && held.key === phase.key
        || held?.kind === 'member' && held.key === phase.key
      const current = this.phaseDisclosures.get(phase.key)
      phases.set(phase.key, current === undefined
        ? initialDisclosure(phaseFacts(phase))
        : advanceDisclosure(current, phaseFacts(phase), focusWithin))
    }
    this.phaseDisclosures = phases
    const focusWithinRun = held !== undefined
    this.runDisclosure = advanceDisclosure(this.runDisclosure, runFacts(next), focusWithinRun)
  }

  /** Seed phases without applying an update transition. */
  private syncPhaseDisclosures(data: WorkflowRunView): void {
    this.phaseDisclosures = new Map(data.phases.map(phase => [phase.key, initialDisclosure(phaseFacts(phase))]))
  }

  /** Collapse clean groups after the keyboard leaves them. */
  private collapsePending(): void {
    let changed = false
    const run = collapseDisclosure(this.runDisclosure)
    if (run !== this.runDisclosure) {
      this.runDisclosure = run
      changed = true
    }
    const phases = new Map<string, DisclosureState>()
    for (const [key, state] of this.phaseDisclosures) {
      const settled = collapseDisclosure(state)
      if (settled !== state) changed = true
      phases.set(key, settled)
    }
    this.phaseDisclosures = phases
    if (changed) this.changed()
  }

  /** Flat source order used by navigation, folding, and member opening. */
  private sourceParts(): readonly WorkflowPartRef[] {
    return workflowParts(this.source)
  }

  /** Cached layout for unchanged width and visible state. */
  private layout(width: number): WorkflowLayout {
    const key = `${String(width)}:${String(this.revision)}`
    if (this.drawn?.key === key) return this.drawn.layout
    const layout = this.buildLayout(width)
    this.drawn = { key, layout }
    return layout
  }

  /** Build visible rows and hidden-part fallback ranges from the displayed projection. */
  private buildLayout(width: number): WorkflowLayout {
    const lines: string[] = ['']
    const refs = workflowParts(this.displayed)
    const ranges: (LineRange | undefined)[] = Array.from({ length: refs.length })
    const fallbacks: (LineRange | undefined)[] = Array.from({ length: refs.length })
    const append = (part: number, row: string): LineRange => {
      const from = lines.length
      lines.push(...wrapTextWithAnsi(row, width))
      const range = { from, to: lines.length }
      ranges[part] = range
      fallbacks[part] = range
      return range
    }
    let part = 0
    const runRange = append(part, runRow(this.theme, this.displayed))
    part += 1
    if (!this.runDisclosure.open) {
      for (; part < refs.length; part += 1) fallbacks[part] = runRange
      return { lines, ranges, fallbacks }
    }
    for (const phase of this.displayed.phases) {
      const phasePart = part
      const phaseRange = append(phasePart, phaseRow(this.theme, phase))
      part += 1
      /* v8 ignore next -- reconcileDisclosures seeds every displayed phase before layout. */
      const disclosure = this.phaseDisclosures.get(phase.key) ?? initialDisclosure(phaseFacts(phase))
      if (!disclosure.open) {
        for (let index = 0; index < phase.members.length; index += 1) {
          fallbacks[part] = phaseRange
          part += 1
        }
        continue
      }
      for (const member of phase.members) {
        append(part, memberRow(this.theme, member, this.openableChildren.has(member.childId)))
        part += 1
      }
    }
    return { lines, ranges, fallbacks }
  }

  /** Forget cached output after any input the layout reads changes. */
  private changed(): void {
    this.revision += 1
    this.drawn = undefined
  }
}

/** Facts of one phase, derived from its current members. */
function phaseFacts(phase: WorkflowRunPhaseView): DisclosureFacts {
  const mode = phase.members.some(member => abnormal(member.status))
    ? 'abnormal'
    : phase.members.some(member => member.status === 'running') ? 'running' : 'clean'
  return { mode, activityCount: phase.members.length }
}

/** Facts of a whole run, derived from its status and phase groups. */
function runFacts(run: WorkflowRunView): DisclosureFacts {
  const phases = run.phases.map(phaseFacts)
  const mode = abnormal(run.status) || phases.some(phase => phase.mode === 'abnormal')
    ? 'abnormal'
    : run.status === 'running' || phases.some(phase => phase.mode === 'running') ? 'running' : 'clean'
  return { mode, activityCount: phases.reduce((count, phase) => count + phase.activityCount, 0) }
}

/** Initial disclosure follows the same status-driven choice as the Web run node. */
function initialDisclosure(facts: DisclosureFacts): DisclosureState {
  return { ...facts, open: facts.mode !== 'clean', pendingCleanCollapse: false }
}

/** Advance a disclosure without overwriting a person's choice during ordinary updates. */
function advanceDisclosure(current: DisclosureState, facts: DisclosureFacts, focusWithin: boolean): DisclosureState {
  const same = current.mode === facts.mode && current.activityCount === facts.activityCount
  if (same) {
    if (!current.pendingCleanCollapse || focusWithin) return current
    return { ...current, open: false, pendingCleanCollapse: false }
  }
  if (facts.mode === 'clean') {
    const defer = current.open && focusWithin
    return { ...facts, open: defer, pendingCleanCollapse: defer }
  }
  if (current.mode === 'clean' || facts.mode === 'abnormal' && current.mode !== 'abnormal') {
    return { ...facts, open: true, pendingCleanCollapse: false }
  }
  return { ...facts, open: current.open, pendingCleanCollapse: false }
}

/** Close a disclosure whose clean transition waited for focus to leave. */
function collapseDisclosure(state: DisclosureState): DisclosureState {
  return state.pendingCleanCollapse ? { ...state, open: false, pendingCleanCollapse: false } : state
}

/** Whether a status needs attention rather than a clean completion treatment. */
function abnormal(status: WorkflowRunStatus): boolean {
  return status === 'failed' || status === 'cancelled' || status === 'interrupted'
}

/** Flat run, phase, member order matching {@link WorkflowBlock.parts}. */
function workflowParts(data: WorkflowRunView): readonly WorkflowPartRef[] {
  const parts: WorkflowPartRef[] = [{ kind: 'run' }]
  for (const phase of data.phases) {
    parts.push({ kind: 'phase', key: phase.key })
    for (const member of phase.members) parts.push({ kind: 'member', key: phase.key, member })
  }
  return parts
}

/** Number of started members in every phase. */
function memberCount(data: WorkflowRunView): number {
  return data.phases.reduce((count, phase) => count + phase.members.length, 0)
}

/** Readable terminal label for an exact phase identity. */
function phaseName(phase: string | null): string {
  if (phase === null) return 'unassigned'
  return phase === '' ? '(empty phase)' : phase
}

/** Readable terminal label for an optional workflow member label. */
function memberName(label: string): string {
  return label === '' ? '(unnamed member)' : label
}

/** Compact status count summary matching a phase disclosure's tail. */
function phaseSummary(phase: WorkflowRunPhaseView): string {
  const counts = new Map<WorkflowRunStatus, number>()
  for (const member of phase.members) counts.set(member.status, (counts.get(member.status) ?? 0) + 1)
  const count = (status: WorkflowRunStatus): number => counts.get(status) ?? 0
  const active = (['running', 'failed', 'cancelled', 'interrupted'] as const).filter(status => count(status) > 0)
  const visible = active.length === 0
    ? ['completed' as const]
    : active.includes('interrupted') && count('completed') > 0 ? ['completed' as const, ...active] : active
  return visible.map(status => `${String(count(status))} ${status}`).join(' · ')
}

/** Plain status label kept in source rows. */
function statusText(status: WorkflowRunStatus): string {
  return status
}

/** One run header in transcript colors. */
function runRow(theme: BlockTheme, run: WorkflowRunView): string {
  const { palette } = theme
  const count = memberCount(run)
  return `${statusStyle(palette, run.status)('◇')} ${palette.bold('workflow')} ${palette.link(run.name)} ${palette.dim(`· ${String(count)} member${count === 1 ? '' : 's'} · `)}${statusStyle(palette, run.status)(statusText(run.status))}`
}

/** One phase header in transcript colors. */
function phaseRow(theme: BlockTheme, phase: WorkflowRunPhaseView): string {
  const { palette } = theme
  const count = phase.members.length
  const mode = phaseFacts(phase).mode
  const status = phase.members.find(member => abnormal(member.status))?.status
    ?? (mode === 'running' ? 'running' : 'completed')
  return `  ${statusStyle(palette, status)('▸')} ${palette.heading(phaseName(phase.phase))} ${palette.dim(`· ${String(count)} member${count === 1 ? '' : 's'} · `)}${statusStyle(palette, status)(phaseSummary(phase))}`
}

/** One member row in transcript colors. */
function memberRow(theme: BlockTheme, member: WorkflowRunMemberView, openable: boolean): string {
  const { palette } = theme
  const label = memberName(member.label)
  const name = openable ? palette.link(label) : label
  return `    ${statusStyle(palette, member.status)('○')} ${name} ${statusStyle(palette, member.status)(`[${statusText(member.status)}]`)}`
}

/** Palette role for one workflow status. */
function statusStyle(theme: BlockTheme['palette'], status: WorkflowRunStatus): (text: string) => string {
  switch (status) {
    case 'running': return theme.warning
    case 'completed': return theme.success
    case 'failed': return theme.error
    case 'cancelled':
    case 'interrupted': return theme.warning
    /* v8 ignore next -- WorkflowRunStatus is closed and every variant is handled above. */
    default: return status satisfies never
  }
}

/** Compare local liveness ids before rebuilding a member-row layout. */
function sameIds(left: ReadonlySet<SessionId>, right: ReadonlySet<SessionId>): boolean {
  if (left.size !== right.size) return false
  for (const id of left) if (!right.has(id)) return false
  return true
}
