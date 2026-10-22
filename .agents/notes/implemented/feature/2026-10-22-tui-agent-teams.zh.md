# Agent Note: 在 TUI 模板中选中 Agent Teams

Status: implemented

[English](2026-10-22-tui-agent-teams.md) | 中文

## Problem

终端工作需要 Team 委派：持久 roster、共享任务和 `spawn_teammate`，并且来自 `dsh tui` 创建的 profile。Web、headless、SDK 与 ACP 模板保留普通 subagent 工具。`@deepseek-ai/dsh-experimental-agent-team-profile` 是实验包，因此发布包不能依赖它。

## Decision

随附的 `tui` 模板在 `@deepseek-ai/dsh-experimental-auto-review` 之后选中 `@deepseek-ai/dsh-experimental-agent-team-profile`。默认产品隔离放行这个可选组合包，因为 TUI 模板是它唯一的随附选择，而且 TUI predecessor 元组可以重复同一个组合包。bundle 列表恰好是 `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui-app']`，或该列表再加上 `@deepseek-ai/dsh-experimental-auto-review` 的 profile，在下次加载时改写为该模板。其他列表保持不变。Web、headless、SDK 与 ACP 模板不选中该组合包。

该组合包禁用 `subagent`、`subagent_fork` 以及名称重叠的全局 child control，并加入 `spawn_teammate` 与 Team 任务工具。

## Alternatives considered

**继续只通过 `/plugins enable` 选用。** 终端可以打开这个组合包，新建的 profile 于是保留 `subagent` 与 `subagent_fork`，没有 `spawn_teammate` 或 Team 任务工具。

**把服务挂进 `dsh-tui-app`。** 发布包不能依赖这个实验包。

## Consequences

- 原样 TUI 会话可以用 `spawn_teammate` 委派。
- 已经另加过组合包的 profile 不会获得这一层。
- 空的根会话会画出一张起始卡片，写明 Agent Teams 已开启，并给出 `/plugins disable @deepseek-ai/dsh-experimental-agent-team-profile`。
- `/team-play` 播放成员之间如何互相发消息。`/subagents` 仍然打开某一个 teammate 的对话记录。

## Related decisions

- [Agent Teams](2026-08-05-agent-teams.zh.md) — roster、任务、mailbox，以及本模板之外的组合。
- [在 TUI profile 中随附 Auto review](2026-09-24-tui-auto-review.zh.md) — 同一模板上先选中的可选组合包，以及同一组前序列表。
- [随安装提供可选组合包](../process/2026-09-15-shipped-optional-bundles.zh.md) — 安装名单与 TUI 选中例外。
