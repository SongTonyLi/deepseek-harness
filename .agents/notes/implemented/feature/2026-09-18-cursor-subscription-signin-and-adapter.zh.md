# Agent Note: Cursor subscription sign-in and native adapter

Status: implemented

[English](2026-09-18-cursor-subscription-signin-and-adapter.md) | 中文

## Problem

harness 已能通过 `dsh-authorization` 登录 pi-ai 目录中的订阅（ChatGPT Codex、Anthropic 等）并调用对应模型。TUI `/login` 与设置 → 模型都提供这些订阅按钮。两处界面都不能使用 Cursor 订阅。Pi Coding Agent 借助非官方扩展 `npm:@rahularya01/pi-cursor` 做到这一点：`/login cursor` 对 `cursor.com/loginDeepControl` 跑 PKCE，存一份 OAuth 授权，并可选用 Cursor 应用或 CLI 的既有登录，再经 Cursor 的 Connect/protobuf HTTP/2 `agent.v1` API 流式调用。Cursor 不是 pi-ai 内置提供方，因此 `dsh-llm-pi-ai` 的目录登录列表从不提供它，Models 页从不显示 Cursor 的登录控件，该适配器已支持的协议也不能讲 `cursor-native`。

## Decision

`@deepseek-ai/dsh-llm-cursor`（`packages/llm/llm-cursor`，插件 id `llm-cursor`）是 `dsh-llm-deepseek` 与 `dsh-llm-pi-ai` 之外的第三套 LLM 适配器族。挂载后它始终拥有 `cursor` 路由，在凭据键 `llm-cursor/cursor` 上注册一条授权 flow，并把 harness 的每一步流式调用做成一次按 DSH 历史重建的 Cursor `Run`。`@rahularya01/pi-cursor` 不是运行时依赖；OAuth 与裁过的 Node HTTP/2 客户端是自有代码，`agent.v1` proto 按社区 Cursor 客户端已有的 MIT 归属方式 vendoring。

### Package and composition

该插件是直接的 `LlmAdapter`，不是伪造的 pi-ai 目录项。`packages/bundle/base/cordis.patch.yml` 把它挂在 `llm-pi-ai` 旁边，使 TUI、Web 与无头共享该路由。无头不会自行打开浏览器登录；它使用 `CURSOR_ACCESS_TOKEN` 或已存储的授权。没有 `dsh-authorization` 的 ACP（Agent Client Protocol）及其它组合保留适配器、跳过 flow，与 `llm-pi-ai` 用 `registerPiAiFlows` 限定授权 seam 的方式一致。

配置项是 `reuseInstalledCursorLogin`（布尔，默认 `true`，与 Pi 一致）。Agent URL 与客户端版本头保持为协议常量，不是可调项。

### Authentication

`oauth.ts` 实现 PKCE、`loginDeepControl` URL、对 `https://api2.cursor.sh/auth/poll` 的轮询，以及 `https://api2.cursor.sh/auth/exchange_user_api_key` 上的刷新。flow 发出 `{ url, openInBrowser: true }` 通知，轮询至拿到令牌或中止，并在 resolve 之前经 `ctx.credentials.modifyRecord` 提交 `{ kind: grant, payload: { type: oauth, access, refresh, expires } }`。[授权 seam](../architecture/2026-08-13-credential-records-and-authorization-flows.zh.md) 仍确认这次提交。登录后的目录刷新是尽力而为，不得使本次尝试失败。

请求时 `token.ts` 按此顺序解析：启动环境中的 `CURSOR_ACCESS_TOKEN`，然后是已存储授权（临近过期时在 `modifyRecord` 内刷新），然后在 `reuseInstalledCursorLogin` 为 true 时可选读取钥匙串 / Cursor IDE `state.vscdb`。已存储的 DSH 登录优先于采集，以免机器上另一个 Cursor 账户被静默计费。退出登录只做 `deleteRecord`；它不向 Cursor 撤销，也不退出 IDE 或 CLI，因此在关掉该配置之前，采集仍可能满足下一次请求。

### Streaming

DSH 的每一步模型调用是一次 HTTP/2 Connect `AgentService/Run`。适配器把 harness 历史、系统提示与工具映射为 MCP 工具定义，再把文本、thinking、用量与 MCP 工具调用映射为 `StreamChunk`。一次 MCP 工具调用结束该流；DSH 在本地执行工具，下一步是新的 Run。Cursor 原生工作区 exec（`read`、`shell` 及同类）在链路上拒绝，以免该轮停住。pi-cursor 的会话 journal、挂起的 bridge 以及原生工具执行不在范围内。

Cursor 服务端只从 `root_prompt_messages_json` 构建模型提示。2026-09-18 的实测探针表明 `conversation_state.turns` 从不到达模型，且根条目中的 `{"role":"system"}` 会被丢弃而使用 Cursor 自己的提示：重建的请求以一个没有系统提示、也不记得先前助手文本和工具结果的新问题到达，而在一次工具调用之后模型看到的是一条空的用户消息。因此 `buildPromptMessages` 把系统提示作为 `<rules>` user 消息发布，并把每个先前人类轮次重放为 `<user_query>` user 消息，把 harness 注入的目录、快照和通知重放为不加包裹的 user 消息，以及带 `text` 和名为 `mcp_dsh_<tool>` 的 `tool-call` 部分的 assistant 消息和带结果的 `tool` 消息，这与 pi-cursor 针对同一发现采用的渲染一致，只是注入上下文不再折进查询；轮次结构仍一同发送，供服务端记账。本地执行工具调用之后，进行中的轮次连同其结果被重放，Run 必需的用户消息是固定提示 `TOOL_RESULT_CONTINUATION_TEXT`。流解码器把模型回显的 `mcp_dsh_` 前缀还原为 harness 工具名。

Cursor 仍在 MCP 工具之外提供其内建的 `read`、`shell`、`grep` 及同类，而 harness 工具名与之冲突，因此请求上下文的应答带一条全局 Cursor 规则 `NATIVE_TOOLS_RULE`，指出应调用 `mcp_dsh_` 工具；实测探针显示模型读到该规则并跳过了原生工具。当模型仍调用原生工具时，`stream.ts` 以该 exec 的类型化拒绝应答（`readResult.rejected`、`shellResult.rejected`、`grepResult.error` 等），拒绝原因指出对应的 harness 工具；线上服务端保持 Run 开启，模型把该拒绝当作工具结果读取。本构建不认识的 exec 仍作为线路漂移使该步失败。Cursor 不报告提示用量，因此 `inputTokens` 是 payload 基于字符数的估算；token meter 在自身估算更大时保留自己的值，TUI 上下文计量则显示适配器的数字而不是零。

一次 Cursor Run 只有一个当前 `userMessageAction`。loop 在人类提示之后追加的 harness `user/message` 事件——运行时上下文快照、技能目录、技能指令正文、会话引用上下文——是连续的 user 角色消息。`conversationFromOptions` 把 `source.kind === 'user'` 的文本留作查询／动作，并把所有其他 user 角色来源放到根提示上，且不加 `<user_query>` 包裹。若把这些注入消息拼进动作（或拼进历史中的 `<user_query>`），Cursor 模型会把 skill 目录里“行动前先调用 skill 工具”的句子当成用户任务。

`LlmAdapter` 要求的归属头出现在每一次 HTTP/2 请求上。挂载时注册捆绑的回退模型；存在令牌后 `GetUsableModels` 替换它们，缓存在 `$DSH_HOME` 下。

### Web and TUI surfaces

Cursor 登录是两个已发布的人机界面上的订阅选项，不只在 TUI。

在 Web 上，设置 → 模型在插件挂载后立即显示 Cursor 提供方卡片（与 `deepseek-official` 相同的始终注册姿态，不是藏在「添加提供方」后面的休眠行）。该卡片使用已有的登录座位：一个订阅按钮、共用的页脚对话框展示 PKCE URL 与进度，然后是**已通过提供方订阅登录**与退出登录——与 Codex 已有的控件相同。该行不画 API 密钥缺失或已配置圆点；那些属于带密钥引用的 profile。`openInBrowser` 在新标签页打开 `loginDeepControl`；若弹出被拦截，对话框仍保留该 URL。授权成功后，Cursor 模型像其它已配置提供方一样出现在 Web 模型选择器中。

[浏览器提供方登录](2026-09-14-browser-provider-sign-in.zh.md) 在 flow 的记录 scope 为适配器族 settings namespace（`llm-pi-ai` 或 `llm-cursor`）且记录 id 为提供方路由时，把 flow 联到卡片。`dsh-client-ui-settings-signin` 在 `llm-pi-ai` 与 `llm-cursor` 下都注册 provider-card 座位。[用户提供方指南](../../../../docs/user/guide/providers.zh.md) 把 Cursor 与 Codex 并列写为订阅登录。首次运行的 `needsSetup` 不把 Cursor 行当成 DeepSeek 式的密钥卡片。

TUI `/login` 已经列出每条 flow；Cursor 行是 `llm-cursor/cursor`，没有 Cursor 专用命令。[TUI `/login` 命令](2026-09-15-tui-login-and-effort-cycle.zh.md) 与[浏览器交接](../bug-fix/2026-09-16-tui-subscription-sign-in-browser-handoff.zh.md) 仍是界面；它们不学习 Cursor 协议。

## Alternatives considered

**在 `dsh-llm-pi-ai` 里加一个伪造的 `cursor` 目录提供方。** Models 页与 `/login` 几乎不用改 UI 就能工作，凭据也会落在 `llm-pi-ai/cursor`。非官方的 Connect/protobuf 栈就会住进本为复用 pi-ai 目录和三种可重建线路协议而存在的适配器。`provider.ts` 已经拒绝它无法重建的协议。一个组合也不能在丢掉 Cursor 的同时保住其它 pi-ai 路由。

**依赖 `@rahularya01/pi-cursor` 并 shim Pi 的 ExtensionAPI。** 该包是仅支持 Bun 的 Pi Coding Agent 扩展（`pi.registerProvider`），不是库。DSH 是 Node，也没有 ExtensionAPI。对 `pi-coding-agent` 的 peer 依赖以及 `engines.bun` 会与源码启动和 CI 冲突。

**像当前 pi-cursor 那样挂起 HTTP/2 会话并跑 Cursor 原生工具。** 这更接近 Cursor IDE 行为，也能在同一次 Run 的工具中途恢复。DSH 已经通过 agent loop 拥有工具：发出工具调用的步骤结束，本地工具运行，下一步发送历史。在适配器里保持挂起的 bridge 等于再做一遍该循环，并引入 journal、恢复以及本 harness 不得代 Cursor 执行的工作区 exec。

**像目录型 pi-ai 提供方那样，在出现 `llm-cursor:` 设置之前保持休眠路由。** 这与「哪些提供方在跑由用户的 settings 文档决定」一致，也可以避免在无人关心时把 Cursor 显示在 `/model` 里。pi-cursor 与 `deepseek-official` 都在插件挂载后立即出现；在 `/login cursor` 之后还要 `/settings`，正是这篇记录的 TUI 兄弟已经要为 Codex 写进文档的陷阱。Cursor 适配器除采集外没有有用的配置，因此路由始终注册。

**在工具调用之后的 Run 使用 `resumeAction`。** 协议提供它，Cursor CLI 也用它重试失败的轮次。对着线上服务端，它从该轮的用户消息重新开始：步骤 blob 未被读取，模型以新 id 发出了新的工具调用，而把该调用列入 `pending_tool_calls` 会让 Run 以 `internal` 失败。它无法携带本地产生的工具结果。

**把 harness 系统提示作为 `requestContext` 的 Cursor 规则。** Cursor 把规则渲染进自己的系统提示，一条短规则在新会话上被遵守。但在存在重放历史时，它在两个模型、多种规则路径下都丢掉了一条始终适用的指令，而 `<rules>` user 提示消息保住了它，因此只有适配器的工具提示以规则形式发送。

**把工具结果作为工具调用之后那条用户消息的文本，不发 `tool` 提示消息。** 这是 pi-cursor 的降级恢复路径，不需要适配器自有的提示。它让 assistant 的 `tool-call` 后面直接跟着一条用户消息，而 OpenAI 与 Anthropic 风格的请求校验会在其他 Cursor 模型上拒绝这种序列，所以结果留在 `tool` 消息里，由提示填补必需的用户位置。

**默认 `reuseInstalledCursorLogin` 为 false。** 对并非 Cursor 的产品更安全：不会静默读取另一个应用的令牌。它也丢掉 Pi「若 Cursor 应用已登录则直接可用」的路径，而这正是要看 pi-cursor 的主要原因。退出开关仍是该配置字段。

**把 `~/.pi/agent/auth.json` 或 Cursor 的文件当作存储。** 拿到可用令牌最快，其它提供方也已有 pi-ai 式的环境发现。它把 DSH 绑到另一个工具为单一厂商准备的私有文件，跳过授权 seam，并让 Web/TUI 没有「已登录」可展示。采集只是请求时的回退；持久授权是 harness 记录。

**把每条连续的 user 角色消息都拼进 Run 动作和历史中的 `<user_query>`。** 这样注入的上下文不会替换人类提示，而且每轮只需一个字符串。Cursor 会把该字符串当作用户任务，于是 skill 目录里“行动前先加载 skill”的句子就成了模型要执行的指令。人类文本留作查询；目录、快照和通知留在根提示上，不加该包裹。

## Consequences

挂载 base bundle 后，`authorization.list()` 包含带 `oauth` 订阅方法的 `llm-cursor/cursor`，并且 TUI `/login` 提供 Cursor。设置 → 模型在尚未添加提供方时就显示带订阅登录控件的 Cursor 卡片。PKCE 登录打开 `loginDeepControl`，轮询至拿到令牌，提交授权，并报告 `authorized`；中止或超时不存储任何内容。`cursor/<model>` 经 harness 的 `StreamChunk` 约定流出文本（以及模型发出的 thinking）；一次 MCP 工具调用结束该流；缺少令牌时在 HTTP/2 之前以 `MISSING_CREDENTIAL` 失败。

Cursor 可能不预先通知就改 `agent.v1`、认证 URL 或头；包 README 写明该集成为非官方且可能损坏，未知 exec 使该轮失败而不是挂起。采集 IDE 或 CLI 令牌可能把账记到人类未预期的另一个 Cursor 账户；已存储的 DSH 登录优先，`reuseInstalledCursorLogin` 是退出开关。vendoring proto 与裁过的客户端会造成相对 pi-cursor 的维护分叉；接受协议漂移，以换取 Node 自有适配器，以及不依赖 Bun/ExtensionAPI。

## Testing

包测试覆盖 OAuth、采集、登录提交、目录回退、fixture 原生帧、归属头、中止 HTTP/2、插件 last-good 设置、Loader 组合，以及 `llm-cursor/cursor` 的 Models 卡片联接。真实 Cursor e2e 在没有 `CURSOR_ACCESS_TOKEN` 时跳过，覆盖文本回复、对系统提示和先前助手轮次的回忆，以及工具结果继续；当账户的可用列表变化时，`DSH_CURSOR_E2E_MODEL` 覆盖模型 id。`models-settings` Web e2e golden 包含 Cursor 卡片与登录控件。没有 `SessionEventMap` 或 SDK snapshot 变更。`pi-cursor` 不在 `package.json` 中。
