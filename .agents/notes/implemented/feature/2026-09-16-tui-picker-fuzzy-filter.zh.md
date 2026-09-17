# Agent Note: Searchable terminal pickers

Status: implemented

[English](2026-09-16-tui-picker-fuzzy-filter.md) | 中文

## Problem

终端打开的每个列表——`/model` 的模型目录、推理强度选择器、`/sessions`、`/signin` 与 `/login` 的提供方行与方法行，以及登录 flow 自身的 `select` 提示——都是一组固定的行，只能用 `Up` / `Down` 在八行的窗口里走动。已组合的目录动辄数十个模型，workspace 中的会话数量也没有上限，因此到达某一行要付出一串按键的代价，而在选择器里按下可打印键则毫无反应：`SelectList.handleInput` 只读取 `Up`、`Down`、`Enter`、`Escape` 与 `Ctrl+C`，其余一律忽略。

## Decision

查询位于 `PickPrompt`——每个选择器都由这唯一一个 `ListPrompt` 子类构建——因此 `/model` 及其推理强度选择器、`/sessions`、`/signin`、`/login` 与授权 flow 的 `select` 提示一同变得可搜索，而不是只让 `/model` 获得一份自己的搜索。`ApprovalPrompt` 与 `ask_user_question` 提示不带查询：审批只有两行固定选项，提问的选项归请求方所有，`Escape` 在这两者中各自只保留一种含义。

可打印键扩展查询，`Backspace` 删除其最后一个字符，`Ctrl+U` 清空它；`decodeKittyPrintable` 从终端在 Kitty 消歧模式下发送的 CSI-u 形式还原该字符，因此两种编码的输入效果相同。`Escape` 在查询非空时清空查询，在查询为空后使选择器以 undefined 结束，因此打错的查询只损失查询而不损失选择器——对 `/model` 而言，也不损失其后的推理强度选择器。`Up` / `Down`、`Enter` 与 `Ctrl+C` 下传给列表，从而在查询留下的行上保持移动与选择的含义。

匹配使用 pi-tui 导出的 `fuzzyFilter`，作用于每行标签与描述的拼接文本，因此一条查询可同时覆盖两者：查询中以空白或斜杠分隔的每一段都必须匹配，留下的行按最佳得分在前返回。`dsk chat` 与 `deepseek/chat` 都能到达 `deepseek/deepseek-chat`，`gpt5` 能到达 `gpt-5`。

查询变化会重建列表。`SelectList` 把行作为构造参数接收，且不公开任何替换它们的方法，因此 `ListPrompt.setRows` 基于新行构造一个全新的 `SelectList`，把它的 `onSelect` 与 `onCancel` 接回同一个结算点，提示则渲染当前那个列表。全新的列表高亮其第一行，在有查询时即最佳匹配行，而 `PickPrompt` 按 value 把选中的行映射回调用方传入的条目。

生效行上的 `✓` 以及选择器打开时定位到该行，都只在查询为空时适用：标记是行标签的一部分，而被匹配的是未加标记的那份行，因此查询既不会匹配到标记，也不会把高亮停在并非它排在首位的行上。行上方的一行暗色文本在查询为空时显示 `type to filter · Enter selects · Esc cancels`，此后显示 `filter: <query> · <kept>/<total>`，而无任何行匹配的查询会用一行暗色的 `no row matches "<query>"` 取代列表。

## Alternatives considered

**只给 `/model` 一份自己的搜索。** 拒绝：让 `/model` 难以走动的行数在 `/sessions` 中更严重，而每个选择器都是同一个类，因此 `/model` 局部的查询意味着共享提示里多一个特例，旁边还留着不可搜索的列表。把查询放进 `PickPrompt` 比那个特例的代码更少，且覆盖终端打开的每个选择器。

**用 `SelectList.setFilter` 过滤。** 拒绝：它保留 `value` 以查询开头的行，比较时不区分大小写（`item.value.toLowerCase().startsWith(filter.toLowerCase())`），因此 `chat` 根本到不了 `deepseek/deepseek-chat`，行的描述也从不参与匹配；而它的空结果会渲染该组件硬编码的 `  No matching commands` 行，在模型、会话或提供方的列表里说的却是命令。

**自己手写匹配器。** 依据[优先使用依赖而非手写](../process/2026-07-26-dependencies-over-hand-rolling.zh.md)拒绝：pi-tui 从提示已用于渲染的同一个包中导出 `fuzzyFilter` 与 `fuzzyMatch`，带有分段切分、词边界与连续命中的评分，以及让 `gpt5` 能到达 `gpt-5` 的字母/数字互换。自持这个匹配器只会为依赖已经提供的行为增加代码与测试。

**就地替换已挂载列表的行。** 拒绝：`items` 与 `filteredItems` 是该组件自己的字段，除 `setFilter` 外没有任何 setter，写入它们会把终端绑定到某一个锁定版本 pi-tui 的内部实现。每次查询变化构造一个列表只用到有文档的构造函数，而一个选择器持有的行数量在数十量级。

**在有查询时仍保留标记与打开时定位的行。** 拒绝：一旦键入查询，用户想要的就是查询排在首位的那一行，而把高亮停在生效行上，要么会让选择离开那一行，要么会指向查询已经滤掉的行。标记本身还位于标签内部，因此过滤带标记的行会让查询匹配到 `✓`。

**让 `Escape` 始终取消。** 拒绝：查询只存在于选择器之中，因此 `Escape` 在那里的首要职责是撤销输入；始终取消会让一个错字关掉 `/model` 以及其后的推理强度选择器。查询为空时 `Escape` 仍然取消，这正是它在键入任何内容之前的含义。

## Consequences

- 每个选择器响应同一批按键，可打印键也不能再成为选择器的快捷键，因为它归查询所有。
- `Escape` 在选择器中有两种读法。选择器自身的首行在查询为空时写明 `Esc cancels`，终端 README 写明清空这一步，`/help` 仍保留其编辑器按键。
- 查询变化按构造方式丢弃列表的高亮与滚动位置，因此每次按键之后的高亮是最佳匹配行，而不是用户先前走到的那一行。
- `tests/pick-filter.spec.ts` 钉住匹配示例、按键处理、过滤行、空结果行、标记以及跨重建列表的滚动窗口，因此各调用点无需为查询编写逐命令测试。

## Related decisions

终端界面及其选择器归属于[终端界面作为随附 `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.zh.md)。被搜索的这些列表保持各自注记所陈述的行为：`/login` 的提供方行与推理强度选择器来自 [TUI `/login` 与 Shift+Tab 推理强度循环](2026-09-15-tui-login-and-effort-cycle.zh.md)，模型与推理强度事实则由[可导航的终端状态栏](2026-09-16-tui-status-bar-navigation.zh.md)的分段解释。编辑器中的 `@` 补全按[会话 cwd 之外的文件引用补全](2026-09-15-file-reference-outside-workspace.zh.md)自身的规则匹配候选项。
