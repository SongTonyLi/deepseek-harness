---
description: "dsh 的交互式终端模式：在你的终端里与 agent（智能体）对话，带流式回复、工具卡片、用键盘浏览对话记录、逐轮次阅读的全屏阅读器、审批、提问、斜杠命令、! 本地命令、@ 引用、附件与会话切换。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-tui-app

[English](README.md) | 中文

## 概述

`dsh-tui-app` 是 dsh 的终端表层：`dsh tui` 在你的终端里启动一个多轮会话，没有浏览器、也没有服务器。回复流式显示，工具调用变成可折叠的卡片，审批与 `ask_user_question` 的问题出现在输入框上方，`@` 补全路径与会话，`/` 命令与 Web 共用注册表。方向键在停靠的检视面板中走遍对话记录；`Ctrl+G` 把它整屏读出、各轮次并排。持久化会话可通过 `/resume`、`/sessions` 或启动参数 `--resume` 恢复；`/new`、`/clear` 与 `/fork` 创建会话，`/export` 写出 ZIP。它运行 `dsh web` 的模型、工具与安全默认值，同一时间一个会话。

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

退出时应用在 stderr 为当时绑定的会话打印 `dsh: session <id> saved; resume with: dsh --profile tui --resume <id>`。恢复的会话会在接受输入前先重绘其持久化历史；在终端内，`/resume` 与 `/sessions` 打开覆盖所有持久化根会话的同一个选择器，并恢复选中的先前会话，`/new` 与 `/clear` 都会开始一个空的新会话且先前会话仍留在磁盘上可用 `/resume` 恢复，`/fork` 把当前会话复制到其最后一个完成轮次并作为新会话，切割点与浏览器的 fork 相同。切换会释放先前的 Agent 并重绘下一个会话的对话记录。

### 屏幕布局

页眉在标题生成或设置后以标题命名会话，并在旁边显示 id。对话记录在终端自身的回滚区中增长：你的提示以 `❯` 开头，启用颜色时铺在一条通栏的着色背景带上（附件列在其下），assistant 的推理以暗色斜体显示在 `✻ Thinking` 标题之下、Markdown 回复上方，每次工具调用是一张卡片，含按状态着色的 `◆` 符号（运行中为黄色、完成为绿色、失败为红色）、粗体工具名、以紫色显示的呈现器标题、运行中的一行加载标记，以及折叠到 `toolPreviewLines` 行的正文。卡片在模型开始调用时出现，先画标题，其下各行在约 `toolRevealFrames` 帧内逐行展开；工具回答后，结果行也以同样方式展开并浮出。`edit` 或 `write` diff 卡片把每一段连续新增行框进绿色圆角框、每一段连续删除行框进红色圆角框，删除的旧行在上、新增的新行在下；工具应用变更后，已应用的 hunk 取代调用时携带的 diff，并在每行前标出文件行号，新增行与未变行用新文件的行号，删除行用旧文件的行号。`subagent` 与 `subagent_*` 卡片折叠时只画一行，行首是同样按状态着色的 `◆`，交给后台的子 agent 则为暗色：运行中显示工具名、任务描述，以及调用指定的模型与 `background`；结束后描述变暗，右端标出 `[done]`，交给后台的子 agent 标 `[started]`，失败标 `[failed]`。在被标记的行上按 `Space`，或按 `Ctrl+O`，即可展开完整卡片。非空的系统提示词与每一条注入的上下文——instructions、catalogs、snapshots、notices、relays 与 recalls——绘制为暗色 `⬡` 标题，其下是面向模型文本的前 `contextPreviewLines` 行，快照的每一份贡献具名写在其自身各行上方；空的系统提示词与压缩替换则省略。承载的行数多于其绘制行数的工具卡片与上下文块，结尾都是同一条标记：该块被对话记录的焦点持有时为 `… <n> more rows · Space expands`，否则为 `… <n> more rows · Ctrl+O expands`。回复中的围栏代码、`read` 卡片的文件行、`edit` 或 `write` diff 卡片的变更行——其中 `+` 新增项标为绿色、`-` 删除项标为红色，符号后的源文本按文件扩展名对应的语言绘制——以及 `!` / `!!` 草稿、用户 shell 的 `$ command` 行（其 `$` 用强调色）与终端工具卡片中的 shell 命令，都使用语法高亮，配色主题由终端自身的背景在明暗之间选定；某种语言的语法会在第一个用到它的代码块出现时才加载，因此该块先以纯文本绘制、随后被重绘为彩色；这里没有对应语法的语言、既不支持 24 位也不支持 256 色的终端，以及 `codeHighlight: false`，都会把每个代码块画成纯文本。标题与列表标记使用暖橙色，链接与行内代码使用紫色，引用保持暗色。流式推理、回复文字与工具参数到达时先入队，再按帧（默认约每秒 60 帧）分批绘制，因此一次网络突发会分摊到 `streamPaceFrames` 帧里，而不是一次落下，队列也从不拖慢模型调用。流式回复文字会淡入，而且每个词各走各的时钟：一个词以接近终端背景色的亮度出现，并经 `streamFadeSteps` 次、每次 `streamFadeStepMs` 提亮到它最终稳定的颜色，因此流得更快只会留下更长的一串正在提亮的词，而不会更暗。流式推理与工具卡片在同一时长内浮出：它们以抬高的颜色出现，再退回到稳定时的暗色斜体或调色板颜色；从持久化历史重绘的卡片不带淡入，已经稳定下来的文字也不会再被调暗。

对话记录下方依次是 agent 工作时的旋转指示——其标签在模型推理时为 `thinking`，可见文本到达时为 `writing`，工具正在流出或仍在执行时为 `calling <tool>`，并带着当前这次模型调用的实时 `↑` 发送与 `↓` 接收 token，以紧凑的 `k` / `M` / `B` 计数，随数据流入增长，并在提供方的 usage 块到达后落定——任何打开的提示、有消息等待时的带框 follow-ups 列表、本轮 todo 与最新后代行的 activity board（有行时才绘制；已完成内容划掉，状态符号以绿色、黄色或青色显示，todo 最多四行其后 `+<n> more`，不是焦点区域，在 `turn/end` 与 bind 时消失）、编辑器、子 agent 面板，以及页脚：未聚焦时是一行由两端向内构建的状态栏。编辑器的光标是终端自身的闪烁竖条：应用在启动时请求这一形状，退出时把你的默认形状还回去，而状态栏或面板持有键盘期间完全不绘制光标。模型与入口按键带有颜色；进行中的轮次、上下文与 todo 信息分别使用黄色、紫色与绿色。模型锚定在左端且永不丢弃——超过 20 列时退回到裸模型名，只有仍然过宽的标签才会被省略号截断——离开编辑器的那两个按键则锚定在右端，写作 `Shift+↑ read · Shift+↓ status`，有 follow-ups 等待时则写作 `Shift+↑ select · Shift+↓ status`，窄到一定程度收缩为 `Shift+↑↓ nav`，不足 40 列时整体丢弃。关键事实填满剩下的中间部分，按状态栏顺序排列：推理强度（选择把推理交给模型时标为 `effort default`）、进行中轮次的已用时间、上下文窗口百分比、todo 计数，以及 workspace 路径（过长时以 `~` 与 `…/` 缩短）。中间部分容纳不下的每个分段都折进末尾的 `+N`，未聚焦行从不绘制的那些分段也一并折入——权限预设、token 用量（会话合计加上进行中的这次调用）、来自投影接缝的目标与计划模式标记，以及待发送附件的数量。压缩与模型请求重试以通知形式出现，与浏览器标记承载的事实相同。

键盘在对话记录中移动时，编辑器正上方停靠着一个带边框的检视面板，边框即模式：它恰好在对话记录持有键盘时绘制。其顶边线带有一个反白的 ` ● READ ` 徽标与当前聚焦小节的标题——该小节在可导航块中的位置、所属轮次，以及这是哪一种小节——例如 `╭ ● READ ─ 3/12 · turn 2 · bash git status · result ─╮`。其下在块含多个部分时，把这些部分绘制成形如 `← 1 call · [2 result] →` 的带编号、会折行的选择行，被持有的标签除强调色外还加上方括号，因此完全无颜色时选择仍然可读；再往下是该小节自身的源文本行，每行以 `│ ` 起头并按窄两列换行，对每一种小节——含系统提示词与注入的上下文——都折叠到 `focusPreviewLines` 行，其下写出 `… <n> more rows · Ctrl+G reads it`。底边线列出对话记录所应答的按键 `↑↓ sections · ←→ parts · Space folds · Ctrl+G reader · Esc input`，随着终端列数减少收缩为 `↑↓ ←→ · Space folds · Esc input`，再收缩为 `Esc input`。

被聚焦的块也会在原地被标记：一条两列宽的标记条，在块的其他行旁为暗色、在被聚焦小节自身的行旁为强调色——若折叠把该小节整个留在了绘出的行之外，强调色便落在那一行折叠标记旁——标记绘制期间该块的内容按窄两列换行。这个标记只能落在 pi-tui 仍以差分方式重绘的行上——也就是它写出的上一帧的最后 `rows` 行，这条边界只会被更高的帧抬高、不会被更矮的帧降低——因为改动其上方的任何一行都会清空终端的回滚区。已经滚过该位置的块不带标记条，检视面板的标题追加 ` · off screen`，其边框线也改画暗色而非强调色，于是边框本身就报告出标记无法画在该块所在之处。淡入中的各行抵达这一边界时，会在写出它们的同一帧内被结算为最终颜色，因此回滚区里不会留下暗色文字。

在任一区域按 `Ctrl+G`、在对话记录的某个小节上按 `Enter`，以及 `/turns`，都会整屏读出对话记录，一次读一个轮次。阅读器并不画在对话记录之上，而是接管终端：它运行在终端的备用屏幕（alternate screen，分页器所用的那块屏幕）上，只要它还开着，对话记录自己的屏幕就被挡在终端之外。因此它不占用对话记录的任何一行，让重绘边界保持原位，在任何终端上都铺满整屏，也不可能把自己的任何一行留在你的回滚缓冲里；关闭它会把对话记录原样恢复成你离开时的样子，期间落地的内容则绘制在其下方。在带有 ` ● READER ` 徽标与 `turn <n> of <total>` 的顶边线之下，正在阅读的轮次占据屏幕的大部分，左侧是一列窄的轮次列表，每个正文行都以右边框收口。列表每个轮次一行——正在阅读的轮次带 `❯`、轮次编号、其提示的首行，以及右对齐的标记 `⬡<n>` 注入上下文块数、`✻` 有推理、`¶` 有回复、`◆<n>` 工具调用数——并在正在阅读的那个轮次之下列出它的各小节，`▸` 落在阅读器所持的那一个上，因此任何轮次自己的上下文都只有一步之遥。轮次面板用对话记录自己的符号把该轮次从头到尾滚动读出，相邻两个小节之间隔一空行：提示以 `❯` 开头、铺在着色背景带上，其后是暗色斜体的 `✻ Thinking`、按对话记录的方式渲染 Markdown（标题、强调、行内代码，以及带语法着色的围栏代码）但无序列表符号画成 `•` 的 `¶ Reply`、工具调用的 `◆`（结果落地后为绿色、运行中为黄色）连同粗体工具名与链接蓝色的标题、缩进在调用之下的 `⎿ Result`（diff 的 `+ ` 行为绿色、`- ` 行为红色，各铺在着色背景带上；`read` 卡片的文件行带语法着色），以及带注入上下文标签的 `⬡`。顶行所属的小节带强调色，并在每一行带上对话记录走查所用的 `┃` 标记条，无色时也能辨认。背景带由终端报告的背景色混合而成，因此没有报告背景色、或不绘制颜色的终端画出的面板不带背景带。那里的行从不折叠：阅读器正是读取系统提示词、注入快照、长回复或工具结果完整面向模型文本的地方。`Right` 打开被选中的轮次，`Left` 回到轮次列表；在列表中 `Up` / `Down` 每次步进一个小节并跨入相邻的轮次，而 `PageUp` / `PageDown` 步进整个轮次；在轮次面板中它们逐行滚动，而顶行所属的小节就是阅读器关闭后对话记录恢复到的位置。`/` 在按键提示的位置打开一行查询，把轮次列表收窄到提示或文本匹配的轮次，读数写作 `<kept>/<total> turns`；其余时候提示边线在右端报告 `turn 3/12 · row 14/212`，任何宽度都不会丢弃它。列数不足 `readerMinColumns` 时正文一次只画一个面板——轮次列表，或由 `Right` 从中打开的那个轮次——不足 24 列或 8 行时只画一行暗色文字 `terminal too small for the reader (needs 24×8)`，并且只应答 `Esc`、`Ctrl+G` 与 `Ctrl+C`。它在每一帧都重新读取对话记录，因此流式回复会在其中增长、落地的工具结果会出现、新轮次会加入轮次列表；重新换行时它按正在阅读的小节重新锚定，而不是按行号；审批或提问出现时它在该提示存续期间让位；切换会话会让它随通知 `the transcript changed · reader closed` 一同关闭。

临时按键反馈以一行暗色带框文字浮在视口右上角：`press Esc again to stop turn <n>`、`press Ctrl+C again to quit` 与 `nothing in the transcript to read yet`。它以全亮度保持 `toastMs`、随后淡出，不占用对话记录自身的任何一行，也不接管键盘；渲染器已无法重绘视口顶部时，它改为打印进对话记录，从而被保留下来。值得留存的事实则是对话记录中的通知：`stopping the turn…`、`wait for the session switch to finish`、`above the repaint window · opened in the reader` 以及每一条命令结果。

动效不止于流式文本，而且每种效果都乘着同一个淡入时钟。键盘落到对话记录、子 agent 面板或状态栏上时，会把该表层的边框、其徽标与它持有的标记抬亮十二拍（每拍一个 `streamFadeStepMs`）；对话记录走查中的一步把新聚焦的标记条抬亮六拍；状态栏上的一步把所选标签抬亮八拍。活动板上新出现或状态已变的 todo 行，以及被替换的后代行，也在同一时钟上像工具卡片一样浮出；重放与 `reducedMotion` 则画出已稳定的活动板。阅读器在自己占据的屏幕上一次性完整出现，而它新显示的内容会像工具卡片一样在同一时钟上浮出：打开它与显示另一个轮次时浮出整个轮次，在列表中步进到同一轮次的另一个小节时浮出该小节，历时 `streamFadeSteps` 拍；滚动、实时增长与重新换行都不浮出任何内容。任何抬亮都不改变任何东西绘制的行数，而 `reducedMotion`——与 `NO_COLOR`、被禁用的调色板和 `TERM=dumb` 一样——会把它们全部关闭，并且不为它们安排任何重绘。

子 agent 面板在绑定会话之下有常驻的子 agent 会话、或列表中带有无法读取的候选者时绘制。未聚焦时它是一行摘要，含列出的数量与第一个子会话的关键标签；聚焦时其标题统计所列出的条目，并以它所应答的按键 `↑↓ children · Enter opens · Tab regions · Esc input` 结尾，在容纳不下时收缩为 `↑↓ children · Esc input`，再收缩为 `Esc input`；每一行给出该子会话的层级缩进、其标签或 id、其模式（`one-shot` 或 `continuable`）、`resident`、其 agent 处于 `running` 还是 `idle`、其已用时间——进行中轮次的用时，否则是已结束轮次的合计——以及其 token 用量，以本进程对该子会话的可见程度与已组合的投影所能提供的为限。最多绘制六行，其下是 `+<n> more · /subagents lists them all`；列表无法解读的候选者绘制为 `unreadable: <reason>` 且打不开任何页面，读取失败的列表则保留上一次成功读取产生的各行，并在其下写出 `listing failed: <reason>`。面板随其最后一行一同消失。在可读的行上按 `Enter` 或 `Right`，与在可读的 `/subagents` 行上按 `Enter` 一样，会把该子会话作为子 agent 视图打开：终端在已绑定会话的位置绘制子会话——其对话记录、实时流、对话记录走查、检查器、阅读器以及它自己的子 agent 面板——而进入它之前的会话保持打开。常驻的子会话被实时读取，其他子会话则被恢复。条目的详情行作为通知打印在 `subagent <label> · Ctrl+P or /parent returns to session <id>` 之下，页眉以 `◆ subagent view ›`（每进入一层一个 `›`）与 `· Ctrl+P returns` 结尾，只要视图打开，输入框正上方就有一条着色行写着 `◆ subagent view · main › <label> · Ctrl+P back to <parent>`，无论对话记录滚动到哪里，`Ctrl+P` 或 `/parent` 返回上一层，并按父会话此刻的日志重绘它。只要这条链中任一会话正在运行轮次，`/new`、`/clear`、`/resume`、`/sessions` 与 `/fork` 都会拒绝，否则它们会随所离开的会话释放每一个视图；退出会释放每一个视图并保存根会话。

### 按键与命令

对话记录、编辑器、子 agent 面板与状态栏构成垂直方向键走查：在最新小节上按 `Down`、在子 agent 面板第一行上按 `Up`、在没有绘制子 agent 面板时于状态栏上按 `Up`，都会落到光标处。follow-ups 列表位于输入框上方；绘制该列表时，`Shift+Up` 会进入它，它也加入 `Tab` 走查。activity board 位于 follow-ups 与输入之间，不是焦点区域。编辑器以外的区域持有键盘时，`Tab` 与 `Shift+Tab` 走遍已绘制的各区域，并在两端环绕；在编辑器中，`Tab` 采用给出的补全，`Shift+Tab` 打开推理强度选择器。在其中任何一个区域按下可打印键都会回到编辑器并在那里输入，因此在阅读时开始写的句子会落在它所指向的地方；对话记录中的 `Space` 是唯一的例外，它折叠被标记的工具卡片或上下文块。`Ctrl+G`、`Ctrl+O`、`Ctrl+T`、`Ctrl+P` 与 `Ctrl+L` 在这些区域中含义完全相同，而 `Ctrl+C` 与 `Ctrl+D` 会先把键盘交还编辑器再行动。提示与阅读器则各自持有整条按键流，并以交还键盘的方式应答 `Ctrl+C`。

编辑器持有键盘时：

| 按键 | 效果 |
|---|---|
| `Enter` | 发送编辑器文本；轮次进行中时它在编辑器上方的带框 follow-ups 列表中等待下一轮次，直到循环领取它后才进入对话 |
| `!command` / `!!command` | 在本终端运行；`!` 会作为下一步上下文供下一条提示阅读，`!!` 只留在本地 |
| `Shift+Enter` | 插入换行 |
| `Ctrl+S` | 轮次进行中时，把编辑器文本引导（steer）进当前轮次的下一步 |
| `Up` / `Down` | 调出先前的提示 |
| `Shift+Left` / `Shift+Right` | 用 pi-tui 的编辑器导航向左 / 右移动一个词；在 `I want to do` 末尾按 `Shift+Left` 会落在 `do` 之前 |
| `Tab` | 采用编辑器给出的补全 |
| `Shift+Tab` | 打开当前模型的推理强度选择器，从下一次请求生效；与空参数 `/effort` 打开的是同一个选择器 |
| `Shift+Up` | 有提示等待时把焦点放到 follow-ups 列表第一行，否则放到对话记录上、停在走查上次停下的小节；首次进入以及切换会话后的首次进入停在最新小节 |
| `Shift+Down` | 在子 agent 面板已绘制时放到其第一行，再否则放到状态栏 |
| `Ctrl+G` | 整屏读出对话记录，停在其最新小节 |
| `Ctrl+O` | 展开或折叠所有工具卡片与上下文行 |
| `Ctrl+T` | 浏览 agent 的 todo 列表，与 `/todos` 打开的是同一个列表 |
| `Ctrl+P` | 从子 agent 视图返回进入它之前的会话，与 `/parent` 相同 |
| `Ctrl+L` | 从头重绘整个屏幕 |
| `?` | 输入为空时列出命令与按键，与 `/help` 相同；在草稿中则作为文字输入 |
| `Esc` | 取消正在运行的 `!`；在没有轮次进行且草稿以 `!` 开头时清空编辑器；否则装填停止，该提示仍在屏幕上时再按一次会停止正在进行的轮次 |
| `Ctrl+C` | 清空编辑器；600 ms 内再按一次则退出 |
| `Ctrl+D` | 编辑器为空时退出 |

仅仅交还了键盘的 `Esc`——离开某个区域、关闭页面、选择器或阅读器——会打开一个 750 ms 的窗口，其间到达编辑器的 `Esc` 完全不做任何事，因此习惯性的连按停不掉任何轮次。没有轮次进行时，`Esc` 在补全列表打开时关闭它，清空以 `!` 开头的草稿，其余情况保持沉默。尚无可读内容的会话对 `Shift+Up`（没有 follow-up 等待时）与 `Ctrl+G` 回以 `nothing in the transcript to read yet`，并把键盘留在编辑器。

follow-ups 面板持有键盘时：

| 按键 | 效果 |
|---|---|
| `Up` / `Down`、`Home` / `End` | 选择一条待处理 follow-up |
| `Enter` | 从队列移除所选 follow-up，并把它引导进最近的步骤，同时唤醒 Agent |
| `S` | 与 `Enter` 相同的引导 |
| `I` | 把所选 follow-up 移到下一步骤的注入队列，但不唤醒 Agent |
| `E` | 从队列移除所选 follow-up 并放入编辑器；`Enter` 发送修订内容，`Ctrl+C` 把原提示恢复到下一轮次队列 |
| `Tab` / `Shift+Tab` | 下一个 / 上一个已绘制区域 |
| `Esc` | 取消并返回输入框 |
| 任何其他可打印键 | 返回输入框并在光标处输入该字符 |

对话记录持有键盘时：

| 按键 | 效果 |
|---|---|
| `Up` / `Down` | 上一个 / 下一个小节；在最新小节上按 `Down` 落到编辑器 |
| `Shift+Up` / `Shift+Down` | 上一个 / 下一个块，停在该块的第一个小节 |
| `PageUp` / `PageDown` | 上一个 / 下一个轮次，停在该轮次的第一个小节 |
| `Home` / `End` | 最早 / 最新的小节 |
| `Left` / `Right` | 被持有块的上一个 / 下一个部分，到该块两端即停 |
| `Shift+Left` / `Shift+Right` | 被持有块的第一个 / 最后一个部分 |
| `Space` | 折叠或展开被标记的工具卡片或上下文块；渲染器已无法重写的块改为在阅读器中打开，并附上通知 `above the repaint window · opened in the reader` |
| `Enter` | 整屏读出该小节 |
| `Tab` / `Shift+Tab` | 已绘制区域中的下一个 / 上一个 |
| `Esc` | 回到编辑器 |
| 其他任何可打印键 | 回到编辑器，并把该字符输入到光标处 |

走查按阅读顺序覆盖每一个小节——系统提示词、注入的上下文（快照的每一份贡献各自作为一部分）、一条消息的推理与回复、一次工具调用的调用与结果，以及你的提示，轮次结束通知与打印出的报告会被跳过。各部分承载的是块自身的源文本，因此一条回复读到的是模型写下的 Markdown，而不是其上方绘制出的渲染结果。一条先流出推理再调用工具的消息在可见文本到来之前只暴露推理小节，因此走查不会落在空白回复上。切换会话会把键盘放回编辑器，并忘掉走查停下的小节。

子 agent 面板持有键盘时：

| 按键 | 效果 |
|---|---|
| `Up` / `Down` | 上一行 / 下一行；在第一行按 `Up` 落到编辑器，在最后一行按 `Down` 到达状态栏 |
| `Shift+Up` / `Shift+Down`、`Home` / `End`、`PageUp` / `PageDown` | 第一行 / 最后一行 |
| `Enter`、`Right` | 把该子会话作为子 agent 视图打开；`Ctrl+P` 返回本会话 |
| `Tab` / `Shift+Tab` | 已绘制区域中的下一个 / 上一个 |
| `Esc` | 回到编辑器 |
| 任何可打印键 | 回到编辑器，并把该字符输入到光标处 |

面板的最后一行离开时，它也会把键盘交还编辑器。

状态栏持有键盘时：

| 按键 | 效果 |
|---|---|
| `Left` / `Right` | 上一个 / 下一个分段，并在两端环绕 |
| `Shift+Left` / `Shift+Right`、`Home` / `End`、`PageUp` / `PageDown` | 第一个 / 最后一个分段 |
| `Shift+Up` / `Shift+Down` | 对话记录上走查停下的那个小节，以及状态栏自身的第一个分段 |
| `Up` | 面板已绘制时到达其最后一行，否则到达编辑器 |
| `Enter` | 打开所选分段且状态栏保持键盘 |
| `Tab` / `Shift+Tab` | 已绘制区域中的下一个 / 上一个 |
| `Esc` | 回到编辑器 |
| 任何可打印键 | 回到编辑器，并把该字符输入到光标处 |

阅读器打开时：

| 按键 | 效果 |
|---|---|
| `Up` / `Down`、`k` / `j` | 在轮次列表中是上一个 / 下一个小节，并跨入相邻的轮次；在轮次面板中是上滚 / 下滚一行 |
| `PageUp` / `PageDown` | 上一个 / 下一个轮次，或翻一页行并重叠一行 |
| `Space` / `b` | 在轮次面板中向下 / 向上翻一页行并重叠一行 |
| `[` / `]` | 在轮次列表或轮次面板中切到上一个 / 下一个轮次 |
| `Home` / `End`、`g` / `G` | 整个对话的第一个 / 最后一个小节，或该轮次的第一行 / 最后一行 |
| `Right`、`Tab`、`Enter` | 从轮次列表进入旁边的那个轮次 |
| `Left`、`Tab`、`Shift+Tab` | 从轮次面板回到轮次列表 |
| `/` | 在轮次列表中打开轮次过滤：可打印键扩展查询，`Backspace` 删除一个字符，`Ctrl+U` 清空，`Enter` 保留收窄后的列表并关闭该行，`Esc` 先清空非空查询、再关闭该行 |
| `Esc`、`q` | 关闭阅读器，并回到对话记录上最后阅读的那个小节；查询行打开时，`Esc` 先清空非空查询、再关闭该行，`q` 则扩展查询 |
| `Ctrl+G`、`Ctrl+C` | 关闭阅读器并回到编辑器 |

到达阅读器的其他每个按键都被消费，而关闭它同样打开那 750 ms 的交接窗口，因此连按多少次 `Esc` 都到不了编辑器的停止。

每个聚焦的分段都在第二行展开其最重要的事实。除 `todo` 之外，`Enter` 把这些事实打印到对话记录，并指出改变它们的方式：模型分段指出 `/model`，推理强度分段指出 `Shift+Tab` 与 `/effort` 共用的选择器，权限分段指出其预设以及 `/permission` 选择器；`turn` 分段——绘制在权限与用量分段之间、形如 `turn <elapsed>`，且只在轮次进行时出现——给出轮次编号、其开始时间、已用时间与排队消息数量；用量、上下文、目标与计划分段打印 `/status` 报告中对应的小节，workspace 分段显示完整路径，附件分段列出待发送的附件。`todo` 分段展开按状态统计的计数以及正在进行的条目（若无正在进行的条目则为下一条待办），`Enter` 打开 agent 的 todo 列表，与 `/todos` 打开的是同一个列表。

在编辑器开头输入 `/` 会补全终端自身的命令与共享注册表的命令；任意位置的 `@` 补全引用。非空的 `!command` 或 `!!command` 行经 `ctx.shell` 在会话 cwd 以 `danger-full-access` 运行；草稿与对话记录中的 `$ command` 行使用语法高亮，输出画在该行之下。`!` 会注入一条插件通知供下一步领取；`!!` 不会。单独的 `!` 仍是普通提示。草稿以 `!` 开头时，编辑器边框改为警告色。

| 命令 | 效果 |
|---|---|
| `/help` | 列出命令，以及每个焦点状态所应答的按键；输入为空时按 `?` 效果相同 |
| `/model` | 为下一次请求选择模型（输入即可过滤行），若模型声明多于一种推理强度则接着选择强度；`/model <provider>/<model>` 直接选择，`/model save` 把当前选择存为默认，在模型列表中按 `Ctrl+S` 则把高亮的模型存为下次启动的默认而不关闭列表 |
| `/effort [id]` | 不带参数时为下一次请求打开当前模型的推理强度选择器，与编辑器中的 `Shift+Tab` 打开的是同一个；id 直接选择，`/effort default` 恢复提供方默认值 |
| `/permission [preset]` | 不带参数时打开权限预设选择器；preset 直接选择。随附 profile 包含实验性 Auto review；`/permission auto` 为当前会话选中它 |
| `/resume` | 打开与 `/sessions` 相同的持久化会话选择器，并恢复选中的先前会话 |
| `/sessions` | 打开持久化会话选择器，并切换到选中的会话 |
| `/new` | 开始新会话 |
| `/clear` | 开始一个空上下文的新会话；先前会话仍留在磁盘上，可用 `/resume` 恢复 |
| `/fork [turn]` | 在本会话最后一个完成轮次处 fork，或在第 `turn` 轮之后 fork |
| `/title <text>` | 重命名本会话；单独使用时显示当前标题 |
| `/attach <path>` | 把图片或文件附加到下一条提示；`/attach` 列出，`/attach clear` 丢弃 |
| `/queue` | 显示为下一轮次与下一步排队的消息；`/queue clear` 丢弃它们，编辑器上方的对应行也随之消失 |
| `/skills` | 列出 agent 可加载的技能 |
| `/signin` | 通过提供方的通知与提示登录；`/signin <key>` 跳过选择器 |
| `/login` | 用提供方订阅登录（隐藏仅收集密钥的登录）；`/login <key>` 跳过选择器 |
| `/export [dir]` | 把本会话的日志 ZIP（含子会话与附件）写入 `dir`，默认 workspace |
| `/status` | 上下文窗口用量与构成、含缓存命中的 token 总计、会话统计、todo、目标、计划模式与权限 |
| `/todos` | 浏览 agent 的 todo 列表；已完成行会被划掉；`Enter` 完整打开其中一条，含其状态、位置与轮次 |
| `/outline` | 本会话各轮次及其提示与回复预览 |
| `/deliverables` | agent 交付的文件，按轮次分组 |
| `/changes [turn]` | 浏览最近一轮（或第 `turn` 轮）改动的文件及其行数；`Enter` 打开某个文件从轮次开始到结束的对比 |
| `/subagents` | 浏览本会话之下的子 agent 会话；`Enter` 把可读的会话作为子 agent 视图打开，对无法读取的会话则打开其详情 |
| `/parent` | 从子 agent 视图返回进入它之前的会话，与 `Ctrl+P` 相同 |
| `/settings [ns [path value]]` | 列出命名空间、显示某一个或设置某个字段；`/settings reset <ns>` 恢复默认 |
| `/plugins` | 已组合的插件及其启用状态与生命周期阶段；`/plugins bundles` 列出 profile 的组合包，`/plugins enable <id>` 与 `/plugins disable <id>` 切换某个插件条目或组合包，`/plugins add <spec>` 安装组合包，`/plugins remove <name>` 移除组合包 |
| `/tools` | 像 `Ctrl+O` 一样展开或折叠所有工具卡片与上下文行 |
| `/turns` | 像 `Ctrl+G` 一样整屏读出对话记录，各轮次并排 |
| `/quit`、`/exit` | 保存会话并退出 |

其他每条 `/name` 行都交给共享命令注册表，因此 `/compact`、`/goal` 与插件命令的行为和浏览器中一致。

终端打开的每个选择器——`/model` 的模型列表与推理强度列表、空参数 `/effort` 与编辑器 `Shift+Tab` 共用的当前模型推理强度列表、空参数 `/permission` 打开的权限预设列表、`/resume` 与 `/sessions` 共用的持久化会话列表、`/subagents` 与 `/todos` 的列表，以及 `/signin` 与 `/login` 引出的各行——都随输入过滤其行：查询同时匹配每行的标签与描述，其以空白与斜杠分隔的各段必须全部匹配，各行按最佳匹配在前排序，因此 `dsk chat` 与 `deepseek/chat` 都能找到 `deepseek/deepseek-chat`，`gpt5` 能找到 `gpt-5`。`Backspace` 删除最后一个字符，`Ctrl+U` 清空查询，`Esc` 在查询非空时清空查询、在查询为空时取消选择器，`Up` / `Down` 在匹配行之间移动，`Enter` 选中高亮行。行上方的暗色行在查询为空时显示 `type to filter · Enter selects · Esc cancels`，此后显示 `filter: <query> · <kept>/<total>`；无任何行匹配的查询会以 `no row matches "<query>"` 取代这些行，而生效行上的 `✓`——也就是选择器打开时定位的那一行——只在查询为空时显示。

`/todos`、状态栏的 `todo` 分段与 `/subagents` 中无法读取的行共用同一套先列表、后详情的交互：选择器列出各条目，`Enter` 把高亮条目作为只读页面打开，`Up` / `Down` 与 `PageUp` / `PageDown` 滚动该页面，`Enter`、`Esc` 或 `Left` 返回列表并停在刚读过的条目上，因此连续查看多个条目无需重新输入命令；在列表上按 `Esc` 返回编辑器。详情无法读取的条目会在其页面上说明原因，而不会关闭列表。

### 订阅登录

`/login` 只存储订阅凭据，不会激活休眠的模型路由。先配置 catalog 路由，再使用完整的凭据键；例如先运行 `/settings llm-pi-ai providers.openai-codex {}`，再运行 `/login llm-pi-ai/openai-codex`。Cursor 已经注册：`/login llm-cursor/cursor`。被标记的授权页面会在本地默认浏览器中打开，其 URL 同时保留在对话记录中作为后备。SSH 启动、无桌面的宿主、`--no-open` 以及打开器失败时，手动 URL 与设备码路径仍然可用。

### 来自 agent 的提示

审批请求绘制 `Allow <tool>?`、请求方的理由、请求所指的已记录调用（与其工具卡片相同的行，因此 shell 命令在运行前可读）以及两行选项：允许一次或拒绝；`Esc` 拒绝，`Ctrl+C` 取消该请求。`ask_user_question` 的问题把其 `detail` 渲染为 Markdown，置于选项与一行自由文本之上；多选用 `Space` 切换各行并通过 `Done` 确认。计划评审（`exit_plan_mode` 设置的 `plan-review` 意图）把计划绘制为 Markdown，并提供 Approve、Decline 与 Discuss 行，其中 Discuss 像浏览器卡片一样把请求交回编辑器。提示排队、一次只显示一个，被中止的请求会撤回其提示。

### 引用与附件

`@` 后接文本会列出匹配的文件与目录——相对工作区、从工作区出发的 `../`、从家目录出发的 `~/`、或绝对路径——以及其他会话，使用与浏览器编辑器插入相同的提及语法（`@path`、`@"path with spaces"` 与不透明的 `@[label](…)` 会话标记）；base 行把这些提及解析进提示，与浏览器中完全一致。`/attach <path>` 读取相对于 workspace 的本地文件并通过已组合的附件存储保存：`.png`、`.jpg`、`.jpeg`、`.webp` 与 `.gif` 作为图片块，其余作为文件块；待发送附件随下一条提示一起发送，并列在其下。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `prompt` | 无 | 终端就绪后提交的首个提示 |
| `resume` | 无 | 要继续的持久化会话 id，而不是新建会话 |
| `toolPreviewLines` | `8` | 在被标记的卡片上按 `Space` 或按 `Ctrl+O` 展开之前，工具卡片折叠状态下的正文行数 |
| `contextPreviewLines` | `4` | 在被标记的块上按 `Space` 或按 `Ctrl+O` 展开之前，系统提示词或注入的 `⬡` 上下文块绘制的行数 |
| `focusPreviewLines` | `12` | 停靠的检视面板为聚焦小节显示的行数，其后由折叠标记把剩余部分交给阅读器；对每一种小节都适用 |
| `readerMinColumns` | `60` | 阅读器把被选中的轮次画在轮次列表旁边所需的列数；不足时一次只画一个面板 |
| `codeHighlight` | `true` | 以语法高亮绘制回复中的围栏代码、`read` 与 diff 工具卡片的文件行，以及 `!` / `!!` 草稿、`$ command` 行与终端工具卡片中的 shell 命令，配色主题由终端背景选定 |
| `toastMs` | `2000` | 临时按键提示行以全亮度保持多久后淡出，这同时也是第二次 `Esc` 停止正在进行轮次的窗口 |
| `liveRefreshMs` | `1000` | 重绘周期：推进 `turn` 分段与面板中的已用时间，并重新读取已过期的子 agent 列表 |
| `streamFadeSteps` | `24` | 一次淡入或浮出持续多少拍：回复文字淡入，推理与工具卡片浮出，时长为 `streamFadeSteps × streamFadeStepMs` |
| `streamFadeStepMs` | `16` | 一帧的时长：淡入或浮出的一拍、仍在变化时的重绘周期，也是逐帧绘制流式文字的周期；总时长为 `streamFadeSteps × streamFadeStepMs` |
| `streamPaceFrames` | `8` | 积压的流式回复文字或工具参数要经过多少帧才全部上屏。思考块结束时，或回复文字或工具调用开始时，仍在队列中的思考立即画出；`0` 与 `reducedMotion` 一样，收到即绘制 |
| `toolRevealFrames` | `6` | 工具卡片出现或其结果落下时，其各行展开所用的帧数，每帧展开隐藏行的一份。展开卡片，以及正在展开的行已位于渲染器可重绘范围之上的卡片，都会一次画出所有行；`0` 与 `reducedMotion` 一样，一次画出所有行 |
| `reducedMotion` | `false` | 以稳定颜色绘制流式文本、流式推理、工具卡片与应用自身的边框装饰，不做淡入、不做抬亮，也不重复重绘 |
| `openBrowser` | `true` | 把被标记的授权页面交给本地默认浏览器 |

`prompt`、`resume` 与 `openBrowser` 经启动提供方来自命令行；生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tui-app)是所有可接受字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

runner 与 `dsh-headless` 一样是核心 API 载体之上的直接驱动器，但会一直运行到用户退出，并通过 pi 编码 agent 的差分终端渲染器 [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi) 绘制。

### 运行流程

runner 等待完整应用就绪（`ctx.get('loader')?.await()`），并在核心注册表之上构建含四个操作的会话宿主：`create` 用共享的 [`agentDefaultModel`](../../core/agent-default-model/README.zh.md) 选择创建一个全新的持久化 Agent，`resume` 先拿到 Agent 写句柄，再经 `ctx.sessionQuery` 观察实时 Session，使 bind 画出每条持久化事件（包括恢复时的闭合事件），`fork` 通过 `ctx.sessionQuery` 观察源会话、在所选（默认最后一个）`turn/end` 之后直到下一个 `turn/start` 处切割，并创建带 `parentSession` 与 `isSeeded` 元数据的种子 Agent，`observe` 打开子 agent 会话而不释放已绑定的会话——常驻的子 agent Agent 被实时读取、释放它什么也不做，其他会话则被恢复。除常驻会话的 `observe` 外，每个操作都在 Agent 的作用域 setup 中安装 `ModelSelectionRef`，因此 `/model` 会改变下一次请求。终端应用从 `--resume` 或一次新的 `create` 产生的会话开始，订阅 `session/event`、`agent/assistant-stream` 与 `agent/status`，只为绑定的 Agent 应答 `approval/request` 与 `user-questions/request` waterfall，并通过绑定下一个会话、dispose 先前句柄来切换会话；宿主打开下一个会话期间编辑器拒绝输入，等待期间退出会释放随后到达的会话。退出时取消任何进行中的轮次、等待完全停稳、flush 绑定的会话、dispose 其句柄并请求以 0 退出；驱动器失败会向 stderr 写入 `dsh: <message>` 并请求以 1 退出。`/resume` 与 `/sessions` 共用持久化会话选择器。编辑器中的 `Shift+Tab` 会派发空参数 `/effort` 以打开当前模型的推理强度选择器，而编辑器中的 `Shift+Left` / `Shift+Right` 使用 pi-tui 的词导航。`/login` 只带着订阅方法（除收集密钥的 `api-key` 登录外的每一种方法）启动 `authorization.begin`。flow 用 `openInBrowser` 标记的 notice 会经 `dsh-native-command` 的凭据擦除辅助进程交给默认浏览器，URL 同时保持打印；当 `openBrowser` 为 false、启动经过 SSH 或宿主没有桌面时抑制该交接，打开器失败则成为 URL 旁的一条通知，而非登录失败。编辑器里提交的非空 `!` 或 `!!` 行经本进程的 `ctx.shell` 运行；`!` 注入一条下一步通知，`!!` 只留在本地。

### 渲染模型

持久事实来自会话日志：`system/message`（非空提示词完整画出；空的绘制则省略）、`user/message`（自己提交的消息只绘制一次，其回显按消息 id 跳过；注入的上下文——instructions、catalogs、snapshots、notices、relays、recalls 以及未声明的形式——以暗色 `⬡` 行完整画出，快照按具名贡献各成一部分；压缩替换以及工具或模型来源则省略）、`assistant/message`（用已提交文本替换流式块，并把用量折入页脚）、`tool/call` 与 `tool/result`（工具声明 `presentCall` 与 `presentResult` 视图时据此绘制，否则回退到原始参数与原始结果）、`turn/end` 通知、`workspace/changes`（在 Host 仍保存摘要时，以一行通知给出该轮的文件数与行数）、`session/title`（页眉）、`permission/preset`（页脚），以及所属 `turn/start` 之下的 `todo/write`（某条 todo 的详情页所报告的轮次；该列表不带逐条标识，因此改写措辞的条目算作新条目；同一次写入还从 `todos` 投影刷新 activity board）。后代会话的 `tool/call`、`tool/result` 或 `turn/end`，以及绑定父会话的 `subagent/start` / `subagent/end`，会替换该板上的一行摘要——工具标题或结果首行，从不使用子会话的 assistant 正文；绑定会话的 `turn/end` 与 bind 会清空该板。实时增量来自 `agent/assistant-stream` 的文本、推理、工具调用与用量增量：模型一报出工具名就挂上卡片，工作时的旋转指示跟随该流以及持久的 `tool/call` / `tool/result`，从而标出 `thinking`、`writing` 或 `calling <tool>`，并带着该次调用的实时 `↑` 发送与 `↓` 接收。日志之外的会话事实来自浏览器读取的同一批服务：`sessionTitle`、`permissionPresets`、供选择器、`/deliverables` 与子 agent 详情使用的 `sessionQuery`、供页脚、`/status`、`/todos` 与 `/outline` 使用的 `sessionProjections`、供 `@` 补全使用的 `fileReferences` 与 `sessionReferenceResolver`、`attachments`、`skills`、`authorization`、`settings`、`subagents`，以及供 `/plugins` 使用的 Loader 条目。模态提示是进程本地的呈现，从不写入日志。

### 基于 base 的 patch 面

该 patch 叠加在 `dsh-base` 之上：在 base 的 `system-prompt` 行上设置编码 persona 前缀与 cwd 后缀，保留与 Web 表层相同的临时进程级 PTC 模式开关（`DSH_TOOLS_MODE`），插入 PTC 模式的 worker，挂载由终端应答其问题的模型侧 `ask_user_question` 工具，挂载浏览器所组合的同一批 `@` 引用解析器（`file-reference-local`、`session-reference`）与 `present` 交付物工具，加入 `/outline` 与 `/status` 背后的 `session-turn-outline` 与 `session-stats` 投影行，并挂载启动提供方与 runner。base 的 agent 平面行（bash、文件系统、技能、目标、压缩、子 agent）保持启用，因为终端在进程范围内组合其 Agent。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `tui-app` 插件：会话宿主（创建、恢复、fork、观察）、恢复观察、退出流程、退出码映射 |
| [`src/startup.ts`](src/startup.ts) | `tui-app-startup` 提供方：提示位置参数、`--resume`、`--no-open` 与 `--help` |
| [`src/app.ts`](src/app.ts) | 终端应用：布局、按键路由、命令、会话绑定、接缝、日志与流的折叠、编辑器上方的 activity board、停止装填、它挂载的临时提示行、阅读器所依托的终端交接，以及提交时解析的 `!` / `!!` |
| [`src/keys.ts`](src/keys.ts) | 按键模型：各焦点区域、一次按键在每个区域中的含义、它们逐级收缩的按键提示、进入用的按键、`/help` 的各行，以及交接窗口 |
| [`src/sessions.ts`](src/sessions.ts) | `/resume` 与 `/sessions` 共用的持久化会话列表及选择器行 |
| [`src/effort.ts`](src/effort.ts) | `/model`、`/effort` 与编辑器 `Shift+Tab` 共用的推理强度名称及选择器行 |
| [`src/permission.ts`](src/permission.ts) | `/permission` 的权限预设名称及选择器行 |
| [`src/attach.ts`](src/attach.ts) | `/attach`：本地文件经附件存储成为图片或文件块 |
| [`src/export.ts`](src/export.ts) | `/export`：通过导出包的归档辅助函数写出会话日志 ZIP |
| [`src/blocks.ts`](src/blocks.ts) | 对话记录组件：用户提示、用户 shell 运行、assistant 回复、工具卡片、系统提示词与注入上下文、通知；可导航的块暴露其各小节并绘制焦点标记条，可折叠的块则承载两个折叠键共用的那条标记。每个块保留上次画出的行，回复还保留上次 Markdown 解析所着色的代码围栏，并只对最后一个已关闭围栏之后仍打开的尾部重新词法分析，因此已稳定的对话记录每帧只花每块一次键比较，一次流式增量也只为发生变化的那个围栏着色 |
| [`src/context.ts`](src/context.ts) | 把已记录的系统提示词与注入的用户消息投影为对话记录小节 |
| [`src/navigation.ts`](src/navigation.ts) | 把对话记录看作各个小节、沿四条轴走遍它们的光标、这些小节归入的各轮次，以及检视面板的标题 |
| [`src/inspector.ts`](src/inspector.ts) | 停靠的检视面板：带模式徽标的边框面板、小节标题、带编号且会折行的各部分选择行、折叠后的各行，及其挂载的组件 |
| [`src/frame.ts`](src/frame.ts) | 纯粹的画框：圆角边框线、反白的模式徽标、正文行，以及某个宽度容纳得下的按键提示级别 |
| [`src/reader.ts`](src/reader.ts) | 作为纯数据的阅读器：其状态、按键变成的各个意图、其几何布局，以及它画出的各行 |
| [`src/reader-screen.ts`](src/reader-screen.ts) | 画在备用屏幕上的阅读器面板：其按键映射，以及它把键盘留在何处 |
| [`src/screen.ts`](src/screen.ts) | 在构建一帧与写出该帧之间带若干次结算的主屏幕、每次结算所依据的重绘窗口、每个块的重绘下界，以及把对话记录挡在终端之外的挂起 |
| [`src/alt-screen.ts`](src/alt-screen.ts) | 终端的备用屏幕：接管它、在其上按绝对行址绘制，以及把对话记录自己的屏幕交还 |
| [`src/fade.ts`](src/fade.ts) | 流式文本淡入与浮出：基于挂钟的尾部追踪器、块时钟与注册表、淡入亮度级别、浮出混合，以及对已渲染行的重新着色 |
| [`src/pace.ts`](src/pace.ts) | 流式节拍器：助手流与对话记录之间的有序队列，每帧释放积压的一份；以及以同样方式展开工具卡片的逐行展开器 |
| [`src/motion.ts`](src/motion.ts) | 边框装饰的动效时钟与其调用点所绘的三级抬亮：落键、小节步进与状态栏走查 |
| [`src/prompts.ts`](src/prompts.ts) | 审批、提问、选择器与只读详情提示以及模态队列 |
| [`src/toast.ts`](src/toast.ts) | 临时按键提示行：其浮层、其时钟，以及它承载的各条文字 |
| [`src/transcript.ts`](src/transcript.ts) | 呈现视图、用量与轮次结束原因的纯文本折叠、`$ command` 的 span，以及每条标记共用的那一套折叠措辞 |
| [`src/diff.ts`](src/diff.ts) | diff 卡片的行 diff、hunk 选择，以及卡片加框所依据的新增与删除标记 |
| [`src/style.ts`](src/style.ts) | 调色板（含 Markdown 回复所用的暗色冷色阶标题与链接色、已完成 todo 内容所用的划线角色、提示所铺的背景带）与派生的 pi-tui 主题 |
| [`src/highlight.ts`](src/highlight.ts) | 围栏代码、文件行与 shell 命令的语法高亮：某个块可能加载的语法、由背景选定的配色主题，以及一个 token 所用的 SGR |
| [`src/completion.ts`](src/completion.ts) | 编辑器的斜杠命令与 `@` 引用补全 |
| [`src/editor.ts`](src/editor.ts) | 提示编辑器的终端光标、把 `Shift+Left` / `Shift+Right` 映射到 pi-tui 词导航的逻辑，以及 `!` / `!!` 草稿上的语法高亮 |
| [`src/shell-line.ts`](src/shell-line.ts) | 解析 `!` / `!!` 行或实时草稿，并格式化对话记录行与面向模型的通知 |
| [`src/status.ts`](src/status.ts) | 投影接缝的事实，以及 `/status` 报告与分段详情共享的小节；压缩与重试通知 |
| [`src/footer.ts`](src/footer.ts) | 状态栏：有序的各分段、每个分段的详情行、未聚焦时由两端向内构建的一行，以及聚焦时的滑动窗口 |
| [`src/subagent-panel.ts`](src/subagent-panel.ts) | 实时子 agent 面板：一次后代列表加上采样到的实时事实构成其各行、未聚焦时的摘要行，以及聚焦时的列表 |
| [`src/queue-panel.ts`](src/queue-panel.ts) | follow-ups 列表：待处理行符号、悬挂换行与 enter-steer 图例 |
| [`src/activity-board.ts`](src/activity-board.ts) | activity board：todo 状态符号、已完成内容划掉、行数上限，以及一行后代摘要 |
| [`src/catalog.ts`](src/catalog.ts) | `/settings`、`/plugins`、`/subagents`、`/deliverables`、`/changes` 与 `/outline` 的行，以及 `/plugins` 的管理动作 |
| [`src/view-banner.ts`](src/view-banner.ts) | 输入框上方标明已打开的子 agent 视图及返回按键的一行 |
| [`src/todos.ts`](src/todos.ts) | todo 列表：状态符号、已完成内容划掉的选择器行与单个条目的详情行 |
| [`cordis.patch.yml`](cordis.patch.yml) | 基于 `dsh-base` 的终端 patch |
| — | 不发布运行时不变量伴随模块；应用只在一个 Agent 上注册监听器，不持有其他观察者可能与之矛盾的可变关系。 |
| [`tests/app.spec.ts`](tests/app.spec.ts) | 基于伪终端的渲染、按键、命令、停止装填、编辑器上方的 follow-ups 行、activity board 与两个接缝 |
| [`tests/activity-board.spec.ts`](tests/activity-board.spec.ts) | activity board 的状态符号、已完成划掉、行数上限与后代行 |
| [`tests/keys.spec.ts`](tests/keys.spec.ts) | 每个区域为一个按键认领什么、按键提示的各级，以及一次按键输入的文字 |
| [`tests/editor.spec.ts`](tests/editor.spec.ts) | 对照 pi-tui 编辑器行为验证终端光标、`Shift+Left` / `Shift+Right` 词导航，以及 `!` / `!!` 草稿着色 |
| [`tests/frame.spec.ts`](tests/frame.spec.ts) | 边框线、徽标、正文行，以及某个宽度容纳得下的按键提示 |
| [`tests/motion.spec.ts`](tests/motion.spec.ts) | 动效时钟的各个级别、它对重绘的要求，以及每一级所绘的抬亮 |
| [`tests/pace.spec.ts`](tests/pace.spec.ts) | 节拍器的每帧份额、按字素切分、到达顺序、flush、按通道 flush 与 clear，以及逐行展开器的每帧份额、settle 与 clamp |
| [`tests/stream-pace.spec.ts`](tests/stream-pace.spec.ts) | 按流顺序分批绘制的回复文字与工具参数，思考块结束时画出思考，流结束时与已记录事件前的 flush，reducedMotion，以及在帧节拍上展开的工具卡片 |
| [`tests/view-banner.spec.ts`](tests/view-banner.spec.ts) | 子 agent 视图行的路径、返回目标、宽度，以及在主会话时不绘制 |
| [`tests/toast.spec.ts`](tests/toast.spec.ts) | 临时提示行的方框、其保持、其淡出与其提前结算 |
| [`tests/reader.spec.ts`](tests/reader.spec.ts) | 阅读器的几何布局、其状态机、其过滤，以及它返回的各行 |
| [`tests/reader-screen.spec.ts`](tests/reader-screen.spec.ts) | 阅读器面板：其按键映射、它铺满的屏幕、其重新锚定与其退出 |
| [`tests/alt-screen.spec.ts`](tests/alt-screen.spec.ts) | 备用屏幕：其成对的切换、其逐行绘制，以及更短的一帧所清除的行 |
| [`tests/commands.spec.ts`](tests/commands.spec.ts) | 基于脚本化服务的 `/resume` 与 `/sessions` 选择器、附件、队列、技能、登录、导出、引用、`/effort` 与 `Shift+Tab` 共用的选择器、`/permission` 选择器，以及模型列表中的 `Ctrl+S` |
| [`tests/shell.spec.ts`](tests/shell.spec.ts) | 提交时解析的 `!` / `!!` 分发、实时草稿解析、下一步 inject、Esc 取消，以及缺少 shell 时的通知 |
| [`tests/effort.spec.ts`](tests/effort.spec.ts) | 共用的推理强度名称、选择器行、当前强度提示与输入参数匹配 |
| [`tests/permission.spec.ts`](tests/permission.spec.ts) | 共用的权限名称、选择器行、当前预设提示与输入参数匹配 |
| [`tests/panels.spec.ts`](tests/panels.spec.ts) | 状态页脚与报告、可导航的子 agent 与 todo 列表、目录命令、命令提示与审批详情 |
| [`tests/transcript-focus.spec.ts`](tests/transcript-focus.spec.ts) | 走遍对话记录、区域序列、检视面板、实时会话上的阅读器连同它接管与交还的终端，以及重绘窗口内的原地标记条 |
| [`tests/context.spec.ts`](tests/context.spec.ts) | 把系统提示词与注入上下文投影为对话记录小节 |
| [`tests/index.spec.ts`](tests/index.spec.ts) | 创建、恢复分页、fork 切割、会话切换、退出流程与失败报告 |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | 基于真实 Loader 配置树的命令行解析 |
| [`tests/shortcuts.spec.ts`](tests/shortcuts.spec.ts) | 空输入与草稿中的 `?`、任一区域的 `Ctrl+T`、根会话上的 `Ctrl+P`，以及 `Ctrl+L` 重绘 |
| [`tests/subagents.spec.ts`](tests/subagents.spec.ts) | 实时子 agent 面板的各行、走查与列表刷新，以及它与 `/subagents` 打开的子 agent 视图：经 `/parent` 与 `Ctrl+P` 离开，并在会话切换与退出时释放 |
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

### 用户键入的 shell 命令

#### 模型看到什么

非空的 `!command` 行在命令结束后注入一条插件通知（`source.kind: plugin`，`plugin: tui-app`，`form: notice`）。下一步领取时会带上此包装；`<command>` 与围栏正文依数据而定。没有输出时使用精确一行 `(no output)` 而不是围栏。取消的运行会再追加一个空行和 `(command cancelled)`。非零退出会再追加一个空行和 `Command exited with code <n>`。`!!command` 与单独的 `!` 不添加通知。

##### 用户 shell 通知前缀

```markdown
The user ran `<command>` in the terminal.
```

#### Token 影响

有条件且保留：每条 `!` 通知留在之后请求的对话历史中；`!!` 与单独的 `!` 不增加任何内容。

#### KV Cache 影响

在可复用的请求前缀之后只做追加式增长。该通知不改变系统提示或工具目录。`/model` 切换像在浏览器中一样开始新的请求序列。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制描述随发行版交付的终端表层；它们不是一般的 CLI 比较，也不是任务积压。

- **同一时间一个会话**——`/resume`、`/sessions`、`/new`、`/clear` 与 `/fork` 在会话间移动终端，但只有绑定的 Agent 流式显示，子 agent 视图也是用一个子会话替换它所来自的会话来绘制；浏览器可并排展示多个会话。
- **审批为一次性**——提示只提供允许一次或拒绝，与审批接缝的词汇一致；没有记忆的授权。
- **仅浏览器的页面留在浏览器**——workspace 与目录选择器、在应用中打开的链接、轨迹账本与逐条消息的点赞/点踩没有终端对应物；`/settings`、`/plugins`、`/subagents`、`/outline` 与共享的 `/feedback` 以文本覆盖其事实，子 agent 的对话记录在子 agent 视图中阅读。
- **交付物只列名、不打开**——`/deliverables` 列出交付路径，`/changes` 显示逐行对比；浏览器会预览这些文件。
- **历史由终端回滚区持有**——键盘可以走遍对话记录的每个块与每个部分，工具卡片与上下文块可以折叠，阅读器的 `/` 过滤可以收窄本会话的各轮次；搜索一个轮次的文本以及其他会话的历史，属于浏览器表层。
- **滚走的聚焦块只在检视面板中被标记**——pi-tui 只对它写出的上一帧的最后 `rows` 行做差分重绘，要改动其上方的内容就得清空终端回滚区，因此更靠前的块得不到标记条，检视面板标题写出 `off screen`，其边框转为暗色，在它上面按 `Space` 会打开阅读器而不是重写它；`Ctrl+O` 是唯一仍会重写那些行的按键，在高于终端的对话记录上它会让 pi-tui 整屏重绘。
- **缩过的帧会让视口顶部脱离可及范围**——重绘窗口随迄今写出的最高一帧上升且不会回落，因此在读取模式关闭或旋转指示离开之后，临时提示行改为打印进对话记录；它会随对话记录增长而恢复。阅读器不受影响：它画在终端的另一块屏幕上，那里的每一行都归它所有。
- **阅读器开着时不绘制对话记录**——对话记录的屏幕被挡在终端之外，因此期间跑完的轮次、落地的工具结果与打印的通知，都在阅读器关闭时的同一帧里绘出。阅读器自身仍会随它们到达而显示，因为它在每一次绘制时都重新读取对话记录。
- **阅读器显示的是源文本**——assistant 回复读到的是模型写下的 Markdown，而不是对话记录绘制出的渲染结果，因此表格与标题以源码形式呈现；只有列表项开头的 `-`、`*` 或 `+` 画成 `•`。
- **面板列出的是常驻，而不是整棵树**——子会话在其会话记录常驻于本进程期间加入面板，因此由进程外提供方运行、在此没有自己会话的子 agent 永远不会出现；`/subagents` 仍是到达每一个持久后代的途径。
- **常驻不等于正在工作**——列表的 `activity: 'running'` 表示该子会话的记录常驻，这正是行内 `resident` 所报告的内容；子会话是否在工作则是它旁边单独的 `running` / `idle`，读自本进程中该子会话的 Agent。
- **溢出行之后的各行不可选中**——面板最多绘制六行，`Up` / `Down` 在其两端会离开面板；被折叠进 `+<n> more` 的子会话通过 `/subagents` 到达，后者遍历完整的后代树。
- **面板的文字按其上次刷新时的宽度构建**——面板绘制期间改变终端大小，其标题按键提示与行文字会保持那次宽度所选的形态，直到下一次列表更新、选择移动或实时重绘重新构建它们。
- **淡入需要终端的应答**——其亮度级别由终端对启动时发出的查询所报告的背景色构建，因此保持沉默、或既不编码真彩色也不编码 256 色的终端只会得到两级的暗淡模式；`NO_COLOR`、被禁用的调色板、`TERM=dumb` 与 `reducedMotion` 会完全关闭每一种淡入与每一种边框抬亮，临时提示行届时在保持结束时直接消失，而不是淡出。
- **终端自身的光标可能闪烁**——编辑器不绘制自己的光标，应用打开终端光标，而 pi-tui 会在其重绘的各行之间移动它；不支持 pi-tui 为一帧包裹的同步输出序列的终端可能显示出这种移动。
- **通过 `dsh` 启动器运行**——以其他方式启动该 profile 会在启动时失败，因为只有启动器能请求进程退出。
- **`!` 是一次性的，也不是 TTY**——每一行都是一次新的 `ctx.shell.run`；没有持久 shell，也不能跑交互式程序。Web 编辑器不拦截 `!`。命令行上的可选首条提示始终是用户消息。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

`tests/bench.ts` 持有伪 `Terminal` 与脚本化的会话宿主；用它的 `type()` 输入按键，用 `text()` 读取渲染文字（后者会剥离 CSI、OSC 与 APC 序列），并从 `hostCalls` 与 `opened` 读取切换做了什么。pi-tui 把渲染节流到每 16 ms 一帧，因此测试在读取屏幕前通过 `settle()` 等待。命令读取的服务（`sessionTitle`、`attachments`、`authorization`……）经 bench 的 `before` 钩子以窄桩提供。

</details>
