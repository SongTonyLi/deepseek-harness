/** The terminal application over a scripted Agent: rendering, keys, commands, and the two interaction seams. */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { KEY, bench } from './bench.ts'

function typeLine(terminal: { type(data: string): void }, text: string): void {
  for (const char of text) terminal.type(char)
  terminal.type(KEY.enter)
}

describe('TuiApp', () => {
  it('draws the header, footer, and a submitted prompt, and hands the prompt to the idle Agent', async () => {
    const test = await bench()
    await test.settle()
    expect(test.terminal.started).toBe(true)
    expect(test.terminal.title).toBe('dsh · /work')
    const screen = test.terminal.text()
    expect(screen).toContain('session session-tui-test')
    expect(screen).toContain('test-provider/test-model')
    expect(screen).toContain('/work')

    typeLine(test.terminal, 'hello there')
    await test.settle()
    expect(test.calls.followups.map(message => message.content)).toEqual([[{ type: 'text', text: 'hello there' }]])
    expect(test.terminal.text()).toContain('› hello there')
    // The durable echo of that same message is not drawn twice.
    const [submitted] = test.calls.followups
    test.session.append('turn/start', { turn: 1 })
    test.session.append('user/message', submitted!, { surfaceOp: 'append' })
    await test.settle()
    expect(test.terminal.text().split('› hello there')).toHaveLength(2)
  })

  it('ignores blank input and steers a running Agent instead of queueing a turn', async () => {
    const test = await bench()
    test.terminal.type(KEY.enter)
    test.terminal.type(' ')
    test.terminal.type(KEY.enter)
    expect(test.calls.followups).toHaveLength(0)
    test.setStatus('running')
    typeLine(test.terminal, 'also do this')
    await test.settle()
    expect(test.calls.steers).toHaveLength(1)
    expect(test.terminal.text()).toContain('queued for the next step')
    expect(test.terminal.text()).toContain('thinking')
    test.setStatus('idle')
    test.setStatus('idle')
    await test.settle()
  })

  it('streams reasoning and text, then replaces them with the committed message and its usage', async () => {
    const test = await bench()
    test.stream.start()
    test.stream.chunk({ type: 'text-delta', index: 0, text: '' })
    test.stream.chunk({ type: 'reasoning-delta', index: 0, text: '' })
    test.stream.chunk({ type: 'reasoning-delta', index: 0, text: 'let me think' })
    test.stream.chunk({ type: 'text-delta', index: 1, text: 'Hello ' })
    test.stream.chunk({ type: 'text-delta', index: 1, text: '**world**' })
    test.stream.chunk({ type: 'tool-call-delta', index: 2, id: 'call-1' as never, name: 'bash', argumentsDelta: '{' })
    test.stream.chunk({ type: 'tool-call-delta', index: 2, id: 'call-1' as never, argumentsDelta: '}' })
    test.stream.chunk({ type: 'block-start', index: 3, blockType: 'text' })
    test.stream.chunk({ type: 'block-end', index: 3, block: { type: 'text', text: '' } })
    test.stream.chunk({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } })
    test.stream.chunk({ type: 'finish', reason: { kind: 'stop' } })
    await test.settle()
    expect(test.terminal.text()).toContain('let me think')
    expect(test.terminal.text()).toContain('Hello world')
    test.appendAssistant(
      [{ type: 'reasoning', text: 'final thought' }, { type: 'text', text: 'Hello **there**' }],
      { usage: { inputTokens: 1200, outputTokens: 34 } },
    )
    test.stream.end({ kind: 'committed', eventType: 'assistant/message', seq: test.session.seq as never })
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('final thought')
    expect(screen).toContain('Hello there')
    expect(screen).toContain('↑1.2k ↓34 ctx 1.2k')
  })

  it('drops an abandoned attempt that streamed nothing and keeps one that did', async () => {
    const test = await bench()
    test.stream.start()
    test.stream.end({ kind: 'abandoned' })
    await test.settle()
    test.stream.start()
    test.stream.chunk({ type: 'text-delta', index: 0, text: 'partial' })
    test.stream.end({ kind: 'abandoned' })
    await test.settle()
    expect(test.terminal.text()).toContain('partial')
    // A committed message with no streamed frames still renders.
    test.appendAssistant([{ type: 'text', text: 'direct' }], { interrupted: true })
    await test.settle()
    expect(test.terminal.text()).toContain('direct')
    expect(test.terminal.text()).toContain('[interrupted]')
  })

  it('renders tool cards from presenters, folds their bodies, and toggles them with Ctrl+O', async () => {
    const test = await bench({
      toolPreviewLines: 2,
      before: async (ctx) => {
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRuntime)
        ctx.tools.register({
          name: 'bash',
          description: 'run',
          parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: () => Promise.resolve('unused'),
          presentCall: args => ({ card: 'terminal', title: (args as { command: string }).command, cwd: '/work' }),
          presentResult: (_args, result) => ({ card: 'terminal', output: result.content.map(block => block.type === 'text' ? block.text : '').join(''), exitCode: result.isError ? 2 : 0 }),
        })
        ctx.tools.register({
          name: 'broken',
          description: 'throws in its presenters',
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: () => Promise.resolve('unused'),
          presentCall: () => { throw new Error('bad call presenter') },
          presentResult: () => { throw new Error('bad result presenter') },
        })
      },
    })
    test.appendToolCall('call-1', 'bash', { command: 'ls -la' })
    await test.settle()
    expect(test.terminal.text()).toContain('bash ls -la')
    expect(test.terminal.text()).toContain('cwd: /work')
    test.appendToolResult('call-1', [{ type: 'text', text: 'a\nb\nc\nd\n' }], true, { extra: 1 })
    await test.settle()
    expect(test.terminal.text()).toContain('… 4 more lines (Ctrl+O expands)')
    expect(test.terminal.text()).not.toContain('exit 2')
    test.terminal.type(KEY.ctrlO)
    await test.settle()
    expect(test.terminal.text()).toContain('exit 2')
    typeLine(test.terminal, '/tools')
    await test.settle()
    // A presenter that throws falls back to the raw arguments and result text.
    test.appendToolCall('call-2', 'broken', { x: 1 })
    test.appendToolResult('call-2', [{ type: 'text', text: 'raw result' }])
    // A result for an unknown call is ignored.
    test.appendToolResult('call-9', [{ type: 'text', text: 'orphan' }])
    // A tool with no definition renders its raw arguments and raw result.
    test.appendToolCall('call-3', 'mystery', { path: 'x' })
    test.appendToolResult('call-3', [{ type: 'text', text: 'mystery output' }])
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('broken')
    expect(screen).toContain('{"x":1}')
    expect(screen).toContain('raw result')
    expect(screen).toContain('mystery')
    expect(screen).toContain('{"path":"x"}')
    expect(screen).toContain('mystery output')
    expect(screen).not.toContain('orphan')
  })

  it('draws resumed history, notices, and turn-end reasons', async () => {
    const history = [
      { type: 'user/message', seq: 0, time: 1, data: createUserMessage({ content: [{ type: 'text', text: 'earlier prompt' }], source: { kind: 'user' } }) },
      { type: 'user/message', seq: 1, time: 1, data: createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'skill', form: 'notice', summary: 'skill loaded' } }) },
      { type: 'user/message', seq: 2, time: 1, data: createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'agent-instructions', form: 'instructions' } }) },
      { type: 'turn/end', seq: 3, time: 1, data: { turn: 1, reason: { kind: 'error', error: { code: 'E_TEST', message: 'boom' } } } },
      { type: 'turn/end', seq: 4, time: 1, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
      { type: 'step/start', seq: 5, time: 1, data: { turn: 3, step: 1 } },
      { type: 'user/message', seq: 6, time: 1, data: createUserMessage({ content: [{ type: 'text', text: 'tool text' }], source: { kind: 'tool', callId: 'c' as never } }) },
    ] as never[]
    const test = await bench({ history })
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('› earlier prompt')
    expect(screen).toContain('· skill loaded')
    expect(screen).not.toContain('agent-instructions')
    expect(screen).toContain('turn failed: E_TEST: boom')
    expect(screen).toContain('turn stopped')
    expect(screen).not.toContain('tool text')
    // Events of another session are ignored.
    const other = test.ctx.sessions.create('session-other' as Agent['id'])
    other.append('turn/start', { turn: 1 })
    other.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
    await test.settle()
    expect(test.terminal.text()).not.toContain('turn blocked')
  })

  it('stops the running turn on Escape, clears on Ctrl+C, and quits on a double Ctrl+C or Ctrl+D', async () => {
    const test = await bench()
    test.terminal.type(KEY.escape)
    expect(test.calls.cancels).toBe(0)
    test.setStatus('running')
    test.terminal.type(KEY.escape)
    expect(test.calls.cancels).toBe(1)
    await test.settle()
    expect(test.terminal.text()).toContain('stopping the turn')
    test.terminal.type('d')
    test.terminal.type('r')
    test.terminal.type('a')
    test.terminal.type('f')
    test.terminal.type('t')
    test.terminal.type(KEY.ctrlD)
    expect(test.quits).toEqual([])
    test.terminal.type(KEY.ctrlC)
    await test.settle()
    expect(test.terminal.text()).toContain('press Ctrl+C again to quit')
    test.terminal.type(KEY.ctrlD)
    expect(test.quits).toHaveLength(1)
    expect(test.terminal.stopped).toBe(true)
    // Further stops are no-ops.
    test.app.stop()
    expect(test.quits).toHaveLength(1)
  })

  it('quits on a second Ctrl+C inside the double-press window', async () => {
    const test = await bench()
    test.terminal.type(KEY.ctrlC)
    test.terminal.type(KEY.ctrlC)
    expect(test.quits).toHaveLength(1)
  })

  it('answers /help, /quit, /model, and unknown commands locally', async () => {
    const test = await bench({
      before: async (ctx) => {
        await ctx.plugin(CommandRuntime)
        ctx.commands.register({
          name: 'echo',
          description: 'echo the input',
          handler: invocation => ({ kind: 'success', text: `echoed ${invocation.rawInput.trim()}` }),
        })
        ctx.commands.register({
          name: 'fail',
          description: 'fail',
          handler: () => ({ kind: 'error', text: 'nope' }),
        })
        ctx.commands.register({
          name: 'silent',
          description: 'no text',
          handler: () => ({ kind: 'success' }),
        })
        ctx.commands.register({
          name: 'throws',
          description: 'throws',
          handler: () => { throw new Error('handler exploded') },
        })
        ctx.commands.register({
          name: 'odd',
          description: 'rejects with a non-error',
          // oxlint-disable-next-line prefer-promise-reject-errors -- the surface must render any rejection
          handler: () => Promise.reject('plain reason'),
        })
      },
    })
    typeLine(test.terminal, '/help')
    await test.settle()
    expect(test.terminal.text()).toContain('/echo')
    expect(test.terminal.text()).toContain('Esc stops the running turn')
    typeLine(test.terminal, '/echo one two')
    typeLine(test.terminal, '/fail')
    typeLine(test.terminal, '/silent')
    typeLine(test.terminal, '/throws')
    typeLine(test.terminal, '/odd')
    typeLine(test.terminal, '/nosuch')
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('/echo: echoed one two')
    expect(screen).toContain('/fail: nope')
    expect(screen).toContain('/silent done')
    expect(screen).toContain('/throws failed: handler exploded')
    expect(screen).toContain('/odd failed: command handler rejected with a non-Error value: plain reason')
    expect(screen).toContain('unknown command /nosuch')
    typeLine(test.terminal, '/model broken')
    await test.settle()
    expect(test.terminal.text()).toContain('usage: /model <provider>/<model>')
    typeLine(test.terminal, '/model other/big')
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'other', model: 'big' })
    expect(test.terminal.text()).toContain('other/big')
    typeLine(test.terminal, '/exit')
    expect(test.quits).toHaveLength(1)
  })

  it('reports unknown commands when no registry is composed', async () => {
    const test = await bench()
    typeLine(test.terminal, '/nosuch')
    typeLine(test.terminal, '/help')
    await test.settle()
    expect(test.terminal.text()).toContain('unknown command /nosuch')
    expect(test.terminal.text()).toContain('/tools')
  })

  it('answers approvals through a prompt and withdraws them on abort', async () => {
    const test = await bench()
    const ask = (signal?: AbortSignal): Promise<ApprovalOutcome> => test.ctx.waterfall(
      'approval/request',
      { agent: test.agent, toolName: 'bash', reason: 'writes outside the workspace', ...signal === undefined ? {} : { signal } },
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    const first = ask()
    await test.settle()
    expect(test.terminal.text()).toContain('Allow bash?')
    expect(test.terminal.text()).toContain('writes outside the workspace')
    test.terminal.type(KEY.enter)
    await expect(first).resolves.toBe('allowed-once')
    const bare = test.ctx.waterfall('approval/request', { agent: test.agent, toolName: 'edit' }, () => Promise.resolve<ApprovalOutcome>('unavailable'))
    await test.settle()
    expect(test.terminal.text()).toContain('Allow edit?')
    test.terminal.type(KEY.enter)
    await expect(bare).resolves.toBe('allowed-once')
    const again = ask()
    await test.settle()
    test.terminal.type(KEY.enter)
    await expect(again).resolves.toBe('allowed-once')
    await test.settle()
    expect(test.terminal.text()).toContain('bash: allowed once')

    const second = ask()
    await test.settle()
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await expect(second).resolves.toBe('rejected')

    const third = ask()
    await test.settle()
    test.terminal.type(KEY.escape)
    await expect(third).resolves.toBe('rejected')

    const controller = new AbortController()
    const fourth = ask(controller.signal)
    await test.settle()
    controller.abort()
    await expect(fourth).resolves.toBe('cancelled')

    const aborted = new AbortController()
    aborted.abort()
    await expect(ask(aborted.signal)).resolves.toBe('cancelled')

    const fifth = ask()
    await test.settle()
    test.terminal.type(KEY.ctrlC)
    await expect(fifth).resolves.toBe('cancelled')

    // Another agent's request passes through untouched.
    const other = { id: 'session-other' } as Agent
    await expect(test.ctx.waterfall('approval/request', { agent: other, toolName: 'bash' }, () => Promise.resolve<ApprovalOutcome>('unavailable')))
      .resolves.toBe('unavailable')
  })

  it('answers user questions with options, multi-select, and free text', async () => {
    const test = await bench()
    const ask = (questions: unknown[], signal?: AbortSignal): Promise<AskUserQuestionAnswer> => test.ctx.waterfall(
      'user-questions/request',
      { agent: test.agent, questions: questions as never, ...signal === undefined ? {} : { signal } },
      () => Promise.reject(new Error('no answerer')),
    )
    const single = ask([{ id: 'q1', header: 'Setup', question: 'Which color?', detail: 'Pick one', options: [{ label: 'red', description: 'warm' }, { label: 'blue' }] }])
    await test.settle()
    expect(test.terminal.text()).toContain('Which color?')
    expect(test.terminal.text()).toContain('Pick one')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await expect(single).resolves.toEqual({ answers: [{ id: 'q1', selected: ['blue'] }] })

    const multi = ask([{ id: 'q2', question: 'Which sizes?', multiSelect: true, options: [{ label: 's' }, { label: 'm' }, { label: 'l' }] }])
    await test.settle()
    test.terminal.type(KEY.space)
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    test.terminal.type(KEY.space)
    test.terminal.type(KEY.space)
    await test.settle()
    expect(test.terminal.text()).toContain('selected: s')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await expect(multi).resolves.toEqual({ answers: [{ id: 'q2', selected: ['s', 'm'] }] })

    const custom = ask([{ id: 'q3', question: 'Name?', options: [{ label: 'a' }] }])
    await test.settle()
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    // An empty free-text answer is ignored; Escape returns to the options.
    test.terminal.type(KEY.enter)
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.terminal.text()).toContain('Type an answer')
    test.terminal.type(KEY.enter)
    test.terminal.type('z')
    test.terminal.type('q')
    test.terminal.type(KEY.enter)
    await expect(custom).resolves.toEqual({ answers: [{ id: 'q3', selected: [], custom: 'zq' }] })

    const free = ask([{ id: 'q4', question: 'Anything?' }])
    await test.settle()
    test.terminal.type('o')
    test.terminal.type('k')
    test.terminal.type(KEY.enter)
    await expect(free).resolves.toEqual({ answers: [{ id: 'q4', selected: [], custom: 'ok' }] })

    const dismissedFree = ask([{ id: 'q5', question: 'Anything?' }])
    await test.settle()
    expect(test.terminal.text()).toContain('Esc back to the options')
    test.terminal.type(KEY.escape)
    test.terminal.type(KEY.escape)
    await expect(dismissedFree).rejects.toThrow('dismissed')

    const dismissed = ask([{ id: 'q6', question: 'Pick', options: [{ label: 'a' }] }])
    await test.settle()
    test.terminal.type(KEY.escape)
    await expect(dismissed).rejects.toThrow('dismissed')

    const controller = new AbortController()
    const withdrawn = ask([{ id: 'q7', question: 'Pick', options: [{ label: 'a' }] }], controller.signal)
    await test.settle()
    controller.abort()
    await expect(withdrawn).rejects.toThrow('dismissed')

    const other = { id: 'session-other' } as Agent
    await expect(test.ctx.waterfall('user-questions/request', { agent: other, questions: [] }, () => Promise.reject(new Error('no answerer'))))
      .rejects.toThrow('no answerer')
  })

  it('submits an initial prompt and keeps the loader when the Agent is already running', async () => {
    const test = await bench({ initialPrompt: 'first task', color: true, running: true })
    await test.settle()
    expect(test.calls.steers).toHaveLength(1)
    expect(test.terminal.text()).toContain('› first task')
    expect(test.terminal.text()).toContain('thinking')
    test.setStatus('running')
    test.terminal.resize(60)
    await test.settle()
  })

  it('ignores frames and status of other Agents', async () => {
    const test = await bench()
    const other = { id: 'session-other' } as Agent
    test.agent.ctx.emit('agent/assistant-stream', { agent: other, frame: { type: 'start', attemptId: 'x' as never, revision: 1, turn: 1, step: 1 } })
    test.agent.ctx.emit('agent/status', { agent: other, status: 'running' })
    await test.settle()
    expect(test.terminal.text()).not.toContain('thinking')
  })

  it('falls back to the logged request header and then the Agent options for the footer model', async () => {
    const unselected = await bench({ unselected: true })
    await unselected.settle()
    expect(unselected.terminal.text()).toContain('default/default')
    unselected.session.append('turn/start', { turn: 1 })
    unselected.session.append('step/start', { turn: 1, step: 1 })
    unselected.session.append('request/header', { header: { config: { provider: 'logged', model: 'header-model' } }, reason: 'initial' })
    unselected.appendAssistant([{ type: 'text', text: 'x' }], { usage: { inputTokens: 1, outputTokens: 1 } })
    await unselected.settle()
    expect(unselected.terminal.text()).toContain('logged/header-model')
  })

  it('completes slash commands from the editor', async () => {
    const test = await bench()
    test.terminal.type('/')
    await test.settle()
    expect(test.terminal.text()).toContain('/model')
    for (const char of 'qui') test.terminal.type(char)
    await test.settle()
    test.terminal.type(KEY.enter)
    await test.settle()
    // Completion keeps `/quit` in the editor; Enter then submits it.
    test.terminal.type(KEY.enter)
    expect(test.quits).toHaveLength(1)
  })

  it('picks a model from the composed providers', async () => {
    const test = await bench({
      before: (ctx) => {
        ctx.provide('llm', {
          listProviders: () => [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }, { id: 'p3', name: 'Three' }],
          listModels: (provider: string) => {
            if (provider === 'p3') return Promise.reject(new Error('offline'))
            return Promise.resolve(provider === 'p1'
              ? [{ provider, id: 'a', name: 'A', description: 'first' }]
              : [{ provider, id: 'b', name: 'B' }])
          },
        } as never)
      },
    })
    typeLine(test.terminal, '/model')
    await test.settle()
    const screen = test.terminal.text()
    expect(screen).toContain('p3: offline')
    expect(screen).toContain('p1/a')
    expect(screen).toContain('p2/b')
    test.terminal.type(KEY.down)
    test.terminal.type(KEY.enter)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'p2', model: 'b' })
    typeLine(test.terminal, '/model')
    await test.settle()
    test.terminal.type(KEY.escape)
    await test.settle()
    expect(test.selection.current).toEqual({ provider: 'p2', model: 'b' })
  })

  it('reports when no provider offers a model', async () => {
    const test = await bench()
    typeLine(test.terminal, '/model')
    await test.settle()
    expect(test.terminal.text()).toContain('no models are available')
    typeLine(test.terminal, '/help')
    typeLine(test.terminal, '/quit')
    expect(test.quits).toHaveLength(1)
  })
})
