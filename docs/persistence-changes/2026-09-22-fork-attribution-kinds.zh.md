---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-22-fork-attribution-kinds

[English](2026-09-22-fork-attribution-kinds.md) | 中文

## 概述

记录终端、续接、提醒与工作状态通知的归因类型，并与 retry 消息来源一同记录。本次转换以 Timeline 优先级通知记录为基础，该记录是两份记录都变更的每个根的前一版本。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-22-fork-attribution-kinds
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "6a741cea1919b7178b2e30d38ef1814da4af9e979bc70c093f54380a5c60ab5f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "94ed843642dbeb1b02c6a35e0d5bb96c071a48283a9de74b30fa2d6cb5d669d5"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "b5de2f0370e8ccce85c00e24cfa966aba660ecf6f403a28241a2f1b5637c950b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "f80605cc21b9b582b68e2e816b20f0d8390425665971840b4881e4d00aef0b0a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有的 `retry` 与更早的消息记录仍可读取，Session header 保持 V4。每个新增类型都是带有 `@persistenceAttribution` 限定的、仅用于归因的 `MessageSourceMap` 条目。不具备其生产者的读取方会保留该类型以及 `form`/`summary` 元数据，并依据内容推导消息，不做归因专属的校验、回放或权威投影。生产者只为避免重复注入同一通知而读取自身类型。写于 Timeline 优先级通知之前的记录，以及之后缺少这些类型的记录，都按同一规则读取。

<a id="verification"></a>
## 验证

合并后的树上，携带 `@persistenceAttribution` 标记的八个包的测试套件全部通过：no-progress-reminder、goal-round-driver、compaction-basic、tmux-context、action-cards、user-questions、working-directory 与 tui-app。共 111 个文件、1976 项测试通过，另有一项既有的跳过。

<a id="dev-note"></a>
## 开发备注

无。
