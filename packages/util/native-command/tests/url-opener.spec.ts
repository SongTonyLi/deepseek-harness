/** Credential-scrubbed default-browser handoff behavior. */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openNativeUrl } from '../src/index.ts'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}))

type BrowserLauncher = ChildProcess & { stderr: PassThrough }

function launcher(): BrowserLauncher {
  return Object.assign(new EventEmitter(), { stderr: new PassThrough() }) as unknown as BrowserLauncher
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(spawn).mockReset()
  vi.unstubAllEnvs()
})

describe('native URL opener', () => {
  it('passes one HTTP URL through a credential-scrubbed helper', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'must-not-reach-browser')
    vi.stubEnv('DSH_HOME', '/must-not-reach-browser')
    const completed = launcher()
    vi.mocked(spawn).mockReturnValueOnce(completed)
    const completion = openNativeUrl('https://auth.example/start?state=a&next=b')
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]!
    expect(command).toBe(process.execPath)
    expect(args).toEqual([
      '--input-type=module',
      '--eval', expect.stringContaining('await import('),
      '--', 'https://auth.example/start?state=a&next=b',
    ])
    expect(args?.[2]).toContain("if (process.platform === 'win32')")
    expect(args?.[2]).toContain('launcher.ref()')
    expect(options?.env).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(options?.env).not.toHaveProperty('DSH_HOME')
    expect(options?.env?.PATH).toBe(process.env.PATH)
    expect(options?.stdio).toEqual(['ignore', 'inherit', 'pipe'])
    completed.emit('close', 0)
    await expect(completion).resolves.toBeUndefined()
    expect(completed.listenerCount('error')).toBe(0)
  })

  it('forwards helper diagnostics after a successful handoff', async () => {
    const completed = launcher()
    vi.mocked(spawn).mockReturnValueOnce(completed)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const completion = openNativeUrl('http://127.0.0.1:4567')
    completed.stderr.write('launcher note\n')
    completed.emit('close', 0)
    await expect(completion).resolves.toBeUndefined()
    expect(stderr).toHaveBeenCalledWith('launcher note\n')
  })

  it('reports helper stderr, exit, and spawn failures', async () => {
    const failedWithReason = launcher()
    vi.mocked(spawn).mockReturnValueOnce(failedWithReason)
    const reasonFailure = openNativeUrl('https://auth.example/reason')
    const reasonAssertion = expect(reasonFailure).rejects.toThrow('desktop unavailable')
    failedWithReason.stderr.write('Error: desktop unavailable\n    at fixture')
    failedWithReason.emit('close', 1)
    await reasonAssertion

    const failed = launcher()
    vi.mocked(spawn).mockReturnValueOnce(failed)
    const failure = openNativeUrl('https://auth.example/exit')
    const failureAssertion = expect(failure).rejects.toThrow('exited with code 3')
    await Promise.resolve()
    failed.emit('close', 3)
    await failureAssertion

    const errored = launcher()
    vi.mocked(spawn).mockReturnValueOnce(errored)
    const error = openNativeUrl('https://auth.example/spawn')
    const errorAssertion = expect(error).rejects.toThrow('spawn failed')
    await Promise.resolve()
    errored.emit('error', new Error('spawn failed'))
    await errorAssertion
    expect(errored.listenerCount('close')).toBe(0)
  })

  it('rejects malformed and non-HTTP targets before spawning', async () => {
    await expect(openNativeUrl('not a URL')).rejects.toThrow('Invalid URL')
    await expect(openNativeUrl('file:///tmp/secret')).rejects.toThrow('supports only HTTP(S), not file:')
    expect(spawn).not.toHaveBeenCalled()
  })
})
