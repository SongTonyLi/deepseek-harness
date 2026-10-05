/**
 * Test provider for read-scope consumers: confines reads to the policy
 * workspace and hides `.env`, as the container backend does, and refuses to
 * spawn. Imported by the filesystem tool suites and by the suites that depend
 * on whether the session's backend confines reads.
 */

import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxReadScope } from '@deepseek-ai/dsh-sandbox'

/** A `ctx.sandbox` provider whose read scope is the policy workspace minus `.env`. */
export class WorkspaceReadSandbox extends SandboxProvider {
  /** Set false to model a backend that confines writes alone, as a session's backend switch does. */
  confinesReads = true

  confine(): Promise<ConfinedArgv> {
    return Promise.reject(new Error('read-scope tests do not spawn'))
  }

  override readScope(policy: SandboxExecutionPolicy): SandboxReadScope | undefined {
    if (!this.confinesReads || policy.mode === 'danger-full-access') return undefined
    return { roots: [policy.workspaceRoot], hiddenNames: ['.env'] }
  }
}
