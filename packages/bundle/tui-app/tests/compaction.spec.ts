/** The compaction ledger over real session appends, and the account it formats. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage, type ContentBlock, type MessageSource } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionSeq, type Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import {
  COMPACTION_ACCOUNT_PARTS,
  CompactionLedger,
  compactionFailure,
  compactionParts,
  compactionTitle,
  type CompactionOutcome,
  type CompactionReport,
} from '../src/compaction.ts'

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

/** A real session whose every append the ledger observes at the turn the log last opened. */
async function logged(estimate: (tokens: number) => number | undefined = () => 420): Promise<{
  session: Session
  ledger: CompactionLedger
  outcomes: CompactionOutcome[]
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create('session-compaction' as SessionId)
  const ledger = new CompactionLedger(message => estimate(message.content.length))
  const outcomes: CompactionOutcome[] = []
  let turn = 0
  ctx.on('session/event', (_session: Session, event: SessionEvent) => {
    if (event.type === 'turn/start') turn = event.data.turn
    const outcome = ledger.observe(event, turn)
    if (outcome !== undefined) outcomes.push(outcome)
  })
  return { session, ledger, outcomes }
}

function prompt(session: Session, value: string, source: MessageSource = { kind: 'user' }): SessionSeq {
  return session.append('user/message', createUserMessage({ content: text(value), source }), { surfaceOp: 'append' }).seq
}

function reply(session: Session, turn: number, content: ContentBlock[]): SessionSeq {
  return session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createAssistantMessage({ content, source: { provider: 'test-provider', model: 'test-model' } }),
  }, { surfaceOp: 'append' }).seq
}

function result(session: Session, turn: number, callId: string): SessionSeq {
  return session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId(callId), content: text('ok'), isError: false }),
  }, { surfaceOp: 'append' }).seq
}

/** One complete turn: its prompt, a read call, the result, and the final reply. */
function turnWithTool(session: Session, turn: number, ask: string): void {
  session.append('turn/start', { turn })
  prompt(session, ask)
  const callId = `call-${String(turn)}`
  reply(session, turn, [{ type: 'tool-call', id: ToolCallId(callId), name: 'read', arguments: '{}' }])
  result(session, turn, callId)
  reply(session, turn, text(`answer ${String(turn)}`))
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/**
 * Land one standalone compaction over `[start, end]` as a backend does.
 * @returns the transaction's id.
 */
function compact(
  session: Session,
  start: SessionSeq,
  end: SessionSeq,
  options: { id?: string; manual?: boolean; error?: string; turn?: number | null; land?: boolean } = {},
): string {
  const compactionId = CompactionId(options.id ?? 'compaction-1')
  const lifecycle = {
    compactionId,
    ...options.manual === false ? {} : { sourceCommandId: 'cmd-1' as never },
    turn: options.turn ?? null,
  }
  const opened = session.append('compaction/start', lifecycle)
  if (options.error !== undefined) {
    session.append('compaction/end', { ...lifecycle, error: options.error })
    return compactionId
  }
  const nodes = session.surface.nodes
  const shadowedSeqs = nodes.slice(nodes.indexOf(start), nodes.indexOf(end) + 1)
  const summary = session.append('compaction/summary', {
    compactionId,
    summary: text('## Primary Request\n- fix the lexer'),
    shadowedRange: { start, end },
    shadowedSeqs,
    shadowedTokenCount: 6400,
    provider: 'test-provider',
    model: 'summary-model',
  })
  if (options.land !== false) {
    session.append('user/message', createUserMessage({
      content: text('checkpoint'),
      source: compactCheckpointSource(compactionId, lifecycle.sourceCommandId),
    }), { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: [opened.seq, summary.seq, ...shadowedSeqs] })
  }
  session.append('compaction/end', lifecycle)
  return compactionId
}

function report(overrides: Partial<CompactionReport> = {}): CompactionReport {
  return {
    manual: true,
    turn: 3,
    compressed: [],
    preserved: [],
    summary: 'summary',
    compressedTokens: 6400,
    summaryTokens: 900,
    model: 'summary-model',
    summarySeq: SessionSeq(9),
    ...overrides,
  }
}

describe('CompactionLedger', () => {
  it('accounts for a manual compaction: the shadowed span, what stays, and the priced summary', async () => {
    const { session, outcomes } = await logged(blocks => blocks * 100)
    session.append('system/message', { turn: 1, message: { role: 'system', content: text('You are a coding agent.') } } as never, { surfaceOp: 'append' })
    session.append('turn/start', { turn: 1 })
    const first = prompt(session, 'Fix the lexer\nsecond line of the prompt')
    prompt(session, 'workspace rules', { kind: 'agent-instructions', changes: [{ path: 'AGENTS.md' }] } as never)
    reply(session, 1, [{ type: 'tool-call', id: ToolCallId('call-a'), name: 'read', arguments: '{}' }])
    result(session, 1, 'call-a')
    reply(session, 1, text('Found it.'))
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    const last = prompt(session, 'Now write the plan')
    reply(session, 2, text('Plan: …'))
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    compact(session, first, last)

    expect(outcomes).toHaveLength(1)
    const outcome = outcomes[0]!
    expect(outcome.kind).toBe('compacted')
    if (outcome.kind !== 'compacted') return
    expect(outcome.report).toMatchObject({
      manual: true,
      turn: 2,
      summary: '## Primary Request\n- fix the lexer',
      compressedTokens: 6400,
      summaryTokens: 100,
      model: 'summary-model',
    })
    expect(outcome.report.compressed.map(fact => fact.kind)).toEqual(['prompt', 'context', 'reply', 'result', 'reply', 'prompt'])
    expect(outcome.report.compressed[0]).toEqual({ kind: 'prompt', turn: 1, text: 'Fix the lexer' })
    expect(outcome.report.compressed[1]).toEqual({ kind: 'context', turn: 1, title: 'AGENTS.md' })
    expect(outcome.report.compressed[3]).toEqual({ kind: 'result', turn: 1, tool: 'read' })
    expect(outcome.report.preserved).toEqual([{ kind: 'system' }, { kind: 'reply', turn: 2 }])
    const parts = compactionParts(outcome.report)
    expect(parts.map(part => part.label)).toEqual(['compressed', 'preserved', 'summary · summary-model'])
    expect(parts[0]!.rows).toEqual([
      '6 items from turns 1–2',
      '❯ Fix the lexer',
      '❯ Now write the plan',
      '2 replies · 1 tool result (read) · 1 context block (AGENTS.md)',
    ])
    expect(parts[1]!.rows).toEqual(['system prompt', 'turn 2 · 1 reply'])
    expect(parts[2]!.rows).toEqual(['## Primary Request', '- fix the lexer'])
    expect(compactionTitle(outcome.report)).toBe('context compacted by /compact · ~6.4k → ~100 tokens')
    expect(COMPACTION_ACCOUNT_PARTS).toBe(2)
  })

  it('folds an earlier summary into a later one and names each tool, a tool it never saw called, and a developer message', async () => {
    const { session, outcomes } = await logged()
    turnWithTool(session, 1, 'first ask')
    turnWithTool(session, 2, 'second ask')
    const firstNodes = session.surface.nodes
    compact(session, firstNodes[0]!, firstNodes[4]!, { id: 'compaction-a', manual: false, turn: 2 })
    session.append('turn/start', { turn: 3 })
    session.append('developer/message', { message: { role: 'developer', content: text('be brief') } } as never, { surfaceOp: 'append' })
    result(session, 3, 'call-unknown')
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    const nodes = session.surface.nodes
    compact(session, nodes[0]!, nodes.at(-2)!, { id: 'compaction-b' })

    expect(outcomes.map(outcome => outcome.kind)).toEqual(['compacted', 'compacted'])
    const [automatic, manual] = outcomes as Extract<CompactionOutcome, { kind: 'compacted' }>[]
    expect(automatic!.report.manual).toBe(false)
    expect(compactionTitle(automatic!.report)).toBe('context compacted automatically in turn 2 · ~6.4k → ~420 tokens')
    expect(compactionParts(automatic!.report)[0]!.rows).toEqual([
      '5 items from turns 1–2',
      '❯ first ask',
      '❯ second ask',
      '2 replies · 1 tool result (read)',
    ])
    expect(compactionParts(automatic!.report)[1]!.rows).toEqual(['turn 2 · 2 replies · 1 tool result (read)'])
    expect(compactionParts(manual!.report)[0]!.rows).toEqual([
      '5 items from turns 2–3',
      '2 replies · 1 tool result (read) · 1 earlier summary · 1 developer message',
    ])
    expect(compactionParts(manual!.report)[1]!.rows).toEqual(['turn 3 · 1 tool result (tool)'])
  })

  it('reports a failed attempt, and nothing for a transaction it never saw open or that landed no checkpoint', async () => {
    const { session, ledger, outcomes } = await logged()
    turnWithTool(session, 1, 'ask')
    const nodes = session.surface.nodes
    compact(session, nodes[0]!, nodes[1]!, { error: 'summary is not smaller than the shadowed content\n  cause' })
    compact(session, nodes[0]!, nodes[1]!, { id: 'compaction-unlanded', land: false })
    session.append('compaction/end', { compactionId: CompactionId('never-opened'), turn: null })
    session.append('compaction/summary', {
      compactionId: CompactionId('never-opened'),
      summary: text('orphan'),
      shadowedRange: { start: nodes[0]!, end: nodes[0]! },
      shadowedSeqs: [nodes[0]!],
      shadowedTokenCount: 1,
      provider: 'p',
      model: 'm',
    })
    expect(outcomes).toEqual([{
      kind: 'failed',
      compactionId: CompactionId('compaction-1'),
      manual: true,
      error: 'summary is not smaller than the shadowed content\n  cause',
    }])
    expect(compactionFailure(outcomes[0] as Extract<CompactionOutcome, { kind: 'failed' }>))
      .toBe('/compact failed · summary is not smaller than the shadowed content')
    expect(compactionFailure({ kind: 'failed', compactionId: CompactionId('c'), manual: true, error: '   ' }))
      .toBe('/compact failed · ')
    ledger.clear()
    // After `clear` the ledger mirrors no surface, so the replacement names a span it never saw appended.
    compact(session, session.surface.nodes[0]!, session.surface.nodes[1]!, { id: 'compaction-after-clear' })
    expect(outcomes).toHaveLength(2)
    const after = outcomes[1] as Extract<CompactionOutcome, { kind: 'compacted' }>
    expect(after.report.compressed).toEqual([])
    expect(after.report.preserved).toEqual([])
  })

  it('leaves the summary unpriced when no meter is composed, and keeps a checkpoint of another transaction out of the account', async () => {
    const { session, outcomes } = await logged(() => undefined)
    turnWithTool(session, 1, 'ask')
    const nodes = session.surface.nodes
    session.append('compaction/start', { compactionId: CompactionId('outer'), turn: null })
    session.append('user/message', createUserMessage({
      content: text('stray checkpoint'),
      source: compactCheckpointSource(CompactionId('stray')),
    }), { surfaceOp: { op: 'replace', startSeq: nodes[0]!, endSeq: nodes[0]! }, sourceEventSeqs: [nodes[0]!] })
    session.append('compaction/end', { compactionId: CompactionId('outer'), turn: null })
    // A user-role message from a source the context view does not present is named by its kind.
    prompt(session, 'relayed', { kind: 'model', provider: 'p', model: 'm' } as never)
    compact(session, session.surface.nodes[0]!, session.surface.nodes[2]!, { id: 'priced' })
    expect(outcomes).toHaveLength(1)
    const landed = outcomes[0] as Extract<CompactionOutcome, { kind: 'compacted' }>
    expect(landed.report.summaryTokens).toBeUndefined()
    expect(compactionTitle(landed.report)).toBe('context compacted by /compact · ~6.4k tokens into one summary')
    expect(landed.report.compressed.map(fact => fact.kind)).toEqual(['summary', 'reply', 'result'])
    expect(landed.report.preserved).toEqual([{ kind: 'reply', turn: 1 }, { kind: 'context', turn: 1, title: 'model' }])
  })
})

describe('compaction account', () => {
  it('lists five prompts before counting the rest and names four context blocks before counting the rest', () => {
    const prompts = Array.from({ length: 7 }, (_, index) => ({ kind: 'prompt' as const, turn: index + 1, text: `ask ${String(index + 1)}` }))
    const contexts = Array.from({ length: 6 }, (_, index) => ({ kind: 'context' as const, turn: 1, title: `ctx ${String(index + 1)}` }))
    prompts[0] = { kind: 'prompt', turn: 1, text: `${'long '.repeat(20)}prompt` }
    const [compressed] = compactionParts(report({ compressed: [...prompts, ...contexts] }))
    expect(compressed!.rows).toEqual([
      '13 items from turns 1–7',
      `❯ ${'long '.repeat(14)}l…`, '❯ ask 2', '❯ ask 3', '❯ ask 4', '❯ ask 5',
      '+2 more prompts',
      '6 context blocks (ctx 1, ctx 2, ctx 3, ctx 4, +2 more)',
    ])
  })

  it('names a span with no turn, one lone item, repeated tools, and a history the summary wholly replaced', () => {
    const parts = compactionParts(report({
      compressed: [{ kind: 'system' }],
      preserved: [],
      summary: '',
    }))
    expect(parts[0]!.rows).toEqual(['1 item'])
    expect(parts[1]!.rows).toEqual(['nothing else: the summary is the whole history'])
    expect(parts[2]!.rows).toEqual([''])
    const tools = compactionParts(report({
      compressed: [
        { kind: 'result', turn: 4, tool: 'read' },
        { kind: 'result', turn: 4, tool: 'bash' },
        { kind: 'result', turn: 4, tool: 'read' },
      ],
      preserved: [{ kind: 'prompt', turn: 5, text: 'next' }],
    }))
    expect(tools[0]!.rows).toEqual(['3 items from turn 4', '3 tool results (read ×2, bash)'])
    expect(tools[1]!.rows).toEqual(['turn 5 · ❯ next'])
  })
})
