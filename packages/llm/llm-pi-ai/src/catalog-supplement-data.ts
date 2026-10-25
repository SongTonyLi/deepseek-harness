/** Models the installed pi-ai catalog has not shipped yet; see catalog-supplement.ts. */
import type { Api, Model } from '@earendil-works/pi-ai'

/** Supplemental catalog models keyed by provider route, then model id. */
export const CATALOG_SUPPLEMENT: Readonly<Record<string, Readonly<Record<string, Model<Api>>>>> = {
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
    'moonshotai/kimi-k3.1-pro': {
      id: 'moonshotai/kimi-k3.1-pro',
      name: 'MoonshotAI: Kimi K3.1 Pro',
      api: 'openai-completions',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
      contextWindow: 1048576,
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
