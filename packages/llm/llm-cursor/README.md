---
description: "Stream Cursor subscription models through the always-on cursor route with PKCE sign-in and unofficial Connect/protobuf HTTP/2."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-cursor

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-cursor` registers the always-on `cursor` route, signs in with a Cursor subscription through PKCE, and streams each harness step as one unofficial Connect/protobuf HTTP/2 `AgentService/Run`. Settings → Models shows a Cursor card with Sign in; TUI `/login llm-cursor/cursor` lists the same flow. This package can run beside the [DeepSeek](../llm-deepseek/README.md) and [pi-ai](../llm-pi-ai/README.md) adapters.

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
| `retryPolicy` | normal, 5 retries | Provider-owned retry policy executed by `dsh-llm-retry` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-cursor) is the exhaustive source for every accepted field and its JSDoc.

### Sign in

Web: Settings → Models → Cursor → **Sign in**. The dialog opens `https://cursor.com/loginDeepControl`; complete the page and the grant is stored at `llm-cursor/cursor`.

TUI: `/login llm-cursor/cursor`. Headless does not start a browser; export `CURSOR_ACCESS_TOKEN` or reuse a grant written by a previous sign-in.

Sign-out is `deleteRecord` on that key. It does not revoke the session at Cursor and does not log out the IDE or CLI.

<a id="understand-the-implementation"></a>
## Understand the implementation

Request-time token order is: launch-environment `CURSOR_ACCESS_TOKEN`, then the stored OAuth grant (refresh inside `modifyRecord` when near expiry), then optional Keychain / `state.vscdb` harvest when `reuseInstalledCursorLogin` is true. A stored DSH login wins over harvest.

Each DSH model step is a new HTTP/2 Connect `Run` rebuilt from harness history, system prompt, and MCP tool definitions (`providerIdentifier: dsh`, `clientName: dsh`). Cursor's server builds the model prompt from `root_prompt_messages_json`, never renders `conversation_state.turns` into it, and discards a `{"role":"system"}` entry there in favour of its own prompt. The adapter therefore publishes the system prompt as a `<rules>` user prompt message and replays every prior turn as `user`, `assistant`, and `tool` prompt messages, naming historic MCP calls `mcp_dsh_<tool>` as Cursor does; the turn structures ride along for the server's bookkeeping. The request-context answer adds one global Cursor rule telling the model that Cursor's built-in tools return a rejection here and that the `mcp_dsh_` tools are the ones to call.

Text, thinking, usage, and MCP tool calls become `StreamChunk`. An MCP tool call finishes the stream so the agent loop can run the tool locally. The next Run replays that in-flight turn with its results and sends a fixed continuation notice as the user message a Run requires; a `resumeAction` is not used because the server restarts the turn from its user message instead of continuing it. A Cursor-native workspace exec (`read`, `shell`, `grep`, and kin) is answered with its typed rejection naming the harness tool to call instead, so the Run continues and the model reads the refusal as a tool outcome; an exec this build does not know fails the step.

Attribution headers required by `LlmAdapter` go on every HTTP/2 request, with Cursor client headers `x-ghost-mode`, `x-cursor-client-version`, and `x-cursor-client-type`.

<a id="further-exploration"></a>
## Further Exploration

- [Configure models](../../../docs/user/guide/providers.md) — Web and TUI sign-in, including Cursor beside Codex.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — `StreamChunk` and the adapter contract.
- [Cursor subscription sign-in and native adapter](../../../.agents/notes/implemented/feature/2026-09-18-cursor-subscription-signin-and-adapter.md) — why this is a third adapter family rather than a pi-ai catalog entry.

<a id="model-experience"></a>
## Model Experience

### Cursor Run request

#### What the model sees

One rebuilt Cursor `AgentRunRequest` whose `root_prompt_messages_json` carries the model-visible history: the system prompt as a `<rules>` user message, then each prior human turn as a `<user_query>` user message, harness-injected catalogs, snapshots, and notices as separate user messages that are not wrapped in `<user_query>`, assistant messages holding text and `tool-call` parts named `mcp_dsh_<tool>`, and `tool` messages holding the results; thinking is not replayed. The current user action is the human prompt only — a Run has one `userMessageAction`, so skill catalogs and runtime snapshots ride the root prompt instead of joining that action. After locally executed tool calls, the in-flight turn is replayed with its results and the user action is the fixed notice `The results of your tool calls are in the tool messages above. Continue the task.`. The request context carries one global rule stating that Cursor's built-in tools return a rejection and naming the `mcp_dsh_` tools as the ones to call. Images reach the model as the harness's text-only placeholder because the route declares text-only input; no image bytes are sent. Cursor still offers its own built-in tools beside the harness MCP tools.

#### Token effect

Provider tokenization governs exact input. History is fully rebuilt on every DSH step, so the wire request is the current assembled messages rather than a resumed Cursor conversation. Replayed history travels twice on the wire, as prompt messages and as turn structures, but only the prompt messages reach the model. Cursor reports no prompt usage, so `inputTokens` is an estimate of one token per four characters of rules, replayed prompt messages, action text, and MCP tool definitions; `outputTokens` comes from Cursor's `tokenDelta` events.

#### KV Cache effect

Each step is an independent Run. A changed system prompt, history, tool schema, or model id produces a new request and does not reuse a Cursor-side conversation prefix.

### Cursor Run response

#### What the model sees

Text deltas, thinking deltas, token usage, and MCP tool calls become harness chunks. An MCP tool call finishes the stream with `tool-calls`. A native exec is answered with a rejection and the stream continues; an unknown exec fails the turn.

#### Token effect

Generated content affects later inputs only after the loop records it. Output token counts come from Cursor `tokenDelta` events when present.

#### KV Cache effect

Loop-retained response blocks append to the next rebuilt Run. Unrecorded transport frames do not affect later cache identity.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the adapter stops. They are current package constraints, not a Cursor product comparison.

- **The integration is unofficial** — auth URLs, headers, client version, and `agent.v1` can change without notice and break this adapter.
- **Native Cursor workspace execs are not executed** — `read`, `shell`, and kin receive a typed rejection naming the harness tool, so a model that picks one spends a round trip on the refusal before calling the `mcp_dsh_` tool.
- **There is no parked HTTP/2 conversation** — each DSH step is a new Run; mid-tool resume on the same Cursor stream is out of scope.
- **Tool results reach the model as replayed prompt messages plus a fixed continuation notice** — Cursor delivers results in-stream natively; the notice is adapter-owned text the human never typed.
- **`GenerateOptions.stop` is unsupported** — the unofficial Run does not map stop sequences.
- **Image bytes are not sent** — the route declares text-only input, so every image reaches the model as the harness's text-only placeholder rather than as a Cursor selected image.
- **`maxTokens`, `temperature`, and `reasoningEffort` are not mapped** — the Run has no fields for them; effort is chosen through the Cursor model id suffix such as `-high`.
- **Reasoning is not replayed** — Cursor renders no `reasoning` prompt part, so a thinking model re-derives its plan after each locally executed tool call.
- **Prompt token usage is an estimate** — Cursor reports none, so the TUI context meter shows the adapter's character-based estimate.
- **Sign-out does not revoke at Cursor** — it only deletes the local grant; harvest can still satisfy the next request until `reuseInstalledCursorLogin` is false.
- **Harvest can bill a different Cursor account** — a stored DSH grant wins; turn harvest off when this machine's IDE login is not the account to use.
- **A sign-in lives only in the process that started it** — reloading the page mid-login abandons the attempt.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- `src/native/agent_pb.ts` is the MIT-licensed generated schema from https://github.com/Rahularya01/pi-cursor. Coverage, oxlint, and verify-export-jsdoc exclude that file. There is no runtime dependency on `@rahularya01/pi-cursor`.

</details>

**Runtime invariant:** No companion is published. This package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam.
