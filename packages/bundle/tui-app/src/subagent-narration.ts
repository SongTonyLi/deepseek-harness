/**
 * Progress narration for the terminal's in-process subagents. Each child agent
 * this process creates or resumes receives one runtime-context sentence that
 * asks it to narrate before each tool call. Top-level agents and `/btw` side
 * agents receive none.
 *
 * @module @deepseek-ai/dsh-tui-app/subagent-narration
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'

/** Runtime-context name of the narration entry in each child's scope. */
const NARRATION_CONTEXT = 'tui:subagent-narration'

/** Model-facing sentence asking a child to narrate its tool calls. */
const NARRATION_TEXT = 'Before each tool call, say in one short sentence what you are doing and why it serves the task, so your progress can be followed.'

/**
 * Half a step after `SUBAGENT_DELEGATION`: the entry sorts after every context
 * at that order and before the next integer.
 */
const NARRATION_ORDER_STEP = 0.5

/**
 * Register the narration entry on every in-process child agent this process
 * announces. A child is an agent whose session header or runtime options
 * record a delegation depth of at least one. The entry is removed when its
 * child is disposed and when the plugin's context is disposed.
 * @param ctx - plugin context that owns the listeners and the per-agent registrations.
 */
export function installSubagentNarration(ctx: Context): void {
  const fibers = new Map<Agent, ReturnType<Context['inject']>>()
  const disposeFiber = (fiber: ReturnType<Context['inject']>): Promise<void> => fiber.dispose().catch((error: unknown) => {
    ctx.logger.warn(`tui-app: subagent narration cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  ctx.on('agent/created', ({ agent }) => {
    if (delegationDepthOf(agent) === 0 || fibers.has(agent)) return
    fibers.set(agent, agent.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: NARRATION_CONTEXT,
        order: scope.systemPrompt.getContextOrder('SUBAGENT_DELEGATION') + NARRATION_ORDER_STEP,
        text: NARRATION_TEXT,
      })
    }))
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const fiber = fibers.get(agent)
    if (fiber === undefined) return
    fibers.delete(agent)
    void disposeFiber(fiber)
  })
  ctx.effect(() => async () => {
    const pending = [...fibers.values()]
    fibers.clear()
    await Promise.all(pending.map(disposeFiber))
  }, 'tui-app: subagent narration')
}
