/** Request-payload validation that refuses with the shared `gateway/bad-request` failure. */

import { RemoteError } from './remote-error.ts'

/**
 * The part of a schema library's `safeParse` that {@link parseRemoteRequest}
 * reads. Any object with that method qualifies, so this parameter does not
 * bind callers to one validation library's types.
 * @template T - the parsed output type.
 */
export interface RemoteRequestSchema<T> {
  /**
   * Parse one payload without throwing.
   * @param value - the payload as the wire carried it.
   * @returns the parsed output, or the refusal carrying the issues that failed it.
   */
  safeParse(value: unknown): RemoteRequestOutcome<T>
}

/** Either the parsed output or the refusal that carries the schema's issues. */
type RemoteRequestOutcome<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: { readonly issues: readonly object[] } }

/**
 * Parse the domain constraints that are more specific than generated TypeScript
 * codecs. An invalid payload fails as `gateway/bad-request`, so every owner
 * reports the same refusal shape.
 * @param method - the endpoint name, quoted in the failure message.
 * @param schema - the schema the payload must satisfy.
 * @param value - the payload as the wire carried it.
 * @returns the schema's parsed output.
 * @throws RemoteError with code `gateway/bad-request` when the payload fails the schema; `details.issues` carries the schema's issues.
 */
export function parseRemoteRequest<T>(method: string, schema: RemoteRequestSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new RemoteError('gateway/bad-request', `invalid payload for ${method}`, { issues: parsed.error.issues })
  }
  return parsed.data
}
