/**
 * Quitting the shipped tui profile while work runs, through the real `dsh`
 * launcher and a keyless mock model: what each quit stops, the stderr lines
 * and their order, the exit code and how long the exit took, that no process
 * the work started outlives the exit, and what the Session log records.
 *
 * Every command writes its own pids to files in the workspace, so liveness is
 * read with `process.kill(pid, 0)` and never from the process table, and
 * every recorded pid is killed when a scenario ends, whatever it asserted.
 * The commands are bash and the scenarios deliver POSIX signals, so the file
 * runs on POSIX hosts only.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gone, LiveTui, type Exit } from './live-tui.ts'

const ENTER = '\r'
const CTRL_C = '\u0003'
/** The footer's model id: the terminal has drawn and the editor takes keys. */
const READY = 'cli-mock/cli-mock'
/** The mock's final answer once its tool call returned. */
const ROUND_TRIP = 'CLI tool round trip complete'
const QUIT_TOAST = 'press Ctrl+C again to quit'
/** How long a command that ignores SIGTERM runs after it, before the shell tool's kill. */
const KILL_GRACE_MS = 3_000

/** Files one scenario's commands write. */
interface Files {
  /** The command's own pid. */
  readonly cmd: string
  /** The pid of the child the command waits on. */
  readonly child: string
  /** Written when the command receives SIGTERM. */
  readonly term: string
}

/** One launched scenario, disposed after each test. */
interface Scenario {
  readonly cwd: string
  readonly tui: LiveTui
  readonly files: Files
}

const scenarios: Scenario[] = []

afterEach(async () => {
  for (const scenario of scenarios.splice(0)) {
    await scenario.tui.dispose()
    await rm(scenario.cwd, { recursive: true, force: true })
  }
})

/**
 * Records its pid, then its child's, and exits 0 through a TERM trap that
 * writes the marker; the child sleeps in the command's process group, so the
 * group signal stops it as well.
 */
function trappingCommand(files: Files): string {
  return [
    `echo $$ > '${files.cmd}'`,
    `trap 'echo TERM > "${files.term}"; exit 0' TERM`,
    `sleep 120 & echo $! > '${files.child}'`,
    'wait',
  ].join('; ')
}

/**
 * Records its pid and its child's and notes SIGTERM in the marker without
 * exiting; the child ignores SIGTERM. Only the shell tool's SIGKILL after its
 * grace ends either of them.
 */
function survivingCommand(files: Files): string {
  return [
    `echo $$ > '${files.cmd}'`,
    `trap 'echo TERM >> "${files.term}"' TERM`,
    `(trap '' TERM; exec sleep 120) & echo $! > '${files.child}'`,
    'while kill -0 $! 2>/dev/null; do wait $!; done',
  ].join('; ')
}

/**
 * Exits through a TERM trap like {@link trappingCommand}, but its child is a
 * node process that starts `sleep` with `detached: true`, which puts the sleep
 * in a session and process group of its own, the way a test runner launches a
 * browser. The node process records the sleep's pid and keeps running.
 */
function escapingCommand(files: Files, escapee: string): string {
  const runner = 'const c=require("node:child_process").spawn("sleep",["120"],{detached:true,stdio:"ignore"});'
    + 'require("node:fs").writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},60000)'
  return [
    `echo $$ > '${files.cmd}'`,
    `trap 'echo TERM > "${files.term}"; exit 0' TERM`,
    `'${process.execPath}' -e '${runner}' '${escapee}' & echo $! > '${files.child}'`,
    'wait',
  ].join('; ')
}

/**
 * Launch the tui profile in a fresh workspace whose Session log is plain JSONL.
 * @param env - mock hooks and scenario environment.
 * @param tuiApp - `tui-app` config fields the scenario pins.
 * @param command - the shell command the mock runs, built from the workspace's files.
 * @returns the scenario, registered for disposal.
 */
async function launch(
  env: NodeJS.ProcessEnv,
  tuiApp: Readonly<Record<string, number>> = {},
  command?: (files: Files, cwd: string) => string,
): Promise<Scenario> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-quit-'))
  const files: Files = { cmd: join(cwd, 'cmd.pid'), child: join(cwd, 'child.pid'), term: join(cwd, 'term.marker') }
  const patch = join(cwd, 'quit.patch.yml')
  // A patch row replaces the row's whole config, so the log keeps the keyless patch's root.
  const rows = ['- id: session-persistence-jsonl', '  config:', "    root: './.sessions'", '    compression: none']
  // The bundle's own tui-app config carries the launch arguments, which no scenario passes.
  const tuiRows = Object.entries(tuiApp).map(([key, value]) => `    ${key}: ${String(value)}`)
  if (tuiRows.length > 0) rows.push('- id: tui-app', '  config:', ...tuiRows)
  await writeFile(patch, `${rows.join('\n')}\n`)
  const tui = new LiveTui(cwd, {
    patches: [patch],
    env: command === undefined ? env : { ...env, DSH_CLI_MOCK_SHELL_COMMAND: command(files, cwd) },
  })
  const scenario = { cwd, tui, files }
  scenarios.push(scenario)
  await tui.rendered(READY)
  return scenario
}

/**
 * Press Ctrl+C, wait for the line that arms the quit, and press it again.
 * @param tui - the running app.
 * @returns when the second press was sent.
 */
async function doubleCtrlC(tui: LiveTui): Promise<number> {
  const from = tui.written
  tui.send(CTRL_C)
  await tui.rendered(QUIT_TOAST, from)
  const at = Date.now()
  tui.send(CTRL_C)
  return at
}

/**
 * The line that names the saved session last.
 * @param id - the session id.
 * @returns the line.
 */
function resumeHint(id: string): string {
  return `dsh: session ${id} saved; resume with: dsh --profile tui --resume ${id}`
}

/**
 * The id of the tui's own session, read from the Session log rather than from
 * the resume hint, which an unsaved quit does not print.
 * @param cwd - the workspace.
 * @returns the id of the one top-level session the workspace's logs hold.
 */
async function rootSessionId(cwd: string): Promise<string> {
  const headers = await sessionHeaders(cwd)
  const roots = headers.filter(header => header.origin !== 'subagent')
  expect(roots, JSON.stringify(headers)).toHaveLength(1)
  return roots[0]!.id
}

/** The fields of a Session log header these scenarios read, with the log's path. */
interface Header {
  readonly id: string
  /** `subagent` for a delegated child's log. */
  readonly origin: string | undefined
  readonly file: string
}

/** The fields of one Session log record these scenarios read. */
interface LoggedEvent {
  readonly type: string
  readonly data?: {
    /** A `turn/end` reason: `{ kind: 'aborted', reason: { kind: 'user' } }` for a cancelled turn. */
    readonly reason?: { readonly kind?: string; readonly reason?: { readonly kind?: string } }
    /** A `job/settled` cause. */
    readonly cause?: string
  }
}

/**
 * Every Session log under the workspace's `.sessions` root.
 * @param cwd - the workspace.
 * @returns each log's header id and origin, with its path.
 */
async function sessionHeaders(cwd: string): Promise<Header[]> {
  const root = join(cwd, '.sessions')
  const names = existsSync(root) ? await readdir(root, { recursive: true }) : []
  const headers: Header[] = []
  for (const name of names.filter(entry => entry.endsWith('.jsonl'))) {
    const file = join(root, name)
    const first = (await readFile(file, 'utf8')).split('\n', 1)[0] ?? ''
    const header = JSON.parse(first) as { type?: string; id?: string; origin?: string }
    if (header.type === 'session' && header.id !== undefined) headers.push({ id: header.id, origin: header.origin, file })
  }
  return headers
}

/**
 * The records of one Session log.
 * @param cwd - the workspace.
 * @param id - the session id.
 * @returns its records after the header, in order.
 */
async function sessionEvents(cwd: string, id: string): Promise<LoggedEvent[]> {
  const header = (await sessionHeaders(cwd)).find(entry => entry.id === id)
  expect(header, `no Session log for ${id}`).toBeDefined()
  const lines = (await readFile(header!.file, 'utf8')).split('\n').filter(line => line !== '')
  return lines.slice(1).map(line => JSON.parse(line) as LoggedEvent)
}

/**
 * Whether a log ends its turn because the user cancelled it.
 * @param events - the log's records.
 * @returns true when a `turn/end` record carries an aborted reason caused by the user.
 */
function hasUserAbortedTurn(events: readonly LoggedEvent[]): boolean {
  return events.some(event => event.type === 'turn/end'
    && event.data?.reason?.kind === 'aborted' && event.data.reason.reason?.kind === 'user')
}

/**
 * Assert that none of the pids exists once the app exited.
 * @param pids - the pids by what they were.
 */
async function expectNoSurvivors(pids: Readonly<Record<string, number>>): Promise<void> {
  for (const [what, pid] of Object.entries(pids)) {
    expect.soft(await gone(pid), `${what} (pid ${String(pid)}) outlived the exit`).toBe(true)
  }
}

/**
 * Assert how the app exited.
 * @param exit - the observed exit.
 * @param code - the expected exit code.
 */
function expectExitCode(exit: Exit, code: number): void {
  expect.soft({ code: exit.code, signal: exit.signal }).toEqual({ code, signal: null })
}

describe.skipIf(process.platform === 'win32')('tui profile quit while work runs', () => {
  it('stops a foreground command through its TERM trap before it says the session is saved', async () => {
    const { cwd, tui, files } = await launch({}, {}, trappingCommand)
    tui.send(`go${ENTER}`)
    const pids = { command: await tui.pid(files.cmd), child: await tui.pid(files.child) }
    const quitAt = await doubleCtrlC(tui)
    const exit = await tui.waitExit()

    expectExitCode(exit, 0)
    // The trap ends the command at once, so the exit does not wait out the kill grace.
    expect.soft(exit.at - quitAt).toBeLessThan(KILL_GRACE_MS)
    const id = await rootSessionId(cwd)
    expect.soft(tui.dshLines()).toEqual(['dsh: stopping 1 command (Ctrl+C to force)', resumeHint(id)])
    expect.soft(existsSync(files.term), 'the command never received SIGTERM').toBe(true)
    await expectNoSurvivors(pids)
    expect.soft(hasUserAbortedTurn(await sessionEvents(cwd, id)), 'no turn/end aborted by the user').toBe(true)
  })

  it('stops a background job through owner teardown and logs its settlement', async () => {
    const { cwd, tui, files } = await launch({ DSH_CLI_MOCK_SHELL_BACKGROUND: '1' }, {}, trappingCommand)
    tui.send(`go${ENTER}`)
    const pids = { command: await tui.pid(files.cmd), child: await tui.pid(files.child) }
    // The call returned the job id, so the turn ended while the job runs on.
    await tui.rendered(ROUND_TRIP)
    await doubleCtrlC(tui)
    const exit = await tui.waitExit()

    expectExitCode(exit, 0)
    const id = await rootSessionId(cwd)
    expect.soft(tui.dshLines()).toEqual(['dsh: stopping 1 background job (Ctrl+C to force)', resumeHint(id)])
    expect.soft(existsSync(files.term), 'the job never received SIGTERM').toBe(true)
    await expectNoSurvivors(pids)
    const settled = (await sessionEvents(cwd, id)).filter(event => event.type === 'job/settled')
    expect.soft(settled.map(event => event.data?.cause)).toEqual(['teardown'])
  })

  it('stops a subagent and the command it runs, and names both', async () => {
    const { cwd, tui, files } = await launch({ DSH_CLI_MOCK_DELEGATE: '1' }, {}, trappingCommand)
    tui.send(`go${ENTER}`)
    const pids = { command: await tui.pid(files.cmd), child: await tui.pid(files.child) }
    // The parent's turn ends once the delegation started; the child's command runs on.
    await tui.rendered(ROUND_TRIP)
    await doubleCtrlC(tui)
    const exit = await tui.waitExit()

    expectExitCode(exit, 0)
    const id = await rootSessionId(cwd)
    expect.soft(tui.dshLines()).toEqual(['dsh: stopping 1 command, 1 subagent (Ctrl+C to force)', resumeHint(id)])
    expect.soft(existsSync(files.term), 'the subagent\'s command never received SIGTERM').toBe(true)
    await expectNoSurvivors(pids)
  })

  it('reports a command that ignores SIGTERM while it waits for the kill, then saves', async () => {
    const { cwd, tui, files } = await launch({}, {}, survivingCommand)
    tui.send(`go${ENTER}`)
    const pids = { command: await tui.pid(files.cmd), child: await tui.pid(files.child) }
    const quitAt = await doubleCtrlC(tui)
    const exit = await tui.waitExit()

    expectExitCode(exit, 0)
    // The shell tool kills the command when its grace runs out, well inside the quit budget.
    expect.soft(exit.at - quitAt).toBeGreaterThanOrEqual(KILL_GRACE_MS)
    expect.soft(exit.at - quitAt).toBeLessThan(9_000)
    const id = await rootSessionId(cwd)
    const lines = tui.dshLines()
    expect.soft(lines[0]).toBe('dsh: stopping 1 command (Ctrl+C to force)')
    expect.soft(lines.slice(1, -1).length, `no progress notice in ${JSON.stringify(lines)}`).toBeGreaterThanOrEqual(1)
    expect.soft(lines.slice(1, -1).every(line => line === 'dsh: still stopping 1 command (Ctrl+C to force)'), JSON.stringify(lines)).toBe(true)
    expect.soft(lines.at(-1)).toBe(resumeHint(id))
    expect.soft(existsSync(files.term), 'the command never received SIGTERM').toBe(true)
    await expectNoSurvivors(pids)
  })

  it('gives up waiting when the quit budget runs out, exits 1, and the launcher still kills the command', async () => {
    const { tui, files } = await launch({}, { quitGraceMs: 1_000 }, survivingCommand)
    tui.send(`go${ENTER}`)
    const pids = { command: await tui.pid(files.cmd), child: await tui.pid(files.child) }
    const quitAt = await doubleCtrlC(tui)
    const exit = await tui.waitExit()

    expectExitCode(exit, 1)
    // The budget, then the launcher's own bounded disposal.
    expect.soft(exit.at - quitAt).toBeLessThan(9_000)
    // The flush waits for the Agent to go idle, which the command holds past the budget, so nothing was saved.
    expect.soft(tui.dshLines()).toEqual([
      'dsh: stopping 1 command (Ctrl+C to force)',
      'dsh: gave up waiting after 1s; 1 command may still be running',
    ])
    await expectNoSurvivors(pids)
  })

  it('forces the exit on SIGINT while the stop is pending, and exits 130', async () => {
    const { tui, files } = await launch({}, {}, survivingCommand)
    tui.send(`go${ENTER}`)
    const pids = { command: await tui.pid(files.cmd), child: await tui.pid(files.child) }
    await doubleCtrlC(tui)
    // SIGTERM reached the command, so the stop is under way and the command still runs.
    await tui.until('the command to receive SIGTERM', () => existsSync(files.term))
    const forcedAt = Date.now()
    tui.signal('SIGINT')
    const exit = await tui.waitExit()

    expectExitCode(exit, 130)
    // The launcher's bounded disposal follows; the quit budget does not.
    expect.soft(exit.at - forcedAt).toBeLessThan(6_000)
    expect.soft(tui.dshLines()).toEqual([
      'dsh: stopping 1 command (Ctrl+C to force)',
      'dsh: forcing exit; 1 command may still be running',
    ])
    await expectNoSurvivors(pids)
  })

  it('stops the running command when the terminal hangs up, logs the aborted turn, and exits 129', async () => {
    const { cwd, tui, files } = await launch({}, {}, trappingCommand)
    tui.send(`go${ENTER}`)
    const pids = { command: await tui.pid(files.cmd), child: await tui.pid(files.child) }
    tui.signal('SIGHUP')
    const exit = await tui.waitExit()

    expectExitCode(exit, 129)
    expect.soft(existsSync(files.term), 'the command never received SIGTERM').toBe(true)
    await expectNoSurvivors(pids)
    expect.soft(hasUserAbortedTurn(await sessionEvents(cwd, await rootSessionId(cwd))), 'no turn/end aborted by the user').toBe(true)
  })

  it('quits on a second Ctrl+C while the quit line is up, and only then', async () => {
    // The line holds 3 s and fades over 2 steps of 16 ms, so it is gone 3032 ms after it went up.
    const lifetimeMs = 3_000 + 2 * 16
    const { cwd, tui } = await launch({}, { toastMs: 3_000, streamFadeSteps: 2, streamFadeStepMs: 16 })
    const first = tui.written
    tui.send(CTRL_C)
    await tui.rendered(QUIT_TOAST, first)
    // Time is the subject: the second press lands after the first line came down.
    await new Promise(resolve => setTimeout(resolve, lifetimeMs + 1_000))
    const second = tui.written
    tui.send(CTRL_C)
    await tui.rendered(QUIT_TOAST, second)
    expect(tui.exit, 'a press after the line came down quit').toBeUndefined()
    expect(tui.dshLines()).toEqual([])
    // A press one second into the line it put up quits.
    await new Promise(resolve => setTimeout(resolve, 1_000))
    tui.send(CTRL_C)
    const exit = await tui.waitExit(10_000)

    expectExitCode(exit, 0)
    expect.soft(tui.dshLines()).toEqual([resumeHint(await rootSessionId(cwd))])
  })

  it('stops a process the command moved into its own session along with the command', async () => {
    let escapee = ''
    const { tui, files } = await launch({}, {}, (commandFiles, cwd) => {
      escapee = join(cwd, 'escapee.pid')
      return escapingCommand(commandFiles, escapee)
    })
    tui.send(`go${ENTER}`)
    const pids = {
      command: await tui.pid(files.cmd),
      runner: await tui.pid(files.child),
      'detached sleep': await tui.pid(escapee),
    }
    await doubleCtrlC(tui)
    const exit = await tui.waitExit()

    await expectNoSurvivors(pids)
    expectExitCode(exit, 0)
    expect.soft(tui.dshLines()[0]).toBe('dsh: stopping 1 command (Ctrl+C to force)')
  })
})
