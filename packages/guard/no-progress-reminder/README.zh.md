---
description: "建议性循环卫生 guard：当 agent（智能体）在目标进行中连续若干轮次未改动文件时提醒模型，供选择、配置或排查此插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-no-progress-reminder

[English](README.md) | 中文

## 概述

使用本包，在模型于目标处于 active 时把整轮花在复盘、skill（技能）或待办上却不改动任何文件时提醒它。经过配置数量的空闲轮次后，下一步会收到一条点出该计数的通知，要求 read、edit、write 或 bash 调用，或说明阻塞原因。通知只是建议，绝不会阻止工具。continue 不会清零计数；只有成功的变更类工具，或被清除、已完成的目标，才会清零。`dsh` 基础组合包默认在 Cursor 订阅路由（`provider: cursor`）上于五个空闲轮次时启用它。

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

当 Cursor 订阅模型上长时间、目标驱动的会话应当自行发现自己在复盘、skill 或待办上循环且未改动文件时，挂载此插件。`dsh` 基础组合包已经为 `cursor` 路由运行它；想在其他路由上、更早、更晚或在没有当前目标时收到提醒时，调优下面的空闲轮次、变更类工具模式、目标要求或 `providers` 列表即可。

### 何时选择

当模型朝着一个持续目标工作很多轮、且你想打破的失败是只有记账而没有树变更时，选择它。当空闲分析合理且必须不受打扰地运行时，以及变更通过默认 `edit`／`write`／`bash` 列表之外的工具名发生时——这些名称可配置，但漏掉的模式会继续计数——避免使用它。

### 设置空闲次数与变更类工具

想改变通知何时触发或哪些成功工具会清零时，用配置挂载插件：

```yaml
- name: '@deepseek-ai/dsh-no-progress-reminder'
  config:
    idleTurns: 5
    mutatingTools: [edit, write, bash]
    requireGoal: true
    providers: [cursor]
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `idleTurns` | `5` | 没有成功变更类工具时，触发通知的完整轮次数 |
| `mutatingTools` | `['edit', 'write', 'bash']` | 成功调用会重置计数的工具名 `*` 通配模式 |
| `requireGoal` | `true` | 仅在 goals 服务存在且该 agent 的目标为 `active` 时计数并注入 |
| `providers` | `['cursor']` | 参与的提供方路由；空列表不匹配任何路由。默认是 Cursor 订阅路由 |

无效的 `idleTurns` 会在启动时以清晰错误失败——非整数或小于 1 的值——绝不会静默改变行为。当 `requireGoal: true` 且缺少 goals 服务或 agent 不在注册表中存活时，调用时为空操作，而不是抛出错误。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-no-progress-reminder)记录每个受支持的值。

### 你会得到什么

按默认值，在 active 目标下连续五个完整轮次没有成功的 `edit`、`write` 或 `bash` 调用的 Cursor 订阅模型，会在下一步收到通知，点出该空闲计数，并要求它 read、edit、write 或 bash，或说明阻塞原因。DeepSeek 或 pi-ai 目录路由不会收到该通知。之后仍无变更的空闲轮次会再次收到通知（每轮一次）。用户 continue 不会清除这笔债。成功的变更类工具，或被清除、已完成的目标，会重置计数。通知作为归属于插件的附加用户消息出现。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释 guard 如何统计空闲轮次并投递通知，并指出实现它的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

guard 建立在四项承诺之上：

- **仅建议，不否决。** guard 在 `agent/pre-step` 上追加一条带来源的用户消息；它从不阻止或改写工具调用。
- **按完整轮次计数。** 检测在 `turn/end` 上递增，因此一轮中的多个记账工具仍只算一次空闲轮次。
- **仅在变更或目标结束时重置。** 名称匹配 `mutatingTools` 的成功 `tools/post-execute`，或操作为 `clear` 或 `complete` 的 `goal/change`，会将计数清零。用户类消息不会。
- **加载时快速失败。** `idleTurns` 在 `apply` 中校验并抛出错误，绝不在监听器内部回退到隐藏默认值。

### 检测：空闲轮次计数器

每个 agent 的计数器保存在 `WeakMap<Agent, IdleState>` 中。

- **目标门控。** 当 `requireGoal` 为 true 时，仅当 `ctx.get('goals')` 存在、该 agent 是注册表中的存活实例、且 `goals.get(agent)` 的 phase 为 `active` 时才计一轮。缺少 goals 服务或非存活 agent 则什么也不做。当 `requireGoal` 为 false 时，每一轮都符合条件。
- **变更会重置当前轮。** 匹配且成功的调用会标记未结束的轮次，使其随后的 `turn/end` 不再递增。
- **未匹配的工具对计数透明。** `todo_write`、`skill`、`get_goal` 以及任何不在 `mutatingTools` 中的名称既不重置也不阻止计数。
- **失败的变更类调用不重置。** 只有 `isError === false` 才会清除这笔债。
- **按 agent 分键。** 一个 agent 的空闲过程绝不会触发另一个 agent 的通知。
- **仅驻留内存。** 从持久化恢复的会话以全新计数器开始。

### 通知传递

通知随 `agent/pre-step` 作为附加用户消息传递（来源为 `{kind: 'plugin', plugin: 'no-progress-reminder', form: 'notice', summary: 'no progress'}`）。在连续 `idleTurns` 个已计数轮次之后，下一轮的第一次 pre-step 会收到通知；同一轮的后续步骤不会。之后的空闲轮次会用更新后的计数再次注入。guard 始终通过 `next()` 委派，并且只把通知追加到 `enter` 决策上。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、快速失败校验、空闲轮次监听器 |
| — | 不发布运行时不变式配套组件；空闲轮次链私有于一组监听器，且不公开任何可供独立配套组件观察的包自有事件或快照。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从工具 waterfall（瀑布式事件）与目标服务逐步进入 guard 组映射。

- [工具子系统参考](../../../docs/subsystems/tools.zh.md)——本 guard 消费的 `tools/post-execute` waterfall 与 `agent/pre-step` 决策。
- [目标服务](../../goal/goal/README.zh.md)——当 `requireGoal` 为 true 时本 guard 读取的可选 `ctx.goals` 查找。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-no-progress-reminder)——从插件 schema 收集的受支持配置字段。
- [guard 组映射](../README.zh.md)——同组的 guard 包与循环卫生家族。

-----

<a id="model-experience"></a>
## 模型体验

### 空闲进展上下文消息

#### 模型看到什么

在连续 `idleTurns` 个已计数轮次且没有成功的变更类工具之后，对应 agent 会在下一步收到下面的通知。不会添加工具 schema 或正常调用文本。

##### 空闲进展通知

```markdown
No file has changed in <N> turns. Your next tool call must be read, edit, write, or bash, or explain what blocks you.
```

#### Token 影响

达到阈值前为零 token。每条通知都会作为该 agent 的历史记录保留；`<N>` 是注入时已计数的空闲轮次总数。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明 guard 何时不合适。它们是当前包约束，不是任务积压。

- **仅驻留内存**——恢复的会话以全新计数器开始，因此空闲债不能在进程重启后保留。
- **仅提供建议**——通知绝不阻止工具调用，也不强制使用变更类工具。
- **read 不会重置**——成功的 `read` 不在默认 `mutatingTools` 列表中，因此仅检查仍会保留这笔债。
- **用户 continue 不会重置**——新的用户类消息不会改变计数。
- **压缩（compaction）不会重置**——跨越压缩检查点的计数器会继续计数。
- **不跨 agent 共享**——父 agent 与其 subagent 保持独立计数器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和包代码为准。

无。

</details>
