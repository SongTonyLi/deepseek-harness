# Agent Note: 宿主机绑定进程在宿主机上受读取围栏隔离

Status: implemented

[English](2026-11-05-container-host-bound-processes.md) | 中文

## 问题

终端 profile 的 [Apple container 后端](../feature/2026-10-01-apple-container-sandbox-backend.zh.md)通过 `container exec` 在 Linux 虚拟机中运行每个受限 argv。运行工作流的 Node PTC worker 会启动宿主机的 Node 可执行文件和宿主机上的 bootstrap 文件，并通过子进程提供方在文件描述符 7 上传入的控制管道与宿主机通信。客户机中这两个文件都不存在，而 `container exec` 只转发 stdin、stdout 和 stderr。因此，在装有 `container` CLI 的 Mac 上，受限会话中的每个工作流都在第一个子智能体启动之前失败：

```text
Error: workflow run failed: workflow execution failed (worker-exit): Node process exited (127, signal null): sh: 1: /opt/homebrew/Cellar/node/25.9.0_2/bin/node: not found
```

唯一的绕行办法是把会话切换到 `/sandbox local` 或完全访问。

## 决策

`SandboxProvider.confineHostBound(argv, policy, { runtimePaths }, signal)` 包装宿主机绑定执行：这类进程必须留在子进程提供方的执行世界中，因为它会启动该世界中位于共享工作区之外的可执行文件或文件，或者继承 stdio 之外的描述符。基础实现就是 `confine`，每个在宿主机内核上隔离的提供方本就在该世界中应用它。Node PTC worker 调用它，并把自己的可执行文件以及 bootstrap 的脚本目录（或源码检出目录）声明为运行时路径。

container 后端覆盖了这个方法。本地后端会话原样使用继承的本地链。container 会话使用本地 Seatbelt 链：沿用策略的写入规则，再加上由 `LocalSandboxProvider.confineWithReadFence` 添加到 profile 中的读取围栏。围栏在 `hostBoundUnreadableRoots`（默认 `/Users` 与 `/Volumes`）下拒绝 `file-read-data`，在 container 读取范围、策略的可写根目录和运行时路径下重新允许，并在任何位置拒绝读取匹配 `hiddenFiles` 的文件名。Seatbelt 采用最后一条匹配规则并按解析后路径匹配，因此符号链接和经 firmlink 的写法都留在围栏之内，它也会拒绝为被拒绝的文件新建硬链接。只有 Seatbelt 档能表达围栏；其他 runner 或配置的 `runnerCommand` 会以 `SANDBOX_UNSUPPORTED_POLICY` 故障关闭。

worker 启动的工作保持各自的隔离：工作流子智能体的命令仍在容器中运行。

## 考虑过的替代方案

**在客户机中运行 worker。** 这需要用客户机的 Node 代替宿主机可执行文件，把 bootstrap 放进客户机，还需要在两端各建一个中继，通过 `container exec` 的 stdio 复用控制通道与程序输出；`container run --publish-socket` 只能在容器启动时发布 socket。这相当于在 [SSH helper](../../../../packages/ssh/ssh/README.zh.md) 之外再建一套传输，而运行在客户机镜像 Node 22 上的 worker 会与宿主机运行时产生分歧。

**用普通 Seatbelt 隔离 worker。** 工作流脚本可以通过钩子函数接触到 Node，因为工作流 VM 不是安全边界。没有读取围栏时，脚本可以读取 container 对命令和文件工具隐藏的密钥与其他仓库。

**允许列表式读取围栏。** 拒绝指定根目录之外的一切读取，就必须同时列出 Node 启动时读取的每个目录，而这些目录在 Homebrew、nvm 与 asdf 安装之间各不相同。

**在 `confine` 内识别 PTC argv。** 提供方只能从 argv 的形态猜测意图，其他宿主机绑定消费方也无法主动选择。

**在 container 会话中隐藏 workflow 工具。** 工具在每个组合中只注册一次，而后端会通过 `/sandbox` 按会话改变。

## 影响

工作流在终端 profile 默认的 container 会话中能够完成，其子智能体仍在虚拟机中运行命令。逃出工作流 VM 的脚本可以读取 `/Users` 与 `/Volumes` 之外的宿主机路径，例如 `/etc`、`/opt` 和临时区域，也可以在任何位置读取文件元数据。它无法读取主目录中位于工作区、只读挂载、可写根目录和自身运行时文件之外的文件内容，也无法读取机密文件。客户机不会暴露上述任何宿主机路径，因此围栏弱于虚拟机。

实验性的 Python PTC 运行时仍调用 `confine`，在 container 会话中仍会失败。

单元测试固定 Seatbelt 围栏文本、受保护包装的拒绝情形、提供方路由以及 worker 的运行时路径。一个 Seatbelt 端到端测试证明围栏会拒绝文件内容、符号链接别名、目录列表、新建硬链接以及隐藏名的大小写变体。一个终端端到端测试通过发布的 profile 在 workspace-write 的 container 会话中运行工作流，没有这项改动时会失败。两个端到端测试在各自运行时不可用时都会跳过。

## 相关决策

- [Apple container 沙箱后端](../feature/2026-10-01-apple-container-sandbox-backend.zh.md) — 该后端及其读取范围。
- [为工作流复用 PTC Node 沙箱](../architecture/2026-09-13-workflow-ptc-sandbox-reuse.zh.md) — 工作流为何运行在 PTC 进程中。
