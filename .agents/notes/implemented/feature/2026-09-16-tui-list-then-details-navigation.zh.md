# Agent Note: Terminal list-then-details navigation

Status: implemented

[English](2026-09-16-tui-list-then-details-navigation.md) | 中文

## Problem

`/subagents` 把每个后代会话打印成对话记录中的一行，agent（智能体）的 todo 列表则是 `/status` 报告中打印出来的一个小节。两种回答都是一整块文本，用户只能连同整个终端一起滚动：子 agent 自身的事实——workspace、标题、轮次提纲、已交付文件——不切换到子会话就无法读到，要看第二个子会话就得重新输入 `/subagents`，而 todo 小节一次性打印所有条目，却没有任何关于某个条目在列表中的位置、以及它写于哪一轮次、又在哪一轮次变动的内容。终端已经有一个带查询的列表组件 `PickPrompt`，位于 `/model`、`/sessions`、`/signin` 与 `/login` 之后，因此缺的是进入某一行并能返回该行的方式，而不是又一个打印器。

## Decision

终端拥有一套列表到详情的交互 `TuiApp.browse`，各命令是它的消费方。`browse` 接收一个标题与若干 `BrowseRow` 值——供选择器使用的 `PickItem`、页面标题，以及解析出页面各行的 `detail()`——并循环执行：`PickPrompt` 在这些行上打开，`Enter` 把所选行的详情解析进一个 `DetailPrompt`，离开该页面会以刚读过的行作为 `current` 重新打开选择器，在选择器上按 `Esc` 结束循环并把键盘交还编辑器。被拒绝的 `detail()` 会成为页面的各行，因此读取失败只损失该页面而不损失列表。消费方可以加宽选择器的标签列，todo 列表正是这样做的，以免 64 列宽的条目又被列表组件默认的 30 列截断。

`DetailPrompt` 是一个只读页面：一个高亮标题、调用方的各行按终端宽度换行，以及一行暗色提示。`Up` 与 `Down` 滚动一行，`PageUp` 与 `PageDown` 滚动一整页，当行数超过一次绘制的 16 行时提示行带上 `(<first>/<total>)`，`Enter`、`Esc` 或 `Left` 返回列表。其他按键一律忽略，因为该页面没有别的要应答。

`/subagents` 是第一个消费方。`listSubagentChoices` 把子 agent 运行时的后代清单映射为选择器行——持久标签或 id，按深度缩进，后面跟活动状态、模式与 id——`subagentDetail` 则通过 `sessionQuery` 读取某个子会话，取得该行的标签与描述、创建时间、workspace、标题、轮次提纲与已交付文件，并把提纲与文件列表各折叠到八条。清单报告为 `diagnostic` 候选的后代同样可以打开；其页面载有 id 与该持久记录无法解读的原因。

agent 的 todo 列表是第二个消费方，由 `/todos` 以及在状态栏 `todo` 分段上按 `Enter` 打开。`listTodoChoices` 把 `todos` 投影变成每条目一行——状态符号、截到 64 列的内容与状态词——`todoDetail` 则打印某个条目按 72 列换行的完整内容、其状态、`item 3 of 7`、按状态计数的列表（`2 completed · 1 in progress · 4 pending`），以及该条目的轮次事实。列表为空、尚未写入或在本 profile 中不可用时，绘制 `no todos yet` 通知，而不是打开一个空选择器。

## Todo turn facts are keyed by item content

`todo/write` 承载整份列表且不带逐条标识：一个 `TodoItem` 就是 `{ content, status }`。因此条目首次写入的轮次与其状态最后变动的轮次由应用持有，而不是逐条回读：`onSessionEvent` 记住每个 `turn/start` 开启的轮次，每个 `todo/write` 把新列表折入一个以条目内容为键的 `Map`，而 `todo_write` 工具会拒绝同一次写入内的重复内容。绑定会话此前未承载过的内容从当前轮次开始，状态发生变动的已知内容记录该轮次，被这次写入丢弃的内容则被遗忘。因此改写措辞的条目是一个重新开始的新条目，它取代的那个条目已经消失。绑定另一个会话会清空该 Map 并从该会话重放的历史中重建，因此恢复的会话保留其轮次事实，而全新的会话在写出列表前没有轮次事实。

## Alternatives considered

**继续像状态栏分段那样把详情块打印到对话记录。** 否决：对话记录中的块无法单独滚动——用户滚动的是整个终端，长的轮次提纲会把对话挤走——而且打印会关闭列表，于是遍历子 agent 树要为每个子会话付出一次 `/subagents`。模态页面自己滚动，并把列表交回刚读过的那一行。

**给每个命令各自的输出格式。** 否决：`/subagents` 与 todo 列表将各自持有一套行布局、一张按键表与一种空列表处理，而第二个消费方会照抄第一个。基于既有 `PickPrompt` 的一个 `browse` 加一个 `DetailPrompt` 就是全部机制，第三个消费方只需添加一份 `BrowseRow` 列表，别无其他。

**把详情画成只有一行的 `PickPrompt`。** 否决：选择器会在没有任何可选可过滤内容的页面上画出过滤行、行列表与选中高亮，而其 `Escape` 会先去清空一个该页面用不上的查询。`DetailPrompt` 画的是标题、各行以及它所应答的按键。

**在日志中记录逐条 todo 标识，从而不需要内存中的映射。** 否决：`todo/write` 是 `todo_write` 工具的整份列表快照，Web 表层与两个 SDK 都会读取它；为满足一个终端页面而添加 id，会为所有读取方改变一个已记录的事件。内容在一次写入内唯一，足以支撑该页面，代价也已写明：改写措辞的条目算作新条目。

**在页面打开时从日志派生轮次事实，就像子 agent 页面派生其详情那样。** 否决：`todo/write` 自身不带轮次，因此条目的轮次只相对于其所属的 `turn/start` 存在，按需派生意味着每打开一次页面就折叠一遍整份日志。终端本就实时地、并在重放时看到绑定会话的每个事件，因此同一次折叠随事件到达只做一遍。

**让状态栏的 `todo` 分段继续打印其 `/status` 小节。** 否决：该分段命名的正是列表持有的事实，而读取同一份列表的两条路径——`Enter` 下打印的小节与 `/todos` 下的选择器——会彼此漂移。`/status` 仍作为整份报告的一部分打印 todo 小节。

## Consequences

- 状态栏上的 `Enter` 有两种读法：`todo` 分段打开列表，其余每个分段把详情打印到对话记录。包 README 与根 README 都说明了这一分工。
- 详情页面不进入回滚区。页面展示过的内容在其关闭后即消失；对话记录只保留命令打印过的内容。
- todo 的轮次事实是进程本地且以内容为键的，因此改写措辞的条目会重新开始，而没有 `todos` 投影的 profile 根本没有可打开的列表。
- 第三份列表的代价是一份 `BrowseRow` 列表及其详情行；按键、返回刚访问过的那一行的行为以及失败文本都随 `browse` 一起获得。
- `tests/panels.spec.ts` 端到端地钉住两个消费方——遍历、进入、返回已访问的行、无法读取的子会话、空列表与轮次行——`tests/prompts.spec.ts` 钉住 `DetailPrompt` 的换行、滚动、位置行与结束按键，`tests/todos.spec.ts` 与 `tests/catalog.spec.ts` 钉住行与页面文本。

## Related decisions

承载这些列表的终端应用归[作为随发行版交付的 `tui` profile 的终端表层](../architecture/2026-09-15-terminal-surface-tui-app.zh.md)所有。它们打开的选择器正是[可搜索的终端选择器](2026-09-16-tui-picker-fuzzy-filter.zh.md)为之加上查询的那一个，因此子 agent 列表与 todo 列表像其他每个选择器一样过滤。`todo` 分段以及通向它的 `Enter` 绑定来自[可导航的终端状态栏](2026-09-16-tui-status-bar-navigation.zh.md)，其余分段仍保留各自打印出的详情。
