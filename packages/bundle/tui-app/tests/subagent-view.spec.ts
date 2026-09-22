/** Entering a subagent session as a live view: the host's failures, overlapping switches, and releasing views. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEY, bench, type Bench } from './bench.ts'

/** A listed subagent whose Agent is not resident, so viewing it resumes it through the host. */
const SETTLED = [{
  kind: 'child',
  id: 'session-done',
  activity: 'inactive',
  mode: 'one-shot',
  hasChildren: false,
  parentId: 'session-tui-test',
  depth: 1,
  label: 'finished',
}]

/**
 * Type one line into the input and send it.
 * @param test - the running bench.
 * @param line - the line.
 */
async function send(test: Bench, line: string): Promise<void> {
  for (const char of line) test.terminal.type(char)
  test.terminal.type(KEY.enter)
  await test.settle()
}

/**
 * Pick the first `/subagents` row.
 * @param test - the running bench.
 */
async function enterFirst(test: Bench): Promise<void> {
  await send(test, '/subagents')
  test.terminal.type(KEY.enter)
  await test.settle()
}

let dir: string

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dsh-subagent-view-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('the subagent view', () => {
  it('reports a view the host cannot open and stays on the parent', async () => {
    const test = await bench({ subagents: () => Promise.resolve(SETTLED as never), hostFailure: 'no such session' })
    await enterFirst(test)
    const screen = await test.screen()
    expect(screen).toContain('opening subagent session-done failed: no such session')
    expect(screen).not.toContain('subagent view')
  })

  it('refuses a second view while one opens, and releases a view that opens after quitting', async () => {
    const gate = { release: () => {} }
    const test = await bench({ subagents: () => Promise.resolve(SETTLED as never), hostGate: gate })
    await enterFirst(test)
    await enterFirst(test)
    expect(await test.screen()).toContain('wait for the session switch to finish')
    test.terminal.type(KEY.ctrlD)
    await test.settle()
    gate.release()
    await test.settle()
    expect(test.opened.find(entry => entry.bound.agent.session.id === 'session-done')?.disposed).toBe(1)
  })

  it('refuses to return while a switch opens, reports a failed return, and a failed release', async () => {
    const options: Parameters<typeof bench>[0] & object = { subagents: () => Promise.resolve(SETTLED as never) }
    const test = await bench(options)
    await enterFirst(test)
    expect(await test.screen()).toContain('subagent finished')

    options.hostFailure = 'log unreadable'
    test.terminal.type('\u0010')
    await test.settle()
    expect(await test.screen()).toContain('returning to session session-tui-test failed: log unreadable')
    delete options.hostFailure

    options.disposeFailure = 'still busy'
    test.terminal.type('\u0010')
    await test.settle()
    const back = await test.screen()
    expect(back).toContain('back in session session-tui-test')
    expect(back).toContain('releasing the subagent view failed: still busy')
  })

  it('refuses to return while a session switch is still opening', async () => {
    const gate = { release: () => {} }
    const options: Parameters<typeof bench>[0] & object = { subagents: () => Promise.resolve(SETTLED as never) }
    const test = await bench(options)
    await enterFirst(test)
    options.hostGate = gate
    await send(test, '/new')
    test.terminal.type('\u0010')
    await test.settle()
    expect(await test.screen()).toContain('wait for the session switch to finish')
    gate.release()
    await test.settle()
    expect(await test.screen()).toContain('new session: session session-opened-1')
  })

  it('keeps pending attachments with the parent and releases every view on quit, reporting a failed release', async () => {
    const options: Parameters<typeof bench>[0] & object = {
      subagents: () => Promise.resolve(SETTLED as never),
      before: (ctx) => { ctx.provide('attachments', { saveFile: () => Promise.resolve({ kind: 'file', id: 'file' }) } as never) },
    }
    const test = await bench(options)
    await writeFile(join(dir, 'a.txt'), 'a')
    await send(test, `/attach ${join(dir, 'a.txt')}`)
    await enterFirst(test)
    expect(await test.screen()).toContain('1 pending attachment(s) stayed with the parent session')
    options.disposeFailure = 'still busy'
    test.terminal.type(KEY.ctrlD)
    await test.settle()
    expect(test.quits.map(bound => bound.agent.session.id)).toEqual(['session-tui-test'])
    expect(test.terminal.text()).toContain('releasing a subagent view failed: still busy')
  })
})
