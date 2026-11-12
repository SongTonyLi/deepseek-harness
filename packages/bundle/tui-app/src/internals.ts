/**
 * Process-bound effects of the terminal runner: the host interface and its
 * default process implementations. Same-package tests replace members of
 * `internals` to substitute a fake terminal and captured streams.
 */

import { ProcessTerminal, type Terminal } from '@earendil-works/pi-tui'
import { canOpenNativePath, openNativeUrl } from '@deepseek-ai/dsh-native-command'
import { colorEnabled, paletteDepth, type PaletteDepth } from './style.ts'

/** Process-facing effects of one run: the terminal, the error stream, and the launcher's bounded exit request. */
export interface TuiHost {
  /** Create the terminal the tree renders into. */
  createTerminal(): Terminal
  /** Drop the process's reference to terminal input once the terminal has stopped. */
  releaseInput(): void
  stderr: { write(chunk: string): unknown }
  /** Whether SGR styling is emitted. */
  color: boolean
  /** How the palette encodes its hues. */
  depth: PaletteDepth
  /** Whether this Host can hand a URL to a local desktop. */
  canOpenUrl(): boolean
  /** Hand an authorization page to the local default browser. */
  openUrl(url: string): Promise<void>
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
  /**
   * Listen for a process signal.
   * @param signal - `SIGINT` forces a quit already under way; `SIGHUP` reports that the terminal went away.
   * @param handler - runs once per delivery.
   * @returns the disposer that removes the listener.
   */
  onSignal(signal: 'SIGINT' | 'SIGHUP', handler: () => void): () => void
  /** Keep a write error on stdout or stderr from becoming an uncaught exception once the terminal is gone. */
  swallowStreamErrors(): void
}

/** The process-bound pieces of the host; tests substitute a fake terminal and captured streams. */
export const internals: Pick<TuiHost, 'createTerminal' | 'releaseInput' | 'stderr' | 'color' | 'depth' | 'canOpenUrl' | 'openUrl' | 'onSignal' | 'swallowStreamErrors'> = {
  /* v8 ignore next -- the process terminal owns raw stdin; tests substitute a fake */
  createTerminal: () => new ProcessTerminal(),
  /* v8 ignore next -- process stdin is the host's; tests substitute a recorder */
  releaseInput: () => { process.stdin.unref() },
  stderr: process.stderr,
  color: colorEnabled(process.env, process.stdout.isTTY),
  depth: paletteDepth(process.env),
  canOpenUrl: () => canOpenNativePath(),
  openUrl: openNativeUrl,
  /* v8 ignore start -- process signals and streams are the host's; tests substitute recorders */
  onSignal: (signal, handler) => {
    process.on(signal, handler)
    return () => { process.off(signal, handler) }
  },
  swallowStreamErrors: () => {
    const ignore = (): void => {
      // A terminal that closed leaves stdout and stderr failing with EIO or EPIPE; the quit still has to finish.
    }
    process.stdout.on('error', ignore)
    process.stderr.on('error', ignore)
  },
  /* v8 ignore stop */
}
