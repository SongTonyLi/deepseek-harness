# Agent Note: session-controller 的 continuation 迁移及其兼容性

Status: implemented

[English](2026-11-12-session-controller-continuation-compatibility.md) | 中文

## 问题

上游同步保留了 fork 的做法：把 continuation 投影从 `SessionController` 移到独立的 `session-continuation` 插件中。直接测试装配现在在构造控制器之前注册该投影，因此拦截第一次投影注册已不能测试列表初始化期间的助手流观察。

## 决策

用户接受方案 A：[初始化规格](../../../../packages/api/session-controller/tests/controller.host.spec.ts)拦截第一次 `sessionListMetadata` 注册。这保留了原断言：控制器列表初始化期间到达的助手流帧仍可被观察。该调整仅涉及测试：不改变生产组合，不增加由控制器拥有的回退挂载，也不改变共享 continuation 的接纳行为。

[同步决策](2026-11-12-fork-runtime-decisions-after-upstream-sync.zh.md)引用此选择。[手动继续生成决策](../feature/2026-10-26-manual-generation-continuation.zh.md)保留接纳策略的依据。在 TUI 中挂载 `terminal-controller` 仍然推迟，不属于本决策。

## 事实

1. **挂载。** [Web 层](../../../../packages/bundle/web-app/cordis.patch.yml)挂载 `session-controller` 和独立的 `terminal-controller`。共享的[基础层](../../../../packages/bundle/base/cordis.patch.yml)挂载 `session-continuation`。[TUI 层](../../../../packages/bundle/tui-app/cordis.patch.yml)不挂载这两个控制器。
2. **注入。** fork 在 [`SessionController.inject`](../../../../packages/api/session-controller/src/index.ts) 中增加了 `sessionContinuation`；`upstream/master` 不要求该服务。Cordis 的 [`Fiber._refresh()`](../../../../vendor/cordis/src/fiber.ts) 在必需服务缺失时使插件保持非活动，因此由 Cordis 管理的控制器现在需要该服务。像测试装配那样直接构造实例并显式调用初始化，本身并不经过插件的注入检查。
3. **初始化顺序。** [`SessionController` 初始化](../../../../packages/api/session-controller/src/index.ts)在等待 `listState.initialize()` 之前创建 `HistoryController`。[`HistoryController`](../../../../packages/api/session-controller/src/history/controller.ts) 在构造期间挂载[助手流监听器](../../../../packages/api/session-controller/src/history/assistant-stream.ts)。在 `upstream/master` 中，`commands.initialize()` 在这两步之间注册 continuation 投影；fork 删除了该调用。现在投影在 [`SessionContinuation` 初始化](../../../../packages/session/session-continuation/src/index.ts)中注册。fork 的[直接测试装配](../../../../packages/api/session-controller/tests/test-remote.ts)在构造 `TestController` 之前等待 `ctx.plugin(SessionContinuation)`，因此在该装配中，注册先于监听器。这个结论不适用于所有可能组合中的构造顺序。
4. **已有失败记录。** 使用上游选择条件时，[初始化规格](../../../../packages/api/session-controller/tests/controller.host.spec.ts)“keeps assistant stream observation live while list initialization awaits”在同步期间的运行记录中得到助手流 revision 0，而非 1。它的 spy 拦截安装后的第一次投影注册。在 fork 的测试装配中，该注册就是 continuation 投影，此时控制器的监听器尚不存在，因此合成的起始帧未进入控制器的累积器。这解释了测试不匹配，并不能证明生产环境在列表初始化期间丢帧。已接受的选择条件改为拦截 `sessionListMetadata`。
5. **测试装配差异。** fork 的 [`test-remote.ts`](../../../../packages/api/session-controller/tests/test-remote.ts) 导入并等待 `SessionContinuation`，然后才执行 `new TestController`；`upstream/master` 没有这两项新增内容。[`continuation.host.spec.ts`](../../../../packages/api/session-controller/tests/continuation.host.spec.ts) 从新包导入迁移后的投影。另一个 [`session.client.spec.ts`](../../../../packages/api/session-controller/tests/session.client.spec.ts) 差异为 steering（中途引导）断言提供确定的请求 id，并不改变 continuation 初始化。
6. **类型兼容性。** [`session-controller/src/types.ts`](../../../../packages/api/session-controller/src/types.ts) 从 [`session-continuation/src/types.ts`](../../../../packages/session/session-continuation/src/types.ts) 导入并重新导出 `SessionRequestId`，保留了现有导入路径和品牌类型。后者还声明了 `SessionProjectionMap.conversationContinuation: SessionSeq | null` 和 `MessageSourceMap['retry-rpc']`，字段与上游相同。它们属于模块扩充，而非从控制器 API 中删除的独立导出字段。控制器类型的导入和重新导出仍可到达这些声明，因此仅迁移声明并不能证明公共类型发生破坏性变更。Web 的[输入 hub](../../../../packages/client/ui-conversation/src/client/input/hub.ts) 和[输入栏](../../../../packages/client/ui-conversation/src/client/skeleton/InputBar.tsx)仍读取 `conversationContinuation`。本次文档审查未独立检查已发布声明文件的解析。
7. **运行时依赖。** [`commands.ts`](../../../../packages/api/session-controller/src/commands.ts) 导入 `SessionContinuationBusyError`，并将空提示词的接纳委托给 `ctx.sessionContinuation.retry`。控制器的 [`package.json`](../../../../packages/api/session-controller/package.json) 将 `@deepseek-ai/dsh-session-continuation` 同时声明为开发依赖和对等依赖（peer dependency）。
8. **空提示词路由。** [`@Remote('prompt')`](../../../../packages/api/session-controller/src/index.ts) 为空内容设置来源种类 `retry`。[`commands.ts`](../../../../packages/api/session-controller/src/commands.ts) 要求该路径使用 queue 模式，并将 continuation 不可用或接纳失败映射为 `session/agent-busy`。

## 与 TUI 及 terminal-controller 的兼容性

`session-controller` 提供 Session Remote 操作；[`terminal-controller`](../../../../packages/api/terminal-controller/src/index.ts) 管理归 Session 所有的终端。后者不是 TUI 应用。随产品提供的 TUI 和基础补丁都不挂载这两个控制器，TUI 的[源码](../../../../packages/bundle/tui-app/src/app.ts)和[清单](../../../../packages/bundle/tui-app/package.json)也不导入或依赖这两个控制器包。因此，session-controller 的规格不匹配不能作为必须在 TUI 中挂载 terminal-controller 的证据。

TUI 的 `/retry` 直接使用共享的 `sessionContinuation` 服务，并从 continuation 包导入 `SessionContinuationBusyError` 和 `SessionRequestId`。尽管 TUI 绕过 Session Remote 控制器，对该包的改动仍可能同时影响 Web 重试与 TUI 重试。这一耦合需要独立于控制器测试选择条件进行验证。在 TUI 中挂载 terminal-controller 的工作仍然推迟；本文既不实现它，也不确认它与 TUI 的兼容性。

## 考虑过的替代方案

**B. 源码守卫。** 让 `SessionController` 在缺少 `SessionContinuation` 时挂载它，会为适配直接构造而让控制器承担组合职责。组合包已提供该服务，而规格无需改变生产归属便可针对列表初始化。仅调整测试即可避免这项额外的生命周期与顺序职责。

**C. 保留上游选择条件且不作其他改动。** 已记录的直接测试装配运行中，8 个测试有 1 个失败，因为选择条件拦截的是 continuation 设置，而非列表初始化。保留该选择条件会让检查继续失败，却未测试预期交错；这不能成为改变共享 continuation 行为的理由。

## 后果

- 规格继续观察列表初始化期间的帧，不改变共享 continuation 接纳行为，也不改变 TUI 的直接 `/retry` 路径。
- fork 修改了上游测试文件，后续上游同步可能在该选择条件处发生冲突。
- 控制器的累积器无法观察监听器挂载之前发出的帧。直接测试装配的失败展示了这一限制，但并不证明生产启动竞态，也不保证任意组合的顺序。
- 在 TUI 中挂载 terminal-controller 仍然推迟。控制器规格不能替代对该独立集成的验证。

## 验证

以下为同步工作保留的结果，并非本次文档更新新运行的测试，也不构成 terminal-controller/TUI 兼容性检查。

- 应用方案 A 的目标规格：1 个文件 / 8 个测试通过。使用上游选择条件时：1 个测试失败，7 个通过；期望 revision 1，实际为 revision 0。
- 应用方案 A 的 `pnpm exec vitest run packages/api/session-controller`：51 个文件 / 1,135 个测试通过。
- 应用方案 A 的 `packages/experimental/liveshare`、`packages/experimental/client-ui-cot-translation` 与 `packages/test-support/client-runtime`：156 个文件通过；1,577 个测试通过，另有 1 个预期失败。
