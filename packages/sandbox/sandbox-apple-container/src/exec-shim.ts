/**
 * Exec-shim process entry: binds {@link runShim} to Node's process, child
 * process, and filesystem facilities. The provider's confined argv runs this
 * file under plain Node (built `lib/`) or tsx (source checkout).
 * @module @deepseek-ai/dsh-sandbox-apple-container/exec-shim
 */
/* v8 ignore file -- a child-process entry; tests/shim.spec.ts covers runShim and the real-runtime e2e covers this binding. */

import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SHIM_FAILURE_EXIT, SHIM_FAILURE_PREFIX, parseShimArgs, runShim } from './shim.ts'

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

try {
  const args = parseShimArgs(process.argv.slice(2))
  process.exitCode = await runShim(args, {
    token: randomUUID(),
    cwd: process.cwd(),
    env: process.env,
    tty: process.stdin.isTTY,
    spawn: (executable, spawnArgs) => spawn(executable, spawnArgs, { stdio: 'inherit' }),
    run: (executable, runArgs) => new Promise((resolve) => {
      execFile(executable, runArgs, (error) => {
        resolve(error === null ? 0 : typeof error.code === 'number' ? error.code : SHIM_FAILURE_EXIT)
      })
    }),
    writeEnvFile: (text) => {
      const path = join(mkdtempSync(join(tmpdir(), 'dsh-container-env-')), 'env')
      writeFileSync(path, text, { mode: 0o600 })
      return path
    },
    removeEnvFile: (path) => { rmSync(join(path, '..'), { recursive: true, force: true }) },
    onSignal: (handler) => {
      for (const signal of SIGNALS) process.on(signal, handler)
      return () => { for (const signal of SIGNALS) process.off(signal, handler) }
    },
    stderr: (text) => { process.stderr.write(text) },
  })
} catch (error: unknown) {
  process.stderr.write(`${SHIM_FAILURE_PREFIX}${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = SHIM_FAILURE_EXIT
}
