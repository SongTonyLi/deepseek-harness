# Agent Note：用单个 npm tarball 安装整个 dsh 运行时

Status: implemented

[English](2026-09-15-single-tarball-npm-cli-distribution.md) | 中文

## Problem

从 npm 安装 `dsh` 意味着安装 `@deepseek-ai/dsh` 并解析它依赖的约两百个 `@deepseek-ai/dsh-*` 包，其中每一个都必须已按匹配的版本发布。这对本仓库自己的发布是可行的——它从一个 tag 以同一个版本发布整个族——但对任何分发自己没有 scope 所有权的本源码构建的人都不可用：分叉哪怕只改动一个共享包也无法发布它，因为 npm 会把其余每个名字解析到已发布的上游副本。终端界面正是这种情况——`dsh-tui-app` 依赖 `dsh-file-reference`、`dsh-host-plugin-inventory` 和 `dsh-user-questions` 的分叉构建——因此无法把一条既安装终端 Agent 又能启动它的命令交给别人。

现有的两套自包含组装也回答不了它。Desktop 运行时把已发布的 `@deepseek-ai/*` 包从 registry 安装进 Electron 资源树，因而以整族发布为前提。单文件可执行程序在本地暂存闭包，但把它编译成通过 Python wheel 分发的 `pkg` 二进制，而不是通过 npm 分发。

## Decision

`pnpm run build:npm-cli` 组装出一个 npm 包 `dsh-cli`，其载荷是以 `bundleDependencies` 承载的整个 Node 闭包。安装的可执行文件是 `dsh`，该包在安装期不依赖任何 `@deepseek-ai` 名字，因此 registry 永远不会再解析出一份载荷已经包含的副本。

载荷就是单文件可执行程序已经定义的运行时闭包 `python/sdk-runtime`，由 `pnpm deploy --legacy --config.node-linker=hoisted` 暂存为无符号链接的树。复用该清单正是让这个包诚实反映一次 profile 启动所需内容的原因：`cordis.yml` 以字符串命名的插件不是任何包的依赖边，而该闭包清单正是枚举它们并由 `verify-runtime-closure` 把关的地方。

暂存树的四项性质由构建过程建立而非假定，因为每一项在用户运行结果之前都不可见：

- **`workspace:` 范围被固定。** `pnpm deploy` 会把它们留在嵌套清单里，而 npm 无法解析该协议。每个范围都被改写为暂存在其旁边的版本，因为载荷是封闭的，所以这个版本是精确的。
- **平台变体不打包。** 带 `os`/`cpu` 的包每个平台解析出一份构建，因此打包暂存树会发布一个仅限 darwin-arm64 的包。构建会从载荷中移除这些变体，从已打包父包的清单中删除其条目，并在发布包的顶层 `optionalDependencies` 中只声明一次每个变体，让 npm 在每次安装时选择。单一声明使全局 npm 安装能够实体化所选变体，而不是保留空的嵌套包目录。这覆盖 ripgrep、sharp、koffi、`node-addon-require-builtin` 和 Landlock 启动器；`node-pty` 与 `pi-tui` 在同一个包内附带全部预构建，保持打包。
- **补齐缺失的 workspace peer。** `workspace:` peer 只能由本仓库满足，因此 pnpm 的 peer 自动安装无法提供它，deploy 根的依赖列表是唯一会引入它的东西。当该列表不全时，构建会按该 workspace 包发布时的样子打包并解包进载荷，重复直到没有未解析项。以此方式组装终端 profile 发现了两处这样的缺口：`dsh-session-title-llm` 和 `dsh-util-workspace-path`，二者都经由 `dsh-base` 到达，且都不被 `verify-runtime-closure` 发现——它遍历的是已发布的 agent preset 而非 bundle patch。
- **载荷在打包前被证明是封闭的。** 载荷中每个包的每个依赖以及每个非可选 peer 都必须在载荷内解析。该检查先于版本范围固定运行，因为固定会丢弃它无法解析的范围，否则就会抹掉证据。

随包发布的 bin 把不带参数的 `dsh` 默认指向 `tui` profile，其余每种调用原样透传，因此 `dsh web`、`dsh plugin`、`dsh --profile <name>` 以及应用自有的参数的行为与源码检出时一致。它调用启动器导出的 `runCli`，而不是依赖模块的 `import.meta.main` 自派发——对导入方而言那是 false。它自己回答 `--version` 并给出两个版本，因为启动器报告的是它据以组装的 harness 构建，而一个按自己版本线发布的包否则看起来像装错了东西。

打包会还原 `pnpm deploy` 改写的、用于描述本仓库自身安装状态的文件。一次 `--prod` deploy 会在 workspace 状态中记下 `dev: false`，此后每次 `pnpm run` 都会把该 workspace 读作过期，并提出清除本仓库的开发依赖。

## Verification

`pnpm run build:npm-cli` 在出现无法解析的运行时边时让构建失败，这正是已发布的 tarball 无法挽回的性质。聚焦的打包测试还固定了仅由根部声明平台变体、`workspace:` 范围归一化、保留无关可选依赖以及在修改前检测冲突。组装出的包已从其 tarball 安装到干净的全局前缀中，`@vscode/ripgrep` 会在那里解析并执行所选的 `rg` 二进制。已发布命令检查仍包括 `dsh --version`、`dsh --help`、`dsh tui --help`、`dsh --profile headless --help` 和 `dsh web --help`；不带参数的 `dsh` 在 pty 下初始化 `tui` profile，渲染出会话抬头、模型、权限预设与按键提示，并带着 resume 提示干净退出。安装树中存在 `@deepseek-ai/dsh-tui-app` 证明所用的是打包载荷而非 registry 副本，因为该包并未发布。

未覆盖模型往返：冒烟测试在没有 provider 密钥的情况下运行，因此该组装只验证到首次模型请求之前。

## Alternatives considered

**以分叉拥有的 scope 发布整族。** 已否决：在打包时把 `@deepseek-ai/dsh` 改写到另一个 scope 是可行的，但它每次分叉、每次发布都要发布约 270 个包名，且结果的每个消费者都要承受一套与上游源码完全相同的包的平行命名宇宙。

**只发布改动过的包，其余交给 npm 解析。** 否决的理由是不正确而不只是成本高：npm 独立解析每个名字，因此同一版本下混合分叉与上游构建的载荷，正是打包机制要防止的情况。

**用打包器把闭包打成单文件。** 已否决：Cordis 在运行时按包名从 `cordis.yml` 解析插件模块，而 harness 会启动重复该解析的 worker 线程与子进程，因此单文件构建将不得不复刻模块解析而非依赖它。

**把树放在 npm 不会剥离的目录下并从 bin 解析它。** 已否决，改用 `bundleDependencies`——它是在 tarball 中承载依赖树的受支持机制，无需我们自备解析器。

**把载荷裁剪到终端 profile 的闭包。** 已否决：去掉 `dsh-web-app` 与 `dsh-acp-app` 只能省下 22 MB tarball 的一部分，却会让 `dsh web` 与 `dsh acp` 在发布构建中变成坏掉的命令，而且需要对 `apps/cli` 的依赖列表做一份仅用于打包的分叉，而仓库中没有任何东西验证它。

## Consequences

代价是载荷成为一份时间点快照。被打包依赖的修复只有在本包重新构建并重新发布时才能到达用户，因为 npm 无法升级 bundle 内部的任何东西；tarball 为 22 MB、安装后为 92 MB，其中大部分代码同时也以各自的名字存在于 registry 上；而且发布树的 lifecycle 脚本被剥除，因此依赖本会在安装期完成的事情必须在暂存树中已经成立。该组装在一点上仍带有构建主机的形状而这并未消除：被打包的部分在一台机器上构建，只有 `os`/`cpu` 包按安装解析。

它换来的是一种不依赖 scope 所有权、也不依赖整族发布的分发方式，这正是终端界面得以从分叉安装的原因。除原生变体外，所有安装者拿到的是相同的字节，因此关于某个发布构建的报告指向唯一的产物。闭包检查是其中持久的部分：它陈述了载荷必须满足的性质，并让构建而不是首次启动失败；它发现了两处真实缺口——`dsh-session-title-llm` 和 `dsh-util-workspace-path`——这是 `verify-runtime-closure` 未覆盖的，因为它遍历的是已发布的 agent preset 而非 bundle patch。`dsh plugin` 仍然调用 pnpm，因此管理外部插件需要 `PATH` 上有 pnpm，与源码安装时完全一致。
