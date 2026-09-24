---
description: "Stream Cursor subscription models through the always-on cursor route with PKCE sign-in and unofficial Connect/protobuf HTTP/2."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-cursor

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-cursor` registers the always-on `cursor` route, signs in with a Cursor subscription through PKCE, and streams harness steps over unofficial Connect/protobuf HTTP/2 `AgentService/Run` streams; the steps of one turn share a Run while the adapter can resume it. Settings → Models shows a Cursor card with Sign in; TUI `/login llm-cursor/cursor` lists the same flow. This package can run beside the [DeepSeek](../llm-deepseek/README.md) and [pi-ai](../llm-pi-ai/README.md) adapters.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a composition should offer Cursor subscription models. The base bundle already does. The plugin registers `cursor` as soon as it loads; there is no Add-provider step.

### When to choose it

Choose this adapter to use a Cursor subscription from TUI, Web, or headless with `CURSOR_ACCESS_TOKEN` or a stored grant. Choose `dsh-llm-pi-ai` for Codex and other pi-ai catalog subscriptions, and `dsh-llm-deepseek` for the official DeepSeek route. The three adapters can be mounted together because their route names do not collide.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-llm-cursor'
  config:
    apiKeyEnv: CURSOR_ACCESS_TOKEN
    reuseInstalledCursorLogin: true
```

A request selects the route with `provider: cursor`. Model ids pass through; bundled fallback names include `composer-2`, `composer-2-fast`, `composer-1.5`, `claude-4.5-sonnet`, `claude-4.6-opus-high`, and `gpt-5.1`. After sign-in, `GetUsableModels` replaces that list and caches it under `$DSH_HOME/cache/llm-cursor/usable-models.json`. Unlisted ids still resolve as text-only routes.

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `CURSOR_ACCESS_TOKEN` | Credential reference resolved per request before a stored grant or harvest |
| `reuseInstalledCursorLogin` | `true` | Whether a request may reuse a Cursor IDE or CLI login already on this machine |
| `streamIdleTimeoutMs` | `300,000` | Maximum provider idle time per outstanding stream read |
| `parkedRunTimeoutMs` | `1,800,000` | How long a Run parked on tool calls waits for their results before it is cancelled |
| `toolCallSettleMs` | `1,000` | Wait for further parallel tool calls when Cursor has not yet sent the checkpoint that ends the model message |
| `retryPolicy` | normal, 5 retries | Provider-owned retry policy executed by `dsh-llm-retry` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-cursor) is the exhaustive source for every accepted field and its JSDoc.

### Sign in

Web: Settings → Models → Cursor → **Sign in**. The dialog opens `https://cursor.com/loginDeepControl`; complete the page and the grant is stored at `llm-cursor/cursor`.

TUI: `/login llm-cursor/cursor`. Headless does not start a browser; export `CURSOR_ACCESS_TOKEN` or reuse a grant written by a previous sign-in.

Sign-out is `deleteRecord` on that key. It does not revoke the session at Cursor and does not log out the IDE or CLI.

<a id="understand-the-implementation"></a>
## Understand the implementation

Request-time token order is: launch-environment `CURSOR_ACCESS_TOKEN`, then the stored OAuth grant (refresh inside `modifyRecord` when near expiry), then optional Keychain / `state.vscdb` harvest when `reuseInstalledCursorLogin` is true. A stored DSH login wins over harvest.

A new Run is rebuilt from harness history, system prompt, and MCP tool definitions (`providerIdentifier: dsh`, `clientName: dsh`). Cursor's server builds the model prompt from `root_prompt_messages_json`, never renders `conversation_state.turns` into it, and discards a `{"role":"system"}` entry there in favour of its own prompt. The adapter therefore publishes the system prompt as a `<rules>` user prompt message and replays every prior turn as `user`, `assistant`, and `tool` prompt messages, writing each historic harness tool call as the `CallDynamicTool` call Cursor records for an MCP tool; the turn structures ride along for the server's bookkeeping. A Cursor CLI Run exposes MCP tools to the model only through `GetDynamicTools` and `CallDynamicTool`, so the request-context answer adds one global Cursor rule telling the model that Cursor's built-in tools return a rejection here, that harness tools are called with `CallDynamicTool` in namespace `dsh`, and which tool names exist.

Text, thinking, usage, and MCP tool calls become `StreamChunk`. MCP tool calls end the step once Cursor sends the checkpoint that follows the model's last parallel call, or after `toolCallSettleMs` without a frame. When the request names a Session and is not a compaction or title request, the Run then parks: the adapter keeps the stream open with a `clientHeartbeat` every five seconds. The next request from that Session resumes it when its history before the last assistant message is unchanged and that message is followed only by the pending calls' results and harness-injected user-role context; the adapter answers each call with `mcpResult` on the same stream, appends such context to the last result, and keeps reading. Any other request, a Run that died while parked, or one older than `parkedRunTimeoutMs` falls back to a new Run that replays the in-flight turn with its results and sends a fixed continuation notice as the user message a Run requires; a `resumeAction` is not used because the server restarts the turn from its user message instead of continuing it. A Cursor-native or CLI Pi workspace exec (`read`, `shell`, `piRead`, and kin) is answered with its typed rejection naming the harness tool to call through `CallDynamicTool`, so the Run continues and the model reads the refusal as a tool outcome; text after a refused exec starts a new text block. A native Cursor question receives a typed rejection that directs the model to the harness `ask_user_question` MCP tool when available, or to ask in a reply otherwise; the Run continues. A CLI hook is answered with an empty matching response. An MCP-state exec returns the advertised `dsh` tools. Any other exec this build cannot type is answered with ExecClientThrow so the Run continues. An exec with no payload still fails the step.

Attribution headers required by `LlmAdapter` go on every HTTP/2 request, with Cursor client headers `x-ghost-mode`, `x-cursor-client-version`, and `x-cursor-client-type`.

<a id="further-exploration"></a>
## Further Exploration

- [Configure models](../../../docs/user/guide/providers.md) — Web and TUI sign-in, including Cursor beside Codex.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — `StreamChunk` and the adapter contract.
- [Cursor subscription sign-in and native adapter](../../../.agents/notes/implemented/feature/2026-09-18-cursor-subscription-signin-and-adapter.md) — why this is a third adapter family rather than a pi-ai catalog entry.
- [Park Cursor Runs across tool calls and route harness tools through CallDynamicTool](../../../.agents/notes/implemented/architecture/2026-09-23-cursor-parked-runs-and-dynamic-tools.md) — why a turn stays on one Run and how the model reaches harness tools.

<a id="model-experience"></a>
## Model Experience

### Cursor Run request

#### What the model sees

A new Cursor `AgentRunRequest` whose `root_prompt_messages_json` carries the model-visible history: the system prompt as a `<rules>` user message, then each prior human turn as a `<user_query>` user message, harness-injected catalogs, snapshots, and notices as separate user messages that are not wrapped in `<user_query>`, assistant messages holding text and `tool-call` parts written as `CallDynamicTool` calls in namespace `dsh`, and `tool` messages holding the results; thinking is not replayed. The current user action is the human prompt only — a Run has one `userMessageAction`, so skill catalogs and runtime snapshots ride the root prompt instead of joining that action. A resumed Run sends no new request: the model reads each tool result as the outcome of its own pending call, with harness context that followed the results appended to the last one. When the Run cannot resume after locally executed tool calls, the in-flight turn is replayed with its results and the user action is the fixed notice `The results of your tool calls are in the tool messages above. This is not a new request: continue the current task from the last tool result. The user has already seen your earlier messages, so do not repeat or rephrase them or restate your plan; write only new information.`. The request context carries one global rule stating that Cursor's built-in tools return a rejection and that harness tools are called with `CallDynamicTool` in namespace `dsh`, followed by the harness tool names. Images reach the model as the harness's text-only placeholder because the route declares text-only input; no image bytes are sent. Cursor still offers its own built-in tools beside the harness MCP tools.

#### Token effect

Provider tokenization governs exact input. A new Run carries the current assembled messages; a resumed Run adds only the tool results to the conversation Cursor already holds. Replayed history travels twice on the wire, as prompt messages and as turn structures, but only the prompt messages reach the model. Cursor reports no prompt usage, so `inputTokens` is an estimate of one token per four characters of rules, replayed prompt messages, action text, and MCP tool definitions for the request as a new Run would carry it; `outputTokens` comes from Cursor's `tokenDelta` events.

#### KV Cache effect

The steps of a turn share one Cursor conversation while the Run resumes. A new Run, opened after a changed system prompt, history, tool schema, or model id, or after any fallback, does not reuse a Cursor-side conversation prefix.

### Cursor Run response

#### What the model sees

Text deltas, thinking deltas, token usage, and MCP tool calls become harness chunks. MCP tool calls finish the step with `tool-calls` after the model's parallel calls arrive. A native or CLI Pi workspace exec is answered with a rejection and the stream continues. A CLI hook or MCP-state exec is answered so the Run stays open. Any other exec this build cannot type is answered with ExecClientThrow and the stream continues. An exec with no payload fails the turn.

#### Token effect

Generated content affects later inputs only after the loop records it. Output token counts come from Cursor `tokenDelta` events when present.

#### KV Cache effect

A resumed Run already holds the model's own output. Loop-retained response blocks append to the next new Run. Unrecorded transport frames do not affect later cache identity.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the adapter stops. They are current package constraints, not a Cursor product comparison.

- **The integration is unofficial** — auth URLs, headers, client version, and `agent.v1` can change without notice and break this adapter.
- **Native Cursor workspace execs are not executed** — `read`, `shell`, CLI Pi tools (`piRead`, `piBash`, and kin), and the same family receive a typed rejection naming the harness tool, so a model that picks one spends a round trip on the refusal before calling `CallDynamicTool`.
- **CLI control execs do not run Cursor hooks** — hook frames get an empty matching response, MCP-state frames list the advertised `dsh` tools, and any other unnamed exec is answered with ExecClientThrow so the Run continues; none of them execute workspace work.
- **A parked Run lives in one process** — it is not journaled, so a restarted process, a human message after the tool results, or any changed history falls back to a new Run rebuilt from history.
- **A fallback Run delivers tool results as replayed prompt messages plus a fixed continuation notice** — the notice is adapter-owned text the human never typed; a resumed Run delivers injected context inside the last tool result instead of as its own message.
- **`GenerateOptions.stop` is unsupported** — the unofficial Run does not map stop sequences.
- **Image bytes are not sent** — the route declares text-only input, so every image reaches the model as the harness's text-only placeholder rather than as a Cursor selected image.
- **`maxTokens`, `temperature`, and `reasoningEffort` are not mapped** — the Run has no fields for them; effort is chosen through the Cursor model id suffix such as `-high`.
- **Reasoning is not replayed** — Cursor renders no `reasoning` prompt part, so after a fallback a thinking model re-derives its plan; a resumed Run keeps its reasoning.
- **Prompt token usage is an estimate** — Cursor reports none, so the TUI context meter shows the adapter's character-based estimate.
- **Sign-out does not revoke at Cursor** — it only deletes the local grant; harvest can still satisfy the next request until `reuseInstalledCursorLogin` is false.
- **Harvest can bill a different Cursor account** — a stored DSH grant wins; turn harvest off when this machine's IDE login is not the account to use.
- **A sign-in lives only in the process that started it** — reloading the page mid-login abandons the attempt.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- `src/native/agent_pb.ts` is the MIT-licensed generated schema from the community Cursor proto catalogs used by https://github.com/Rahularya01/pi-cursor and https://github.com/can1357/oh-my-pi. Coverage, oxlint, and verify-export-jsdoc exclude that file. There is no runtime dependency on those packages.

</details>

**Runtime invariant:** No companion is published. This package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam.
