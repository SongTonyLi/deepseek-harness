/** The sandbox read fence on every `str_replace_editor` command. */

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
import * as ToolStrReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'
import { WorkspaceReadSandbox } from '../../../sandbox/sandbox/tests/read-scope-sandbox.ts'

let ws: string
let outside: string
let ctx: Context
let calls = 0

function call(args: Record<string, unknown>) {
  return ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`call-${++calls}`), name: 'str_replace_editor', arguments: args })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

beforeEach(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), 'dsh-editor-scope-ws-')))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'dsh-editor-scope-out-')))
  await writeFile(join(ws, 'a.txt'), 'inside\n')
  await writeFile(join(ws, '.env'), 'DEEPSEEK_API_KEY=sk-test\n')
  await writeFile(join(outside, 'secret.txt'), 'outside\n')
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: ws })
  await ctx.plugin(WorkspaceReadSandbox)
  await ctx.plugin(LocalFileSystem, { cwd: ws })
  await ctx.plugin(ToolStrReplaceEditor)
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(ws, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('str_replace_editor read fence', () => {
  it('views inside the scope', async () => {
    expect(text(await call({ command: 'view', path: join(ws, 'a.txt') }))).toContain('inside')
  })

  it('refuses every command on outside paths and hidden files', async () => {
    const attempts = [
      { command: 'view', path: join(outside, 'secret.txt') },
      { command: 'view', path: outside },
      { command: 'view', path: join(ws, '.env') },
      { command: 'str_replace', path: join(ws, '.env'), old_str: 'sk-test', new_str: 'x' },
      { command: 'insert', path: join(outside, 'secret.txt'), insert_line: 0, new_str: 'x' },
      { command: 'create', path: join(outside, 'new.txt'), file_text: 'x' },
    ]
    for (const args of attempts) {
      const result = await call(args)
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('the sandbox hides this path from this session')
    }
    expect(await readFile(join(ws, '.env'), 'utf8')).toBe('DEEPSEEK_API_KEY=sk-test\n')
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside\n')
  })
})
