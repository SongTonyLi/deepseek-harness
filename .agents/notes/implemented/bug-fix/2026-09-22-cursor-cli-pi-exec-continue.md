# Agent Note: Keep unofficial Cursor Runs alive across CLI Pi and control execs

Status: implemented

English | [中文](2026-09-22-cursor-cli-pi-exec-continue.zh.md)

## Problem

The unofficial Cursor adapter presents itself as the Cursor CLI (`x-cursor-client-type: cli`). Cursor CLI models emit modern exec frames the first vendored `agent.v1` schema did not name: Pi workspace tools (`piReadArgs` = 45 through `piLsArgs` = 51), `executeHookArgs` = 27, and `mcpStateExecArgs` = 36. Those decoded as an empty oneof. The adapter treated that as wire drift, sent `ExecClientThrow`, and failed the DSH turn with `UNSUPPORTED_CONTENT`. A live TUI session on `cursor/cursor-grok-4.6-high-fast` asking "what does it do" died immediately after the first text and thinking, before any `mcp_dsh_*` tool call.

## Decision

The vendored schema is the community `agent.v1` catalog that names those CLI frames. Workspace execs, including Pi and redacted/mini-swe variants, still receive a typed rejection that names the harness tool to call through `CallDynamicTool`; this adapter does not execute Cursor workspace tools. Each known CLI hook returns an empty matching `ExecuteHookResponse`. An MCP-state exec returns the advertised harness tools grouped as one `dsh` server, filtered by `serverIdentifiers` when Cursor sends them. Any other named exec, or an unknown oneof field stored on `$unknown`, is answered with `ExecClientThrow` so the Run continues. An exec with no payload still fails the turn as a malformed frame.

`ConversationStateStructure.client_name` is omitted from the vendored subset; the adapter still writes field 22 as `dsh` on `$unknown` so the wire identity matches the previous typed field. `UserMessage.selected_context_blob` (field 10) and `correlation_id` (field 17) are written the same way.

## Alternatives considered

**Keep failing the turn on an unknown exec.** That was the previous policy, chosen so a re-issued unanswered exec could not hang the Run. It kills every current CLI model that emits a Pi tool or hook before the model can call `mcp_dsh_*`.

**Ignore an unknown exec without a reply.** Rejected because community clients warn Cursor can re-issue the same exec and the stream then waits forever.

**Execute Pi and native workspace tools.** Rejected: DSH owns tools through the agent loop; running Cursor's workspace execs would park a bridge this adapter does not have.

**Answer every unknown exec with a generic success.** Rejected: a write or shell could look completed when nothing ran.

## Consequences

- CLI Cursor models can keep the Run open through hooks, MCP-state, and refused Pi tools, then call harness tools.
- Future unnamed execs no longer abort the DSH turn; they still do not run.
- An empty exec still fails loud.
- `packages/llm/llm-cursor/tests/stream.spec.ts` pins Pi rejections, every modelled hook, MCP-state listing and filtering, unknown field 99, a typed control exec, and the empty-exec failure.

## Related decisions

The adapter family and the original unknown-exec failure policy are [Cursor subscription sign-in and native adapter](../feature/2026-09-18-cursor-subscription-signin-and-adapter.md). Native-tool execution and a parked HTTP/2 conversation remain out of scope there.
