/** The `/btw` side agent's seed and opening notice. */

import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { BTW_BRIEF, BTW_SANDBOXED_TOOLS, BTW_TOOLS, btwBriefMessage, btwSeed, restrictBtwAgent } from '../src/btw.ts'

/** A log whose second turn is still waiting on one tool call. */
function openTurnLog(): SessionEvent[] {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { turn: 1, message: createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }) }, surfaceOp: 'append' },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'step/start', data: { turn: 2, step: 1 } },
    {
      type: 'assistant/message',
      data: {
        turn: 2,
        step: 1,
        stream: [],
        message: createAssistantMessage({
          content: [{ type: 'tool-call', id: 'call-1' as ToolCallId, name: 'read', arguments: '{}' }],
          source: { provider: 'p', model: 'm' },
        }),
      },
      surfaceOp: 'append',
    },
  ]
  return events.map((event, seq) => ({ ...event, seq, time: 1 }) as SessionEvent)
}

describe('btwSeed', () => {
  it('copies the whole log and closes the unfinished turn after the fork marker', () => {
    const events = openTurnLog()
    const { seed, inheritedEventCount } = btwSeed(events)
    expect(inheritedEventCount).toBe(events.length)
    expect(seed.slice(0, events.length)).toEqual(events)
    expect(seed.slice(events.length).map(event => event.type)).toEqual(['session/end-seed', 'tool/result', 'step/end', 'turn/end'])
    expect(seed.at(-1)).toMatchObject({ data: { turn: 2, reason: { kind: 'forked' } } })
    expect(seed.map(event => event.seq)).toEqual(seed.map((_, index) => index))
  })

  it('seeds nothing from an empty log', () => {
    expect(btwSeed([])).toEqual({ seed: [], inheritedEventCount: 0 })
  })
})

describe('btwBriefMessage', () => {
  it('is a terminal notice carrying the brief', () => {
    const message = btwBriefMessage()
    expect(message.source).toEqual({ kind: 'tui-app', form: 'notice', summary: 'btw · side agent' })
    expect(message.content).toEqual([{ type: 'text', text: BTW_BRIEF }])
  })
})

describe('restrictBtwAgent', () => {
  /**
   * A side agent's creation context over scripted services.
   * @param services - the composed tools, by name, and whether the command executor confines.
   * @returns the context, the agent, and what they recorded.
   */
  function world(services: { tools?: readonly string[]; confined?: boolean }) {
    const appended: { type: string; data: unknown }[] = []
    const restrictions: unknown[] = []
    const registered = new Set(services.tools)
    const tools = {
      get: (name: string) => registered.has(name) ? {} : undefined,
      restrict: (filter: unknown) => { restrictions.push(filter) },
    }
    const services_: Record<string, unknown> = {
      ...services.tools === undefined ? {} : { tools },
      ...services.confined === undefined ? {} : { shell: { sandboxMode: services.confined ? 'workspace-write' : undefined } },
    }
    const agentCtx = { get: (name: string) => services_[name], tools }
    const agent = { session: { append: (type: string, data: unknown) => { appended.push({ type, data }) } } }
    return { agentCtx: agentCtx as never, agent: agent as never, appended, restrictions }
  }

  const policy = { btwTools: BTW_TOOLS, btwSandboxedTools: BTW_SANDBOXED_TOOLS }

  it('pins the read-only sandbox and the never approval policy and keeps only composed read tools and confined commands', () => {
    const { agentCtx, agent, appended, restrictions } = world({ tools: ['read', 'grep', 'write', 'edit', 'bash', 'subagent'], confined: true })
    restrictBtwAgent(agentCtx, agent, policy)
    expect(appended).toEqual([
      { type: 'sandbox/mode', data: { mode: 'read-only', source: 'delegation' } },
      { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
    ])
    expect(restrictions).toEqual([{ allow: ['read', 'grep', 'bash'] }])
  })

  it('hides command tools when the command executor does not confine', () => {
    const { agentCtx, agent, restrictions } = world({ tools: ['read', 'bash'], confined: false })
    restrictBtwAgent(agentCtx, agent, policy)
    expect(restrictions).toEqual([{ allow: ['read'] }])
  })

  it('hides command tools without a command executor and restricts nothing without a tool registry', () => {
    const bare = world({ tools: ['bash'] })
    restrictBtwAgent(bare.agentCtx, bare.agent, policy)
    expect(bare.restrictions).toEqual([{ allow: [] }])
    const none = world({})
    restrictBtwAgent(none.agentCtx, none.agent, policy)
    expect(none.restrictions).toEqual([])
    expect(none.appended).toHaveLength(2)
  })
})
