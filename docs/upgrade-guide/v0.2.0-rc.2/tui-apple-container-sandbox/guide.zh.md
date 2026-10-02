---
kind: upgrade-guide
description: "终端 profile 在 Apple 芯片的 macOS 上于 Apple container 虚拟机中约束命令，其沙箱行改为 `sandbox-apple-container`。"
---

# 终端 profile 在 macOS 上于 Apple container 中约束命令

[English](guide.md) | 中文

## 变更

此前，`dsh --profile tui` 使用基础的 `sandbox` 行（`@deepseek-ai/dsh-sandbox-local`，在 macOS 上为 Seatbelt）约束 bash、终端与 PTC 命令，模型的文件工具可以读取任意宿主机路径。

现在，终端 bundle 禁用该行，并以 `backend: auto` 插入 `sandbox-apple-container`（`@deepseek-ai/dsh-sandbox-apple-container`）。在安装了 [`container`](https://github.com/apple/container) CLI 的 Apple 芯片 macOS 上，受限命令在只挂载工作区的 Linux 虚拟机中运行；`workspace-write` 下 `.git` 为只读，密钥文件与凭据环境变量被隐藏；`read`、`edit`、`write`、`str_replace_editor`、`grep` 与 `glob` 拒绝工作区与只读技能根目录之外的路径。在其他所有主机上，该行保持之前的本地沙箱。`/sandbox` 报告并切换会话的后端。

受影响者：命令需要仅存在于宿主机的工具、或需要读取工作区之外路径的 macOS 终端用户，以及配置了 `sandbox` 行的 profile patch。

## 迁移

1. 若要使用容器，请安装并启动它：`brew install container`，然后运行 `container system start`。
2. 若要为单个会话保留之前的行为，运行 `/sandbox local`。若要为所有会话保留，在 profile 的 `cordis.patch.yml` 中加入：

   ```yaml
   - id: sandbox-apple-container
     config:
       backend: local
   ```

3. 把你在 `sandbox` 行上设置的配置（`runnerCommand`、`runnerFailureSignatures`、`probeTimeoutMs`）移到 `sandbox-apple-container` 行；终端 profile 中的 `sandbox` 行已被禁用。
4. 用 `/sandbox` 确认：它会输出带有镜像和容器状态的 `backend container`，或 `backend local`。
