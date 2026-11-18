/** The terminal's subagent narration entry: which agents receive it, where it sorts, and when it is removed. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SystemPrompt, type AssembledContext, type PromptContextOrderName } from '@deepseek-ai/dsh-system-prompt'
import { apply } from '../src/index.ts'
import { installSubagentNarration } from '../src/subagent-narration.ts'
import { NARRATION_CONTEXT, NARRATION_SENTENCE, spawnChild, spawnSide, terminalConfig } from './narration-fixtures.ts'

/** Repository-owned runtime-context placements; the narration order must differ from each. */
const CENTRAL_CONTEXT_ORDERS: PromptContextOrderName[] = [
  'WORKING_DIRECTORY',
  'SANDBOX_POLICY',
  'SANDBOX_BACKEND',
  'APPROVAL_POLICY',
  'SUBAGENT_DELEGATION',
  'HARNESS_SOURCE',
  'WEB_SURFACE',
]

const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/**
 * Mount the production AgentLoop over the real registries. The suite owns the
 * context and disposes it after each test.
 * @returns the context and the production Agent driver.
 */
async function mount() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  return { ctx, loop }
}

/**
 * Assemble an agent's runtime context exactly as its model request does.
 * @param ctx - context that owns the systemPrompt registry.
 * @param agent - the agent whose scope is assembled.
 * @returns the agent's runtime-context entries in request order.
 */
async function runtimeContextOf(ctx: Context, agent: Agent): Promise<AssembledContext[]> {
  return (await ctx.systemPrompt.assemble(assembleContextFor(agent))).contexts
}

/**
 * @param entries - runtime-context entries in request order.
 * @returns their names in the same order.
 */
function namesOf(entries: readonly AssembledContext[]): string[] {
  return entries.map(entry => entry.name)
}

describe('subagent narration', () => {
  it('gives an in-process child the entry directly after its delegation statement, at a distinct order', async () => {
    const { ctx, loop } = await mount()
    const registrations = vi.spyOn(SystemPrompt.prototype, 'context')
    await ctx.plugin(installSubagentNarration)
    const parent = await loop.create(brandString<SessionId>('parent'))
    const child = await spawnChild(ctx, parent, 'child')

    const entries = await runtimeContextOf(ctx, child)
    const names = namesOf(entries)
    const delegation = names.indexOf('subagent:delegation')
    expect(delegation).toBeGreaterThanOrEqual(0)
    expect(names[delegation + 1]).toBe(NARRATION_CONTEXT)
    expect(entries.find(entry => entry.name === NARRATION_CONTEXT)?.text).toBe(NARRATION_SENTENCE)

    const [registered] = registrations.mock.calls.map(([entry]) => entry).filter(entry => entry.name === NARRATION_CONTEXT)
    expect(registered?.text).toBe(NARRATION_SENTENCE)
    const order = registered?.order
    expect(order).toBeGreaterThan(ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'))
    expect(order).toBeLessThan(ctx.systemPrompt.getContextOrder('HARNESS_SOURCE'))
    expect(CENTRAL_CONTEXT_ORDERS.map(name => ctx.systemPrompt.getContextOrder(name))).not.toContain(order)
  })

  it('gives no narration entry to a top-level agent or to a /btw side agent', async () => {
    const { ctx, loop } = await mount()
    await ctx.plugin(installSubagentNarration)
    const parent = await loop.create(brandString<SessionId>('parent'))
    const side = await spawnSide(ctx, parent)

    expect(namesOf(await runtimeContextOf(ctx, parent))).not.toContain(NARRATION_CONTEXT)
    expect(namesOf(await runtimeContextOf(ctx, side))).not.toContain(NARRATION_CONTEXT)
  })

  it('removes a child entry when that child is disposed and keeps the delegation statement', async () => {
    const { ctx, loop } = await mount()
    await ctx.plugin(installSubagentNarration)
    const parent = await loop.create(brandString<SessionId>('parent'))
    const child = await spawnChild(ctx, parent, 'child')
    expect(namesOf(await runtimeContextOf(ctx, child))).toContain(NARRATION_CONTEXT)

    ctx.emit('agent/disposed', { agent: child })

    await vi.waitFor(async () => {
      expect(namesOf(await runtimeContextOf(ctx, child))).not.toContain(NARRATION_CONTEXT)
    })
    expect(namesOf(await runtimeContextOf(ctx, child))).toContain('subagent:delegation')
  })

  it('removes every entry and registers no new one when the installation is disposed', async () => {
    const { ctx, loop } = await mount()
    const installed = await ctx.plugin(installSubagentNarration)
    const parent = await loop.create(brandString<SessionId>('parent'))
    const first = await spawnChild(ctx, parent, 'first')
    expect(namesOf(await runtimeContextOf(ctx, first))).toContain(NARRATION_CONTEXT)

    await installed.dispose()

    expect(namesOf(await runtimeContextOf(ctx, first))).not.toContain(NARRATION_CONTEXT)
    const later = await spawnChild(ctx, parent, 'later')
    expect(namesOf(await runtimeContextOf(ctx, later))).not.toContain(NARRATION_CONTEXT)
  })

  it('is installed by the plugin entry, so a child created after mounting carries the entry', async () => {
    const { ctx, loop } = await mount()
    // The runner returns before creating a terminal when no default-model service is composed.
    ctx.provide('appExit', () => {})
    apply(ctx, terminalConfig())
    const parent = await loop.create(brandString<SessionId>('parent'))
    const child = await spawnChild(ctx, parent, 'child')

    expect(namesOf(await runtimeContextOf(ctx, child))).toContain(NARRATION_CONTEXT)
    expect(namesOf(await runtimeContextOf(ctx, parent))).not.toContain(NARRATION_CONTEXT)
  })
})
