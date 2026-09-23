# Agent Note: 跨工具调用挂起 Cursor Run，并通过 CallDynamicTool 路由 harness 工具

Status: implemented

[English](2026-09-23-cursor-parked-runs-and-dynamic-tools.md) | 中文

## Problem

DSH 中的 Cursor 模型会重复自己。一次使用 `grok-4.7-xhigh-fast` 的实况 TUI 会话在同一轮的十六步中有八步写出同一句状态说明，几乎每个 thinking 块都在重述任务。DSH 的每一步都是由历史重建的新 `AgentService/Run`。本地工具调用之后，Run 必需的用户消息是适配器的继续提示，Cursor 把它呈现为新的 `<user_query>`，而重放的 reasoning 不可见，因此模型把每一步都当作新轮次开场。

每次工具调用还要花三到四轮模型往返。2026-09-23 用 `grok-4.7-xhigh-fast`、`composer-2.5-fast` 和 `claude-4.6-sonnet-medium` 做的实测探针表明，CLI 客户端的 Run 从不把 harness MCP 工具列为 `mcp_dsh_<tool>` 函数。模型只能通过 Cursor 的 `GetDynamicTools`（`{ pattern }` 搜索或 `{ namespace, toolName }` schema）和 `CallDynamicTool`（`{ namespace, toolName, arguments }`）到达它们。适配器规则、原生 exec 拒绝和重放历史都写 `mcp_dsh_<tool>`，因此模型先试 Cursor 原生 `Read`，再试不存在的 `mcp_dsh_read` 并收到 Cursor 的 “Tool not available”，然后搜索、取 schema，最后才调用工具。在该会话的最后一步，没有任何调用到达 DSH，模型报告所有工具都不可用。

## Decision

以 MCP 工具调用结束的一步会挂起其 Run，而不是关闭它。`stream.ts` 收集每个 `mcpArgs` exec，直到 Cursor 发出 `conversationCheckpointUpdate`（线上服务端在模型最后一个并行调用之后发送），或直到 `toolCallSettleMs` 内没有新帧。然后它以 `tool-calls` 结束发出这些调用，并把 Run 交给适配器按 Session 索引的 `CursorRunRegistry`（`park.ts`）。注册表像 Cursor CLI 一样每五秒发送 `clientHeartbeat`，并在 `parkedRunTimeoutMs` 之后取消该 Run。

该 Session 的下一次请求在以下条件同时成立时恢复该 Run：最后一条 assistant 消息之前的消息与挂起时的请求一致（模型、系统提示、工具 schema 和消息内容），该 assistant 消息恰好带有待处理的调用，并且其后只有这些调用的工具结果以及 harness 注入的 user 角色上下文。适配器在同一条流上以 `mcpResult` 应答每个 exec 并继续读取，因此模型带着自己的 reasoning 继续，永远看不到继续提示。挂起的 Run 无法接收新的用户消息，因此嵌套工作区指令等注入上下文会追加到它发送的最后一个结果之后。该 Session 的任何其他请求、结果之后的人类消息、变化的前缀、挂起期间死亡的 Run 或已过期的 Run，都回退为由历史重建的新 Run。压缩和标题请求（`GenerateOptions.purpose`）以及没有 Session 的请求从不挂起或恢复。

适配器规则现在写明调用约定：harness 工具是命名空间 `dsh` 中的 MCP 工具，用 `CallDynamicTool` 调用，用 `GetDynamicTools` 获取 schema，随后列出 harness 工具名。原生 exec 拒绝指出带命名空间 `dsh` 和替代 `toolName` 的 `CallDynamicTool`。重放历史把每个 harness 调用及其结果写成 Cursor 在自身检查点中记录的 `CallDynamicTool` 调用。历史以工具结果加注入上下文结尾的重建 Run 会继续进行中的轮次，而不是发送空的用户查询。

## Alternatives considered

**每一步仍用一个 Run，并加强继续提示。** 继续提示现在告诉模型该请求延续当前任务，但 Cursor 仍把它框定为新的用户查询，模型仍在没有 reasoning 的情况下重新推导计划。它保留为回退路径，而不是修复。

**用 `resumeAction` 恢复。** 2026-09-18 的实测探针表明服务端会从该轮的用户消息重新开始，且无法携带本地产生的结果。

**只在结尾恰好是工具结果时挂起。** 每当模型读取带有自己 `AGENTS.md` 的目录下的文件时，嵌套工作区指令都会跟在工具结果之后，因此在实况检查中严格匹配会让大多数编码轮次回退。

**让模型调用 `mcp_dsh_<tool>`。** 这是 Cursor 在其 IDE 内部使用的名字；CLI 客户端的 Run 不暴露它，线上服务端会拒绝它。

**执行 Cursor 原生工作区工具。** DSH 通过 agent loop 拥有工具执行与权限；适配器仍拒绝它们。

## Consequences

- 在历史保持可挂起时，一个 Cursor 轮次运行在同一个 Run 上：模型保留自己的 reasoning，把并行调用批入同一步，并且不写每步开场白。一次实况 TUI 检查在四步轮次的每一步都恢复成功，包括嵌套工作区指令之后的一步。
- 首次查询 schema 之后，harness 工具只需一轮 `CallDynamicTool`，而不是三到四轮。
- 挂起的 Run 在最长 `parkedRunTimeoutMs` 内为每个 Session 占用一条 HTTP/2 流；本地工具运行期间由心跳保持开启。
- 注入上下文以最后一个工具结果内部的文本到达恢复的模型，而不是作为独立的用户消息。
- 模型可见输入仍可由会话日志重建：恢复的模型看到的是已记录的请求前缀、已记录的 reasoning 与调用，以及已记录的结果与上下文。
- `packages/llm/llm-cursor/tests/park.spec.ts` 固定批处理、恢复、上下文交付、遇到人类消息或死亡 Run 时的回退、旁路请求隔离、心跳和过期。

## Related decisions

[Cursor 订阅登录与原生适配器](../feature/2026-09-18-cursor-subscription-signin-and-adapter.zh.md) 拥有该适配器族及其提示重放；本记录取代其每步一个 Run 的流式方式。[让非官方 Cursor Run 在 CLI Pi 与控制 exec 下保持存活](../bug-fix/2026-09-22-cursor-cli-pi-exec-continue.zh.md) 拥有 Run 内的 exec 应答。
