# Agent Note: 让非官方 Cursor Run 在 CLI Pi 与控制 exec 下保持存活

Status: implemented

[English](2026-09-22-cursor-cli-pi-exec-continue.md) | 中文

## Problem

非官方 Cursor 适配器把自己呈现为 Cursor CLI（`x-cursor-client-type: cli`）。Cursor CLI 模型会发出第一份 vendored `agent.v1` schema 未命名的现代 exec 帧：Pi 工作区工具（`piReadArgs` = 45 至 `piLsArgs` = 51）、`executeHookArgs` = 27，以及 `mcpStateExecArgs` = 36。它们被解码为空的 oneof。适配器把这当作线路漂移，发送 `ExecClientThrow`，并以 `UNSUPPORTED_CONTENT` 使 DSH 轮次失败。一次使用 `cursor/cursor-grok-4.6-high-fast`、提问 “what does it do” 的实况 TUI 会话在第一段文本和 thinking 之后立刻死亡，来不及发出任何 `mcp_dsh_*` 工具调用。

## Decision

vendored schema 是为这些 CLI 帧命名的社区 `agent.v1` 目录。工作区 exec（包括 Pi 以及 redacted / mini-swe 变体）仍收到指出 `mcp_dsh_*` 替代工具的类型化拒绝；本适配器不执行 Cursor 工作区工具。每个已知 CLI 钩子返回空的匹配 `ExecuteHookResponse`。MCP-state exec 返回按一个 `dsh` 服务器分组的已通告 harness 工具，并在 Cursor 发送 `serverIdentifiers` 时按标识过滤。任何其他已命名 exec，或存放在 `$unknown` 上的未知 oneof 字段，以 `ExecClientThrow` 应答，以便 Run 继续。没有 payload 的 exec 仍作为畸形帧使该轮失败。

vendored 子集省略了 `ConversationStateStructure.client_name`；适配器仍把字段 22 作为 `dsh` 写到 `$unknown` 上，使线路身份与先前的类型化字段一致。`UserMessage.selected_context_blob`（字段 10）和 `correlation_id`（字段 17）以同样方式写入。

## Alternatives considered

**对未知 exec 继续使该轮失败。** 这是先前策略，目的是避免未应答 exec 被再次下发后把 Run 挂起。它会在模型调用 `mcp_dsh_*` 之前杀死每一个发出 Pi 工具或钩子的当前 CLI 模型。

**对未知 exec 不回复并忽略。** 拒绝，因为社区客户端警告 Cursor 可能再次下发同一 exec，然后该流永远等待。

**执行 Pi 与原生工作区工具。** 拒绝：DSH 通过 agent loop 拥有工具；运行 Cursor 的工作区 exec 会挂起本适配器没有的 bridge。

**用通用成功应答每一个未知 exec。** 拒绝：一次写入或 shell 会在什么都没跑的情况下看起来已经完成。

## Consequences

- CLI Cursor 模型可以在钩子、MCP-state 和被拒绝的 Pi 工具期间保持 Run 开启，然后调用 `mcp_dsh_*`。
- 未来未命名 exec 不再中止 DSH 轮次；它们仍不执行。
- 没有 payload 的 exec 仍会大声失败。
- `packages/llm/llm-cursor/tests/stream.spec.ts` 钉住 Pi 拒绝、每一个已建模钩子、MCP-state 列出与过滤、未知字段 99、已类型化的控制 exec，以及空 exec 失败。

## Related decisions

适配器族与原先的未知 exec 失败策略见 [Cursor 订阅登录与原生适配器](../feature/2026-09-18-cursor-subscription-signin-and-adapter.zh.md)。原生工具执行与挂起的 HTTP/2 会话仍在那里的范围之外。
