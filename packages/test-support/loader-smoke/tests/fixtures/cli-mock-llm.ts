import { appendFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { loadReplayScript, resolveScriptedEntry, type ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import {
  ToolCallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type RequestMessage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'

const HIGH = ReasoningEffortId('high')
const OFF = ReasoningEffortId('off')
const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'
const SHELL_COMMAND = process.platform === 'win32'
  ? "Write-Output 'CLI_TOOL_ROUND_TRIP'"
  : 'printf CLI_TOOL_ROUND_TRIP'
/** The whole summary a compaction request receives, short enough to shrink any shadowed span. */
const COMPACTION_SUMMARY = '## Primary Request and Intent\n- CLI_COMPACTION_SUMMARY'
/** The model-facing name of the delegation tool the shipped profiles compose. */
const DELEGATION_TOOL = 'subagent'
/** Text in a delegated prompt that tells this mock it is answering the child, which makes the shell call. */
const DELEGATED_MARKER = 'CLI_DELEGATED_SHELL_CALL'
/** The model-facing name of the workflow tool the shipped profiles compose. */
const WORKFLOW_TOOL = 'workflow'
/** Text in a workflow child's prompt that tells this mock it is answering that child. */
const WORKFLOW_MARKER = 'CLI_WORKFLOW_CHILD'
/** The text every workflow child replies with. */
const WORKFLOW_CHILD_REPLY = 'CLI_WORKFLOW_CHILD_OK'
/** The model-facing name of the todo tool the shipped profiles compose. */
const TODO_TOOL = 'todo_write'
/** The list the todo hook writes: one item of each status. */
const TODO_LIST = [
  { content: 'Read the CLI round trip', status: 'completed' },
  { content: 'Write the CLI todo list', status: 'in_progress' },
  { content: 'Check the CLI todos page', status: 'pending' },
]

/**
 * Whether the conversation is a delegated child or has already delegated.
 * @param messages - the request's conversation.
 * @returns true when a user message carries the delegation marker or an
 * assistant message already called the delegation tool.
 */
function delegationHandled(messages: readonly RequestMessage[]): boolean {
  return messages.some(message => message.content.some(block =>
    (message.role === 'user' && block.type === 'text' && block.text.includes(DELEGATED_MARKER))
    || (message.role === 'assistant' && block.type === 'tool-call' && block.name === DELEGATION_TOOL)))
}

/**
 * Whether the conversation belongs to a workflow child or has already called the workflow tool.
 * @param messages - the request's conversation.
 * @returns which of the two applies, or undefined for neither.
 */
function workflowRole(messages: readonly RequestMessage[]): 'child' | 'called' | undefined {
  if (messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text.includes(WORKFLOW_MARKER)))) return 'child'
  if (messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'tool-call' && block.name === WORKFLOW_TOOL))) return 'called'
  return undefined
}

/**
 * The tool call a conversation without a tool result makes.
 * @param workflow - whether the workflow hook selects the `workflow` tool.
 * @param messages - the request's conversation, read by the delegation hook.
 * @returns the tool name and its JSON arguments.
 */
function firstToolCall(workflow: boolean, messages: readonly RequestMessage[]): { tool: string; args: string } {
  if (workflow) {
    return {
      tool: WORKFLOW_TOOL,
      args: JSON.stringify({
        meta: { name: 'cli-mock-workflow', description: 'One child for the CLI round trip' },
        script: `phase('Run')\nconst reply = await agent('Reply for the CLI workflow. ${WORKFLOW_MARKER}')\nreturn { reply }`,
      }),
    }
  }
  if (process.env.DSH_CLI_MOCK_TODOS === '1'
    && !messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'tool-call' && block.name === TODO_TOOL))) {
    return { tool: TODO_TOOL, args: JSON.stringify({ todos: TODO_LIST }) }
  }
  if (process.env.DSH_CLI_MOCK_DELEGATE === '1' && !delegationHandled(messages)) {
    return { tool: DELEGATION_TOOL, args: JSON.stringify({ description: 'Delegated shell call', prompt: `Make the CLI shell call. ${DELEGATED_MARKER}` }) }
  }
  return {
    tool: SHELL_TOOL,
    args: JSON.stringify({
      command: process.env.DSH_CLI_MOCK_SHELL_COMMAND ?? SHELL_COMMAND,
      description: 'Prove the CLI tool round trip.',
      ...process.env.DSH_CLI_MOCK_SHELL_BACKGROUND === '1' ? { run_in_background: true } : {},
    }),
  }
}

/**
 * Keyless headless-agent adapter: one production shell call followed by a
 * final answer, and a fixed text summary for a compaction request.
 *
 * Test hooks, each inert while its variable is unset:
 * - `DSH_CLI_MOCK_SHELL_COMMAND` is the command the shell call runs, in place
 *   of the round-trip marker command.
 * - `DSH_CLI_MOCK_SHELL_BACKGROUND=1` makes the shell call with
 *   `run_in_background: true`.
 * - `DSH_CLI_MOCK_DELEGATE=1` makes a conversation that has not delegated yet
 *   call the `subagent` tool instead, with a prompt carrying
 *   {@link DELEGATED_MARKER}; the child, whose conversation carries the
 *   marker, makes the shell call. Later turns of the delegating conversation
 *   make the shell call themselves.
 * - `DSH_CLI_MOCK_TODOS=1` makes a conversation that has not called the
 *   `todo_write` tool yet call it with {@link TODO_LIST}; the tool result then
 *   gets the ordinary round-trip reply.
 * - `DSH_CLI_MOCK_WORKFLOW=1` makes a conversation that has not called the
 *   `workflow` tool yet call it with a script that starts one child whose
 *   prompt carries {@link WORKFLOW_MARKER}; that child replies
 *   {@link WORKFLOW_CHILD_REPLY}, and the tool result then gets the ordinary
 *   round-trip reply.
 */
class CliMockAdapter extends LlmAdapter {
  private readonly replay: ReplayEntry[] | undefined
  private malformedReviewSent = false

  constructor() {
    super()
    const file = process.env.DSH_TUI_SNAPSHOT_SESSION
    this.replay = file === undefined ? undefined : loadReplayScript({ file })
  }

  assertReplayConsumed(): void {
    if (this.replay !== undefined && this.replay.length !== 0) throw new Error('CLI mock left recorded model calls unconsumed')
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: OFF, name: 'Off' },
          { id: HIGH, name: 'High' },
        ],
        defaultEffort: HIGH,
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (process.env.DSH_CLI_MOCK_FAILURE === '1') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'CLI mock provider failed' } } }
      return
    }
    if (options.system?.startsWith('REVIEW_POLICY\n')) {
      if (process.env.DSH_CLI_MOCK_REJECT_REVIEW_TEMPERATURE === '1' && options.temperature !== undefined) {
        yield { type: 'finish', reason: { kind: 'error', failure: {
          code: 'PI_AI_ERROR', message: 'Codex error: Unsupported parameter: temperature',
        } } }
        return
      }
      const trace = process.env.DSH_CLI_MOCK_REVIEW_TRACE
      if (trace !== undefined) appendFileSync(trace, 'reviewed\n', { mode: 0o600 })
      const malformed = process.env.DSH_CLI_MOCK_MALFORMED_REVIEW_ONCE === '1' && !this.malformedReviewSent
      this.malformedReviewSent ||= malformed
      const verdict = malformed
        ? 'The pending bash call only prints a project-local marker.'
        : '{"risk":"low","decision":"allow"}'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: verdict }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: verdict } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (options.purpose === 'compaction') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: COMPACTION_SUMMARY }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: COMPACTION_SUMMARY } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (this.replay !== undefined) {
      const entry = this.replay.shift()
      if (entry === undefined) throw new Error('CLI mock exhausted the recorded model script')
      const resolved = resolveScriptedEntry(entry, options.messages)
      if (resolved.kind !== 'chunks') throw new Error('CLI mock requires recorded successful model chunks')
      yield* resolved.chunks
      return
    }
    const workflow = process.env.DSH_CLI_MOCK_WORKFLOW === '1' ? workflowRole(options.messages) : 'called'
    if (workflow === 'child') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: WORKFLOW_CHILD_REPLY }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: WORKFLOW_CHILD_REPLY } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const last = options.messages.at(-1)
    const toolResult = last?.role === 'tool' ? last : undefined
    if (toolResult === undefined) {
      const reasoning = 'Inspecting the task before the tool call.'
      const { tool, args } = firstToolCall(workflow === undefined, options.messages)
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: reasoning }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 1, id: ToolCallId('cli-smoke-call'), name: tool, argumentsDelta: args }
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('cli-smoke-call'), name: tool, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const toolText = toolResult.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const reply = `CLI tool round trip complete: ${toolText.trim()}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5, reasoningTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'cli-mock-llm'
export const inject = ['llm', 'tools']

/** Register the keyless `cli-mock` adapter and select `off` effort for the step after a tool call. */
export function apply(ctx: Context): void {
  const adapter = new CliMockAdapter()
  ctx.llm.registerAdapter(['cli-mock'], adapter)
  ctx.effect(() => () => { adapter.assertReplayConsumed() }, 'CLI mock replay consumption')
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    const current = exec.agent === undefined ? undefined : exec.agent.model.current()
    if (exec.agent !== undefined && current !== undefined) {
      exec.agent.model.select({ provider: current.provider, model: current.model, reasoningEffort: OFF })
    }
    return result
  })
}
