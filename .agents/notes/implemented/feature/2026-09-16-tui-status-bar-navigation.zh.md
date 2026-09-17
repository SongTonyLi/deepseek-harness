# Agent Note: Navigable terminal status bar

Status: implemented

[English](2026-09-16-tui-status-bar-navigation.md) | 中文

## Problem

终端页脚把事实打印成一行暗色文本：模型、推理强度、权限预设、累计 token 用量、上下文百分比、todo、目标与计划标记、workspace 以及待发送附件数量。看到 `ctx 82%`、`goal blocked` 或 `todo 2/7` 的用户无法追问这个数字涵盖什么、由哪个命令改变；唯一的答案是 `/status`，而它一次打印所有小节，且完全不涉及模型、workspace 与附件。这些事实早已为 `/status` 从 `sessionProjections` 读出，因此缺少的是选择与逐项详情，而不是另一个数据来源。

## Decision

编辑器下方的页脚行是一条分段状态栏，顺序固定：模型（`provider/model`）、推理强度、权限预设、token 用量、`ctx NN%`、`todo done/total`、`goal <phase>`、`plan`、workspace 路径（过长时以 `~` 与 `…/` 缩短）以及 `<n> attached`。分段恰在其事实存在时出现，这正是页脚部件此前遵循的规则，因此未注册的投影键或空附件列表会移除对应分段，而不是显示占位符。

`Shift+Down` 把焦点移入状态栏并选中第一个分段：未绘制子 agent 面板时来自编辑器，来自其他任何区域时则不论绘制了什么。状态栏持有焦点时，`Left` / `Right` 与 `Tab` / `Shift+Tab` 在分段之间移动并在两端环绕，`Up` 离开状态栏前往绘制在其上方的区域，`Enter` 打开所选分段且状态栏保持焦点，`Esc` 把焦点交还编辑器。状态栏持有焦点期间其他按键不会到达编辑器，因此散落的字符不会落进用户看不到光标的提示里；`Ctrl+C` 与 `Ctrl+D` 保持其一贯含义并把焦点交还编辑器，使退出路径在任何焦点状态下都可达。编辑器持有焦点时 `Shift+Tab` 仍循环切换所绑定模型的推理强度——该按键按持有焦点的组件解读，而非全局解读。

打开一个分段会陈述其当前事实并指出改变它们的方式：模型分段指出 `/model`，推理强度分段指出 `Shift+Tab`，权限分段指出其预设；用量、上下文、目标与计划分段打印 `/status` 报告中对应的小节；workspace 分段打印状态栏所缩短的完整路径；附件分段列出待发送的附件。这些详情被打印到对话记录。若某个分段的事实已有应用自己的可导航页面，它就声明这一点而不携带详情行，由状态栏打开该页面：`todo` 分段正属于这一类，它打开的是 `/todos` 打开的同一个列表。`src/status.ts` 拥有唯一一套小节构造函数，`/status` 与被打印的分段详情都调用它们，因此同一小节不会在报告与 `Enter` 之下读出两种结果。`src/footer.ts` 保持纯粹：它把同一批事实变成有序的分段列表，把选中下标变成渲染文本，不接触终端、调色板或 agent，这正是分段列表及其环绕行为可以脱离终端测试的原因。

## Key bindings over the pi-tui editor

来自 `@earendil-works/pi-tui` 的编辑器组件为编辑、补全、提交与历史占用了 `ctrl+a`、`ctrl+b`、`ctrl+e`、`ctrl+f`、`ctrl+d`、`ctrl+k`、`ctrl+u`、`ctrl+w`、`ctrl+y`、`alt+b`、`alt+d`、`alt+f`、`alt+y`、`tab`、`enter`、`shift+enter` 以及裸方向键。`shift+up` 与 `shift+down` 是它未占用的一对，因此应用读取它们不会从文本编辑手中夺走按键，且焦点移动的两个方向保持对称易记。在状态栏内部应用拥有整条按键流，这正是 `Tab`、`Enter` 与方向键在那里可以表示导航、而编辑器持有焦点时仍归编辑器所有的原因。

## Alternatives considered

**把页脚做成悬停或鼠标目标。** 拒绝：终端界面在一般情况下运行时没有鼠标上报，而经由 SSH 的键盘 agent 工作流必须能从键盘到达每一项事实。

**绑定 `Ctrl+Up` 或功能键。** 拒绝：`Ctrl` 加方向键的组合常被终端模拟器与多路复用器改写或吞掉，功能键与宿主终端自身绑定冲突的概率也高于 `Shift` 加方向键。

**把详情作为模态提示而非对话记录行打印。** 对于几行就能装下的事实拒绝：页面一关就什么也不留下，而打印出的详情会留在回滚区，紧邻引出该疑问的那一轮。模态队列并不只留给审批与提问——它同样承载[终端先列表后详情的导航](2026-09-16-tui-list-then-details-navigation.zh.md)加入的只读页面——而 `todo` 分段打开的正是其中之一，因为需要走查的列表不同于只需读几行的事实。

**扩充 `/status` 以纳入模型、workspace 与附件事实并放弃状态栏。** 拒绝：它回答的是“全部是什么”而不是“这个数字是什么”，并且让读取一项事实仍要付出一整份报告的代价。

**给分段详情各自的格式化函数。** 拒绝：同一批投影事实的两套渲染会漂移。`src/status.ts` 中共享的小节构造函数使报告与详情成为同一个定义。

## Consequences

- 每一项页脚事实都能就地解释，终端也因此获得一个由应用记录的焦点状态：编辑器、状态栏，或编辑器两个入口按键之一所到达的另一个区域。
- `Shift+Tab` 因焦点而重载——编辑器中循环推理强度，状态栏中回到上一个分段。`/help` 的按键与包 README 同时陈述这两种读法。
- 新增一项页脚事实意味着同时确定其分段与 `Enter` 对它所做的事：要么是它打印的详情行，要么是应用持有的可导航页面。
- 终端每个会话只有一份对话记录，因此 `Enter` 打印的详情与对话交错，而不像浏览器的卡片那样独占侧栏。

## Related decisions

终端界面、其页脚事实以及基于 `sessionProjections` 的 `/status` 报告归属于[终端界面作为随附 `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.zh.md)；`Shift+Tab` 推理强度循环来自 [TUI `/login` 与 Shift+Tab 推理强度循环](2026-09-15-tui-login-and-effort-cycle.zh.md)。`todo` 分段的页面来自[终端先列表后详情的导航](2026-09-16-tui-list-then-details-navigation.zh.md)；`turn` 分段、停靠在编辑器下方的第二个区域，以及推进状态栏中已用时间的那次重绘，则归属于[实时终端子 agent 面板与已用时间计数](2026-09-17-tui-live-subagent-panel.zh.md)。到达状态栏的入口按键，以及离开它前往上方区域的 `Up` 与 `Down`，归属于[终端对话记录导航与聚焦小节检视区](2026-09-17-tui-transcript-navigation-and-inspector.zh.md)。
