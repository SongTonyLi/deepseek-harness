/** The live subagent panel's rows, its overflow, and the two ways it is drawn. */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { createPalette } from '../src/style.ts'
import {
  SUBAGENT_PANEL_MAX_ROWS,
  renderSubagentPanel,
  subagentPanelView,
  type SubagentLiveFacts,
  type SubagentPanelInputs,
  type SubagentPanelView,
} from '../src/subagent-panel.ts'

/** A fixed instant the running elapsed values are measured against. */
const NOW = Date.UTC(2026, 1, 3, 14, 25, 0)

/** One resident one-shot child at the given depth. */
function child(id: string, extra: Partial<SubagentDescendantListEntry> = {}): SubagentDescendantListEntry {
  return {
    kind: 'child',
    id: id as SessionId,
    activity: 'running',
    mode: 'one-shot',
    hasChildren: false,
    parentId: 'session-root' as SessionId,
    depth: 1,
    ...extra,
  } as SubagentDescendantListEntry
}

/** A view over `entries`, with `facts` keyed by the ids that have any. */
function view(
  entries: readonly SubagentDescendantListEntry[],
  facts: Record<string, SubagentLiveFacts> = {},
): SubagentPanelView {
  const inputs: SubagentPanelInputs = {
    entries,
    facts: new Map(Object.entries(facts) as [SessionId, SubagentLiveFacts][]),
    now: NOW,
  }
  return subagentPanelView(inputs)
}

/** The row texts of a view. */
function texts(entries: readonly SubagentDescendantListEntry[], facts: Record<string, SubagentLiveFacts> = {}): string[] {
  return view(entries, facts).rows.map(row => row.text)
}

describe('subagentPanelView', () => {
  it('keeps the children whose session record is resident and drops the ones that settled out of it', () => {
    const entries = [child('session-live'), child('session-gone', { activity: 'inactive' })]
    expect(view(entries).rows.map(row => row.id)).toEqual(['session-live'])
    expect(view([child('session-gone', { activity: 'inactive' })]).rows).toEqual([])
  })

  it('reads a running child, a resident idle one, and one with no live facts at all', () => {
    const entries = [
      child('session-busy'),
      child('session-waiting', { depth: 2, mode: 'continuable', label: 'reviewer' }),
      child('session-elsewhere'),
    ]
    expect(texts(entries, {
      'session-busy': { running: true, settledMs: 4000, activeSince: NOW - 72_000, usage: { inputTokens: 1200, outputTokens: 300 } },
      'session-waiting': { running: false, settledMs: 8000 },
    })).toEqual([
      'session-busy · one-shot · resident · running · 1m12s · ↑1.2k ↓300',
      '  reviewer · continuable · resident · idle · 8s',
      'session-elsewhere · one-shot · resident · idle',
    ])
  })

  it('times the open turn from its start and falls back to the settled total between turns', () => {
    const running = view([child('session-kid')], { 'session-kid': { running: true, settledMs: 60_000, activeSince: NOW - 5000 } })
    expect(running.rows[0]?.text).toContain('5s')
    expect(running.ticking).toBe(true)
    const settled = view([child('session-kid')], { 'session-kid': { running: false, settledMs: 60_000 } })
    expect(settled.rows[0]?.text).toContain('1m00s')
    expect(settled.ticking).toBe(false)
  })

  it('explains a candidate the listing could not read and refuses to enter it', () => {
    const entries: SubagentDescendantListEntry[] = [{
      kind: 'diagnostic',
      id: 'session-broken' as SessionId,
      reason: 'corrupt',
      parentId: 'session-root' as SessionId,
      depth: 2,
    }]
    const built = view(entries)
    expect(built.rows[0]?.text).toBe('  session-broken · unreadable: corrupt')
    expect(built.rows[0]?.enterable).toBe(false)
    expect(built.rows[0]?.ticking).toBe(false)
  })

  it('draws the first rows and counts the children it left out', () => {
    const entries = Array.from({ length: SUBAGENT_PANEL_MAX_ROWS + 2 }, (_, index) => child(`session-${String(index)}`))
    const built = view(entries)
    expect(built.rows).toHaveLength(SUBAGENT_PANEL_MAX_ROWS)
    expect(built.hidden).toBe(2)
    expect(view(entries.slice(0, SUBAGENT_PANEL_MAX_ROWS)).hidden).toBe(0)
  })
})

describe('renderSubagentPanel', () => {
  const palette = createPalette(false)

  it('heads the panel with the count and stays quiet while the keyboard is elsewhere', () => {
    const built = view([child('session-kid'), child('session-other')])
    expect(renderSubagentPanel(built, { palette })).toBe([
      'subagents · 2 listed',
      'session-kid · one-shot · resident · idle',
      'session-other · one-shot · resident · idle',
    ].join('\n'))
  })

  it('names its keys and accents the selected row while it holds the keyboard', () => {
    const built = view([child('session-kid'), child('session-other')])
    const drawn = renderSubagentPanel(built, { palette: createPalette(true), selected: 1 })
    const [heading, first, second] = drawn.split('\n')
    expect(heading).toContain('↑ ↓ select · Enter details · Esc back')
    expect(first).toContain('\u001b[2msession-kid')
    expect(second).toContain('\u001b[1m\u001b[36msession-other')
  })

  it('counts the rows it did not draw and carries the last listing failure', () => {
    const entries = Array.from({ length: SUBAGENT_PANEL_MAX_ROWS + 1 }, (_, index) => child(`session-${String(index)}`))
    const drawn = renderSubagentPanel(view(entries), { palette, failure: 'the listing timed out' })
    expect(drawn).toContain(`subagents · ${String(SUBAGENT_PANEL_MAX_ROWS + 1)} listed`)
    expect(drawn).toContain('+1 more · /subagents lists them all')
    expect(drawn).toContain('listing failed: the listing timed out')
  })
})
