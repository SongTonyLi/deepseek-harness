/**
 * `/btw`: a temporary side agent seeded with the bound session's context. This
 * module builds the side agent's seed and its opening notice. It does not
 * create an Agent or draw a screen.
 * @module @deepseek-ai/dsh-tui-app/btw
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { buildForkSeed, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-shell'
import { appendDelegatedPolicyOverrides } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'

/**
 * Model-facing notice that opens every side agent's first turn. It follows
 * the inherited history, so the inherited request prefix stays unchanged.
 */
export const BTW_BRIEF = [
  'The conversation above belongs to a working agent that is still running in another session. You are a temporary side agent the user opened to ask questions about it.',
  'Answer the user\'s questions. Your tools are read-only: you can read files, search, and run commands in a read-only sandbox, and every write is refused and cannot be approved. The working agent owns changes to the workspace and does not see this conversation; describe a change in your answer instead of attempting it.',
  'Do not continue the working agent\'s task, and do not send it messages. Tool calls in the inherited history that end in an error saying the history does not include their result may have finished in the working session after this side agent was opened.',
].join('\n\n')

/** Default global tools a side agent may call: tools that only read. */
export const BTW_TOOLS: readonly string[] = [
  'read',
  'read_image',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'session_search',
  'session_trace',
  'session_event_search',
  'session_event_read',
  'session_event_trace',
  'skill',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'ask_user_question',
]

/** Default command tools a side agent may call inside the read-only sandbox. */
export const BTW_SANDBOXED_TOOLS: readonly string[] = ['bash', 'pwsh']

/** The tool names a side agent may call; see the `btwTools` and `btwSandboxedTools` config fields. */
export interface BtwToolPolicy {
  /** Global tools the side agent may call. */
  readonly btwTools: readonly string[]
  /** Command tools it may call only under a confining command executor. */
  readonly btwSandboxedTools: readonly string[]
}

/**
 * Make one unpublished side agent read-only, inside its creation window. Its
 * session gets the `read-only` sandbox mode and the `never` approval policy,
 * so a confined write fails and no prompt can widen it. Its scope then keeps
 * only the allowed global tools: every other one is hidden and refused at
 * execution. Command tools are allowed only when the composed command
 * executor confines commands. Allowed names this composition does not
 * register are skipped.
 * @param agentCtx - the side agent's scoped creation context.
 * @param agent - the unpublished side agent.
 * @param policy - the allowed tool names.
 */
export function restrictBtwAgent(agentCtx: Context, agent: Agent, policy: BtwToolPolicy): void {
  appendDelegatedPolicyOverrides(agent.session, { permissionPreset: undefined, sandboxMode: 'read-only', approvalPolicy: 'never' })
  const tools = agentCtx.get('tools')
  if (tools === undefined) return
  const confined = agentCtx.get('shell')?.sandboxMode !== undefined
  const allowed = [...policy.btwTools, ...confined ? policy.btwSandboxedTools : []]
  agentCtx.tools.restrict({ allow: allowed.filter(name => tools.get(name) !== undefined) })
}

/** The seed of one side agent: the working session's whole log, with its open tail closed. */
export interface BtwSeed {
  /** The copied events, then the fork marker and closers for an open turn; empty for an empty log. */
  readonly seed: readonly SessionEvent[]
  /** Copied source events, excluding the marker and closers. */
  readonly inheritedEventCount: SessionLogOffset
}

/**
 * Seed a side agent from every event the working session has logged so far,
 * including an unfinished turn. Unanswered tool calls in the open step get
 * the fork's error results; the working session is only read.
 * @param events - the working session's log, contiguous from seq 0.
 * @returns the seed, or an empty seed when the log is empty.
 */
export function btwSeed(events: readonly SessionEvent[]): BtwSeed {
  const last = events.at(-1)
  if (last === undefined) return { seed: [], inheritedEventCount: SessionLogOffset(0) }
  return { seed: buildForkSeed(events, last.seq), inheritedEventCount: SessionLogOffset(last.seq + 1) }
}

/**
 * The notice injected before a side agent's first question.
 * @returns a terminal notice carrying {@link BTW_BRIEF}.
 */
export function btwBriefMessage(): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: BTW_BRIEF }],
    source: { kind: 'tui-app', form: 'notice', summary: boundContextSummary('btw · side agent') },
  })
}
