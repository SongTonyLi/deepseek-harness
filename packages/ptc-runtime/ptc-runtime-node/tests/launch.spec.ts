import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { resolveLaunch, workerBootstrap } from '../src/launch.ts'

const unmapped = { processPathFromHostPath: () => undefined }
const noMapping = { processPathFromHostPath: () => { throw new Error('must not map a remote worker') } }
const identity = { processPathFromHostPath: (path: string) => path }

it('uses an explicit installed bootstrap without pretending it maps the host file', () => {
  expect(workerBootstrap(noMapping, { kind: 'node-script', executable: '/remote/node', bootstrapPath: '/remote/process.js' }, 2048))
    .toEqual({ args: ['--experimental-vm-modules', '/remote/process.js', '2048'], readPaths: ['/remote'] })
})

it('fails when the execution world cannot read the source bootstrap', () => {
  expect(() => workerBootstrap(unmapped, { kind: 'node-script', executable: process.execPath }, 2048))
    .toThrow('unavailable in the subprocess execution world')
})

it('reads the whole source checkout when it evaluates the source bootstrap', () => {
  const bootstrap = workerBootstrap(identity, { kind: 'node-script', executable: process.execPath }, 2048)
  expect(bootstrap.args.slice(0, 3)).toEqual(['--experimental-vm-modules', '--input-type=module', '--eval'])
  expect(bootstrap.readPaths).toEqual([resolve(fileURLToPath(new URL('../../../../', import.meta.url)))])
})

it('uses a remote embedded worker when the client runs ordinary Node', () => {
  const launch = resolveLaunch({ kind: 'embedded', executable: '/remote/dsh-ssh-helper' })
  expect(launch).toEqual({ kind: 'embedded', executable: '/remote/dsh-ssh-helper' })
  expect(workerBootstrap(noMapping, launch, 2048)).toEqual({ args: ['2048'], readPaths: [] })
})

it('resolves the local carrier once while preserving an explicit remote script choice', () => {
  const prior = Object.getOwnPropertyDescriptor(process, 'pkg')
  try {
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    expect(resolveLaunch()).toEqual({ kind: 'embedded', executable: process.execPath })
    const remote = resolveLaunch({ kind: 'node-script', executable: '/remote/node', bootstrapPath: '/remote/process.js' })
    expect(workerBootstrap(noMapping, remote, 2048).args).toEqual(['--experimental-vm-modules', '/remote/process.js', '2048'])
  } finally {
    if (prior === undefined) Reflect.deleteProperty(process, 'pkg')
    else Object.defineProperty(process, 'pkg', prior)
  }
  expect(resolveLaunch()).toEqual({ kind: 'node-script', executable: process.execPath })
})

it('requires a script launch for persistent processes and selects their bootstrap', () => {
  expect(() => workerBootstrap(noMapping, { kind: 'embedded', executable: '/remote/helper' }, 2048, true))
    .toThrow('requires a node-script launch')
  expect(workerBootstrap(noMapping, { kind: 'node-script', executable: '/remote/node', bootstrapPath: '/remote/persistent-process.js' }, 2048, true))
    .toEqual({ args: ['--experimental-vm-modules', '/remote/persistent-process.js', '2048'], readPaths: ['/remote'] })
})
