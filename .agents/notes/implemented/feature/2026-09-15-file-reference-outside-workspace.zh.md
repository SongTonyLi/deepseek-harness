# Agent Note: File-reference completion outside the session cwd

Status: implemented

[English](2026-09-15-file-reference-outside-workspace.md) | 中文

## Problem

`@` 补全只列出会话工作目录内的路径。`../`、`~/` 或绝对目录的查询不会返回候选，因此终端或浏览器用户无法提及兄弟仓库或当前目录之外的文件，即使宿主 `read` 工具接受这些路径。

## Decision

解析到工作区之外的目录范围 `@` 查询会即时列出该目录。插入的提及保留用户的写法（`../other-repo/file`、`~/project/file` 或绝对路径）。裸模糊查询仍只搜索有界工作区索引。最终路径为符号链接的目录仍不产生候选，无论查询从工作区内开始还是从外部点名该链接。`FILE_REFERENCE_PROMPT` 把这四种写法称为用户显式引用的路径。

## Alternatives considered

**为裸 `@` 索引父目录树或家目录。** 不采用，因为无界遍历会把私人文件放到每次空 `@` 旁边，并耗尽条目预算。

**在用户键入目录符号链接路径时跟随它。** 不采用，因为这与工作区内植入的链接是同一种逃逸；用户可以改写真实路径。

**只在终端放开围栏。** 不采用，因为 Web 与 `dsh tui` 共用 `file-reference-local`。

## Consequences

- 补全仍是提示性的：沙箱与文件系统策略决定 `read` 能否打开被提及的路径。
- 包级测试覆盖兄弟仓库 `../`、模拟家目录 `~/`、工作区外绝对路径与拒绝符号链接；它们不扫描真实家目录。

## Related decisions

终端 `@` 补全仍由 [作为随附 `tui` profile 的终端表层](../architecture/2026-09-15-terminal-surface-tui-app.zh.md) 持有。
