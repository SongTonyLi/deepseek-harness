# Post-mortem 0005: 父智能体切换模型后恢复旧子智能体

[English](0005-subagent-resume-after-model-switch.md) | 中文

Status: resolved. 冷恢复仍保留记录的路由。本地错误通知现在写明该路由和脱敏后的原因。

## 执行摘要

在上游同步会话中，父智能体切换到 OpenAI Codex 模型后，恢复两个已有 Anthropic 子智能体的尝试失败了。使用当前路由新建的子智能体完成了任务。当前模型发现明确拒绝旧提供方，而本检出目录的代码在冷恢复时保留子智能体记录的模型路由。保留的路由与当前可用路由不匹配是合理但未经证实的假设：失败通知没有提供底层异常，尚不能确定每次失败轮次的具体原因。操作层面的教训是：切换后重新检查路由，并将未完成工作交给新建且获授权的智能体，而不是在没有诊断信息时反复唤醒旧智能体。

## 观察到的行为

| 操作 | 本次会话中的结果 | 能够证明什么 |
|---|---|---|
| 创建最初的工作智能体 | 请求显式选择 `anthropic` / `claude-haiku-5-5` | 它们请求的路由不同于父智能体后来的路由 |
| 切换父智能体模型 | 运行时上下文变为 `openai-codex` / `gpt-6.1-sol` | 父路由发生变化；没有报告子路由迁移 |
| 向 `ctrl-fixer` 和 `masker-refactor` 发送后续工作 | 消息投递获确认，随后两个工作智能体均在完成前失败，且没有结束消息 | 投递确认不能证明子智能体轮次成功 |
| 查询 `list_subagent_models` | 只列出 `openai-codex` | 当前发现结果未提供 Anthropic 路由 |
| 查询 `list_subagent_models({ provider: 'anthropic' })` | `LLM provider "anthropic" is not allowed for this Session` | 当前发现策略明确拒绝旧提供方 |
| 不使用旧路由覆盖，新建 `controller-doc-review` 和 `masker-review` | 两者均完成了分配的审查 | 在当前默认路由上的新委派可以工作 |
| 在此前用户要求暂停时中断 `cache-refactor` 和 `docs-controller` | 两者停止，且没有结束消息 | 主动中断不能作为模型切换失败的证据 |

发现结果中的拒绝涉及授权，不能证明凭据缺失或提供方发生故障。`list_agents` 中的 `inactive` 行不代表已完成；应检查完成通知以及实际文件或任务结果。失败或停止的工作智能体可能留下部分修改，因此重新分配前应检查其写入范围。

## 机制与证据限制

本检出目录的[子智能体描述符](../../packages/subagent/subagent/src/descriptor.ts)保存 `agentProvider`、`agentModel` 和 `agentReasoningEffort`。[冷恢复](../../packages/subagent/subagent/src/manager.ts)将这些记录字段传给子智能体实例化，而不是用父智能体的当前选择替换它们。[继续执行测试](../../packages/subagent/subagent/tests/continuation.spec.ts)“reapplies the descriptor model route and reasoning effort on cold resume”在定向运行中通过。这验证了仓库中的机制，不能补足运行会话中失败工作智能体未提供的异常。

[模型发现](../../packages/subagent/tool-subagent/src/list-models.ts)按照 Session 获授权的路由筛选提供方。没有记录模型选择策略时，它将发现范围限制在父智能体的当前路由。[显式子模型选择](../../packages/subagent/tool-subagent/src/model-selection.ts)另行执行授权检查。因此，父智能体切换模型，并不意味着所有旧子路由仍可选择，也不意味着已有子智能体已切换模型。

反复发送消息本身不会替换记录的路由。但是，单凭发现结果中的拒绝，不能证明已有子智能体唤醒时到底是哪项检查或提供方请求失败。本次事故缺少失败轮次的结构化错误、嵌套原因，以及运行时路由解析跟踪。它不能证明凭据撤销、令牌耗尽、推理强度不兼容，也不能证明每次模型切换都会失败。冷恢复仍保留记录的路由，不会自动改用父智能体后来的路由。本地结果以错误结束时，父级通知现在包含该路由和脱敏后的原因。

## 为什么调查重复了工作

编排者在切换后刷新模型发现之前复用了旧智能体。工具确认了消息投递，但后续失败通知既没有提供方错误，也没有结束报告。因此，编排者不得不重建未完成范围并新建工作智能体。模型发现中的可操作错误直到恢复失败后才被获取。尝试恢复前就可以先查询模型发现。

## 操作缓解措施

1. 父智能体切换模型后，在选择子路由或复用路由不同的工作智能体前，查询 `list_subagent_models`。
2. 一次恢复出现不明原因的失败后，检查完成通知、任务归属和工作智能体的写入范围。不要把投递回执当作工作完成，也不要在没有新证据时反复重试。
3. 旧路由无法用于新委派时，在获授权的路由上新建替代者，并交接准确职责、验收标准、已有证据和剩余工作。替代者写入前先检查部分修改。
4. 负责人变化时，显式重新分配共享任务。任务就绪不会启动空闲智能体；应向新负责人发送任务说明。
5. 如需保留原子智能体的身份和历史，先保留它们，并获取错误及路由可用性的证据，再选择运行时修复方案。新建替代者不等于迁移旧子智能体。

路由检查和替换步骤仍是操作建议。父级通知中的路由和原因现在属于本地结算结果。

## 防护

- 本地结果以 `error` 结束时，activation 结果和父级通知包含 `Child route <provider>/<model> failed (<code>): <message>`。没有路由时，句子是 `Child turn failed (<code>): <message>`。
- `<message>` 是已提交轮次失败的自身文本；若 `turn/end` 未能提交，则是实时错误的自身消息。Bearer 令牌、`sk-` 密钥，以及 `api_key`、`access_token` 或 `secret` 赋值会变成 `[redacted]`。请求 id 和 cause 链不进入通知。文本限制为 4096 个 UTF-8 字节。
- 冷恢复仍使用子智能体记录的路由。一项测试让父智能体在新路由上完成一轮，同时旧提供方继续服务旧子智能体，新建子智能体则使用父级路由。同一切换在该提供方注销后，通知写明 `NO_ADAPTER` 和记录的路由。
- 这些用例在 [`continuation.spec.ts`](../../packages/subagent/subagent/tests/continuation.spec.ts)。脱敏和字节限制在 [`local-failure.spec.ts`](../../packages/subagent/subagent/tests/local-failure.spec.ts)。一条本地失败的父级记录在 [`subagent-local-failure-notice`](../../snapshots/session/subagent-local-failure-notice/snapshot.yml)。
