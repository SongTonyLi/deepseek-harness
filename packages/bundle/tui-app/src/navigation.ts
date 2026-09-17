/**
 * The transcript as a list of navigable sections.
 *
 * A conversation is drawn as one component per fact, and the keyboard walks it
 * in two directions: between blocks and, inside a block, between its parts -
 * the reasoning and the reply of a message, the call and the result of a tool.
 * This module turns the transcript container's children into that list and
 * moves one cursor over it. Everything here is plain data: no pi-tui, no
 * palette, no clock. The rows a part carries are the block's own source text,
 * so the page `Enter` opens shows what the model wrote rather than a rendering
 * of it.
 * @module @deepseek-ai/dsh-tui-app/navigation
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'

/** What separates two facts inside one heading. */
const SEPARATOR = ' · '

/** Which section of a block one part is. */
export type SectionKind = 'user' | 'reasoning' | 'reply' | 'call' | 'result'

/** One navigable section of a block. */
export interface SectionPart {
  kind: SectionKind
  /** The section's full source rows, unwrapped and without palette styling. */
  rows: readonly string[]
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
   * @param part - the section drawn as focused, or undefined to clear the mark.
   */
  setHighlight(part: SectionKind | undefined): void
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

/**
 * A navigable transcript block: the sections the keyboard walks and the focus
 * mark it draws while one of them is held. `UserBlock`, `AssistantBlock`, and
 * `ToolBlock` implement it; notices and printed rows do not, which is how
 * {@link navigableBlocks} tells them apart.
 */
export type SectionSource = UserSection | AssistantSection | ToolSection

/** Where the transcript focus sits: one block, and one part inside it. */
export interface TranscriptCursor {
  /** Index into the navigable blocks, oldest first. */
  block: number
  /** Index into that block's parts, in reading order. */
  part: number
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
 * Where the keyboard enters the transcript: the newest block, on its last
 * part, which is the most recent thing the session produced.
 * @param blocks - the navigable blocks.
 * @returns the cursor, or undefined when the transcript has nothing to inspect.
 */
export function enterNewest(blocks: readonly SectionSource[]): TranscriptCursor | undefined {
  const block = blocks.length - 1
  const parts = partCount(blocks, block)
  if (parts === 0) return undefined
  return { block, part: parts - 1 }
}

/**
 * Move to another block, landing on its last part.
 * @param cursor - where the focus sits.
 * @param step - 1 for the next block, -1 for the previous one.
 * @param blocks - the navigable blocks.
 * @returns the new cursor; the cursor itself at either end of the list.
 */
export function moveBlock(cursor: TranscriptCursor, step: number, blocks: readonly SectionSource[]): TranscriptCursor {
  const block = clampIndex(cursor.block + step, blocks.length)
  if (block === cursor.block) return cursor
  return { block, part: Math.max(0, partCount(blocks, block) - 1) }
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
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default:
      return assertNever(block, 'tui transcript block kind')
  }
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
  return [position, `turn ${String(block.turn)}`, ...subjectOf(block, part)].join(SEPARATOR)
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
  return block.parts().map((part, index) => ({ label: partLabel(part.kind), focused: index === cursor.part }))
}
