# Agent Note: 在 TUI profile 中随附 Auto review

Status: implemented

[English](2026-09-24-tui-auto-review.md) | 中文

## Problem

[Auto review](2026-08-28-auto-review.zh.md) 是可选的 Web bundle。终端有同样的权限选择器与审批提示，但原样的 TUI profile 不会挂上这一层，而且在终端输入的 prompt 是没有 `rpcId` 的 `source.kind === 'user'`，reviewer 不会把它当作人的指令。

## Decision

随附的 `tui` 模板在 `dsh-base` 与 `dsh-tui-app` 之后选中 `@deepseek-ai/dsh-experimental-auto-review`。bundle 列表仍恰好是这两个名字的 profile 在下次加载时改写为该模板；其他列表保持原样。Web、Headless、通用设置与新会话默认值仍然不包含这一层。默认产品隔离只在 TUI 模板是该可选 bundle 的唯一随附选择时放行它。

人从终端提交的每个 prompt 都存 `{ kind: 'user', rpcId }`，并使用一个新 id。Auto review 的既有检查把该 id 当作人的指令。被修改的草稿保留非 user 来源。Child 创建 prompt 仍然没有 `rpcId`。

## Alternatives considered

**继续只通过 `/plugins enable` 选用 Auto review。** 终端已经能打开这个 bundle，但安装后的原样 profile 没有这个模式，而且输入的指令仍然不能授权中等风险调用。

**把每个 `{ kind: 'user' }` 来源都当作人的指令。** Headless 与 child 创建 prompt 使用该来源，它们必须仍是事实或直接父级指令。

## Consequences

- 原样 TUI profile 的 `/permission` 会列出 Auto review。选中它只切换当前会话；未来会话的默认值仍然不包含它。
- 已经另加过 bundle 的原样 profile 不会获得 Auto review，直到其 bundle 列表包含该包。
- 终端 prompt 可以授权一次中等风险调用。此 id 出现之前记录的 prompt 不能。

## Related decisions

- [Auto review](2026-08-28-auto-review.zh.md) — 权威、生命周期与 `rpcId` 检查。
- [可选 bundle](../architecture/2026-09-21-experimental-capabilities-as-optional-bundles.zh.md) — Web 仍从插件页开启这一层。
