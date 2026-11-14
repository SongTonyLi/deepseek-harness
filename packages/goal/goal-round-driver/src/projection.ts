/**
 * The `goalRoundWorkspaceMutation` host-only projection unit: whether the last
 * closed turn recorded a successful edit, write, or bash result. The continue
 * notice reads this state instead of scanning the Session log, so a resumed
 * Session recovers the signal from the projection's checkpoint or fold.
 *
 * @module @deepseek-ai/dsh-goal-round-driver/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** Tool names whose successful results can change the workspace. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set(['edit', 'write', 'bash'])

/**
 * Fold state for one Session. A mutating call stays pending only from its
 * `tool/call` until its `tool/result`, and every turn boundary clears both
 * fields, so the state never grows with the log.
 */
interface WorkspaceMutationState {
  /** Whether the last closed turn recorded a successful mutating result; false before the first `turn/end`. */
  lastClosedTurnMutated: boolean
  /** Whether the open turn has recorded one so far. */
  openTurnMutated: boolean
  /** callIds of mutating calls in the open turn whose results have not landed. */
  pendingMutatingCallIds: string[]
}

const workspaceMutationStateSchema = z.object({
  lastClosedTurnMutated: z.boolean(),
  openTurnMutated: z.boolean(),
  pendingMutatingCallIds: z.array(z.string()),
})

/**
 * The `goalRoundWorkspaceMutation` unit registered on `ctx.sessionProjections`.
 * A result counts when its callId names a mutating call recorded in the same
 * turn that has not yet been answered; `turn/end` commits the turn's flag.
 * Exported so the spec can address the unit by its key.
 */
export const goalRoundWorkspaceMutationDefinition = {
  key: 'goalRoundWorkspaceMutation',
  stateVersion: 1,
  stateSchema: workspaceMutationStateSchema,
  init: () => ({ lastClosedTurnMutated: false, openTurnMutated: false, pendingMutatingCallIds: [] }),
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        if (!state.openTurnMutated && state.pendingMutatingCallIds.length === 0) return state
        return { ...state, openTurnMutated: false, pendingMutatingCallIds: [] }
      case 'tool/call': {
        const { callId, name } = event.data
        const pending = state.pendingMutatingCallIds.includes(callId)
        if (MUTATING_TOOLS.has(name)) {
          return pending ? state : { ...state, pendingMutatingCallIds: [...state.pendingMutatingCallIds, callId] }
        }
        // A non-mutating call that reuses a pending callId replaces the mutating call it names.
        return pending
          ? { ...state, pendingMutatingCallIds: state.pendingMutatingCallIds.filter(id => id !== callId) }
          : state
      }
      case 'tool/result': {
        const callId = event.data.message.source.callId
        if (!state.pendingMutatingCallIds.includes(callId)) return state
        return {
          ...state,
          openTurnMutated: state.openTurnMutated || event.data.message.isError !== true,
          pendingMutatingCallIds: state.pendingMutatingCallIds.filter(id => id !== callId),
        }
      }
      case 'turn/end':
        if (!state.openTurnMutated && !state.lastClosedTurnMutated && state.pendingMutatingCallIds.length === 0) {
          return state
        }
        return { lastClosedTurnMutated: state.openTurnMutated, openTurnMutated: false, pendingMutatingCallIds: [] }
      default:
        return state
    }
  },
  // Host-only: no `wire` block, so the state never reaches a client snapshot.
} satisfies ProjectionDefinition<'goalRoundWorkspaceMutation', WorkspaceMutationState>
