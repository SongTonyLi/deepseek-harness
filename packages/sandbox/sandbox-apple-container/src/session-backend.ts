/**
 * Per-session sandbox-backend choice with the session log as the store. A
 * runtime switch is one log-only `sandbox/backend` event on the session it
 * applies to; the `sandboxBackend` projection unit folds the last one, and the
 * deployment default applies before any switch. The choice survives restart
 * by replay, and two sessions never see each other's choice.
 * @module @deepseek-ai/dsh-sandbox-apple-container/session-backend
 */

import type { Session } from '@deepseek-ai/dsh-session'

/** Where confined commands run: an Apple container VM, or the host's local confinement chain. */
export type SandboxBackend = 'container' | 'local'

/** Every {@link SandboxBackend}, for argument validation and option advertisement. */
export const SANDBOX_BACKENDS: readonly SandboxBackend[] = ['container', 'local']

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's sandbox backend was switched — log-only (like
     * `sandbox/mode`): durable and replayable, never in the model transcript.
     * The LAST such event is the session's backend.
     */
    'sandbox/backend': {
      backend: SandboxBackend
    }
  }
}

/**
 * Whether `value` names a {@link SandboxBackend}.
 * @param value - untrusted text, such as a slash-command argument.
 * @returns true when `value` is a backend name.
 */
export function isSandboxBackend(value: string): value is SandboxBackend {
  return (SANDBOX_BACKENDS as readonly string[]).includes(value)
}

/**
 * Append the one `sandbox/backend` event that switches `session`'s backend;
 * the session's next confined call runs on `backend`.
 * @param session - the session the choice belongs to.
 * @param backend - the backend every later confined call in this session uses.
 */
export function setSandboxBackend(session: Session, backend: SandboxBackend): void {
  session.append('sandbox/backend', { backend })
}
