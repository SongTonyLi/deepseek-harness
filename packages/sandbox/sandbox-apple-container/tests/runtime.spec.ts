/** ContainerRuntime against a fake `container` CLI. */

import { afterEach, describe, expect, it } from 'vitest'
import { ContainerRuntime } from '../src/runtime.ts'
import type { RuntimeOptions } from '../src/runtime.ts'
import { fakeContainer } from './fake-container.ts'
import type { FakeContainer } from './fake-container.ts'

const fakes: FakeContainer[] = []
afterEach(() => {
  for (const fake of fakes.splice(0)) fake.dispose()
})

function setup(options: Partial<RuntimeOptions> = {}): { fake: FakeContainer; runtime: ContainerRuntime } {
  const fake = fakeContainer()
  fakes.push(fake)
  return { fake, runtime: new ContainerRuntime({ executable: fake.executable, image: 'node:22-bookworm', autoStart: true, ...options }) }
}

describe('ContainerRuntime', () => {
  it('leaves a running API server alone', async () => {
    const { fake, runtime } = setup()
    await runtime.ensureService()
    expect(fake.calls()).toEqual([['system', 'status']])
  })

  it('starts a stopped API server with the default kernel', async () => {
    const { fake, runtime } = setup()
    fake.answer('system-status', { code: 1, stdout: 'apiserver is not running' })
    await runtime.ensureService()
    expect(fake.calls()).toEqual([['system', 'status'], ['system', 'start', '--enable-kernel-install']])
  })

  it('reports a failed start', async () => {
    const { fake, runtime } = setup()
    fake.answer('system-status', { code: 1 })
    fake.answer('system-start', { code: 1, stderr: '\nError: launchd refused\n' })
    await expect(runtime.ensureService()).rejects.toThrow('container system start failed: Error: launchd refused')
  })

  it('refuses to start the API server without autoStart', async () => {
    const { fake, runtime } = setup({ autoStart: false })
    fake.answer('system-status', { code: 1 })
    await expect(runtime.ensureService()).rejects.toThrow('the container API server is not running (exit 1); run `container system start`')
    expect(fake.calls()).toEqual([['system', 'status']])
  })

  it('reads container state from inspect', async () => {
    const { fake, runtime } = setup()
    fake.answer('inspect', { stdout: JSON.stringify([{ status: { state: 'running' } }]) })
    await expect(runtime.state('dsh-1')).resolves.toBe('running')
    fake.answer('inspect', { stdout: JSON.stringify([{ status: { state: 'stopped' } }]) })
    await expect(runtime.state('dsh-1')).resolves.toBe('stopped')
    fake.answer('inspect', { stdout: '[]' })
    await expect(runtime.state('dsh-1')).resolves.toBe('stopped')
    fake.answer('inspect', { code: 1, stderr: 'Error: not found' })
    await expect(runtime.state('dsh-1')).resolves.toBe('missing')
    expect(fake.calls()[0]).toEqual(['inspect', 'dsh-1'])
  })

  it('runs an idle container with labels, resources, bind mounts, and masks', async () => {
    const { fake, runtime } = setup({ cpus: 2, memory: '4g' })
    await runtime.run({
      name: 'dsh-1',
      labels: { 'dsh.pid': '42' },
      mounts: [{ source: '/ws', target: '/ws', readonly: true }, { source: '/ws', target: '/link', readonly: false }],
      maskedPaths: ['/ws/.env'],
    })
    expect(fake.calls()).toEqual([[
      'run', '--detach', '--init', '--rm', '--name', 'dsh-1', '--label', 'dsh.pid=42', '--cpus', '2', '--memory', '4g',
      '--mount', 'type=bind,source=/ws,target=/ws,readonly', '--mount', 'type=bind,source=/ws,target=/link',
      '--masked-path', '/ws/.env',
      'node:22-bookworm', 'sleep', 'infinity',
    ]])
  })

  it('reports a failed run', async () => {
    const { fake, runtime } = setup()
    fake.answer('run', { code: 1, stderr: 'Error: image not found' })
    await expect(runtime.run({ name: 'dsh-1', labels: {}, mounts: [], maskedPaths: [] })).rejects.toThrow('container run failed: Error: image not found')
  })

  it('deletes a container by name', async () => {
    const { fake, runtime } = setup()
    fake.answer('delete', { code: 1 })
    await runtime.remove('dsh-1')
    expect(fake.calls()).toEqual([['delete', '--force', 'dsh-1']])
  })

  it('lists containers with their labels', async () => {
    const { fake, runtime } = setup()
    fake.answer('list', { stdout: JSON.stringify([{ configuration: { id: 'a', labels: { 'dsh.pid': '1' } } }, { configuration: { id: 'b' } }]) })
    await expect(runtime.list()).resolves.toEqual([{ id: 'a', labels: { 'dsh.pid': '1' } }, { id: 'b', labels: {} }])
    fake.answer('list', { code: 1 })
    await expect(runtime.list()).resolves.toEqual([])
  })

  it('names a missing executable', async () => {
    const runtime = new ContainerRuntime({ executable: '/nonexistent/container', image: 'x', autoStart: true })
    await expect(runtime.ensureService()).rejects.toThrow('cannot run "/nonexistent/container"')
  })
})
