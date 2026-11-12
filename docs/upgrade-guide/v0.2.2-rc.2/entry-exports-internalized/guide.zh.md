---
kind: upgrade-guide
description: "八个已发布的包入口停止导出使用者依赖的辅助值。"
---

# 八个包入口停止导出辅助值

[English](guide.md) | 中文

## 变更

此前，下列每个包在插件或服务 API 之外还导出辅助值。现在其入口移除所列辅助值。Cursor 还将解析后的 `Config` 字段从普通值改为动态引用；普通输入使用新增的 `Options` 类型。YAML 键与订阅认证保持不变。

受影响者：从包入口导入所列名称的代码。此类导入会在类型检查时报 `has no exported member`，或在模块链接时报 `does not provide an export named`。依据：[插件入口值导出](../../../../.agents/notes/implemented/process/2026-11-04-plugin-entry-value-exports.zh.md)。

- `@deepseek-ai/dsh-llm-cursor`：`CursorAdapter`、`resolveAdapterOptions`、`FALLBACK_MODELS`、`createCursorOauthClient`、`harvestInstalledCursorLogin`、`readInstalledCursorSources`、`windowsUsernameFromEnv`、`buildCursorRun`、`buildMcpToolDefinitions`、`conversationFromOptions`、`createConnectFrameParser`、`decodeUnaryBody`、`frameConnectMessage`、`parseConnectEndStream`、`CURSOR_RECORD_KEY`、`DEFAULT_API_KEY_ENV`、`NS`、`PROVIDER`。
- `@deepseek-ai/dsh-sandbox-apple-container`：`isSandboxBackend`、`SANDBOX_BACKENDS`、`setSandboxBackend`、`containerSupported`、`executableResolves`、`resolveBackend`、`DEFAULT_ENV_DENYLIST`、`DEFAULT_HIDDEN_FILES`、`DEFAULT_HOST_BOUND_UNREADABLE_ROOTS`、`shimInvocation`。
- `@deepseek-ai/dsh-tool-skill`：`formatUnknownSkillError`、`unknownSkillLine`、`rankClosestCatalogNames`、`compareCatalogNames`、`levenshteinDistance`、`isSubsequenceOf`、`CLOSED_SKILL_CATALOG_LINE`、`CLOSED_SKILL_CATALOG_THIS_TURN`、`MAX_CLOSE_SKILL_DISTANCE`、`MAX_CLOSE_SKILL_SUGGESTIONS`、`MAX_LISTED_CATALOG_NAMES`、`UNKNOWN_SKILL_STREAK_LIMIT`。
- `@deepseek-ai/dsh-host-plugin-inventory`：`pluginFiberPhase`。
- `@deepseek-ai/dsh-user-questions`：`planReviewOptions`。
- `@deepseek-ai/dsh-tool-fs-search`：`searchFence`。
- `@deepseek-ai/dsh-tui-app`：`internals`。
- `@deepseek-ai/dsh-client-ui-secret-mask`：`maskCredentialText`。其匹配器模块已迁入 `@deepseek-ai/dsh-util-credential-mask`，因此深层导入 `src/client/credential-*.ts` 与 `src/client/format-tables.ts` 不再能解析。

### 新增导出（无需操作）

- `@deepseek-ai/dsh-util-values`：`groupByPhase` 以及类型 `PhaseGroup`。
- `@deepseek-ai/dsh-typert-protocol`：`parseRemoteRequest` 以及类型 `RemoteRequestSchema`。

## 迁移

1. `@deepseek-ai/dsh-llm-cursor`：停止构造 `CursorAdapter`。通过 Loader 挂载插件。普通配置对象使用 `Options`；经过 schema 解析后，使用 `.get()` 读取 `Config` 字段。其余已移除的辅助值没有公开替代。
2. `@deepseek-ai/dsh-sandbox-apple-container`：在 `sandbox-apple-container` 插件配置中设置 `backend`（`auto`、`container` 或 `local`），或用 `/sandbox container` 或 `/sandbox local` 切换单个会话。`DEFAULT_*` 常量没有替代；省略某个选项即可保留其默认值。
3. `@deepseek-ai/dsh-tool-skill`：删除这些导入。`skill` 工具的行为不变。
4. `@deepseek-ai/dsh-host-plugin-inventory`：读取 `readPluginInventory()` 所解析的快照中 `entries` 的 `fiberPhase`，不要自行映射 fiber 状态。
5. `@deepseek-ai/dsh-user-questions`：`import { planReviewOptions } from '@deepseek-ai/dsh-user-questions/plan-review'`。`PlanReviewOptions` 类型仍保留在入口上。
6. `@deepseek-ai/dsh-tool-fs-search`（`searchFence`）与 `@deepseek-ai/dsh-tui-app`（`internals`）：删除这些导入。常规使用无需替代。
7. `@deepseek-ai/dsh-client-ui-secret-mask`：`maskCredentialText` 由 `@deepseek-ai/dsh-util-credential-mask` 中的 `createCredentialMasker()` 取代。使用 `import { createCredentialMasker } from '@deepseek-ai/dsh-util-credential-mask'` 导入，为每个持有者用 `const masker = createCredentialMasker()` 创建一个 masker，并调用 `masker.mask(text)`。将该包加为依赖。它还导出类型 `CredentialMasker`，以及值 `MASK`、`CredentialScanner` 与 `formatTables`。
8. 确认：类型检查或构建通过。残留的已移除名称导入会报 `has no exported member`（TypeScript）或 `does not provide an export named`（Node ESM）。
