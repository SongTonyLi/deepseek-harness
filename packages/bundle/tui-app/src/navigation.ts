/**
 * The transcript as a list of navigable sections.
 *
 * A conversation is drawn as one component per fact, and the keyboard walks it
 * in two directions: `Up` / `Down` through every section in reading order —
 * a system prompt, injected context, the reasoning and the reply of a message,
 * the call and the result of a tool — and `Left` / `Right` between the parts
 * of the held block without leaving it. Snapshot contributions are separate
 * parts of one injected block, so the arrows walk each named piece of context.
 * A long conversation is also walked coarsely: one block at a time, one turn
 * at a time over the groups each prompt opens, and to either end.
 * This module turns the transcript container's children into that list and
 * moves one cursor over it. Everything here is plain data: no pi-tui, no
 * palette, no clock. The rows a part carries are the block's own source text,
 * so the page `Enter` opens shows what the model wrote rather than a rendering
 * of it.
 * @module @deepseek-ai/dsh-tui-app/navigation
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { MotionLevel } from './motion.ts'

/** What separates two facts inside one heading. */
const SEPARATOR = ' · '

/** Which section of a block one part is. */
export type SectionKind =
  | 'user'
  | 'reasoning'
  | 'reply'
  | 'call'
  | 'result'
  | 'system'
  | 'instructions'
  | 'catalog'
  | 'snapshot'
  | 'notice'
  | 'relay'
  | 'recall'
  | 'context'

/** One navigable section of a block. */
export interface SectionPart {
  kind: SectionKind
  /** The section's full source rows, unwrapped and without palette styling. */
  rows: readonly string[]
  /** Strip and heading label when it is not the kind name, e.g. a snapshot contribution. */
  label?: string
}

/** What every navigable transcript block exposes, whatever kind it is. */
interface SectionSourceBase {
  /** Marks a transcript child as navigable; {@link isSectionSource} tests it. */
  readonly navigable: true
  /** The turn the block was appended in; 0 before the session's first turn. */
  readonly turn: number
  /**
   * The block's sections in reading order.
   * @returns the parts; reasoning is absent while empty and a tool's result is
   * absent until it lands, so the list grows as the block does.
   */
  parts(): readonly SectionPart[]
  /**
   * Draw this block with the focus mark, or without it.
   * @param part - the index of the section drawn as focused, or undefined to clear the mark.
   * @param level - how far above its settled drawing the mark itself is
   * lifted, which is how a step of the walk is seen; omitted draws the
   * settled mark.
   */
  setHighlight(part: number | undefined, level?: MotionLevel): void
}

/** A prompt the user submitted, as the keyboard sees it. */
export interface UserSection extends SectionSourceBase {
  readonly blockKind: 'user'
}

/** An assistant message, as the keyboard sees it. */
export interface AssistantSection extends SectionSourceBase {
  readonly blockKind: 'assistant'
}

/** A tool card, as the keyboard sees it. */
export interface ToolSection extends SectionSourceBase {
  readonly blockKind: 'tool'
  /** The tool's name. */
  readonly name: string
  /** The card headline the tool's presenter produced; empty when it declares none. */
  readonly title: string
}

/** A system prompt or injected context, as the keyboard sees it. */
export interface ContextSection extends SectionSourceBase {
  readonly blockKind: 'context'
  /** Form and producer, a notice summary, or `system prompt` / `system prompt update`. */
  readonly title: string
}

/**
 * A navigable transcript block: the sections the keyboard walks and the focus
 * mark it draws while one of them is held. `UserBlock`, `AssistantBlock`,
 * `ToolBlock`, and `ContextBlock` implement it; turn-end notices and printed
 * rows do not, which is how {@link navigableBlocks} tells them apart.
 */
export type SectionSource = UserSection | AssistantSection | ToolSection | ContextSection

/** Where the transcript focus sits: one block, and one part inside it. */
export interface TranscriptCursor {
  /** Index into the navigable blocks, oldest first. */
  block: number
  /** Index into that block's parts, in reading order. */
  part: number
}

/** What one movement key steps the transcript focus along. */
export type TranscriptAxis =
  /** One navigable section, in reading order. */
  | 'section'
  /** One navigable block, landing on its first section. */
  | 'block'
  /** One turn group, landing on its first section. */
  | 'turn'
  /** One part of the block the cursor holds. */
  | 'part'

/**
 * Which way along its axis one movement key steps. `first` and `last` are the
 * ends of the axis; on the block and turn axes, which the key model binds to
 * neither, they step one entry the same way `previous` and `next` do.
 */
export type MoveTarget = 'previous' | 'next' | 'first' | 'last'

/** What one turn contributed, counted for the rail that compares turns. */
export interface TurnMarkers {
  /** Injected context blocks, the system prompt included. */
  context: number
  /** Whether any message of the turn carries reasoning. */
  reasoning: boolean
  /** Whether any message of the turn carries a reply. */
  reply: boolean
  /** Tool calls the turn made. */
  tools: number
}

/** The blocks of one prompt and everything the session produced answering it. */
export interface TurnGroup {
  /** The largest turn number among the group's blocks. */
  turn: number
  /** The first line of the group's prompt, and `session start` before the first one. */
  label: string
  /** What the group contributed, for a glance across turns. */
  markers: TurnMarkers
  /** Every section of the group, in reading order. */
  sections: readonly TranscriptCursor[]
}

/** One entry of the inspector's parts strip. */
export interface PartLabel {
  /** What the strip calls the part. */
  label: string
  /** Whether the cursor holds this part. */
  focused: boolean
}

/**
 * Whether one transcript child is navigable.
 * @param child - a child of the transcript container.
 * @returns true when the child carries the navigable marker.
 */
export function isSectionSource(child: unknown): child is SectionSource {
  return typeof child === 'object' && child !== null && (child as { navigable?: unknown }).navigable === true
}

/**
 * The navigable blocks of a transcript, in drawing order.
 * @param children - the transcript container's children.
 * @returns the children that expose sections; notices and printed rows are left out.
 */
export function navigableBlocks(children: readonly unknown[]): SectionSource[] {
  return children.filter(isSectionSource)
}

/**
 * Hold one index inside a list.
 * @param index - the wanted index.
 * @param length - the list length; at least 1.
 * @returns the index, moved to the nearest end when it falls outside.
 */
function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length - 1))
}

/**
 * How many parts one block carries.
 * @param blocks - the navigable blocks.
 * @param index - the block to count.
 * @returns the count, and 0 for an index past the list.
 */
function partCount(blocks: readonly SectionSource[], index: number): number {
  return blocks[index]?.parts().length ?? 0
}

/**
 * The oldest section of the transcript, which `Home` reaches.
 * @param blocks - the navigable blocks.
 * @returns the cursor, or undefined when no block carries a section.
 */
export function firstSection(blocks: readonly SectionSource[]): TranscriptCursor | undefined {
  for (let block = 0; block < blocks.length; block += 1) {
    if (partCount(blocks, block) > 0) return { block, part: 0 }
  }
  return undefined
}

/**
 * The newest section of the transcript: the most recent thing the session
 * produced, which `End` reaches and which the keyboard enters a transcript it
 * has not walked yet on.
 * @param blocks - the navigable blocks.
 * @returns the cursor, or undefined when no block carries a section.
 */
export function lastSection(blocks: readonly SectionSource[]): TranscriptCursor | undefined {
  for (let block = blocks.length - 1; block >= 0; block -= 1) {
    const parts = partCount(blocks, block)
    if (parts > 0) return { block, part: parts - 1 }
  }
  return undefined
}

/**
 * Every section of the transcript in drawing order, oldest block first and
 * each block's parts in reading order. Blocks that currently expose no parts
 * are omitted, so a walk never lands on an empty index.
 * @param blocks - the navigable blocks.
 * @returns one cursor per section.
 */
function flattenSections(blocks: readonly SectionSource[]): TranscriptCursor[] {
  const sections: TranscriptCursor[] = []
  for (let block = 0; block < blocks.length; block += 1) {
    const count = partCount(blocks, block)
    for (let part = 0; part < count; part += 1) sections.push({ block, part })
  }
  return sections
}

/**
 * Whether two cursors name the same section.
 * @param left - one cursor.
 * @param right - the other.
 * @returns true when both name the same block and part.
 */
function sameSection(left: TranscriptCursor, right: TranscriptCursor): boolean {
  return left.block === right.block && left.part === right.part
}

/**
 * Index into a non-empty flattened section list.
 * @param sections - the flattened sections; length at least 1.
 * @param index - an in-range index.
 * @param fallback - used when that index has no section.
 * @returns that section.
 */
function sectionAt(sections: readonly TranscriptCursor[], index: number, fallback: TranscriptCursor): TranscriptCursor {
  const section = sections[index]
  /* v8 ignore next -- callers pass an in-range index into a non-empty list */
  return section ?? fallback
}

/**
 * Move to another section in reading order: the previous or next part of the
 * held block, or the last or first part of the neighbouring block that has
 * one. A block whose `parts()` is empty is skipped.
 * @param cursor - where the focus sits.
 * @param step - 1 for the next section, -1 for the previous one.
 * @param blocks - the navigable blocks.
 * @returns the new cursor; the cursor itself at either end of the transcript.
 */
export function moveSection(cursor: TranscriptCursor, step: number, blocks: readonly SectionSource[]): TranscriptCursor {
  const sections = flattenSections(blocks)
  if (sections.length === 0) return cursor
  const settled = clampCursor(cursor, blocks)
  if (settled === undefined) {
    const index = step >= 0
      ? sections.findIndex(section => section.block > cursor.block)
      : sections.findLastIndex(section => section.block < cursor.block)
    if (index < 0) return sectionAt(sections, step >= 0 ? sections.length - 1 : 0, cursor)
    return sectionAt(sections, index, cursor)
  }
  const index = sections.findIndex(section => sameSection(section, settled))
  /* v8 ignore next -- a settled cursor is always in flattenSections */
  if (index < 0) return settled
  return sectionAt(sections, clampIndex(index + step, sections.length), settled)
}

/**
 * Move between the parts of the held block.
 * @param cursor - where the focus sits.
 * @param step - 1 for the next part, -1 for the previous one.
 * @param blocks - the navigable blocks.
 * @returns the new cursor; the cursor itself at either end of the block.
 */
export function movePart(cursor: TranscriptCursor, step: number, blocks: readonly SectionSource[]): TranscriptCursor {
  const parts = partCount(blocks, cursor.block)
  if (parts === 0) return cursor
  return { block: cursor.block, part: clampIndex(cursor.part + step, parts) }
}

/**
 * Move to the neighbouring block, landing on its first section, which is the
 * coarse step over a conversation too long to walk section by section. A
 * block whose `parts()` is empty is skipped.
 * @param cursor - where the focus sits.
 * @param step - 1 for the next block, -1 for the previous one.
 * @param blocks - the navigable blocks.
 * @returns the new cursor; the held section at either end of the transcript,
 * and the cursor itself when no block carries a section.
 */
export function moveBlock(cursor: TranscriptCursor, step: number, blocks: readonly SectionSource[]): TranscriptCursor {
  const settled = clampCursor(cursor, blocks)
  const from = settled?.block ?? cursor.block
  for (let block = from + step; block >= 0 && block < blocks.length; block += step) {
    if (partCount(blocks, block) > 0) return { block, part: 0 }
  }
  return settled ?? cursor
}

/** What the group before the session's first prompt is called. */
const SESSION_START = 'session start'

/** One group while it is still taking blocks. */
interface OpenGroup extends TurnGroup {
  markers: TurnMarkers
  sections: TranscriptCursor[]
}

/**
 * The first line of one prompt, which names its turn.
 * @param parts - the prompt block's sections.
 * @returns the line, and the empty string for a prompt with no text.
 */
function promptLabel(parts: readonly SectionPart[]): string {
  const [first] = parts
  const [line] = first?.rows ?? []
  return line ?? ''
}

/**
 * Count one block into the group that holds it.
 * @param markers - the group's markers, updated in place.
 * @param block - the block.
 * @param parts - its sections, read once by the caller.
 */
function countMarkers(markers: TurnMarkers, block: SectionSource, parts: readonly SectionPart[]): void {
  if (block.blockKind === 'context') markers.context += 1
  if (block.blockKind === 'tool') markers.tools += 1
  for (const part of parts) {
    if (part.kind === 'reasoning') markers.reasoning = true
    if (part.kind === 'reply') markers.reply = true
  }
}

/**
 * Group the transcript by prompt: every `user` block opens a group, and the
 * blocks before the first prompt — a system prompt and the context injected
 * with it — form one `session start` group.
 *
 * The grouping is the prompts themselves rather than `block.turn`, because a
 * prompt block carries the turn in force when it was appended, which is the
 * turn before the one it opens.
 * @param blocks - the navigable blocks.
 * @returns the groups, oldest first; a group with no section at all is left
 * out, so every group the keyboard reaches can be entered.
 */
export function turnGroups(blocks: readonly SectionSource[]): readonly TurnGroup[] {
  const groups: OpenGroup[] = []
  let open: OpenGroup | undefined
  for (const [index, block] of blocks.entries()) {
    const parts = block.parts()
    if (open === undefined || block.blockKind === 'user') {
      open = {
        turn: block.turn,
        label: block.blockKind === 'user' ? promptLabel(parts) : SESSION_START,
        markers: { context: 0, reasoning: false, reply: false, tools: 0 },
        sections: [],
      }
      groups.push(open)
    }
    open.turn = Math.max(open.turn, block.turn)
    countMarkers(open.markers, block, parts)
    for (let part = 0; part < parts.length; part += 1) open.sections.push({ block: index, part })
  }
  return groups.filter(group => group.sections.length > 0)
}

/**
 * Which group holds one cursor.
 * @param cursor - where the focus sits.
 * @param groups - the groups of the same transcript.
 * @returns the index into `groups`, or -1 when no group holds the cursor's block.
 */
export function turnIndexOf(cursor: TranscriptCursor, groups: readonly TurnGroup[]): number {
  return groups.findIndex(group => group.sections.some(section => section.block === cursor.block))
}

/**
 * One section of one group, by position.
 * @param groups - the groups of the transcript.
 * @param group - the index into `groups`; an index outside it is pulled to the nearest end.
 * @param section - the index into that group's sections, pulled the same way.
 * @returns the cursor, or undefined when the transcript has no group at all.
 */
export function cursorAt(groups: readonly TurnGroup[], group: number, section: number): TranscriptCursor | undefined {
  const held = groups[clampIndex(group, groups.length)]
  if (held === undefined) return undefined
  return held.sections[clampIndex(section, held.sections.length)]
}

/**
 * Move to the neighbouring turn, landing on its first section.
 * @param cursor - where the focus sits.
 * @param step - 1 for the next turn, -1 for the previous one.
 * @param blocks - the navigable blocks.
 * @returns the new cursor; the first section of the held turn at either end,
 * and the cursor itself when no group holds it.
 */
export function moveTurn(cursor: TranscriptCursor, step: number, blocks: readonly SectionSource[]): TranscriptCursor {
  const groups = turnGroups(blocks)
  const index = turnIndexOf(cursor, groups)
  if (index === -1) return cursor
  /* v8 ignore next -- a clamped index names a group, and every group carries a section */
  return cursorAt(groups, index + step, 0) ?? cursor
}

/**
 * Which way one target steps along its axis.
 * @param to - the target the key named.
 * @returns -1 towards the start of the axis, 1 towards its end.
 */
function stepFor(to: MoveTarget): -1 | 1 {
  return to === 'previous' || to === 'first' ? -1 : 1
}

/**
 * Step the transcript focus along one axis, which is what every transcript
 * movement key does.
 * @param cursor - where the focus sits.
 * @param axis - what the key steps along.
 * @param to - which way along it.
 * @param blocks - the navigable blocks.
 * @returns the new cursor, and the held one at the end of the axis.
 */
export function moveTranscriptCursor(
  cursor: TranscriptCursor,
  axis: TranscriptAxis,
  to: MoveTarget,
  blocks: readonly SectionSource[],
): TranscriptCursor {
  switch (axis) {
    case 'section': {
      if (to === 'first') return firstSection(blocks) ?? cursor
      if (to === 'last') return lastSection(blocks) ?? cursor
      return moveSection(cursor, stepFor(to), blocks)
    }
    case 'part': {
      const reach = to === 'first' || to === 'last' ? partCount(blocks, cursor.block) : 1
      return movePart(cursor, stepFor(to) * reach, blocks)
    }
    case 'block':
      return moveBlock(cursor, stepFor(to), blocks)
    case 'turn':
      return moveTurn(cursor, stepFor(to), blocks)
    /* v8 ignore next 2 -- closed-union exhaustiveness guard */
    default:
      return assertNever(axis, 'tui transcript axis')
  }
}

/**
 * Put a remembered cursor back on the current transcript, which grew a block,
 * grew a part, or was replaced by another session since it was taken.
 * @param cursor - the remembered cursor.
 * @param blocks - the navigable blocks as they are now.
 * @returns the cursor inside the current list, or undefined when the
 * transcript has nothing to hold it.
 */
export function clampCursor(cursor: TranscriptCursor, blocks: readonly SectionSource[]): TranscriptCursor | undefined {
  if (blocks.length === 0) return undefined
  const block = clampIndex(cursor.block, blocks.length)
  const parts = partCount(blocks, block)
  if (parts === 0) return undefined
  return { block, part: clampIndex(cursor.part, parts) }
}

/**
 * The part the cursor holds.
 * @param cursor - where the focus sits.
 * @param blocks - the navigable blocks.
 * @returns the part, or undefined when the cursor points past the list.
 */
function partAt(cursor: TranscriptCursor, blocks: readonly SectionSource[]): SectionPart | undefined {
  return blocks[cursor.block]?.parts()[cursor.part]
}

/**
 * What the inspector and the parts strip call one section.
 * @param kind - the section.
 * @returns the label; the user's own prompt reads as `you`.
 */
function partLabel(kind: SectionKind): string {
  return kind === 'user' ? 'you' : kind
}

/**
 * How a block names the held section after its position and turn.
 * @param block - the held block.
 * @param part - the held part.
 * @returns the naming facts, in heading order.
 */
function subjectOf(block: SectionSource, part: SectionPart): string[] {
  switch (block.blockKind) {
    case 'user':
    case 'assistant':
      return [partLabel(part.kind)]
    case 'tool': {
      const card = block.title === '' ? block.name : `${block.name} ${block.title}`
      // A tool whose result has not landed is still running, which its card's
      // status glyph shows and the heading repeats for the inspector.
      const settled = block.parts().some(candidate => candidate.kind === 'result')
      return [card, settled ? partLabel(part.kind) : 'running']
    }
    case 'context':
      return part.label === undefined || part.label === block.title
        ? [block.title]
        : [block.title, part.label]
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      return assertNever(block, 'tui transcript block kind')
  }
}

/**
 * What one section is called: `you`, `reply`, the tool card and its section,
 * or the injected context and its contribution. The docked inspector names it
 * after the position and turn; a surface that already states both prints the
 * label alone.
 * @param block - the block the section belongs to.
 * @param part - the section.
 * @returns the label, e.g. `bash git status · result`.
 */
export function sectionLabel(block: SectionSource, part: SectionPart): string {
  return subjectOf(block, part).join(SEPARATOR)
}

/**
 * The inspector heading of the held section: its position in the transcript,
 * the turn it belongs to, and what the section is.
 * @param cursor - where the focus sits.
 * @param blocks - the navigable blocks.
 * @returns the heading, or an empty string when the cursor points past the list.
 */
export function sectionHeading(cursor: TranscriptCursor, blocks: readonly SectionSource[]): string {
  const block = blocks[cursor.block]
  const part = partAt(cursor, blocks)
  if (block === undefined || part === undefined) return ''
  const position = `${String(cursor.block + 1)}/${String(blocks.length)}`
  return [position, `turn ${String(block.turn)}`, sectionLabel(block, part)].join(SEPARATOR)
}

/**
 * The parts strip of the held block.
 * @param cursor - where the focus sits.
 * @param blocks - the navigable blocks.
 * @returns one label per part in reading order, the held one marked; empty
 * when the cursor points past the list.
 */
export function partLabels(cursor: TranscriptCursor, blocks: readonly SectionSource[]): PartLabel[] {
  const block = blocks[cursor.block]
  if (block === undefined) return []
  return block.parts().map((part, index) => ({
    label: part.label ?? partLabel(part.kind),
    focused: index === cursor.part,
  }))
}
