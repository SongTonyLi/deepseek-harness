import { describe, expect, it } from 'vitest'
import { groupByPhase } from '../src/index.ts'

interface Item {
  readonly label: string
  readonly phase?: string
}

/** An omitted phase is null; the key keeps null, empty, and titled phases distinct. */
const phaseOf = (item: Item): string | null => item.phase ?? null
const keyOf = (phase: string | null): string => phase === null ? 'missing' : `value:${phase.length}:${phase}`
const labelOf = (item: Item): string => item.label

describe('groupByPhase', () => {
  it('groups members by phase key in first-appearance order and keeps member order', () => {
    const items: Item[] = [
      { label: 'a', phase: 'scan' },
      { label: 'b' },
      { label: 'c', phase: '' },
      { label: 'd', phase: 'scan' },
    ]

    expect(groupByPhase(items, phaseOf, keyOf, labelOf)).toEqual([
      { key: 'value:4:scan', phase: 'scan', members: ['a', 'd'] },
      { key: 'missing', phase: null, members: ['b'] },
      { key: 'value:0:', phase: '', members: ['c'] },
    ])
  })

  it('reports the first member phase identity when distinct identities share a key', () => {
    const items: Item[] = [{ label: 'upper', phase: 'Scan' }, { label: 'lower', phase: 'scan' }]

    expect(groupByPhase(items, phaseOf, phase => (phase ?? 'missing').toLowerCase(), labelOf)).toEqual([
      { key: 'scan', phase: 'Scan', members: ['upper', 'lower'] },
    ])
  })

  it('returns no groups for no members', () => {
    expect(groupByPhase([], phaseOf, keyOf, labelOf)).toEqual([])
  })
})
