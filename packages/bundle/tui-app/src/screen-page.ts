/**
 * What a page that takes the whole terminal implements. The application
 * shows one such page at a time on the alternate screen, gives it every key,
 * redraws it when the session changes, and keeps the spinner tick running
 * exactly while the page reports motion. `Esc` and `q` close every page.
 * @module @deepseek-ai/dsh-tui-app/screen-page
 */

import type { SubagentChoice } from './catalog.ts'
import type { TeamBrowseRow } from './team.ts'

/**
 * The narrowest legend step of every full-screen page: the keys that close
 * it. Each page's legend ends in this step, so a terminal too narrow for the
 * rest still names the way back.
 */
export const PAGE_CLOSE_HINT = 'Esc q closes'

/** What a key asks the application to do. */
export type ScreenPageAction =
  /** Leave the page and give the conversation its screen back. */
  | { readonly kind: 'close' }
  /** Leave the page and open this teammate's session, as `/team` does. */
  | { readonly kind: 'open'; readonly entry: TeamBrowseRow; readonly choice: SubagentChoice }

/** One page drawn on the alternate screen. */
export interface ScreenPage {
  /**
   * Answer one key.
   * @param data - the raw key bytes.
   * @returns what the application should do, or undefined when the page handled the key itself and only needs a redraw.
   */
  handleInput(data: string): ScreenPageAction | undefined
  /**
   * Draw the page.
   * @param width - the terminal columns.
   * @param rows - the terminal rows.
   * @returns exactly `rows` lines, each fitting `width`.
   */
  render(width: number, rows: number): string[]
  /**
   * Whether the frame {@link ScreenPage.render} last returned differs from the
   * one the next spinner tick would draw.
   * @returns true while the page draws a spinner or an unsettled transition.
   */
  animates(): boolean
}
