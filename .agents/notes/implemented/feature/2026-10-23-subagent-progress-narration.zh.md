# Agent Note: 委派上下文中的 subagent 进度叙述

Status: implemented

[English](2026-10-23-subagent-progress-narration.md) | 中文

## 问题

终端的 activity board 为每个运行中的 subagent 画一行。该行若由子级的工具调用与结果生成，读起来是 `calling read · 1| /** … */`：说明跑了哪个工具，却没说子级在为它的任务做什么。子级的 assistant 消息只有在模型于工具调用前写了文字时才带有这类信息，而此前没有任何东西要求它这样写。

## 决策

`SUBAGENT_DELEGATION_CONTEXT` 末尾多了一句：`Before each tool call, say in one short sentence what you are doing and why it serves the task, so your progress can be followed.` 它搭载在已有的 `subagent:delegation` 运行时上下文贡献上，因此每个进程内子级（spawn 与 fork 一样）都在自己被记录的上下文中带有这句，部署的 system prompt 在父级与子级之间保持一致。

这句话不提任何界面。它要求与任务相关的叙述，任何跟踪子级的宿主都能从同样的 assistant 消息里读到。终端把子级最新 assistant 消息的最后一句画在子级任务标签旁（[终端 README](../../../../packages/bundle/tui-app/README.zh.md)）。子级的结果不变：父级收到的仍是最后一条非空 assistant 消息。

## 考虑过的替代方案

**只在终端 profile 中加这句。** 否决：这需要给 subagent 运行时新增一个配置字段，并把它一路接到子级组合里，才能让 headless、web、ACP 与 SDK 子级保持原文。这句话在每个子级本来就携带的上下文里只有约 30 个 token，而且叙述并不是终端独有的需求。

**显式的进度工具。** 暂时否决：它的说明总是与任务相关，但要给每个子级的 schema 加一个工具、每次更新一次调用，还要一条使用它的提示词指令。

**用旁路模型概括子级最近的活动。** 否决：为了状态文字引入模型成本、延迟，以及对提供方和配置的依赖。

**子级没写文字时画出它的推理。** 否决：推理是草稿，常常很长，也不是对子级做了什么的陈述。

## 验证

- `packages/subagent/subagent/tests/activation-policy.spec.ts` 断言子级的运行时上下文带有这句，而它的 system prompt 不带。
- `snapshots/` 与 `apps/cli/tests/profiles/headless/tests/expected/` 下每份带有委派声明的已录制子 Session 与预期子日志都带有这句，并在 `test:snapshot` 与 `test:expected` 中通过随附 profile 回放。保留的历史代际保持原文。
- 与[结束本轮指导](../bug-fix/2026-10-21-subagent-end-turn-guidance.zh.md)不同，没有受控探针测量模型遵循这句的频率。跳过它的子级只画出标签。

## 影响

- 每个子级的第一份运行时上下文快照多约 30 个 token，只写一次且前缀稳定；父级的请求不变。
- 子级会在工具调用前写一句文字。它出现在子级的对话记录与会话视图里，只有当它是最后一条非空 assistant 消息时才可能成为子级的结果。
- 忽略这句的模型，其终端行停留在标签与旋转指示。
