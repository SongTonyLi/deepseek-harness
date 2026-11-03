---
kind: upgrade-guide
description: "模型切换与手动压缩使用所选模型，而非上一请求模型。"
---

# 压缩遵循模型选择

[English](guide.md) | 中文

## 变更

模型切换压缩此前使用上一请求模型生成摘要，`/compact` 也忽略待用的模型选择。因此，即使 `/model` 已选择其他提供方，两者仍可能调用已耗尽额度的订阅。切换摘要现在使用目标模型及其摘要策略；`/compact` 使用当前选择，包括待用选择。显式 `summarizationProvider` 和 `summarizationModel` 设置仍然优先。普通压力压缩与溢出压缩仍使用上一请求路由。

目录中没有限制的 Cursor 模型现在获得可配置的 200,000 token 压缩预算。账户目录刷新会保留捆绑限制。这为获取的模型启用主动压缩与目标检查，不会改变 Cursor 服务端限制。

## 迁移

1. 如果摘要必须继续使用专门提供方，在配置文件补丁的 `compaction-basic` 行或所选路由的 `modelPolicies` 条目中同时设置 `summarizationProvider` 和 `summarizationModel`。
2. 对于可用窗口不同的 Cursor 模型，按精确模型 id 配置 `llm-cursor.modelContextWindows`，或用 `defaultContextWindow` 设置无目录限制模型的预算。参阅 [Cursor 适配器参考](../../../../packages/llm/llm-cursor/README.zh.md)。
3. 订阅额度耗尽后，用 `/model` 选择可用模型，再重试或运行 `/compact`。确认新的 `compaction/summary` 事件使用所选提供方和模型，除非配置了显式摘要目标。如果目标模型无法容纳摘要输入，压缩仍可能被拒绝；应选择更大窗口的模型或专门的摘要目标。
