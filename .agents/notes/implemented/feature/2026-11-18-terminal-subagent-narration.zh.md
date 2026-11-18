# Agent Note: Subagent progress narration in the terminal profile

Status: implemented

[English](2026-11-18-terminal-subagent-narration.md) | 中文

## 问题

终端的 activity board 为每个运行中的 subagent 画一行。每一行在子级任务标签旁显示子级最新 assistant 消息的最后一句，而这句话只有在模型于工具调用前写了文字时才存在，因此看板需要一条能送达每个终端子级的指令。Web、headless 与 SDK 子级不会画出看板。

这条指令最初放在 `SUBAGENT_DELEGATION_CONTEXT` 中，即每个进程内子级都携带的声明。上游维护这段声明，并为它增加了消息作者身份的句子，同步把这些句子带入了本分支；叙述句子不在这段共享声明之中。

## 决策

叙述句子是一条仅终端使用的运行时上下文条目，名为 `tui:subagent-narration`。`tui-app` 监听器在每个 `agent/created` 事件中为委派深度大于零的 agent 注册它，因此每个进程内子级（spawn 与 fork 一样）都会收到该条目。顶层 agent 与 `/btw` 旁路 agent 的委派深度为零，不会收到该条目。agent 被 dispose 时监听器移除该条目，插件被 dispose 时也会移除。该条目与委派声明一样属于子级的运行时上下文快照，因此子级的 Session 日志会记录它。

该条目的排序位置是 `SUBAGENT_DELEGATION` + 0.5（120.5），紧跟在 `subagent:delegation` 声明之后。`SUBAGENT_DELEGATION` 为 120，实验性 timeline 的 `timeline:maintenance` 上下文使用整数 121。句子的措辞与[此前的决策](2026-10-23-subagent-progress-narration.zh.md)相同。该句子不属于 `SUBAGENT_DELEGATION_CONTEXT`，后者只陈述委派范围与消息作者身份。

## 考虑过的替代方案

**每个子级都在 `SUBAGENT_DELEGATION_CONTEXT` 中保留这句。** 否决：这正是被取代的决策。只有终端会画看板，因此 Web、headless 与 SDK 子级会在没有看板可画的情况下写出这句话，而由 fork 添加的文字会位于上游维护的声明之中。

**在 subagent 插件中加一个运行时配置字段。** 否决：仅终端使用的开关会把终端专属行为放进共享的 `@deepseek-ai/dsh-subagent` 包，并要求子级组合把该字段一路传递下去。监听器把该条目保留在终端所属的包中。

**在 `dsh-system-prompt` 中给出具名位置。** 暂缓：具名的运行时上下文位置会取代半个顺序位。在它存在之前，半个顺序位就是已记录的位置，[终端 README](../../../../packages/bundle/tui-app/README.zh.md) 对此有记录。

## 验证

- `packages/bundle/tui-app/tests/subagent-narration.spec.ts` 覆盖位置与接收者：进程内子级在 `subagent:delegation` 之后直接收到该条目，顶层 agent 与 `/btw` 旁路 agent 都不会收到，释放子级或整个安装都会移除该条目。
- `packages/bundle/tui-app/tests/subagent-narration-loader.spec.ts` 通过 Loader 从仅供测试的 `cordis.yml` 启动插件，并驱动父级的 `subagent` 工具调用：子级的第一条模型请求在其委派声明之后携带该句子；不应用该条目的同一流程则不携带。
- `packages/subagent/subagent/tests/activation-policy.spec.ts` 检查子级运行时上下文中的委派声明；它不引用叙述句子。
- `snapshots/` 下录制的子级 Session 与 `apps/cli/tests/profiles/headless/tests/expected/` 下的预期子级日志都不含叙述句子，因此它们通过 `pnpm run test:snapshot` 与 `pnpm run test:expected` 的无密钥回放不包含该句子。
- 由于环境中没有 `DEEPSEEK_API_KEY`，无法用真实模型进行人工 TUI 运行。

## 影响

- Web、headless 与 SDK 子级不进行叙述。[升级指南](../../../../docs/upgrade-guide/v0.2.2-rc.4/child-progress-narration/guide.zh.md)说明了读取子级最新句子作为进度的宿主如何迁移。
- 终端看板保留每个运行中子级的一行。跳过该句子的子级只显示标签。
- 由终端 profile 启动的每个子级，其第一份运行时上下文快照多约 30 个 token，只写一次且前缀稳定；父级的请求不变。
- 子级的结果仍是它最后一条非空 assistant 消息，因此只有当叙述句子是最后的文字时，它才会成为结果。
- 半个顺序位（120.5）是已知限制；具名的 `dsh-system-prompt` 位置会取代它，该位置目前暂缓。
