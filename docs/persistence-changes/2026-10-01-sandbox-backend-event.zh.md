---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-01-sandbox-backend-event

[English](2026-10-01-sandbox-backend-event.md) | 中文

## 概述

新增仅记录在日志中的 `sandbox/backend` 会话事件，用于记录 `/sandbox` 在 Apple container 与本地沙箱后端之间的切换。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-01-sandbox-backend-event
baseline: false
changes:
  - root: "event:sandbox/backend"
    previous: null
    after: "d4625f12f4753a49ecbd0822fb534207e5d087be05992290cd7eedf23812a9d3"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

现有日志不包含 `sandbox/backend` 事件，回放结果不变，并使用配置的默认后端。该事件在读取时为必需事件，因此与任何新事件类型一样，早于本变更的构建会拒绝包含它的日志。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/sandbox/sandbox-apple-container：58 个测试通过，包括 /sandbox 切换及其投影出的后端。

<a id="dev-note"></a>
## 开发备注

无。
