/**
 * Test helper: drive `ctx.llm.stream()` through a `BlockAssembler`.
 */
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { FinishReason, GenerateOptions, Message, TokenUsage } from '@deepseek-ai/dsh-llm'

export interface AssembledResult {
  message: Message
  usage?: TokenUsage
  finish: FinishReason
}

/**
 * Assemble one stream into a message, usage, and finish reason.
 * @param ctx - composed LLM context.
 * @param options - request without a required provider default of `cursor`.
 * @returns assembled result.
 */
export async function assemble(
  ctx: Context,
  options: Omit<GenerateOptions, 'provider'> & { provider?: string },
): Promise<AssembledResult> {
  const assembler = new BlockAssembler()
  const request = { provider: 'cursor', ...options }
  for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk)
  return {
    message: assembler.message({
      provider: request.provider,
      model: request.model,
      ...assembler.replayState === undefined ? {} : { replayState: assembler.replayState },
    }),
    ...assembler.usage !== undefined ? { usage: assembler.usage } : {},
    finish: assembler.finish,
  }
}
