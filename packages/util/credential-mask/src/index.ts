/**
 * Credential recognition and display masking for user text: the linear
 * scanner, its format tables, and the masked display text that the browser
 * and the terminal draw. The input text is never changed.
 *
 * @module @deepseek-ai/dsh-util-credential-mask
 */

import { CredentialScanner } from './credential-scanner.ts'
import { formatTables } from './format-tables.ts'

export { MASK } from './credential-masks.ts'
export { CredentialScanner } from './credential-scanner.ts'
export { formatTables } from './format-tables.ts'

/**
 * Draws the display form of user text. An owner creates one with
 * {@link createCredentialMasker} and passes it to the code that draws text.
 */
export interface CredentialMasker {
  /**
   * Draw recognized credentials masked, as the browser draws sent user text.
   * The input is never changed: copy, export, and model requests keep the original.
   * @param text - the user text to draw.
   * @returns the display text; line breaks stay in place and each credential keeps its provider prefix.
   */
  mask(text: string): string
}

/**
 * Create a masker that owns one scanner. The scanner memoizes the text it last
 * drew, so an owner creates one masker and reuses it for every draw.
 * @returns a masker with its own scanner; no draw state is shared between maskers.
 */
export function createCredentialMasker(): CredentialMasker {
  const scanner = new CredentialScanner(formatTables())
  return {
    mask(text: string): string {
      let shown = ''
      let from = 0
      let node = scanner.match(text, from)
      while (node !== undefined && node.end > from) {
        shown += text.slice(from, node.start) + node.data.masked
        from = node.end
        node = scanner.match(text, from)
      }
      return shown + text.slice(from)
    },
  }
}
