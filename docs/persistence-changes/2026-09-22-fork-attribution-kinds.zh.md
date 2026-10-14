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
    previous: "2026-10-13-user-rpc-principal"
    after: "8f46cfe00d9b7cef2188da411a30d9088ab0a376ba36f523839c48e5375adc6f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "b3e4411741ee4e0ec5ce40eb2054bac73e66c4586161748c3896ddbf41a0eac1"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "a4ccffb0fe337434bfbc4d054d092e0a97c0bbf2049b3a893e75e2434b3a77c1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "ecff517267d800dd81577a288bf654e14272d2eef1d00003fdb77144cd1b079d"
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
