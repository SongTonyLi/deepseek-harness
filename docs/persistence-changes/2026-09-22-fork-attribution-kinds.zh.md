---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-22-fork-attribution-kinds

[English](2026-09-22-fork-attribution-kinds.md) | 中文

## 概述

记录终端、续跑、提醒与工作状态提示的归属 kind。

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
    previous: "2026-10-05-working-directory-attribution"
    after: "3657a134850d96e4ca1c9f54bae79a5bb8f6b40eea412d8f5f362c6e9292d3bb"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "9ba59a2a9237a9f5eebb860f46c08c1f5f719d26712ee8579eda8bf885bc7838"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "e8597919599b39fdd41b62528bdfa009817050cc821d109982b408a773b9844b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "bbc82c00f7d5080f24f5038c38ef9502030af02572d1c1deb47c6be43f7e39ab"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新增的每个 kind 都是 user 或 developer 源槽位上仅表示归属的 `MessageSourceMap` 条目，并以 `@persistenceAttribution` 限定。既有记录的 kind 保持不变，Session header 仍为 V4。缺少该生产者的读取器会保留 kind 及其 `form`/`summary` 元数据，仅凭内容还原消息，无需任何校验、回放或授权投影；只有生产该 kind 的插件会读取自身 kind，用于避免重复注入同一条提示。

<a id="verification"></a>
## 验证

各生产者插件的单元测试断言每条注入提示上记录的 source；终端转录测试仅凭记录的 kind，就把无所属插件的提示绘制为注入上下文。

<a id="dev-note"></a>
## 开发备注

无。
