---
kind: upgrade-guide
description: "原样 tui profile 挂载 Agent Teams，此前的两份组合包列表会改写为该模板。"
---

# 原样 tui profile 挂载 Agent Teams

[English](guide.md) | 中文

## 变更

原样 `tui` profile 此前不挂载 Agent Teams。随附模板现在在 `@deepseek-ai/dsh-experimental-auto-review` 之后追加 `@deepseek-ai/dsh-experimental-agent-team-profile`。下次启动时，`dsh.profile.bundles` 恰好是 `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui-app']`，或该列表再加上 `@deepseek-ai/dsh-experimental-auto-review` 的 profile，会被改写为该模板。其他列表保持不变。Web、headless、SDK 与 ACP 模板不会获得这个组合包。

该组合包禁用 `subagent`、`subagent_fork` 以及名称重叠的全局 child control，并加入 `spawn_teammate` 与 Team 任务工具。

## 迁移

1. 若要保留原先的工具，从 `$DSH_HOME/profiles/tui/package.json` 的 `dsh.profile.bundles` 中移除 `@deepseek-ai/dsh-experimental-agent-team-profile`。
2. 用 `dsh tui` 启动确认。空会话的起始卡片写着 `Agent Teams is on`，说明 lead 与 teammate 各做什么，并给出 `/plugins disable @deepseek-ai/dsh-experimental-agent-team-profile`。`/team-play` 打开团队室：每名成员的角色与当前工作、共享任务，以及成员之间的消息；`Enter` 打开所选 teammate 的会话，`f` 把消息收窄到该成员，`Esc` 关闭团队室。移除了该组合包的 profile 没有起始卡片，`/team-play` 报告 `Agent Teams are not enabled in this composition`。
