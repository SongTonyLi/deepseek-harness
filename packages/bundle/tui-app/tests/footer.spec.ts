/** The status bar's segments, their details, the workspace label, and the two footer lines. */

import { describe, expect, it } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  FIRST_FOOTER_SEGMENT,
  buildFooterSegments,
  footerSelectionIndex,
  renderFooter,
  workspaceLabel,
  type FooterInputs,
  type FooterSegment,
  type FooterTurn,
} from '../src/footer.ts'
import type { StatusFacts } from '../src/status.ts'
import { createPalette } from '../src/style.ts'

const model: ModelSelection = { provider: 'deepseek', model: 'deepseek-chat' }

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

describe('buildFooterSegments', () => {
  it('always carries the model and the workspace, and nothing whose fact is missing', () => {
    expect(ids()).toEqual(['model', 'workspace'])
    expect(buildFooterSegments(inputs())[0]?.id).toBe(FIRST_FOOTER_SEGMENT)
  })

  it('orders every present fact from the model to the attachments', () => {
    expect(ids({
      selection: { ...model, reasoningEffort: ReasoningEffortId('high') },
      permission: 'workspace-write',
      turn,
      usage: '↑1.2k ↓300 ctx 900',
      facts,
      attachments: [{ name: 'notes.txt', kind: 'file' }],
    })).toEqual(['model', 'effort', 'permission', 'turn', 'usage', 'context', 'todo', 'goal', 'plan', 'workspace', 'attachments'])
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

  it('drops the effort segment when the selection carries no reasoning effort', () => {
    expect(ids()).not.toContain('effort')
    expect(ids({ selection: { ...model, reasoningEffort: ReasoningEffortId('low') } })).toContain('effort')
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
    expect(rows(buildFooterSegments(inputs()), 'model')).toEqual([
      'provider: deepseek',
      'model: deepseek-chat',
      'reasoning effort: the model\'s own default',
      '/model picks the provider and model for the next request',
    ])
    const selected = buildFooterSegments(inputs({ selection: { ...model, reasoningEffort: ReasoningEffortId('high') } }))
    expect(rows(selected, 'model')).toContain('reasoning effort: high')
    expect(rows(selected, 'effort')).toEqual([
      'reasoning effort: high',
      'Shift+Tab cycles it · /effort picks one',
    ])
  })

  it('reports the permission projection when it is registered and the service value when it is not', () => {
    expect(rows(buildFooterSegments(inputs({ permission: 'workspace-write', facts })), 'permission')).toEqual([
      'permission: workspace-write',
      '/permission <preset> changes the sandbox mode and the approval policy',
    ])
    expect(rows(buildFooterSegments(inputs({ permission: 'auto' })), 'permission')).toEqual([
      'permission: auto',
      '/permission <preset> changes the sandbox mode and the approval policy',
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
      'tokens: ↑1.0k uncached · cache read 3.0k · cache write 0 · ↓400 · cache hit 75%',
      '/status prints all of these sections',
    ])
    expect(rows(built, 'goal')).toEqual([
      'goal: active · round 1/8 · ship it',
      '/status prints all of these sections',
    ])
    expect(rows(built, 'plan')).toEqual(['plan: on', '/status prints all of these sections'])
  })

  it('hands the todo fact to the app instead of building rows for it', () => {
    const built = buildFooterSegments(inputs({ facts }))
    expect(segment(built, 'todo').detail).toEqual({ kind: 'page' })
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
    expect(footerSelectionIndex(built, 'attachments')).toBe(2)
    expect(footerSelectionIndex(buildFooterSegments(inputs()), 'attachments')).toBe(0)
  })
})

describe('renderFooter', () => {
  const built = buildFooterSegments(inputs({ usage: '↑10 ↓4 ctx 10' }))

  it('joins every segment into one dim line and advertises the entry keys under it', () => {
    const plain = renderFooter(built, { palette: createPalette(false), hints: 'Enter sends' })
    expect(plain).toBe('deepseek/deepseek-chat · ↑10 ↓4 ctx 10 · /work\nEnter sends · Shift+↑ transcript · Shift+↓ status bar')
    const styled = renderFooter(built, { palette: createPalette(true), hints: 'Enter sends' })
    expect(styled.split('\n')[0]).toBe('\u001b[2mdeepseek/deepseek-chat · ↑10 ↓4 ctx 10 · /work\u001b[22m')
  })

  it('accents only the selected segment and replaces the hints with the navigation keys', () => {
    const plain = renderFooter(built, { palette: createPalette(false), selected: 1, hints: 'Enter sends' })
    expect(plain).toBe('deepseek/deepseek-chat · ↑10 ↓4 ctx 10 · /work\n← → select · ↑ ↓ regions · Enter details · Esc back')
    const styled = renderFooter(built, { palette: createPalette(true), selected: 1, hints: 'Enter sends' })
    const [bar] = styled.split('\n')
    expect(bar).toContain('\u001b[1m\u001b[36m↑10 ↓4 ctx 10\u001b[39m\u001b[22m')
    expect(bar).toContain('\u001b[2mdeepseek/deepseek-chat\u001b[22m')
    expect(bar).toContain('\u001b[2m/work\u001b[22m')
  })
})
