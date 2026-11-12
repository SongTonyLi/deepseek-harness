---
kind: upgrade-guide
description: "Eight published package entry points stop exporting helper values that importers used."
---

# Eight package entry points stop exporting helper values

English | [中文](guide.zh.md)

## Change

Before, each package below exported helper values beside its plugin or service API. Now its entry drops the listed helpers. Cursor also changes its parsed `Config` fields from ordinary values to live references; plain input uses the new `Options` type. YAML keys and subscription authentication stay unchanged.

Affected: code that imports a listed name from the package entry. Such an import fails to typecheck (`has no exported member`) or fails at module link time (`does not provide an export named`). Rationale: [plugin entry value exports](../../../../.agents/notes/implemented/process/2026-11-04-plugin-entry-value-exports.md).

- `@deepseek-ai/dsh-llm-cursor`: `CursorAdapter`, `resolveAdapterOptions`, `FALLBACK_MODELS`, `createCursorOauthClient`, `harvestInstalledCursorLogin`, `readInstalledCursorSources`, `windowsUsernameFromEnv`, `buildCursorRun`, `buildMcpToolDefinitions`, `conversationFromOptions`, `createConnectFrameParser`, `decodeUnaryBody`, `frameConnectMessage`, `parseConnectEndStream`, `CURSOR_RECORD_KEY`, `DEFAULT_API_KEY_ENV`, `NS`, `PROVIDER`.
- `@deepseek-ai/dsh-sandbox-apple-container`: `isSandboxBackend`, `SANDBOX_BACKENDS`, `setSandboxBackend`, `containerSupported`, `executableResolves`, `resolveBackend`, `DEFAULT_ENV_DENYLIST`, `DEFAULT_HIDDEN_FILES`, `DEFAULT_HOST_BOUND_UNREADABLE_ROOTS`, `shimInvocation`.
- `@deepseek-ai/dsh-tool-skill`: `formatUnknownSkillError`, `unknownSkillLine`, `rankClosestCatalogNames`, `compareCatalogNames`, `levenshteinDistance`, `isSubsequenceOf`, `CLOSED_SKILL_CATALOG_LINE`, `CLOSED_SKILL_CATALOG_THIS_TURN`, `MAX_CLOSE_SKILL_DISTANCE`, `MAX_CLOSE_SKILL_SUGGESTIONS`, `MAX_LISTED_CATALOG_NAMES`, `UNKNOWN_SKILL_STREAK_LIMIT`.
- `@deepseek-ai/dsh-host-plugin-inventory`: `pluginFiberPhase`.
- `@deepseek-ai/dsh-user-questions`: `planReviewOptions`.
- `@deepseek-ai/dsh-tool-fs-search`: `searchFence`.
- `@deepseek-ai/dsh-tui-app`: `internals`.
- `@deepseek-ai/dsh-client-ui-secret-mask`: `maskCredentialText`. Its matcher modules moved to `@deepseek-ai/dsh-util-credential-mask`, so deep imports of `src/client/credential-*.ts` and `src/client/format-tables.ts` no longer resolve.

### Additive exports (no action needed)

- `@deepseek-ai/dsh-util-values`: `groupByPhase` and the type `PhaseGroup`.
- `@deepseek-ai/dsh-typert-protocol`: `parseRemoteRequest` and the type `RemoteRequestSchema`.

## Migration

1. `@deepseek-ai/dsh-llm-cursor`: stop constructing `CursorAdapter`. Mount the plugin through the Loader. Use `Options` for plain configuration objects; after schema parsing, read `Config` fields with `.get()`. The other removed helpers have no public replacement.
2. `@deepseek-ai/dsh-sandbox-apple-container`: set `backend` (`auto`, `container`, or `local`) in the `sandbox-apple-container` plugin config, or switch one session with `/sandbox container` or `/sandbox local`. The `DEFAULT_*` constants have no replacement; omit an option to keep its default.
3. `@deepseek-ai/dsh-tool-skill`: delete the imports. The `skill` tool behaves as before.
4. `@deepseek-ai/dsh-host-plugin-inventory`: read `fiberPhase` from the `entries` of the snapshot that `readPluginInventory()` resolves to, instead of mapping fiber state yourself.
5. `@deepseek-ai/dsh-user-questions`: `import { planReviewOptions } from '@deepseek-ai/dsh-user-questions/plan-review'`. The `PlanReviewOptions` type stays on the entry.
6. `@deepseek-ai/dsh-tool-fs-search` (`searchFence`) and `@deepseek-ai/dsh-tui-app` (`internals`): delete the imports. Normal use needs no replacement.
7. `@deepseek-ai/dsh-client-ui-secret-mask`: `maskCredentialText` is replaced by `createCredentialMasker()` from `@deepseek-ai/dsh-util-credential-mask`. Import it with `import { createCredentialMasker } from '@deepseek-ai/dsh-util-credential-mask'`, create one masker per owner with `const masker = createCredentialMasker()`, and call `masker.mask(text)`. Add that package as a dependency. It also exports the type `CredentialMasker` and the values `MASK`, `CredentialScanner`, and `formatTables`.
8. Confirm: your typecheck or build passes. A leftover import of a removed name fails with `has no exported member` (TypeScript) or `does not provide an export named` (Node ESM).
