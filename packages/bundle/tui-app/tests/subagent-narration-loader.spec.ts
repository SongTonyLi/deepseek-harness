/**
 * Real-composition check for the subagent narration entry, booted through the
 * Loader and driven through the real subagent tool path.
 *
 * The root context mounts the agent-loop test dependencies with the real working
 * directory, the JSONL session persistence that parent-delivered activations
 * require, the production AgentLoop, the subagent runtime, the in-process spawn
 * provider (`spawn`), and the `subagent` tool. A test-only `cordis.yml` is then
 * included through `cordis:include`, and its `tui-app` entry is a fixture module
 * that delegates to the real `apply` from `../src/index.ts` with the terminal
 * configuration of the unit specs. The Loader calls `apply`, which installs the
 * narration listener. This spec never calls `installSubagentNarration`. The
 * fixture omits the real module's `inject` list (`agentDefaultModel`) because
 * this tree composes no default-model service, so `apply` returns before any
 * terminal work.
 *
 * Child creation: the parent's scripted model emits one `subagent` tool call. The
 * tool starts an activation on the spawn provider, and the spawn path creates the
 * child and applies its delegation statement. This spec makes no direct
 * `childSessionMeta` or `applyChildComposition` call.
 *
 * Scripted model: the agent-loop testkit has no scripted adapter that can emit a
 * tool call, so the spec uses the core agent-loop `MockAdapter` through its
 * relative test path, as the spawn and fork specs do. `MockAdapter` consumes its
 * script in call order, but the background child's requests interleave with the
 * parent's, so every script entry routes its response by the request's `sessionId`.
 *
 * Keyless: the only provider is the scripted `mock` route, and no network is used.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, type AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as subagentTool from '@deepseek-ai/dsh-tool-subagent'
import { renderContextSections, renderContextSnapshot, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, type Config } from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { NARRATION_CONTEXT, NARRATION_SENTENCE, terminalConfig } from './narration-fixtures.ts'

/** Global slot the fixture entry calls; the Loader imports the fixture through Node's resolver, which cannot load this spec's sources. */
const ENTRY_GLOBAL = '__dshTuiNarrationEntry'

const PARENT_ID = brandString<SessionId>('parent')
const PARENT_PROMPT = 'narration parent task'
const CHILD_PROMPT = 'narration child task'
const SUBAGENT_CALL = 'subagent-call-1'
const PARENT_ANSWER = 'delegated'
const CHILD_ANSWER = 'child answer'
/** Upper bound on scripted model calls: the parent's tool call, its tool-result turn, the child, and the parent's notice turn. */
const SCRIPT_ENTRIES = 8

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  Reflect.deleteProperty(globalThis, ENTRY_GLOBAL)
})

/** The child the subagent tool started, and its runtime-context assembly captured while the child was alive. */
interface StartedChild {
  child: Agent
  assembly: Promise<PromptAssembly>
}

/** One tree booted through the Loader. */
interface Booted {
  ctx: Context
  loop: AgentLoopTestHarness
  /** The configurations the Loader passed to the entry's `apply`, in call order. */
  applied: Config[]
  /** Children started through the subagent tool, in start order. */
  children: StartedChild[]
  /** The scripted model; its recorded requests are what the provider received. */
  adapter: MockAdapter
}

/**
 * Mount the subagent tool path and the production AgentLoop on one root context,
 * then boot the test-only `cordis.yml` through the Loader.
 * @param options - `applyEntry: false` records the Loader's call without running the real `apply`, as a control.
 * @returns the booted tree, its production Agent driver, and the observed applications and children.
 */
async function boot({ applyEntry = true }: { applyEntry?: boolean } = {}): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-narration-'))
  const sessions = mkdtempSync(join(tmpdir(), 'dsh-tui-narration-sessions-'))
  tempDirs.push(dir, sessions)
  const applied: Config[] = []
  writeFileSync(join(dir, 'tui-app-entry.mjs'), [
    'export const name = \'tui-app\'',
    `export const apply = (ctx, config) => globalThis[${JSON.stringify(ENTRY_GLOBAL)}](ctx, config)`,
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: tui-app',
    `  name: ${JSON.stringify(pathToFileURL(join(dir, 'tui-app-entry.mjs')).href)}`,
    `  config: ${JSON.stringify(terminalConfig())}`,
    '',
  ].join('\n'))
  Object.assign(globalThis, {
    [ENTRY_GLOBAL]: (ctx: Context, config: Config) => {
      applied.push(config)
      if (applyEntry) apply(ctx, config)
    },
  })

  const ctx = new Context()
  contexts.push(ctx)
  const children: StartedChild[] = []
  // Requests from the child and from the parent interleave, so each entry routes by session.
  let parentCalls = 0
  const route = (options: GenerateOptions): StreamChunk[] => {
    if (options.sessionId !== PARENT_ID) {
      const child = options.sessionId === undefined ? undefined : ctx.agents.get(options.sessionId)
      if (child !== undefined && children.length === 0) {
        children.push({ child, assembly: ctx.systemPrompt.assemble(assembleContextFor(child)) })
      }
      return textResponse(CHILD_ANSWER)
    }
    parentCalls += 1
    return parentCalls === 1
      ? toolCallResponse(SUBAGENT_CALL, 'subagent', { description: 'narration child', prompt: CHILD_PROMPT })
      : textResponse(PARENT_ANSWER)
  }

  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root: sessions })
  const loop = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  await ctx.plugin(subagentTool, { provider: 'spawn' })
  const adapter = new MockAdapter(Array.from({ length: SCRIPT_ENTRIES }, () => route))
  ctx.llm.registerAdapter(['mock'], adapter)
  // `apply` reads the launcher's exit request before it mounts the runner.
  ctx.provide('appExit', () => {})
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  return { ctx, loop, applied, children, adapter }
}

/**
 * Run one parent turn that delegates through the subagent tool, then wait until
 * the started child has ended.
 * @param tree - the booted tree whose scripted model and tool are mounted.
 * @returns the parent agent and the started child with its captured assembly.
 */
async function delegate(tree: Booted): Promise<{ parent: Agent } & StartedChild> {
  const { ctx, loop, children } = tree
  const parent = await loop.create(PARENT_ID, { provider: 'mock', model: 'mock' })
  const ended = new Promise<void>((resolve) => {
    ctx.on('subagent/end', (info) => {
      if (info.parentSessionId === PARENT_ID) resolve()
    })
  })
  parent.followup(createUserMessage({ content: [{ type: 'text', text: PARENT_PROMPT }], source: { kind: 'user' } }))
  await parent.whenIdle()
  await ended
  const started = children[0]
  if (started === undefined) throw new Error('the subagent tool did not start a child')
  return { parent, ...started }
}

describe('subagent narration through the Loader and the subagent tool', () => {
  it('applies the terminal entry once, with the terminal configuration', async () => {
    const { applied } = await boot()
    expect(applied).toEqual([terminalConfig()])
  })

  it('gives a tool-started child the narration directly after its delegation statement, with the exact sentence', async () => {
    const tree = await boot()
    const { child, assembly } = await delegate(tree)

    expect(child.session.header.parentSession).toBe(PARENT_ID)
    expect(child.session.header.delegationDepth).toBe(1)
    const resolved = await assembly
    const sections = renderContextSections(resolved)
    const names = sections.map(section => section.name)
    const delegation = names.indexOf('subagent:delegation')
    expect(delegation).toBeGreaterThanOrEqual(0)
    expect(names[delegation + 1]).toBe(NARRATION_CONTEXT)
    expect(sections[delegation + 1]?.text).toBe(NARRATION_SENTENCE)
    expect(renderContextSnapshot(resolved)).toContain(NARRATION_SENTENCE)

    // The provider received the child's first request with the same sentence after the delegation statement.
    const request = tree.adapter.requests.find(options => options.sessionId === child.id)
    expect(request).toBeDefined()
    const wire = JSON.stringify(request?.messages)
    const delegationStart = sections[delegation]?.text.slice(0, 60) ?? ''
    expect(delegationStart).not.toBe('')
    const delegationAt = wire.indexOf(delegationStart)
    expect(delegationAt).toBeGreaterThanOrEqual(0)
    expect(wire.indexOf(NARRATION_SENTENCE)).toBeGreaterThan(delegationAt)
  })

  it('gives the top-level agent no narration', async () => {
    const tree = await boot()
    const { parent } = await delegate(tree)

    const assembly = await tree.ctx.systemPrompt.assemble(assembleContextFor(parent))
    expect(renderContextSections(assembly).map(section => section.name)).not.toContain(NARRATION_CONTEXT)
    expect(renderContextSnapshot(assembly)).not.toContain(NARRATION_SENTENCE)
  })

  it('gives the same tool-started child no narration when the Loader does not run the entry', async () => {
    const tree = await boot({ applyEntry: false })
    const { child, assembly } = await delegate(tree)

    const names = renderContextSections(await assembly).map(section => section.name)
    expect(names).toContain('subagent:delegation')
    expect(names).not.toContain(NARRATION_CONTEXT)
    const request = tree.adapter.requests.find(options => options.sessionId === child.id)
    expect(request).toBeDefined()
    expect(JSON.stringify(request?.messages)).not.toContain(NARRATION_SENTENCE)
  })
})
