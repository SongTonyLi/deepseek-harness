# Agent Note: Syntax colour for shell-mode drafts and `$ command` rows

Status: implemented

[English](2026-09-22-tui-shell-syntax-colour.md) | 中文

## Problem

终端已经用同一个 shiki core 为围栏代码以及 `read` 或 `diff` 卡片的文件行着色。`!` / `!!` 草稿——人写下命令的另一处——却仍是同一种颜色：bang、标志、字符串与路径，和普通提示用的是同一个前景色。提交之后，对话记录里的 `$ command` 行以及终端工具卡片上的命令也是同一种灰。shellscript 语法早已在表中；这些行没有去问它。

## Decision

同一个高亮器为 shell 草稿和 `$ command` 行着色。启动时没有新的加载。第一个抵达渲染的 `!` 会请求 `shellscript`；那一帧把 bang 画成警告色、命令仍是纯文本，语法落地后让对话记录失效并再次请求这一帧。

**编辑器覆盖是对已渲染行的变换。** pi-tui 的 `Editor` 没有高亮钩子，而编辑器状态就是用户将要提交的文本。`BarCursorEditor.render` 仍先去掉块状光标，随后 `paintShellEditorLines` 在内容行上着色：缩进保持原样，`!` / `!!` 使用 `palette.warning`（与 shell 模式边框同一角色），命令使用 `highlight.lines(..., 'shellscript')`。`CURSOR_MARKER`、内边距、顶底边框以及自动补全列表保持原样。若某段着色后的可见宽度与纯文本不同，或滚动之后无法匹配，该段保持纯文本。ANSI 从不进入 `setText`。

**对话记录的 `$ command` 行是一个 `CodeSpan`。** `UserShellBlock` 通过 `paintCodeRows` 绘制已完成的运行，因此提交之后落地的语法仍会给命令重新着色。输出行保持无色。终端工具卡片把 `$ ${title}` 放进调用正文并带上同一段 span，于是模型即将运行的命令与用户键入的命令使用同一套颜色；页眉上暗色的标题仍是标题。

## Alternatives considered

**为编辑器高亮钩子而分叉或修补 pi-tui。** 已否决：光标子类已经为了一个单元拒绝过分叉，而一个高亮钩子会以同样的理由把换行、粘贴标记与自动补全都接过来。

**把 ANSI 写进编辑器文本。** 已否决：光标、词移动、提交与历史都读取那段文本。着色后的字节会错位，并泄漏进 `ctx.shell`。

**把 shell token 映射到调色板角色上。** 已否决，理由与[围栏代码的语法高亮](2026-09-19-tui-syntax-colour.zh.md)相同：调色板是语义化的，语法不是。

**等语法就绪再画第一帧。** 已否决：用户正在看的草稿会一直是纯文本，直到某个无关按键。高亮器已经会自己请求这一帧。

**给终端卡片的标题着色，而不增加正文行。** 已否决：页眉已经用 `palette.dim` 包住标题，那会冲掉主题颜色，而卡片正文才是 `paintCodeRows` 已经拥有的路径。

**用只出现在正文中的命令替换标题。** 已否决：页眉会丢掉折叠与检视面板已经用来命名该调用的那条命令。

## Consequences

- 一次会话的第一个 `!` 会开始导入 shellscript。从未键入 `!`、也从未渲染 `shell` / `bash` 围栏的会话仍然不会加载它。
- 非空的终端卡片标题会多出一行 `$ command` 正文，因此折叠卡片的“还有更多行”计数加一，而读取 `call.lines` 的审批详情会显示该命令。
- 落在 token 中间的换行，或覆盖不视为原子的粘贴标记，可能让那一段保持纯文本。命令仍然可读。
- `tests/editor.spec.ts` 对照 pi-tui 自己的行钉住覆盖；`tests/blocks.spec.ts` 钉住 `UserShellBlock` 的失效；`tests/transcript.spec.ts` 钉住终端卡片的 span；`tests/stream-fade.spec.ts` 在 truecolor 工作台上钉住真实语法。

## Related decisions

高亮器、惰性加载与重绘属于[围栏代码的语法高亮](2026-09-19-tui-syntax-colour.zh.md)。先渲染再变换，与[终端竖条光标与流式文字淡入](2026-09-17-tui-bar-caret-and-stream-fade.zh.md)去掉块状光标是同一种做法。所绘入的界面是[终端界面作为随附 `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.zh.md)。
