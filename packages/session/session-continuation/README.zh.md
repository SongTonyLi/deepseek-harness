---
description: "在不添加指令的情况下继续符合条件的失败模型轮次。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-continuation

[English](README.md) | 中文

## 概要

在不向对话添加指令文本的情况下继续符合条件的失败模型工作。重试会开始新轮次，并在 Session 日志中保留失败轮次。待处理的用户输入或正在运行的 Agent 工作会阻止接纳。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 Session 投影注册表旁挂载 `@deepseek-ai/dsh-session-continuation`。随附的 base 和 sdk-minimal bundle 已提供该服务；自定义 Session Controller 组合也必须挂载它。该服务没有配置字段。

使用精确的活动 Agent 和包含 `kind: 'retry'` 与带品牌的 `rpcId` 的 `RetrySource` 调用 `ctx.sessionContinuation.retry(agent, source)`。可选的 `clientTimeZone` 和 `principal` 字段保留调用方归属信息。调用方负责授权、请求标识、去重和错误展示。

接纳空重试并将其入队后，服务返回 `accepted`；当上一轮不符合条件、存在待处理的下一轮输入或存在待处理的下一步骤用户输入时，服务返回 `unavailable`，且不会入队重试。接纳条件要求已接纳用户工作或空重试、最后一个请求步骤中存在失败尝试，且错误结束码为 `RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE` 或 `STREAM_CLOSED`。此手动策略独立于提供方自动重试。不唤醒 Agent 的注入上下文仍留在队列中，供下一次请求使用。

Agent 维护锁将条件检查、收件箱检查和接纳操作保护为一个过程。Agent 正在工作或存在并发维护时抛出 `SessionContinuationBusyError`；其他接纳失败会继续向上传播。调用方应报告未知失败，不应假定重试已接纳，也不应在没有自己的去重策略时重试。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

服务负责注册并等待 `conversationContinuation` 投影就绪。其固定大小的折叠从完整 Session 日志推导接纳条件；检查点和后缀回放使用状态版本 4。wire 视图仍为符合条件的 `turn/end` 序号或 `null`。卸载服务会释放其注册；Session 准备和恢复仍由投影注册表与 Session 加载器负责。

[服务入口](src/index.ts)提供接纳操作，[投影](src/projection.ts)折叠持久事件，[类型](src/types.ts)声明重试来源和 wire 投影。Session Controller 消费该服务，并继续负责 RPC 去重和 Remote 错误处理。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [Session 投影注册表](../session-projection/README.zh.md) — 注册、恢复和检查点生命周期。
- [Session Controller](../../api/session-controller/README.zh.md) — Remote 提示词接纳和请求去重。
- [手动生成继续](../../../.agents/notes/implemented/feature/2026-10-26-manual-generation-continuation.zh.md) — 策略和持久输入的设计依据。

-----

<a id="model-experience"></a>
## 模型体验

接纳的重试会记录一个带重试来源的空用户消息并开始新轮次。它不会添加指令文本；保留的不唤醒上下文会随该请求交付。

#### KV Cache 影响

空消息会扩展对话。现有历史会保留；实际缓存复用取决于提供方和组装后的请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **请求去重由调用方负责** — 再次提交相同来源不保证幂等。Session Controller 提供自己的 RPC 请求去重。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
