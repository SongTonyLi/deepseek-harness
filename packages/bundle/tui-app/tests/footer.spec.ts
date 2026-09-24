/** The status bar's segments, their details, the workspace label, and the footer lines. */

import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  FIRST_FOOTER_SEGMENT,
  FooterBar,
  buildFooterSegments,
  footerSelectionIndex,
  renderFooter,
  workspaceLabel,
  type FooterInputs,
  type FooterSegment,
  type FooterTurn,
} from '../src/footer.ts'
import type { MotionLevel } from '../src/motion.ts'
import type { StatusFacts } from '../src/status.ts'
import { createPalette } from '../src/style.ts'

const model: ModelSelection = { provider: 'deepseek', model: 'deepseek-chat' }

/** A width that holds every segment this file builds, so windowing stays out of the way. */
const WIDE = 160

/** The bare bar: one model, one workspace, nothing else known. */
function inputs(extra: Partial<FooterInputs> = {}): FooterInputs {
  return { selection: model, usage: '', facts: {}, cwd: '/work', attachments: [], ...extra }
}

/** The ids of the segments `inputs` produces, in bar order. */
function ids(extra: Partial<FooterInputs> = {}): string[] {
  return buildFooterSegments(inputs(extra)).map(segment => segment.id)
}

/** The one segment carrying `id`. */
function segment(built: readonly FooterSegment[], id: string): FooterSegment {
  const found = built.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`no ${id} segment: ${built.map(one => one.id).join(', ')}`)
  return found
}

/** The rows one segment hands the app to print. */
function rows(built: readonly FooterSegment[], id: string): readonly string[] {
  const { detail } = segment(built, id)
  if (detail.kind !== 'rows') throw new Error(`the ${id} segment is opened by the app, not printed`)
  return detail.rows
}

/** The running turn every `turn` case starts from. */
const turn: FooterTurn = {
  number: 3,
  startedAt: Date.UTC(2026, 1, 3, 14, 25, 30),
  elapsed: '1m12s',
  queuedNextTurn: 2,
  queuedNextStep: 0,
}

const facts: StatusFacts = {
  context: { used: 54_000, window: 128_000, percent: 42 },
  breakdown: { systemTokens: 1200, toolsTokens: 3400, messageTokens: 30_000 },
  tokenUsage: { uncachedInputTokens: 1000, outputTokens: 400, cacheReadTokens: 3000, cacheWriteTokens: 0 },
  todos: { items: [{ content: 'write tests', status: 'completed' }], done: 1, active: 0, pending: 0 },
  goal: { phase: 'active', objective: 'ship it', round: 1, maxRounds: 8 },
  plan: { active: true, pending: false },
  permissions: { currentValue: 'workspace-write' },
}

/** Every optional fact the bar can carry at once. */
function crowded(extra: Partial<FooterInputs> = {}): FooterInputs {
  return inputs({
    selection: { ...model, reasoningEffort: ReasoningEffortId('high') },
    permission: 'workspace-write',
    turn,
    usage: '↑1.2k ↓300 ctx 900',
    facts,
    attachments: [{ name: 'notes.txt', kind: 'file' }],
    ...extra,
  })
}

describe('buildFooterSegments', () => {
  it('always carries the model, the effort, and the workspace, and nothing whose fact is missing', () => {
    expect(ids()).toEqual(['model', 'effort', 'workspace'])
    expect(buildFooterSegments(inputs())[0]?.id).toBe(FIRST_FOOTER_SEGMENT)
  })

  it('orders every present fact from the model to the attachments', () => {
    expect(ids(crowded())).toEqual(['model', 'effort', 'permission', 'turn', 'usage', 'context', 'todo', 'goal', 'plan', 'workspace', 'attachments'])
  })

  it('carries the turn only while one is running, labelled with its elapsed time', () => {
    expect(ids()).not.toContain('turn')
    const built = buildFooterSegments(inputs({ turn }))
    expect(segment(built, 'turn').label).toBe('turn 1m12s')
    expect(rows(built, 'turn')).toEqual([
      'turn 3',
      'started: 2026-02-03 14:25',
      'elapsed: 1m12s',
      'queued: 2 for the next turn · 0 for the next step',
    ])
  })

  it('labels each segment the way the bar reads it', () => {
    const built = buildFooterSegments(inputs({
      selection: { ...model, reasoningEffort: ReasoningEffortId('high') },
      permission: 'read-only',
      usage: '↑1.2k ↓300 ctx 900',
      facts,
      attachments: [{ name: 'notes.txt', kind: 'file' }, { name: 'shot.png', kind: 'image' }],
    }))
    expect(built.map(one => one.label)).toEqual([
      'deepseek/deepseek-chat',
      'effort high',
      'permission read-only',
      '↑1.2k ↓300 ctx 900',
      'ctx 42%',
      'todo 1/1',
      'goal active',
      'plan',
      '/work',
      '2 attached',
    ])
  })

  it('always carries an effort segment, labelled default when the selection has none', () => {
    expect(segment(buildFooterSegments(inputs()), 'effort').label).toBe('effort default')
    expect(segment(buildFooterSegments(inputs({ selection: { ...model, reasoningEffort: ReasoningEffortId('low') } })), 'effort').label)
      .toBe('effort low')
  })

  it('drops the permission segment when no permission service is composed', () => {
    expect(ids({ facts })).not.toContain('permission')
    expect(ids({ facts, permission: 'auto' })).toContain('permission')
  })

  it('drops the usage segment until the terminal has billed tokens to report', () => {
    expect(ids({ usage: '' })).not.toContain('usage')
    expect(ids({ usage: '↑10 ↓4 ctx 10' })).toContain('usage')
  })

  it('names the model, its effort, and the command that changes them', () => {
    const unset = buildFooterSegments(inputs())
    expect(rows(unset, 'model')).toEqual([
      'provider: deepseek',
      'model: deepseek-chat',
      'reasoning effort: the model\'s own default',
      '/model picks the provider and model for the next request',
    ])
    expect(rows(unset, 'effort')).toEqual([
      'reasoning effort: the model\'s own default',
      'Shift+Tab or /effort opens the effort list',
    ])
    const selected = buildFooterSegments(inputs({ selection: { ...model, reasoningEffort: ReasoningEffortId('high') } }))
    expect(rows(selected, 'model')).toContain('reasoning effort: high')
    expect(rows(selected, 'effort')).toEqual([
      'reasoning effort: high',
      'Shift+Tab or /effort opens the effort list',
    ])
  })

  it('reports the permission projection when it is registered and the service value when it is not', () => {
    expect(rows(buildFooterSegments(inputs({ permission: 'workspace-write', facts })), 'permission')).toEqual([
      'permission: workspace-write',
      '/permission opens the permission list',
    ])
    expect(rows(buildFooterSegments(inputs({ permission: 'auto' })), 'permission')).toEqual([
      'permission: auto',
      '/permission opens the permission list',
    ])
  })

  it('details the projection facts with the same sections /status prints', () => {
    const built = buildFooterSegments(inputs({ facts, usage: '↑1.2k ↓300 ctx 900' }))
    expect(rows(built, 'context')).toEqual([
      'context: ~54k / 128k (42%)',
      '  system ~1.2k · tools ~3.4k · messages ~30k',
      '/status prints all of these sections',
    ])
    expect(rows(built, 'usage')).toEqual([
      'this terminal: ↑1.2k ↓300 ctx 900',
      'tokens: ↑1k uncached · cache read 3k · cache write 0 · ↓400 · cache hit 75%',
      '/status prints all of these sections',
    ])
    expect(rows(built, 'goal')).toEqual([
      'goal: active · round 1/8 · ship it',
      '/status prints all of these sections',
    ])
    expect(rows(built, 'plan')).toEqual(['plan: on', '/status prints all of these sections'])
  })

  it('hands the todo fact to the app and summarises the counts plus the item being worked on', () => {
    const built = buildFooterSegments(inputs({
      facts: {
        todos: {
          items: [
            { content: 'read the spec', status: 'completed' },
            { content: 'write the data layer', status: 'in_progress' },
            { content: 'wire the picker', status: 'pending' },
          ],
          done: 1,
          active: 1,
          pending: 1,
        },
      },
    }))
    expect(segment(built, 'todo').detail).toEqual({
      kind: 'page',
      summary: 'todos: 1 done · 1 active · 1 pending · write the data layer',
    })
    expect(() => rows(built, 'todo')).toThrow('opened by the app')
  })

  it('keeps the unshortened workspace path and one row per attachment in the details', () => {
    const built = buildFooterSegments(inputs({
      cwd: '/home/dev/projects/deepseek-harness',
      home: '/home/dev',
      attachments: [{ name: 'notes.txt', kind: 'file' }, { name: 'shot.png', kind: 'image' }],
    }))
    expect(segment(built, 'workspace').label).toBe('…/projects/deepseek-harness')
    expect(rows(built, 'workspace')).toEqual(['workspace: /home/dev/projects/deepseek-harness'])
    expect(rows(built, 'attachments')).toEqual([
      'file: notes.txt',
      'image: shot.png',
      '/attach <path> adds one · /attach clear drops them all',
    ])
  })
})

describe('workspaceLabel', () => {
  it('keeps a short path and folds the home directory into a tilde', () => {
    expect(workspaceLabel('/work', '/home/dev')).toBe('/work')
    expect(workspaceLabel('/home/dev/site', '/home/dev')).toBe('~/site')
    expect(workspaceLabel('/home/dev', '/home/dev')).toBe('~')
  })

  it('leaves a path alone when no home directory is known or the home is only a name prefix', () => {
    expect(workspaceLabel('/home/dev/site', undefined)).toBe('/home/dev/site')
    expect(workspaceLabel('/home/developer/site', '/home/dev')).toBe('/home/developer/site')
    expect(workspaceLabel('/work', '')).toBe('/work')
  })

  it('keeps the last two segments of a path too wide for the bar', () => {
    expect(workspaceLabel('/srv/builds/nightly/checkout/deepseek-harness', undefined)).toBe('…/checkout/deepseek-harness')
    expect(workspaceLabel('/home/dev/work/side-projects/harness', '/home/dev')).toBe('…/side-projects/harness')
    expect(workspaceLabel('C:\\Users\\dev\\projects\\deepseek-harness', undefined)).toBe('…\\projects\\deepseek-harness')
  })

  it('keeps a single wide segment whole, having nothing to drop', () => {
    expect(workspaceLabel('/a-single-very-long-directory-name', undefined)).toBe('/a-single-very-long-directory-name')
  })
})

describe('footerSelectionIndex', () => {
  it('finds the held segment and falls back to the first one once its fact is gone', () => {
    const built = buildFooterSegments(inputs({ attachments: [{ name: 'notes.txt', kind: 'file' }] }))
    expect(footerSelectionIndex(built, 'attachments')).toBe(3)
    expect(footerSelectionIndex(buildFooterSegments(inputs()), 'attachments')).toBe(0)
  })
})

describe('renderFooter', () => {
  const palette = createPalette(false)
  const usage = buildFooterSegments(inputs({ usage: '↑10 ↓4 ctx 10' }))

  it('builds the unfocused line from both ends: the model left, the entry keys right, the facts between', () => {
    const lines = renderFooter(usage, { palette, width: WIDE })
    expect(lines).toHaveLength(1)
    const [line = ''] = lines
    expect(line.startsWith('deepseek-chat · effort default · /work · +1')).toBe(true)
    expect(line.endsWith('Shift+↑ read · Shift+↓ status')).toBe(true)
    expect(visibleWidth(line)).toBe(WIDE)
    const styled = renderFooter(usage, { palette: createPalette(true), width: WIDE })
    expect(styled).toHaveLength(1)
    expect(styled[0]).toContain('\u001b[2m')
    expect(styled[0]).not.toContain('\n')
  })

  it('distinguishes the model, live turn, context, and entry keys by color', () => {
    const [line = ''] = renderFooter(buildFooterSegments(crowded()), { palette: createPalette(true), width: WIDE })
    expect(line).toContain('\u001b[36mdeepseek-chat\u001b[39m')
    expect(line).toContain('\u001b[33mturn 1m12s\u001b[39m')
    expect(line).toContain('\u001b[38;5;141mctx 42%\u001b[39m')
    expect(line).toContain('\u001b[38;5;141mShift+↑ read · Shift+↓ status\u001b[39m')
    expect(visibleWidth(line)).toBe(WIDE)
  })

  it('reserves both entry keys while the width can spare them, then degrades, then drops them', () => {
    const built = buildFooterSegments(crowded())
    const at = (width: number): string => renderFooter(built, { palette, width })[0] ?? ''
    expect(at(95)).toContain('Shift+↑ read · Shift+↓ status')
    expect(renderFooter(built, { palette, width: 95, queue: true })[0]).toContain('Shift+↑ select · Shift+↓ status')
    expect(renderFooter(built, { palette, width: 95, queue: true })[0]).not.toContain('Shift+↑ read · Shift+↓ status')
    expect(at(60)).toContain('Shift+↑↓ nav')
    expect(at(60)).not.toContain('Shift+↑ read')
    expect(at(36)).not.toContain('Shift+')
    // The keys are reserved before any fact, so the facts fold instead.
    expect(at(60)).toContain('deepseek-chat')
    expect(at(60)).toMatch(/\+\d/u)
    for (const width of [95, 60, 36]) expect(visibleWidth(at(width))).toBeLessThanOrEqual(width)
  })

  it('drops the provider from a wide model label before it ellipsizes the model itself', () => {
    const wide = buildFooterSegments(inputs({ selection: { provider: 'openai-codex-preview', model: 'gpt-5.6-sol' } }))
    expect(renderFooter(wide, { palette, width: WIDE })[0]?.startsWith('gpt-5.6-sol · ')).toBe(true)
    const huge = buildFooterSegments(inputs({ selection: { provider: 'openai', model: 'gpt'.padEnd(30, '-') } }))
    const [line = ''] = renderFooter(huge, { palette, width: WIDE })
    const label = (line.split(' · ')[0] ?? '').replaceAll('\u001b[0m', '')
    expect(label.startsWith('gpt---')).toBe(true)
    expect(label.endsWith('…')).toBe(true)
    expect(visibleWidth(label)).toBe(20)
  })

  it('keeps model, effort, a running turn, context, todo, and workspace on the unfocused line', () => {
    const [line] = renderFooter(buildFooterSegments(crowded()), { palette, width: WIDE })
    expect(line).toContain('deepseek-chat')
    expect(line).toContain('effort high')
    expect(line).toContain('turn 1m12s')
    expect(line).toContain('ctx 42%')
    expect(line).toContain('todo 1/1')
    expect(line).toContain('/work')
    expect(line).toContain('Shift+↓')
    expect(line).toMatch(/\+\d/u)
    expect(line).not.toContain('permission')
    expect(line).not.toContain('goal active')
    expect(line).not.toContain('2 attached')
    expect(line).not.toContain('↑1.2k')
    expect(line).not.toContain('Enter sends')
    expect(line).not.toContain('Shift+↑ transcript')
    expect(line).not.toContain('←→ segments')
  })

  it('omits the overflow token when nothing is folded', () => {
    const [line = ''] = renderFooter(buildFooterSegments(inputs()), { palette, width: WIDE })
    expect(line.startsWith('deepseek-chat · effort default · /work')).toBe(true)
    expect(line).not.toMatch(/\+\d/u)
  })

  it('brackets and accents the selected segment, and expands it on the second line', () => {
    const lines = renderFooter(usage, { palette, selected: 1, width: WIDE })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('deepseek-chat · [effort default] · ↑10 ↓4 ctx 10 · /work')
    expect(lines[1]).toBe('reasoning effort: the model\'s own default · ←→ segments · Enter details · Tab regions · Esc input')
    const styled = renderFooter(usage, { palette: createPalette(true), selected: 1, width: WIDE })
    const [bar, expansion] = styled
    expect(bar).toContain('\u001b[36m[effort default]\u001b[39m')
    expect(bar).toContain('\u001b[2mdeepseek-chat\u001b[22m')
    expect(bar).toContain('\u001b[2m/work\u001b[22m')
    expect(expansion).toContain('reasoning effort: the model\'s own default')
    expect(expansion).toContain('←→ segments')
  })

  it('lifts the selected label while a walk is still moving and settles back onto the accent', () => {
    const styled = createPalette(true)
    const at = (level: MotionLevel): string => renderFooter(usage, { palette: styled, selected: 1, level, width: WIDE })[0] ?? ''
    // The peak is the one moment the bar draws bold; the settled label is the
    // plain accent, whatever the terminal's motion setting.
    expect(at(2)).toContain('\u001b[1m\u001b[36m\u001b[36m[effort default]')
    expect(at(1)).toContain('\u001b[36m\u001b[36m[effort default]')
    expect(at(0)).toBe(renderFooter(usage, { palette: styled, selected: 1, width: WIDE })[0])
    expect(at(0)).not.toContain('\u001b[1m')
    // A lift never changes how much of the bar is drawn.
    for (const level of [0, 1, 2] as MotionLevel[]) {
      expect(visibleWidth(at(level))).toBe(visibleWidth(at(0)))
      expect(renderFooter(usage, { palette: styled, selected: 1, level, width: WIDE })).toHaveLength(2)
    }
  })

  it('keeps the model anchored while the walk slides the window past it', () => {
    const built = buildFooterSegments(crowded())
    for (let selected = 1; selected <= 4; selected += 1) {
      const [line = ''] = renderFooter(built, { palette, selected, width: 40 })
      expect(line).toContain('deepseek-chat')
      expect(visibleWidth(line)).toBeLessThanOrEqual(40)
    }
    // A window cut on either side says so where it was cut.
    expect(renderFooter(built, { palette, selected: 4, width: 40 })[0]).toContain('‹')
    expect(renderFooter(built, { palette, selected: 1, width: 40 })[0]).toContain('›')
  })

  it('keeps the selected segment in a sliding window that fits the terminal', () => {
    const built = buildFooterSegments(crowded())
    const last = built.length - 1
    const lines = renderFooter(built, { palette, selected: last, width: 36 })
    expect(lines[0]).toContain('1 attached')
    expect(lines[0]).toContain('deepseek-chat')
    expect(lines[0]).not.toContain('effort high')
    expect(visibleWidth(lines[0] ?? '')).toBeLessThanOrEqual(36)
    expect(visibleWidth(lines[1] ?? '')).toBeLessThanOrEqual(36)
    const first = renderFooter(built, { palette, selected: 0, width: 36 })
    expect(first[0]).toContain('[deepseek-chat]')
    expect(first[0]).not.toContain('1 attached')
    expect(visibleWidth(first[0] ?? '')).toBeLessThanOrEqual(36)
  })

  // The brackets are what names the selected segment without color, so the
  // label's own text is what a window too narrow for it gives up.
  it('cuts the selected label inside its brackets rather than past them', () => {
    const built = buildFooterSegments(crowded())
    const effort = footerSelectionIndex(built, 'effort')
    const at = (width: number): string => stripTerminalSequences(renderFooter(built, { palette, selected: effort, width })[0] ?? '')
    for (const width of [40, 30, 26, 22]) {
      expect(at(width)).toContain('deepseek-chat')
      expect(at(width)).toMatch(/\[[^[\]]+\]/u)
      expect(visibleWidth(at(width))).toBeLessThanOrEqual(width)
    }
    expect(at(40)).toContain('[effort high]')
    expect(at(26)).toContain('[effor…]')
    expect(at(22)).toContain('[e…]')
  })

  it('never draws a line wider than the terminal, even when one label exceeds it', () => {
    const built = buildFooterSegments(inputs({ cwd: '/a-single-very-long-directory-name' }))
    const workspace = footerSelectionIndex(built, 'workspace')
    for (const width of [8, 12, 24, 40]) {
      for (const selected of [undefined, 0, workspace]) {
        for (const line of renderFooter(built, { palette, width, ...selected === undefined ? {} : { selected } })) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width)
        }
      }
    }
  })

  it('ellipsizes an anchor that carries no shorter form of its own', () => {
    const long: FooterSegment = { id: 'workspace', label: '/srv/builds/nightly/checkout', detail: { kind: 'rows', rows: ['x'] } }
    const [line = ''] = renderFooter([long], { palette, width: WIDE })
    const label = line.replaceAll('\u001b[0m', '').split('  ')[0] ?? ''
    expect(label.endsWith('…')).toBe(true)
    expect(visibleWidth(label)).toBe(20)
  })

  it('names the entry keys even on a bar that carries no segment at all', () => {
    const [line = ''] = renderFooter([], { palette, width: 60 })
    expect(line.trimStart()).toBe('Shift+↑↓ nav')
    expect(visibleWidth(line)).toBe(60)
  })

  it('fits an empty segment list and keeps every line inside the width', () => {
    const lines = renderFooter([], { palette: createPalette(false), selected: 0, width: 40 })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('')
    expect(lines[1]).toContain('←→ segments')
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
  })

  it('expands the todo segment with the counts and the item being worked on, not the chip', () => {
    const built = buildFooterSegments(inputs({
      facts: {
        todos: {
          items: [
            { content: 'read the spec', status: 'completed' },
            { content: 'write the data layer', status: 'in_progress' },
            { content: 'wire the picker', status: 'pending' },
          ],
          done: 1,
          active: 1,
          pending: 1,
        },
      },
    }))
    const todo = footerSelectionIndex(built, 'todo')
    const [, expansion] = renderFooter(built, { palette, selected: todo, width: WIDE })
    expect(expansion).toContain('todos: 1 done · 1 active · 1 pending · write the data layer')
    expect(expansion).not.toContain('todo 1/3 · ←→ segments')
    expect(expansion).toContain('←→ segments')
  })
})

describe('FooterBar', () => {
  it('reads the segments once per render so a later width reaches the window', () => {
    const built = buildFooterSegments(crowded())
    let selected = 0
    const bar = new FooterBar(() => ({ segments: built, render: { palette: createPalette(false), selected } }))
    bar.invalidate()
    const wide = bar.render(WIDE)
    expect(wide[0]).toContain('1 attached')
    selected = built.length - 1
    const narrow = bar.render(36)
    expect(narrow[0]).toContain('1 attached')
    expect(narrow[0]).not.toContain('goal active')
    expect(visibleWidth(narrow[0] ?? '')).toBeLessThanOrEqual(36)
  })
})
