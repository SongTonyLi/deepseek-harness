/**
 * Logged facts that reach the model but used to reach the screen wrongly or not
 * at all: pruned tool results, multi-block messages, failure reasons, model
 * retries, and approval outcomes, each drawn live and again from a replayed log.
 */

import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, type ContentBlock, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionEventMap, SessionSeq } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { KEY, bench, type Bench } from './bench.ts'

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]
const callId = (value: string): ToolCallId => value as ToolCallId

/** Build a log on a bench, then draw the same log live and from a fresh bench's history. */
async function liveAndReplayed(
  options: Parameters<typeof bench>[0],
  build: (test: Bench) => void | Promise<void>,
  check: (screen: string, test: Bench) => void | Promise<void>,
): Promise<void> {
  const live = await bench(options)
  let history: readonly SessionEvent[]
  try {
    await build(live)
    await live.settle()
    await check(await live.screen(), live)
    history = live.session.ownEvents()
  } finally {
    live.app.stop()
    await live.ctx.fiber.dispose()
  }
  const replay = await bench({ ...options, history })
  try {
    await check(await replay.screen(), replay)
  } finally {
    replay.app.stop()
    await replay.ctx.fiber.dispose()
  }
}

function openStep(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
}

/** A finished `bash` card whose result the pruner may later replace. */
function bashCard(session: Session, id: string, output: string): { seq: SessionSeq; data: SessionEvent<'tool/result'>['data'] } {
  session.append('tool/call', { turn: 1, step: 1, callId: callId(id), name: 'bash', arguments: JSON.stringify({ command: `cat ${id}` }) })
  return session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: callId(id), content: text(output), isError: false }),
  }, { surfaceOp: 'append' })
}

/** The pair the tool-result pruner appends: its shadow price, then the replacement result. */
function prune(session: Session, original: { seq: SessionSeq; data: SessionEvent<'tool/result'>['data'] }, output: string, tokens = 900): void {
  session.append('compaction/prune', { shadowedRange: { start: original.seq, end: original.seq }, shadowedSeqs: [original.seq], shadowedTokenCount: tokens })
  session.append('tool/result', { ...original.data, message: { ...original.data.message, content: text(output) } }, {
    surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
    sourceEventSeqs: [original.seq],
  })
}

const PRUNED = 'HEAD\n\n[... tool result middle pruned ...]\n\nTAIL'
const occurrences = (screen: string, needle: string): number => screen.split(needle).length - 1

describe('pruned tool results', () => {
  it('keeps the card as the user saw it, notes the prune, and never rewrites history above the screen', async () => {
    const test = await bench({ toolPreviewLines: 8 })
    try {
      openStep(test.session)
      const first = bashCard(test.session, 'first', 'HEAD\nFIRST-MIDDLE\nTAIL')
      for (let n = 0; n < 30; n += 1) bashCard(test.session, `later-${String(n)}`, `row ${String(n)}`)
      await test.settle()
      const before = test.terminal.written.length
      prune(test.session, first, PRUNED)
      await test.settle()
      expect(test.terminal.written.slice(before)).not.toContain('\u001b[3J')
      const screen = await test.screen()
      expect(screen).toContain('FIRST-MIDDLE')
      expect(screen).not.toContain('middle pruned')
      expect(occurrences(screen, 'pruned 1 tool result to head and tail in the model\'s context (~900 tokens before)')).toBe(1)
    } finally {
      test.app.stop()
      await test.ctx.fiber.dispose()
    }
  })

  it('folds one pass into one notice and opens another after other content', async () => {
    await liveAndReplayed({ toolPreviewLines: 8 }, (test) => {
      openStep(test.session)
      const cards = [1, 2, 3].map(n => bashCard(test.session, `pass-one-${String(n)}`, `HEAD\nMIDDLE-${String(n)}\nTAIL`))
      for (const card of cards) prune(test.session, card, PRUNED)
      const later = bashCard(test.session, 'pass-two', 'HEAD\nMIDDLE-4\nTAIL')
      prune(test.session, later, PRUNED, 450)
    }, (screen) => {
      expect(occurrences(screen, 'pruned 3 tool results to head and tail in the model\'s context (~2.7k tokens before)')).toBe(1)
      expect(occurrences(screen, 'pruned 1 tool result to head and tail in the model\'s context (~450 tokens before)')).toBe(1)
      for (const n of [1, 2, 3, 4]) expect(screen).toContain(`MIDDLE-${String(n)}`)
      expect(screen).not.toContain('middle pruned')
    })
  })
})

describe('messages with several blocks of one kind', () => {
  const blocks: ContentBlock[] = [
    { type: 'reasoning', text: 'THINK-ONE' },
    { type: 'text', text: 'FIRST-TEXT.' },
    { type: 'reasoning', text: 'THINK-TWO' },
    { type: 'text', text: '' },
    { type: 'text', text: 'SECOND-TEXT.' },
  ]
  /** `first` and `second` sit on rows with exactly one blank row between them. */
  const apart = (screen: string, first: string, second: string): void => {
    expect(screen).toMatch(new RegExp(`${first}[ ]*\\r?\\n[ ]*\\r?\\n[ ]*${second}`, 'u'))
  }

  it('separates the blocks in a committed message, live and replayed', async () => {
    await liveAndReplayed({}, (test) => { test.appendAssistant(blocks) }, (screen) => {
      apart(screen, 'FIRST-TEXT\\.', 'SECOND-TEXT\\.')
      apart(screen, 'THINK-ONE', 'THINK-TWO')
    })
  })

  it('separates the blocks while the message streams, as the committed message does', async () => {
    const test = await bench()
    try {
      test.stream.start()
      test.stream.chunk({ type: 'reasoning-delta', index: 0, text: 'THINK-ONE' })
      test.stream.chunk({ type: 'text-delta', index: 1, text: 'FIRST-' })
      test.stream.chunk({ type: 'text-delta', index: 1, text: 'TEXT.' })
      test.stream.chunk({ type: 'reasoning-delta', index: 2, text: 'THINK-TWO' })
      test.stream.chunk({ type: 'text-delta', index: 3, text: '' })
      test.stream.chunk({ type: 'text-delta', index: 4, text: 'SECOND-TEXT.' })
      await test.settle()
      const screen = await test.screen()
      apart(screen, 'FIRST-TEXT\\.', 'SECOND-TEXT\\.')
      apart(screen, 'THINK-ONE', 'THINK-TWO')
    } finally {
      test.app.stop()
      await test.ctx.fiber.dispose()
    }
  })

  it('keeps a failed attempt\'s blocks apart too', async () => {
    await liveAndReplayed({}, (test) => {
      openStep(test.session)
      test.session.append('assistant/attempt', { turn: 1, step: 1, stream: [
        { type: 'chunk', time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        { type: 'text-chunks', time0: 0, index: 0, dt: [0], texts: ['ATTEMPT-ONE.'] },
        { type: 'chunk', time: 1, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'ATTEMPT-ONE.' } } },
        { type: 'chunk', time: 2, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
        { type: 'text-chunks', time0: 2, index: 1, dt: [0], texts: ['ATTEMPT-TWO.'] },
      ] } as SessionEventMap['assistant/attempt'])
    }, (screen) => {
      apart(screen, 'ATTEMPT-ONE\\.', 'ATTEMPT-TWO\\.')
    })
  })
})

describe('failure reasons', () => {
  const failed = (test: Bench, reason?: string): void => {
    openStep(test.session)
    test.session.append('tool/call', { turn: 1, step: 1, callId: callId('denied'), name: 'bash', arguments: '{"command":"curl evil"}' })
    test.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: callId('denied'), content: text('Auto review rejected tool "bash"; its body was not executed'), isError: true }),
      error: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED', ...reason === undefined ? {} : { reason } },
    }, { surfaceOp: 'append' })
  }

  it('ends the failed card on the reason the tool recorded, live and replayed', async () => {
    await liveAndReplayed({ toolPreviewLines: 8 }, (test) => { failed(test, 'sends credentials\noff-host') }, (screen) => {
      expect(screen).toContain('Auto review rejected tool "bash"; its body was not executed')
      expect(screen).toContain('reason: sends credentials off-host')
    })
  })

  it('draws no reason row when the failure recorded none', async () => {
    await liveAndReplayed({ toolPreviewLines: 8 }, (test) => { failed(test) }, (screen) => {
      expect(screen).toContain('its body was not executed')
      expect(screen).not.toContain('reason:')
    })
  })
})

describe('model retries', () => {
  it('leaves a notice behind that the spinner label does not, live and replayed', async () => {
    await liveAndReplayed({}, (test) => {
      openStep(test.session)
      test.session.append('llm/retry', {
        retryId: 'retry-1', turn: 1, step: 1, provider: 'p', mode: 'normal', policyKey: 'k', retry: 2, maxRetries: 5, delayMs: 4000,
        failure: { code: 'RATE_LIMIT', message: 'provider busy' },
      } as SessionEventMap['llm/retry'])
      test.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: text('done'), source: { provider: 'p', model: 'm' } }) }, { surfaceOp: 'append' })
    }, (screen) => {
      expect(occurrences(screen, 'model request failed · retrying (2/5) in 4s · RATE_LIMIT: provider busy')).toBe(1)
    })
  })
})

describe('approval outcomes', () => {
  const asked = (test: Bench, id: string, tool: string, reason?: string): void => {
    test.session.append('approval/asked', { id: id as never, toolName: tool, ...reason === undefined ? {} : { reason } })
  }
  const decided = (test: Bench, id: string, outcome: SessionEventMap['approval/decided']['outcome']): void => {
    test.session.append('approval/decided', { id: id as never, outcome })
  }

  it('draws every outcome with the asker\'s reason from the log, live and replayed', async () => {
    await liveAndReplayed({}, (test) => {
      openStep(test.session)
      asked(test, 'a1', 'bash', 'writes outside the workspace')
      decided(test, 'a1', 'allowed-once')
      asked(test, 'a2', 'bash', 'Auto review denied tool "bash": sends credentials\noff-host')
      decided(test, 'a2', 'rejected')
      asked(test, 'a3', 'edit')
      decided(test, 'a3', 'cancelled')
      asked(test, 'a4', 'write', 'no answerer')
      decided(test, 'a4', 'unavailable')
    }, (screen) => {
      expect(occurrences(screen, 'bash: allowed once · writes outside the workspace')).toBe(1)
      expect(screen).toContain('bash: rejected · Auto review denied tool "bash": sends credentials off-host')
      expect(screen).toMatch(/edit: cancelled(?! ·)/u)
      expect(screen).toContain('write: unavailable · no answerer')
    })
  })

  it('draws nothing for an answer whose question this log never held, or one never answered', async () => {
    await liveAndReplayed({}, (test) => {
      openStep(test.session)
      decided(test, 'orphan', 'allowed-once')
      asked(test, 'open', 'bash', 'still waiting')
    }, (screen) => {
      expect(screen).not.toContain('allowed once')
      expect(screen).not.toContain('still waiting')
    })
  })

  it('draws the outcome once when this terminal answers through the real approval service', async () => {
    const test = await bench({ before: async (ctx) => { await ctx.plugin(ApprovalService) } })
    try {
      test.session.append('turn/start', { turn: 1 })
      const outcome = test.ctx.approval.request({ agent: test.agent, toolName: 'bash', reason: 'writes outside the workspace' })
      await test.settle()
      expect(test.terminal.text()).toContain('Allow bash?')
      test.terminal.type(KEY.enter)
      await expect(outcome).resolves.toBe('allowed-once')
      await test.settle()
      const events = test.session.ownEvents().filter(event => event.type.startsWith('approval/')).map(event => event.type)
      expect(events).toEqual(['approval/asked', 'approval/decided'])
      expect(occurrences(await test.screen(), 'bash: allowed once · writes outside the workspace')).toBe(1)

      const refused = test.ctx.approval.request({ agent: test.agent, toolName: 'edit' })
      await test.settle()
      test.terminal.type(KEY.escape)
      await expect(refused).resolves.toBe('rejected')
      await test.settle()
      expect(occurrences(await test.screen(), 'edit: rejected')).toBe(1)
    } finally {
      test.app.stop()
      await test.ctx.fiber.dispose()
    }
  })
})
