/**
 * A fake `container` CLI for unit tests: a shell script that appends each
 * invocation's argv to a log and answers from per-subcommand fixture files,
 * so tests drive the real `execFile` path without the Apple runtime.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One subcommand's scripted answer. */
export interface FakeAnswer {
  code?: number
  stdout?: string
  stderr?: string
}

/** A fake CLI and its controls. */
export interface FakeContainer {
  /** Path of the executable script. */
  executable: string
  /** Script an answer for `container <subcommand>` (`system-status`, `inspect`, ...). */
  answer(subcommand: string, answer: FakeAnswer): void
  /** Every logged invocation's argv. */
  calls(): string[][]
  /** Remove the fixture directory. */
  dispose(): void
}

/**
 * Create a fake `container` CLI. Unscripted subcommands exit 0 with no output.
 * @returns the fake and its controls.
 */
export function fakeContainer(): FakeContainer {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fake-container-'))
  const executable = join(dir, 'container')
  const log = join(dir, 'calls.log')
  writeFileSync(log, '')
  writeFileSync(executable, [
    '#!/bin/sh',
    `dir=${JSON.stringify(dir)}`,
    'printf "%s\\037" "$@" >> "$dir/calls.log"; printf "\\n" >> "$dir/calls.log"',
    'key="$1"; case "$1" in system) key="system-$2";; esac',
    '[ -f "$dir/$key.out" ] && cat "$dir/$key.out"',
    '[ -f "$dir/$key.err" ] && cat "$dir/$key.err" >&2',
    '[ -f "$dir/$key.code" ] && exit "$(cat "$dir/$key.code")"',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 })
  return {
    executable,
    answer: (subcommand, answer) => {
      writeFileSync(join(dir, `${subcommand}.out`), answer.stdout ?? '')
      writeFileSync(join(dir, `${subcommand}.err`), answer.stderr ?? '')
      writeFileSync(join(dir, `${subcommand}.code`), String(answer.code ?? 0))
    },
    calls: () => readFileSync(log, 'utf8').split('\n').filter(line => line !== '').map(line => line.split('\x1f').slice(0, -1)),
    dispose: () => { rmSync(dir, { recursive: true, force: true }) },
  }
}
