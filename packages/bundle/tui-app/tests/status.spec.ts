/** Status facts read from the projection snapshot and their footer, report, and notice text. */

import { describe, expect, it } from 'vitest'
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { GoalId, GoalProjection } from '@deepseek-ai/dsh-goal/types'
import type { LlmRetryEventData, RetryId } from '@deepseek-ai/dsh-llm-retry/types'
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/types'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import {
  cacheHitPercent,
  compactionNotice,
  footerStatus,
  formatDuration,
  readStatusFacts,
  retryMessage,
  statusReport,
  todoSummary,
  type StatusFacts,
  type StatusProjections,
} from '../src/status.ts'

const session = {} as unknown as Session

/** A registry whose one snapshot serves exactly `values`, recording the keys it was asked for. */
function registryOf(values: ProjectionSnapshot['values']): StatusProjections & { keys: readonly string[] | undefined } {
  const registry = {
    keys: undefined as readonly string[] | undefined,
    snapshot(_session: Session, keys?: readonly string[]): ProjectionSnapshot {
      registry.keys = keys
      return { asOfSeq: -1, values }
    },
  }
  return registry
}

const usage: TokenUsageProjection = { uncachedInputTokens: 1000, outputTokens: 400, cacheReadTokens: 3000, cacheWriteTokens: 0 }

const stats: SessionStatsProjection = {
  turns: 2,
  steps: 5,
  llmMs: 45_250,
  toolMs: 3_100,
  ttftMs: 1_600,
  ttftSteps: 2,
  decodeMs: 10_000,
  decodeTokens: 420,
}

const goal: GoalProjection = {
  goal: { id: 'g1' as GoalId, revision: 2, objective: 'ship it', phase: 'active', maxGoalRounds: 8 },
  roundsStarted: 3,
  createdAt: 1,
  updatedAt: 2,
}

describe('readStatusFacts', () => {
  it('selects every status key in one snapshot and yields nothing for an unregistered cut', () => {
    const registry = registryOf({})
    expect(readStatusFacts(registry, session)).toEqual({})
    expect(registry.keys).toEqual([
      'contextPressure',
      'contextBreakdown',
      'tokenUsage',
      'sessionStats',
      'todos',
      'goal',
      'plan',
      'permissions',
    ])
  })

  it('derives context occupancy from the projected prompt size and the route capacity', () => {
    expect(readStatusFacts(registryOf({
      contextPressure: { pressureTokens: 40_000, projectedTokens: 54_000, contextWindow: 128_000 },
    }), session).context).toEqual({ used: 54_000, window: 128_000, percent: 42 })
    expect(readStatusFacts(registryOf({
      contextPressure: { pressureTokens: 200_000, contextWindow: 128_000 },
    }), session).context).toEqual({ used: 200_000, window: 128_000, percent: 100 })
  })

  it('leaves context absent until both a usage sample and a capacity exist', () => {
    expect(readStatusFacts(registryOf({ contextPressure: { contextWindow: 128_000 } }), session).context).toBeUndefined()
    expect(readStatusFacts(registryOf({ contextPressure: { pressureTokens: 10 } }), session).context).toBeUndefined()
  })

  it('passes breakdown, usage, stats, plan, and permissions through whole', () => {
    const breakdown = { systemTokens: 1200, toolsTokens: 3400, messageTokens: 30_000 }
    const plan = { active: true, pending: false }
    const permissions = { options: [{ value: 'read-only', name: 'Read only' }], currentValue: 'read-only' }
    expect(readStatusFacts(registryOf({ contextBreakdown: breakdown, tokenUsage: usage, sessionStats: stats, plan, permissions }), session))
      .toEqual({ breakdown, tokenUsage: usage, stats, plan, permissions })
  })

  it('counts todos by status and skips the list before its first write', () => {
    expect(readStatusFacts(registryOf({ todos: null }), session).todos).toBeUndefined()
    const items = [
      { content: 'a', status: 'completed' as const },
      { content: 'b', status: 'in_progress' as const },
      { content: 'c', status: 'pending' as const },
      { content: 'd', status: 'pending' as const },
    ]
    expect(readStatusFacts(registryOf({ todos: items }), session).todos).toEqual({ items, done: 1, active: 1, pending: 2 })
  })

  it('flattens the goal and carries a blocked reason only while blocked', () => {
    expect(readStatusFacts(registryOf({ goal: null }), session).goal).toBeUndefined()
    expect(readStatusFacts(registryOf({ goal }), session).goal)
      .toEqual({ phase: 'active', objective: 'ship it', round: 3, maxRounds: 8 })
    const blocked: GoalProjection = {
      ...goal,
      goal: { ...goal.goal, phase: 'blocked', blockedReason: { code: 'needs-input', message: 'waiting for the user' } },
    }
    expect(readStatusFacts(registryOf({ goal: blocked }), session).goal)
      .toEqual({ phase: 'blocked', objective: 'ship it', round: 3, maxRounds: 8, blockedReason: 'waiting for the user' })
  })
})

describe('footerStatus', () => {
  it('tags one short part per present fact with the status-bar segment it becomes', () => {
    const facts: StatusFacts = {
      context: { used: 54_000, window: 128_000, percent: 42 },
      todos: { items: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }], done: 1, active: 0, pending: 1 },
      goal: { phase: 'active', objective: 'ship it', round: 1, maxRounds: 8 },
      plan: { active: true, pending: false },
    }
    expect(footerStatus(facts)).toEqual([
      { id: 'context', label: 'ctx 42%' },
      { id: 'todo', label: 'todo 1/2' },
      { id: 'goal', label: 'goal active' },
      { id: 'plan', label: 'plan' },
    ])
    expect(footerStatus({})).toEqual([])
  })

  it('marks a pending plan switch and hides plan mode while off', () => {
    expect(footerStatus({ plan: { active: false, pending: true } })).toEqual([{ id: 'plan', label: 'plan…' }])
    expect(footerStatus({ plan: { active: false, pending: false } })).toEqual([])
  })
})

describe('todoSummary', () => {
  it('names the in-progress item after the counts, and the next pending item when none is running', () => {
    expect(todoSummary({
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
    })).toBe('todos: 1 done · 1 active · 1 pending · write the data layer')
    expect(todoSummary({
      todos: {
        items: [{ content: 'write tests', status: 'completed' }, { content: 'ship', status: 'pending' }],
        done: 1,
        active: 0,
        pending: 1,
      },
    })).toBe('todos: 1 done · 0 active · 1 pending · ship')
  })

  it('keeps the counts alone when every item is done, and is empty before the first write', () => {
    expect(todoSummary({
      todos: { items: [{ content: 'write tests', status: 'completed' }], done: 1, active: 0, pending: 0 },
    })).toBe('todos: 1 done · 0 active · 0 pending')
    expect(todoSummary({})).toBe('')
  })
})

describe('statusReport', () => {
  it('reports every section', () => {
    const facts: StatusFacts = {
      context: { used: 54_000, window: 128_000, percent: 42 },
      breakdown: { systemTokens: 1200, toolsTokens: 3400, messageTokens: 30_000 },
      tokenUsage: usage,
      stats,
      todos: {
        items: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }],
        done: 1,
        active: 1,
        pending: 1,
      },
      goal: { phase: 'blocked', objective: 'ship it', round: 3, maxRounds: 8, blockedReason: 'waiting' },
      plan: { active: true, pending: true },
      permissions: { currentValue: 'read-only' },
    }
    expect(statusReport(facts)).toEqual([
      'context: ~54k / 128k (42%)',
      '  system ~1.2k · tools ~3.4k · messages ~30k',
      'tokens: ↑1.0k uncached · cache read 3.0k · cache write 0 · ↓400 · cache hit 75%',
      'session: 2 turns · 5 steps · model 45.3s · tools 3.1s · first token 0.8s avg · 42 tok/s',
      'todos: 1 done · 1 active · 1 pending',
      '  ✓ a',
      '  ▸ b',
      '  ○ c',
      'goal: blocked · round 3/8 · ship it',
      '  blocked: waiting',
      'plan: on (switching)',
      'permission: read-only',
    ])
  })

  it('omits figures that have no sample yet and names an unlisted permission value', () => {
    const facts: StatusFacts = {
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stats: { turns: 1, steps: 1, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 },
      goal: { phase: 'active', objective: 'ship it', round: 0, maxRounds: 8 },
      plan: { active: false, pending: false },
      permissions: { currentValue: 'custom' },
    }
    expect(statusReport(facts)).toEqual([
      'tokens: ↑0 uncached · cache read 0 · cache write 0 · ↓0',
      'session: 1 turn · 1 step · model 0s · tools 0s',
      'goal: active · round 0/8 · ship it',
      'plan: off',
      'permission: custom',
    ])
  })

  it('explains an empty status', () => {
    expect(statusReport({})).toEqual(['no session status yet'])
  })
})

describe('cacheHitPercent', () => {
  it('rounds ordinary shares and never rounds a partial hit up to 100', () => {
    expect(cacheHitPercent(usage)).toBe('75')
    expect(cacheHitPercent({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull()
    expect(cacheHitPercent({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 50, cacheWriteTokens: 0 })).toBe('100')
    expect(cacheHitPercent({ uncachedInputTokens: 1, outputTokens: 0, cacheReadTokens: 9999, cacheWriteTokens: 0 })).toBe('99.9')
  })
})

describe('formatDuration', () => {
  it('uses tenths of a second under a minute and minutes beyond', () => {
    expect(formatDuration(45_250)).toBe('45.3s')
    expect(formatDuration(162_400)).toBe('2m42s')
  })
})

describe('notices', () => {
  it('describes a compaction by its shadowed items and price', () => {
    expect(compactionNotice({ shadowedSeqs: [SessionSeq(3), SessionSeq(4)], shadowedTokenCount: 3400 }))
      .toBe('compacted 2 items (~3.4k tokens)')
    expect(compactionNotice({ shadowedSeqs: [SessionSeq(3)], shadowedTokenCount: 12 }))
      .toBe('compacted 1 item (~12 tokens)')
  })

  it('describes a retry with its attempt, wait, and failure', () => {
    const base = {
      retryId: 'r1' as RetryId,
      turn: 1,
      step: 1,
      provider: 'deepseek-official',
      policyKey: 'default',
      retry: 2,
      delayMs: 4000,
      failure: { message: 'provider busy', code: 'RATE_LIMIT', status: 429 },
    }
    const normal: LlmRetryEventData = { ...base, mode: 'normal', maxRetries: 5 }
    const always: LlmRetryEventData = { ...base, mode: 'always' }
    expect(retryMessage(normal)).toBe('retrying (2/5) in 4s · RATE_LIMIT: provider busy')
    expect(retryMessage(always)).toBe('retrying (2) in 4s · RATE_LIMIT: provider busy')
  })
})
