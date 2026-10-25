import { describe, expect, it, vi } from 'vitest'
import { catalogModels } from '../src/catalog.ts'
import { getSupportedThinkingLevels } from '../src/models.ts'
import * as supplementModule from '../src/catalog-supplement.ts'

describe('catalog supplement', () => {
  it('adds a supplemental model the installed catalog lacks', () => {
    const sibling = catalogModels('openai-codex').get('gpt-6-astra')!
    const spy = vi.spyOn(supplementModule, 'supplementalCatalogModels').mockReturnValue([
      { ...sibling, id: 'gpt-unreleased', name: 'GPT Unreleased' },
    ])
    expect(catalogModels('openai-codex').get('gpt-unreleased')?.name).toBe('GPT Unreleased')
    spy.mockRestore()
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

  it('supplements the OpenRouter DeepSeek V4.1 Flash 1017 model with its listed pricing', () => {
    const model = catalogModels('openrouter').get('deepseek/deepseek-v4.1-flash-1017')
    expect(model).toMatchObject({
      id: 'deepseek/deepseek-v4.1-flash-1017',
      name: 'DeepSeek: DeepSeek V4.1 Flash (1017)',
      provider: 'openrouter',
      api: 'openai-completions',
      contextWindow: 1000000,
      cost: { input: 0.05, output: 0.6 },
      thinkingLevelMap: { off: 'none', high: 'high', max: 'max' },
    })
  })

  it('supplements the OpenRouter Kimi K3.1 Pro model with its listed pricing and efforts', () => {
    const model = catalogModels('openrouter').get('moonshotai/kimi-k3.1-pro')
    expect(model).toMatchObject({
      id: 'moonshotai/kimi-k3.1-pro',
      name: 'MoonshotAI: Kimi K3.1 Pro',
      provider: 'openrouter',
      api: 'openai-completions',
      contextWindow: 1048576,
      cost: { input: 2, output: 10, cacheRead: 0.2 },
      compat: { requiresReasoningContentOnAssistantMessages: true },
      thinkingLevelMap: { off: 'none', low: 'low', high: 'high', max: 'max' },
    })
    expect(getSupportedThinkingLevels(model!)).toEqual(['off', 'low', 'high', 'max'])
  })

  it('returns no supplemental models for a provider route the supplement does not extend', () => {
    expect(supplementModule.supplementalCatalogModels('deepseek')).toEqual([])
  })
})
