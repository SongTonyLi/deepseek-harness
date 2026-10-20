/**
 * Real-process check that terminating a command also ends a child it started
 * in its own session and process group (`detached: true`), which a signal to
 * the command's process group never reaches. On macOS and on Linux without
 * user-systemd this runs the fallback descendant sweep and needs a readable
 * process table (`/bin/ps`, `/proc`); a Linux scope owns the child natively.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-subprocess-escapee-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/**
 * A leader that starts a detached child and waits. The child writes its own
 * pid only after installing its SIGTERM disposition, so the marker proves the
 * disposition is in place before termination starts.
 */
function leaderProgram(pidFile: string, ignoreTerm: boolean): string {
  const child = [
    ignoreTerm ? 'process.on("SIGTERM", () => {})' : '',
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
    'setInterval(() => {}, 1000)',
  ].join(';')
  return [
    'const { spawn } = require("node:child_process")',
    `spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { detached: true, stdio: "ignore" })`,
    'setInterval(() => {}, 1000)',
  ].join(';')
}

async function readPid(path: string): Promise<number> {
  return vi.waitFor(() => {
    const pid = Number(readFileSync(path, 'utf8').trim())
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`pid file ${path} is not written yet`)
    return pid
  }, { timeout: 10_000, interval: 20 })
}

/** Whether no running process holds `pid`; a Linux zombie awaiting its reaper runs no code and counts as gone. */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
  if (process.platform !== 'linux') return false
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch (error: unknown) {
    // The process was reaped between the probe and this read.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
  return /^[ZXx]$/.test(stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3))
}

describe.skipIf(process.platform === 'win32')('terminating a command with a detached child', () => {
  it.each([
    { name: 'ends the child with the termination signal', ignoreTerm: false },
    { name: 'escalates to SIGKILL for a child that ignores SIGTERM', ignoreTerm: true },
  ])('$name', { timeout: 30_000 }, async ({ ignoreTerm }) => {
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const pidFile = join(scratch, `escapee-${String(ignoreTerm)}-${Date.now()}.pid`)
    let escapee: number | undefined
    try {
      const handle = ctx.subprocess.spawn({
        argv: [process.execPath, '-e', leaderProgram(pidFile, ignoreTerm)],
        cwd: scratch,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: 300,
      })
      escapee = await readPid(pidFile)

      handle.terminate()
      await expect(handle.waitForExit()).resolves.toBe(true)

      // Named first so an unreadable process table reports its own cause.
      expect(warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes('cannot read the process table'))).toEqual([])
      expect(gone(escapee)).toBe(true)
    } finally {
      if (escapee !== undefined && !gone(escapee)) process.kill(escapee, 'SIGKILL')
      await fiber.dispose()
    }
  })
})
