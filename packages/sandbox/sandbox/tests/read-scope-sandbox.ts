/**
 * Test provider for read-scope consumers: confines reads to the policy
 * workspace and hides `.env`, as the container backend does, and refuses to
 * spawn. Imported by the filesystem tool suites.
 */

import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxReadScope } from '@deepseek-ai/dsh-sandbox'

/** A `ctx.sandbox` provider whose read scope is the policy workspace minus `.env`. */
export class WorkspaceReadSandbox extends SandboxProvider {
  confine(): Promise<ConfinedArgv> {
    return Promise.reject(new Error('read-scope tests do not spawn'))
  }

  override readScope(policy: SandboxExecutionPolicy): SandboxReadScope | undefined {
    return policy.mode === 'danger-full-access' ? undefined : { roots: [policy.workspaceRoot], hiddenNames: ['.env'] }
  }
}
