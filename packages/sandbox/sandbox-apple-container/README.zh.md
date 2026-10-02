---
description: "Apple container 沙箱后端，面向在 macOS 上于按工作区划分的 Linux 虚拟机中运行受限命令、并在容器与本地沙箱之间切换会话的用户和维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-apple-container

[English](README.md) | 中文

## 概述

使用本包可以在搭载 Apple 芯片的 macOS 上，于 [Apple `container`](https://github.com/apple/container) Linux 虚拟机中运行受限的 bash、终端与 PTC 命令。虚拟机只在宿主机路径处挂载会话工作区，因此命令无法读取或修改其他宿主机文件，模型的文件工具也受同一读取范围约束。`.env` 等密钥文件被遮蔽，形似凭据的环境变量永远不会进入客户机，`.git` 保持只读。在其他所有主机上，以及通过 `/sandbox local` 切换的会话中，本包通过继承的本地沙箱链进行限制。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本包作为 `ctx.sandbox` 提供方挂载，取代 `@deepseek-ai/dsh-sandbox-local`，并与 `@deepseek-ai/dsh-sandbox-policy` 并列。随附的终端 profile 正是如此：它禁用基础的 `sandbox` 行，并以 `backend: auto` 插入本包。

### 何时选择

当受限命令不应看到用户的主目录、密钥或其他仓库，且宿主机是搭载 Apple 芯片、运行 macOS 26 并已安装 `container` CLI 的 Mac 时（`brew install container`，然后 `container system start`），选择本包。当命令需要仅存在于宿主机的工具链（例如 Xcode 或 Darwin 原生的 `node_modules` 二进制）时，保留本地提供方。

### 最小配置

```yaml
- id: sandbox
  disabled: true
- insert:
    - name: '@deepseek-ai/dsh-sandbox-apple-container'
      config:
        backend: auto
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `backend` | `auto` | 默认后端：`auto` 在 CLI 可解析的 Apple 芯片 macOS 上选择 `container`，其他情况选择 `local`；`container` 与 `local` 为固定值 |
| `executable` | `container` | `container` CLI；为裸名称时在 `PATH` 上解析 |
| `image` | `node:22-bookworm` | 每个自有容器运行的 OCI 镜像；必须提供 `sh` 与 util-linux 的 `setsid` |
| `cpus`、`memory` | 未设置 | 每个容器的资源；未设置时使用 `container` 系统默认值 |
| `autoStart` | `true` | API 服务器停止时运行一次 `container system start` |
| `recheckMs` | `10000` | 对缓存容器两次存活检查之间的最小间隔 |
| `envDenylist` | 宿主机路径以及 `*KEY*`、`*TOKEN*`、`*SECRET*`、`*PASSWORD*`、`*PASSWD*`、`*CREDENTIAL*`、`*COOKIE*`、`*PRIVATE*`、`AWS_*` | 永不转发到客户机的环境变量名通配模式，即使组合显式传入也不转发 |
| `readOnlyMounts` | `[]` | 以只读方式挂载在其自身路径、且文件工具可读取的宿主机绝对目录；终端 profile 挂载用户技能根目录 |
| `protectedPaths` | `['.git']` | 在 `workspace-write` 下以只读方式挂载的工作区相对目录 |
| `hiddenFiles` | `.env`、`.env.*`、`.envrc`、私钥与证书文件名、`.npmrc`、`.pypirc`、`.netrc`、`.git-credentials` | 在客户机中被遮蔽、并被文件工具拒绝的文件名通配模式 |
| `hiddenFilesMaxDepth`、`hiddenFilesSkipDirs` | `8`、`['node_modules', '.git']` | 容器启动时查找待遮蔽文件的工作区扫描范围 |

`@deepseek-ai/dsh-sandbox-local` 的字段同样适用于 `local` 后端。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-sandbox-apple-container)是每个字段及其 JSDoc 的完整来源。

### 切换会话

`/sandbox` 报告会话的后端、镜像以及每个自有容器的状态。`/sandbox container` 与 `/sandbox local` 记录一个 `sandbox/backend` 事件；会话的下一次受限调用使用新后端，且该选择在重启后保留。在无法运行 Apple `container` 的主机上，`/sandbox container` 会被拒绝。

### 限制所覆盖的范围

| 威胁 | container 后端下的行为 |
|---|---|
| 命令读取工作区之外的宿主机文件 | 该路径在客户机中不存在 |
| 文件工具读取工作区之外的内容 | `read`、`edit`、`write`、`str_replace_editor`、`grep` 与 `glob` 通过读取范围拒绝 |
| 命令或工具读取工作区中的密钥文件 | 在客户机中被遮蔽为 `/dev/null`；被文件工具拒绝；从 `grep` 中排除 |
| 凭据进入客户机环境 | 被拒绝的名称以及带有 `user:password@` 的 URL 永不转发 |
| 命令植入宿主机之后会执行的 Git hook 或配置 | 在 `workspace-write` 下 `.git` 为只读；写入以 `Read-only file system` 失败，并走常规提权流程 |
| 命令写入工作区之外 | 写入落在容器自己的磁盘上，永远不会到达宿主机 |

`danger-full-access` 绕过 `confine`，因此在任一后端下都在宿主机上运行。

### 失败与恢复

CLI 缺失、已停止且无法启动的 API 服务器，或 `container run` 失败，都会以 `SANDBOX_UNAVAILABLE` 拒绝受限调用，消息中会提到 `/sandbox local`。`read-only` 下被拒绝的写入报告 `Read-only file system`，工具层会为此提供标准的一次性提权。无效的 `envDenylist`、`readOnlyMounts`、`protectedPaths` 或 `cpus` 值在加载时失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

### 容器

提供方为每个规范化的工作区根目录与受限模式各持有一个容器，由该工作区与模式下的所有会话和子智能体共享。容器以 `container run --detach --init --rm` 启动，带有所属进程 id 的标签，使用 `--mount type=bind,…` 绑定挂载（不使用 `-v src:dst:ro` 形式，因为 `container` 1.5.0 会错误解析它），并以 `sleep infinity` 空转。缓存的容器每 `recheckMs` 至多重新检查一次，消失时重新启动；销毁时删除所有自有容器，加载时删除其标签进程已退出的容器。当默认后端为 `container` 且部署默认模式为受限模式时，默认模式的容器会在加载时于后台启动。

### 执行 shim

`confine` 返回 `[node, exec-shim.js, <executable>, <container>, <denylist>, '--', ...argv]`。shim 以调用方的工作目录与环境在宿主机上运行，将过滤后的环境写入私有的 `--env-file`，并在客户机中通过 `setsid -w` 以 `container exec -i [-t] -w <cwd>` 运行 argv。由于 `container exec` 不转发信号，shim 记录客户机的进程组 id 并自行向该进程组发送信号；被转发的信号以 `128 + n` 退出。启动哨兵文件用于区分运行时失败（以 `dsh-container-exec: …` 报告、退出码 125，并由运行器失败规则分类）与已运行但失败的命令。构建后的 `lib/exec-shim.js` 只依赖 Node 内置模块，可在 npm 安装的 CLI 中以纯 Node 运行；源码检出则通过 tsx 启动 `src/exec-shim.ts`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 提供方：配置、按会话路由、`readScope`、`/sandbox`、上下文贡献、预热与清理 |
| [`src/pool.ts`](src/pool.ts) | 自有容器、挂载、遮蔽、存活重检与销毁 |
| [`src/runtime.ts`](src/runtime.ts) | 类型化的 `container` CLI 调用 |
| [`src/shim.ts`](src/shim.ts)、[`src/exec-shim.ts`](src/exec-shim.ts) | exec shim 逻辑及其进程入口 |
| [`src/secrets.ts`](src/secrets.ts) | 查找待遮蔽文件的工作区扫描 |
| [`src/host.ts`](src/host.ts) | 主机支持判断与 `auto` 解析 |
| [`src/session-backend.ts`](src/session-backend.ts) | `sandbox/backend` 事件及其写入路径 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [进程沙箱子系统](../../../docs/subsystems/sandbox.zh.md) — 模式、逐调用策略与读取范围。
- [Apple container 沙箱决策](../../../.agents/notes/implemented/feature/2026-10-01-apple-container-sandbox-backend.zh.md) — 虚拟机后端为何加入沙箱 seam，以及备选方案。
- [本地提供方](../sandbox-local/README.zh.md) — 本包为 `local` 会话继承的后端。

-----

<a id="model-experience"></a>
## 模型体验

### container 后端上下文

#### 模型看到什么

当会话在受限模式下解析为 `container` 后端时，运行时上下文快照中会有一条 `sandbox:backend` 贡献；在 `local` 与 `danger-full-access` 下为空。`<image>` 与 `<workspace root>` 以 JSON 引号包裹。

##### container 后端

```markdown
Commands confined by the DSH file sandbox run inside a Linux container from image <image>. Only the session workspace <workspace root> is shared with the host; files written elsewhere stay inside the container and are not visible to file tools. File tools cannot read host paths outside the workspace, and secret files such as `.env` and private keys are hidden from commands and file tools.
```

#### Token 影响

约六十个 token，出现在首次请求以及后端或模式改变该文本后的每次请求的上下文快照中；未变化的请求不增加任何内容。

#### KV Cache 影响

稳定的系统提示词保持不变。变化后的上下文快照追加在保留的历史之后，保持已缓存的前缀；切换后端或模式是本包唯一会改变该文本的操作。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **遮蔽只覆盖容器启动时已存在的文件** — `container` 只遮蔽创建时存在的路径，因此之后创建的密钥文件在容器重启前可被运行中容器内的命令读取；文件工具会立即拒绝它。
- **不支持单文件挂载** — `container` 1.5.0 只能绑定目录，因此保护以目录（`.git`）为单位，而非文件（`.git/config`）。
- **子智能体从默认后端开始** — 子会话不继承父会话的 `/sandbox` 选择。
- **终端尺寸变化不会传到客户机** — `container exec` 不转发 `SIGWINCH`。
- **宿主机与客户机工具链不同** — 工作区中的 Darwin 原生二进制无法在 Linux 客户机中运行；此类项目请使用 `/sandbox local`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

未发布 `./invariant` 配套模块：`sandboxBackend` 投影会用其二值状态 schema 校验每个折叠的 `sandbox/backend` 值，因此伪造的值会在回放时失败，无需额外的独立观察。

升级 `container` 时，请重新评估 `-v` 解析、信号转发与单文件挂载这几项绕行措施；其版本号是产品版本，而非语义化版本。

</details>
