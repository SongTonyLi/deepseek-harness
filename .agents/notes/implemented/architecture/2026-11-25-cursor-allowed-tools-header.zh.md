# Agent Note: 用 allowed-tools 请求头从 Run 中移除 Cursor 内建工具

Status: implemented

[English](2026-11-25-cursor-allowed-tools-header.md) | 中文

## Problem

尽管 DSH 拒绝每一个内建 exec，Cursor Run 仍在 harness MCP 工具之外向模型提供 Cursor 的全部内建工具。2026-11-25 用 `composer-2.5-fast`、8,291 字符的系统提示和三个 harness 工具进行的实测中，`TurnEndedUpdate` 报告 5,957 个输入 token；Cursor 的上下文分类把 14,047 字符计为工具定义，其中 harness 工具只占 2,177 字符。选中内建工具的模型会为拒绝多花一个往返，获批的内建网页搜索在 Cursor 一侧执行，Session 日志中没有对应的 harness 工具调用。

## Decision

每个新的 Run 都发送 `x-cursor-agent-allowed-tools`，即 `@cursor/sdk` 1.5.0 为其 `tools` 选项发送的、以逗号分隔的 agent proto 工具名列表。通告了 harness 工具时，列表为 `mcp_tool_call,get_mcp_tools_tool_call`，即 `CallDynamicTool` 与 `GetDynamicTools` 背后的 proto 工具；否则值为空，Run 不提供任何工具。一元 RPC 不发送该请求头。原生 exec 拒绝与批准应答保留给 Cursor 忽略该请求头的 Run。

## Alternatives considered

**继续拒绝内建 exec。** 两种做法下 DSH 都是唯一的工具执行者，但每个请求仍携带内建工具 schema，选中内建工具的模型仍要多花一个往返。

**发送 `x-cursor-agent-exclude-tools`。** 拒绝列表会保留 Cursor 在此之后新增的每个内建工具。

**允许 SDK 的整个 `mcp` 组。** 它额外加入 `list_mcp_resources_tool_call`、`read_mcp_resource_tool_call` 和 `mcp_auth_tool_call`，没有 harness 工具使用它们；2026-11-25 的实测只用这两个名称就调用到了 harness 工具。

**采用 `@cursor/sdk` 及其 `tools` 选项。** SDK 发送同一个请求头，但会带来需要 DSH 在 worker 进程中承载的专有运行时；仅靠该请求头即可移除这些 schema。

**用 `custom_system_prompt` 替换 Cursor 的系统提示。** 2026-11-25 服务端返回 `invalid_argument: Custom system prompt is not enabled for this account`；该字段按团队放行，普通账户无法用它缩减提示。

## Consequences

- 在同一实测中，该请求头把请求从 5,957 个输入 token 降到 3,204 个；Cursor 自己 2,111 字符的系统提示仍然保留。
- 不再提供 Cursor 服务端网页搜索；搜索由 harness 网页工具执行并记录。
- 移除依赖一个未公开的请求头。若 Cursor 忽略它，Run 回到拒绝路径；若 Cursor 拒绝它，Cursor 轮次会失败，直到请求头随之调整。
- `packages/llm/llm-cursor/tests/connect.spec.ts`、`request.spec.ts` 和 `stream.spec.ts` 固定该请求头的值、空值形式，以及一元 RPC 上不发送它。

## Related decisions

[跨工具调用挂起 Cursor Run，并通过 CallDynamicTool 路由 harness 工具](2026-09-23-cursor-parked-runs-and-dynamic-tools.zh.md) 拥有 `CallDynamicTool` 路由，以及本记录保留为回退的原生 exec 拒绝。
