# Agent Note: 智能体自行 resume 已暂停的 goal

Status: implemented

[English](2026-11-12-agent-resume-paused-goal.md) | 中文

## 问题

paused goal 以前只能从 goal 栏或 `/goal resume` 恢复。即使当前轮次已经包含人类直接消息，`update_goal` 的 `resume` 仍会以 `GOAL_TOOL_RESUME_PAUSED` 拒绝该阶段。精确的 continue 短语会让 goal 保持暂停，并告诉模型它没有被 resume。人必须先使用另一个控件，智能体才能继续该目标。

## 决策

人类直接轮次可以通过 `update_goal` 的 `resume` 恢复 paused goal，并使用与 pause 和 edit 相同的实时 agent 与人类直接消息检查。没有人类直接消息的 Goal Round 仍然不能 resume。Web 与 `/goal resume` 仍然可以恢复同一个 goal。

精确的 continue-intent——`@deepseek-ai/dsh-goal-round-driver` 已经识别的封闭短语——会 resume 仍有 Round 额度的 paused goal，将其启用，并追加现有的已 resume 通知。没有剩余 Round 的 paused goal 保持暂停且不产生通知，与已耗尽额度的 active-disarmed goal 相同。该短语不会重新启用 blocked 或 complete 的 goal。

goal 系统提示词保持不变。它仍然告诉模型：当人类要求继续时，重新启用 disarmed goal，并且不点名 paused goal。本决策只取代[面向模型的 goal 工具决策](../feature/2026-07-19-model-facing-goal-tools.zh.md)中对 paused resume 的拒绝。自主 Round 仍然不能 edit、pause 或 resume 一个 goal。

## 考虑过的替代方案

**让自动 Goal Round 在没有新的人类消息时 resume paused goal。** 不予采纳，因为暂停本应停止的续行就会把暂停自己撤销。

**只对精确的 continue 短语 resume paused goal，并继续拒绝 `update_goal`。** 不予采纳，因为 pause 和 edit 已经接受任何人类直接轮次，由模型判断措辞是否在要求继续。

**在系统提示词中点名 paused goal。** 本次变更不予采纳。提示词文本及其固定的 sidecar 保持原样；执行接受 resume，continue-intent 通知也已经说明某个短语是否 resume 了 goal。

## 测试

`packages/goal/tool-goal/tests/tool-goal.spec.ts` 在同一人类轮次和稍后的人类轮次中 resume paused goal，并拒绝没有人类消息的 Goal Round 中的 resume。`packages/goal/goal-round-driver/tests/goal-round-driver.spec.ts` 在用户说出 `continue` 时 resume 仍有剩余 Round 的 paused goal，然后接纳随后的 Goal Round。blocked、complete，以及已耗尽额度的 active-disarmed continue 行为仍由现有驱动器测试覆盖。

## 后果

人类消息让模型在判断该请求是在要求继续时取消暂停。运行时不检查该消息的措辞。精确的 continue 短语会 resume 仍有 Round 的 paused goal，并且可以在不使用单独控件的情况下启动下一轮 Goal Round。Goal Round 仍然不能自行 resume paused goal。
