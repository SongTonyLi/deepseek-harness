/**
 * Terminal projection of Cordis Fiber states to the plugin inventory's public
 * phase vocabulary, so the `/plugins` rows report the same phase as the
 * inventory gateway. The table mirrors `@deepseek-ai/dsh-host-plugin-inventory`.
 */

import type { FiberState } from '@deepseek-ai/cordis'
import type { PluginFiberPhase } from '@deepseek-ai/dsh-host-plugin-inventory/types'

/**
 * Public phase per Cordis Fiber state value. `satisfies` requires an entry for
 * every state, so a new state fails the type check here.
 */
const PHASE_BY_FIBER_STATE = {
  0: 'pending', // PENDING
  1: 'loading', // LOADING
  2: 'active', // ACTIVE
  3: 'failed', // FAILED
  4: null, // DISPOSED
  5: 'unloading', // UNLOADING
} as const satisfies Record<FiberState, PluginFiberPhase>

/**
 * Project an optional Cordis fiber state to the inventory's public phase.
 * @param state - state of the entry's root fiber, if present.
 * @returns its public phase, or null when no live fiber exists.
 */
export function pluginFiberPhase(state: FiberState | undefined): PluginFiberPhase {
  return state === undefined ? null : PHASE_BY_FIBER_STATE[state]
}
