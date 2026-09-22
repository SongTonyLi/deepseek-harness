# Agent Note: Cursor subscription sign-in and native adapter

Status: implemented

English | [中文](2026-09-18-cursor-subscription-signin-and-adapter.zh.md)

## Problem

The harness can sign in to pi-ai catalog subscriptions (ChatGPT Codex, Anthropic, and others) through `dsh-authorization` and then call those models. TUI `/login` and Settings → Models both offer those subscription buttons. Neither surface can use a Cursor subscription. Pi Coding Agent does this with the unofficial extension `npm:@rahularya01/pi-cursor`: `/login cursor` runs PKCE against `cursor.com/loginDeepControl`, stores an OAuth grant, optionally reuses the Cursor app or CLI login, and streams over Cursor's Connect/protobuf HTTP/2 `agent.v1` API. Cursor is not a pi-ai builtin provider, so `dsh-llm-pi-ai`'s catalog login list never offers it, the Models page never shows a Cursor Sign in control, and the adapter's supported protocols cannot speak `cursor-native`.

## Decision

`@deepseek-ai/dsh-llm-cursor` (`packages/llm/llm-cursor`, plugin id `llm-cursor`) is a third LLM adapter family beside `dsh-llm-deepseek` and `dsh-llm-pi-ai`. It always owns the `cursor` route when mounted, registers one authorization flow at credential key `llm-cursor/cursor`, and streams each harness step as a new Cursor `Run` rebuilt from DSH history. `@rahularya01/pi-cursor` is not a runtime dependency; OAuth and a trimmed Node HTTP/2 client are owned code, with the `agent.v1` proto vendored under the MIT attribution already used for community Cursor clients.

### Package and composition

The plugin is a direct `LlmAdapter`, not a synthetic pi-ai catalog entry. `packages/bundle/base/cordis.patch.yml` mounts it next to `llm-pi-ai` so TUI, Web, and headless share the route. Headless does not start a browser login by itself; it uses `CURSOR_ACCESS_TOKEN` or an already stored grant. ACP and other compositions without `dsh-authorization` keep the adapter and skip the flow, matching how `llm-pi-ai` scopes `registerPiAiFlows`.

Config is `reuseInstalledCursorLogin` (boolean, default `true`, matching Pi). Agent URL and client-version headers stay protocol constants, not tunables.

### Authentication

`oauth.ts` implements PKCE, the `loginDeepControl` URL, poll of `https://api2.cursor.sh/auth/poll`, and refresh at `https://api2.cursor.sh/auth/exchange_user_api_key`. The flow notifies `{ url, openInBrowser: true }`, polls until tokens or abort, and commits `{ kind: grant, payload: { type: oauth, access, refresh, expires } }` through `ctx.credentials.modifyRecord` before resolving. The [authorization seam](../architecture/2026-08-13-credential-records-and-authorization-flows.md) still confirms that commit. Catalog refresh after login is best-effort and must not fail the attempt.

Request-time `token.ts` resolves in this order: launch-environment `CURSOR_ACCESS_TOKEN`, then the stored grant (refresh inside `modifyRecord` when near expiry), then optional Keychain / Cursor IDE `state.vscdb` harvest when `reuseInstalledCursorLogin` is true. A stored DSH login wins over harvest so a second Cursor account on the machine cannot silently bill. Sign-out is `deleteRecord` only; it does not revoke at Cursor and does not log out the IDE or CLI, so harvest can still satisfy the next request until the config is turned off.

### Streaming

Each DSH model step is one HTTP/2 Connect `AgentService/Run`. The adapter maps harness history, system prompt, and tools to MCP tool definitions, then maps text, thinking, usage, and MCP tool calls to `StreamChunk`. An MCP tool call finishes the stream; DSH executes the tool locally and the next step is a new Run. Cursor-native and CLI Pi workspace execs (`read`, `shell`, `piRead`, and kin) are rejected on the wire so the turn cannot park. Pi-cursor's conversation journal, parked bridge, and native-tool execution are out of scope.

Cursor's server builds the model prompt only from `root_prompt_messages_json`. Live probes on 2026-09-18 showed that `conversation_state.turns` never reaches the model and that a `{"role":"system"}` root entry is discarded for Cursor's own prompt: a rebuilt request arrived as a fresh question with no system prompt and no memory of earlier assistant text or tool results, and after a tool call the model saw an empty user message. `buildPromptMessages` therefore publishes the system prompt as a `<rules>` user message and replays every prior human turn as a `<user_query>` user message, harness-injected catalogs, snapshots, and notices as unwrapped user messages, assistant messages with `text` and `tool-call` parts named `mcp_dsh_<tool>`, and `tool` messages with the results, the same rendering pi-cursor adopted for the same finding except that injected context is not folded into the query; the turn structures still ride along for the server's bookkeeping. After locally executed tool calls, the in-flight turn is replayed with its results and the Run's required user message is the fixed notice `TOOL_RESULT_CONTINUATION_TEXT`. The stream decoder unwraps a model-echoed `mcp_dsh_` prefix back to the harness tool name.

Cursor keeps offering its built-in `read`, `shell`, `grep`, and kin beside the MCP tools, and harness tool names collide with them, so the request-context answer carries one global Cursor rule, `NATIVE_TOOLS_RULE`, naming the `mcp_dsh_` tools as the ones to call; a live probe showed the model reading it and skipping the native tool. When a model calls a native or CLI Pi tool anyway, `stream.ts` answers with that exec's typed rejection (`readResult.rejected`, `piReadResult.error`, and so on) whose reason names the harness tool; the live server keeps the Run open and the model reads the refusal as a tool outcome. An empty exec still fails the step as a malformed frame. A named exec or unknown-field exec this build cannot type is answered with ExecClientThrow so the Run continues; [Keep unofficial Cursor Runs alive across CLI Pi and control execs](../bug-fix/2026-09-22-cursor-cli-pi-exec-continue.md) owns that reversal. Cursor reports no prompt usage, so `inputTokens` is the payload's character-based estimate; the token meter keeps its own estimate when that is larger, and the TUI context meter shows the adapter's number instead of zero.

A Cursor Run has one current `userMessageAction`. Harness `user/message` events that the loop appends after the human prompt — runtime-context snapshots, skill catalogs, skill instruction bodies, session-reference context — are consecutive user-role messages. `conversationFromOptions` keeps `source.kind === 'user'` text as the query / action and puts every other user-role source on the root prompt without a `<user_query>` wrapper. Joining those injected messages into the action (or into a historical `<user_query>`) made Cursor models treat the skill catalog's "call the skill tool before acting" line as the user's task.

Attribution headers required by `LlmAdapter` go on every HTTP/2 request. Bundled fallback models register at mount; `GetUsableModels` replaces them after a token exists, with a cache under `$DSH_HOME`.

### Web and TUI surfaces

Cursor sign-in is a subscription option on **both** shipped human surfaces, not TUI-only.

On Web, Settings → Models shows a Cursor provider card as soon as the plugin mounts (same always-registered posture as `deepseek-official`, not a dormant row hidden behind Add provider). The card uses the existing Sign in seat: one subscription button, the shared footer dialog for the PKCE URL and progress, then **signed in with a provider subscription** and Sign out — the same controls Codex already has. The row does not paint API-key missing or configured dots; those belong to key-referenced profiles. `openInBrowser` opens `loginDeepControl` in a new tab; the dialog keeps the URL if the popup is blocked. After a successful grant, Cursor models appear in the Web model picker like any other configured provider.

[Browser provider sign-in](2026-09-14-browser-provider-sign-in.md) joins a flow to a card when the flow's record scope is an adapter-family settings namespace (`llm-pi-ai` or `llm-cursor`) and the record id is the provider route. `dsh-client-ui-settings-signin` registers the provider-card seat under both `llm-pi-ai` and `llm-cursor`. The [user providers guide](../../../../docs/user/guide/providers.md) names Cursor next to Codex as a subscription sign-in. First-run `needsSetup` does not treat the Cursor row as a DeepSeek-style key card.

TUI `/login` lists every flow; the Cursor row is `llm-cursor/cursor` with no Cursor-specific command. The [TUI `/login` command](2026-09-15-tui-login-and-effort-cycle.md) and [browser handoff](../bug-fix/2026-09-16-tui-subscription-sign-in-browser-handoff.md) stay the surfaces; they do not learn Cursor protocol.

## Alternatives considered

**Grow `dsh-llm-pi-ai` with a synthetic `cursor` catalog provider.** The Models page and `/login` would work with almost no UI change, and credentials would stay under `llm-pi-ai/cursor`. The unofficial Connect/protobuf stack would then live inside the adapter that exists to reuse pi-ai catalogs and the three reconstructable wire protocols. `provider.ts` already refuses protocols it cannot reconstruct. A composition could not drop Cursor without dropping every other pi-ai route.

**Depend on `@rahularya01/pi-cursor` and shim Pi's ExtensionAPI.** That package is a Bun-only Pi Coding Agent extension (`pi.registerProvider`), not a library. DSH is Node and has no ExtensionAPI. Peer dependencies on `pi-coding-agent` and `engines.bun` would fight source launch and CI.

**Parked HTTP/2 conversation with Cursor-native tools, as current pi-cursor.** That matches Cursor IDE behavior and can resume mid-tool on the same Run. DSH already owns tools through the agent loop: a step that emits tool calls finishes, local tools run, and the next step sends history. Keeping a parked bridge duplicates that loop inside the adapter and pulls in journals, recovery, and workspace execs this harness must not run on Cursor's behalf.

**Dormant route until `llm-cursor:` settings exist, like catalog pi-ai providers.** Consistent with "which providers run is the user's settings document," and it would avoid showing Cursor in `/model` before anyone cares. Pi-cursor and `deepseek-official` both appear as soon as their plugin mounts; requiring `/settings` after `/login cursor` is a trap this note's TUI sibling already has to document for Codex. The Cursor adapter has nothing useful to configure besides harvest, so the route is always registered.

**`resumeAction` for the post-tool Run.** The protocol offers it and the Cursor CLI retries a failed turn with it. Against the live server it restarted the last turn from its user message: the step blobs were not read and the model issued a fresh tool call with a new id, and listing the call in `pending_tool_calls` failed the Run with `internal`. It cannot carry a locally produced tool result.

**Harness system prompt as a `requestContext` Cursor rule.** Cursor renders rules inside its own system prompt, and a short rule was honored on a fresh conversation. With replayed history present it lost an always-apply instruction on two models and under several rule paths, while the `<rules>` user prompt message kept it, so only the adapter's tool notice travels as a rule.

**Tool results as the text of the post-tool user message, with no `tool` prompt message.** This is pi-cursor's degraded recovery path and needs no adapter-owned notice. It leaves an assistant `tool-call` followed directly by a user message, which OpenAI- and Anthropic-style request validation rejects on other Cursor models, so the results stay in `tool` messages and the notice fills the required user slot.

**Default `reuseInstalledCursorLogin` to false.** Safer for a product that is not Cursor: no silent read of another app's tokens. It also drops Pi's "if the Cursor app is logged in, it just works" path, which is the main reason to look at pi-cursor at all. Opt-out remains the config field.

**Read `~/.pi/agent/auth.json` or Cursor's files as the store.** Fastest path to a working token, and pi-ai-style ambient discovery already exists for other providers. It binds DSH to another tool's private file for one vendor, skips the authorization seam, and leaves Web/TUI with nothing to show as signed-in. Harvest is request-time fallback only; the durable grant is a harness record.

**Join every consecutive user-role message into the Run action and each historical `<user_query>`.** That keeps injected context from replacing the human prompt and needs only one string per turn. Cursor wraps that string as the user's task, so a skill catalog that says to load a skill before acting becomes the instruction the model follows. Human text stays the query; catalogs, snapshots, and notices stay on the root prompt without that wrapper.

## Consequences

With the base bundle mounted, `authorization.list()` includes `llm-cursor/cursor` with an `oauth` subscription method, and TUI `/login` offers Cursor. Settings → Models shows a Cursor card with the subscription Sign in control without adding a provider first. PKCE login opens `loginDeepControl`, polls until tokens, commits the grant, and reports `authorized`; abort or timeout stores nothing. `cursor/<model>` streams text (and thinking when the model emits it) through the harness `StreamChunk` contract; an MCP tool call finishes the stream; a missing token fails before HTTP/2 with `MISSING_CREDENTIAL`.

Cursor may change `agent.v1`, auth URLs, or headers without notice; the package README says the integration is unofficial and can break, and an empty exec fails the turn while other unanswered execs throw on the wire and continue rather than hang ([CLI Pi and control execs](../bug-fix/2026-09-22-cursor-cli-pi-exec-continue.md)). Harvesting IDE or CLI tokens can bill a different Cursor account than the human expects; stored DSH login wins, and `reuseInstalledCursorLogin` is the opt-out. Vendoring proto and a trimmed client creates a maintenance fork of the community Cursor clients; protocol drift is accepted in exchange for a Node-owned adapter and no Bun/ExtensionAPI dependency.

## Testing

Package tests cover OAuth, harvest, login commit, catalog fallback, fixture native frames, attribution headers, abort of HTTP/2, plugin last-good settings, Loader composition, and the Models-card join for `llm-cursor/cursor`. Real Cursor e2e skips without `CURSOR_ACCESS_TOKEN` and covers a text reply, recall of the system prompt and an earlier assistant turn, and the tool-result continuation; `DSH_CURSOR_E2E_MODEL` overrides the model id when the account's usable list moves on. The `models-settings` Web e2e goldens include the Cursor card and Sign in control. No `SessionEventMap` or SDK snapshot change. `pi-cursor` is not in `package.json`.
