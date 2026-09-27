import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { catalogModels } from '../src/catalog.ts'
import * as supplementModule from '../src/catalog-supplement.ts'

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {})
  return ctx
}

describe('catalog supplement', () => {
  it('adds GPT-6 Luna and Sol to openai-codex until pi-ai ships them', () => {
    const ids = [...catalogModels('openai-codex').keys()]
    expect(ids).toContain('gpt-6-luna')
    expect(ids).toContain('gpt-6-sol')
    expect(catalogModels('openai-codex').get('gpt-6-luna')).toMatchObject({
      name: 'GPT-6 Luna',
      contextWindow: 1_050_000,
      input: ['text', 'image'],
    })
  })

  it('adds GPT-6 Luna and Sol to the openai API route', () => {
    expect([...catalogModels('openai').keys()]).toEqual(
      expect.arrayContaining(['gpt-6-luna', 'gpt-6-sol']),
    )
  })

  it('adds Claude Opus 5.5 to anthropic until pi-ai ships it', () => {
    expect(catalogModels('anthropic').get('claude-opus-5-5')).toMatchObject({
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      contextWindow: 1_000_000,
    })
  })

  it('surfaces supplemental codex models through catalog discovery', async () => {
    const ctx = await harness()
    const discovered = await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai-codex' })
    expect(discovered.map(model => model.id)).toEqual(
      expect.arrayContaining(['gpt-6-luna', 'gpt-6-sol']),
    )
  })

  it('does not replace an installed catalog id when the supplement repeats it', () => {
    const installed = catalogModels('openai-codex').get('gpt-6-astra')
    expect(installed).toBeDefined()
    const spy = vi.spyOn(supplementModule, 'supplementalCatalogModels').mockReturnValue([
      { ...installed!, name: 'Supplement duplicate' },
    ])
    expect(catalogModels('openai-codex').get('gpt-6-astra')?.name).toBe('GPT-6 Astra')
    spy.mockRestore()
  })

  it('returns no supplemental models for a provider route the supplement does not extend', () => {
    expect(supplementModule.supplementalCatalogModels('deepseek')).toEqual([])
  })
})
