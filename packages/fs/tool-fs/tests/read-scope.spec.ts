/**
 * The sandbox read fence on `read`, `edit`, and `write`: under a provider that
 * confines reads, paths outside the read scope and hidden secret files are
 * refused before anything observes them; without one, reads are unconfined.
 */

import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { WorkspaceReadSandbox } from '../../../sandbox/sandbox/tests/read-scope-sandbox.ts'

let ws: string
let outside: string
let ctx: Context
let calls = 0

function call(name: string, args: unknown) {
  return ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`call-${++calls}`), name, arguments: args })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function mount(confining: boolean, mode: 'workspace-write' | 'danger-full-access' = 'workspace-write'): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: ws })
  if (confining) await ctx.plugin(WorkspaceReadSandbox)
  await ctx.plugin(LocalFileSystem, { cwd: ws })
  await ctx.plugin(ToolFs)
}

beforeEach(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), 'dsh-read-scope-ws-')))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-read-scope-out-')))
  await writeFile(join(ws, 'a.txt'), 'inside\n')
  await writeFile(join(ws, '.env'), 'DEEPSEEK_API_KEY=sk-test\n')
  await writeFile(join(outside, 'secret.txt'), 'outside\n')
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(ws, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('sandbox read fence', () => {
  it('reads inside the scope and refuses outside paths and hidden files', async () => {
    await mount(true)
    expect(text(await call('read', { file_path: 'a.txt' }))).toContain('inside')
    for (const path of [join(outside, 'secret.txt'), join(outside, 'absent.txt'), '.env', '../x/secret.txt']) {
      const result = await call('read', { file_path: path })
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'FS_SANDBOX_DENIED' } })
      expect(text(result)).toContain('the sandbox hides this path from this session')
      expect(text(result)).not.toContain('sk-test')
    }
  })

  it('refuses edits and overwrites that would present hidden content', async () => {
    await mount(true)
    const edit = await call('edit', { file_path: join(outside, 'secret.txt'), old_string: 'outside', new_string: 'changed' })
    expect(edit.error).toMatchObject({ info: { code: 'FS_SANDBOX_DENIED' } })
    const write = await call('write', { file_path: '.env', content: 'X=1\n' })
    expect(write.error).toMatchObject({ info: { code: 'FS_SANDBOX_DENIED' } })
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside\n')
    expect(await readFile(join(ws, '.env'), 'utf8')).toBe('DEEPSEEK_API_KEY=sk-test\n')
  })

  it('leaves reads unconfined without a confining provider or under danger-full-access', async () => {
    await mount(false)
    expect(text(await call('read', { file_path: join(outside, 'secret.txt') }))).toContain('outside')
    await ctx.fiber.dispose()
    await mount(true, 'danger-full-access')
    expect(text(await call('read', { file_path: '.env' }))).toContain('sk-test')
  })
})
