/** Exec-shim logic: argument codec, environment file, guest wrapper, and the run/sentinel/signal paths. */

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  SHIM_FAILURE_EXIT,
  SHIM_FAILURE_PREFIX,
  encodeShimArgs,
  envFileText,
  execArgs,
  isDenied,
  killArgs,
  parseShimArgs,
  runShim,
  wrapperScript,
} from '../src/shim.ts'
import type { ShimArgs, ShimDeps } from '../src/shim.ts'

const ARGS: ShimArgs = { executable: '/bin/container', container: 'dsh-1', runDir: '/host/run/dsh-1', denylist: ['PATH', 'XPC_*'], argv: ['bash', '-c', 'true'] }

describe('shim arguments', () => {
  it('round-trips through the argv codec', () => {
    const encoded = encodeShimArgs(ARGS)
    expect(encoded).toEqual(['/bin/container', 'dsh-1', '/host/run/dsh-1', 'PATH,XPC_*', '--', 'bash', '-c', 'true'])
    expect(parseShimArgs(encoded)).toEqual(ARGS)
    expect(parseShimArgs(encodeShimArgs({ ...ARGS, denylist: [] })).denylist).toEqual([])
  })

  it('rejects a malformed invocation', () => {
    expect(() => parseShimArgs(['/bin/container', 'dsh-1', '/run', ''])).toThrow('usage: exec-shim')
    expect(() => parseShimArgs(['/bin/container', 'dsh-1', '/run', '', 'x', 'true'])).toThrow('usage: exec-shim')
    expect(() => parseShimArgs(['/bin/container', 'dsh-1', '/run', '', '--'])).toThrow('usage: exec-shim')
    expect(() => parseShimArgs(['/bin/container', 'dsh-1', '', '--', 'true'])).toThrow('usage: exec-shim')
  })
})

describe('environment forwarding', () => {
  it('matches whole names with star wildcards anywhere, ignoring case', () => {
    expect(isDenied('PATH', ARGS.denylist)).toBe(true)
    expect(isDenied('XPC_SERVICE_NAME', ARGS.denylist)).toBe(true)
    expect(isDenied('PATHS', ARGS.denylist)).toBe(false)
    expect(isDenied('DEEPSEEK_API_KEY', ['*KEY*'])).toBe(true)
    expect(isDenied('github_token', ['*TOKEN*'])).toBe(true)
    expect(isDenied('A.B', ['A.B'])).toBe(true)
    expect(isDenied('AXB', ['A.B'])).toBe(false)
  })

  it('writes allowed single-line variables only', () => {
    const text = envFileText({
      PATH: '/usr/bin',
      XPC_FLAGS: '0',
      FOO: 'bar baz',
      MULTI: 'a\nb',
      'NOT-A-NAME': 'x',
      EMPTY: '',
      HTTPS_PROXY: 'http://user:hunter2@proxy:8080',
      NO_AUTH_PROXY: 'http://proxy:8080',
      UNSET: undefined,
    }, ARGS.denylist)
    expect(text).toBe('FOO=bar baz\nEMPTY=\nNO_AUTH_PROXY=http://proxy:8080\n')
  })
})

describe('guest commands', () => {
  it('runs the argv under setsid with a token wrapper', () => {
    expect(wrapperScript('t1')).toBe('echo $$ > /run/dsh/t1.pid || exit 125; "$@"')
    expect(execArgs(ARGS, { cwd: '/ws', envFile: '/tmp/env', tty: false, token: 't1' })).toEqual([
      'exec', '-i', '-w', '/ws', '--env-file', '/tmp/env', 'dsh-1', 'setsid', '-w', 'sh', '-c', wrapperScript('t1'), 'sh', 'bash', '-c', 'true',
    ])
    expect(execArgs(ARGS, { cwd: '/ws', envFile: '/tmp/env', tty: true, token: 't1' }).slice(0, 3)).toEqual(['exec', '-i', '-t'])
  })

  it('signals the guest process group named by the pid file', () => {
    expect(killArgs('dsh-1', 't1', 'SIGTERM')).toEqual(['exec', 'dsh-1', 'sh', '-c', 'kill -TERM -$(cat /run/dsh/t1.pid) 2>/dev/null; true'])
  })
})

interface Harness {
  deps: ShimDeps
  child: EventEmitter
  spawned: (readonly string[])[]
  controls: (readonly string[])[]
  removed: string[]
  consumed: string[]
  stderr: string[]
  signal(name: NodeJS.Signals): void
  listening(): boolean
}

function harness(started: boolean | Error = true): Harness {
  const child = new EventEmitter()
  const spawned: (readonly string[])[] = []
  const controls: (readonly string[])[] = []
  const removed: string[] = []
  const consumed: string[] = []
  const stderr: string[] = []
  let handler: ((signal: NodeJS.Signals) => void) | undefined
  const deps: ShimDeps = {
    token: 't1',
    cwd: '/ws',
    env: { FOO: 'bar', PATH: '/usr/bin' },
    tty: false,
    spawn: (executable, args) => {
      spawned.push([executable, ...args])
      return child
    },
    run: (executable, args) => {
      controls.push([executable, ...args])
      return Promise.resolve(0)
    },
    consumeFile: (path) => {
      consumed.push(path)
      if (started instanceof Error) throw started
      return started
    },
    writeEnvFile: (text) => {
      expect(text).toBe('FOO=bar\n')
      return '/tmp/env'
    },
    removeEnvFile: (path) => { removed.push(path) },
    onSignal: (listener) => {
      handler = listener
      return () => { handler = undefined }
    },
    stderr: (text) => { stderr.push(text) },
  }
  return {
    deps, child, spawned, controls, removed, consumed, stderr,
    signal: (name) => { handler?.(name) },
    listening: () => handler !== undefined,
  }
}

/** Let `runShim` reach its first await so the child listeners are attached. */
async function settled(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

describe('runShim', () => {
  it('returns zero and consumes the start sentinel on the host', async () => {
    const h = harness()
    const run = runShim(ARGS, h.deps)
    await settled()
    h.child.emit('close', 0, null)
    await expect(run).resolves.toBe(0)
    expect(h.spawned).toEqual([['/bin/container', ...execArgs(ARGS, { cwd: '/ws', envFile: '/tmp/env', tty: false, token: 't1' })]])
    expect(h.controls).toEqual([])
    expect(h.consumed).toEqual(['/host/run/dsh-1/t1.pid'])
    expect(h.removed).toEqual(['/tmp/env'])
    expect(h.listening()).toBe(false)
  })

  it('returns the command exit status once the start sentinel proves it ran', async () => {
    const h = harness(true)
    const run = runShim(ARGS, h.deps)
    await settled()
    h.child.emit('close', 3, null)
    await expect(run).resolves.toBe(3)
    expect(h.controls).toEqual([])
    expect(h.stderr).toEqual([])
  })

  it('reports a runtime failure when the command never started', async () => {
    const h = harness(false)
    const run = runShim(ARGS, h.deps)
    await settled()
    h.child.emit('close', 1, null)
    await expect(run).resolves.toBe(SHIM_FAILURE_EXIT)
    expect(h.stderr).toEqual([`${SHIM_FAILURE_PREFIX}the container runtime failed before the command started (container exec exited 1)\n`])
  })

  it('reports a sentinel cleanup failure as a runtime failure', async () => {
    const h = harness(new Error('EACCES: permission denied, unlink'))
    const run = runShim(ARGS, h.deps)
    await settled()
    h.child.emit('close', 3, null)
    await expect(run).resolves.toBe(SHIM_FAILURE_EXIT)
    expect(h.stderr).toEqual([`${SHIM_FAILURE_PREFIX}EACCES: permission denied, unlink\n`])
    expect(h.removed).toEqual(['/tmp/env'])
  })

  it('maps a signal-terminated container CLI to 128 plus the signal number', async () => {
    const h = harness(true)
    const run = runShim(ARGS, h.deps)
    await settled()
    h.child.emit('close', null, 'SIGKILL')
    await expect(run).resolves.toBe(137)
  })

  it('forwards a signal to the guest process group', async () => {
    const h = harness(true)
    const run = runShim(ARGS, h.deps)
    await settled()
    h.signal('SIGTERM')
    h.signal('SIGINT')
    h.child.emit('close', 1, null)
    await expect(run).resolves.toBe(143)
    expect(h.controls).toEqual([
      ['/bin/container', ...killArgs('dsh-1', 't1', 'SIGTERM')],
      ['/bin/container', ...killArgs('dsh-1', 't1', 'SIGINT')],
    ])
  })

  it('reports a container CLI that cannot spawn', async () => {
    const h = harness()
    const run = runShim(ARGS, h.deps)
    await settled()
    h.child.emit('error', new Error('spawn /bin/container ENOENT'))
    await expect(run).resolves.toBe(SHIM_FAILURE_EXIT)
    expect(h.stderr).toEqual([`${SHIM_FAILURE_PREFIX}spawn /bin/container ENOENT\n`])
    expect(h.removed).toEqual(['/tmp/env'])
  })
})
