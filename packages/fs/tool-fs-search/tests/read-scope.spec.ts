/** The sandbox read fence on `grep` and `glob`: outside search paths are refused and hidden files are never searched. */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import { buildGrepCommand } from '@deepseek-ai/dsh-tool-fs-search'
import { WorkspaceReadSandbox } from '../../../sandbox/sandbox/tests/read-scope-sandbox.ts'

let ws: string
let outside: string
/** The Session's current directory, which a test moves away from the workspace the way `cd` does. */
let current: string
let ctx: Context
let calls = 0

function call(name: string, args: Record<string, unknown>, agent?: Agent) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++calls}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

/** An agent whose session workspace is `cwd`; the search tools read only its session. */
function agentIn(cwd: string): Agent {
  const id = SessionId(`search-scope-${++calls}`)
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd })
  return { session } as Partial<Agent> as Agent
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

beforeEach(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), 'dsh-search-scope-ws-')))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-search-scope-out-')))
  await writeFile(join(ws, 'a.txt'), 'needle inside\n')
  await writeFile(join(ws, '.env'), 'needle=sk-test\n')
  await writeFile(join(ws, 'server.env'), 'needle visible\n')
  await writeFile(join(outside, 'secret.txt'), 'needle outside\n')
  current = ws
  ctx = new Context()
  ctx.provide('workingDirectory', { ensure: () => Promise.resolve(current) })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: ws })
  await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(ws, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('search read fence', () => {
  it('excludes hidden names after the include glob', () => {
    expect(buildGrepCommand({ pattern: 'x', include: '*.ts', path: 'src' }, ['.env', '*.pem'])).toEqual([
      '--json', '--regexp=x', '--glob=*.ts', '--iglob=!.env', '--iglob=!*.pem', '--', 'src',
    ])
  })

  it('refuses outside paths and never searches hidden files', async () => {
    await ctx.plugin(WorkspaceReadSandbox)
    for (const name of ['grep', 'glob']) {
      const refused = await call(name, name === 'grep' ? { pattern: 'needle', path: outside } : { pattern: '*', path: outside })
      expect(refused.isError).toBe(true)
      expect(refused.error).toMatchObject({ info: { code: 'SEARCH_SANDBOX_DENIED' } })
      expect(text(refused)).toContain(`${name} cannot search "${outside}": the sandbox hides this path from this session`)
    }
    const found = text(await call('grep', { pattern: 'needle', path: ws }))
    expect(found).toContain('a.txt')
    expect(found).toContain('server.env')
    expect(found).not.toContain('sk-test')
    const hidden = await call('grep', { pattern: 'needle', path: join(ws, '.env') })
    expect(hidden.error).toMatchObject({ info: { code: 'SEARCH_SANDBOX_DENIED' } })
  })

  it('scopes a pathless search to the calling session workspace', async () => {
    await ctx.plugin(WorkspaceReadSandbox)
    expect(text(await call('grep', { pattern: 'needle' }, agentIn(ws)))).toContain('a.txt')
    const agentless = await call('grep', { pattern: 'needle' })
    expect(text(agentless)).toContain('grep cannot search ".": the sandbox hides this path from this session')
  })

  it('fences the directory the search runs in, not the workspace the session started in', async () => {
    await ctx.plugin(WorkspaceReadSandbox)
    const agent = agentIn(ws)
    current = outside
    for (const [name, args] of [['grep', { pattern: 'needle' }], ['glob', { pattern: '*' }]] as const) {
      const refused = await call(name, args, agent)
      expect(refused.error).toMatchObject({ info: { code: 'SEARCH_SANDBOX_DENIED' } })
      expect(text(refused)).not.toContain('secret.txt')
    }
    await mkdir(join(ws, 'sub'))
    current = join(ws, 'sub')
    const found = text(await call('grep', { pattern: 'needle', path: '..' }, agent))
    expect(found).toContain('a.txt')
    expect(found).not.toContain('sk-test')
  })

  it('searches anywhere without a confining provider', async () => {
    expect(text(await call('grep', { pattern: 'needle', path: outside }))).toContain('secret.txt')
  })
})
