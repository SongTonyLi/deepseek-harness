---
kind: upgrade-guide
description: "宿主机文件工具和宿主机绑定进程现在遵守 Apple 容器后端的路径写保护。"
---

# 容器会话中的路径写保护

[English](guide.md) | 中文

## 变更

在使用 `workspace-write` 的 TUI 容器会话中，宿主机文件工具和宿主机绑定进程过去可以修改客户机以只读方式挂载的路径。现在它们拒绝写入 `protectedPaths`（默认为 `.git`）和 `readOnlyMounts` 下的路径，即使某个可写根目录也包含目标路径。

## 迁移

1. 将生成的文件和其他常规编辑放在工作区内普通的可写目录中。
2. 如需修改仓库元数据，请自行执行操作或审核单次提权请求。受限文件工具写入受保护路径时会报告 `FS_SANDBOX_DENIED`。
