/** Models the installed pi-ai catalog has not shipped yet; see catalog-supplement.ts. */
import type { Api, Model } from '@earendil-works/pi-ai'

/** Supplemental catalog models keyed by provider route, then model id. */
export const CATALOG_SUPPLEMENT: Readonly<Record<string, Readonly<Record<string, Model<Api>>>>> = {
  anthropic: {
    'claude-haiku-5-5': {
      id: 'claude-haiku-5-5',
      name: 'Claude Haiku 5.5',
      api: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      reasoning: true,
      input: ['text', 'image'],
      cost: {
        input: 0.1,
        output: 0.5,
        cacheRead: 0.01,
        cacheWrite: 0.125,
        tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
      },
      contextWindow: 1000000,
      maxTokens: 128000,
      compat: {
        supportsMidConvoEffort: true,
        supportsMidConvoSystemMessages: true,
        supportsMidConvoToolChanges: true,
        forceAdaptiveThinking: true,
        supportsStrictTools: true,
      },
      thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
      promptCache: { short: 300, long: 3600 },
      inputLimits: {
        maxRequestBytes: 33554432,
        images: {
          maxPerRequest: 600,
          resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 },
        },
      },
      type: 'chat',
    },
  },
  openrouter: {
    'deepseek/deepseek-v4.1-flash-1017': {
      id: 'deepseek/deepseek-v4.1-flash-1017',
      name: 'DeepSeek: DeepSeek V4.1 Flash (1017)',
      api: 'openai-completions',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0.05, output: 0.6, cacheRead: 0.006, cacheWrite: 0 },
      contextWindow: 1000000,
      maxTokens: 943718,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: 'openrouter',
        supportsStrictMode: true,
        sendSessionAffinityHeaders: true,
        requiresReasoningContentOnAssistantMessages: true,
      },
      thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
      inputLimits: {
        images: {
          resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 },
        },
      },
      type: 'chat',
    },
  },
}
