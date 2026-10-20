# Agent Note: The terminal application owns its quit

Status: implemented

[English](2026-10-19-tui-graceful-quit.md) | 中文

## Problem

在有工作运行时退出，用户既得不到它停止了什么的说明，也没有它要花多久的上限。runner 先释放终端、打印恢复提示，然后才 dispose 会话绑定，而停止后台作业与子 agent 的正是这一步。忽略 `SIGTERM` 的命令会让退出一直等到其工具的强制终止宽限期结束，期间终端毫无输出；`whenIdle`、flush 或 dispose 中任何一步挂起，退出就会无限期等待，因为 [`process-shutdown.ts`](../../../../apps/cli/src/process-shutdown.ts) 中启动器五秒的 dispose 上限只有在应用请求退出之后才开始计时。第二次 `Ctrl+C` 必须在 600 ms 内到达，而邀请这次按键的那一行却在屏幕上停留约两秒，于是用户按屏幕提示做出的按键可能只是清空编辑器并重新装填，而没有退出。关闭终端会发出 `SIGHUP`，其默认处置直接结束进程而不做 dispose：会话没有 flush，它启动的命令也没有被停止。

## Decision

**退出策略归终端应用所有。** 它不由任何共享服务承载，也不需要修改启动器。`dsh-tui-app` 中的 [`src/quit.ts`](../../../../packages/bundle/tui-app/src/quit.ts) 在停止任何东西之前，先清点根会话树中正在运行的工作：shell 命令（模型的前台调用与用户的 `!` 命令）、其他存活的后台作业，以及正在运行的后代 Agent。随后它依次运行 `agent.cancel({ kind: 'user' })`、`await agent.whenIdle()`、`sessions.flush(session)` 与 `await bound.dispose()`，每一步都依赖前一步。先取消，使每个工具调用都经由自身的取消路径停止，对 shell 调用而言就是该工具先终止、后强杀的升级流程。在 flush 之前等待空闲，使被取消轮次的收尾记录（包括其 `turn/end`）进入 flush 所持久化的日志。先 flush 再 dispose，使释放绑定即便挂起，会话也已保存。dispose 放在最后，因为停止根会话所拥有的作业与子 agent 的正是 owner 的 dispose。每一步都被隔离：抛出异常的步骤被记为一个带类型的 `QuitFailure`，下一步照常运行，因此 flush 失败绝不会跳过停止工作的 dispose。该序列与 `quitGraceMs`（默认 10 000 ms，最小 1000）以及用户的强制退出竞争；之后 runner 请求退出，启动器自身五秒的应用树 dispose 与同步的退出时进程强杀仍会随后执行。报告把 `timedOut`、`interrupted`、`failures` 与 `saved` 作为彼此独立的字段。强制退出时退出码为 130，否则挂断为 129，否则超时或某一步失败为 1，其余为 0。

**退出绝不调用 `jobs.kill`。** `cause: 'kill'` 的结算会让 `dsh-tool-jobs` 向作业的 owner Agent 投递一条完成通知，而这条通知会唤醒空闲的 owner，从而在退出刚刚停下的 Agent 上开始一个新轮次。owner 的 dispose 以 `cause: 'teardown'` 结算其拥有的每个作业，这种结算不投递通知，因为被 dispose 的 owner 已没有读者。因此作业只经由 `bound.dispose()` 停止。

**`SIGHUP` 由 TUI runner 处理，而不是启动器。** 启动器层面的处理器会作用于每个 profile，而添加 Node 的 `SIGHUP` 监听器会取代 `nohup` 设定的忽略处置，于是 `nohup dsh web &` 会在其终端关闭时结束。TUI profile 总有一个终端，因此它的 runner 经 `ctx.effect` 注册该监听器，其 disposer 会移除它。挂断以 cause `hangup` 运行同样的退出：终端写入与渲染器的停止都是尽力而为，一个空操作的 `error` 监听器使 stdout 与 stderr 上的 `EIO` 与 `EPIPE` 不会变成未捕获异常，退出码为 129。用于强制退出的 `SIGINT` 监听器只在退出进行期间存在；启动器自身的 `SIGINT` 处理器在旁边照常运行。

**进度在终端释放之后写到 stderr。** 停止过程在 `TuiApp.stop()` 恢复终端之后才开始，因此 `dsh: stopping <work> (Ctrl+C to force)`、每两秒一行带当前清点结果的 `dsh: still stopping <work> (Ctrl+C to force)`，以及结果行，都是普通的 stderr 写入。它们在退出后与恢复提示一起留在 shell 的回滚缓冲中，处于 cooked 模式的终端会把 `Ctrl+C` 变成强制退出所需的 `SIGINT`，而挂断路径以尽力而为的方式使用同样的写入。

**退出的装填恰好持续到提示行消失为止。** 第一次 `Ctrl+C` 清空编辑器，显示 `press Ctrl+C again to quit`（清点结果非空闲时其后跟着 `· stops <work>`），并在 `showToast` 返回的生命周期内装填退出：保持时长加上淡出；不绘制淡出或该行被打印进对话记录时，则只有保持时长。`Esc` 的停止装填遵循同一规则，任何其他按键都会解除装填。用户按屏幕提示做出的第二次按键总会退出，也不存在按键含义与屏幕所示不符的窗口。

## Alternatives considered

**在启动器中为每个长期运行的 profile 处理 `SIGHUP`。** 已否决：安装该监听器会覆盖继承来的忽略处置，于是每个在 `nohup` 下启动的非交互 profile 都会在其终端关闭时结束。只有 TUI 确定拥有一个终端。

**在释放会话之前用 `jobs.kill` 停止作业。** 已否决：每次强杀结算都会发出一条完成通知，可能唤醒退出刚刚停下的 Agent，并在关闭过程中发起一次模型请求。owner 的 dispose 已经以一种什么也不发送的结算停止了同样的作业。

**先请求退出，让启动器五秒的 dispose 来限定停止过程。** 已否决：该上限只在请求退出时才开始计时，它 dispose 整棵应用树时不遵循取消、空闲、flush、dispose 的顺序，也不报告它在等待什么。它固定的五秒仍作为 `quitGraceMs` 之后的第二道上限保留。

**让 TUI 一直绘制到停止完成，并在其中显示进度。** 已否决：绘制会让渲染器及其会话订阅在它们所读的会话正被释放时仍然存活，而挂断时根本没有终端可画。stderr 行在退出后留在 shell 的回滚缓冲中，而在 cooked 模式的终端里，强制退出键以启动器本已处理的 `SIGINT` 形式到达。

**保留固定的 600 ms 连按窗口，或给该窗口单独的设置项。** 已否决：短于邀请按键那一行的窗口，会让这一邀请在其显示的大部分时间里都是错的，而单独的设置项可能与 `toastMs` 不一致。把装填与提示行的生命周期绑定，只让一个值说了算。

## Consequences

- 有工作运行时的退出会写明这些工作，每两秒说明仍在运行的内容；除干净停止之外的每种结果都会打印一行写明可能仍在运行的工作，并以非零退出码退出。干净的退出只打印恢复提示，且在作业与子 agent 停止之后才打印。
- 无论某一步做什么，退出最多耗时 `quitGraceMs` 加上启动器的五秒；预算放弃的工作可能一直运行到启动器的退出时强杀。在 macOS 上，以及在没有 user-systemd scope 的 Linux 上，通过两次 fork 脱离命令进程树的进程不在该强杀范围之内，如 [subprocess-local 的限制](../../../../packages/subprocess/subprocess-local/README.zh.md#known-limitations-and-deferred-work)所述。
- 只有 TUI profile 会在其终端关闭时清理。其他 profile 保留 `SIGHUP` 的默认处置，因此 `nohup` 对它们照常有效，而未用 `nohup` 启动的 `dsh web` 在其终端关闭时仍会不经 dispose 直接结束。
- 面向模型的内容没有任何变化，也没有新增 Session 事件；一次退出的日志包含被取消轮次的 `turn/end`，以及退出所停止的每个作业的一条 `cause: 'teardown'` 的 `job/settled` 记录。
- [`tests/quit.spec.ts`](../../../../packages/bundle/tui-app/tests/quit.spec.ts) 固定了顺序、预算、强制退出、被隔离的失败、进度行与结果映射，构建后的免密钥测试 `apps/cli/tests/profiles/tui/tests/quit-while-busy.e2e.ts` 则让已发布的 profile 经历有工作运行时的退出、`SIGHUP` 与强制退出。退出尚未在 Apple container 沙箱后端下、真实 PTY 中，以及 Linux 与 Windows 主机上得到验证。

## Related decisions

本记录取代了[终端阅读器浮层、Esc 安全与以编辑器为中枢](../feature/2026-09-18-tui-reader-overlay-and-esc-safety.zh.md)所保留的 600 ms `Ctrl+C` 窗口；该记录的其余内容依然有效。终端界面及其 profile 归[终端界面即已发布的 `tui` profile](2026-09-15-terminal-surface-tui-app.zh.md) 所有。
