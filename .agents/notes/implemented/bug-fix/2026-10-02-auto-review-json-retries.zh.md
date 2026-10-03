# Agent Note: 重试 Auto reviewer 的无效 JSON

Status: implemented

[English](2026-10-02-auto-review-json-retries.md) | 中文

## 问题

Auto reviewer 可能无视 JSON 指令而返回解释性文字。解析这些文字会使普通工具调用在 body 执行前立即失败。[最初的 Auto 决策](../feature/2026-08-28-auto-review.zh.md)排除重试，因此临时格式错误会中断已授权的项目工作。

## 决策

Reviewer 只重试完整响应中唯一的最终 text block 无法解析为 JSON 的情况。包的 `maxJsonRetries` 设置是非负安全整数，默认 `1`，接受 `0` 以禁用重试。每次尝试使用相同的冻结动作事实、route、采样设置与取消信号。重试在策略后追加固定 JSON 格式提醒；格式错误的响应既不提供指令，也不提供授权，并且不会发送回 reviewer。

每次尝试必须通过完整 stream 与 risk／decision 校验，结果才能授权执行。有效拒绝、非法决定对象、重复 JSON 成员、provider 失败、非法 stream 结束以及已取消的 review 不重试。重试耗尽时返回带有 `auto-review: reviewer output must be valid JSON` 的 reviewer 失败，绝不执行工具 body。[用户审批兜底](../feature/2026-09-24-auto-review-user-approval-fallback.zh.md)仍负责有效拒绝。

## 考虑过的替代方案

**从周围文字中提取 JSON 对象。** 响应可能包含冲突决定或引用的示例。要求整个响应可解析，可以避免从歧义文字中选择授权。

**重试拒绝或所有 reviewer 失败。** 重复分类可能把有效拒绝替换为允许，而 provider 与 stream 错误需要各自的诊断。格式恢复在这两种情况之前停止。

## 后果

无效 JSON 可能在配置的重试次数内增加模型延迟与 token 成本。Reviewer 尝试仍为临时状态，不增加 Session 事件。Owner 测试覆盖恢复、拒绝、耗尽、禁用重试、PTC 调用与取消；录制的 TUI 回放通过随附 profile 与生产 Bash 工具执行先返回解释文字、再返回有效 JSON 的场景。
