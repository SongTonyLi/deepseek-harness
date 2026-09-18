# Agent Note: Live terminal subagent panel and elapsed counters

Status: implemented

[English](2026-09-17-tui-live-subagent-panel.md) | 中文

## Problem

被委派的工作正在进行时，终端对此只字不提。`/subagents` 回答的是完整的持久后代树，因此派出三个子会话的用户必须先输入命令，再读一份同时包含数小时前就已结束的每个子会话的列表；屏幕上没有任何内容说明此刻有多少子会话在工作，甚至没有说明是否有。两侧都缺少时间：旋转指示报告绑定的 Agent 正忙，却从不说明已经忙了多久，子会话自己的轮次则完全没有读数。这些事实早已存在——subagent 运行时可以列出后代，`subagentTiming` 与 `tokenUsage` 投影承载每个会话的轮次计时与总计，`ctx.agents.get` 可解析出子会话的实时 Agent——因此缺少的是绘制它们的位置，以及让它们走动的时钟。

## Decision

一个子 agent 面板停靠在编辑器与状态栏之间，状态栏新增了一个 `turn` 分段，由同一个重复重绘推动两者。

面板恰在有行可绘时挂载，因此在被委派的工作开始时出现，并随其最后一行离开；若面板当时持有键盘，键盘会回到编辑器。未聚焦时是一行摘要（`subagents · N listed` 加上第一个子会话的关键标签，以及粘滞的列表失败）；聚焦时绘制带导航键的标题、所列出的每一行、溢出行以及失败行。每一行承载该子会话的层级缩进（每级两个空格，与 `/subagents` 各行的缩进一致）、其持久标签或会话 id、其模式（`one-shot` 或 `continuable`）、`resident`、其 Agent 在本进程中处于 `running` 还是 `idle`、其已用时间，以及其 token 用量；未组合 `subagentTiming` 或 `tokenUsage` 投影时，后两项不出现。最多绘制 `SUBAGENT_PANEL_MAX_ROWS`（6）行，其余折叠为 `+<n> more · /subagents lists them all`，因为面板压在对话之上，过长的列表会把对话挤出屏幕。列表无法解读的候选者绘制为 `<id> · unreadable: <reason>` 且不可进入；读取失败的列表保留上一次成功读取产生的各行，并在其下加上 `listing failed: <reason>`（聚焦时独立成行，未聚焦时并入摘要行），而对话记录只在原因发生变化时才收到通知，因此持续失败的服务无法用通知灌满对话。在某一行上按 `Enter` 打开的是 `/subagents` 打开的同一个只读会话页面，离开后键盘回到面板的该行。

`src/subagent-panel.ts` 是纯粹的：一个函数把列表与采样到的实时事实变成各行，另一个把这些行渲染成面板文本，当前时间是输入。因此面板的各行、其溢出行以及未聚焦摘要与聚焦列表无需终端或定时器即可被固定。

`turn` 分段位于 `permission` 与 `usage` 之间，只在轮次进行时绘制，形如 `turn <elapsed>`；其详情给出轮次编号、开始时间、已用时间与两项排队消息数量。开始时间取自持久的 `turn/start` 信封，因此读数是被记录轮次的年龄，而不是某个屏幕状态的年龄。面板行的已用时间以同样方式读取，取自子会话自己的投影：有进行中轮次时是该轮次的用时（用 `subagentTiming.active.since` 对照应用时钟），否则是其已结束轮次的合计（`subagentTiming.settledMs`）。

## Membership is residency, not the durable tree

`child` 条目只在其 `activity` 为 `running` 期间加入面板，而该值由 subagent 列表依据会话存储设置：子会话的逻辑会话记录常驻于本进程。常驻正是让面板成为实时视图的原因——不再常驻的子会话离开面板，最后一个离开时面板随之消失——而 `/subagents` 仍然对每一个持久后代作答，无论是否常驻。`diagnostic` 条目无论如何都会绘制，因为列表无法解读的候选者是活着的问题，而不是已经结束的子会话；这也是面板在没有常驻子会话时仍会绘制的唯一情形。

常驻没有说明的部分在它落地之处写明：`activity: 'running'` 表示记录常驻，而不是子会话正在工作，因此行内还带有该子会话 Agent 自己的 `running` / `idle` 状态；而由进程外提供方运行的 subagent 在此没有自己的会话记录，因此根本不会出现在面板里。

## Membership is reconciled from live signals, not polled

各条目来自每次对账一次的 `subagents.listDescendants(session.id)` 调用。对账在会话绑定时运行一次——为面板播种本身就是一次列表读取，而不是某个事件处理器的读取——此后只在实时信号把列表标记为过期时运行：来自绑定 Agent 之外任何 Agent 的 `agent/status`、`subagent/start` 与 `subagent/end`（两个边沿都不携带发起委派的父会话，且对进程外子会话同样触发，因此它们只做标记，而不增删某一行）、来自其他会话的 `session/event`，以及其他会话的投影变化。标记不等于读取：共享的 tick 每个周期最多执行一次列表读取，从而把子会话事件的突发收敛为一次读取。两次列表读取从不重叠，而属于终端已经离开的会话的结果会被丢弃并重新标记过期，因此下一个 tick 读取的是真正绑定的会话。

## One tick, armed only while something moves

`updateTicker` 在有轮次进行、有已绘制的行正在为进行中的轮次计时、或列表已过期期间装上实时刷新定时器，一旦三者都不成立便立刻卸下，因此空闲会话不运行任何定时器。一个周期内会对账过期的列表、重绘面板，并在轮次进行时刷新页脚——计数与过期对账共用一个 tick，因为它们需要相同的周期与相同的重绘。其周期是经校验的 `liveRefreshMs` 配置字段（`z.natural().min(100).default(1000)`），因此想要更安静的终端或更细的计数的部署从 `cordis.yml` 修改它，而不是改一个常量。

## Deviation: the tick is `ctx.effect` + `setInterval` + `unref`, not `ctx.interval`

插件把 `TuiAppDeps.tick` 提供为 `ctx.effect(() => { const timer = setInterval(callback, delayMs); timer.unref(); return () => { clearInterval(timer) } })`，也就是 `ctx.interval` 所做的事情再加上 `unref`。`@deepseek-ai/cordis-plugin-timer` 不是本包的依赖——它由本组合包所叠加的 `dsh-base` patch 挂载——因此调用 `ctx.interval` 意味着为了一个重绘定时器而声明依赖一个终端自身并不组合的插件，而仓库中“优先选用已维护的依赖”的偏好针对的是依赖能够删掉的代码，这里只有一次 `setInterval` 调用。`unref` 是第二个理由，也是真正改变行为的那个：`ctx.interval` 让定时器保持被引用，而重绘定时器绝不能在退出流程 flush 会话期间把进程一直挂住。资源释放没有变化，因为该 effect 属于插件 fiber，配置树拆除时会清除定时器。

## Alternatives considered

**每个 tick 都轮询 `listDescendants`。** 拒绝：该列表把实时会话存储与持久化语料合并，并读取冷候选者，因此每周期运行一次对没有子会话的会话而言不会告诉它任何新东西，代价却是每周期一次语料扫描。改用过期标记后，读取次数与子会话活动成正比。

**在注意到变化的处理器里直接读取列表。** 拒绝：一个子会话的启动、运行与结束会产生一连串状态、会话与投影信号；按信号读取会让列表读取相互重叠，并在一帧内多次重绘面板。tick 是唯一的读取者，处理器写的只是过期标志。

**像 `/subagents` 那样在面板中列出每一个持久后代。** 拒绝：面板停靠在对话之上，因此委派过五十次的会话会用早已结束的子会话把对话记录挤走。常驻回答的是“现在在跑什么”；溢出行则指出回答“曾经跑过什么”的命令。

**只用 `subagent/start` 与 `subagent/end` 跟踪成员关系、不做列表读取。** 拒绝：两个边沿都不携带发起委派的父会话，因此监听者无法区分绑定会话之下的运行与旁系会话之下的运行，而可续接子会话的常驻周期也并不与单一的 start/end 对应。列表持有成员关系，边沿只说明它过期了。

**在终端中依据它看到的事件累加已用时间。** 拒绝：`subagentTiming` 投影已经从子会话自己的日志折叠出其进行中与已结束的轮次时间，第二个累加器在恢复、会话切换或漏掉事件之后就会与它不一致。终端只是把投影值对照自己的时钟格式化，不持有任何计时状态。

**每个计数各用一个定时器。** 拒绝：面板各行与页脚的 turn 分段按同一周期推进、并在同一帧绘制，因此第二个定时器只会为显示同一秒的走动而让重绘翻倍。唯一的例外是淡入 tick，它有自己的周期，因为它以每秒 25 帧重绘，且由不同条件装上。

**让定时器在应用的整个生命周期内一直运行。** 拒绝：空闲的终端会永远每周期重绘一次，在笔记本上这就是为一块没有变化的屏幕每周期唤醒一次。只依据三个可能让某个值走动的条件装上定时器，空闲会话便完全不运行定时器。

## Consequences

- 终端有了停靠在编辑器下方的第二个区域。编辑器中的 `Shift+Down` 在面板绘制期间落在面板的第一行，否则落在状态栏；`Up` 与 `Down` 走查面板的各行，并在两端离开面板前往上方或下方的区域；`Esc` 始终返回编辑器。状态栏自身的按键归[可导航的终端状态栏](2026-09-16-tui-status-bar-navigation.zh.md)所有，方向键所走查的那个堆叠归[终端对话记录导航与聚焦小节检视区](2026-09-17-tui-transcript-navigation-and-inspector.zh.md)所有。
- 没有 subagent 运行时、或没有常驻子会话的 profile 不绘制面板，也不为它装上定时器；没有计时与用量投影的 profile 绘制不含这些列的行，而不是留出空白。
- 面板是带有明确盲区的实时视图：进程外子会话与已结束的子会话都不在其中，`/subagents` 是这两者的答案。
- 六行是本表层的呈现常量，而不是配置字段，且溢出行之后的各行不可选中。
- `tests/subagent-panel.spec.ts` 固定各行、已用时间的取舍、诊断行与溢出；`tests/subagents.spec.ts` 在伪终端上固定成员关系、到达与离开面板的按键、`Enter`、每个 tick 至多一次列表读取的约束、失败行、定时器的装上与卸下，以及各种不出现的情形。

## Related decisions

终端应用、其页脚事实以及它读取的 `/subagents` 列表归属于[终端界面作为随附 `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.zh.md)。面板的 `Enter` 打开的是[终端先列表后详情的导航](2026-09-16-tui-list-then-details-navigation.zh.md)所定义的页面；键盘经由[终端对话记录导航与聚焦小节检视区](2026-09-17-tui-transcript-navigation-and-inspector.zh.md)所定义的堆叠到达它，而与之并列的区域归[可导航的终端状态栏](2026-09-16-tui-status-bar-navigation.zh.md)所有。编辑器持有键盘时显示的光标，以及与本 tick 共处一个终端的第二个 tick，来自[终端竖条光标与流式文本淡入](2026-09-17-tui-bar-caret-and-stream-fade.zh.md)。
