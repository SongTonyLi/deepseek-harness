/**
 * Coded failures of the local sandbox provider. The class stays package-local:
 * `@deepseek-ai/dsh-sandbox` exports no unsupported-policy error, so consumers
 * receive it only as a `HarnessError` carrying {@link SANDBOX_UNSUPPORTED_POLICY}.
 * @module @deepseek-ai/dsh-sandbox-local/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-error'

/** Code of an execution whose policy the selected runner cannot enforce. */
export const SANDBOX_UNSUPPORTED_POLICY = 'SANDBOX_UNSUPPORTED_POLICY'

/**
 * Thrown before a process starts when a read fence needs the Seatbelt rung and
 * another runner, or a configured `runnerCommand`, is selected.
 */
export class SandboxUnsupportedPolicyError extends HarnessError {
  /**
   * @param message - the refused execution and the runner that cannot enforce the policy.
   */
  constructor(message: string) {
    super(message, SANDBOX_UNSUPPORTED_POLICY)
  }
}
