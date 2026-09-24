---
description: "通过始终在线的 cursor 路由，以 PKCE 登录和非官方 Connect/protobuf HTTP/2 流式调用 Cursor 订阅模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-cursor

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-llm-cursor` 注册始终在线的 `cursor` 路由，通过 PKCE 用 Cursor 订阅登录，并在非官方 Connect/protobuf HTTP/2 `AgentService/Run` 流上流式执行 harness 的各步；在适配器能够恢复时，一个轮次的各步共享一个 Run。设置 → 模型显示带「登录」的 Cursor 卡片；TUI `/login llm-cursor/cursor` 列出同一条 flow。本包可与 [DeepSeek](../llm-deepseek/README.zh.md) 和 [pi-ai](../llm-pi-ai/README.zh.md) 适配器一起挂载。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当组合需要提供 Cursor 订阅模型时挂载本插件。基础 bundle 已经挂载。插件加载后即注册 `cursor`，没有「添加提供方」步骤。

### 何时选择它

要从 TUI、Web 或带 `CURSOR_ACCESS_TOKEN` / 已存授权的无头组合使用 Cursor 订阅时选择本适配器。Codex 及其它 pi-ai 目录订阅选 `dsh-llm-pi-ai`，官方 DeepSeek 路由选 `dsh-llm-deepseek`。三个适配器可以一起挂载，因为路由名不冲突。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-llm-cursor'
  config:
    apiKeyEnv: CURSOR_ACCESS_TOKEN
    reuseInstalledCursorLogin: true
```

请求用 `provider: cursor` 选择该路由。模型 id 原样通过；捆绑的回退名称包括 `composer-2`、`composer-2-fast`、`composer-1.5`、`claude-4.5-sonnet`、`claude-4.6-opus-high` 和 `gpt-5.1`。登录后 `GetUsableModels` 替换该列表，并缓存到 `$DSH_HOME/cache/llm-cursor/usable-models.json`。未列出的 id 仍作为仅文本路由解析。

| 字段 | 默认 | 含义 |
|---|---|---|
| `apiKeyEnv` | `CURSOR_ACCESS_TOKEN` | 每次请求先解析的凭据引用，然后才是已存授权或采集 |
| `reuseInstalledCursorLogin` | `true` | 请求是否可以复用本机已有的 Cursor IDE 或 CLI 登录 |
| `streamIdleTimeoutMs` | `300,000` | 单次未完成的流式读取允许的最长提供方空闲时间 |
| `parkedRunTimeoutMs` | `1,800,000` | 因工具调用而挂起的 Run 等待其结果的时长，超时即取消 |
| `toolCallSettleMs` | `1,000` | Cursor 尚未发送结束模型消息的检查点时，等待更多并行工具调用的时长 |
| `retryPolicy` | 普通模式，5 次重试 | 由 `dsh-llm-retry` 执行的提供方自有重试策略 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-cursor)是每个已接受字段及其 JSDoc 的完整来源。

### 登录

Web：设置 → 模型 → Cursor → **登录**。对话框打开 `https://cursor.com/loginDeepControl`；完成该页后授权写入 `llm-cursor/cursor`。

TUI：`/login llm-cursor/cursor`。无头不会打开浏览器；导出 `CURSOR_ACCESS_TOKEN`，或复用先前登录写入的授权。

退出登录是对该键做 `deleteRecord`。它不向 Cursor 撤销会话，也不退出 IDE 或 CLI。

<a id="understand-the-implementation"></a>
## 理解实现

请求时令牌顺序为：启动环境中的 `CURSOR_ACCESS_TOKEN`，然后是已存储的 OAuth 授权（临近过期时在 `modifyRecord` 内刷新），然后在 `reuseInstalledCursorLogin` 为 true 时可选读取钥匙串 / `state.vscdb`。已存储的 DSH 登录优先于采集。

新的 Run 由 harness 历史、系统提示和 MCP 工具定义重建（`providerIdentifier: dsh`，`clientName: dsh`）。Cursor 服务端只从 `root_prompt_messages_json` 构建模型提示，从不把 `conversation_state.turns` 渲染进去，并且会丢弃其中的 `{"role":"system"}` 条目而使用自己的提示。因此适配器把系统提示作为 `<rules>` user 提示消息发布，并把每个先前轮次重放为 `user`、`assistant` 和 `tool` 提示消息，把每个历史 harness 工具调用写成 Cursor 为 MCP 工具记录的 `CallDynamicTool` 调用；轮次结构一同发送，供服务端记账。Cursor CLI 的 Run 只通过 `GetDynamicTools` 和 `CallDynamicTool` 向模型暴露 MCP 工具，因此请求上下文的应答额外带一条全局 Cursor 规则，告知模型 Cursor 内建工具在这里会返回拒绝、harness 工具以命名空间 `dsh` 中的 `CallDynamicTool` 调用，以及有哪些工具名。

文本、thinking、用量与 MCP 工具调用变成 `StreamChunk`。当 Cursor 发出模型最后一个并行调用之后的检查点，或 `toolCallSettleMs` 内没有新帧时，MCP 工具调用结束该步。若请求带有 Session 且不是压缩或标题请求，该 Run 随后挂起：适配器每五秒发送一次 `clientHeartbeat` 保持流开启。该 Session 的下一次请求在以下条件成立时恢复它：最后一条 assistant 消息之前的历史不变，且该消息之后只有待处理调用的结果以及 harness 注入的 user 角色上下文；适配器在同一条流上以 `mcpResult` 应答每个调用，把这类上下文追加到最后一个结果之后，并继续读取。任何其他请求、挂起期间死亡的 Run，或超过 `parkedRunTimeoutMs` 的 Run，都回退为新的 Run：它重放该进行中的轮次及其结果，并把一条固定的继续提示作为 Run 必需的用户消息发送；不使用 `resumeAction`，因为服务端会从该轮的用户消息重新开始而不是继续。Cursor 原生或 CLI Pi 工作区 exec（`read`、`shell`、`piRead` 及同类）以其类型化的拒绝应答，并指出应通过 `CallDynamicTool` 调用的 harness 工具，因此 Run 继续进行，模型把该拒绝当作工具结果读取；被拒绝的 exec 之后的文本开启新的文本块。Cursor 原生提问会收到类型化的拒绝：若 harness 提供 `ask_user_question` MCP 工具，拒绝会引导模型调用该工具；否则会引导模型在回复中提问。Run 随后继续。CLI 钩子以空的匹配响应应答。MCP-state exec 返回已通告的 `dsh` 工具。本构建无法类型化的其他 exec 以 ExecClientThrow 应答，以便 Run 继续。没有 payload 的 exec 仍使该步失败。

`LlmAdapter` 要求的归属头出现在每一次 HTTP/2 请求上，并带有 Cursor 客户端头 `x-ghost-mode`、`x-cursor-client-version` 和 `x-cursor-client-type`。

<a id="further-exploration"></a>
## 进一步探索

- [配置模型](../../../docs/user/guide/providers.zh.md) — Web 与 TUI 登录，包括与 Codex 并列的 Cursor。
- [LLM 流式子系统](../../../docs/subsystems/llm-streaming.zh.md) — `StreamChunk` 与适配器约定。
- [Cursor 订阅登录与原生适配器](../../../.agents/notes/implemented/feature/2026-09-18-cursor-subscription-signin-and-adapter.zh.md) — 为何这是第三套适配器族，而不是 pi-ai 目录项。
- [跨工具调用挂起 Cursor Run，并通过 CallDynamicTool 路由 harness 工具](../../../.agents/notes/implemented/architecture/2026-09-23-cursor-parked-runs-and-dynamic-tools.zh.md) — 为何一个轮次停留在一个 Run 上，以及模型如何到达 harness 工具。

<a id="model-experience"></a>
## 模型体验

### Cursor Run 请求

#### 模型看见什么

一次新的 Cursor `AgentRunRequest`，其 `root_prompt_messages_json` 承载模型可见的历史：系统提示作为 `<rules>` user 消息，然后每个先前人类轮次作为 `<user_query>` user 消息，harness 注入的目录、快照和通知作为不被 `<user_query>` 包裹的独立 user 消息，assistant 消息承载文本和写成命名空间 `dsh` 中 `CallDynamicTool` 调用的 `tool-call` 部分，以及承载结果的 `tool` 消息；thinking 不重放。当前用户动作只有人类提示——一次 Run 只有一个 `userMessageAction`，因此 skill 目录和运行时快照走根提示，而不并入该动作。恢复的 Run 不发送新请求：模型把每个工具结果当作自己待处理调用的结果读取，结果之后的 harness 上下文追加到最后一个结果之后。本地执行工具调用之后若 Run 无法恢复，进行中的轮次连同其结果被重放，用户动作是固定提示 `The results of your tool calls are in the tool messages above. This is not a new request: continue the current task from the last tool result. The user has already seen your earlier messages, so do not repeat or rephrase them or restate your plan; write only new information.`。请求上下文带一条全局规则，声明 Cursor 内建工具会返回拒绝、harness 工具以命名空间 `dsh` 中的 `CallDynamicTool` 调用，随后列出 harness 工具名。由于该路由声明只接受文本输入，图片以 harness 的纯文本占位符到达模型；不发送图片字节。Cursor 仍在 harness MCP 工具之外提供自己的内建工具。

#### Token 影响

精确输入由提供方分词决定。新的 Run 承载当前组装好的消息；恢复的 Run 只把工具结果加入 Cursor 已持有的会话。重放的历史在线路上传输两次——作为提示消息和作为轮次结构——但只有提示消息到达模型。Cursor 不报告提示用量，因此 `inputTokens` 是按新 Run 会承载的规则、重放的提示消息、动作文本与 MCP 工具定义每四个字符一个 token 的估算；`outputTokens` 来自 Cursor 的 `tokenDelta` 事件。

#### KV Cache 影响

在 Run 恢复期间，一个轮次的各步共享同一个 Cursor 会话。在系统提示、历史、工具 schema 或模型 id 变化之后，或任何回退之后打开的新 Run，不会复用 Cursor 一侧的会话前缀。

### Cursor Run 响应

#### 模型看见什么

文本增量、thinking 增量、token 用量和 MCP 工具调用变成 harness 分片。模型的并行调用到齐之后，MCP 工具调用以 `tool-calls` 结束该步。原生或 CLI Pi 工作区 exec 以拒绝应答且流继续。CLI 钩子或 MCP-state exec 被应答以保持 Run 开启。本构建无法类型化的其他 exec 以 ExecClientThrow 应答且流继续。没有 payload 的 exec 使该轮失败。

#### Token 影响

生成内容只有在 loop 记录之后才会影响后续输入。输出 token 计数在存在时来自 Cursor 的 `tokenDelta` 事件。

#### KV Cache 影响

恢复的 Run 已持有模型自己的输出。loop 保留的响应块追加到下一次新的 Run。未记录的传输帧不影响之后的缓存身份。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制划定适配器的停止点。它们是当前的包约束，不是与 Cursor 产品的对比。

- **该集成是非官方的** — 认证 URL、头、客户端版本和 `agent.v1` 可能不预先通知就变更并弄坏本适配器。
- **不执行原生 Cursor 工作区 exec** — `read`、`shell`、CLI Pi 工具（`piRead`、`piBash` 及同类）以及同一家族收到指出 harness 工具的类型化拒绝，因此选中它们的模型会在调用 `CallDynamicTool` 之前多花一个往返。
- **CLI 控制 exec 不运行 Cursor 钩子** — 钩子帧得到空的匹配响应，MCP-state 帧列出已通告的 `dsh` 工具，其他未命名 exec 以 ExecClientThrow 应答以使 Run 继续；它们都不执行工作区工作。
- **挂起的 Run 只存在于一个进程中** — 它没有 journal，因此进程重启、工具结果之后的人类消息或任何历史变化都会回退为由历史重建的新 Run。
- **回退的 Run 以重放的提示消息加一条固定继续提示交付工具结果** — 该提示是适配器自有的文本，人类从未输入过；恢复的 Run 把注入上下文放在最后一个工具结果内部交付，而不是作为独立消息。
- **不支持 `GenerateOptions.stop`** — 非官方 Run 不映射停止序列。
- **不发送图片字节** — 该路由声明只接受文本输入，因此每张图片以 harness 的纯文本占位符到达模型，而不是作为 Cursor 选中图片。
- **不映射 `maxTokens`、`temperature` 和 `reasoningEffort`** — Run 没有对应字段；努力程度通过 Cursor 模型 id 后缀（如 `-high`）选择。
- **不重放 reasoning** — Cursor 不渲染 `reasoning` 提示部分，因此回退之后 thinking 模型会重新推导计划；恢复的 Run 保留其 reasoning。
- **提示 token 用量是估算值** — Cursor 不报告，因此 TUI 上下文计量显示适配器基于字符数的估算。
- **退出登录不会在 Cursor 一侧撤销** — 它只删除本地授权；在 `reuseInstalledCursorLogin` 为 false 之前，采集仍可能满足下一次请求。
- **采集可能把账记到另一个 Cursor 账户** — 已存储的 DSH 授权优先；当本机 IDE 登录不是要用的账户时请关掉采集。
- **登录只存在于启动它的那个进程** — 登录途中刷新页面会放弃该次尝试。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本开发备注是非权威的工作上下文：未决方向与维护者备忘。已交付行为与被接受的理由写在上面各节、包代码以及链接的 Agent Note 中。

- `src/native/agent_pb.ts` 是来自 https://github.com/Rahularya01/pi-cursor 与 https://github.com/can1357/oh-my-pi 所用社区 Cursor proto 目录的 MIT 许可生成 schema。覆盖率、oxlint 与 verify-export-jsdoc 排除该文件。运行时不依赖这些包。

</details>

**运行时不变量：** 不发布伴随包。本包不在其所属 seam 已强制的约定之外暴露独立的事件序列或可变数据关系。
