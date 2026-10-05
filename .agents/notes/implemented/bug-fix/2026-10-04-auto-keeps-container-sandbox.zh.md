# Agent Note: Auto 在限制读取的后端上保留沙箱

Status: implemented

[English](2026-10-04-auto-keeps-container-sandbox.md) | 中文

## 问题

[Auto review](../feature/2026-08-28-auto-review.zh.md)把 Full access 沙箱模式 `danger-full-access` 与它的逐调用 reviewer 捆绑在一起。所有执行强制的消费方在该模式下都跳过限制，因此在终端 profile 的 [Apple container 后端](../feature/2026-10-01-apple-container-sandbox-backend.zh.md)上，选择 Auto 会让命令在宿主机上运行，并让文件工具读取整个宿主机。基于模型的 reviewer 成了唯一的屏障，而用户选定的隔离在没有任何提示或通知的情况下被丢弃。

## 决策

Auto 在被选择时为会话解析自己的沙箱值。当会话的后端限制读取时，`SandboxPolicyService.confinesReads(session)` 为 true，Auto 写入 `workspace-write`；否则 Auto 照旧写入 `danger-full-access`。目前只有容器后端限制读取。该值是一条普通的已记录 `sandbox/mode`，因此持久终端的模式限制、投影与模型可见的策略文本读取到的都是实际生效的模式。已存储的 Auto 选择在两种值下都保持其身份，所以在本决策之前记录的 Session 仍解析为 Auto，并保留其 review 门禁。

应答调用所提出审批的是 reviewer，而不是用户。置前的 `approval/request` listener 对指向 reviewer 已放行的调用的请求应答 `allowed-once`，前提是该调用仍在运行且 Session 仍处于 Auto。这涵盖一次性 `sandbox_permissions` 提权和读取工作区之外的内容。Reviewer 拒绝仍会就该调用请求用户审批，用户随后放行的调用所提出的审批同样会交给用户。下游 listener 自己发起的审批永远不会被应答，对未经审查的 `run_code` transport 的提权仍会请求用户审批。委派的 child 固定 `never`，因此其提权会在任何应答者运行之前被拒绝。

在任何调用 body 之前（包括 `run_code` transport），pre-execute listener 会调用权限预设服务的 `confineAuto`，它收窄仍为 `danger-full-access`、而其后端限制读取的会话。这涵盖在本决策之前记录的 Session，以及之后才切换到容器的会话，并且只追加沙箱模式，因此身份与委派子会话所固定的审批策略不变。该步骤只收紧：切换后端绝不会放宽已受限的 Auto 会话，因此在 `/sandbox local` 之后，用户需要再次选择 Auto 才能回到宿主机上的 Full access。被拒绝的变更（例如终端的模式限制）会使调用失败，而不是让它在陈旧的模式下运行。

卸载 integration 时，受限的 Auto 会话迁移到 Workspace Write，其他任何 Auto 会话迁移到 Full access，因此迁移会保留每个会话的沙箱值。终端的后端选择器把容器预览为对仍处于完全访问的 Auto 会话是受限的。

## 考虑过的替代方案

**在策略解析时推导受限模式。** 日志会保留 `danger-full-access`，因此从 Full access 切换到 Auto 不会追加 `sandbox/mode` 事件，持久终端的限制也就永远不会触发。一个不受限的终端可能在切换之后继续存活于声称受容器限制的 Session 中，日志、模型可见的策略与强制执行三者将不一致。

**保持完全访问，只给出警告。** Reviewer 仍是唯一屏障，所报告的绕过依旧存在。

**在每个后端上都限制 Auto。** 宿主机内核提供方只限制写入，因此 `workspace-write` 会阻碍无人值守的工作，例如写入主目录中的包缓存，模型必须逐项请求提权。在容器上这些写入落在虚拟机内。Web 文案也把 Auto 记录为不带沙箱运行。

**每次提权都询问用户。** Auto 提示的次数会多于 Workspace Write，失去替代提示的用途。

**每次调用前重新选择 Auto。** 选择 Auto 会写入整个组合，包括 `ask` 审批策略，因此固定为 `never` 的委派 child 会被解除固定，reviewer 随后就能应答它的提权。收窄只写入沙箱模式。

**双向跟随后端。** 切换到 `/sandbox local` 会在用户没有选择策略的情况下放宽策略，并且在持久终端打开时，下一次调用会因模式限制而失败。

**在追加后端事件时改写模式。** Session observer 在追加被锁定时运行，因此重入追加会被拒绝，而延后追加会留下调用在陈旧模式下运行的窗口。

**第四种让容器保持完全可写的沙箱模式。** 它会改变封闭的模式词汇表与持久事件，而不带该模式的构建会拒绝该日志。

## 后果

在容器上，Auto 把命令限制在虚拟机与工作区内。那里的 `.git` 为只读，因此提交需要由 reviewer 决定的提权，Darwin 原生工具链在 guest 中无法运行；先执行 `/sandbox local` 再选择 Auto 即可恢复此前的完全访问行为。

Reviewer 的错误仍可能让一次提权的调用获得宿主机访问，这与 Auto 此前对每个调用的暴露面相同。审计日志把该应答记录为普通的 `approval/decided` 事件，因此并不显示授权来自 reviewer 而非用户。固定的 reviewer policy 把每次 allow 都表述为完整宿主机访问，所以 reviewer 评判受限调用时仿佛它们不受限。

在本决策之前记录的 Session，在容器上的下一次调用时被限制，模型在下一个快照中读取变化后的沙箱策略，快照追加在保留历史之后。

单元测试固定了模式解析、已存储身份的匹配、应答及其排除项、收紧及其拒绝放宽，以及卸载时的迁移。auto-review 组合测试用真实的 agent loop、Bash 工具、执行器、presets、审批服务与容器提供方路由，加上一个记录调用的虚拟机替身运行，并在此前的行为下失败。

## 相关决策

- [Auto review](../feature/2026-08-28-auto-review.zh.md)——reviewer、其授权，以及此前的 Full access 沙箱值。
- [Auto 在拒绝后询问用户](../feature/2026-09-24-auto-review-user-approval-fallback.zh.md)——Auto 写入的审批策略。
- [Apple container 沙箱后端](../feature/2026-10-01-apple-container-sandbox-backend.zh.md)——限制读取的后端。
