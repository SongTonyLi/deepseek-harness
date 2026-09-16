import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { liftPlatformOptionalDependencies, npmPayloadExclusion } from './build-npm-cli-package.ts'

interface TestManifest {
  name: string
  version?: string
  optionalDependencies?: Record<string, string>
  os?: string[]
  cpu?: string[]
}

const fixtureRoots: string[] = []

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function createPayload(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cli-platform-variants-'))
  fixtureRoots.push(root)
  const nodeModules = join(root, 'node_modules')
  await mkdir(nodeModules)
  return nodeModules
}

async function writePackage(nodeModules: string, manifest: TestManifest): Promise<void> {
  const directory = join(nodeModules, manifest.name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
}

async function readPackage(nodeModules: string, name: string): Promise<TestManifest> {
  return JSON.parse(await readFile(join(nodeModules, name, 'package.json'), 'utf8')) as TestManifest
}

describe('npmPayloadExclusion', () => {
  it('keeps the runtime files a bundled package is imported through', () => {
    expect(npmPayloadExclusion('node_modules/@deepseek-ai/dsh-tui-app/lib/index.js')).toBeUndefined()
    expect(npmPayloadExclusion('node_modules/@deepseek-ai/dsh-tui-app/package.json')).toBeUndefined()
    expect(npmPayloadExclusion('node_modules/@deepseek-ai/dsh-tui-app/cordis.patch.yml')).toBeUndefined()
  })

  it('drops build and diagnostic files no install reads', () => {
    expect(npmPayloadExclusion('node_modules/@deepseek-ai/dsh/lib/types/index.d.ts')).toBe('TypeScript declaration')
    expect(npmPayloadExclusion('node_modules/@deepseek-ai/dsh/lib/index.js.map')).toBe('source map')
    expect(npmPayloadExclusion('node_modules/@deepseek-ai/dsh/lib/tsconfig.tsbuildinfo')).toBe('TypeScript build cache')
    expect(npmPayloadExclusion('node_modules/@mixmark-io/domino/test/fixture.js')).toBe('Domino test fixtures')
  })

  it('drops the package-manager metadata a published tree must not carry', () => {
    expect(npmPayloadExclusion('node_modules/.bin/dsh')).toBe('package-manager metadata')
    expect(npmPayloadExclusion('node_modules/.pnpm/lock.yaml')).toBe('package-manager metadata')
    expect(npmPayloadExclusion('node_modules/.modules.yaml')).toBe('package-manager metadata')
  })

  it('keeps every node-pty prebuild, because one tarball serves every platform', () => {
    for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']) {
      expect(npmPayloadExclusion(`node_modules/node-pty/prebuilds/${platform}/pty.node`)).toBeUndefined()
    }
    expect(npmPayloadExclusion('node_modules/node-pty/prebuilds/win32-x64/conpty.pdb')).toBe('node-pty debug symbols')
  })
})

describe('liftPlatformOptionalDependencies', () => {
  it('lifts a fixed-range family once and removes every nested declaration', async () => {
    const nodeModules = await createPayload()
    await Promise.all([
      writePackage(nodeModules, {
        name: 'secondary-consumer',
        version: '3.0.0',
        optionalDependencies: { 'platform-linux-x64': '1.0.0', 'plain-addon': '^9.0.0' },
      }),
      writePackage(nodeModules, { name: 'plain-addon', version: '9.1.0' }),
      writePackage(nodeModules, {
        name: 'platform-parent',
        version: '1.0.0',
        optionalDependencies: { 'platform-darwin-arm64': '1.0.0', 'platform-linux-x64': '1.0.0' },
      }),
      writePackage(nodeModules, {
        name: 'platform-darwin-arm64',
        version: '1.0.0',
        os: ['darwin'],
        cpu: ['arm64'],
      }),
    ])

    const lifted = await liftPlatformOptionalDependencies(nodeModules, [
      'secondary-consumer',
      'plain-addon',
      'platform-parent',
      'platform-darwin-arm64',
    ])

    expect(lifted).toEqual({ 'platform-darwin-arm64': '1.0.0', 'platform-linux-x64': '1.0.0' })
    expect((await readPackage(nodeModules, 'platform-parent')).optionalDependencies).toBeUndefined()
    expect((await readPackage(nodeModules, 'secondary-consumer')).optionalDependencies).toEqual({ 'plain-addon': '^9.0.0' })
    await expect(access(join(nodeModules, 'platform-darwin-arm64'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('normalizes workspace variants before deduplicating their declarations', async () => {
    const nodeModules = await createPayload()
    await Promise.all([
      writePackage(nodeModules, {
        name: 'secondary-consumer',
        version: '2.3.4',
        optionalDependencies: { 'platform-linux-x64': 'workspace:^', 'plain-addon': '^9.0.0' },
      }),
      writePackage(nodeModules, { name: 'plain-addon', version: '9.1.0' }),
      writePackage(nodeModules, {
        name: 'platform-parent',
        version: '2.3.4',
        optionalDependencies: { 'platform-darwin-arm64': 'workspace:*', 'platform-linux-x64': 'workspace:^' },
      }),
      writePackage(nodeModules, {
        name: 'platform-darwin-arm64',
        version: '2.3.4',
        os: ['darwin'],
        cpu: ['arm64'],
      }),
    ])

    const lifted = await liftPlatformOptionalDependencies(nodeModules, [
      'secondary-consumer',
      'plain-addon',
      'platform-parent',
      'platform-darwin-arm64',
    ])

    expect(lifted).toEqual({ 'platform-darwin-arm64': '2.3.4', 'platform-linux-x64': '2.3.4' })
    expect((await readPackage(nodeModules, 'platform-parent')).optionalDependencies).toBeUndefined()
    expect((await readPackage(nodeModules, 'secondary-consumer')).optionalDependencies).toEqual({ 'plain-addon': '^9.0.0' })
  })

  it('rejects a conflicting secondary declaration before changing the payload', async () => {
    const nodeModules = await createPayload()
    await Promise.all([
      writePackage(nodeModules, {
        name: 'secondary-consumer',
        version: '3.0.0',
        optionalDependencies: { 'platform-linux-x64': '2.0.0', 'plain-addon': '^9.0.0' },
      }),
      writePackage(nodeModules, { name: 'plain-addon', version: '9.1.0' }),
      writePackage(nodeModules, {
        name: 'platform-parent',
        version: '1.0.0',
        optionalDependencies: { 'platform-darwin-arm64': '1.0.0', 'platform-linux-x64': '1.0.0' },
      }),
      writePackage(nodeModules, {
        name: 'platform-darwin-arm64',
        version: '1.0.0',
        os: ['darwin'],
        cpu: ['arm64'],
      }),
    ])
    const parentBefore = await readFile(join(nodeModules, 'platform-parent', 'package.json'), 'utf8')
    const consumerBefore = await readFile(join(nodeModules, 'secondary-consumer', 'package.json'), 'utf8')

    await expect(liftPlatformOptionalDependencies(nodeModules, [
      'secondary-consumer',
      'plain-addon',
      'platform-parent',
      'platform-darwin-arm64',
    ])).rejects.toThrow(
      'platform-linux-x64 has conflicting lifted ranges 1.0.0 from platform-parent and 2.0.0 from secondary-consumer',
    )

    expect(await readFile(join(nodeModules, 'platform-parent', 'package.json'), 'utf8')).toBe(parentBefore)
    expect(await readFile(join(nodeModules, 'secondary-consumer', 'package.json'), 'utf8')).toBe(consumerBefore)
    await expect(access(join(nodeModules, 'platform-darwin-arm64'))).resolves.toBeUndefined()
  })

  it('leaves payload manifests untouched when no platform family is present', async () => {
    const nodeModules = await createPayload()
    await Promise.all([
      writePackage(nodeModules, {
        name: 'ordinary-consumer',
        version: '1.0.0',
        optionalDependencies: { 'plain-addon': '^9.0.0' },
      }),
      writePackage(nodeModules, { name: 'plain-addon', version: '9.1.0' }),
    ])
    const before = await readFile(join(nodeModules, 'ordinary-consumer', 'package.json'), 'utf8')

    await expect(liftPlatformOptionalDependencies(nodeModules, ['ordinary-consumer', 'plain-addon'])).resolves.toEqual({})
    expect(await readFile(join(nodeModules, 'ordinary-consumer', 'package.json'), 'utf8')).toBe(before)
  })
})
