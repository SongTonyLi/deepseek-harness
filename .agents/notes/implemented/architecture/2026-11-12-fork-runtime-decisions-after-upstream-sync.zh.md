# Agent Note: 同步上游后与上游不同的 fork 决策

Status: implemented

[English](2026-11-12-fork-runtime-decisions-after-upstream-sync.md) | 中文

## 问题

本 fork 跟踪上游 master 截至 PR #8278 的状态，并在四项决策上与之不同：本地沙箱中的读取围栏拒绝、放在静态 Client 工具包中的凭据匹配器、`interrupt_agent` 工具（终端 profile 启用它，上游的内置配置却将其关闭，PR #7986），以及点名 `cordis` 智能体预设 id 的四个文件的 rescope 豁免。代码显示每项决策做了什么，却没有说明它为何不同于上游；本笔记记录这些原因。

## 决策

用户接受 [session-controller continuation 兼容性](2026-11-12-session-controller-continuation-compatibility.zh.md)中记录的、仅涉及测试的 `sessionListMetadata` 选择条件调整。它保留共享 continuation 服务，不增加由控制器拥有的挂载；在 TUI 中挂载 `terminal-controller` 仍然推迟。

### 读取围栏拒绝保留其错误码

上游没有读取围栏。没有任何上游包包含 `confineWithReadFence` 或 `SANDBOX_UNSUPPORTED_POLICY`；上游提交 `refactor(sandbox): remove obsolete unsupported-policy error` 从 `@deepseek-ai/dsh-sandbox` 中移除了 `SandboxUnsupportedPolicyError` 导出。因此，该拒绝只存在于本 fork 中。

当所选 runner 或配置的 `runnerCommand` 无法强制执行读取围栏时，本地提供方会在进程启动前，以错误码 `SANDBOX_UNSUPPORTED_POLICY` 拒绝该次执行。拒绝所用的错误是 `SandboxUnsupportedPolicyError`，即 [errors.ts](../../../../packages/sandbox/sandbox-local/src/errors.ts) 中包内的 `HarnessError` 子类；`@deepseek-ai/dsh-sandbox` 不为它导出任何类（[入口](../../../../packages/sandbox/sandbox/src/index.ts)）。该类在 [index.ts](../../../../packages/sandbox/sandbox-local/src/index.ts) 的 `wrap` 中有两个抛出分支：`runnerCommand` 分支与非 Seatbelt 分支。

规格依据错误码字符串。[local.spec.ts](../../../../packages/sandbox/sandbox-local/tests/local.spec.ts) 按错误码与消息断言两种拒绝；[provider.spec.ts](../../../../packages/sandbox/sandbox-apple-container/tests/provider.spec.ts) 断言 Apple container 后端的错误码，其 [README](../../../../packages/sandbox/sandbox-apple-container/README.zh.md) 同样记录了该错误码。读取围栏本身记录于[宿主机绑定进程在宿主机上受读取围栏隔离](../bug-fix/2026-11-05-container-host-bound-processes.zh.md)。

### 凭据匹配器位于静态工具包中

凭据扫描器及其格式表位于 `@deepseek-ai/dsh-util-credential-mask`（[README](../../../../packages/util/credential-mask/README.zh.md)）中。上游把它们保留在 `@deepseek-ai/dsh-client-ui-secret-mask` 中。该工具包是静态链接的 Client 库：[PLATFORM_MODULES](../../../../packages/client/web/src/platform.ts) 列出了它，[seed.ts](../../../../packages/client/web/src/seed.ts) 把它注入 shell 的模块表。

终端界面由一个所有者持有遮蔽器：[app.ts](../../../../packages/bundle/tui-app/src/app.ts) 用 `createCredentialMasker()` 创建一个遮蔽器，并把它传给 [blocks.ts](../../../../packages/bundle/tui-app/src/blocks.ts) 中的 `UserBlock`，以及 [queue-panel.ts](../../../../packages/bundle/tui-app/src/queue-panel.ts) 中的 `renderQueuePanel`。遮蔽器的类型 `CredentialMasker` 只有一个方法 `mask(text)`，它返回显示文本。Web 的 `secret` 规则在每次调用 `createSecretRule()` 时创建自己的 `CredentialScanner`（[secret-rule.ts](../../../../packages/client/ui-secret-mask/src/client/secret-rule.ts)），因为它需要 `mask(text)` 不返回的匹配范围（`start` 与 `end`）。

客户端规则禁止功能插件在运行时导入另一个功能插件的值，并把共享运行时代码放在窄的静态归属方中，例如 `client/store`、`ui-primitives` 或浏览器安全的工具包（[导出规则](../../../../packages/client/AGENTS.md#export-discipline-client-plugin-packages)）。该工具包的 [清单](../../../../packages/util/credential-mask/package.json) 不声明 `dependencies`，只声明 harness 包通常声明的 `@deepseek-ai/cordis` 对等依赖与开发依赖。匹配算法及其预算记录于[用户文本的线性凭据匹配与性能门禁](../testing/2026-10-11-user-text-credential-matching.zh.md)。

### 终端 profile 保留 interrupt_agent 启用

终端 profile（`packages/bundle/tui-app`）不在上游中。它的 [tool-subagent-control 行](../../../../packages/bundle/tui-app/cordis.patch.yml)设置 `config.interrupt: true`，因此终端的工具集包含 `interrupt_agent`。已发布的 base（[行](../../../../packages/bundle/base/cordis.patch.yml)）以及 Web 的 [`standard`](../../../../packages/bundle/web-app/presets/standard.patch.yml)、[`cordis`](../../../../packages/bundle/web-app/presets/cordis.patch.yml)、[`ptc`](../../../../packages/bundle/web-app/presets/ptc.patch.yml) 预设都设置 `interrupt: false`。在 `packages/bundle` 中，只有终端行启用它。[插件](../../../../packages/subagent/tool-subagent-control/src/index.ts)对省略该设置的组合默认为 `true`。

终端 profile 默认启用 Agent Teams（[行](../../../../packages/bundle/tui-app/cordis.patch.yml)）。Team 功能通过标准控制工具接触 teammate，其中包括 `interrupt_agent`（[tool-agent-team](../../../../packages/team/tool-agent-team/README.zh.md)）。内置配置默认关闭该工具（[agent-team](../../../../packages/team/agent-team/README.zh.md)）。

### 四个文件在 rescope 门禁下保留 cordis 预设 id

fork 在 [rescope-vendor.ts](../../../../scripts/rescope-vendor.ts) 的 `GENERIC_SKIPS` 中为裸 `cordis` 名新增四个条目：[creator-persona.e2e.ts](../../../../apps/web/tests/creator-persona.e2e.ts)、[agent-scopes.spec.ts](../../../../packages/experimental/cua/tests/agent-scopes.spec.ts)，以及 subagent-interrupt-default 指南的中文版（[guide.zh.md](../../../../docs/upgrade-guide/v0.2.2-rc.1/subagent-interrupt-default/guide.zh.md)）。英文版 `guide.md` 是第四个条目。产品标识符表 [rescope-vendor.spec.ts](../../../../scripts/rescope-vendor.spec.ts) 列出全部四个文件，并断言 rescope 不会改动其中任何一个。

rescope 门禁会把裸 `cordis` 名改写为 `@deepseek-ai/cordis`，改写范围包括带分隔符的名称标记、YAML 的 `name:` 标量，以及 TypeScript 与 JavaScript 的模块说明符。在这四个文件中，裸名属于产品数据，即 `cordis` 智能体预设 id：creator-persona 将其选为默认预设并断言会话的预设 id，agent-scopes 将其列在预设之中，subagent-interrupt 指南在变更与迁移步骤中点名它。上游的 rescope 列表对这四个文件没有任何条目。

`GENERIC_SKIPS` 中某文件与裸名 `cordis` 对应的条目，会让 token 规则跳过该文件中所有带引号的裸 `cordis`，包括 Markdown 正文中带引号的模块说明符，因此产品字符串保持不变。`rewriteModules` 中的模块语法处理仍会改写被豁免的 TypeScript 或 JavaScript 文件中的裸 `cordis` 模块说明符，以及其 TypeScript 或 JavaScript 代码块中的同类说明符。这四个文件都不含此类说明符：creator-persona 只使用带引号的预设 id；agent-scopes 导入的是带 scope 的 `@deepseek-ai/cordis`，并使用带引号的预设 id；两份指南的代码块都是 YAML。

`ui-agent-preset` 条目上方的代码注释记录：改名曾改变 creator 流程暂存的预设，以及 roster 报告的 id。

## 考虑过的替代方案

**把该类从 `@deepseek-ai/dsh-sandbox` 导出。** 该方案未被采用：上游已移除这一导出，而 `sandbox-local` 之外没有任何包构造或导入该类，共享导出只会增加一个没有使用方的公共类型。

**把扫描器保留在 `dsh-client-ui-secret-mask` 中，并由终端界面导入。** 该方案未被采用：客户端规则为共享运行时代码指定了窄的静态归属方，功能插件不是其中之一。

**把扫描器放入 `client/store` 或 `ui-primitives`。** 该方案未被采用：`client/store` 承担 snapshot-store 引擎，`ui-primitives` 承载共享控件；扫描器两者的职责都不具备（[分层规则](../../../../packages/client/AGENTS.md#layering-red-lines)）。

**终端保留 base 中的关闭行。** 该方案未被采用：终端 profile 默认启用 Agent Teams，而 Team 功能通过 `interrupt_agent` 接触 teammate，内置配置却关闭该工具。

**在共享 base 中启用该工具。** 该方案未被采用：上游在 PR #7986 中于内置配置里关闭了它，Web 预设也保留了这一设置。

**把四个文件中的裸 `cordis` 与其他用法一样改名。** 该方案未被采用：裸名是这些文件选择、断言并记录的预设 id，而 `ui-agent-preset` 条目上方的代码注释记录了改名曾改变 creator 流程暂存的预设，以及 roster 报告的 id。

## 后果

- **读取围栏拒绝：** 识别该拒绝的调用方匹配错误码字符串，因为该类既未从 `sandbox-local` 的入口重新导出，也未从 `dsh-sandbox` 重新导出。改动该字符串需要同时更新 `errors.ts`、点名它的 JSDoc、断言它的两份规格，以及记录它的各份 README。
- **凭据匹配器：** Web 的 `secret` 规则与终端界面共享同一个工具包，因此扫描器的改动会同时影响两个界面。新增静态 Client 库需要同时编辑 `PLATFORM_MODULES` 与 `seed.ts`。`getStaticModules()` 中的 `satisfies Record<PlatformModule, unknown>` 子句即是对这一对的编译期检查，其注释写明：在 `PLATFORM_MODULES` 中新增却没有静态导入的词，或相反的情况，都会导致编译失败。
- **interrupt 工具：** 终端的工具集包含 `interrupt_agent`，而 base 与 Web 预设省略了它。终端行显式设置该值，因此修改 base 行不会改变终端。
- **rescope 豁免：** 这四个文件保留其产品值。上游列表对裸名共有 76 个条目，本 fork 另外新增了这四个文件的条目。其他符合改写条件、且引用裸名的文件，除非列表点名，否则会被门禁改写。
