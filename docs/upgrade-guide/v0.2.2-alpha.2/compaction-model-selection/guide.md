---
kind: upgrade-guide
description: "Model-switch and manual compaction summarize on the selected model while the latest request route has answered."
---

# Compaction follows model selection

English | [中文](guide.zh.md)

## Change

Model-switch and `/compact` summaries use the selected model and its summary policy while the latest request route has answered: no assistant message exists yet, or the latest assistant message names the same provider and model as the latest request header. After a request whose route did not answer, they use the route that last answered. Pressure and overflow summaries also use the route that last answered, not the latest request route, so a request rejected on one route does not summarize on that route. Before this change, model-switch compaction summarized with the previous request model, and `/compact` ignored a pending selection; both could call an exhausted subscription after `/model` selected another provider. Explicit `summarizationProvider` and `summarizationModel` settings still take precedence.

Cursor models without catalog limits now receive a configurable 200,000-token compaction budget. Account catalog refreshes retain bundled limits. This enables proactive compaction and destination checks for fetched models; it does not change Cursor's server limit.

## Migration

1. If summaries must keep using a dedicated provider, set both `summarizationProvider` and `summarizationModel` on the `compaction-basic` row or the selected route's `modelPolicies` entry in your profile patch.
2. For Cursor models with different available windows, configure `llm-cursor.modelContextWindows` by exact model id, or `defaultContextWindow` for models without catalog limits. See the [Cursor adapter reference](../../../../packages/llm/llm-cursor/README.md).
3. After a subscription limit, select an available model with `/model`, then retry or run `/compact`. While the latest request route has answered, a new `compaction/summary` event names the selected provider and model, unless an explicit summary target is configured. Otherwise the event names the route that last answered; if that route is unavailable too, configure `summarizationProvider` and `summarizationModel`. A destination unable to fit the summary input can still reject compaction; choose a larger model or a dedicated summary target.
