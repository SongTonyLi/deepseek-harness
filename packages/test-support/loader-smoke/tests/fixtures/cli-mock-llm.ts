import { appendFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { loadReplayScript, resolveScriptedEntry, type ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import {
  ToolCallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const HIGH = ReasoningEffortId('high')
const OFF = ReasoningEffortId('off')
const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'
const SHELL_COMMAND = process.platform === 'win32'
  ? "Write-Output 'CLI_TOOL_ROUND_TRIP'"
  : 'printf CLI_TOOL_ROUND_TRIP'
/** The whole summary a compaction request receives, short enough to shrink any shadowed span. */
const COMPACTION_SUMMARY = '## Primary Request and Intent\n- CLI_COMPACTION_SUMMARY'

/**
 * Keyless headless-agent adapter: one production shell call followed by a
 * final answer, and a fixed text summary for a compaction request.
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
    const last = options.messages.at(-1)
    const toolResult = last?.role === 'tool' ? last : undefined
    if (toolResult === undefined) {
      const reasoning = 'Inspecting the task before the tool call.'
      const args = JSON.stringify({ command: SHELL_COMMAND, description: 'Prove the CLI tool round trip.' })
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: reasoning }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 1, id: ToolCallId('cli-smoke-call'), name: SHELL_TOOL, argumentsDelta: args }
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('cli-smoke-call'), name: SHELL_TOOL, arguments: args } }
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
export const inject = ['llm']

/** Register the keyless `cli-mock` adapter. */
export function apply(ctx: Context): void {
  const adapter = new CliMockAdapter()
  ctx.llm.registerAdapter(['cli-mock'], adapter)
  ctx.effect(() => () => { adapter.assertReplayConsumed() }, 'CLI mock replay consumption')
  ctx.on('agent/request', async ({ step }, next) => {
    const config = await next()
    return step === 2 ? { ...config, reasoningEffort: OFF } : config
  })
}
