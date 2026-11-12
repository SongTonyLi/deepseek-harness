/** Native HTTP/2 sessions are unavailable in a browser worker. */
import { notAvailableError } from '../../notImplementedFail.ts'

/**
 * Reject native HTTP/2 instead of simulating a successful connection.
 * @returns Never; a browser worker cannot create a native HTTP/2 session.
 */
export function connect(): never {
  throw notAvailableError('node:http2', 'connect')
}

/** CommonJS interop marker for the worker module loader. */
export const __esModule = true

/** CommonJS exports for the worker's explicit HTTP/2 refusal. */
export default { connect } satisfies Partial<typeof import('node:http2')>
