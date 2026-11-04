---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-22-fork-attribution-kinds

[English](2026-09-22-fork-attribution-kinds.md) | 中文

## 概述

在 `retry` 消息源之外记录终端、续跑、提醒与工作状态提示的归属 kind。

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
    previous: "2026-10-27-retry-control-input"
    after: "3a9f532fdce6b1065b89c210760639e13897c3b9780ae1aed38d58f1862464f8"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "c72bb925c77731c0c53faaf1c4734cf6090829c6cdcd781d23491da76d3f02a7"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "576e5323de7e752ffb4dfac8abd756976f0cfce7cbea116b77f3f654fe5755c8"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "c2574cff7c7c777baa5ee06efb5fee3e610f978642c78a0b8e08212918b16e4a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 `retry` 及更早的消息记录仍可读取，Session header 保持 V4。每个新增 kind 都是以 `@persistenceAttribution` 限定的仅表示归属的 `MessageSourceMap` 条目。缺少对应生产者的读取器会保留 kind 及 `form`/`summary` 元数据，仅凭内容还原消息，无需归属专用的校验、回放或授权投影。生产者仅读取自身 kind，以避免重复注入同一条提示。

<a id="verification"></a>
## 验证

no-progress reminder、goal-round driver、压缩、终端旁路 agent、retry 输入和 V3 到 V4 迁移的聚焦测试通过：七个文件共 279 个测试。

<a id="dev-note"></a>
## 开发备注

无。
