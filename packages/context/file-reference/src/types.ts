/**
 * Public file-reference discovery records. This module contains types only so
 * generated Remote clients can consume it without Host runtime code.
 * @module @deepseek-ai/dsh-file-reference/types
 */

/** One path-only completion candidate for a user-facing path. */
export interface FileReferenceCandidate {
  /** User-facing path accepted by normal prompts and filesystem tools. */
  path: string
  /** Directories keep completion open; files finish the mention. */
  kind: 'file' | 'directory'
}
