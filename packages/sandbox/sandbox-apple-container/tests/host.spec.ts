/** Host support and `auto` backend resolution. */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { containerSupported, executableResolves, resolveBackend } from '../src/host.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function binDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-host-bin-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'container'), '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(join(dir, 'plain'), '')
  chmodSync(join(dir, 'plain'), 0o644)
  return dir
}

describe('executableResolves', () => {
  it('finds bare names on PATH and absolute executables', () => {
    const dir = binDir()
    expect(executableResolves('container', `/nonexistent${delimiter}${delimiter}${dir}`)).toBe(true)
    expect(executableResolves('container', undefined)).toBe(false)
    expect(executableResolves('plain', dir)).toBe(false)
    expect(executableResolves(join(dir, 'container'), undefined)).toBe(true)
  })
})

describe('containerSupported', () => {
  it('requires macOS on Apple silicon with the CLI installed', () => {
    const path = binDir()
    expect(containerSupported('container', { platform: 'darwin', arch: 'arm64', path })).toBe(true)
    expect(containerSupported('container', { platform: 'darwin', arch: 'x64', path })).toBe(false)
    expect(containerSupported('container', { platform: 'linux', arch: 'arm64', path })).toBe(false)
    expect(containerSupported('container', { platform: 'darwin', arch: 'arm64', path: '/nonexistent' })).toBe(false)
  })
})

describe('resolveBackend', () => {
  it('resolves auto by host support and keeps a fixed backend', () => {
    expect(resolveBackend('auto', true)).toBe('container')
    expect(resolveBackend('auto', false)).toBe('local')
    expect(resolveBackend('container', false)).toBe('container')
    expect(resolveBackend('local', true)).toBe('local')
  })
})
