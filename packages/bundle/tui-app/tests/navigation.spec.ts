/** The transcript as a list of navigable sections. */

import { describe, expect, it } from 'vitest'
import {
  clampCursor,
  enterNewest,
  isSectionSource,
  moveBlock,
  movePart,
  navigableBlocks,
  partLabels,
  sectionHeading,
  type AssistantSection,
  type SectionKind,
  type SectionPart,
  type ToolSection,
  type UserSection,
} from '../src/navigation.ts'

/** Every mark a fake block was told to draw, in the order it was told. */
const marks: (SectionKind | undefined)[] = []

/**
 * Record one mark for the block that received it.
 * @param part - the focused section, or undefined to clear the mark.
 */
function mark(part: SectionKind | undefined): void {
  marks.push(part)
}

/**
 * A prompt block with fixed rows.
 * @param rows - the prompt's own lines.
 * @returns the block.
 */
function userBlock(rows: string[]): UserSection {
  return { blockKind: 'user', navigable: true, turn: 2, parts: () => [{ kind: 'user', rows }], setHighlight: mark }
}

/**
 * A message block with fixed parts.
 * @param parts - its sections in reading order.
 * @returns the block.
 */
function assistantBlock(parts: SectionPart[]): AssistantSection {
  return { blockKind: 'assistant', navigable: true, turn: 2, parts: () => parts, setHighlight: mark }
}

/**
 * A tool card with fixed parts.
 * @param name - the tool's name.
 * @param title - the card headline; empty when the tool declares none.
 * @param parts - its sections in reading order.
 * @returns the block.
 */
function toolBlock(name: string, title: string, parts: SectionPart[]): ToolSection {
  return { blockKind: 'tool', name, title, navigable: true, turn: 2, parts: () => parts, setHighlight: mark }
}

const prompt = userBlock(['read the spec', 'then fix it'])
const reply = assistantBlock([
  { kind: 'reasoning', rows: ['weighing it up'] },
  { kind: 'reply', rows: ['done'] },
])
const card = toolBlock('bash', 'git status', [
  { kind: 'call', rows: ['git status'] },
  { kind: 'result', rows: ['clean'] },
])
const blocks = [prompt, reply, card]

describe('navigableBlocks', () => {
  it('keeps the children that expose sections, in order', () => {
    expect(navigableBlocks([prompt, { render: () => [] }, card])).toEqual([prompt, card])
  })

  it('rejects anything that carries no navigable marker', () => {
    expect(isSectionSource(null)).toBe(false)
    expect(isSectionSource('a printed row')).toBe(false)
    expect(isSectionSource({})).toBe(false)
    expect(isSectionSource(prompt)).toBe(true)
  })
})

describe('entering and moving', () => {
  it('enters on the newest block and its last part', () => {
    expect(enterNewest(blocks)).toEqual({ block: 2, part: 1 })
  })

  it('has nothing to enter in an empty transcript or on a block with no parts', () => {
    expect(enterNewest([])).toBeUndefined()
    expect(enterNewest([assistantBlock([])])).toBeUndefined()
  })

  it('moves between blocks and lands on the destination\'s last part', () => {
    expect(moveBlock({ block: 2, part: 0 }, -1, blocks)).toEqual({ block: 1, part: 1 })
    expect(moveBlock({ block: 1, part: 1 }, -1, blocks)).toEqual({ block: 0, part: 0 })
  })

  it('stays on the held part at either end of the list', () => {
    expect(moveBlock({ block: 0, part: 0 }, -1, blocks)).toEqual({ block: 0, part: 0 })
    expect(moveBlock({ block: 2, part: 0 }, 1, blocks)).toEqual({ block: 2, part: 0 })
  })

  it('moves between the parts of one block and stops at both ends', () => {
    expect(movePart({ block: 1, part: 0 }, 1, blocks)).toEqual({ block: 1, part: 1 })
    expect(movePart({ block: 1, part: 1 }, 1, blocks)).toEqual({ block: 1, part: 1 })
    expect(movePart({ block: 1, part: 0 }, -1, blocks)).toEqual({ block: 1, part: 0 })
  })

  it('leaves a cursor that names no block alone', () => {
    expect(movePart({ block: 9, part: 0 }, 1, blocks)).toEqual({ block: 9, part: 0 })
  })
})

describe('clampCursor', () => {
  it('keeps a cursor the transcript still holds', () => {
    expect(clampCursor({ block: 1, part: 1 }, blocks)).toEqual({ block: 1, part: 1 })
  })

  it('pulls a cursor back inside a list that lost blocks or parts', () => {
    expect(clampCursor({ block: 9, part: 9 }, blocks)).toEqual({ block: 2, part: 1 })
    expect(clampCursor({ block: 1, part: 4 }, [prompt, reply])).toEqual({ block: 1, part: 1 })
  })

  it('holds a cursor that grew a part where it was', () => {
    const growing = toolBlock('bash', '', [{ kind: 'call', rows: ['git status'] }])
    expect(clampCursor({ block: 0, part: 1 }, [growing])).toEqual({ block: 0, part: 0 })
  })

  it('has nothing to hold when the transcript emptied or the block lost its parts', () => {
    expect(clampCursor({ block: 0, part: 0 }, [])).toBeUndefined()
    expect(clampCursor({ block: 0, part: 0 }, [assistantBlock([])])).toBeUndefined()
  })
})

describe('sectionHeading', () => {
  it('names a prompt by its position, turn, and author', () => {
    expect(sectionHeading({ block: 0, part: 0 }, blocks)).toBe('1/3 · turn 2 · you')
  })

  it('names each half of a message', () => {
    expect(sectionHeading({ block: 1, part: 0 }, blocks)).toBe('2/3 · turn 2 · reasoning')
    expect(sectionHeading({ block: 1, part: 1 }, blocks)).toBe('2/3 · turn 2 · reply')
  })

  it('names a tool card by its tool, headline, and section', () => {
    expect(sectionHeading({ block: 2, part: 0 }, blocks)).toBe('3/3 · turn 2 · bash git status · call')
    expect(sectionHeading({ block: 2, part: 1 }, blocks)).toBe('3/3 · turn 2 · bash git status · result')
  })

  it('reports a tool whose result has not landed as running, with no headline to add', () => {
    const running = toolBlock('read', '', [{ kind: 'call', rows: ['{}'] }])
    expect(sectionHeading({ block: 0, part: 0 }, [running])).toBe('1/1 · turn 2 · read · running')
  })

  it('names nothing for a cursor past the blocks or past their parts', () => {
    expect(sectionHeading({ block: 9, part: 0 }, blocks)).toBe('')
    expect(sectionHeading({ block: 0, part: 9 }, blocks)).toBe('')
  })
})

describe('partLabels', () => {
  it('lists the parts of the held block and marks the held one', () => {
    expect(partLabels({ block: 1, part: 1 }, blocks)).toEqual([
      { label: 'reasoning', focused: false },
      { label: 'reply', focused: true },
    ])
    expect(partLabels({ block: 0, part: 0 }, blocks)).toEqual([{ label: 'you', focused: true }])
  })

  it('lists nothing for a cursor past the blocks', () => {
    expect(partLabels({ block: 9, part: 0 }, blocks)).toEqual([])
  })
})

describe('setHighlight', () => {
  it('carries the focused section, and clears the mark with undefined', () => {
    reply.setHighlight('reply')
    card.setHighlight(undefined)
    expect(marks).toEqual(['reply', undefined])
  })
})
