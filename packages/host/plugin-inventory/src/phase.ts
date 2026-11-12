/**
 * Projection of Cordis Fiber states to the inventory's public phase vocabulary.
 * The terminal `/plugins` rows apply the same mapping in their own package.
 */

import type { FiberState } from '@deepseek-ai/cordis'
import type { PluginFiberPhase } from './types.ts'

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

/**
 * Project an optional Cordis fiber state to the inventory's public phase.
 * @param state - state of the entry's root fiber, if present.
 * @returns its public phase, or null when no live fiber exists.
 */
export function pluginFiberPhase(state: FiberState | undefined): PluginFiberPhase {
  return state === undefined ? null : FIBER_PHASE[state]
}
