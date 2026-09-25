/**
 * One side question about a conversation that already exists. This builds a
 * tool-free model request from derived messages. It does not write a session,
 * call a model, or draw a screen.
 * @module @deepseek-ai/dsh-tui-app/btw
 */

import type { ContentBlock, GenerateOptions, Message, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/**
 * The system prompt for one side question. It is not the agent's prompt: the
 * answer stays in prose and does not continue the task or call a tool.
 */
export const BTW_POLICY = 'You answer one side question about the conversation above. You are not the agent in that conversation. You cannot call tools, edit files, or change that conversation. Answer the question in plain prose. Do not continue the agent\'s task and do not propose a tool call.'

/** The provider and model a side question is sent to. */
export interface AsideRoute {
  /** Registered provider route. */
  readonly provider: string
  /** Provider model id. */
  readonly model: string
  /** Adapter reasoning effort; omitted when the selected route has none. */
  readonly reasoningEffort?: ReasoningEffortId
}

/** A candidate route: the logged request header, or the terminal's current selection. */
export interface AsideRouteSource {
  /** Registered provider route; empty when nothing is selected. */
  readonly provider: string
  /** Provider model id; empty when nothing is selected. */
  readonly model: string
  /** Adapter reasoning effort, when that candidate carries one. */
  readonly reasoningEffort?: ReasoningEffortId
}

/**
 * The route a side question uses.
 * @param header - the bound session's logged request header, when it names a model.
 * @param fallback - the terminal's current selection, used only when `header` is missing.
 * @returns the preferred route, with `reasoningEffort` only when that route has one.
 * @throws {Error} when the chosen provider or model is empty (`btw: no model is selected`).
 */
export function asideRoute(header: AsideRouteSource | undefined, fallback: AsideRouteSource | undefined): AsideRoute {
  const chosen = header ?? fallback
  if (chosen === undefined || chosen.provider === '' || chosen.model === '') {
    throw new Error('btw: no model is selected')
  }
  return {
    provider: chosen.provider,
    model: chosen.model,
    ...chosen.reasoningEffort === undefined ? {} : { reasoningEffort: chosen.reasoningEffort },
  }
}

/** Where the last assistant message sits, and which of its tool calls a later result answers. */
interface TailAssistant {
  /** Index of the last assistant message. */
  index: number
  /** That message. */
  message: Extract<Message, { role: 'assistant' }>
  /** Tool-call ids answered by a tool result after that message. */
  resolved: ReadonlySet<ToolCallId>
}

/**
 * The last assistant message, and the tool-call ids answered after it.
 * @param messages - derived conversation messages, oldest first.
 * @returns that message and the ids of later tool results, or undefined when
 * the history has no assistant message.
 */
function tailAssistant(messages: readonly Message[]): TailAssistant | undefined {
  let tail: { index: number; message: TailAssistant['message'] } | undefined
  const resolved = new Set<ToolCallId>()
  for (const [index, message] of messages.entries()) {
    switch (message.role) {
      case 'assistant':
        tail = { index, message }
        resolved.clear()
        break
      case 'tool':
        resolved.add(message.toolCallId)
        break
      case 'system':
      case 'developer':
      case 'user':
        break
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default:
        assertNever(message, 'btw message role')
    }
  }
  return tail === undefined ? undefined : { ...tail, resolved }
}

/**
 * A provider-safe copy of derived history.
 *
 * Frozen inputs are not mutated. When the last assistant message contains
 * tool-call blocks with no later tool result, that message is structured-cloned
 * and only those unresolved blocks are dropped. The clone is omitted when it
 * then has no content. Earlier messages and resolved calls stay as they are.
 * @param messages - derived conversation messages, oldest first.
 * @returns a new array safe to send without an unresolved trailing tool call.
 */
export function asideHistory(messages: readonly Message[]): Message[] {
  const tail = tailAssistant(messages)
  if (tail === undefined) return [...messages]
  const unresolved = tail.message.content.some(block => block.type === 'tool-call' && !tail.resolved.has(block.id))
  if (!unresolved) return [...messages]
  const cloned = structuredClone(tail.message)
  const content = cloned.content.filter(block => block.type !== 'tool-call' || tail.resolved.has(block.id))
  const copy = [...messages]
  if (content.length === 0) copy.splice(tail.index, 1)
  else copy[tail.index] = { ...cloned, content }
  return copy
}

/**
 * One tool-free request for a side question.
 * @param input - the route, derived history, optional in-progress reply (blank text is left out), question, and cancellation signal.
 * @returns generation options with {@link BTW_POLICY}, temperature 0, and no tools.
 */
export function buildAsideOptions(input: {
  readonly route: AsideRoute
  readonly history: readonly Message[]
  readonly partial?: string
  readonly question: string
  readonly signal: AbortSignal
}): GenerateOptions {
  const partial = input.partial?.trim() ?? ''
  const messages: GenerateOptions['messages'] = [
    ...asideHistory(input.history),
    ...partial === '' ? [] : [createAssistantMessage({
      content: [{ type: 'text', text: partial }],
      source: { provider: input.route.provider, model: input.route.model },
    })],
    { role: 'user', content: [{ type: 'text', text: input.question }] },
  ]
  return {
    provider: input.route.provider,
    model: input.route.model,
    ...input.route.reasoningEffort === undefined ? {} : { reasoningEffort: input.route.reasoningEffort },
    system: BTW_POLICY,
    messages,
    temperature: 0,
    signal: input.signal,
  }
}

/**
 * Visible reply text, ignoring reasoning and every non-text block.
 * @param blocks - content blocks from one model response.
 * @returns text blocks joined by a blank line, skipping empty text, or `''` when none remain.
 */
export function asideVisibleText(blocks: readonly ContentBlock[]): string {
  const pieces: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text !== '') pieces.push(block.text)
  }
  return pieces.join('\n\n')
}
