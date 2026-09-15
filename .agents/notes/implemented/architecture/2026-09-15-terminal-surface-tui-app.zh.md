# Agent Note: 以随附 `tui` profile 提供终端表层

Status: implemented

[English](2026-09-15-terminal-surface-tui-app.md) | 中文

## 问题

DeepSeek Harness 只随发行版交付了一个交互式表层，即 `dsh web` 背后的浏览器应用；终端只有一次性的 `headless` runner，它回答单个任务后退出。[TUI 包移除决定](../../archived/simplification/2026-08-04-remove-tui-package.md)删除了早期的终端前端，因为没有任何组合使用它，并为其回归设定了门槛：具名的产品部署、明确的包边界、具体的交互提供方，以及组装后的生命周期验收。想要类似 pi 编码 agent（智能体）终端工作流的用户没有受支持的答案。

## 决定

`packages/bundle/tui-app` 下的 `@deepseek-ai/dsh-tui-app` 是终端表层，`tui` 是随附 profile（`dsh-base` 加 `dsh-tui-app`，只在启动时应用 patch），并以 `dsh tui` 作为与 `dsh web` 并列的启动器别名。该组合包镜像 `dsh-headless`：`tui-app-startup` 命令行提供方发布 `tuiStartup`（可选的首个提示与 `--resume <session-id>`），`tui-app` runner 通过核心注册表创建或恢复一个 Agent 并驱动它直到用户退出。该 profile 保持 base 的 agent 平面行启用，只额外加入 PTC 模式的 worker 与 `ask_user_question` 工具。

渲染器是 [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi)，即 pi 编码 agent 维护的差分终端库，作为与仓库现有 `@earendil-works/pi-ai` 适配器并列的普通依赖引入，而不是 vendored 或打过补丁的副本。应用把自己的编辑器、Markdown、选择列表与加载指示组件组合在 pi-tui 的主屏渲染器上，因此终端回滚区保留对话记录。

终端只读取其他表层已经使用的接缝。持久事实来自 `session/event`（`user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/end`）；实时文本来自 `agent/assistant-stream`；工具卡片使用每个工具的 `presentCall` 与 `presentResult` 视图；`/` 行在四个终端本地命令（`/help`、`/model`、`/tools`、`/quit`）之后交给 `ctx.commands.execute`；应用只为自己的 Agent 充当 `approval/request` 与 `user-questions/request` waterfall 的进程内应答器。提示是进程本地的呈现，从不写入日志。`--resume` 在 Agent 恢复前通过 `sessionPersistence` 的只读句柄分页读取持久化日志，因此生产代码中没有新增同步历史读取。

## 验证

包级测试在伪 `Terminal` 上驱动应用，输入原始按键字节并读取渲染文字，在逐文件覆盖率门槛下覆盖渲染、按键、两个交互接缝、本地与共享命令、模型选择器，以及 runner 的创建、恢复、退出与失败路径。启动提供方在真实 Loader 配置树上得到验证。`apps/cli/tests/profiles/tui/tests/keyless-smoke.e2e.ts` 通过真实 `dsh` 启动器与免密钥模拟模型启动随附 profile，驱动生产环境的 shell 工具，用 Ctrl+D 退出，并在第二个进程中恢复持久化会话。

## 考虑过的替代方案

**恢复已删除的 TUI 包。** 拒绝：移除决定已让该实现及其打过补丁的 pi-tui 退役；当前表层更小，构建在当前接缝之上，并由随附 profile 持有。

**通过 SDK JSON-RPC 或 ACP 服务器提供终端。** 拒绝：二者都是面向远端客户端的自动化传输，其审批与提问流程指向远端，而终端需要 Web 客户端经 Typert Remote 获得的同进程呈现。

**在仓库内编写终端渲染器。** 依据"优先依赖而非手写"政策拒绝：pi-tui 已经拥有差分渲染、raw 模式输入、括号粘贴、Kitty 键盘协议，以及带历史与补全的编辑器。

**向插件暴露 pi-tui 树。** 延期：移除记录指出面向插件的浮层 API 需要具体消费者；在其出现之前，该树对组合包保持私有。

## 后果

`dsh tui` 与 `dsh web`、`headless`、`sdk`、`sdk-minimal` 和 `acp` 一起成为随附应用；启动器、架构、启动与组合包文档列出它，profile 测试枚举其组合包。`tui` 不再是文档中自定义 profile 名称的占位符。终端每个进程一个会话，审批为一次性；更丰富的会话导航与记忆授权仍是浏览器表层的功能，直到有终端消费者证明其必要。
