# Agent Note: 先按端点测量 TUI，再决定是否照搬 Web 优化

Status: proposed

[English](2026-09-20-tui-performance-vs-web.md) | 中文

## 问题

`dsh tui` 与 `dsh web` 即使用起来手感不同，两个 profile 也仍叠加 `dsh-base` 并共用同一个 agent loop（智能体循环）。单靠一个「TUI 更慢」的数字无法指出真正不同的工作。冷启动、长日志的 `--resume`、实时 token 上屏、轮次进行中的按键回显，以及两条表层已经共用的模型或工具时间，是五套不同的时钟。

Web 已经有会话打开、Client 对话折叠、活动重连和长会话浏览器工作流的必跑车道（[会话打开门禁](../../implemented/testing/2026-09-04-session-open-performance-gate.zh.md)、[前端预算](../../implemented/testing/2026-09-06-frontend-performance-budgets.zh.md)）。会话打开排除模型与 Gateway。浏览器工作流包含测试 Host、传输、Playwright 与绘制；它不是 `dsh web` 进程拉起。`benchmarks/` 没有 TUI 用户路径。`packages/bundle/tui-app/tests/bench.ts` 是功能向的伪 `Terminal` 驱动，不是计时门禁。

若不把时钟分开，照搬 Web 的分页、会话折叠或 `requestAnimationFrame` 批处理，会与已交付的终端规则冲突：transcript（文本记录）从不裁剪，回滚区拥有历史，而 `previousViewportTop` 之上的行变化会写出 `ESC[3J` 并清掉那段历史（[重绘窗口](../../implemented/feature/2026-09-17-tui-transcript-navigation-and-inspector.zh.md)）。已结算块的行复用已经交付；它拒绝的是裁剪，不是那条序列（[渲染复用](../../implemented/bug-fix/2026-09-19-tui-transcript-render-reuse.zh.md)）。

## 提案

把 TUI 性能当成五个端点。先在生产入口路径上分别测量，再改产品代码。只有不破坏上述终端规则、不去掉已交付的 TUI 能力、且有一张具名卡片证明它去掉的就是那笔成本时，才照搬 Web 机制。

### 已交付能力保持不变

性能改动可以删除重复工作。它不得删除、隐藏、分页拿掉，或用新开关挡住终端已经交付的任何能力：回滚区里未裁剪的 transcript；流式渐变与卡片浮出；检查器与焦点标记条；备用屏幕阅读器；第一道围栏上的语法着色；Agent 处于 `running` 时的加载器；可折叠的工具卡片与上下文块；subagent 面板；状态栏走位；`/` 命令；`!` / `!!`；`@` 补全；审批与提问；会话的创建、恢复、fork 与导出。`reducedMotion`、`NO_COLOR` 与 `codeHighlight: false` 仍是现有的关闭开关；它们不是这次优化。

### 该抱怨混在一起的端点

| 编号 | 用户操作 | 更快的 Web 标签页证明不了什么 |
|---|---|---|
| A | 冷启动：进程拉起直到编辑器回显一个按键 | Web 的界面可以在 Host 启动之后、任何会话存在之前出现 |
| B | 恢复：`--resume` 直到历史已上屏且编辑器接受输入 | Web 打开 50 条消息的一页，并可能先不激活 Agent |
| C | 实时流：token 到可见回复文本 | Web 画在浏览器线程上；TUI 画在同时跑循环的 Node 循环上 |
| D | 轮次中的输入：token 或旋转指示器运行时，按键到编辑器回显 | Web 输入与 Host 的工具和 LLM I/O 不在同一进程 |
| E | 共用循环工作：提示词组装、工具、模型 I/O | 会话一旦在跑，这就不是 TUI 相对 Web 的产品差距 |

tsx 源码启动（`pnpm dsh`）会同时加重两个 Host。要把构建后的 `dsh --profile tui` 与构建后的 Web Host 加构建后的 Client 相比。PTC 模式是 `dsh-base` 的一行，不是 TUI 插入项。空的新会话不会加载 Shiki；第一个索要语法的围栏代码块才会加载（[语法着色](../../implemented/feature/2026-09-19-tui-syntax-colour.zh.md)）。

### 源码已经表明的事实

- 两个 profile 都通过 `dsh-base` 挂载 `@deepseek-ai/dsh-agent-loop`。会话一旦在跑，host 平面行与 `agent-presets` 重新挂载并不改变每轮次工作的类别。
- TUI 的 `TuiApp.onStreamFrame` 对每个 `chunk` 与 `end` 帧调用 `this.tui.requestRender()`（`start` 直接返回，不请求）。在主屏上，pi-tui 的 `TuiBase.requestRender` 已经按 `MIN_RENDER_INTERVAL_MS = 16` 合并；同一窗口内后一次调用在 `renderRequested` 为真时直接返回。被挂起的阅读器会立即绘制（[备用屏幕阅读器](../../implemented/architecture/2026-09-20-tui-reader-on-the-alternate-screen.zh.md)）。
- 正在流式输出的 `AssistantBlock` 在挂着渐变时，每次 `render()` 都调用 `compose()`。pi-tui 的 `Markdown.render` 只在 `setText` 或宽度变化后重新词法分析。因此渐变滴答会重新着色，不会重新解析。
- `presentCall` 与 `presentResult` 只在 `tool/call` 与 `tool/result` 上运行。`tool-call-delta` 只更新加载器文案。
- `--resume` 在 `readHistory` 里按 `HISTORY_PAGE = 256` 分页读日志（读句柄上的一整遍全日志，随后该句柄关闭），随后 `agents.resume()` 打开写句柄并调用 `handle.read(0, undefined)`（第二遍全日志，可能追加被打断轮次的闭合事件）。`TuiApp.bind` 再经 `onSessionEvent` 回放 `readHistory` 快照，因此漏掉那些闭合事件。Web Client 的 `Session.doOpen` 请求 `PAGE_MESSAGES = 50`。
- Web 会话组装把实时分片发布为 `'animation-frame'`，并等待三次 `requestAnimationFrame` 回调。这是比 TUI 的 16 ms 调度更松的上限，不是 TUI 缺少的能力。
- 已结算的块已经交回 `LastDrawn` 行。复用注记的伪终端 bench 给出空闲帧：20 轮次 1.2 ms，80 轮次 4.4 ms，320 轮次 18 ms。空闲时剩下的成本是 pi-tui 对不断变长的帧做遍历与逐行比较。
- Agent 处于 `running` 时，80 ms 的加载器会调用 `requestRender`。思考间隙里这大约是每秒 12.5 帧的整帧比对，不是重建 transcript。

同进程争用是拓扑事实（`tui-app` runner 与 `AgentLoop` 共用一个 Node 循环）。复用注记里已结算的伪终端空闲帧在 80 轮次只有几毫秒；它们并不测量实时 `doRender` 下的工具或按键延迟。仍在流式输出、并对大回复重新词法分析的长 `doRender`，仍可能在该循环上推迟下一件工具或下一次按键。

### 测量卡片

先做这些卡片，再改产品。使用普通 Node 下的已编译 JavaScript、私有 `mkdtemp` Harness 主目录，以及由已审常量生成的合成 JSONL。排除模型与网络延迟。包内 `.perf.ts` 可以持有伪 `Terminal` 上流式卡片；必跑的 `benchmarks/` 车道要等校准，见 [benchmarks/AGENTS.md](../../../../benchmarks/AGENTS.md) 与[基于证据的性能技能](../../implemented/process/2026-09-06-evidence-driven-performance-skill.zh.md)。

| 卡片 | 完成条件 | 工作负载 | 入口路径 | 时钟 | 内存 |
|---|---|---|---|---|---|
| A 冷启动首键 | 可打印按键出现在编辑器中 | 新的空会话 | 构建后的 `dsh --profile tui` 子进程 | 进程启动 → 回显的按键 | 首帧后的 RSS |
| B 恢复就绪 | 编辑器接受输入，且历史上屏行数与日志一致 | 复用 bench 形态的 80 轮次与 320 轮次夹具（1500 行系统提示词、每轮次一张折叠的 `read` 卡片和一段带围栏的回复） | 同一子进程；在 `loader.await` 之后分别计时 `readHistory`、`agents.resume`、`bind` 与首帧 | 持久化 I/O 与界面回放分开 | 保留的会话加上已挂载的块 |
| C 流式帧 | 一阵分片之后的一次 `doRender` | 2 万字符的实时回复、已关闭的围栏、在一个 16 ms 窗口内的 50 个分片，然后再跑按 16 ms 步进的流 | 主屏上的生产 `TuiApp` 加伪 `Terminal` | 词法分析、`compose`、渐变着色、`Container` 拼接、逐行比对各自占比 | 这一阵期间的瞬时峰值 |
| D 思考间隙帧 | 已结算的 80 轮次 transcript 上，只由加载器驱动的一秒 | Agent 为 `running`、无分片、渐变已解除 | 同上 | `doRender` 次数与耗时 | 保留的块不变 |
| C+D 输入重叠 | C 或 D 运行时，按键字节到编辑器行变化 | 同一棵 80 轮次树，加上实时分片或加载器 | 同上 | 事件循环延迟与按键到回显 | — |

卡片 C 必须在主屏上的一个 16 ms 窗口内统计 `Markdown` 词法分析次数、`requestRender` 次数与 `doRender` 次数。生产上的预期是：一阵只改实时回复文本的分片，只解析一次、只 `doRender` 一次；那一次 `doRender` 仍可能把树走最多三遍（第一次 `super.render` 之后还有 `SETTLE_PASSES = 2`）。阅读器的立即绘制不进这张卡片。

在得到三次参考样本和一次托管复跑之前，不要写入必跑 CI 时间预算。无阈值的诊断就足以给下面的改动排序。

### 按优先级排列的改动

| 次序 | 改动 | 裁决 | 最小证伪 | 必须保持的行为 |
|---|---|---|---|---|
| 1 | 实时回复的增量 Markdown：缓存已关闭的 token，只组合仍打开的尾部 | 卡片 C 之后保留 | 2 万字符回复上，词法分析加折行低于约五分之一的 `doRender` | 折行、列表、表格、未关闭围栏、`recolorTail` 从末尾匹配、第一道围栏的语法加载 |
| 2 | 从 Agent 已加载的会话恢复，而不是再跑一遍 `readHistory` | 为卡片 B 保留 | 分页读句柄那一遍加上写句柄的 `read(0, undefined)` 变成一遍全日志；80 轮次与 320 轮次恢复墙钟下降 | `bind` 画出每条持久化事件，包括恢复时的闭合事件；写句柄修复仍运行 |
| 3 | 只在思考间隙放慢加载器滴答 | 降级，直到卡片 D | 一秒思考间隙里的 `doRender` 次数 | Agent 处于 `running` 时加载器仍绘制；停掉它不在范围内 |
| 4 | 历史画完之前就亮出编辑器 | 拒绝 | `--resume` 与 `/resume` 仍在编辑器接受提交前画出持久化日志 | 输入前历史上屏是已交付的恢复约定 |
| 5 | 像 Web 那样把 TUI 工具改挂到 `agent-presets` 后面 | 仅作为启动项降级 | 卡片 A 的插件结算时间 | 终端 profile 所记载的进程级组合 |
| 6 | 应用层 16 ms 流合并 | 拒绝 | `TuiBase.requestRender` 已经合并主屏；一个窗口内的 50 个分片必须仍只调度一次 `doRender` | 主屏上的流与渐变节奏；被挂起的阅读器保持立即绘制 |
| 7 | Web 的 `PAGE_MESSAGES` 窗口或「加载更早」 | 拒绝 | `Home`、`/turns` 与 `Ctrl+G` 仍必须点名每一轮次 | 回滚区拥有历史；在视口之上前置会写出 `ESC[3J` |
| 8 | 只在实时块变化时跳过兄弟 `render()` | 拒绝 | 320 轮次时 `AssistantBlock.render`、`Container` 拼接与逐行比对各自耗时 | pi-tui 每帧调用每个子组件；`LastDrawn` 才是合法跳过 |
| 9 | 引入 Client 的 `ConversationNodeAssembler` | 拒绝 | 没有 `session/event` 分支表达不了的 TUI 缺陷 | 对等来自共享服务，而不是 Client 节点图 |
| 10 | 丢掉屏外块 | 拒绝 | `transcript-focus` 的回滚区清除不变量 | 高度留在树里；屏外行就是回滚区 |
| 11 | token 到达时关闭渐变 | 拒绝 | 卡片 C 加上 `reducedMotion` 已经是关闭开关 | 墙钟年龄；没有按到达速率切断（[连续渐变](../../implemented/feature/2026-09-17-tui-continuous-fade.zh.md)） |
| 12 | 在流处理与绘制之间插入 `setImmediate` | 降级 | 事件循环延迟 ≈ `doRender` 耗时 | 一帧就是一组一致的行 |
| 13 | 在 worker 线程上绘制 | 拒绝 | 没有小测量能让这合法 | 进程 TTY、原始 stdin、进程内审批与提问 waterfall（瀑布式事件） |
| 14 | 缓存页脚的 `sessionProjections.snapshot` | 作为首选工作拒绝 | 快照时间对比一次加载器 `doRender` | 页脚数字在 1 秒实时滴答以及轮次、用量、权限与投影更新上保持当前 |

### 实现分层

后续工作分成可独立合并的 PR：

1. 把卡片 A–D 做成包内诊断或一条 `benchmarks/` 路径，由本注记持有测量卡片。不改产品行为。
2. 仅当卡片 C 显示词法分析占比时做次序 1。`tests/blocks.spec.ts` 中的所属测试保持围栏备忘与折行约定。
3. 仅当卡片 B 显示第二次整日志读取时做次序 2。`bind` 读取已恢复会话的事件；`readHistory` 删除或变成仅测试助手。
4. 仅当卡片 D 显示加载器帧主导思考间隙 CPU 时做次序 3，且只作为仍绘制旋转指示器的更慢滴答。

以后的必跑 TUI 车道复用同一组卡片，并按 Web 浏览器工作流那样加预算：先参考机器样本，再托管复跑，最后写入源码常量。

## 考虑过的替代方案

**把一次 TUI 对 Web 的墙钟当成验收测试。** 拒绝：Web 的「打开」是已经搭好的 Host 里打开会话；TUI 首绘包含 profile 启动和急切的 Agent。混在一起会因为错误的端点而通过或失败。

**先照搬 Web 的分页、非活动视图推迟和 Client 组装器。** 拒绝：那些机制假定 DOM 窗口和 Client 节点图。复用注记已经拒绝裁剪旧块。终端表层读取浏览器已读取的同一批服务，并不导入 Client 会话类型（[终端表层](../../implemented/architecture/2026-09-15-terminal-surface-tui-app.zh.md)）。

**先加一层应用 16 ms 合并，再测量。** 拒绝：该间隔已经由 pi-tui 持有。额外定时器切不掉 Markdown 重新解析，只会让流和渐变变成台阶。

**把同循环争用当成第一个产品修复。** 拒绝，直到卡片 C 与 D 显示 `doRender` 在推迟工具或按键。复用注记里已结算的空闲帧在 80 轮次的伪终端上只有几毫秒；worker 渲染器会拆开表层所要求的 TTY 与进程内 waterfall。

**没有卡片 C 就交付增量 Markdown。** 拒绝：Markdown 不是局部的。前缀折行变化必须使缓存失效，且 `recolorTail` 从末尾匹配。若卡片 C 把剩下的成本归到 pi-tui 的行遍历，本包若不分叉渲染器就无法跳过那次遍历。

**靠丢掉渐变、检查器、阅读器或旧 transcript 行来加速。** 拒绝：那些是已交付的能力。本注记加快现有终端，不缩小它。

## 验收标准

- 本注记是 TUI 对 Web 性能工作的所有者：五个端点、测量卡片，以及保留 / 降级 / 拒绝表。
- 声称 TUI 加速的改动必须点名一个端点，在该卡片上跑改前与改后，并保持行为列。
- 卡片 A–D 作为构建产物上的可执行诊断存在，即使还不是必跑 CI 预算。
- 在本注记处于提案或已实现期间，任何 PR 都不得照搬 Web 分页、Client 折叠、跳过兄弟 `render()`、屏外虚拟化、流式渐变切断或渲染 worker。
- 次序 2 不得移动、覆盖或删除已提交的持久化世代；它只停止终端为 Agent 即将加载的同一份日志再跑第二遍全日志。
- 去掉、隐藏、分页拿掉或用新开关挡住已交付 TUI 能力的加速不在范围内。
- 包 `tui-app` 测试与免密钥 TUI profile 冒烟测试仍是功能钉；更快但让它们失败的卡片不得落地。

## 风险

在历史画完之前就亮出的编辑器，可能对着仍在绑定的会话接受提示词。次序 4 已拒绝，因此 `--resume` 与 `/resume` 仍在提交前画出持久化日志。会话切换期间可打印按键已经回显。

错过前缀重样式的增量 Markdown，会在闭合标记到达时出现布局跳动。所属测试必须覆盖未关闭围栏、因后续标记收紧的列表，以及宽度变化。

让 `bind` 从已恢复的会话取事件，不得跳过 `agents.resume()` 里的写句柄修复。Agent 仍先取得写句柄，并在发布前追加被打断轮次的闭合事件。

从一次笔记本样本采纳的必跑 TUI CI 预算会在托管 runner 上抖动。跟随 Web 前端注记：先做无阈值诊断，再做参考与托管校准。

伪 `Terminal` 卡片排除模拟器延迟与同步输出成本。每份报告都写明该排除；它们不证明 Kitty 或 iTerm 的绘制时间。

## 相关决定

终端应用及其未打补丁的 pi-tui 依赖是[随附的 `tui` profile](../../implemented/architecture/2026-09-15-terminal-surface-tui-app.zh.md)；次序 2 会改正该注记里「`--resume` 在 Agent 恢复前分页打开读句柄」那一句，而不会把它归档。已结算块的行复用、围栏备忘，以及剩下的整帧遍历是[transcript 渲染复用](../../implemented/bug-fix/2026-09-19-tui-transcript-render-reuse.zh.md)。渐变年龄、33 ms 滴答，以及被拒绝的按到达速率切断是[连续渐变](../../implemented/feature/2026-09-17-tui-continuous-fade.zh.md)。高水位重绘窗口与回滚区清除规则是[transcript 导航与检查器](../../implemented/feature/2026-09-17-tui-transcript-navigation-and-inspector.zh.md)。`Ctrl+G` 与 `/turns` 会让对话离开终端并绕过 16 ms 调度器（[备用屏幕阅读器](../../implemented/architecture/2026-09-20-tui-reader-on-the-alternate-screen.zh.md)）。延迟加载语法是[语法着色](../../implemented/feature/2026-09-19-tui-syntax-colour.zh.md)。测量程序是[基于证据的性能技能](../../implemented/process/2026-09-06-evidence-driven-performance-skill.zh.md)。本注记不得盲目对比的 Web 数字是[前端预算](../../implemented/testing/2026-09-06-frontend-performance-budgets.zh.md)与[会话打开门禁](../../implemented/testing/2026-09-04-session-open-performance-gate.zh.md)。
