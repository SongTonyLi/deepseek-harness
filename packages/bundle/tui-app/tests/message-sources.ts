/** Test-only context source constructors for TUI transcript fixtures. */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'

/** TUI fixture context kind, declared locally rather than impersonating a plugin. */
export type TuiTestContextSource = ContextFormed & {
  readonly kind: 'tui-test-context'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'tui-test-context': TuiTestContextSource
  }
}

/**
 * Create one fixture-only injected-context source.
 * @param form - the semantic context form and required fields.
 * @returns the source accepted by message constructors in these tests.
 */
export function testContextSource(form: ContextFormed): TuiTestContextSource {
  return { kind: 'tui-test-context', ...form }
}
