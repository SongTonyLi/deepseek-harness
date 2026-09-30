import { describe, expect, it, vi } from 'vitest'
import { catalogModels } from '../src/catalog.ts'
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

  it('returns no supplemental models for a provider route the supplement does not extend', () => {
    expect(supplementModule.supplementalCatalogModels('deepseek')).toEqual([])
  })
})
