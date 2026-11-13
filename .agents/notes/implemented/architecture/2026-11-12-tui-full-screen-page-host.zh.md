# Agent Note: TUI 全屏页面共用一个宿主

Status: implemented

[English](2026-11-12-tui-full-screen-page-host.md) | 中文

## Problem

除阅读器外，终端还在备用屏幕上绘制两个占据整个终端的页面：`/team-play` 背后的团队室，展示团队如何分配角色；`/todos` 背后的 todos 页面，展示团队如何分配工作。团队室先出现，`src/app.ts` 手工接入了它：一个字段，六个方法分别负责打开、绘制、重绘、转发按键、关闭与撤下，并在退出路径、会话切换、按键路由、滚轮处理、旋转指示 tick 与会话事件处理中各有针对团队室的检查。以同样方式接入第二个页面会把这些全部复制一遍，而每份副本都要单独维持 `tui.suspend`、`readerScreen.enter` 与 `updateSpinTicker` 的正确顺序，并在逐文件覆盖率门禁下各有一套测试。

## Decision

[`src/screen-page.ts`](../../../../packages/bundle/tui-app/src/screen-page.ts) 定义 `ScreenPage`，即全屏页面所实现的接口：`handleInput(data)` 返回一个 `ScreenPageAction`（`close`，或像 `/team` 一样 `open` 某个 teammate 会话）或不返回任何内容，`render(width, rows)` 恰好返回 `rows` 行，`animates()` 报告下一次旋转指示 tick 是否会画出不同的帧。该模块还拥有 `PAGE_CLOSE_HINT`，即每个页面图例都以之结尾的 `Esc q closes` 步骤。`src/app.ts` 在 `screenPage` 中最多持有一个页面，并通过 `openScreenPage`、`paintScreenPage`、`repaintScreenPage`、`onScreenPageKey`、`closeScreenPage` 与 `dropScreenPage` 驱动它；原先针对团队室的每个调用点都改为调用这些方法。`TeamPlay` 与 `TodosPage` 都实现该接口，`/team-play` 与 `/todos` 的区别只在于构造的页面以及构造前的检查。

页面拥有所有因页面而异的部分：自身状态、图例与动效；动效依据应用传入的时钟计算，而不是依靠定时器。应用拥有对每个页面都相同的部分：备用屏幕、暂停与恢复对话的渲染器、页面显示期间把每个按键交给页面且 `Ctrl+C` 总是关闭它、滚轮不做任何事、在会话事件到来时重绘、恰在 `animates()` 为真时启用旋转指示 tick，以及在退出和会话切换时撤下页面。todos 页面的数据来自 [`src/work-tree.ts`](../../../../packages/bundle/tui-app/src/work-tree.ts)，这是一个纯函数，应用在每个按键与每一帧时以 Team 快照、投影与绑定日志调用它。

## Alternatives considered

**把 todos 页面接在团队室旁边。** 否决：这会复制 `app.ts` 中约 80 行代码及其测试，而两份副本会在顺序细节上逐渐分歧，阅读器的历史表明这些细节很重要（重绘边界以及渲染器何时恢复）。

**把工作树移入团队包的会话投影。** 推迟：这样 Web 与各 SDK 也能绘制同一棵树，但 teammate 的 todo 列表位于它自己的 Session 中，单会话折叠读不到，因此终端仍需自行拼出树的一部分。目前还没有第二个客户端需要这棵树。

## Consequences

第三个全屏页面只需一个实现 `ScreenPage` 的类和一个命令分支。阅读器保持独立：它是带有自身出现时钟与固定提示行的 pi-tui 组件，而不是 `ScreenPage`。`open` 动作指向 teammate 会话，因此想打开其他内容的页面需要扩展 `ScreenPageAction` 以及 `onScreenPageKey` 中以 `assertNever` 结尾的 switch。应用只依据流式文本所用的同一项淡入能力判定一次页面是否有动效，因此减弱动效、禁用调色板、`NO_COLOR` 与 `TERM=dumb` 会同时停止所有页面的动效。
