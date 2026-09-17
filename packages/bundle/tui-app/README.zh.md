---
description: "dsh 的交互式终端模式：在你的终端里与 agent（智能体）对话，带流式回复、工具卡片、用键盘浏览对话记录、审批、提问、斜杠命令、@ 引用、附件与会话切换。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-tui-app

[English](README.md) | 中文

## 概述

`dsh-tui-app` 是 dsh 的终端表层：`dsh tui` 在你所在的终端里启动一个多轮会话，没有浏览器托管的应用、也没有服务器。回复流式显示，工具调用变成可折叠的卡片，审批与 `ask_user_question` 的问题出现在输入框上方，`@` 补全路径与会话，`/attach` 加入图片与文件，`/` 命令与 Web 共用注册表。方向键在停靠的检视面板中走遍对话记录。会话持久化：`/sessions`、`/new` 与 `/fork` 在会话间切换，`/export` 写出浏览器的 ZIP，`--resume` 稍后继续。它运行 `dsh web` 的模型、工具与安全默认值，同一时间一个会话。

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

页眉在标题生成或设置后以标题命名会话，并在旁边显示 id。对话记录在终端自身的回滚区中增长：你的提示以 `›` 开头（附件列在其下），assistant 的推理以暗色显示在 Markdown 回复上方，每次工具调用是一张卡片，含状态符号、工具名、呈现器标题，以及折叠到 `toolPreviewLines` 行的正文。流式文字会淡入，而且每个词各走各的时钟：一个词以接近终端背景色的亮度出现，并经 `streamFadeSteps` 级亮度、每级 `streamFadeStepMs` 提亮到它最终稳定的颜色，因此流得更快只会留下更长的一串正在提亮的词，而不会更暗。同一套淡入也覆盖流式推理（它稳定在自身绘制所用的暗色前景）与工具卡片：卡片的表头与调用行在调用被记录时淡入，结果行在工具应答时淡入；从持久化历史重绘的卡片不带淡入，已经稳定下来的文字也不会再被调暗。对话记录下方依次是 agent 工作时的旋转指示、任何打开的提示、编辑器、子 agent 面板，以及页脚：一行分段状态栏，其下是一行按键提示。编辑器的光标是终端自身的闪烁竖条：应用在启动时请求这一形状，退出时把你的默认形状还回去，而状态栏或面板持有键盘期间完全不绘制光标。每个分段只在其事实存在时出现——模型与推理强度、权限预设、正在进行轮次的已用时间、累计 token 用量、上下文窗口百分比、来自投影接缝的 todo、目标与计划模式标记、workspace 路径（过长时以 `~` 与 `…/` 缩短）、待发送附件数量——`Shift+Down` 把焦点移入状态栏以查看某个分段的详情。压缩与模型请求重试以通知形式出现，与浏览器标记承载的事实相同。

键盘在对话记录中移动时，编辑器正上方停靠着一个检视面板。它写出当前聚焦小节的名称——它在可导航块中的位置、所属轮次，以及这是哪一种小节，例如 `3/12 · turn 2 · bash git status · result`——在块含多个部分时把这些部分绘制成形如 `‹ reasoning · reply ›` 的一条选择行，把该小节自身的源文本行截到 `focusPreviewLines` 行并在其下写出 `… <n> more rows · Enter opens the page`，最后以一行暗色文字列出它所应答的按键。被聚焦的块也会在原地被标记：一条两列宽的标记条，在块的其他行旁为暗色、在被聚焦小节自身的行旁为强调色，标记绘制期间该块的内容按窄两列换行。这个标记只能落在 pi-tui 仍以差分方式重绘的行上——也就是它写出的上一帧的最后 `rows` 行，这条边界只会被更高的帧抬高、不会被更矮的帧降低——因为改动其上方的任何一行都会清空终端的回滚区；已经滚过该位置的块不带标记条，其检视面板标题改为写出 `off screen`；淡入中的各行抵达这一边界时，会在写出该帧的同一帧内被结算为最终颜色，因此回滚区里不会留下暗色文字。

子 agent 面板在绑定会话之下有常驻的子 agent 会话、或列表中带有无法读取的候选者时绘制。其标题统计所列出的条目，每一行给出该子会话的层级缩进、其标签或 id、其模式（`one-shot` 或 `continuable`）、`resident`、其 agent 处于 `running` 还是 `idle`、其已用时间——进行中轮次的用时，否则是已结束轮次的合计——以及其 token 用量，以本进程对该子会话的可见程度与已组合的投影所能提供的为限。最多绘制六行，其下是 `+<n> more · /subagents lists them all`；列表无法解读的候选者绘制为 `unreadable: <reason>` 且打不开任何页面，读取失败的列表则保留上一次成功读取产生的各行，并在其下写出 `listing failed: <reason>`。面板随其最后一行一同消失。

### 按键与命令

| 按键 | 效果 |
|---|---|
| `Enter` | 发送编辑器文本；轮次进行中时它排队到下一轮次 |
| `Ctrl+S` | 轮次进行中时，把编辑器文本引导（steer）进当前轮次的下一步 |
| `Shift+Enter` | 插入换行 |
| `Shift+Tab` | 编辑器持有焦点时，循环切换当前模型的推理强度，从下一次请求生效 |
| `Up` / `Down` | 调出先前的提示 |
| `Shift+Up` | 把焦点放到对话记录的最新块上；在任何区域都直接跳过去 |
| `Shift+Down` | 面板已绘制时把焦点放到其第一行，否则放到状态栏的第一个分段；在任何区域都直接跳到状态栏 |
| `Esc` | 停止正在进行的轮次；已排队的消息保持排队 |
| `Ctrl+O` | 展开或折叠所有工具卡片 |
| `Ctrl+C` | 清空编辑器；600 ms 内再按一次则退出 |
| `Ctrl+D` | 编辑器为空时退出 |

对话记录、子 agent 面板与状态栏按此顺序自上而下排布，`Up` / `Down` 走遍整个序列且在两端都不环绕。对话记录持有焦点时，`Up` / `Down` 在块之间移动——你的提示、assistant 消息与工具卡片，通知与打印出的报告会被跳过——`Left` / `Right` 在块的各部分之间移动，也就是一条消息的推理与回复、一次工具调用的调用与结果，`Enter` 把当前聚焦的部分作为只读页面打开、其中带有该部分的完整各行，离开后回到同一部分，`Esc` 把焦点交还编辑器。各部分承载的是块自身的源文本，因此一条回复读到的是模型写下的 Markdown，而不是其上方绘制出的渲染结果。除 `Ctrl+C` 与 `Ctrl+D` 外，其他按键都在此被消费；切换会话会把焦点交回编辑器，尚无可查看内容的会话对 `Shift+Up` 回以 `nothing in the transcript to inspect yet` 并把键盘留在编辑器。

状态栏持有焦点时，`Left` / `Right` 与 `Tab` / `Shift+Tab` 在分段之间移动并在两端环绕，`Up` 在面板已绘制时离开状态栏前往面板的最后一行、否则前往对话记录，`Enter` 打开所选分段且状态栏保持焦点，`Esc` 把焦点交还编辑器。状态栏持有焦点期间其他按键不会到达编辑器；`Ctrl+C` 与 `Ctrl+D` 保持其一贯含义，并把焦点交还编辑器。

子 agent 面板持有焦点时，`Up` / `Down` 移动选择，并在其两端继续进入相邻区域——在第一行按 `Up` 到达对话记录，在最后一行按 `Down` 到达状态栏——`Enter` 把该子会话的详情作为只读页面打开、离开后回到面板的同一行，`Esc` 把焦点交还编辑器。除 `Ctrl+C` 与 `Ctrl+D` 外，其他按键同样在此被消费；面板的最后一行离开时，它也会把键盘交还编辑器。

除 `todo` 之外的每个分段都把详情打印到对话记录，陈述其当前事实并指出改变它们的方式：模型分段指出 `/model`，推理强度分段指出 `Shift+Tab`，权限分段指出其预设；`turn` 分段——绘制在权限与用量分段之间、形如 `turn <elapsed>`，且只在轮次进行时出现——给出轮次编号、其开始时间、已用时间与排队消息数量；用量、上下文、目标与计划分段打印 `/status` 报告中对应的小节，workspace 分段显示完整路径，附件分段列出待发送的附件。`todo` 分段则改为打开 agent 的 todo 列表，与 `/todos` 打开的是同一个列表。

在编辑器开头输入 `/` 会补全终端自身的命令与共享注册表的命令；任意位置的 `@` 补全引用。

| 命令 | 效果 |
|---|---|
| `/help` | 列出命令与按键 |
| `/model` | 为下一次请求选择模型（输入即可过滤行），若模型声明多于一种推理强度则接着选择强度；`/model <provider>/<model>` 直接选择，`/model save` 把当前选择存为默认 |
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
| `/todos` | 浏览 agent 的 todo 列表；`Enter` 完整打开其中一条，含其状态、位置与轮次 |
| `/outline` | 本会话各轮次及其提示与回复预览 |
| `/deliverables` | agent 交付的文件，按轮次分组 |
| `/subagents` | 浏览本会话之下的子 agent 会话；`Enter` 打开某个会话的详情 |
| `/settings [ns [path value]]` | 列出命名空间、显示某一个或设置某个字段；`/settings reset <ns>` 恢复默认 |
| `/plugins` | 已组合的插件及其启用状态与生命周期阶段 |
| `/tools` | 像 `Ctrl+O` 一样展开或折叠所有工具卡片 |
| `/quit`、`/exit` | 保存会话并退出 |

其他每条 `/name` 行都交给共享命令注册表，因此 `/compact`、`/permission`、`/goal` 与插件命令的行为和浏览器中一致。

终端打开的每个选择器——`/model` 的模型列表与推理强度列表、`/sessions`、`/subagents` 与 `/todos` 的列表，以及 `/signin` 与 `/login` 引出的各行——都随输入过滤其行：查询同时匹配每行的标签与描述，其以空白与斜杠分隔的各段必须全部匹配，各行按最佳匹配在前排序，因此 `dsk chat` 与 `deepseek/chat` 都能找到 `deepseek/deepseek-chat`，`gpt5` 能找到 `gpt-5`。`Backspace` 删除最后一个字符，`Ctrl+U` 清空查询，`Esc` 在查询非空时清空查询、在查询为空时取消选择器，`Up` / `Down` 在匹配行之间移动，`Enter` 选中高亮行。行上方的暗色行在查询为空时显示 `type to filter · Enter selects · Esc cancels`，此后显示 `filter: <query> · <kept>/<total>`；无任何行匹配的查询会以 `no row matches "<query>"` 取代这些行，而生效行上的 `✓`——也就是选择器打开时定位的那一行——只在查询为空时显示。

`/subagents`、`/todos` 与状态栏的 `todo` 分段共用同一套先列表、后详情的交互：选择器列出各条目，`Enter` 把高亮条目作为只读页面打开，`Up` / `Down` 与 `PageUp` / `PageDown` 滚动该页面，`Enter`、`Esc` 或 `Left` 返回列表并停在刚读过的条目上，因此连续查看多个条目无需重新输入命令；在列表上按 `Esc` 返回编辑器。详情无法读取的条目会在其页面上说明原因，而不会关闭列表。

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
| `focusPreviewLines` | `12` | `Enter` 完整打开之前，停靠的检视面板为聚焦小节显示的行数 |
| `liveRefreshMs` | `1000` | 重绘周期：推进 `turn` 分段与面板中的已用时间，并重新读取已过期的子 agent 列表 |
| `streamFadeSteps` | `8` | 一个流式词、一个推理词或一张工具卡片在以其稳定颜色绘制之前经过的亮度级数 |
| `streamFadeStepMs` | `33` | 每级亮度持续多久，因此一个词在出现后 `streamFadeSteps × streamFadeStepMs` 稳定下来；这也是淡入的重绘周期 |
| `reducedMotion` | `false` | 以稳定颜色绘制流式文本、流式推理与工具卡片，不做淡入，也不重复重绘 |
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

持久事实来自会话日志：`user/message`（自己提交的消息只绘制一次，其回显按消息 id 跳过；插件通知是一行暗色文字，其他注入的上下文不绘制）、`assistant/message`（用已提交文本替换流式块，并把用量折入页脚）、`tool/call` 与 `tool/result`（工具声明 `presentCall` 与 `presentResult` 视图时据此绘制，否则回退到原始参数与原始结果）、`turn/end` 通知、`session/title`（页眉）、`permission/preset`（页脚），以及所属 `turn/start` 之下的 `todo/write`（某条 todo 的详情页所报告的轮次；该列表不带逐条标识，因此改写措辞的条目算作新条目）。实时增量来自 `agent/assistant-stream` 的文本与推理增量。日志之外的会话事实来自浏览器读取的同一批服务：`sessionTitle`、`permissionPresets`、供选择器、`/deliverables` 与子 agent 详情使用的 `sessionQuery`、供页脚、`/status`、`/todos` 与 `/outline` 使用的 `sessionProjections`、供 `@` 补全使用的 `fileReferences` 与 `sessionReferenceResolver`、`attachments`、`skills`、`authorization`、`settings`、`subagents`，以及供 `/plugins` 使用的 Loader 条目。模态提示是进程本地的呈现，从不写入日志。

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
| [`src/blocks.ts`](src/blocks.ts) | 对话记录组件：用户提示、assistant 回复、工具卡片、通知；可导航的块还暴露其各小节并绘制焦点标记条 |
| [`src/navigation.ts`](src/navigation.ts) | 把对话记录看作各个小节、走遍它们的光标，以及检视面板的标题 |
| [`src/inspector.ts`](src/inspector.ts) | 停靠的检视面板：聚焦小节的标题、各部分选择行、折叠后的各行，及其挂载的组件 |
| [`src/screen.ts`](src/screen.ts) | 在构建一帧与写出该帧之间带若干次结算的主屏幕、每次结算所依据的重绘窗口，以及每个块的重绘下界 |
| [`src/fade.ts`](src/fade.ts) | 流式文本淡入：基于挂钟的尾部追踪器、块淡入时钟与注册表、感知均匀的亮度级别，以及对已渲染行的重新着色 |
| [`src/prompts.ts`](src/prompts.ts) | 审批、提问、选择器与只读详情提示以及模态队列 |
| [`src/transcript.ts`](src/transcript.ts) | 呈现视图、用量与轮次结束原因的纯文本折叠 |
| [`src/diff.ts`](src/diff.ts) | diff 卡片的行 diff 与 hunk 选择 |
| [`src/style.ts`](src/style.ts) | 调色板与派生的 pi-tui 主题 |
| [`src/completion.ts`](src/completion.ts) | 编辑器的斜杠命令与 `@` 引用补全 |
| [`src/editor.ts`](src/editor.ts) | 去掉 pi-tui 自绘块状光标的提示编辑器，以及终端自身光标所用的 DECSCUSR 序列 |
| [`src/status.ts`](src/status.ts) | 投影接缝的事实，以及 `/status` 报告与分段详情共享的小节；压缩与重试通知 |
| [`src/footer.ts`](src/footer.ts) | 状态栏：有序的各分段、每个分段的详情行，以及页脚渲染出的两行 |
| [`src/subagent-panel.ts`](src/subagent-panel.ts) | 实时子 agent 面板：一次后代列表加上采样到的实时事实构成其各行，各行再构成其文本 |
| [`src/catalog.ts`](src/catalog.ts) | `/settings`、`/plugins`、`/subagents`、`/deliverables` 与 `/outline` 的行 |
| [`src/todos.ts`](src/todos.ts) | todo 列表：状态符号、选择器行与单个条目的详情行 |
| [`cordis.patch.yml`](cordis.patch.yml) | 基于 `dsh-base` 的终端 patch |
| — | 不发布运行时不变量伴随模块；应用只在一个 Agent 上注册监听器，不持有其他观察者可能与之矛盾的可变关系。 |
| [`tests/app.spec.ts`](tests/app.spec.ts) | 基于伪终端的渲染、按键、命令与两个接缝 |
| [`tests/commands.spec.ts`](tests/commands.spec.ts) | 基于脚本化服务的会话、附件、队列、技能、登录、`/login`、Shift+Tab 推理强度循环、导出、引用与推理强度命令 |
| [`tests/panels.spec.ts`](tests/panels.spec.ts) | 状态页脚与报告、可导航的子 agent 与 todo 列表、目录命令、命令提示与审批详情 |
| [`tests/transcript-focus.spec.ts`](tests/transcript-focus.spec.ts) | 走遍对话记录、区域序列、检视面板，以及重绘窗口内的原地标记条 |
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
- **历史由终端回滚区持有**——键盘可以走遍对话记录的每个块与每个部分，但没有搜索，除工具卡片外也没有折叠；更丰富的导航由浏览器表层持有。
- **滚走的聚焦块只在检视面板中被标记**——pi-tui 只对它写出的上一帧的最后 `rows` 行做差分重绘，要改动其上方的内容就得清空终端回滚区，因此更靠前的块得不到标记条，检视面板标题写出 `off screen`；占满终端的页面会把这条边界永久抬高，因此页面关闭后，打开它的那个块也可能写出 `off screen`；该小节仍可在检视面板中、以及 `Enter` 打开的页面上阅读。
- **页面显示的是源文本**——在 assistant 回复上按 `Enter` 打开的是模型写下的 Markdown，而不是对话记录绘制出的渲染结果，因此表格与标题以源码形式呈现。
- **面板列出的是常驻，而不是整棵树**——子会话在其会话记录常驻于本进程期间加入面板，因此由进程外提供方运行、在此没有自己会话的子 agent 永远不会出现；`/subagents` 仍是到达每一个持久后代的途径。
- **常驻不等于正在工作**——列表的 `activity: 'running'` 表示该子会话的记录常驻，这正是行内 `resident` 所报告的内容；子会话是否在工作则是它旁边单独的 `running` / `idle`，读自本进程中该子会话的 Agent。
- **溢出行之后的各行不可选中**——面板最多绘制六行，`Up` / `Down` 在其两端会离开面板；被折叠进 `+<n> more` 的子会话通过 `/subagents` 到达，后者遍历完整的后代树。
- **淡入需要终端的应答**——其亮度级别由终端对启动时发出的查询所报告的背景色构建，因此保持沉默、或既不编码真彩色也不编码 256 色的终端只会得到两级的暗淡模式；`NO_COLOR`、被禁用的调色板、`TERM=dumb` 与 `reducedMotion` 则完全关闭该效果。
- **终端自身的光标可能闪烁**——编辑器不绘制自己的光标，应用打开终端光标，而 pi-tui 会在其重绘的各行之间移动它；不支持 pi-tui 为一帧包裹的同步输出序列的终端可能显示出这种移动。
- **通过 `dsh` 启动器运行**——以其他方式启动该 profile 会在启动时失败，因为只有启动器能请求进程退出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

`tests/bench.ts` 持有伪 `Terminal` 与脚本化的会话宿主；用它的 `type()` 输入按键，用 `text()` 读取渲染文字（后者会剥离 CSI、OSC 与 APC 序列），并从 `hostCalls` 与 `opened` 读取切换做了什么。pi-tui 把渲染节流到每 16 ms 一帧，因此测试在读取屏幕前通过 `settle()` 等待。命令读取的服务（`sessionTitle`、`attachments`、`authorization`……）经 bench 的 `before` 钩子以窄桩提供。

</details>
