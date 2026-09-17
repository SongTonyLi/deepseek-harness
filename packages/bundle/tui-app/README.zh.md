---
description: "dsh 的交互式终端模式：在你的终端里与 agent（智能体）对话，带流式回复、工具卡片、审批、提问、斜杠命令、@ 引用、附件与会话切换。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-tui-app

[English](README.md) | 中文

## 概述

`dsh-tui-app` 是 dsh 的终端表层：`dsh tui` 在你当前所在的终端里启动一个多轮会话，没有浏览器托管的应用、也没有服务器。回复实时流式显示，工具调用变成可折叠的卡片，审批与 `ask_user_question` 的问题出现在输入框上方，`@` 补全路径与会话，`/attach` 加入图片与文件，`/` 命令与 Web 共用注册表。会话持久化：`/sessions`、`/new` 与 `/fork` 在会话间切换，`/export` 写出浏览器的 ZIP，`--resume` 稍后继续。它运行与 `dsh web` 相同的模型、工具与安全默认值，同一时间一个会话。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

启动会话、输入、就地阅读答案。`dsh tui` 是 `dsh --profile tui` 的别名；命令行上可选的首个提示会在终端就绪后立即提交。

### 启动与恢复

```sh
dsh tui                                   # new session, wait for input
dsh tui "explain this repository"         # new session with a first prompt
dsh tui --resume <session-id>             # continue an earlier session
dsh tui --no-open                         # print sign-in URLs without opening a browser
```

退出时应用在 stderr 为当时绑定的会话打印 `dsh: session <id> saved; resume with: dsh --profile tui --resume <id>`。恢复的会话会在接受输入前先重绘其持久化历史；在终端内，`/sessions` 打开覆盖所有持久化根会话的选择器，`/new` 开始一个新会话，`/fork` 把当前会话复制到其最后一个完成轮次并作为新会话，切割点与浏览器的 fork 相同。切换会释放先前的 Agent 并重绘下一个会话的对话记录。

### 屏幕布局

页眉在标题生成或设置后以标题命名会话，并在旁边显示 id。对话记录在终端自身的回滚区中增长：你的提示以 `›` 开头（附件列在其下），assistant 的推理以暗色显示在 Markdown 回复上方，每次工具调用是一张卡片，含状态符号、工具名、呈现器标题，以及折叠到 `toolPreviewLines` 行的正文。对话记录下方依次是 agent 工作时的旋转指示、任何打开的提示、编辑器，以及两行页脚：模型与推理强度、权限预设、累计 token 用量、上下文窗口百分比、来自投影接缝的 todo、目标与计划模式标记、workspace、待发送附件数量与按键提示。压缩与模型请求重试以通知形式出现，与浏览器标记承载的事实相同。

### 按键与命令

| 按键 | 效果 |
|---|---|
| `Enter` | 发送编辑器文本；轮次进行中时它排队到下一轮次 |
| `Ctrl+S` | 轮次进行中时，把编辑器文本引导（steer）进当前轮次的下一步 |
| `Shift+Enter` | 插入换行 |
| `Shift+Tab` | 循环切换当前模型的推理强度，从下一次请求生效 |
| `Up` / `Down` | 调出先前的提示 |
| `Esc` | 停止正在进行的轮次；已排队的消息保持排队 |
| `Ctrl+O` | 展开或折叠所有工具卡片 |
| `Ctrl+C` | 清空编辑器；600 ms 内再按一次则退出 |
| `Ctrl+D` | 编辑器为空时退出 |

在编辑器开头输入 `/` 会补全终端自身的命令与共享注册表的命令；任意位置的 `@` 补全引用。

| 命令 | 效果 |
|---|---|
| `/help` | 列出命令与按键 |
| `/model` | 为下一次请求选择模型，若模型声明多于一种推理强度则接着选择强度；`/model <provider>/<model>` 直接选择，`/model save` 把当前选择存为默认 |
| `/sessions` | 选择另一个持久化会话并切换过去 |
| `/new` | 开始新会话 |
| `/fork [turn]` | 在本会话最后一个完成轮次处 fork，或在第 `turn` 轮之后 fork |
| `/title <text>` | 重命名本会话；单独使用时显示当前标题 |
| `/attach <path>` | 把图片或文件附加到下一条提示；`/attach` 列出，`/attach clear` 丢弃 |
| `/queue` | 显示为下一轮次与下一步排队的消息；`/queue clear` 丢弃它们 |
| `/skills` | 列出 agent 可加载的技能 |
| `/signin` | 通过提供方的通知与提示登录；`/signin <key>` 跳过选择器 |
| `/login` | 用提供方订阅登录（隐藏仅收集密钥的登录）；`/login <key>` 跳过选择器 |
| `/export [dir]` | 把本会话的日志 ZIP（含子会话与附件）写入 `dir`，默认 workspace |
| `/status` | 上下文窗口用量与构成、含缓存命中的 token 总计、会话统计、todo、目标、计划模式与权限 |
| `/outline` | 本会话各轮次及其提示与回复预览 |
| `/deliverables` | agent 交付的文件，按轮次分组 |
| `/subagents` | 本会话之下的子 agent 会话，含活动状态与 id |
| `/settings [ns [path value]]` | 列出命名空间、显示某一个或设置某个字段；`/settings reset <ns>` 恢复默认 |
| `/plugins` | 已组合的插件及其启用状态与生命周期阶段 |
| `/tools` | 像 `Ctrl+O` 一样展开或折叠所有工具卡片 |
| `/quit`、`/exit` | 保存会话并退出 |

其他每条 `/name` 行都交给共享命令注册表，因此 `/compact`、`/permission`、`/goal` 与插件命令的行为和浏览器中一致。

### 订阅登录

`/login` 只存储订阅凭据，不会激活休眠的模型路由。先配置 catalog 路由，再使用完整的凭据键；例如先运行 `/settings llm-pi-ai providers.openai-codex {}`，再运行 `/login llm-pi-ai/openai-codex`。被标记的授权页面会在本地默认浏览器中打开，其 URL 同时保留在对话记录中作为后备。SSH 启动、无桌面的宿主、`--no-open` 以及打开器失败时，手动 URL 与设备码路径仍然可用。

### 来自 agent 的提示

审批请求绘制 `Allow <tool>?`、请求方的理由、请求所指的已记录调用（与其工具卡片相同的行，因此 shell 命令在运行前可读）以及两行选项：允许一次或拒绝；`Esc` 拒绝，`Ctrl+C` 取消该请求。`ask_user_question` 的问题把其 `detail` 渲染为 Markdown，置于选项与一行自由文本之上；多选用 `Space` 切换各行并通过 `Done` 确认。计划评审（`exit_plan_mode` 设置的 `plan-review` 意图）把计划绘制为 Markdown，并提供 Approve、Decline 与 Discuss 行，其中 Discuss 像浏览器卡片一样把请求交回编辑器。提示排队、一次只显示一个，被中止的请求会撤回其提示。

### 引用与附件

`@` 后接文本会列出匹配的文件与目录——相对工作区、从工作区出发的 `../`、从家目录出发的 `~/`、或绝对路径——以及其他会话，使用与浏览器编辑器插入相同的提及语法（`@path`、`@"path with spaces"` 与不透明的 `@[label](…)` 会话标记）；base 行把这些提及解析进提示，与浏览器中完全一致。`/attach <path>` 读取相对于 workspace 的本地文件并通过已组合的附件存储保存：`.png`、`.jpg`、`.jpeg`、`.webp` 与 `.gif` 作为图片块，其余作为文件块；待发送附件随下一条提示一起发送，并列在其下。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `prompt` | 无 | 终端就绪后提交的首个提示 |
| `resume` | 无 | 要继续的持久化会话 id，而不是新建会话 |
| `toolPreviewLines` | `8` | `Ctrl+O` 展开前折叠的工具卡片正文行数 |
| `openBrowser` | `true` | 把被标记的授权页面交给本地默认浏览器 |

`prompt`、`resume` 与 `openBrowser` 经启动提供方来自命令行；生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tui-app)是所有可接受字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

runner 与 `dsh-headless` 一样是核心 API 载体之上的直接驱动器，但会一直运行到用户退出，并通过 pi 编码 agent 的差分终端渲染器 [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi) 绘制。

### 运行流程

runner 等待完整应用就绪（`ctx.get('loader')?.await()`），并在核心注册表之上构建含三个操作的会话宿主：`create` 用共享的 [`agentDefaultModel`](../../core/agent-default-model/README.zh.md) 选择创建一个全新的持久化 Agent，`resume` 通过 `ctx.sessionPersistence` 的只读句柄分页读取持久化日志并经注册表恢复 Agent，`fork` 通过 `ctx.sessionQuery` 观察源会话、在所选（默认最后一个）`turn/end` 之后直到下一个 `turn/start` 处切割，并创建带 `parentSession` 与 `isSeeded` 元数据的种子 Agent。每个操作都在 Agent 的作用域 setup 中安装 `ModelSelectionRef`，因此 `/model` 会改变下一次请求。终端应用从 `--resume` 或一次新的 `create` 产生的会话开始，订阅 `session/event`、`agent/assistant-stream` 与 `agent/status`，只为绑定的 Agent 应答 `approval/request` 与 `user-questions/request` waterfall，并通过绑定下一个会话、dispose 先前句柄来切换会话；宿主打开下一个会话期间编辑器拒绝输入，等待期间退出会释放随后到达的会话。退出时取消任何进行中的轮次、等待完全停稳、flush 绑定的会话、dispose 其句柄并请求以 0 退出；驱动器失败会向 stderr 写入 `dsh: <message>` 并请求以 1 退出。Shift+Tab 循环切换绑定模型的适配器自有推理强度，并在提供方默认值处回绕；`/login` 只带着订阅方法（除收集密钥的 `api-key` 登录外的每一种方法）启动 `authorization.begin`。flow 用 `openInBrowser` 标记的 notice 会经 `dsh-native-command` 的凭据擦除辅助进程交给默认浏览器，URL 同时保持打印；当 `openBrowser` 为 false、启动经过 SSH 或宿主没有桌面时抑制该交接，打开器失败则成为 URL 旁的一条通知，而非登录失败。

### 渲染模型

持久事实来自会话日志：`user/message`（自己提交的消息只绘制一次，其回显按消息 id 跳过；插件通知是一行暗色文字，其他注入的上下文不绘制）、`assistant/message`（用已提交文本替换流式块，并把用量折入页脚）、`tool/call` 与 `tool/result`（工具声明 `presentCall` 与 `presentResult` 视图时据此绘制，否则回退到原始参数与原始结果）、`turn/end` 通知、`session/title`（页眉）与 `permission/preset`（页脚）。实时增量来自 `agent/assistant-stream` 的文本与推理增量。日志之外的会话事实来自浏览器读取的同一批服务：`sessionTitle`、`permissionPresets`、供选择器与 `/deliverables` 使用的 `sessionQuery`、供页脚、`/status` 与 `/outline` 使用的 `sessionProjections`、供 `@` 补全使用的 `fileReferences` 与 `sessionReferenceResolver`、`attachments`、`skills`、`authorization`、`settings`、`subagents`，以及供 `/plugins` 使用的 Loader 条目。模态提示是进程本地的呈现，从不写入日志。

### 基于 base 的 patch 面

该 patch 叠加在 `dsh-base` 之上：在 base 的 `system-prompt` 行上设置编码 persona 前缀与 cwd 后缀，保留与 Web 表层相同的临时进程级 PTC 模式开关（`DSH_TOOLS_MODE`），插入 PTC 模式的 worker，挂载由终端应答其问题的模型侧 `ask_user_question` 工具，挂载浏览器所组合的同一批 `@` 引用解析器（`file-reference-local`、`session-reference`）与 `present` 交付物工具，加入 `/outline` 与 `/status` 背后的 `session-turn-outline` 与 `session-stats` 投影行，并挂载启动提供方与 runner。base 的 agent 平面行（bash、文件系统、技能、目标、压缩、子 agent）保持启用，因为终端在进程范围内组合其 Agent。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `tui-app` 插件：会话宿主（创建、恢复、fork）、历史读取、退出流程、退出码映射 |
| [`src/startup.ts`](src/startup.ts) | `tui-app-startup` 提供方：提示位置参数、`--resume`、`--no-open` 与 `--help` |
| [`src/app.ts`](src/app.ts) | 终端应用：布局、按键、命令、会话绑定、接缝、日志与流的折叠 |
| [`src/sessions.ts`](src/sessions.ts) | 基于查询引擎的 `/sessions` 列表及其选择器行 |
| [`src/attach.ts`](src/attach.ts) | `/attach`：本地文件经附件存储成为图片或文件块 |
| [`src/export.ts`](src/export.ts) | `/export`：通过导出包的归档辅助函数写出会话日志 ZIP |
| [`src/blocks.ts`](src/blocks.ts) | 对话记录组件：用户提示、assistant 回复、工具卡片、通知 |
| [`src/prompts.ts`](src/prompts.ts) | 审批、提问与选择器提示以及模态队列 |
| [`src/transcript.ts`](src/transcript.ts) | 呈现视图、用量与轮次结束原因的纯文本折叠 |
| [`src/diff.ts`](src/diff.ts) | diff 卡片的行 diff 与 hunk 选择 |
| [`src/style.ts`](src/style.ts) | 调色板与派生的 pi-tui 主题 |
| [`src/completion.ts`](src/completion.ts) | 编辑器的斜杠命令与 `@` 引用补全 |
| [`src/status.ts`](src/status.ts) | 基于投影接缝的页脚部件与 `/status` 报告；压缩与重试通知 |
| [`src/catalog.ts`](src/catalog.ts) | `/settings`、`/plugins`、`/subagents`、`/deliverables` 与 `/outline` 的行 |
| [`cordis.patch.yml`](cordis.patch.yml) | 基于 `dsh-base` 的终端 patch |
| — | 不发布运行时不变量伴随模块；应用只在一个 Agent 上注册监听器，不持有其他观察者可能与之矛盾的可变关系。 |
| [`tests/app.spec.ts`](tests/app.spec.ts) | 基于伪终端的渲染、按键、命令与两个接缝 |
| [`tests/commands.spec.ts`](tests/commands.spec.ts) | 基于脚本化服务的会话、附件、队列、技能、登录、`/login`、Shift+Tab 推理强度循环、导出、引用与推理强度命令 |
| [`tests/panels.spec.ts`](tests/panels.spec.ts) | 状态页脚与报告、目录命令、命令提示与审批详情 |
| [`tests/index.spec.ts`](tests/index.spec.ts) | 创建、恢复分页、fork 切割、会话切换、退出流程与失败报告 |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | 基于真实 Loader 配置树的命令行解析 |
| [`../../../apps/cli/tests/profiles/tui/tests/keyless-smoke.e2e.ts`](../../../apps/cli/tests/profiles/tui/tests/keyless-smoke.e2e.ts) | 通过真实启动器与免密钥模拟模型运行随附 profile |

### 不变量归属

不发布不变量伴随模块，因为应用的可观察契约（stdout 上的对话记录、退出码、持久化会话）是进程级的，由启动器 e2e 持有；该插件只注册监听器，配置树内没有需要审计的可变关系。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

想深入了解共享核心、同级表层或终端应答的接缝时，阅读这些页面。

- [组合包地图](../README.zh.md)——构建在同一核心上的各表层。
- [dsh-base](../base/README.zh.md)——终端所运行的共享核心。
- [dsh-headless](../headless/README.zh.md)——面向脚本与 CI 的一次性同级表层。
- [dsh-web-app](../web-app/README.zh.md)——面向多会话工作的浏览器同级表层。
- [dsh-user-approval](../../interaction/user-approval/README.zh.md) 与 [dsh-user-questions](../../interaction/user-questions/README.zh.md)——终端应答的两个接缝。
- [dsh-commands](../../interaction/commands/README.zh.md)——`/` 命令背后的注册表。
- [dsh-file-reference](../../context/file-reference/README.zh.md) 与 [dsh-session-reference](../../context/session-reference/README.zh.md)——`@` 提及语法与解析器。
- [dsh-session-log-export](../../session-query/session-log-export/README.zh.md)——`/export` 写出的归档。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tui-app)——所有可接受的配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 runner 把键入的文本作为普通用户消息提交，提示与工具由已组合的 base 与终端配置行持有。

#### KV Cache 影响

runner 不向请求前缀添加任何内容；`/model` 切换像在浏览器中一样开始新的请求序列。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制描述随发行版交付的终端表层；它们不是一般的 CLI 比较，也不是任务积压。

- **同一时间一个会话**——`/sessions`、`/new` 与 `/fork` 在会话间切换终端，但只有绑定的 Agent 流式显示；浏览器可并排展示多个会话。
- **审批为一次性**——提示只提供允许一次或拒绝，与审批接缝的词汇一致；没有记忆的授权。
- **仅浏览器的页面留在浏览器**——workspace 与目录选择器、在应用中打开的链接、轨迹账本与逐条消息的点赞/点踩没有终端对应物；`/settings`、`/plugins`、`/subagents`、`/outline` 与共享的 `/feedback` 以文本覆盖其事实，子 agent 的对话记录通过切换到子会话来阅读。
- **交付物只列名、不打开**——`/deliverables` 列出交付路径；浏览器会预览这些文件。
- **历史由终端回滚区持有**——除工具卡片外，对话记录不可搜索或折叠；更丰富的导航由浏览器表层持有。
- **通过 `dsh` 启动器运行**——以其他方式启动该 profile 会在启动时失败，因为只有启动器能请求进程退出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

`tests/bench.ts` 持有伪 `Terminal` 与脚本化的会话宿主；用它的 `type()` 输入按键，用 `text()` 读取渲染文字（后者会剥离 CSI、OSC 与 APC 序列），并从 `hostCalls` 与 `opened` 读取切换做了什么。pi-tui 把渲染节流到每 16 ms 一帧，因此测试在读取屏幕前通过 `settle()` 等待。命令读取的服务（`sessionTitle`、`attachments`、`authorization`……）经 bench 的 `before` 钩子以窄桩提供。

</details>
