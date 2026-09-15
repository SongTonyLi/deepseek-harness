/**
 * Editor completion: `/` at the start of the message opens the command list,
 * and `@` anywhere offers workspace paths and other sessions as references,
 * inserted in the same mention grammar the browser composer uses.
 * @module @deepseek-ai/dsh-tui-app/completion
 */

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from '@earendil-works/pi-tui'
import { activeAtToken } from '@deepseek-ai/dsh-file-reference'

/** One completable command. */
export interface CompletableCommand {
  /** The name without the leading slash. */
  name: string
  description: string
}

/** One `@` reference the editor can insert. */
export interface ReferenceItem {
  /** The exact text that replaces the typed `@` token. */
  mention: string
  label: string
  description?: string
}

/** Sources the completion provider queries. */
export interface CompletionSources {
  /** The currently available commands. */
  commands(): readonly CompletableCommand[]
  /**
   * References matching the text after `@`.
   * @param query - the typed text after `@`, without quotes.
   * @param quoted - whether the token opened with `@"`.
   * @param signal - cancels a superseded request.
   */
  references(query: string, quoted: boolean, signal: AbortSignal): Promise<readonly ReferenceItem[]>
}

/**
 * Build the provider over live sources, so commands and references registered
 * after startup appear without re-creating the editor.
 * @param sources - the command and reference sources.
 * @returns the editor's autocomplete provider.
 */
export function editorCompletion(sources: CompletionSources): AutocompleteProvider {
  return {
    triggerCharacters: ['/', '@'],
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const line = lines[cursorLine] ?? ''
      const before = line.slice(0, cursorCol)
      const at = activeAtToken(line, cursorCol)
      if (at !== undefined) {
        const references = await sources.references(at.query, at.quoted, options.signal)
        const items: AutocompleteItem[] = references.map(reference => ({
          value: reference.mention,
          label: reference.label,
          ...reference.description === undefined ? {} : { description: reference.description },
        }))
        return items.length === 0 ? null : { items, prefix: at.prefix }
      }
      // Only the first token of the first line is a command.
      if (cursorLine !== 0 || !before.startsWith('/') || /\s/u.test(before)) return null
      const prefix = before
      const items: AutocompleteItem[] = sources.commands()
        .filter(command => `/${command.name}`.startsWith(prefix))
        .map(command => ({ value: `/${command.name}`, label: `/${command.name}`, description: command.description }))
      return items.length === 0 ? null : { items, prefix }
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const line = lines[cursorLine] ?? ''
      const start = cursorCol - prefix.length
      const replaced = `${line.slice(0, start)}${item.value} ${line.slice(cursorCol)}`
      const next = [...lines]
      next[cursorLine] = replaced
      return { lines: next, cursorLine, cursorCol: start + item.value.length + 1 }
    },
  }
}
