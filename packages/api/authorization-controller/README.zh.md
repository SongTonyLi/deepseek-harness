---
description: "浏览器登录的 Host Remote 拥有者：配置页所列的 flow 目录、带提问的单次流式尝试，以及退出登录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-authorization-controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-authorization-controller` 让浏览器配置页登录那些无法用密钥配置的提供方。它公开已注册的登录 flow 及其凭据存储状态，以一条流运行单次尝试、把 flow 的指引与提问送到页面、再把回答带回来，并在退出登录时忘记已存的凭据。当某个界面必须跨 wire 运行一次登录对话时选用它；部署方能以取值形式提供的凭据应改用 `credentials` namespace。提问的回答只朝一个方向跨越，且这里没有任何方法会返回机密。

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

在提供浏览器配置的 profile 中，把本包挂载为一个 Loader 条目。无论 authorization seam 是否存在，它都会注册 `authorization` Remote namespace，因此页面可以询问「有什么可以登录」，并得到诚实的空答案。

### 何时选择它

当某个配置界面必须通过与人对话来取得凭据时挂载它——账号登录、一次性验证码、账号选择。所有提供方都以密钥配置的部署在这里无需任何东西，而无头或纯自动化的组合也没有可发起登录的界面。flow 本身来自拥有各自凭据的插件；本包不提供任何 flow。

### 最小挂载

```yaml
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
- id: authorization
  name: '@deepseek-ai/dsh-authorization'
- id: authorization-controller
  name: '@deepseek-ai/dsh-api-authorization-controller'
```

本包不接受任何配置。

### 列出可登录的对象

`list()` 为每个已注册 flow 返回一行：它写入的凭据记录（拆为拥有该记录的插件的 `scope` 与插件自身的 `id`，对 LLM（大语言模型）适配器而言即提供方路由）、flow 的标签、它提供的登录方式（最优先在前）、当前是否已有尝试在任何位置运行，以及当前是否已存有凭据记录。没有 authorization seam 的组合返回空列表而非报错，因为这样的部署确实没有任何可登录的东西。已挂载 seam 却缺少凭据 provider 属于配置错误，并会被点名报出。

### 运行一次尝试

`begin(request, signal)` 是一条流。每一项都是一个帧：`notice` 携带人需要做的事、它涉及的页面或验证码，以及桌面界面是否应把该页面交给默认浏览器，`prompt` 携带一个提问以及回答时要指明的 id，`prompt-withdrawn` 对应 flow 撤回的提问，最后的 `settled` 帧携带 `authorized` 或 `cancelled`。尝试在载体拉取第一帧时开始，随流结束而结束；关闭该流即撤回它。`cancel(key)` 用于已不再持有该流的调用撤回它，这正是重新渲染后的页面上「取消」按钮所用的方式。

回答提问要用第二次调用并指明该帧的 `promptId`：`answer(key, promptId, value)` 传入输入的文本或所选项的 id，或在人拒绝时用 `decline(key, promptId)`，后者会让尝试以 `cancelled` 结算。只有该尝试自己的提问可以被回答，因此过期的 id 会被拒绝，而不会被悄悄用在更新的尝试上。

### 退出登录

`signOut(key)` 删除已存的记录。删除不存在的记录会成功，且不会通知签发方——凭据只在本地被遗忘。

### 失败与恢复

`begin` 调用的每一种失败都以流失败的形式到达，而不是以被拒绝的打开，因此界面只需处理一条失败路径。`authorization/rejected` 携带拒绝信息，并在 seam 给出代码时把它放进 `reason`：无 flow 认领该键时为 `NO_FLOW`，flow 不提供所指定方式时为 `UNKNOWN_METHOD`，另一界面正在进行尝试时为 `ALREADY_IN_FLIGHT`，flow 返回却什么都没存时为 `NOT_COMMITTED`。仅仅失败的 flow 只携带它自己的信息。`authorization/no-prompt` 用于回应无人等待的 `promptId`。格式错误的键或负载为 `gateway/bad-request`，缺失的 seam 或凭据 provider 为 `gateway/internal` 并点名应挂载的行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

authorization seam 拥有对话以及「每个键同时只跑一次尝试」的生命周期。本包只拥有 wire 在其之上追加的部分。

### 流即尝试

seam 交给运行中 flow 的交互实现带有 `notify` 与 `prompt` 两个回调，二者都在进程内。浏览器不在进程内，于是每一个都变成压入队列、由 Remote 载体拉取的帧，而 `prompt` 还会额外停在一个 promise 上，由之后的 `answer` 或 `decline` 调用解决。这就是全部的翻译：待答提问表以该尝试的凭据键为键，而 seam 自身的单尝试规则正是让这一表项不产生歧义的原因。

该生成器刻意是惰性的——尝试在第一次拉取时才开始。否则一条无人消费的流会在进程的整个生命周期里占住那个键，而这恰恰是 seam 自己的撤回规则要防止的卡死状态。当流关闭时，仍然打开的每个提问都会被撤回，这样 flow 的 `await` 会结算，而不是等待一个再也不会到来的回答。

### 两种撤回

提问自带信号，因此当 flow 让输入的验证码与浏览器回调赛跑时，可以在尝试继续的同时撤回落败的那个提问。该拒绝刻意不是「拒答」：seam 把 `AuthorizationDeclinedError` 读作人说不，所以 flow 自行解决的竞态必须以别的方式拒绝，否则之后的尝试会被误报为拒答。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Remote 服务：请求校验、帧队列、待答提问表、拒绝映射 |
| [`src/types.ts`](src/types.ts) | 浏览器安全的 flow 视图、begin 请求、帧联合类型与失败代码 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面从本包所承载的 seam 出发，走向驱动它的界面。

- [dsh-authorization](../../credentials/authorization/README.zh.md) — 拥有 flow 与尝试生命周期的 seam。
- [dsh-credentials](../../credentials/credentials/README.zh.md) — flow 提交所经、本包从中删除的记录存储。
- [ui-settings-signin](../../client/ui-settings-signin/README.zh.md) — 消费该 namespace 的模型页界面。
- [API Gateway reference](../../../docs/api-gateway.zh.md) — Remote 方法及其流如何到达浏览器。
- [Credential records and authorization flows](../../../.agents/notes/implemented/architecture/2026-08-13-credential-records-and-authorization-flows.zh.md) — 记录与 flow 两半为何是这种形状。

-----

<a id="model-experience"></a>
## 模型体验

无，因为登录是配置期与人的对话，没有任何 flow、notice 或 prompt 会进入模型请求。

#### KV Cache 影响

不会失效；没有任何登录状态进入请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制是本包当前的约束，继承自它所承载的 seam。

- **一次尝试只活在发起它的那条流里** — 登录途中刷新页面会丢弃该尝试，因为 seam 没有为它准备持久存储。重新加载后的页面会看到该键重新空闲，并从头开始。
- **退出登录只在本地遗忘** — `signOut` 删除记录而不通知签发方，因此需要服务端吊销的提供方无处声明这一点。
- **每个键只允许一次尝试，且是拒绝而非并入** — 第二个界面发起同一个登录会以 `ALREADY_IN_FLIGHT` 被拒绝；行上的 `inFlight` 正是让它禁用按钮、而不是靠报错才发现状态的依据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

None.

</details>

**Runtime invariant:** 不发布伴随实现。authorization seam 拥有尝试生命周期这一关系，本包没有新增可独立观测的关系。
