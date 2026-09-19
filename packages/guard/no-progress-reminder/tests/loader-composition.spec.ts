/**
 * REAL-composition proof: a test-only cordis.yml boots the function plugin
 * through the vendored Loader, the namespace survives (no default export),
 * and an idle turn pair through the composed loop yields the notice.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as NoProgressReminder from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const spine = [
  "- name: '@deepseek-ai/dsh-llm'",
  "- name: '@deepseek-ai/dsh-session'",
  "- name: '@deepseek-ai/dsh-session-projection'",
  "- name: '@deepseek-ai/dsh-system-prompt'",
  "- name: '@deepseek-ai/dsh-tools'",
  "- name: '@deepseek-ai/dsh-agent'",
  "- name: '@deepseek-ai/dsh-agent-loop'",
] as const

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-no-progress-reminder-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-no-progress-reminder', NoProgressReminder],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it('loads the YAML shape, keeps the function-plugin namespace, and injects the notice', {
    timeout: 60_000,
  }, async () => {
    const loaded = await loadYaml([
      ...spine,
      "- name: '@deepseek-ai/dsh-no-progress-reminder'",
      '  config:',
      '    idleTurns: 1',
      '    requireGoal: false',
      '    providers: [mock]',
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect('default' in NoProgressReminder).toBe(false)

    loaded.tools.register(defineContentToolFixture({
      name: 'todo_write',
      description: 't',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'todo' }] },
    }))
    loaded.llm.registerAdapter(['mock'], new MockAdapter([
      toolCallResponse('t1', 'todo_write', {}),
      textResponse('idle'),
      textResponse('after nudge'),
    ]))
    const agent = await loaded.agentLoop.create(SessionId('composed'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const notices = agent.session.snapshotEvents()
      .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind !== 'user')
      .map(e => e.data.content.map(block => block.type === 'text' ? block.text : '').join('|'))
    expect(notices).toEqual([
      'No file has changed in 1 turns. Your next tool call must be read, edit, write, or bash, or explain what blocks you.',
    ])
  })
})
