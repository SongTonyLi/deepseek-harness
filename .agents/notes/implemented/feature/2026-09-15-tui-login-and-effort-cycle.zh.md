# Agent Note: TUI `/login` and Shift+Tab effort cycling

Status: implemented

[English](2026-09-15-tui-login-and-effort-cycle.md) | 中文

## Problem

终端已有 `/signin`，会提供流程声明的每一种授权方法，包括收集密钥的 `api-key` 登录；Models 卡片会隐藏这些方法，因为卡片本身已有密钥字段。想从 `dsh tui` 使用订阅支持的模型访问的用户，没有与该卡片对齐的命令。更改推理强度需要 `/model` 再加一次选择，即使只需移动已选模型的强度。

## Decision

`/login` 是与 `/signin` 并列的终端本地命令。它只列出并启动订阅方法：id 不是 `api-key` 的每一种方法，与 Models 卡片使用的判定相同。`/signin` 仍提供流程声明的每一种方法，包括空方法列表。只收集密钥的流程不会出现在 `/login` 中；以 `/login <key>` 指名它会报告没有订阅登录。

Shift+Tab 在编辑器之前被消费，把绑定的 `ModelSelectionRef` 沿当前模型由 `llm.resolveModelInfo` 给出的适配器自有强度向前推进一步，并在提供方默认值（无 `reasoningEffort` 字段）处回绕。强度少于两种的模型除通知外不改变选择。快速连按会串行化，使每次循环看到上一次选择。该更改从下一次请求起生效，不会写为已保存的默认值；`/model save` 仍是显式持久化。

## Alternatives considered

**让 `/signin` 只提供订阅，或把 `/login` 做成纯别名。** 不采用，因为现有 `/signin` 测试与流程包含 `api-key` 和空方法列表；合并会去掉仍可用的收集密钥路径。`/login` 是订阅命令；`/signin` 仍是通用命令。

**在 Shift+Tab 上打开 `/model` 的强度选择器。** 不采用，因为需求是就地更改当前模型的强度。循环已解析的强度列表符合该需求，而 `/model` 仍是更改提供方/模型的方式。

**从 Web 登录包共享 `isSubscriptionMethod`。** 不采用，因为终端不得导入 client 插件。该判定就是已文档化的 `api-key` id 规则，在 `/login` 旁重述。

## Consequences

- 终端上的订阅登录不会再提供一处粘贴 Models 卡片已经收集的同一 API 密钥的路径。
- 没有组合 LLM 目录或当前路由无法解析时，强度循环会明确失败；它不会发明一套强度词汇。
- 包级测试在伪终端上覆盖 `/login` 过滤与 Shift+Tab 循环；它们不会通过 `/model save` 持久化循环得到的强度。

## Related decisions

终端表层、`/signin` 与 `/model` 强度选择器仍由 [作为随附 `tui` profile 的终端表层](../architecture/2026-09-15-terminal-surface-tui-app.zh.md) 持有。
