/**
 * Scripted navigable blocks: the transcript as the keyboard sees it, without
 * a pi-tui tree behind it, so the pure walk and the reader can be driven
 * directly.
 */

import type { SectionPart, SectionSource, TurnGroup } from '../src/navigation.ts'

/**
 * One navigable block of a scripted transcript.
 * @param blockKind - which kind of block it is.
 * @param parts - its sections in reading order.
 * @param options - the turn it was appended in, and a tool's or context block's name.
 * @returns the block, as the keyboard sees it.
 */
export function source(
  blockKind: SectionSource['blockKind'],
  parts: readonly SectionPart[],
  options: { turn?: number; name?: string; title?: string } = {},
): SectionSource {
  const base = {
    navigable: true as const,
    turn: options.turn ?? 1,
    parts: () => parts,
    setHighlight: () => {},
  }
  switch (blockKind) {
    case 'user':
      return { ...base, blockKind: 'user' }
    case 'assistant':
      return { ...base, blockKind: 'assistant' }
    case 'tool':
      return { ...base, blockKind: 'tool', name: options.name ?? 'bash', title: options.title ?? '' }
    default:
      return { ...base, blockKind: 'context', title: options.title ?? 'system prompt' }
  }
}

/** Rows long enough that the reader has to scroll on any terminal a spec uses. */
export const REPLY_ROWS: readonly string[] = Array.from({ length: 40 }, (_, index) => `reply row ${String(index)}`)

/** A turn whose section the transcript no longer carries, which a session switch leaves behind. */
export const GONE: TurnGroup = {
  turn: 9,
  label: 'gone',
  markers: { context: 0, reasoning: false, reply: false, tools: 0 },
  sections: [{ block: 99, part: 0 }],
}

/**
 * A scripted transcript: one system prompt, then two prompts, the first
 * answered with reasoning, a long reply, and a tool call.
 * @returns the navigable blocks, oldest first.
 */
export function transcript(): SectionSource[] {
  return [
    source('context', [{ kind: 'system', rows: ['you are the agent'] }], { turn: 0, title: 'system prompt' }),
    source('user', [{ kind: 'user', rows: ['fix the fade at the top'] }], { turn: 0 }),
    source('assistant', [
      { kind: 'reasoning', rows: ['the tail is matched backwards'] },
      { kind: 'reply', rows: REPLY_ROWS },
    ], { turn: 1 }),
    source('tool', [
      { kind: 'call', rows: ['{"command":"git status"}'] },
      { kind: 'result', rows: ['clean tree'] },
    ], { turn: 1, name: 'bash', title: 'git status' }),
    source('user', [{ kind: 'user', rows: ['run the tests'] }], { turn: 1 }),
    source('assistant', [{ kind: 'reply', rows: ['all green'] }], { turn: 2 }),
  ]
}
