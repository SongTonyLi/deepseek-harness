# Agent Note: Remove Cursor's built-in tools from Runs with the allowed-tools header

Status: implemented

English | [中文](2026-11-25-cursor-allowed-tools-header.zh.md)

## Problem

A Cursor Run offered the model Cursor's full built-in toolset beside the harness MCP tools, although DSH refuses every built-in exec. A live measurement on 2026-11-25 with `composer-2.5-fast`, an 8,291-character system prompt, and three harness tools reported 5,957 input tokens in `TurnEndedUpdate`; Cursor's context breakdown attributed 14,047 characters to tool definitions, of which the harness tools were 2,177. A model that picked a built-in tool spent a round trip on the refusal, and an approved built-in web search ran on Cursor's side without a harness tool call in the Session log.

## Decision

Every new Run sends `x-cursor-agent-allowed-tools`, the comma-separated list of agent proto tool names that `@cursor/sdk` 1.5.0 sends for its `tools` option. When harness tools are advertised, the list is `mcp_tool_call,get_mcp_tools_tool_call`, the proto tools behind `CallDynamicTool` and `GetDynamicTools`; otherwise the value is empty and the Run offers no tools. Unary RPCs send no such header. The native-exec rejections and approval replies stay for a Run on which Cursor ignores the header.

## Alternatives considered

**Keep refusing built-in execs.** DSH stays the only tool executor either way, but every request still carries the built-in schemas and a model that picks one spends a round trip.

**Send `x-cursor-agent-exclude-tools`.** A deny list keeps every built-in tool Cursor adds after this change.

**Allow the SDK's whole `mcp` group.** It adds `list_mcp_resources_tool_call`, `read_mcp_resource_tool_call`, and `mcp_auth_tool_call`, which no harness tool uses; a live check on 2026-11-25 reached a harness tool with only the two names.

**Adopt `@cursor/sdk` and its `tools` option.** The SDK sends the same header but brings a proprietary runtime that DSH would host in a worker process; the header alone removes the schemas.

**Replace Cursor's system prompt with `custom_system_prompt`.** The server answered `invalid_argument: Custom system prompt is not enabled for this account` on 2026-11-25; the field is allowlisted per team, so it cannot reduce the prompt on ordinary accounts.

## Consequences

- In the same measurement, the header lowered the request from 5,957 to 3,204 input tokens; Cursor's own 2,111-character system prompt remains.
- Cursor's server-side web search is no longer offered; harness web tools own search and log it.
- The removal depends on an undocumented header. If Cursor ignores it, Runs return to the refusal path; if Cursor rejects it, Cursor turns fail until the header changes.
- `packages/llm/llm-cursor/tests/connect.spec.ts`, `request.spec.ts`, and `stream.spec.ts` pin the header value, its empty form, and its absence on unary RPCs.

## Related decisions

[Park Cursor Runs across tool calls and route harness tools through CallDynamicTool](2026-09-23-cursor-parked-runs-and-dynamic-tools.md) owns the `CallDynamicTool` route and the native-exec refusals this note keeps as the fallback.
