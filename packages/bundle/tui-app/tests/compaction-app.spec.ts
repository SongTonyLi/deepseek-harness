/**
 * `/compact` in the terminal: the cancellable `compacting` spinner, prompts
 * queued behind it, the one block a landed compaction draws in place of the
 * command's own result, and the same account drawn from a replayed log.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime, { type CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createAssistantMessage, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionSeq, type Session, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import { KEY, bench, spinning } from './bench.ts'

function typeLine(terminal: { type(data: string): void }, text: string): void {
  for (const char of text) terminal.type(char)
  terminal.type(KEY.enter)
}

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

/** One completed turn with a prompt and a text reply, as the loop logs it. */
function turn(session: Session, number: number, ask: string, answer: string): void {
  session.append('turn/start', { turn: number })
  session.append('user/message', createUserMessage({ content: text(ask), source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    stream: [],
    turn: number,
    step: 1,
    message: createAssistantMessage({ content: text(answer), source: { provider: 'test-provider', model: 'test-model' } }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: number, reason: { kind: 'completed' } })
}

/** The lifecycle fields of one standalone or turn-owned transaction. */
function lifecycle(id: string, sourceCommandId: CommandId | undefined, owner: number | null): {
  compactionId: ReturnType<typeof CompactionId>
  sourceCommandId?: CommandId
  turn: number | null
} {
  return { compactionId: CompactionId(id), ...sourceCommandId === undefined ? {} : { sourceCommandId }, turn: owner }
}

/**
 * Land an opened transaction over every surface node but the last, as the
 * basic backend does with no retained tail.
 * @returns the `compaction/summary` seq a `/compact` result names.
 */
function land(session: Session, fields: ReturnType<typeof lifecycle>, openedSeq: SessionSeq): SessionSeq {
  const nodes = session.surface.nodes
  const shadowedSeqs = nodes.slice(0, -1)
  const start = shadowedSeqs[0]!
  const end = shadowedSeqs.at(-1)!
  const summary = session.append('compaction/summary', {
    ...fields,
    summary: text('## Primary Request\n- fix the lexer\n- keep lex() stable\n## Next Step\n- write the plan'),
    shadowedRange: { start, end },
    shadowedSeqs,
    shadowedTokenCount: 6400,
    provider: 'test-provider',
    model: 'summary-model',
  })
  session.append('user/message', createUserMessage({
    content: text('checkpoint preamble'),
    source: compactCheckpointSource(fields.compactionId, fields.sourceCommandId),
  }), { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: [openedSeq, summary.seq, ...shadowedSeqs] })
  session.append('compaction/end', fields)
  return summary.seq
}

/** A `/compact` command that opens its transaction, then waits for the spec to land or fail it. */
function gatedCompact(): {
  register(ctx: Context): void
  land(): void
  fail(error: string): void
  invocation(): CommandInvocation
} {
  let current: { invocation: CommandInvocation; settle: (error: string | undefined) => void } | undefined
  return {
    register(ctx) {
      ctx.commands.register({
        name: 'compact',
        description: 'Compact older conversation history',
        handler: invocation => new Promise((resolve) => {
          const { session } = invocation.agent
          const fields = lifecycle('compaction-live', invocation.commandId, null)
          const opened = session.append('compaction/start', fields)
          current = {
            invocation,
            settle: (error) => {
              if (error === undefined) {
                resolve({ kind: 'success', text: 'Compacted 3 history items (~6400 tokens).', sourceEventSeq: land(session, fields, opened.seq) })
                return
              }
              session.append('compaction/end', { ...fields, error })
              resolve({ kind: 'error', text: 'Compaction cancelled.' })
            },
          }
        }),
      })
    },
    land: () => { current!.settle(undefined) },
    fail: (error) => { current!.settle(error) },
    invocation: () => current!.invocation,
  }
}

describe('/compact', () => {
  it('spins while it runs, queues prompts behind it, and draws the landed compaction as one block', async () => {
    const compact = gatedCompact()
    const test = await bench({
      before: async (ctx) => {
        await ctx.plugin(CommandRuntime)
        compact.register(ctx)
      },
    })
    turn(test.session, 1, 'Fix the lexer columns', 'Found the off-by-one.')
    turn(test.session, 2, 'Now write the plan', 'Plan: keep lex() stable.')
    await test.settle()
    typeLine(test.terminal, '/compact')
    await test.settle()
    expect(test.terminal.text()).toMatch(spinning('compacting context · Esc cancels', 'compacting'))
    expect(compact.invocation().rawInput).toBe('')

    typeLine(test.terminal, 'and then ship it')
    typeLine(test.terminal, '/compact')
    typeLine(test.terminal, '/new')
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([text('and then ship it')])
    const waiting = test.terminal.text()
    expect(waiting).toContain('queued: the prompt starts once compaction finishes')
    expect(waiting).not.toContain('❯ and then ship it')
    expect(waiting).toContain('a compaction is already running · Esc cancels it')
    expect(waiting).toContain('wait for the compaction to finish (Esc cancels it) before switching sessions')
    expect(test.hostCalls).toEqual([])

    compact.land()
    await test.settle()
    const screen = await test.screen()
    expect(screen).toContain('⬡ context compacted by /compact · ~6.4k tokens into one summary')
    expect(screen).toContain('compressed')
    expect(screen).toContain('3 items from turns 1–2')
    expect(screen).toContain('❯ Fix the lexer columns')
    expect(screen).toContain('❯ Now write the plan')
    expect(screen).toContain('1 reply')
    expect(screen).toContain('preserved')
    expect(screen).toContain('turn 2 · 1 reply')
    expect(screen).toContain('summary · summary-model')
    expect(screen).toContain('## Primary Request')
    expect(screen).toContain('… 2 more rows · Ctrl+O expands')
    // The block is the result: neither the command's text nor the checkpoint's framing is drawn again.
    expect(screen).not.toContain('Compacted 3 history items')
    expect(screen).not.toContain('checkpoint preamble')
    expect(screen).not.toContain('compacting context')
    // The fold keys reach the summary like any context block.
    test.terminal.type(KEY.ctrlO)
    await test.settle()
    expect(await test.screen()).toContain('- write the plan')
  })

  it('cancels on Esc and prints nothing for the transaction the command already reported', async () => {
    const compact = gatedCompact()
    const test = await bench({
      before: async (ctx) => {
        await ctx.plugin(CommandRuntime)
        compact.register(ctx)
      },
    })
    turn(test.session, 1, 'Fix it', 'Fixed.')
    typeLine(test.terminal, '/compact')
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(compact.invocation().signal.aborted).toBe(true)
    // The backend closes its bracket after the command stopped waiting.
    compact.fail('AbortError: This operation was aborted')
    await test.settle()
    const screen = await test.screen()
    expect(screen).toContain('/compact cancelled')
    expect(screen).not.toContain('failed')
    expect(screen).not.toContain('compacting context')
    expect(test.calls.cancels).toBe(0)
  })

  it('waits for the running turn, and quitting mid-compaction prints nothing more', async () => {
    const running = await bench({ running: true, before: async (ctx) => { await ctx.plugin(CommandRuntime) } })
    typeLine(running.terminal, '/compact')
    await running.settle()
    expect(running.terminal.text()).toContain('/compact runs between turns: let this turn finish, or stop it (Esc twice)')

    const compact = gatedCompact()
    const test = await bench({
      before: async (ctx) => {
        await ctx.plugin(CommandRuntime)
        compact.register(ctx)
      },
    })
    turn(test.session, 1, 'Fix it', 'Fixed.')
    typeLine(test.terminal, '/compact')
    await test.settle()
    test.app.stop()
    const output = test.terminal.output
    compact.fail('AbortError: This operation was aborted')
    await test.settle()
    expect(compact.invocation().signal.aborted).toBe(true)
    expect(test.terminal.output).toBe(output)
  })

  it('prints a command result that settles for the session it ran on only, and names a source it did not draw', async () => {
    const gates: { resolve: () => void; reject: (error: Error) => void }[] = []
    const test = await bench({
      before: async (ctx) => {
        await ctx.plugin(CommandRuntime)
        ctx.commands.register({
          name: 'slow',
          description: 'Settle when the spec says so',
          handler: () => new Promise((resolve, reject) => {
            gates.push({ resolve: () => { resolve({ kind: 'success', text: 'late result' }) }, reject })
          }),
        })
        ctx.commands.register({
          name: 'sourced',
          description: 'Name a source event nothing drew',
          handler: () => ({ kind: 'success', text: 'sourced result', sourceEventSeq: SessionSeq(0) }),
        })
      },
    })
    typeLine(test.terminal, '/sourced')
    await test.settle()
    expect(test.terminal.text()).toContain('/sourced: sourced result')

    typeLine(test.terminal, '/slow')
    typeLine(test.terminal, '/slow')
    await test.settle()
    typeLine(test.terminal, '/new')
    await test.settle()
    expect(test.hostCalls).toEqual(['create'])
    gates[0]!.resolve()
    gates[1]!.reject(new Error('late failure'))
    await test.settle()
    const screen = await test.screen()
    expect(screen).not.toContain('late result')
    expect(screen).not.toContain('late failure')

    typeLine(test.terminal, '/slow')
    await test.settle()
    test.app.stop()
    const output = test.terminal.output
    gates[2]!.resolve()
    await test.settle()
    expect(test.terminal.output).toBe(output)
  })
})

describe('compaction from the log', () => {
  it('replays a manual and an automatic compaction as blocks, a failed /compact as a notice, and no failed automatic attempt', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create('session-replayed' as SessionId)
    const history: SessionEvent[] = []
    ctx.on('session/event', (_session: Session, event: SessionEvent) => { history.push(event) })
    turn(session, 1, 'First ask', 'First answer.')
    turn(session, 2, 'Second ask', 'Second answer.')
    const manual = lifecycle('compaction-manual', 'cmd-1' as CommandId, null)
    land(session, manual, session.append('compaction/start', manual).seq)
    const failed = lifecycle('compaction-failed', 'cmd-2' as CommandId, null)
    session.append('compaction/start', failed)
    session.append('compaction/end', { ...failed, error: 'summary is not smaller than the shadowed content\nat compact' })
    session.append('turn/start', { turn: 3 })
    session.append('user/message', createUserMessage({ content: text('Third ask'), source: { kind: 'user' } }), { surfaceOp: 'append' })
    const retried = lifecycle('compaction-automatic-failed', undefined, 3)
    session.append('compaction/start', retried)
    session.append('compaction/end', { ...retried, error: 'automatic attempt did not shrink' })
    const automatic = lifecycle('compaction-automatic', undefined, 3)
    land(session, automatic, session.append('compaction/start', automatic).seq)
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })

    const test = await bench({ history })
    const screen = await test.screen()
    expect(screen).toContain('⬡ context compacted by /compact · ~6.4k tokens into one summary')
    expect(screen).toContain('3 items from turns 1–2')
    expect(screen).toContain('/compact failed · summary is not smaller than the shadowed content')
    expect(screen).not.toContain('at compact')
    expect(screen).not.toContain('automatic attempt did not shrink')
    expect(screen).toContain('⬡ context compacted automatically in turn 3 · ~6.4k tokens into one summary')
    expect(screen).toContain('1 earlier summary')
    // A replayed automatic compaction leaves the idle spinner alone.
    expect(screen).not.toContain('compacting')
  })

  it('labels the running turn\'s spinner while an automatic compaction condenses history', async () => {
    const test = await bench({ running: true })
    turn(test.session, 1, 'First ask', 'First answer.')
    test.session.append('turn/start', { turn: 2 })
    test.session.append('user/message', createUserMessage({ content: text('Second ask'), source: { kind: 'user' } }), { surfaceOp: 'append' })
    const automatic = lifecycle('compaction-automatic', undefined, 2)
    const opened = test.session.append('compaction/start', automatic)
    await test.settle()
    expect(test.terminal.text()).toMatch(spinning('compacting', 'compacting'))
    expect(test.terminal.text()).not.toContain('Esc cancels')
    land(test.session, automatic, opened.seq)
    await test.settle()
    expect(await test.screen()).toContain('⬡ context compacted automatically in turn 2')
  })
})
