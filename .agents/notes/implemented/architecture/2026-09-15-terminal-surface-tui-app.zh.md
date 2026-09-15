# Agent Note: 以随附 `tui` profile 提供终端表层

Status: implemented

[English](2026-09-15-terminal-surface-tui-app.md) | 中文

## 问题

DeepSeek Harness 只随发行版交付了一个交互式表层，即 `dsh web` 背后的浏览器应用；终端只有一次性的 `headless` runner，它回答单个任务后退出。[TUI 包移除决定](../../archived/simplification/2026-08-04-remove-tui-package.md)删除了早期的终端前端，因为没有任何组合使用它，并为其回归设定了门槛：具名的产品部署、明确的包边界、具体的交互提供方，以及组装后的生命周期验收。想要类似 pi 编码 agent（智能体）终端工作流的用户没有受支持的答案。

## 决定

`packages/bundle/tui-app` 下的 `@deepseek-ai/dsh-tui-app` 是终端表层，`tui` 是随附 profile（`dsh-base` 加 `dsh-tui-app`，只在启动时应用 patch），并以 `dsh tui` 作为与 `dsh web` 并列的启动器别名。该组合包镜像 `dsh-headless`：`tui-app-startup` 命令行提供方发布 `tuiStartup`（可选的首个提示与 `--resume <session-id>`），`tui-app` runner 是核心注册表之上的会话宿主（创建、恢复、以浏览器相同的切割点在最后一个完成轮次处 fork），同一时间驱动一个绑定的 Agent 直到用户退出。该 profile 保持 base 的 agent 平面行启用，并加入 PTC 模式的 worker、`ask_user_question` 工具、`file-reference-local` 与 `session-reference` 解析器以及 `present` 工具，因此终端组合的模型侧行与浏览器相同。

渲染器是 [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi)，即 pi 编码 agent 维护的差分终端库，作为与仓库现有 `@earendil-works/pi-ai` 适配器并列的普通依赖引入，而不是 vendored 或打过补丁的副本。应用把自己的编辑器、Markdown、选择列表与加载指示组件组合在 pi-tui 的主屏渲染器上，因此终端回滚区保留对话记录。

终端只读取其他表层已经使用的接缝。持久事实来自 `session/event`（`user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/end`）；实时文本来自 `agent/assistant-stream`；工具卡片使用每个工具的 `presentCall` 与 `presentResult` 视图；`/` 行在终端本地命令之后交给 `ctx.commands.execute`；应用只为其绑定的 Agent 充当 `approval/request` 与 `user-questions/request` waterfall 的进程内应答器。与浏览器的对等来自读取同一批服务而非新增服务：`/sessions` 经 `sessionQuery` 列出，`/title` 经 `sessionTitle` 重命名，`/attach` 经 `attachments` 存储，`@` 补全查询 `fileReferences` 与 `sessionReferenceResolver` 并插入其规范提及，`/skills` 读取 `skills`，`/signin` 以终端作为交互运行 `authorization.begin`，`/login` 只提供订阅方法（除收集密钥的 `api-key` 登录外的每一种方法），`/export` 经 `dsh-session-log-export` 写出与浏览器下载路由相同的归档，`/model` 从 `llm.resolveModelInfo` 提供推理强度并经 `agentDefaultModel` 保存，Shift+Tab 在绑定选择上循环这些强度，页眉与页脚折叠 `session/title` 与 `permission/preset`，页脚与 `/status` 读取 `sessionProjections`（上下文压力、token 用量、会话统计、todo、目标、计划、权限），`/outline` 读取 `turnOutline` 投影，`/deliverables` 折叠 `deliverables/presented`，`/subagents` 读取 `subagents.listDescendants`，`/settings` 读取并修改 `settings`，`/plugins` 通过 `dsh-host-plugin-inventory` 的 `pluginFiberPhase` 读取 Loader 条目。审批提示显示请求所指的已记录调用，`plan-review` 问题使用 `dsh-user-questions` 的 `planReviewOptions`，即浏览器卡片也使用的收窄逻辑。提交语义遵循浏览器：轮次进行中 Enter 排队到下一轮次，Ctrl+S 引导，Esc 以 `keepInbox` 取消。提示是进程本地的呈现，从不写入日志。`--resume` 在 Agent 恢复前通过 `sessionPersistence` 的只读句柄分页读取持久化日志，因此生产代码中没有新增同步历史读取。

## 验证

包级测试在伪 `Terminal` 上驱动应用，输入原始按键字节并读取渲染文字，在逐文件覆盖率门槛下覆盖渲染、按键、两个交互接缝、本地与共享命令、模型与推理强度选择器、Shift+Tab 推理强度循环、会话切换与 fork、附件、`@` 补全、登录、订阅 `/login`、导出，以及 runner 的创建、恢复、fork 切割、退出与失败路径。启动提供方在真实 Loader 配置树上得到验证。`apps/cli/tests/profiles/tui/tests/keyless-smoke.e2e.ts` 通过真实 `dsh` 启动器与免密钥模拟模型启动随附 profile，驱动生产环境的 shell 工具，用 Ctrl+D 退出，并在第二个进程中恢复持久化会话，其页眉带有生成的标题、页脚带有权限预设。

## 考虑过的替代方案

**恢复已删除的 TUI 包。** 拒绝：移除决定已让该实现及其打过补丁的 pi-tui 退役；当前表层更小，构建在当前接缝之上，并由随附 profile 持有。

**通过 SDK JSON-RPC 或 ACP 服务器提供终端。** 拒绝：二者都是面向远端客户端的自动化传输，其审批与提问流程指向远端，而终端需要 Web 客户端经 Typert Remote 获得的同进程呈现。

**在仓库内编写终端渲染器。** 依据"优先依赖而非手写"政策拒绝：pi-tui 已经拥有差分渲染、raw 模式输入、括号粘贴、Kitty 键盘协议，以及带历史与补全的编辑器。

**向插件暴露 pi-tui 树。** 延期：移除记录指出面向插件的浮层 API 需要具体消费者；在其出现之前，该树对组合包保持私有。

## 后果

`dsh tui` 与 `dsh web`、`headless`、`sdk`、`sdk-minimal` 和 `acp` 一起成为随附应用；启动器、架构、启动与组合包文档列出它，profile 测试枚举其组合包。`tui` 不再是文档中自定义 profile 名称的占位符。终端同一时间驱动一个会话，审批为一次性；浏览器保留其仅页面功能（workspace 与目录选择器、在应用中打开、轨迹账本、逐条消息反馈），终端以文本命令覆盖设置、插件、子 agent、交付物、轮次大纲与状态。计划评审收窄逻辑从浏览器客户端移入 `dsh-user-questions/plan-review`，fiber 阶段映射由 `dsh-host-plugin-inventory` 导出，因此两个表层共享同一定义。
