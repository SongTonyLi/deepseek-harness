# Agent Note: Apple container sandbox backend

Status: implemented

[English](2026-10-01-apple-container-sandbox-backend.md) | 中文

## Problem

终端 profile 曾通过 `@deepseek-ai/dsh-sandbox-local` 使用 macOS Seatbelt 约束 bash、终端与 PTC 子进程。Seatbelt 共享宿主机内核、宿主机工具链以及所有可读的宿主机文件，因此受限命令可以读取用户能读取的任何内容，包括密钥、其他仓库和 `.env` 文件，只是被阻止写入。模型的 `read`、`grep` 与 `glob` 工具读取宿主机时完全不受约束。Apple 的 [`container`](https://github.com/apple/container) 在 Apple 芯片和 macOS 26 上为每个 Linux 容器运行一个独立的轻量虚拟机，读写都被限制在显式挂载的范围之内。

[子进程沙箱决策](2026-07-06-sandbox.zh.md)曾否决把容器作为 `ctx.sandbox` 后端，因为 `confine(argv)` 预设共享文件系统。当工作区绑定挂载在其宿主机绝对路径上时，共享文件系统这一前提对受限模式可写入的每条路径都成立，因此本笔记针对这种形式的虚拟机后端收窄了那条规则。

## Decision

`@deepseek-ai/dsh-sandbox-apple-container` 继承 `LocalSandboxProvider` 并注册为 `ctx.sandbox`。每个会话的后端为 `container` 或 `local`：`local` 调用继承的本地链，`container` 用 exec shim 包装 argv，使其在虚拟机中运行。终端 bundle 禁用基础的 `sandbox` 行并以 `backend: auto` 插入本包；`auto` 在 `container` CLI 可解析的 Apple 芯片 macOS 上选择 `container`，在其他所有主机上选择 `local`，因此通过 npm 安装的 CLI 在 Mac 以外的行为与之前相同。

### 容器

提供方为每个规范化的工作区根目录与受限模式各持有一个容器，由该工作区与模式下的所有会话和子智能体共享。默认镜像为 `node:22-bookworm`：工作区挂载在其规范路径与字面路径上（`read-only` 下为只读），`workspace-write` 下 `.git` 以只读方式挂载，技能根目录等额外配置的目录以只读方式挂载，启动时已存在的密钥文件被遮蔽为 `/dev/null`。销毁时删除自有容器；加载时删除其标签所属进程已退出的容器；默认模式的容器在后台预热。

### 执行 shim

`confine` 返回 `[node, exec-shim.js, <executable>, <container>, <denylist>, '--', ...argv]`。宿主机上的 shim 携带 spawn 的工作目录，把去除形似凭据的变量名以及内嵌凭据的 URL 之后的环境写入私有的 `--env-file`，并在客户机中通过 `setsid -w` 运行 argv。`container` 1.5.0 不会通过 `container exec` 转发信号，因此 shim 自行向记录下的客户机进程组发送信号。启动哨兵文件用于区分运行时失败（退出码 125 并输出 `dsh-container-exec: ` 行，由运行器失败规则匹配）与已运行但失败的命令。构建后的 shim 只依赖 Node 内置模块，因此可从打包的 npm 包中以纯 Node 运行。

### 读取范围

`SandboxProvider.readScope(policy)` 报告受限进程可读取的宿主机路径；基础实现返回 `undefined`，表示读取不受限。container 后端返回工作区与额外挂载目录，并排除隐藏文件名。`SandboxPolicyService.canRead` 解析会话策略，并用规范化后的路径对照该范围检查；`read`、`edit`、`write`、`str_replace_editor`、`grep` 与 `glob` 工具在观察路径之前拒绝范围之外的路径，`grep` 还会排除隐藏文件名。因此模型的文件工具读取的内容永远不会超出其受限命令。

### 会话状态与模型可见性

仅记录在日志中的 `sandbox/backend` 事件记录一次 `/sandbox` 切换，由 `sandboxBackend` 投影折叠；在任何切换之前使用配置的默认值。`ctx.commands` 上共享的 `/sandbox` 命令报告并切换后端，并在不支持的主机上拒绝 `container`。在 container 后端与受限模式下，`sandbox:backend` 运行时上下文贡献告诉模型：命令运行在 Linux 容器中，只有工作区是共享的，密钥文件被隐藏。

## Alternatives considered

**环境一致的能力组**（`subprocess-container`、`fs-container` 与 `sandbox-container`，类似 SSH 家族）——保持原规则不变，但规模大数倍，而且文件系统工具在工作区之外将看不到用户的 Mac。工作区绑定挂载加读取范围以很小的代价让双方拥有相同视图。

**只替换 shell 执行器**（用 `bash-container` 替换 `bash-sandbox`）——终端、PTC 及其他所有 `ctx.sandbox` 消费方仍在 Seatbelt 下运行，一个会话会混用两种约束世界。

**每条命令执行 `container run --rm`**——实测每次调用约 0.8 秒，而对运行中容器执行 `container exec` 约 0.07 秒。

**每个会话一个容器**——会话之间隔离更强，但子智能体会失去父会话在客户机内的状态，且每个会话都要付出虚拟机启动的代价。

**`container machine`**——以读写方式挂载整个主目录、转发 SSH agent、授予所有 capability 并配置免密 sudo；这更接近不受约束的宿主机执行，而非沙箱。

**在 `ctx.fs` 内限制读取**——文件系统提供方同时服务技能与设置等必须访问工作区之外路径的 harness 读取，因此围栏放在代表模型读取的模型可见工具中。

**环境变量白名单**——会丢弃 harness 有意传入的变量（例如分页器设置）；对显式条目同样生效的、按凭据形态匹配的拒绝名单在保留这些变量的同时扣下密钥和令牌。

**以 Alpine 作为默认镜像**——musl 以及缺少 `bash`、`git` 和 util-linux `setsid` 会导致常见智能体命令失败。

## Consequences

在受支持的 Mac 上，受限命令无法读取或修改工作区之外的宿主机文件，看不到启动时已存在的密钥文件或凭据环境变量，也无法植入供宿主机执行的 Git hook。模型的文件工具共享同一读取视图。在 Mac 之外，终端 profile 保持之前的本地沙箱。

代价是工具链不同：工作区中的 Darwin 原生二进制无法在 Linux 客户机中运行，这类项目需使用 `/sandbox local`。容器启动后创建的密钥文件在重启前仍可在容器内读取，`.git` 写入需要提权，终端尺寸变化不会传到客户机，子智能体从默认后端开始，安装后的第一条命令可能需要等待镜像拉取。早于本变更的构建会拒绝包含 `sandbox/backend` 的日志。升级 `container` 时必须重新评估 `-v` 解析、信号转发与单文件挂载这几项绕行措施。

## Testing

单元测试针对伪造的 `container` CLI 驱动提供方、容器池、运行时、shim、扫描与主机解析，达到逐文件完整覆盖，每个文件工具的读取围栏都有各自的测试套件。`tests/apple-container.e2e.ts` 针对真实运行时运行，检查 Linux 客户机、宿主机可见的工作区写入、不可读的宿主机文件与密钥、只读的 `.git`、只读拒绝的分类以及取消；在 `container system status` 失败的主机上跳过。
