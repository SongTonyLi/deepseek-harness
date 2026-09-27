/** `Ctrl+B` background handoff over the real tool runtime, job registry, and completion notices. */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { JobId, type JobOutcome } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import ToolRuntime, { defineTool, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { movedResultText } from '../src/background.ts'
import { KEY, bench, type Bench } from './bench.ts'

function typeLine(terminal: { type(data: string): void }, text: string): void {
  for (const char of text) terminal.type(char)
  terminal.type(KEY.enter)
}

/** Mount the tool runtime, the local job registry, and the model-facing job tools with their completion notices. */
async function composeJobs(ctx: Context): Promise<void> {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs)
}

/** One call of a tool that runs until the spec settles it or its signal aborts. */
interface HeldCall {
  /** The signal the body received. */
  signal: AbortSignal
  /** Settle the body with this text. */
  finish(text: string): void
  /** Fail the body with this error. */
  fail(error: Error): void
}

/**
 * Register a tool whose calls wait on the spec, and optionally register a
 * job of their own first, as a shell tool registers its process.
 * @param ctx - the bench context.
 * @param name - the tool name.
 * @param ownJob - register a `bash` job labelled with the command and write `output` to it.
 * @returns the calls in start order.
 */
function heldTool(ctx: Context, name: 'slow' | 'bash', ownJob?: { output: string }): HeldCall[] {
  const calls: HeldCall[] = []
  ctx.tools.register(defineTool({
    name,
    description: `Held tool ${name}.`,
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    presentCall: args => ({ card: 'generic', title: `run ${args.command}` }),
    execute: (args, exec) => new Promise<string>((resolve, reject) => {
      const owner = exec.agent?.id
      // Like the shell tools, the body stops and drops its own job when its call is aborted.
      let stopOwnJob = (): void => {}
      if (ownJob !== undefined) {
        const settled = Promise.withResolvers<JobOutcome>()
        const id = ctx.jobs.start({
          kind: 'bash',
          label: args.command,
          ...owner === undefined ? {} : { owner },
          run: (job) => {
            job.append(ownJob.output, { channel: 'stdout' })
            return { cancel: () => { settled.resolve({ status: 'killed' }) }, done: settled.promise }
          },
        })
        stopOwnJob = () => {
          ctx.jobs.kill(id, owner)
          void ctx.jobs.wait(id, 1000, owner).then(() => { ctx.jobs.remove(id, owner) })
        }
      }
      exec.signal.addEventListener('abort', () => {
        stopOwnJob()
        reject(new Error('aborted'))
      }, { once: true })
      calls.push({ signal: exec.signal, finish: resolve, fail: reject })
    }),
  }))
  return calls
}

/**
 * Dispatch one root call for the bound Agent, as the loop does.
 * @param test - the bench.
 * @param name - the tool to call.
 * @param command - the call's one argument.
 * @param turn - the running turn's signal.
 * @returns the call's outcome.
 */
function dispatch(test: Bench, name: string, command: string, turn: AbortSignal): Promise<ToolExecutionResult> {
  return test.ctx.tools.execute({ callId: ToolCallId(`call-${command}`), name, arguments: { command }, agent: test.agent, signal: turn })
}

function textOf(content: readonly ContentBlock[]): string {
  return content.map(block => block.type === 'text' ? block.text : '').join('')
}

/** Let queued microtasks and the throttled renderer run. */
async function flush(test: Bench): Promise<void> {
  await test.settle()
}

/**
 * The current frame with the transient line taken down: a key the editor
 * takes, here `Right` on an empty input, disarms it.
 * @param test - the bench.
 * @returns the complete current frame.
 */
async function screenBelowToast(test: Bench): Promise<string> {
  test.terminal.type(KEY.right)
  return test.screen()
}

describe('TuiApp Ctrl+B background handoff', () => {
  it('names Ctrl+B while a call runs, answers the call with its job, and notifies the Agent when the body finishes', async () => {
    const test = await bench({ running: true, before: composeJobs })
    const held = heldTool(test.ctx, 'slow')
    const outcome = dispatch(test, 'slow', 'build', new AbortController().signal)
    await flush(test)
    expect(held).toHaveLength(1)
    // Another session's job is not this session's background work.
    const child = await test.createChild()
    test.ctx.jobs.start({ kind: 'bash', label: 'elsewhere', owner: child.id, run: () => ({ cancel() {}, done: new Promise(() => {}) }) })
    expect(await test.screen()).toContain('Ctrl+B background')

    test.terminal.type(KEY.ctrlB)
    const result = await outcome
    expect(result.isError).toBe(true)
    expect(textOf(result.content)).toBe(movedResultText(JobId('tool-1')))
    await flush(test)
    expect(test.terminal.text()).toContain('◇ slow moved to the background as tool-1 · /jobs lists it')
    const screen = await screenBelowToast(test)
    expect(screen).toContain('◇ 1 in background · tool-1 slow 0s · /jobs')
    expect(screen).not.toContain('Ctrl+B background')
    expect(screen).not.toContain('elsewhere')
    expect(held[0]?.signal.aborted).toBe(false)
    // The registry stamps jobs with the process clock; the live line measures against the app's.
    test.setNow(test.ctx.jobs.get(JobId('tool-1'), test.agent.id).startedAt + 65_000)
    test.tick(0)
    expect(await test.screen()).toContain('◇ 1 in background · tool-1 slow 1m05s · /jobs')

    held[0]?.finish('built ok')
    await flush(test)
    expect(test.calls.injections.map(message => textOf(message.content))).toEqual([
      'background job tool-1 (tool: slow) finished [status: completed]. Read its output with job_output.',
    ])
    expect(test.terminal.text()).toContain('◇ tool-1 completed · slow · agent notified')
    expect(test.ctx.jobs.read(JobId('tool-1'), test.agent.id).result).toBe('built ok')
    expect(await test.screen()).not.toContain('in background')
  })

  it('draws a logged moved result as a background card, live or replayed', async () => {
    const test = await bench()
    test.appendToolCall('call-9', 'slow', { command: 'deploy' })
    test.appendToolResult('call-9', [{ type: 'text', text: movedResultText(JobId('tool-4')) }], true)
    const screen = await test.screen()
    expect(screen).toContain('◇ moved to the background as tool-4 · /jobs lists it')
    expect(screen).not.toContain('The user moved this call')
  })

  it('lists jobs in /jobs, shows one job\'s output, and stops the highlighted one with Ctrl+K', async () => {
    const test = await bench({ running: true, before: composeJobs })
    const held = heldTool(test.ctx, 'bash', { output: 'compiling 3 files\n' })
    const outcome = dispatch(test, 'bash', 'make all', new AbortController().signal)
    await flush(test)
    // The call's own process job is foreground work while the call waits on it.
    expect(await test.screen()).not.toContain('in background')

    test.terminal.type(KEY.ctrlB)
    await outcome
    await flush(test)
    expect(await screenBelowToast(test)).toContain('◇ 1 in background · tool-1 bash 0s · /jobs')

    typeLine(test.terminal, '/jobs')
    await flush(test)
    let screen = await test.screen()
    expect(screen).toContain('Background jobs')
    expect(screen).toContain('Enter shows the output · Ctrl+K stops the highlighted job')
    expect(screen).toContain('running · 0s · bash')
    test.terminal.type(KEY.enter)
    await flush(test)
    screen = await test.screen()
    expect(screen).toContain('Job tool-1')
    expect(screen).toContain('compiling 3 files')

    test.terminal.type(KEY.escape)
    await flush(test)
    test.terminal.type(KEY.ctrlK)
    await flush(test)
    expect(held[0]?.signal.aborted).toBe(true)
    expect(test.terminal.text()).toContain('◇ tool-1 killed · bash')
    expect(test.ctx.jobs.get(JobId('tool-1'), test.agent.id)).toMatchObject({ status: 'killed', detail: 'stopped by the user' })
    expect(await screenBelowToast(test)).not.toContain('in background')
    expect(test.calls.injections.map(message => textOf(message.content))).toEqual([
      'background job tool-1 (tool: bash) finished [status: killed, stopped by the user]. Read its output with job_output.',
    ])
    test.terminal.type(KEY.ctrlK)
    await flush(test)
    expect(test.terminal.text()).toContain('tool-1 already finished')
    test.terminal.type(KEY.escape)
    await flush(test)
    expect(await test.screen()).not.toContain('Background jobs')
  })

  it('labels a moved call\'s job with its card headline', async () => {
    const test = await bench({ running: true, before: composeJobs })
    heldTool(test.ctx, 'slow')
    test.appendToolCall('call-deploy', 'slow', { command: 'deploy' })
    const outcome = dispatch(test, 'slow', 'deploy', new AbortController().signal)
    await flush(test)
    test.terminal.type(KEY.ctrlB)
    await outcome
    expect(test.ctx.jobs.get(JobId('tool-1'), test.agent.id).label).toBe('slow run deploy')
  })

  it('stops a moved call with its turn without waking the Agent', async () => {
    const turn = new AbortController()
    const test = await bench({ running: true, before: composeJobs, onCancel: () => { turn.abort() } })
    const held = heldTool(test.ctx, 'slow')
    const outcome = dispatch(test, 'slow', 'watch', turn.signal)
    await flush(test)
    test.terminal.type(KEY.ctrlB)
    await outcome
    // A call the user left in the foreground stops with the turn as every call does.
    const foreground = dispatch(test, 'slow', 'lint', turn.signal)
    await flush(test)

    test.terminal.type(KEY.escape)
    test.terminal.type(KEY.escape)
    await flush(test)
    expect((await foreground).isError).toBe(true)
    expect(held.map(call => call.signal.aborted)).toEqual([true, true])
    expect(test.terminal.text()).toContain('stopping the turn… 1 background call(s) from this turn stop with it')
    expect(test.ctx.jobs.get(JobId('tool-1'), test.agent.id)).toMatchObject({ status: 'killed', detail: 'stopped with the turn that called it' })
    expect(test.calls.injections).toEqual([])
  })

  it('leaves Ctrl+B to the editor outside a turn and says when a turn runs no call', async () => {
    const test = await bench({ before: composeJobs })
    test.terminal.type('ab')
    test.terminal.type(KEY.ctrlB)
    test.terminal.type('X')
    await flush(test)
    expect(await test.screen()).toContain('aXb')

    // A docked region keeps the key to itself outside a turn.
    test.terminal.type(KEY.shiftDown)
    test.terminal.type(KEY.ctrlB)
    test.terminal.type(KEY.escape)
    await flush(test)
    expect(await test.screen()).toContain('aXb')

    test.setStatus('running')
    test.terminal.type(KEY.ctrlB)
    await flush(test)
    expect(test.terminal.text()).toContain('no tool call is running · Ctrl+B moves a running call to the background')
  })

  it('says a composition without a job registry cannot move calls, and stops a turn as before', async () => {
    const test = await bench({ running: true })
    test.terminal.type(KEY.ctrlB)
    typeLine(test.terminal, '/jobs')
    await flush(test)
    expect(test.terminal.text()).toContain('background jobs need a job registry in this composition')
    test.terminal.type(KEY.escape)
    test.terminal.type(KEY.escape)
    await flush(test)
    expect(test.calls.cancels).toBe(1)
    expect(test.terminal.text()).toContain('stopping the turn…')
    expect(test.terminal.text()).not.toContain('background call(s)')
  })

  it('says when this session has no background job to list', async () => {
    const test = await bench({ before: composeJobs })
    typeLine(test.terminal, '/jobs')
    await flush(test)
    expect(test.terminal.text()).toContain('no background jobs in this session · Ctrl+B moves a running tool call here')
  })

  it('leaves a call running in the foreground when the registry refuses its job', async () => {
    const test = await bench({
      running: true,
      // No job tools: no controller serves the owner, so the registry refuses to start its jobs.
      before: async (ctx) => {
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRuntime)
        await ctx.plugin(LocalJobRegistry)
      },
    })
    const held = heldTool(test.ctx, 'slow')
    const outcome = dispatch(test, 'slow', 'index', new AbortController().signal)
    await flush(test)
    test.terminal.type(KEY.ctrlB)
    await flush(test)
    expect(test.terminal.text()).toContain('could not move slow: background jobs unavailable: no job controller serves this agent')
    held[0]?.finish('indexed')
    expect(textOf((await outcome).content)).toBe('indexed')
  })

  it('reports a moved call that failed, and one that finished without output', async () => {
    const test = await bench({ running: true, before: composeJobs })
    const failing = heldTool(test.ctx, 'slow')
    const first = dispatch(test, 'slow', 'fetch', new AbortController().signal)
    const second = dispatch(test, 'slow', 'touch', new AbortController().signal)
    await flush(test)
    test.terminal.type(KEY.ctrlB)
    await Promise.all([first, second])
    await flush(test)
    expect(test.terminal.text()).toContain('◇ 2 calls moved to the background · /jobs lists them')

    failing[0]?.fail(new Error('network down\n  at fetch'))
    failing[1]?.finish('')
    await flush(test)
    expect(test.ctx.jobs.get(JobId('tool-1'), test.agent.id)).toMatchObject({ status: 'failed', detail: 'network down' })
    expect(test.ctx.jobs.read(JobId('tool-1'), test.agent.id).result).toBe('Error: network down\n  at fetch')
    expect(test.ctx.jobs.get(JobId('tool-2'), test.agent.id).status).toBe('completed')
    expect(test.ctx.jobs.read(JobId('tool-2'), test.agent.id).result).toBeUndefined()
  })

  it('fails a moved call\'s job when a later around-dispatch wrapper rejects', async () => {
    const test = await bench({ running: true, before: composeJobs })
    heldTool(test.ctx, 'slow')
    const gate = Promise.withResolvers<undefined>()
    test.ctx.on('tools/execute', async () => {
      await gate.promise
      throw new Error('wrapper broke')
    })
    const outcome = dispatch(test, 'slow', 'sync', new AbortController().signal)
    await flush(test)
    test.terminal.type(KEY.ctrlB)
    await outcome
    gate.resolve(undefined)
    await flush(test)
    expect(test.ctx.jobs.get(JobId('tool-1'), test.agent.id)).toMatchObject({ status: 'failed', detail: 'wrapper broke' })
  })
})
