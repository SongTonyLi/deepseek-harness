---
description: "面向用户文本的凭据识别与显示遮蔽，由终端与浏览器共用：基于公开凭据格式的线性扫描器，以及它绘制的遮蔽文本。"
kind: "package-library"
---

# @deepseek-ai/dsh-util-credential-mask

[English](README.md) | 中文

## 概述

调用方可以按公开凭据格式识别用户文本中的凭据，并在不引入 UI 插件的情况下以遮蔽形式绘制。遮蔽文本保留换行与每个服务商前缀，输入文本从不被修改，因此复制、导出与模型请求仍使用原文。本包没有运行时依赖。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 为显示遮蔽文本

`createCredentialMasker()` 返回 `CredentialMasker`，其 `mask(text)` 返回 `text` 的显示形式：服务商密钥保留前八个字符，其余替换为 `MASK`；携带凭据的地址中的密码整体遮蔽；私钥块保留首行与末行。所有者创建一个遮蔽器并将其传给绘制文本的代码；每个遮蔽器拥有自己的扫描器，并保留它最近绘制的文本，直到绘制另一段文本。

```ts
import { createCredentialMasker } from '@deepseek-ai/dsh-util-credential-mask'

const masker = createCredentialMasker()
const sample = `sk-${'0123456789abcdef'.repeat(2)}`
// The first eight characters of the key stay readable; the rest mask.
const shown = masker.mask(`use ${sample} for the call`)
```

### 扫描凭据

`new CredentialScanner(formatTables())` 通过 `match(text, from)` 返回位于偏移量或其之后最近的凭据。每个节点携带原文的 `start` 与 `end` 以及显示形式 `data.masked`。扫描器在返回节点之前不分配内存，并记住最近查询的文本，因此对同一文本的查询共享工作。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`formatTables()` 从公开的凭据格式推导独立的查找表。每个扫描器所有者创建一次查找表，并通过扫描器复用。每个格式检查都是有界的字符比较，或在首个类外字符处停止的粘性 `[class]*` 匹配，因此没有任何格式会回溯。仅含字面量的交替式用于找到格式可能开始的位置，扫描会在可能与下一个字面量重叠的字面量内部继续。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `createCredentialMasker()`、`CredentialMasker` 与包导出 |
| [`src/credential-formats.ts`](src/credential-formats.ts) | 公开的凭据格式及其字符类 |
| [`src/format-tables.ts`](src/format-tables.ts) | 从格式推导的查找表 |
| [`src/credential-scanner.ts`](src/credential-scanner.ts) | 返回最近凭据范围的线性扫描器 |
| [`src/credential-masks.ts`](src/credential-masks.ts) | 凭据范围的显示形式，由共享标记字符串构成 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具包地图](../README.zh.md) — 相邻的无状态辅助模块。
- [客户端 secret 规则](../../client/ui-secret-mask/README.zh.md) — 包装本扫描器的浏览器 `secret` 用户文本规则。
- [凭据匹配性能](../../../.agents/notes/implemented/testing/2026-10-11-user-text-credential-matching.zh.md) — 线性匹配器及其时间与分配门禁。

-----

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **识别基于格式** — 没有公开格式的自由形式密码与 `name=value` 赋值保持原样。
- **备忘录只保留一段文本** — 遮蔽器或扫描器会保留它最近查询的文本，直到查询另一段文本。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
