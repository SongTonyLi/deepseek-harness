/**
 * Slash-command completion for the editor: `/` at the start of the message
 * opens the command list, and typing narrows it by prefix.
 * @module @deepseek-ai/dsh-tui-app/completion
 */

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from '@earendil-works/pi-tui'

/** One completable command. */
export interface CompletableCommand {
  /** The name without the leading slash. */
  name: string
  description: string
}

/**
 * Build the provider over a live command source, so commands registered
 * after startup appear without re-creating the editor.
 * @param commands - returns the currently available commands.
 * @returns the editor's autocomplete provider.
 */
export function slashCommandCompletion(commands: () => readonly CompletableCommand[]): AutocompleteProvider {
  return {
    triggerCharacters: ['/'],
    getSuggestions(lines, cursorLine, cursorCol): Promise<AutocompleteSuggestions | null> {
      const line = lines[cursorLine] ?? ''
      const before = line.slice(0, cursorCol)
      // Only the first token of the first line is a command.
      if (cursorLine !== 0 || !before.startsWith('/') || /\s/u.test(before)) return Promise.resolve(null)
      const prefix = before
      const items: AutocompleteItem[] = commands()
        .filter(command => `/${command.name}`.startsWith(prefix))
        .map(command => ({ value: `/${command.name}`, label: `/${command.name}`, description: command.description }))
      return Promise.resolve(items.length === 0 ? null : { items, prefix })
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
