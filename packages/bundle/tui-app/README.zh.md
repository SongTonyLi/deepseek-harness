---
description: "dsh 的交互式终端模式：在你的终端里与 agent（智能体）对话，带流式回复、工具卡片、审批、提问与斜杠命令。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-tui-app

[English](README.md) | 中文

## 概述

`dsh-tui-app` 是 dsh 的终端表层：`dsh tui` 在你当前所在的终端里启动一个多轮会话，没有浏览器、没有服务器。回复实时流式显示，每次工具调用都变成可折叠的卡片，权限提示与 `ask_user_question` 的问题出现在输入框上方，`/` 命令与 Web 表层共用同一注册表。会话像其他表层一样持久化，因此可以用 `--resume` 稍后继续。它运行与 `dsh web` 相同的模型、工具与安全默认值；边界是每个终端一个会话。

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
```

退出时应用在 stderr 打印 `dsh: session <id> saved; resume with: dsh --profile tui --resume <id>`。恢复的会话会在接受输入前先重绘其持久化历史。

### 屏幕布局

对话记录在终端自身的回滚区中增长：你的提示以 `›` 开头，assistant 的推理以暗色显示在 Markdown 回复上方，每次工具调用是一张卡片，含状态符号、工具名、呈现器标题，以及折叠到 `toolPreviewLines` 行的正文。对话记录下方依次是 agent 工作时的旋转指示、任何打开的提示、编辑器，以及两行页脚：模型、累计 token 用量、workspace 与按键提示。

### 按键与命令

| 按键 | 效果 |
|---|---|
| `Enter` | 发送编辑器文本；轮次进行中时它被引导（steer）进下一步 |
| `Shift+Enter` | 插入换行 |
| `Up` / `Down` | 调出先前的提示 |
| `Esc` | 停止正在进行的轮次 |
| `Ctrl+O` | 展开或折叠所有工具卡片 |
| `Ctrl+C` | 清空编辑器；600 ms 内再按一次则退出 |
| `Ctrl+D` | 编辑器为空时退出 |

`/help` 列出命令与按键，`/model` 打开已组合提供方的选择器（或用 `/model <provider>/<model>` 直接选择）以用于下一次请求，`/tools` 像 `Ctrl+O` 一样切换卡片，`/quit` 保存并退出。其他每条 `/name` 行都交给共享命令注册表，因此 `/compact`、`/permission`、`/goal` 与插件命令的行为和浏览器中一致。

### 来自 agent 的提示

审批请求绘制 `Allow <tool>?`、请求方的理由以及两行选项：允许一次或拒绝；`Esc` 拒绝，`Ctrl+C` 取消该请求。`ask_user_question` 的问题绘制其选项加一行自由文本；多选用 `Space` 切换各行并通过 `Done` 确认。提示排队、一次只显示一个，被中止的请求会撤回其提示。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `prompt` | 无 | 终端就绪后提交的首个提示 |
| `resume` | 无 | 要继续的持久化会话 id，而不是新建会话 |
| `toolPreviewLines` | `8` | `Ctrl+O` 展开前折叠的工具卡片正文行数 |

`prompt` 与 `resume` 经启动提供方来自命令行；生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tui-app)是所有可接受字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

runner 与 `dsh-headless` 一样是核心 API 载体之上的直接驱动器，但会一直运行到用户退出，并通过 pi 编码 agent 的差分终端渲染器 [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi) 绘制。

### 运行流程

runner 等待完整应用就绪（`ctx.get('loader')?.await()`），读取共享的 [`agentDefaultModel`](../../core/agent-default-model/README.zh.md) 选择，然后要么用该提供方与模型创建一个全新的持久化 Agent，要么在 `--resume` 时通过 `ctx.sessionPersistence` 的只读句柄分页读取持久化日志并经注册表恢复 Agent。两条路径都在 Agent 的作用域 setup 中安装 `ModelSelectionRef`，因此 `/model` 会改变下一次请求。随后终端应用为该 Agent 订阅 `session/event`、`agent/assistant-stream` 与 `agent/status`，注册 `approval/request` 与 `user-questions/request` 应答器，并接管终端。退出时取消任何进行中的轮次、等待完全停稳、flush 会话、dispose Agent 句柄并请求以 0 退出；驱动器失败会向 stderr 写入 `dsh: <message>` 并请求以 1 退出。

### 渲染模型

持久事实来自会话日志：`user/message`（自己提交的消息只绘制一次，其回显按消息 id 跳过；插件通知是一行暗色文字，其他注入的上下文不绘制）、`assistant/message`（用已提交文本替换流式块，并把用量折入页脚）、`tool/call` 与 `tool/result`（工具声明 `presentCall` 与 `presentResult` 视图时据此绘制，否则回退到原始参数与原始结果）以及 `turn/end` 通知。实时增量来自 `agent/assistant-stream` 的文本与推理增量。模态提示是进程本地的呈现，从不写入日志。

### 基于 base 的 patch 面

该 patch 叠加在 `dsh-base` 之上：在 base 的 `system-prompt` 行上设置编码 persona 前缀与 cwd 后缀，保留与 Web 表层相同的临时进程级 PTC 模式开关（`DSH_TOOLS_MODE`），插入 PTC 模式的 worker，挂载由终端应答其问题的模型侧 `ask_user_question` 工具，并挂载启动提供方与 runner。base 的 agent 平面行（bash、文件系统、技能、目标、压缩、子 agent）保持启用，因为终端是单会话的，并在进程范围内组合其 Agent。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `tui-app` 插件：Agent 创建或恢复、历史读取、退出流程、退出码映射 |
| [`src/startup.ts`](src/startup.ts) | `tui-app-startup` 提供方：提示位置参数、`--resume` 与 `--help` |
| [`src/app.ts`](src/app.ts) | 终端应用：布局、按键、命令、接缝、日志与流的折叠 |
| [`src/blocks.ts`](src/blocks.ts) | 对话记录组件：用户提示、assistant 回复、工具卡片、通知 |
| [`src/prompts.ts`](src/prompts.ts) | 审批、提问与选择器提示以及模态队列 |
| [`src/transcript.ts`](src/transcript.ts) | 呈现视图、用量与轮次结束原因的纯文本折叠 |
| [`src/diff.ts`](src/diff.ts) | diff 卡片的行 diff 与 hunk 选择 |
| [`src/style.ts`](src/style.ts) | 调色板与派生的 pi-tui 主题 |
| [`src/completion.ts`](src/completion.ts) | 编辑器的斜杠命令补全 |
| [`cordis.patch.yml`](cordis.patch.yml) | 基于 `dsh-base` 的终端 patch |
| — | 不发布运行时不变量伴随模块；应用只在一个 Agent 上注册监听器，不持有其他观察者可能与之矛盾的可变关系。 |
| [`tests/app.spec.ts`](tests/app.spec.ts) | 基于伪终端的渲染、按键、命令与两个接缝 |
| [`tests/index.spec.ts`](tests/index.spec.ts) | 创建、恢复分页、退出流程与失败报告 |
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

- **每个进程一个会话**——没有会话列表或切换器；另开一个 `dsh tui`，或用 `--resume` 打开先前的会话。
- **审批为一次性**——提示只提供允许一次或拒绝，与审批接缝的词汇一致；没有记忆的授权。
- **附件仅限文本**——编辑器只发送文本；图片与文件回执只能从浏览器到达命令。
- **历史由终端回滚区持有**——除工具卡片外，对话记录不可搜索或折叠；更丰富的导航由浏览器表层持有。
- **通过 `dsh` 启动器运行**——以其他方式启动该 profile 会在启动时失败，因为只有启动器能请求进程退出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

`tests/bench.ts` 持有伪 `Terminal`；用它的 `type()` 输入按键，用 `text()` 读取渲染文字，后者会剥离 CSI、OSC 与 APC 序列。pi-tui 把渲染节流到每 16 ms 一帧，因此测试在读取屏幕前通过 `settle()` 等待。

</details>
