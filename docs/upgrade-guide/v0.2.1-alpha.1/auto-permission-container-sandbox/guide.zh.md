---
kind: upgrade-guide
description: "终端中的 Auto 权限保留 Apple container 沙箱，而不是把会话切换到完全访问，并由其 reviewer 应答提权请求。"
---

# Auto 在终端中保留容器沙箱

[English](guide.md) | 中文

## 变更

此前，`/permission auto` 写入 `danger-full-access`。在 Apple container 后端上运行 `dsh --profile tui` 时，会话的命令随即在宿主机上运行，文件工具也可以读取整个宿主机，因此 Auto reviewer 是唯一的屏障。

现在，会话运行在 Apple container 后端上时，Auto 写入 `workspace-write`，命令仍被限制在容器内。必须离开容器的调用，例如一次性 `sandbox_permissions` 提权或读取工作区之外的内容，由 Auto reviewer 而不是你来决定；被 reviewer 拒绝的调用仍会请求你的审批。在其他所有后端以及 Web 中，Auto 仍写入 `danger-full-access`。

以 Auto 与 `danger-full-access` 保存的会话，一旦运行在容器上，会在下一次调用时被限制。用 `/sandbox` 切换后端绝不会放宽已受限的 Auto 会话。

受影响：在装有 `container` CLI 的 macOS 上使用 Auto 的终端用户，尤其是需要 Darwin 原生工具链或工作区之外文件的用户。容器内 `.git` 为只读，因此提交需要由 reviewer 决定的提权。

## 迁移

1. 要像以前一样在宿主机上运行 Auto，请把会话切换到本地后端，再重新选择 Auto：

   ```text
   /sandbox local
   /permission auto
   ```

   若要让本地后端成为每个会话的默认值，请在你 profile 的 `cordis.patch.yml` 中为 `sandbox-apple-container` 行设置 `backend: local`。
2. 若要保留容器，无需任何改动。
3. 用 `/sandbox` 确认：选择器标题行在容器上显示 `file policy: workspace-write`，完成步骤 1 后显示 `file policy: danger-full-access`。
