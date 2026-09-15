/** `/export`: the session log ZIP written to a local directory. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { exportSessionZip } from '../src/export.ts'
import { exportStubs } from './bench.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dsh-tui-export-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const signal = new AbortController().signal

describe('exportSessionZip', () => {
  it('writes the archive named after the session into the directory', async () => {
    const ctx = new Context()
    exportStubs(ctx, 'session-x' as SessionId)
    const path = await exportSessionZip(ctx, 'session-x' as SessionId, dir, signal)
    expect(path).toBe(join(dir, 'dsh-session-session-x.zip'))
    const bytes = await readFile(path)
    // A ZIP archive starts with the local file header signature.
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')
  })

  it('fails loud without the export services or without a stored log', async () => {
    await expect(exportSessionZip(new Context(), 'session-x' as SessionId, dir, signal))
      .rejects.toThrow('export needs the session query, persistence, and attachment services')
    const ctx = new Context()
    exportStubs(ctx, 'session-x' as SessionId, true)
    await expect(exportSessionZip(ctx, 'session-x' as SessionId, dir, signal))
      .rejects.toThrow('session session-x has no persisted log to export')
  })
})
