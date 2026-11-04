---
kind: upgrade-guide
description: "TUI 以标准 subagent 身份、任务工具和受管理的已保存子级继续执行，替代实验性 Team 成员关系与委派。"
---

# TUI 中的 Agent Teams 使用标准 subagent

[English](guide.md) | 中文

## 变更

随附 TUI 通过基础组合开启 Team 模式，取代已停用的 `@deepseek-ai/dsh-experimental-agent-team-profile` 组合包。`/team on` 与 `/team off` 保存根 Session 的选择；关闭 Team 保留子级和任务。这些 TUI 命令继续可用，不依赖 Web 会话菜单。

Teammate 是标准 subagent 目录中的可继续条目。TUI 显示其相对于根的名称和任务描述；较早的无名条目使用标签。Team 专属创建与模型发现由 `subagent`、`subagent_fork` 和 `list_subagent_models` 取代。共享任务工具按名称指定负责人，也接受 Session id 作为回退。

打开已保存子级只读取其对话，不恢复 Agent。继续执行使用受管理的 subagent 提示操作，恢复已保存的 preset、权限和所有权。TUI 子级继续执行提示只接受文本；普通根会话仍可使用附件。参见 [TUI 参考](../../../../packages/bundle/tui-app/README.zh.md)。

## 迁移

1. 从自定义 profile 选择与 overlay 中移除已停用的实验性 Team 组合包。使用随附 `tui` profile；自定义组合使用 `@deepseek-ai/dsh-agent-team`、`@deepseek-ai/dsh-tool-agent-team` 与标准 subagent 插件。
2. 将 `spawn_teammate` 替换为 `subagent` 或 `subagent_fork`，并保存返回的 agent 名称。将 `list_teammate_models` 替换为 `list_subagent_models`；显式路由使用独立的 `provider`、`model` 及可选的 `reasoning_effort` 字段。
3. 对消息接收者和任务负责人使用启动回执或 `list_agents` 中的名称；已有的 Session id 仍可使用。为每个子级提供任务描述，并可选地指定名称。工具参数变更参见 [subagent 名称升级指南](../subagent-names/guide.zh.md)。
4. 恢复根 Session，通过 `/team` 或 `/team-play` 查看已保存子级，并提交文本继续执行。确认回复出现，且父级目录仍保留该子级。先执行 `/team off`，再执行 `/team on`，确认已保存任务仍然存在。
