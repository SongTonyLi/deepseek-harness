---
kind: upgrade-guide
description: "Model-switch and manual compaction use the selected model instead of the previous request model."
---

# Compaction follows model selection

English | [中文](guide.zh.md)

## Change

Model-switch compaction previously summarized with the previous request model, and `/compact` ignored a pending model selection. Both could call an exhausted subscription after `/model` selected another provider. Switch summaries now use the destination model and its summary policy; `/compact` uses the current selection, including a pending choice. Explicit `summarizationProvider` and `summarizationModel` settings still take precedence. Ordinary pressure and overflow compaction retain the last request route.

Cursor models without catalog limits now receive a configurable 200,000-token compaction budget. Account catalog refreshes retain bundled limits. This enables proactive compaction and destination checks for fetched models; it does not change Cursor's server limit.

## Migration

1. If summaries must keep using a dedicated provider, set both `summarizationProvider` and `summarizationModel` on the `compaction-basic` row or the selected route's `modelPolicies` entry in your profile patch.
2. For Cursor models with different available windows, configure `llm-cursor.modelContextWindows` by exact model id, or `defaultContextWindow` for models without catalog limits. See the [Cursor adapter reference](../../../../packages/llm/llm-cursor/README.md).
3. After a subscription limit, select an available model with `/model`, then retry or run `/compact`. Confirm that any new `compaction/summary` event names the selected provider and model, unless an explicit summary target is configured. A destination unable to fit the summary input can still reject compaction; choose a larger model or a dedicated summary target.
