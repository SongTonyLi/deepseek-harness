---
kind: upgrade-guide
description: "Web、headless 与 SDK 子 agent 不再收到每次工具调用前的进度叙述句；终端配置保留它。"
---

# Web、headless 与 SDK 子 agent 不再叙述工具调用

[English](guide.md) | 中文

## 变更

此前每个进程内子 agent 都会收到一条委派声明，要求它在每次工具调用前用一句简短的话说明进展，宿主因此可以显示子 agent 的进度。现在只有终端配置（`dsh --profile tui`）会添加这句话，它以运行时上下文条目 `tui:subagent-narration` 的形式存在。由 Web、headless 与 SDK 宿主启动的子 agent 不再收到它，因此其 assistant 消息在工具调用前不再包含进度句。`subagent:delegation` 声明本身没有变化。

把子 agent 最新 assistant 句子当作其进度的宿主，将看到更少的文本。子 agent 的结果仍是它最后一条非空 assistant 消息。

## 迁移

1. 如果宿主用子 agent 最新的 assistant 句子显示进度，请改为从子 agent 会话日志中的工具调用事件推导进度；或在交给子 agent 的任务中要求它报告进度。
2. 确认迁移成功：子 agent 会话日志的运行时上下文事件中不应再出现 `progress can be followed`，宿主仍应显示子 agent 的工具调用。
