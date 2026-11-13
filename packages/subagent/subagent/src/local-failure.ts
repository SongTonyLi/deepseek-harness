/**
 * Parent-facing text for a local child epoch that ends as an error.
 *
 * @module @deepseek-ai/dsh-subagent/local-failure
 */

/** Maximum UTF-8 size of a local failure diagnostic, matching provider diagnostics. */
const MAX_DIAGNOSTIC_BYTES = 4_096

const DIAGNOSTIC_TRUNCATION_SUFFIX = '\n[diagnostic truncated]'
const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

/** One child LLM route named in a failure diagnostic. */
export interface ChildFailureRoute {
  /** Registered provider id the child was using. */
  readonly provider: string
  /** Provider-owned model id the child was using. */
  readonly model: string
}

/**
 * Limit diagnostic text without splitting a UTF-8 sequence.
 * @param diagnostic - the formatted failure sentence.
 * @returns the original text, or a visibly truncated value within the limit.
 */
function limitDiagnostic(diagnostic: string): string {
  const bytes = utf8Encoder.encode(diagnostic)
  if (bytes.byteLength <= MAX_DIAGNOSTIC_BYTES) return diagnostic

  const suffixBytes = utf8Encoder.encode(DIAGNOSTIC_TRUNCATION_SUFFIX).byteLength
  let prefixBytes = MAX_DIAGNOSTIC_BYTES - suffixBytes
  while (((bytes[prefixBytes] as number) & 0b1100_0000) === 0b1000_0000) {
    prefixBytes -= 1
  }
  return utf8Decoder.decode(bytes.subarray(0, prefixBytes)) + DIAGNOSTIC_TRUNCATION_SUFFIX
}

/**
 * Replace credential-like spans. The route and failure code stay outside this text.
 * @param message - failure message that may quote a bearer token, key, or assignment.
 * @returns the message with each matched span replaced by `[redacted]`.
 */
function redactCredentials(message: string): string {
  return message
    .replace(/\bBearer\s+\S+/gi, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|secret)\b\s*[:=]\s*\S+/gi, '[redacted]')
}

/**
 * Format the route, stable code, and redacted message for one local child failure.
 * Request ids and cause chains are not accepted here. The result is at most 4096 UTF-8 bytes.
 * @param route - the route the child was using; omission means the child had no route.
 * @param code - stable failure code from the turn or the live error.
 * @param message - the failure's own message, before redaction.
 * @returns the diagnostic sentence included in the parent notice and the activation result.
 */
export function childFailureDiagnostic(
  route: ChildFailureRoute | undefined,
  code: string,
  message: string,
): string {
  const head = route === undefined
    ? `Child turn failed (${code})`
    : `Child route ${route.provider}/${route.model} failed (${code})`
  const detail = redactCredentials(message)
  return limitDiagnostic(detail.length === 0 ? `${head}.` : `${head}: ${detail}`)
}
