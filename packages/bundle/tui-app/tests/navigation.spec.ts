/** The transcript as a list of navigable sections. */

import { describe, expect, it } from 'vitest'
import {
  clampCursor,
  cursorAt,
  firstSection,
  isSectionSource,
  lastSection,
  moveBlock,
  movePart,
  moveSection,
  moveTranscriptCursor,
  moveTurn,
  navigableBlocks,
  partLabels,
  sectionHeading,
  sectionLabel,
  turnGroups,
  turnIndexOf,
  type AssistantSection,
  type ContextSection,
  type SectionPart,
  type ToolSection,
  type UserSection,
} from '../src/navigation.ts'

/** Every mark a fake block was told to draw, in the order it was told. */
const marks: (number | undefined)[] = []

/**
 * Record one mark for the block that received it.
 * @param part - the focused section index, or undefined to clear the mark.
 */
function mark(part: number | undefined): void {
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

/**
 * A system prompt or injected context with fixed parts.
 * @param title - the heading name.
 * @param parts - its sections in reading order.
 * @returns the block.
 */
function contextBlock(title: string, parts: SectionPart[]): ContextSection {
  return { blockKind: 'context', title, navigable: true, turn: 0, parts: () => parts, setHighlight: mark }
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
  it('names the newest section and the oldest one', () => {
    expect(lastSection(blocks)).toEqual({ block: 2, part: 1 })
    expect(firstSection(blocks)).toEqual({ block: 0, part: 0 })
  })

  it('steps over a block that carries no section yet at either end', () => {
    const empty = assistantBlock([])
    expect(lastSection([prompt, empty])).toEqual({ block: 0, part: 0 })
    expect(firstSection([empty, card])).toEqual({ block: 1, part: 0 })
  })

  it('has no section in an empty transcript or on a block with no parts', () => {
    expect(lastSection([])).toBeUndefined()
    expect(firstSection([])).toBeUndefined()
    expect(lastSection([assistantBlock([])])).toBeUndefined()
    expect(firstSection([assistantBlock([])])).toBeUndefined()
  })

  it('walks every section in reading order, crossing from a block into its neighbour', () => {
    expect(moveSection({ block: 2, part: 1 }, -1, blocks)).toEqual({ block: 2, part: 0 })
    expect(moveSection({ block: 2, part: 0 }, -1, blocks)).toEqual({ block: 1, part: 1 })
    expect(moveSection({ block: 1, part: 1 }, -1, blocks)).toEqual({ block: 1, part: 0 })
    expect(moveSection({ block: 1, part: 0 }, -1, blocks)).toEqual({ block: 0, part: 0 })
    expect(moveSection({ block: 0, part: 0 }, 1, blocks)).toEqual({ block: 1, part: 0 })
    expect(moveSection({ block: 1, part: 0 }, 1, blocks)).toEqual({ block: 1, part: 1 })
    expect(moveSection({ block: 1, part: 1 }, 1, blocks)).toEqual({ block: 2, part: 0 })
  })

  it('stays on the held section at either end of the transcript', () => {
    expect(moveSection({ block: 0, part: 0 }, -1, blocks)).toEqual({ block: 0, part: 0 })
    expect(moveSection({ block: 2, part: 1 }, 1, blocks)).toEqual({ block: 2, part: 1 })
  })

  it('skips a neighbouring block that has no parts', () => {
    const empty = assistantBlock([])
    const withGap = [prompt, empty, card]
    expect(moveSection({ block: 0, part: 0 }, 1, withGap)).toEqual({ block: 2, part: 0 })
    expect(moveSection({ block: 2, part: 0 }, -1, withGap)).toEqual({ block: 0, part: 0 })
    expect(moveSection({ block: 1, part: 0 }, 1, withGap)).toEqual({ block: 2, part: 0 })
    expect(moveSection({ block: 1, part: 0 }, -1, withGap)).toEqual({ block: 0, part: 0 })
    expect(moveSection({ block: 1, part: 0 }, 1, [card, empty])).toEqual({ block: 0, part: 1 })
    expect(moveSection({ block: 0, part: 0 }, -1, [empty, card])).toEqual({ block: 1, part: 0 })
  })

  it('has nowhere to walk when every block is empty', () => {
    expect(moveSection({ block: 0, part: 0 }, 1, [])).toEqual({ block: 0, part: 0 })
    expect(moveSection({ block: 0, part: 0 }, 1, [assistantBlock([])])).toEqual({ block: 0, part: 0 })
  })

  it('moves between the parts of one block and stops at both ends', () => {
    expect(movePart({ block: 1, part: 0 }, 1, blocks)).toEqual({ block: 1, part: 1 })
    expect(movePart({ block: 1, part: 1 }, 1, blocks)).toEqual({ block: 1, part: 1 })
    expect(movePart({ block: 1, part: 0 }, -1, blocks)).toEqual({ block: 1, part: 0 })
  })

  it('leaves a cursor that names no block alone', () => {
    expect(movePart({ block: 9, part: 0 }, 1, blocks)).toEqual({ block: 9, part: 0 })
  })

  it('jumps a whole block, landing on its first part', () => {
    expect(moveBlock({ block: 2, part: 1 }, -1, blocks)).toEqual({ block: 1, part: 0 })
    expect(moveBlock({ block: 1, part: 1 }, -1, blocks)).toEqual({ block: 0, part: 0 })
    expect(moveBlock({ block: 0, part: 0 }, 1, blocks)).toEqual({ block: 1, part: 0 })
  })

  it('holds the section it was on at either end of the transcript', () => {
    expect(moveBlock({ block: 0, part: 0 }, -1, blocks)).toEqual({ block: 0, part: 0 })
    expect(moveBlock({ block: 2, part: 1 }, 1, blocks)).toEqual({ block: 2, part: 1 })
  })

  it('steps over a block with no parts, and has nowhere to jump in an empty transcript', () => {
    const empty = assistantBlock([])
    expect(moveBlock({ block: 0, part: 0 }, 1, [prompt, empty, card])).toEqual({ block: 2, part: 0 })
    expect(moveBlock({ block: 2, part: 0 }, -1, [prompt, empty, card])).toEqual({ block: 0, part: 0 })
    expect(moveBlock({ block: 0, part: 0 }, 1, [])).toEqual({ block: 0, part: 0 })
    expect(moveBlock({ block: 0, part: 0 }, 1, [empty])).toEqual({ block: 0, part: 0 })
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

  it('names a system prompt and each snapshot contribution', () => {
    const context = [
      contextBlock('system prompt', [{ kind: 'system', rows: ['You are the agent.'] }]),
      contextBlock('snapshot · workspace', [
        { kind: 'snapshot', label: 'sandbox', rows: ['allow python'] },
        { kind: 'snapshot', label: 'git', rows: ['clean'] },
      ]),
    ]
    expect(sectionHeading({ block: 0, part: 0 }, context)).toBe('1/2 · turn 0 · system prompt')
    expect(sectionHeading({ block: 1, part: 0 }, context)).toBe('2/2 · turn 0 · snapshot · workspace · sandbox')
    expect(sectionHeading({ block: 1, part: 1 }, context)).toBe('2/2 · turn 0 · snapshot · workspace · git')
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

  it('uses a snapshot contribution name as the strip label', () => {
    const snapshot = contextBlock('snapshot · workspace', [
      { kind: 'snapshot', label: 'sandbox', rows: ['allow python'] },
      { kind: 'snapshot', label: 'git', rows: ['clean'] },
    ])
    expect(partLabels({ block: 0, part: 1 }, [snapshot])).toEqual([
      { label: 'sandbox', focused: false },
      { label: 'git', focused: true },
    ])
  })

  it('does not repeat a contribution name that already is the title', () => {
    const named = contextBlock('sandbox', [{ kind: 'snapshot', label: 'sandbox', rows: ['allow'] }])
    expect(sectionHeading({ block: 0, part: 0 }, [named])).toBe('1/1 · turn 0 · sandbox')
  })

  it('lists nothing for a cursor past the blocks', () => {
    expect(partLabels({ block: 9, part: 0 }, blocks)).toEqual([])
  })
})

describe('sectionLabel', () => {
  it('names the section alone, for a surface that already states the position and turn', () => {
    expect(sectionLabel(prompt, { kind: 'user', rows: ['read the spec'] })).toBe('you')
    expect(sectionLabel(reply, { kind: 'reply', rows: ['done'] })).toBe('reply')
    expect(sectionLabel(card, { kind: 'result', rows: ['clean'] })).toBe('bash git status · result')
    expect(sectionLabel(contextBlock('snapshot · workspace', [{ kind: 'snapshot', label: 'git', rows: ['clean'] }]), { kind: 'snapshot', label: 'git', rows: ['clean'] }))
      .toBe('snapshot · workspace · git')
  })
})

/**
 * A prompt block appended in `turn`, which is the turn in force before the one
 * the prompt opens.
 * @param turn - the turn the block carries.
 * @param text - the prompt's own lines.
 * @returns the block.
 */
function promptIn(turn: number, text: string): UserSection {
  return { blockKind: 'user', navigable: true, turn, parts: () => [{ kind: 'user', rows: text.split('\n') }], setHighlight: mark }
}

/**
 * A message block appended in `turn`.
 * @param turn - the turn the block carries.
 * @param parts - its sections in reading order.
 * @returns the block.
 */
function replyIn(turn: number, parts: SectionPart[]): AssistantSection {
  return { blockKind: 'assistant', navigable: true, turn, parts: () => parts, setHighlight: mark }
}

/** A system prompt, one prompt answered with reasoning, a reply and a tool call, then a turn still streaming. */
const system = contextBlock('system prompt', [{ kind: 'system', rows: ['You are the agent.'] }])
const firstPrompt = promptIn(0, 'read the spec\nthen fix it')
const firstReply = replyIn(1, [{ kind: 'reasoning', rows: ['weighing it up'] }, { kind: 'reply', rows: ['done'] }])
const firstCard: ToolSection = {
  blockKind: 'tool',
  name: 'bash',
  title: 'git status',
  navigable: true,
  turn: 1,
  parts: () => [{ kind: 'call', rows: ['git status'] }, { kind: 'result', rows: ['clean'] }],
  setHighlight: mark,
}
const secondPrompt = promptIn(1, 'now ship it')
const streaming = replyIn(2, [{ kind: 'reasoning', rows: ['planning the call'] }])
const grouped = [system, firstPrompt, firstReply, firstCard, secondPrompt, streaming]

describe('turnGroups', () => {
  it('opens a group at every prompt and gathers what came before the first one', () => {
    const groups = turnGroups(grouped)
    expect(groups.map(group => group.label)).toEqual(['session start', 'read the spec', 'now ship it'])
    // A prompt carries the turn in force before the one it opens, so the
    // group takes the largest turn among its own blocks.
    expect(groups.map(group => group.turn)).toEqual([0, 1, 2])
    expect(groups.map(group => group.sections.length)).toEqual([1, 5, 2])
  })

  it('counts what each turn contributed, and flags a streaming turn with no reply yet', () => {
    expect(turnGroups(grouped).map(group => group.markers)).toEqual([
      { context: 1, reasoning: false, reply: false, tools: 0 },
      { context: 0, reasoning: true, reply: true, tools: 1 },
      { context: 0, reasoning: true, reply: false, tools: 0 },
    ])
  })

  it('gives two prompts queued inside one turn a group each', () => {
    const queued = [promptIn(3, 'first ask'), promptIn(3, 'second ask'), replyIn(4, [{ kind: 'reply', rows: ['both done'] }])]
    const groups = turnGroups(queued)
    expect(groups.map(group => group.label)).toEqual(['first ask', 'second ask'])
    expect(groups.map(group => group.turn)).toEqual([3, 4])
    expect(groups.map(group => group.sections)).toEqual([[{ block: 0, part: 0 }], [{ block: 1, part: 0 }, { block: 2, part: 0 }]])
  })

  it('leaves out a group with nothing to walk, and names a prompt with no rows', () => {
    const blank: UserSection = { blockKind: 'user', navigable: true, turn: 1, parts: () => [], setHighlight: mark }
    const rowless: UserSection = { blockKind: 'user', navigable: true, turn: 1, parts: () => [{ kind: 'user', rows: [] }], setHighlight: mark }
    expect(turnGroups([blank])).toEqual([])
    expect(turnGroups([assistantBlock([]), firstPrompt]).map(group => group.label)).toEqual(['read the spec'])
    expect(turnGroups([rowless]).map(group => group.label)).toEqual([''])
  })
})

describe('turnIndexOf and cursorAt', () => {
  it('round-trips every section through the group that holds it', () => {
    const groups = turnGroups(grouped)
    for (const [index, group] of groups.entries()) {
      for (const [position, section] of group.sections.entries()) {
        expect(turnIndexOf(section, groups)).toBe(index)
        expect(cursorAt(groups, index, position)).toEqual(section)
      }
    }
  })

  it('holds a position outside the groups, and has nothing to name without one', () => {
    const groups = turnGroups(grouped)
    expect(turnIndexOf({ block: 9, part: 0 }, groups)).toBe(-1)
    expect(cursorAt(groups, 99, 99)).toEqual({ block: 5, part: 0 })
    expect(cursorAt([], 0, 0)).toBeUndefined()
  })
})

describe('moveTurn', () => {
  it('lands on the first section of the neighbouring turn and stops at both ends', () => {
    expect(moveTurn({ block: 5, part: 0 }, -1, grouped)).toEqual({ block: 1, part: 0 })
    expect(moveTurn({ block: 3, part: 1 }, -1, grouped)).toEqual({ block: 0, part: 0 })
    expect(moveTurn({ block: 0, part: 0 }, -1, grouped)).toEqual({ block: 0, part: 0 })
    expect(moveTurn({ block: 0, part: 0 }, 1, grouped)).toEqual({ block: 1, part: 0 })
    expect(moveTurn({ block: 5, part: 0 }, 1, grouped)).toEqual({ block: 4, part: 0 })
  })

  it('leaves a cursor no group holds alone', () => {
    expect(moveTurn({ block: 9, part: 0 }, 1, grouped)).toEqual({ block: 9, part: 0 })
    expect(moveTurn({ block: 0, part: 0 }, 1, [])).toEqual({ block: 0, part: 0 })
  })
})

describe('moveTranscriptCursor', () => {
  it('steps each axis the way its keys name it', () => {
    expect(moveTranscriptCursor({ block: 2, part: 1 }, 'section', 'previous', blocks)).toEqual({ block: 2, part: 0 })
    expect(moveTranscriptCursor({ block: 0, part: 0 }, 'section', 'next', blocks)).toEqual({ block: 1, part: 0 })
    expect(moveTranscriptCursor({ block: 1, part: 1 }, 'section', 'first', blocks)).toEqual({ block: 0, part: 0 })
    expect(moveTranscriptCursor({ block: 0, part: 0 }, 'section', 'last', blocks)).toEqual({ block: 2, part: 1 })
    expect(moveTranscriptCursor({ block: 1, part: 0 }, 'part', 'next', blocks)).toEqual({ block: 1, part: 1 })
    expect(moveTranscriptCursor({ block: 1, part: 1 }, 'part', 'previous', blocks)).toEqual({ block: 1, part: 0 })
    expect(moveTranscriptCursor({ block: 1, part: 1 }, 'part', 'first', blocks)).toEqual({ block: 1, part: 0 })
    expect(moveTranscriptCursor({ block: 1, part: 0 }, 'part', 'last', blocks)).toEqual({ block: 1, part: 1 })
    expect(moveTranscriptCursor({ block: 2, part: 1 }, 'block', 'previous', blocks)).toEqual({ block: 1, part: 0 })
    expect(moveTranscriptCursor({ block: 0, part: 0 }, 'block', 'next', blocks)).toEqual({ block: 1, part: 0 })
    expect(moveTranscriptCursor({ block: 5, part: 0 }, 'turn', 'previous', grouped)).toEqual({ block: 1, part: 0 })
    expect(moveTranscriptCursor({ block: 0, part: 0 }, 'turn', 'next', grouped)).toEqual({ block: 1, part: 0 })
  })

  it('reaches the ends of a block with more parts than one step', () => {
    // A snapshot carries a contribution per named section, so the ends of the
    // held block are further away than one step.
    const snapshot = [contextBlock('snapshot · workspace', [
      { kind: 'snapshot', label: 'sandbox', rows: ['allow python'] },
      { kind: 'snapshot', label: 'git', rows: ['clean'] },
      { kind: 'snapshot', label: 'todos', rows: ['none'] },
    ])]
    expect(moveTranscriptCursor({ block: 0, part: 0 }, 'part', 'last', snapshot)).toEqual({ block: 0, part: 2 })
    expect(moveTranscriptCursor({ block: 0, part: 0 }, 'part', 'next', snapshot)).toEqual({ block: 0, part: 1 })
    expect(moveTranscriptCursor({ block: 0, part: 2 }, 'part', 'first', snapshot)).toEqual({ block: 0, part: 0 })
    expect(moveTranscriptCursor({ block: 0, part: 2 }, 'part', 'previous', snapshot)).toEqual({ block: 0, part: 1 })
  })

  it('holds the cursor when the transcript has no section to reach', () => {
    expect(moveTranscriptCursor({ block: 0, part: 0 }, 'section', 'first', [])).toEqual({ block: 0, part: 0 })
    expect(moveTranscriptCursor({ block: 0, part: 0 }, 'section', 'last', [])).toEqual({ block: 0, part: 0 })
  })
})

describe('setHighlight', () => {
  it('carries the focused section, and clears the mark with undefined', () => {
    reply.setHighlight(1)
    card.setHighlight(undefined)
    expect(marks).toEqual([1, undefined])
  })
})
