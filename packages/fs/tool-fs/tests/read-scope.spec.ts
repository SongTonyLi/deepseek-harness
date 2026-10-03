/**
 * The sandbox read fence on `read`, `edit`, and `write`: under a provider that
 * confines reads, hidden secret files are refused before anything observes
 * them, `read` asks the user before reading any other path outside the read
 * scope, and without a confining provider reads are unconfined.
 */

import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { WorkspaceReadSandbox } from '../../../sandbox/sandbox/tests/read-scope-sandbox.ts'

let ws: string
let outside: string
let ctx: Context
let calls = 0

function call(name: string, args: unknown, agent?: object) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++calls}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent: agent as never },
  })
}

/** A fake mid-turn agent in the workspace whose session records appended events. */
function readingAgent(): { agent: object; events: Array<{ type: string; data: Record<string, unknown> }> } {
  const id = SessionId('sess-read-scope')
  const events: Array<{ type: string; seq: ReturnType<typeof SessionSeq>; time: number; data: Record<string, unknown> }> = [
    { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
  ]
  const session = {
    id,
    header: { version: 0, id, createdAt: 0, cwd: ws, isSeeded: false },
    inheritedEventCount: SessionLogOffset(0),
    firstLiveSeq: SessionLogOffset(0),
    get seq() { return SessionLogOffset(events.length) },
    eventAt: (seq: ReturnType<typeof SessionSeq>) => events[seq],
    snapshotEvents: (from = SessionLogOffset(0), to = SessionLogOffset(events.length)) => events.slice(from, to),
    append: (type: string, data: Record<string, unknown>) => {
      const event = { type, seq: SessionSeq(events.length), time: events.length, data }
      events.push(event)
      return event
    },
  }
  return { agent: { id, session }, events }
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function mount(confining: boolean, mode: 'workspace-write' | 'danger-full-access' = 'workspace-write', approval = false): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: ws })
  if (confining) await ctx.plugin(WorkspaceReadSandbox)
  if (approval) await ctx.plugin(ApprovalService)
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

  describe('reading outside the workspace', () => {
    type Asked = { toolName: string; reason?: string; displayReason?: { en: string } }

    async function mountAnswering(outcome: ApprovalOutcome): Promise<Asked[]> {
      await mount(true, 'workspace-write', true)
      const asked: Asked[] = []
      ctx.on('approval/request', (req) => {
        asked.push(req)
        return Promise.resolve(outcome)
      })
      return asked
    }

    it('reads an outside file once after the user allows it, without widening later reads', async () => {
      const asked = await mountAnswering('allowed-once')
      const { agent, events } = readingAgent()
      const path = join(outside, 'secret.txt')
      expect(text(await call('read', { file_path: path }, agent))).toContain('outside')
      expect(asked.map(req => [req.toolName, req.reason, req.displayReason?.en])).toEqual([[
        'read',
        `read outside the sandbox read scope: ${path}`,
        `Allow reading this file outside the session workspace once: ${path}`,
      ]])
      expect(events.map(event => event.type)).toEqual(['turn/start', 'approval/asked', 'approval/decided'])
      await call('read', { file_path: path }, agent)
      expect(asked).toHaveLength(2)
    })

    it('makes no filesystem call on an outside path the user rejects', async () => {
      await mountAnswering('rejected')
      const resolve = vi.spyOn(ctx.fs, 'resolve')
      const stat = vi.spyOn(ctx.fs, 'stat')
      for (const path of [join(outside, 'secret.txt'), join(outside, 'absent.txt'), '../elsewhere.txt', 'sub/../../elsewhere.txt']) {
        const result = await call('read', { file_path: path }, readingAgent().agent)
        expect(result.error).toMatchObject({ info: { code: 'FS_SANDBOX_DENIED' } })
        expect(text(result)).toContain('the user declined access to this path outside the session workspace')
        expect(text(result)).not.toContain('outside\n')
      }
      expect(resolve).not.toHaveBeenCalled()
      expect(stat).not.toHaveBeenCalled()
    })

    it.each([
      ['cancelled', 'approval to read this path outside the session workspace was cancelled'],
      ['unavailable', 'no user approval is available to read it'],
    ] as const)('fails closed when approval is %s', async (outcome, message) => {
      await mountAnswering(outcome)
      const result = await call('read', { file_path: join(outside, 'secret.txt') }, readingAgent().agent)
      expect(result.error).toMatchObject({ info: { code: 'FS_SANDBOX_DENIED' } })
      expect(text(result)).toContain(message)
    })

    it('asks after resolution when a workspace symlink leads outside', async () => {
      const asked = await mountAnswering('rejected')
      await symlink(join(outside, 'secret.txt'), join(ws, 'link.txt'))
      const result = await call('read', { file_path: 'link.txt' }, readingAgent().agent)
      expect(text(result)).toContain('the user declined access')
      expect(asked).toEqual([expect.objectContaining({ reason: `read outside the sandbox read scope: ${join(outside, 'secret.txt')}` })])
    })

    it('refuses hidden files outside the workspace without asking, even through a symlink', async () => {
      const asked = await mountAnswering('allowed-once')
      await writeFile(join(outside, '.env'), 'TOKEN=outside-secret\n')
      await symlink(join(outside, '.env'), join(outside, 'innocent.txt'))
      const direct = await call('read', { file_path: join(outside, '.env') }, readingAgent().agent)
      expect(text(direct)).toContain('the sandbox hides this path from this session')
      expect(asked).toEqual([])
      const linked = await call('read', { file_path: join(outside, 'innocent.txt') }, readingAgent().agent)
      expect(text(linked)).toContain('the sandbox hides this path from this session')
      expect(text(linked)).not.toContain('outside-secret')
    })
  })
})
