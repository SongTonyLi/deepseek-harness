# Agent Note: Park Cursor Runs across tool calls and route harness tools through CallDynamicTool

Status: implemented

English | [中文](2026-09-23-cursor-parked-runs-and-dynamic-tools.zh.md)

## Problem

Cursor models in DSH repeated themselves. A live TUI session on `grok-4.7-xhigh-fast` wrote the same status sentence at eight of sixteen steps of one turn, and almost every thinking block restated the task. Each DSH step was a new `AgentService/Run` rebuilt from history. After local tool calls, the Run's required user message was an adapter continuation notice that Cursor presents as a new `<user_query>`, and replayed reasoning is invisible, so the model opened every step as a new turn.

Tool calls also took three or four model rounds each. Live probes on 2026-09-23 with `grok-4.7-xhigh-fast`, `composer-2.5-fast`, and `claude-4.6-sonnet-medium` showed that a CLI-client Run never lists harness MCP tools as `mcp_dsh_<tool>` functions. The model reaches them only through Cursor's `GetDynamicTools` (`{ pattern }` search or `{ namespace, toolName }` schema) and `CallDynamicTool` (`{ namespace, toolName, arguments }`). The adapter rule, the native-exec refusals, and the replayed history all named `mcp_dsh_<tool>`, so the model first tried Cursor's native `Read`, then a nonexistent `mcp_dsh_read` that Cursor answered with "Tool not available", then searched, fetched the schema, and finally called the tool. In the last step of that session no call reached DSH and the model reported that every tool was unavailable.

## Decision

A step that ends on MCP tool calls parks its Run instead of closing it. `stream.ts` collects every `mcpArgs` exec until Cursor's `conversationCheckpointUpdate`, which the live server sends after the model's last parallel call, or until `toolCallSettleMs` passes without a frame. It then emits the calls with a `tool-calls` finish and hands the Run to the adapter's `CursorRunRegistry` (`park.ts`), keyed by Session. The registry sends `clientHeartbeat` every five seconds, as the Cursor CLI does, and cancels the Run after `parkedRunTimeoutMs`.

The next request from that Session resumes the Run when the messages before its last assistant message match the parked request (model, system prompt, tool schemas, and message content), that assistant message carries exactly the pending calls, and it is followed only by their tool results plus harness-injected user-role context. The adapter answers each exec with `mcpResult` on the same stream and keeps reading, so the model continues with its own reasoning and never sees the continuation notice. A parked Run cannot take a new user message, so injected context such as nested workspace instructions is appended to the last result it sends. Any other request from the Session, a human message after the results, a changed prefix, a Run that died while parked, or an expired Run falls back to a new Run rebuilt from history. Compaction and title requests (`GenerateOptions.purpose`) and requests without a Session never park or resume.

The adapter rule now names the calling convention: harness tools are MCP tools in namespace `dsh`, called with `CallDynamicTool`, with `GetDynamicTools` for a schema, followed by the list of harness tool names. Native-exec refusals name `CallDynamicTool` with namespace `dsh` and the replacing `toolName`. Replayed history writes each harness call and result as the `CallDynamicTool` call Cursor records in its own checkpoint. A rebuilt Run whose history ends in tool results followed by injected context continues the in-flight turn instead of sending an empty user query.

## Alternatives considered

**Keep one Run per step and strengthen the continuation notice.** The notice now tells the model the request continues the current task, but Cursor still frames it as a new user query and the model still re-derives its plan without its reasoning. It remains the fallback path, not the fix.

**Resume with `resumeAction`.** Live probes on 2026-09-18 showed the server restarts the turn from its user message and cannot carry a locally produced result.

**Park only when the tail is exactly the tool results.** Nested workspace instructions follow a tool result whenever the model reads under a directory with its own `AGENTS.md`, so a strict match fell back on most coding turns in the live check.

**Tell the model to call `mcp_dsh_<tool>`.** That is the name Cursor uses inside its IDE; a CLI-client Run does not expose it, and the live server rejects it.

**Execute Cursor-native workspace tools.** DSH owns tool execution and permission through the agent loop; the adapter still refuses them.

## Consequences

- A Cursor turn runs on one Run while its history stays parkable: the model keeps its reasoning, batches parallel calls into one step, and writes no per-step preamble. A live TUI check resumed every step of a four-step turn, including a step after nested workspace instructions.
- Harness tools cost one `CallDynamicTool` round after the first schema lookup instead of three or four rounds.
- A parked Run holds one HTTP/2 stream per Session for up to `parkedRunTimeoutMs`; heartbeats keep it open while a local tool runs.
- Injected context reaches a resumed model inside the last tool result instead of as its own user message.
- Model-visible input remains reconstructable from the session log: a resumed model saw the logged request prefix, its logged reasoning and calls, and the logged results and context.
- `packages/llm/llm-cursor/tests/park.spec.ts` pins batching, resume, context delivery, fallback on a human message or a dead Run, side-request isolation, heartbeats, and expiry.

## Related decisions

[Cursor subscription sign-in and native adapter](../feature/2026-09-18-cursor-subscription-signin-and-adapter.md) owns the adapter family and its prompt replay; this note replaces its one-Run-per-step streaming. [Keep unofficial Cursor Runs alive across CLI Pi and control execs](../bug-fix/2026-09-22-cursor-cli-pi-exec-continue.md) owns exec replies inside a Run.
