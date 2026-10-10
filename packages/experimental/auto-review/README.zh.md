---
description: "添加实验性逐调用 Auto review，在工具以 Full access 执行前使用当前 agent 的模型审查；沙箱后端限制读取时则在受限状态下执行。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-auto-review

[English](README.md) | 中文

## 概述

为当前会话权限选择器添加 Auto review。每次原生或 PTC inner 工具调用前，当前 agent 的 provider 与模型会评估待执行动作；获准调用以 Full access 执行，会话运行在 Apple container 后端时则在容器内受限执行，被拒绝调用会请求用户审批。随附的 TUI profile 包含此层。在 Web 侧栏插件页开启或显式安装之前，默认 Web 保持三种权限模式。Auto review 是实验功能：它可能误放行不安全动作、误拒绝有用操作，并消耗额外 token。

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

评审环境记录待执行操作对应的 Session 当前工作目录。

### 安装到 profile

从源码 checkout 通过既有 CLI 将包安装到 Web profile：

```sh
pnpm dsh plugin --profile web add ./packages/experimental/auto-review
```

CLI 会在需要时初始化 profile，并将本包声明的 patch 追加到 base 与 Web 层之后。Reconciliation 将 patch 激活为 profile 层；没有 `dsh.bundle.patch` 的包只是已安装依赖。在 composer 菜单或 `/permission` 选择器中选择带 `EXP` 标记的「自动审查」，并确认当前会话风险对话框。显式 `/permission auto` 命令直接切换。通用设置与未来会话默认值不提供 Auto。

通过同一 CLI 移除此层：

```sh
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-experimental-auto-review
```

### 获得的能力

Auto 在每个受支持调用的 body 执行前审查一次，包括每个已开始的 PTC `tools.*` inner call。它按实际效果分类：普通项目内操作和精确清理本 Session 创建的对象属于 low，直接允许；不可逆删除既有对象、生产操作、外部写入和安全控制变更属于 medium，需要当前 human 或直接父级明确授权动作、目标与范围。跨信任边界泄露敏感信息属于 high，始终拒绝。效果不明确和授权冲突未解决时拒绝。选择 Auto 会设置 `ask` 审批策略，因此被拒绝调用会请求用户审批，获批后才执行；审批被拒绝或取消时 body 不执行。进程内委派 child 固定 `never` 策略，其拒绝是最终结果。Reviewer 响应不合法和技术失败会以具体错误使调用失败，且从不执行。

最终拒绝使用普通工具卡片。折叠行标识 Auto review；展开输出说明 body 未执行，并显示可选理由。[Web 权限包](../../client/ui-permission-presets/README.zh.md)拥有选择器交互，[工具 UI](../../client/ui-tool/README.zh.md)拥有理由展示。

### Auto 在容器后端上

会话运行在 [Apple container 后端](../../sandbox/sandbox-apple-container/README.zh.md)时，Auto 会保留沙箱：选择它写入 `workspace-write` 而不是 `danger-full-access`，因此获准的命令在容器内受限运行。必须离开容器的调用，例如模型发起的一次性 `sandbox_permissions` 提权或读取工作区之外的内容，由 reviewer 而不是用户决定：获准的调用在运行期间提出的每一项审批都由它代为应答。被 reviewer 拒绝的调用仍会就该调用本身请求用户审批，其随后提出的任何审批也会交给用户。外层 `run_code` transport 不经过审查，因此对其自身进程的提权仍会请求用户审批。

在 Auto 一律写入 `danger-full-access` 时记录的会话，一旦其后端限制读取，就会在下一次调用时被限制。切换后端绝不会放宽已受限的 Auto 会话，因此执行 `/sandbox local` 后，需要再次选择 Auto 才能回到宿主机上的 Full access。只限制写入的后端让 Auto 保持 Full access。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制——点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml)把本包自身插入为 `auto-review` 行。[`src/index.ts`](src/index.ts)要求 approval、LLM、permission、Session 与 tools 服务，然后在同一个 effect 中安装 preset contribution 和置前的 pre-execute listener。Review 结束后，拒绝会读取 Session 的审批策略：`never` 下为最终拒绝；`ask` 下 listener 先交给后续 pre-execute listener，只有它们放行调用时才返回 tools 流水线的 `ask` 决定，因此后续的拒绝、取消或 `ask`（带自己的理由）优先。`ask` 决定携带英文审计理由，以及保留原始 reviewer 理由的本地化提示文本。[权限 owner](../../interaction/permission-presets/README.zh.md)提供当前身份和进程目录；Auto 写入 `ask` 审批策略，搭配 Full access 的沙箱值；会话的后端限制读取时则搭配 `workspace-write`；它不改变工具定义。

另有两个 listener 让 Auto 留在受限后端上。在任何调用 body 之前，pre-execute listener 会调用权限预设服务的 `confineAuto(session)`，它在后端限制读取时收窄仍为 `danger-full-access` 的会话，只追加沙箱模式，因此委派子会话所固定的审批策略不变；它对未经审查的 `run_code` transport 同样运行，被拒绝的变更（例如持久终端的沙箱模式限制）会使调用失败，而不是让它在陈旧的模式下运行。置前的 `approval/request` listener 对满足以下条件的请求应答 `allowed-once`：请求指向 reviewer 已放行、仍在运行的调用，且会话仍处于 Auto；下游 listener 针对该调用自己发起的审批不在其覆盖范围内，调用结算时 `tools/post-execute` 会让它忘记该调用。

Reviewer 从当前 Session surface 与待执行调用重建五个分区：固定策略、仅 cwd 的环境、带来源的项目约束、过滤后带来源的历史，以及完整待审动作。原生 schema 来自最新 request header。PTC binding 冻结其 schema，经由调度器传入临时执行元数据；开始与结算事件都不序列化描述或参数 schema。主 agent 的 `system/message` 节点、assistant 正文与 reasoning、tool results 全部排除。外层评审输入是冻结的 `RequestUserInput`，不含持久身份或来源；保留历史在评审文本中仍携带原始来源。[决策记录](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.zh.md)拥有权威、生命周期与 child 继承的理由。

卸载时先关闭选择与 review admission，经由既有 preset writer 迁移存活 Auto Session，再中止并等待在途 review 结清，最后撤回 listener 与 contribution。处于 `danger-full-access` 的会话变为 Full access，通过 Session writer 写入 `never` 审批策略，不排入策略变更通知；处于 `workspace-write` 的会话变为 Workspace Write，仅当会话尚无 `ask` 审批策略时才写入它。模型在下一次 runtime-context 快照中看到新策略。每个会话保留自己的沙箱值，持久终端在迁移中保持不变。持久 Auto Session 缺少完整 integration 时不能发布；安装后重新打开需要用户显式操作。重装只恢复选项，不把存活 Session 切回 Auto。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [实验包](../README.zh.md)——发布策略与依赖隔离。
- [Web bundle](../../bundle/web-app/README.zh.md)——此 patch 扩展的稳定 profile。
- [Auto review 决策](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.zh.md)——固定风险策略、权威与生命周期。
- [Tools](../../core/tools/README.zh.md)——执行、取消与 PTC 结果传播。

-----

<a id="model-experience"></a>
## 模型体验

### 逐调用 reviewer

#### 模型看到什么

Reviewer 使用最新 `request/header.config` 的 provider 与模型，并沿用 shipped adapter 默认 reasoning。`temperature` 设置接受 `0` 到 `2` 的数值或 `provider-default`；后者省略请求参数。插件默认值为 `0`，bundle 仅在 `tui` profile 中选择 `provider-default`，使不接受 temperature 的 provider 也能审查调用。固定 `REVIEW_POLICY` 替代恰好一个动作的人工审批：allow 后立即执行，措辞上视为拥有完整宿主机访问权限，即使会话保留着容器也是如此，因此 reviewer 会把每个调用都当作拥有该权限来评判。其余四个分区只包含上文列出的保留事实。响应为一个严格 JSON text 对象，包含 `risk` 与 `decision`；deny 可附字符串 `reason`。Reasoning blocks 可以位于这唯一 text block 之前。只有 `low + allow`、`medium + allow/deny` 和 `high + deny` 合法。

#### Token 影响

每个受支持调用额外产生一次模型请求。完整 text 响应不是有效 JSON 时，`maxJsonRetries` 允许额外请求（默认 `1`，非负安全整数；`0` 禁用重试）。每次重试复用冻结的动作事实，并在策略后追加固定格式提醒，不包含格式错误的响应。有效拒绝、非法 risk／decision 对象、provider 或 stream 失败以及已取消的 review 不重试。JSON 重试耗尽后调用失败，不执行 body。请求不缓存、截断、压缩，也不设单独的小型输出预算；超窗请求以 provider 错误使调用失败。

#### KV Cache 影响

固定 reviewer policy 可以共享前缀；保留历史与待审动作随调用变化。Auto 不向主 agent 增加专门 runtime context 或模式切换提示词。在容器后端上选择 Auto，或限制一个按完全访问记录的会话，会让既有的沙箱策略与后端贡献变化一次；新快照追加在保留历史之后，因此缓存前缀不变。

### 工具拒绝

#### 模型看到什么

在 `ask` 审批策略下，模型只看到审批结果，例如 `the user rejected tool "<name>"`，或获批调用的普通结果。最终拒绝消息为 `Auto review rejected tool "<name>"; its body was not executed`。Reviewer 失败消息为 `Auto review of tool "<name>" failed; its body was not executed: <error>`。普通原生错误渲染在每条消息前加 `Error: `。PTC 使用既有 inner-call 异常与 catch 行为；被捕获的拒绝不强制外层 `run_code` 失败。可选原始理由是面向用户的持久结构化错误详情，绝不进入主模型内容。风险、reviewer prompt、reasoning 与原始响应都不持久化。

#### Token 影响

被拒绝或失败的调用只向主对话贡献其普通错误结果。

#### KV Cache 影响

拒绝追加普通工具结果，不改写更早的上下文，也不隐藏既有模型可见信息。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 随附的 TUI profile 包含 Auto review。默认 Web、Headless、通用设置与新会话默认值在开启此层之前都不包含它。
- Auto 自身不提供文件沙箱。在限制读取的后端上，它保留该后端的 `workspace-write` 限制，其他后端上以 Full access 运行。外层 `run_code` transport 及 PTC 程序内直接 Node 效果不经过 inner-tool review。
- 固定 reviewer policy 把每次 allow 都表述为完整宿主机访问，且不会告知 reviewer 会话的沙箱模式，因此它可能拒绝容器本可限制住的调用。
- 应答审批的 reviewer allow 会记录为普通的 `approval/decided` 事件，结果为 `allowed-once`。审计轨迹不会记录这次授权来自 reviewer 而非用户，reviewer 的 risk 与 decision 也不持久化。
- 模型分类可能出错。不提供确定性工具豁免、持久 grant 或可配置策略。格式重试无法纠正有效但错误的分类。
- 进程内 Auto child 独立审查自身调用。进程外 child 在父委派调用获准后保留原生权限系统。
- reviewer 在带行级豁免的情况下，通过已废弃的同步 `snapshotEvents()` 读取 Session 动作历史。此前的调用、PTC start 与直接父级的初始 prompt 目前都没有投影或分页读取方，因此迁移按[同步读取决策](../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.zh.md)继续延期。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
