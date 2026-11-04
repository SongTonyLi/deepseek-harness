---
kind: upgrade-guide
description: "自定义 Session Controller 组合必须挂载共享的继续服务。"
---

# Session Controller 需要继续服务

[English](guide.md) | 中文

## 变更

`SessionController` 需要 `sessionContinuation` 来接纳失败轮次的重试。此前未挂载该服务的自定义组合必须添加它；随附的 base 和 sdk-minimal bundle 已提供该服务。现有 Session 重试来源字段、`conversationContinuation` 投影键、检查点版本和 wire 视图保持不变。

## 迁移

1. 在每个自定义 Session Controller 组合的依赖和 Cordis 配置中添加 `@deepseek-ai/dsh-session-continuation`。同时保持挂载 `@deepseek-ai/dsh-session-projection`；继续服务依赖它。
2. 在直接 Host 组合中，先挂载投影注册表并等待 `ctx.plugin(SessionContinuation)` 完成，再激活 Session Controller。不要直接构造服务，因为注册发生在服务激活期间。
3. 确认 Controller 成功激活，且符合条件的失败轮次可以接纳空重试。重新检查自定义 RPC 消费方的授权和请求去重；这些职责仍由调用方负责。接纳条件和失败情形见[服务参考](../../../../packages/session/session-continuation/README.zh.md)。
