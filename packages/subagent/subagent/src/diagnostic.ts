/**
 * Byte budget shared by `SubagentResult.diagnostic` and the continuable
 * settlement notice's failure reason.
 *
 * @module @deepseek-ai/dsh-subagent/diagnostic
 */

/** Maximum UTF-8 size of `SubagentResult.diagnostic`. */
const MAX_SUBAGENT_DIAGNOSTIC_BYTES = 4_096

const DIAGNOSTIC_TRUNCATION_SUFFIX = '\n[diagnostic truncated]'
const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

/**
 * Limit failure detail without splitting a UTF-8 sequence.
 * @param diagnostic - safe diagnostic text produced by a provider or teardown.
 * @returns the original text, or a visibly truncated value within the limit.
 */
export function limitSubagentDiagnostic(diagnostic: string): string {
  const bytes = utf8Encoder.encode(diagnostic)
  if (bytes.byteLength <= MAX_SUBAGENT_DIAGNOSTIC_BYTES) return diagnostic

  const suffixBytes = utf8Encoder.encode(DIAGNOSTIC_TRUNCATION_SUFFIX).byteLength
  let prefixBytes = MAX_SUBAGENT_DIAGNOSTIC_BYTES - suffixBytes
  while (((bytes[prefixBytes] as number) & 0b1100_0000) === 0b1000_0000) {
    prefixBytes -= 1
  }
  return utf8Decoder.decode(bytes.subarray(0, prefixBytes))
    + DIAGNOSTIC_TRUNCATION_SUFFIX
}

/**
 * Apply the diagnostic byte budget and drop an empty result.
 * @param diagnostic - candidate failure detail, or absent.
 * @returns the limited text, or `undefined` when nothing remains to show.
 */
export function optionalSubagentDiagnostic(diagnostic: string | undefined): string | undefined {
  if (diagnostic === undefined || diagnostic.length === 0) return undefined
  return limitSubagentDiagnostic(diagnostic)
}
