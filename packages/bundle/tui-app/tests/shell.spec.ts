/** User-typed `!` / `!!` shell lines: local run, transcript echo, next-step reference. */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecRequest, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { KEY, bench } from './bench.ts'

function typeLine(terminal: { type(data: string): void }, text: string): void {
  for (const char of text) terminal.type(char)
  terminal.type(KEY.enter)
}

/** A resolved foreground result with only the fields a spec cares about filled. */
function runResult(overrides: {
  exitCode?: number | null
  stdout?: string
  stderr?: string
  aborted?: boolean
  timedOut?: boolean
  timeoutMs?: number
  signal?: NodeJS.Signals | null
  stdoutTruncated?: boolean
  stdoutSpill?: string
} = {}): ShellRunResult {
  return {
    exitCode: overrides.exitCode === undefined ? 0 : overrides.exitCode,
    signal: overrides.signal ?? null,
    timedOut: overrides.timedOut ?? false,
    aborted: overrides.aborted ?? false,
    timeoutMs: overrides.timeoutMs ?? 30_000,
    stdout: {
      text: overrides.stdout ?? '',
      truncated: overrides.stdoutTruncated ?? false,
      ...overrides.stdoutSpill === undefined ? {} : { spillPath: overrides.stdoutSpill },
    },
    stderr: { text: overrides.stderr ?? '', truncated: false },
  }
}

/**
 * Mount a scripted `ctx.shell` that records each resolve and answers the
 * execution's `result()`.
 * @param ctx - the bench context.
 * @param run - the scripted result, or a function of the request.
 * @returns the recorded resolve requests.
 */
function provideShell(
  ctx: Context,
  run: ShellRunResult | ((request: ShellExecRequest) => Promise<ShellRunResult> | ShellRunResult),
): ShellExecRequest[] {
  const requests: ShellExecRequest[] = []
  ctx.provide('shell', {
    resolve: (request: ShellExecRequest) => {
      requests.push(request)
      return request
    },
    execute: (spec: ShellExecRequest) => ({
      result: async () => typeof run === 'function' ? run(spec) : run,
    }),
  } as never)
  return requests
}

describe('TuiApp user shell lines', () => {
  it('runs !command locally, draws it, and injects the result as next-step context', async () => {
    let requests: ShellExecRequest[] = []
    const test = await bench({
      before(ctx) {
        requests = provideShell(ctx, runResult({ stdout: 'hi\n' }))
      },
    })
    typeLine(test.terminal, '!echo hi')
    await test.settle()
    expect(test.calls.followups).toHaveLength(0)
    expect(test.calls.steers).toHaveLength(0)
    expect(requests).toEqual([expect.objectContaining({
      command: 'echo hi',
      workdir: '/work',
      sandboxPolicy: expect.objectContaining({ mode: 'danger-full-access', workspaceRoot: '/work' }),
    })])
    expect(test.calls.injections).toHaveLength(1)
    const [notice] = test.calls.injections
    expect(notice?.content).toEqual([{
      type: 'text',
      text: 'The user ran `echo hi` in the terminal.\n```\nhi\n```',
    }])
    expect(notice?.source).toEqual({
      kind: 'tui-app',
      form: 'notice',
      summary: '! echo hi',
    })
    expect(test.terminal.text()).toContain('$ echo hi')
    expect(test.terminal.text()).toContain('hi')
    expect(test.terminal.text()).not.toContain('› !echo hi')
    expect(test.terminal.text()).not.toContain('QUEUE')
  })

  it('runs !!command without injecting it into the next request', async () => {
    const test = await bench({
      before(ctx) {
        provideShell(ctx, runResult({ stdout: 'secret\n' }))
      },
    })
    typeLine(test.terminal, '!!echo secret')
    await test.settle()
    expect(test.calls.followups).toHaveLength(0)
    expect(test.calls.injections).toHaveLength(0)
    expect(test.agent.inbox.nextStep).toHaveLength(0)
    expect(test.terminal.text()).toContain('$ echo secret')
    expect(test.terminal.text()).toContain('secret')
  })

  it('sends a lone ! as an ordinary prompt', async () => {
    const test = await bench({
      before(ctx) {
        provideShell(ctx, () => {
          throw new Error('lone ! must not run the shell')
        })
      },
    })
    typeLine(test.terminal, '!')
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: '!' }]])
    expect(test.calls.injections).toHaveLength(0)
  })

  it('rejects ! when no shell executor is composed', async () => {
    const test = await bench()
    typeLine(test.terminal, '!echo hi')
    await test.settle()
    expect(test.calls.followups).toHaveLength(0)
    expect(test.calls.injections).toHaveLength(0)
    expect(test.terminal.text()).toContain('! needs a shell executor in this composition')
  })

  it('puts a second !! back in the editor while one command is running', async () => {
    const test = await bench({
      before(ctx) {
        provideShell(ctx, request => new Promise((resolve) => {
          request.signal?.addEventListener('abort', () => {
            resolve(runResult({ aborted: true, exitCode: null }))
          })
        }))
      },
    })
    typeLine(test.terminal, '!sleep 10')
    await test.settle()
    typeLine(test.terminal, '!!echo later')
    await test.settle()
    expect(test.terminal.text()).toContain('A shell command is already running. Press Esc to cancel it first.')
    expect(test.terminal.text()).toContain('!!echo later')
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.calls.injections).toHaveLength(1)
  })

  it('refuses a second ! while one is running and Esc cancels the first', async () => {
    const test = await bench({
      before(ctx) {
        provideShell(ctx, request => new Promise((resolve) => {
          request.signal?.addEventListener('abort', () => {
            resolve(runResult({ aborted: true, exitCode: null }))
          })
        }))
      },
    })
    typeLine(test.terminal, '!sleep 10')
    await test.settle()
    typeLine(test.terminal, '!echo later')
    await test.settle()
    expect(test.terminal.text()).toContain('A shell command is already running. Press Esc to cancel it first.')
    expect(test.calls.injections).toHaveLength(0)
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.calls.injections).toHaveLength(1)
    expect(test.calls.injections[0]?.content).toEqual([{
      type: 'text',
      text: 'The user ran `sleep 10` in the terminal.\n(no output)\n\n(command cancelled)',
    }])
    expect(test.terminal.text()).toContain('(command cancelled)')
  })

  it('clears a leading ! draft on Esc when the Agent is idle', async () => {
    const test = await bench({
      before(ctx) {
        provideShell(ctx, () => {
          throw new Error('Esc must not run the draft')
        })
      },
    })
    for (const char of '!pwd') test.terminal.type(char)
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    typeLine(test.terminal, 'hello')
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'hello' }]])
    expect(test.calls.injections).toHaveLength(0)
  })

  it('surfaces a thrown shell run as a notice without injecting', async () => {
    const test = await bench({
      before(ctx) {
        provideShell(ctx, () => {
          throw new Error('boom')
        })
      },
    })
    typeLine(test.terminal, '!echo hi')
    await test.settle()
    expect(test.calls.injections).toHaveLength(0)
    expect(test.terminal.text()).toContain('! failed: boom')
  })

  it('does not inject a finished ! after /new drops the run', async () => {
    const test = await bench({
      before(ctx) {
        provideShell(ctx, request => new Promise((resolve) => {
          request.signal?.addEventListener('abort', () => {
            resolve(runResult({ aborted: true, exitCode: null }))
          })
        }))
      },
    })
    typeLine(test.terminal, '!sleep 10')
    await test.settle()
    typeLine(test.terminal, '/new')
    await test.settle()
    expect(test.hostCalls).toEqual(['create'])
    expect(test.calls.injections).toHaveLength(0)
    expect(test.terminal.text()).not.toContain('$ sleep 10')
    expect(test.terminal.text()).not.toContain('! failed')
  })

  it('swallows a thrown ! after /new drops the run', async () => {
    const test = await bench({
      before(ctx) {
        provideShell(ctx, request => new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(new Error('killed'))
          })
        }))
      },
    })
    typeLine(test.terminal, '!sleep 10')
    await test.settle()
    typeLine(test.terminal, '/new')
    await test.settle()
    expect(test.calls.injections).toHaveLength(0)
    expect(test.terminal.text()).not.toContain('! failed')
  })

  it('does not inject a finished ! after quit drops the run', async () => {
    const test = await bench({
      before(ctx) {
        provideShell(ctx, request => new Promise((resolve) => {
          request.signal?.addEventListener('abort', () => {
            resolve(runResult({ aborted: true, exitCode: null }))
          })
        }))
      },
    })
    typeLine(test.terminal, '!sleep 10')
    await test.settle()
    test.terminal.type(KEY.ctrlC)
    test.terminal.type(KEY.ctrlC)
    await test.settle()
    expect(test.quits).toHaveLength(1)
    expect(test.calls.injections).toHaveLength(0)
  })

  it('sends a queued-prompt revision that starts with ! as a followup', async () => {
    const test = await bench({
      running: true,
      before(ctx) {
        provideShell(ctx, () => {
          throw new Error('a queued revision must not run the shell')
        })
      },
    })
    const edit = createUserMessage({ content: [{ type: 'text', text: '!echo hi' }], source: { kind: 'user' } })
    test.agent.inbox.append('next-turn', edit)
    test.agent.ctx.emit('agent/inbox/inserted', { agent: test.agent, message: edit })
    test.terminal.type(KEY.shiftUp)
    test.terminal.type('e')
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.calls.followups.at(-1)?.content).toEqual([{ type: 'text', text: '!echo hi' }])
    expect(test.calls.injections).toHaveLength(0)
  })

  it('skips the later user/message echo of a shell notice it already drew', async () => {
    const test = await bench({
      before(ctx) {
        provideShell(ctx, runResult({ stdout: 'hi\n' }))
      },
    })
    typeLine(test.terminal, '!echo hi')
    await test.settle()
    const [notice] = test.calls.injections
    test.session.append('turn/start', { turn: 1 })
    test.session.append('user/message', notice!, { surfaceOp: 'append' })
    await test.settle()
    expect(test.terminal.text().split('$ echo hi')).toHaveLength(2)
    expect(test.terminal.text()).not.toContain('notice · ! echo hi')
  })
})

describe('parseUserShellLine', () => {
  it('treats only a nonempty ! or !! prefix as a shell line', async () => {
    const { parseUserShellLine } = await import('../src/shell-line.ts')
    expect(parseUserShellLine('!echo hi')).toEqual({ command: 'echo hi', excluded: false })
    expect(parseUserShellLine('!!echo secret')).toEqual({ command: 'echo secret', excluded: true })
    expect(parseUserShellLine('!')).toBeUndefined()
    expect(parseUserShellLine('!!')).toBeUndefined()
    expect(parseUserShellLine('hello !there')).toBeUndefined()
    expect(parseUserShellLine('  !ls  ')).toEqual({ command: 'ls', excluded: false })
  })
})

describe('parseUserShellDraft', () => {
  it('keeps the exact columns after a leading ! or !!', async () => {
    const { parseUserShellDraft } = await import('../src/shell-line.ts')
    expect(parseUserShellDraft('!echo hi')).toEqual({ indent: '', bang: '!', command: 'echo hi' })
    expect(parseUserShellDraft('!!echo secret')).toEqual({ indent: '', bang: '!!', command: 'echo secret' })
    expect(parseUserShellDraft('  ! ls')).toEqual({ indent: '  ', bang: '!', command: ' ls' })
    expect(parseUserShellDraft('\n!echo')).toEqual({ indent: '\n', bang: '!', command: 'echo' })
    expect(parseUserShellDraft('!')).toEqual({ indent: '', bang: '!', command: '' })
    expect(parseUserShellDraft('!!')).toEqual({ indent: '', bang: '!!', command: '' })
    expect(parseUserShellDraft('hello !there')).toBeUndefined()
    expect(parseUserShellDraft('')).toBeUndefined()
  })
})

describe('user shell presentation', () => {
  it('formats the model-facing notice and transcript rows for each outcome', async () => {
    const { userShellContextText, userShellTranscriptRows } = await import('../src/shell-line.ts')
    expect(userShellContextText('echo hi', runResult({ stdout: 'hi\n' }))).toBe(
      'The user ran `echo hi` in the terminal.\n```\nhi\n```',
    )
    expect(userShellContextText('true', runResult())).toBe(
      'The user ran `true` in the terminal.\n(no output)',
    )
    expect(userShellContextText('sleep 10', runResult({ aborted: true, exitCode: null }))).toBe(
      'The user ran `sleep 10` in the terminal.\n(no output)\n\n(command cancelled)',
    )
    expect(userShellContextText('slow', runResult({ timedOut: true, exitCode: null, timeoutMs: 5_000 }))).toBe(
      'The user ran `slow` in the terminal.\n(no output)\n\n[timed out after 5000ms]',
    )
    expect(userShellContextText('die', runResult({ signal: 'SIGKILL', exitCode: null }))).toBe(
      'The user ran `die` in the terminal.\n(no output)\n\n[killed by signal: SIGKILL]',
    )
    expect(userShellContextText('false', runResult({ exitCode: 2 }))).toBe(
      'The user ran `false` in the terminal.\n(no output)\n\nCommand exited with code 2',
    )
    expect(userShellContextText('mix', runResult({ stdout: 'out\n', stderr: 'err\n' }))).toBe(
      'The user ran `mix` in the terminal.\n```\nout\n[stderr]\nerr\n```',
    )
    expect(userShellContextText('err', runResult({ stderr: 'nope\n' }))).toBe(
      'The user ran `err` in the terminal.\n```\n[stderr]\nnope\n```',
    )
    expect(userShellContextText('big', runResult({
      stdout: 'tail',
      stdoutTruncated: true,
      stdoutSpill: '/tmp/out',
    }))).toBe(
      'The user ran `big` in the terminal.\n```\ntail\n[output truncated; full output: /tmp/out]\n```',
    )
    expect(userShellContextText('lost', runResult({ stdout: 'tail', stdoutTruncated: true }))).toBe(
      'The user ran `lost` in the terminal.\n```\ntail\n[output truncated; full output: (unavailable)]\n```',
    )
    expect(userShellTranscriptRows('echo hi', runResult({ stdout: 'hi\n' }))).toEqual(['$ echo hi', 'hi'])
    expect(userShellTranscriptRows('true', runResult())).toEqual(['$ true'])
    expect(userShellTranscriptRows('sleep 10', runResult({ aborted: true, exitCode: null }))).toEqual([
      '$ sleep 10',
      '(command cancelled)',
    ])
    expect(userShellTranscriptRows('false', runResult({ exitCode: 2, stdout: 'nope\n' }))).toEqual([
      '$ false',
      'nope',
      '(exit 2)',
    ])
  })
})
