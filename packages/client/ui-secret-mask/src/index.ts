/**
 * Credential display masking plugin, node half. Pure UI plugin: the empty
 * apply exists so the plugin appears in the host cordis.yml / Loader; the
 * browser half ships via exports["./client"], discovered through the
 * package.json `dsh.client` declaration. The node half also exports
 * {@link maskCredentialText}, the same matcher for the terminal surface.
 */

import { CredentialScanner } from './client/credential-scanner.ts'
import { formatTables } from './client/format-tables.ts'

/** Host plugin body — no host-side behavior for this display plugin. */
export function apply(): void {}

let scanner: CredentialScanner | undefined

/**
 * Draw recognized credentials masked, as the browser draws sent user text.
 * The input is never changed: copy, export, and model requests keep the original.
 * @param text - the user text to draw.
 * @returns the display text; line breaks stay in place and each credential keeps its provider prefix.
 */
export function maskCredentialText(text: string): string {
  scanner ??= new CredentialScanner(formatTables())
  let shown = ''
  let from = 0
  let node = scanner.match(text, from)
  while (node !== undefined && node.end > from) {
    shown += text.slice(from, node.start) + node.data.masked
    from = node.end
    node = scanner.match(text, from)
  }
  return shown + text.slice(from)
}
