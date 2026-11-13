---
kind: upgrade-guide
description: "TUI 的 `/todos` 选择器改为全屏 todos 页面，显示共享任务、其负责人与子任务，以及本 agent 的 todo 列表。"
---

# TUI 中的 `/todos` 打开全屏 todos 页面

[English](guide.md) | 中文

## 变更

`/todos`、`Ctrl+T` 以及在状态栏 `todo` 分段上按 `Enter`，过去会打开 agent 自己 todo 列表的选择器，在其中按 `Enter` 显示某一条目的状态、位置、列表计数与轮次。现在它们在备用屏幕上打开 todos 页面。该页面列出每条共享任务及其负责人，并把负责人存活时的 todo 列表列为子任务，随后把 agent 自己的 todo 列表作为一个分支，每行标为 delivered、in progress、stuck、deferred 或 pending。右栏详述所选行；对于 agent 自己的 todo，仍会给出该条目首次写入的轮次与状态最后改变的轮次。选择器的随输入过滤以及条目位置与列表计数已移除。在页面上按 `Ctrl+T` 会关闭它。使用随附 `tui` profile 的用户会看到这一变化；配置、Session 数据与 SDK 均无变化。参见 [TUI 参考](../../../../packages/bundle/tui-app/README.zh.md)。

## 迁移

1. 在页面上用 `↑` `↓` 代替选择器的过滤，用 `←` `→` 折叠与展开任务，用 `Esc`、`q` 或 `Ctrl+T` 回到对话。
2. 从页面第一行 `todos · <delivered>/<total> delivered` 或 `/status` 读取条目计数。
3. 确认方法：运行一个写入 todo 的轮次，输入 `/todos`，检查第一行以 `todos · ` 开头，且 `Esc` 能回到对话。
