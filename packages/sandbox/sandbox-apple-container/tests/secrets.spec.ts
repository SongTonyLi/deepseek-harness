/** The hidden-file scan that feeds container masks. */

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findHiddenFiles } from '../src/secrets.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})

function tree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-secrets-')))
  dirs.push(root)
  mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(root, '.env'), '')
  writeFileSync(join(root, 'README.md'), '')
  writeFileSync(join(root, 'a', 'server.PEM'), '')
  writeFileSync(join(root, 'a', 'b', '.env.local'), '')
  writeFileSync(join(root, 'a', 'b', 'c', 'id_rsa'), '')
  writeFileSync(join(root, 'node_modules', 'pkg', '.env'), '')
  symlinkSync(join(root, 'a'), join(root, 'loop'))
  symlinkSync(join(root, '.env'), join(root, 'linked.key'))
  return root
}

const SCAN = { names: ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*'], skipDirs: ['node_modules'] }

describe('findHiddenFiles', () => {
  it('finds matching files and symlinks without entering skipped or symlinked directories', () => {
    const root = tree()
    expect(findHiddenFiles(root, { ...SCAN, maxDepth: 8 }).sort()).toEqual([
      join(root, '.env'),
      join(root, 'a', 'b', '.env.local'),
      join(root, 'a', 'b', 'c', 'id_rsa'),
      join(root, 'a', 'server.PEM'),
      join(root, 'linked.key'),
    ])
  })

  it('stops at the configured depth', () => {
    const root = tree()
    expect(findHiddenFiles(root, { ...SCAN, maxDepth: 1 }).sort()).toEqual([
      join(root, '.env'),
      join(root, 'a', 'server.PEM'),
      join(root, 'linked.key'),
    ])
  })

  it('skips an unreadable directory', () => {
    const root = tree()
    chmodSync(join(root, 'a'), 0o000)
    try {
      expect(findHiddenFiles(root, { ...SCAN, maxDepth: 8 }).sort()).toEqual([join(root, '.env'), join(root, 'linked.key')])
    } finally {
      chmodSync(join(root, 'a'), 0o755)
    }
  })
})
