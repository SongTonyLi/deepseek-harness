/** Which calls the background wrapper tracks, which jobs it counts as a call's own, and the result text it writes and reads. */

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId, type JobEvent, type JobRegistry, type JobSpec, type JobView } from '@deepseek-ai/dsh-jobs'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ToolBackgrounder, movedJobId, movedResultText, resultText } from '../src/background.ts'

/** Stand-ins for the Agent and registry identities the wrapper compares; it calls nothing on them here. */
const agentA: Agent = { id: SessionId('session-a') } as never
const registry: JobRegistry = {} as never

/** One call's settlement and the outcome `around` returned. */
interface Tracked {
  finish(): void
  outcome: Promise<ToolExecutionResult>
}

/** Numbers every dispatched call, so two calls of one tool keep distinct ids. */
let dispatched = 0

const done: ToolExecutionResult = { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] }

/**
 * Dispatch one call through the wrapper with a body the spec settles.
 * @param backgrounder - the wrapper under test.
 * @param fields - the call's name, arguments, Agent, and parent token.
 * @returns the settle function and the outcome.
 */
function track(backgrounder: ToolBackgrounder, fields: { name: string; arguments: unknown; agent?: Agent; parent?: string }): Tracked {
  const body = Promise.withResolvers<ToolExecutionResult>()
  const exec: ToolDispatchExecution = {
    callId: ToolCallId(`call-${String(++dispatched)}`),
    name: fields.name,
    arguments: fields.arguments,
    signal: new AbortController().signal,
    ...fields.agent === undefined ? {} : { agent: fields.agent },
    ...fields.parent === undefined ? {} : { parent: fields.parent },
  } as never
  return { finish: () => { body.resolve(done) }, outcome: backgrounder.around(exec, () => body.promise) }
}

function textOf(content: readonly ContentBlock[]): string {
  return content.map(block => block.type === 'text' ? block.text : '').join('')
}

function registered(fields: { id: string; kind: string; label: string; owner?: string }, type: 'registered' | 'removed' = 'registered'): JobEvent {
  const job: JobView = {
    id: JobId(fields.id),
    kind: fields.kind,
    label: fields.label,
    ...fields.owner === undefined ? {} : { owner: SessionId(fields.owner) },
    status: 'running',
    startedAt: 0,
    output: { total: 0, earliest: 0 },
  }
  return { type, job }
}

describe('ToolBackgrounder tracking', () => {
  it('tracks root calls of an Agent while a registry is composed, and passes every other call through', async () => {
    let changes = 0
    let jobs: JobRegistry | undefined = registry
    const backgrounder = new ToolBackgrounder({ jobs: () => jobs, changed: () => { changes += 1 } })
    const unowned = track(backgrounder, { name: 'read', arguments: {} })
    const nested = track(backgrounder, { name: 'read', arguments: {}, agent: agentA, parent: 'token-1' })
    jobs = undefined
    const bare = track(backgrounder, { name: 'read', arguments: {}, agent: agentA })
    expect(backgrounder.running(agentA)).toEqual([])
    jobs = registry
    const root = track(backgrounder, { name: 'bash', arguments: { command: 'ls' }, agent: agentA })
    expect(backgrounder.running(agentA).map(call => call.name)).toEqual(['bash'])
    for (const call of [unowned, nested, bare, root]) call.finish()
    expect(await Promise.all([unowned, nested, bare, root].map(call => call.outcome))).toEqual([done, done, done, done])
    expect(backgrounder.running(agentA)).toEqual([])
    expect(changes).toBe(2)
  })

  it('counts a job as a call\'s own only for the same owner and kind, and the call\'s command when it has one', async () => {
    const backgrounder = new ToolBackgrounder({ jobs: () => registry, changed: () => {} })
    const shell = track(backgrounder, { name: 'bash', arguments: { command: 'make' }, agent: agentA })
    const other = track(backgrounder, { name: 'pwsh', arguments: { command: 7 }, agent: agentA })
    backgrounder.observe({ type: 'output', id: JobId('bash-9'), total: 3 })
    backgrounder.observe(registered({ id: 'bash-1', kind: 'bash', label: 'make', owner: 'session-b' }))
    backgrounder.observe(registered({ id: 'bash-2', kind: 'bash', label: 'make' }))
    backgrounder.observe(registered({ id: 'bash-3', kind: 'bash', label: 'make test', owner: 'session-a' }))
    backgrounder.observe(registered({ id: 'tool-1', kind: 'tool', label: 'bash make', owner: 'session-a' }))
    expect(['bash-1', 'bash-2', 'bash-3', 'tool-1'].map(id => backgrounder.isInner(JobId(id)))).toEqual([false, false, false, false])
    backgrounder.observe(registered({ id: 'bash-4', kind: 'bash', label: 'make', owner: 'session-a' }))
    backgrounder.observe(registered({ id: 'bash-5', kind: 'bash', label: 'make', owner: 'session-a' }))
    // A call whose command is not a string takes its own-kind job whatever the label.
    backgrounder.observe(registered({ id: 'pwsh-1', kind: 'pwsh', label: 'Get-Item', owner: 'session-a' }))
    expect(['bash-4', 'bash-5', 'pwsh-1'].map(id => backgrounder.isInner(JobId(id)))).toEqual([true, false, true])
    shell.finish()
    other.finish()
    await Promise.all([shell.outcome, other.outcome])
    expect(backgrounder.isInner(JobId('bash-4'))).toBe(false)
    expect(backgrounder.outputOf(JobId('tool-1'))).toBe('tool-1')
  })

  it('reads a call without arguments or with a non-object argument value as having no command', async () => {
    const backgrounder = new ToolBackgrounder({ jobs: () => registry, changed: () => {} })
    const none = track(backgrounder, { name: 'bash', arguments: null, agent: agentA })
    backgrounder.observe(registered({ id: 'bash-1', kind: 'bash', label: 'anything', owner: 'session-a' }))
    const scalar = track(backgrounder, { name: 'bash', arguments: 'ls', agent: agentA })
    backgrounder.observe(registered({ id: 'bash-2', kind: 'bash', label: 'anything', owner: 'session-a' }))
    expect([backgrounder.isInner(JobId('bash-1')), backgrounder.isInner(JobId('bash-2'))]).toEqual([true, true])
    none.finish()
    scalar.finish()
    await Promise.all([none.outcome, scalar.outcome])
  })
})

describe('ToolBackgrounder moving', () => {
  it('reads a moved call\'s output from the job its body registers after the move, until that job leaves', async () => {
    const started: JobSpec[] = []
    // Only `start` is called here: the registry runs the starter and issues the id.
    const jobs: JobRegistry = {
      start: (spec: JobSpec) => {
        started.push(spec)
        spec.run({ id: JobId('tool-1'), append() {}, updateProgress() {} })
        return JobId('tool-1')
      },
    } as never
    const backgrounder = new ToolBackgrounder({ jobs: () => jobs, changed: () => {} })
    const call = track(backgrounder, { name: 'bash', arguments: { command: 'make' }, agent: agentA })
    const report = backgrounder.moveAll(jobs, agentA, moved => `${moved.name} make`)
    expect(report.moved.map(moved => moved.id)).toEqual(['tool-1'])
    expect(started.map(spec => [spec.kind, spec.label, spec.owner])).toEqual([['tool', 'bash make', 'session-a']])
    expect(textOf((await call.outcome).content)).toBe(movedResultText(JobId('tool-1')))

    backgrounder.observe(registered({ id: 'bash-1', kind: 'bash', label: 'make', owner: 'session-a' }))
    expect(backgrounder.outputOf(JobId('tool-1'))).toBe('bash-1')
    backgrounder.observe(registered({ id: 'bash-1', kind: 'bash', label: 'make', owner: 'session-a' }, 'removed'))
    expect(backgrounder.outputOf(JobId('tool-1'))).toBe('tool-1')
    call.finish()
  })
})

/** An image block; the text helpers read only its `type`. */
const image: ContentBlock = { type: 'image' } as never

describe('moved-call result text', () => {
  it('names the job and reads it back, and reads nothing from any other result', () => {
    const moved: ContentBlock[] = [{ type: 'text', text: movedResultText(JobId('tool-12')) }]
    expect(movedJobId(moved)).toBe('tool-12')
    expect(movedJobId([])).toBeUndefined()
    expect(movedJobId([{ type: 'text', text: 'Error: boom' }])).toBeUndefined()
    expect(movedJobId([...moved, { type: 'text', text: 'more' }])).toBeUndefined()
    expect(movedJobId([image])).toBeUndefined()
  })

  it('carries text blocks as they are and names every other block', () => {
    expect(resultText([{ type: 'text', text: 'a' }, image])).toBe('a\n[image omitted]')
  })
})
