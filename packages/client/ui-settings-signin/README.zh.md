---
description: "Web 模型页上的提供方登录：订阅与密钥两类登录、带验证码与提问的尝试对话框，以及退出登录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-signin

[English](README.md) | 中文

## 概述

本插件让 Web 用户以订阅、而非 API 密钥接入提供方——用 ChatGPT 订阅使用 OpenAI Codex 模型，以及其他每一个适配器自带订阅登录的提供方。模型页上该提供方的卡片会获得它的登录方式、凭据存好后的已登录标记，以及退出登录。一个对话框承载运行中的尝试：要打开的页面、要在那里输入的验证码，以及提供方提出的任何问题。只接受密钥的提供方保持原有卡片不变。

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

打开**设置 → 模型**。适配器自带订阅登录的提供方会在该提供方的卡片内、常规 API 密钥字段旁显示登录按钮。只以 API 密钥登录的提供方不会新增任何内容：那个密钥属于卡片自己的字段。

### 登录

点击登录按钮；提供多种方式的提供方会为每种方式显示一个按钮，并以方式命名。随后对话框会显示提供方希望人去做的事。浏览器登录以链接形式显示要打开的页面。设备码登录在该页面之外还会显示要输入的短验证码，并配有复制按钮。提供方提出的问题——选择登录方式、粘贴重定向 URL、粘贴密钥——会在同一对话框中显示为输入框或选项列表，**继续**把回答送回。**暂不**拒答该问题，这会取消登录；**取消**撤回整次尝试。

尝试结束时对话框会说明结果：已登录、已取消，或带着提供方自己的信息失败。此后卡片显示已登录标记，该提供方的模型在其路由配置完成后即可选择。

### 退出登录

**退出登录**会在本机忘记已存的凭据。它不会通知提供方，因此提供方仍认为有效的会话在那边依然有效；要吊销请在提供方自己的账号设置中操作。

### 各状态的含义

每个提供方的卡片显示一块登录区域：

| 状态 | 含义 |
|---|---|
| 登录按钮与提示 | 未存有凭据；该提供方使用订阅登录 |
| 已通过提供方订阅登录 | 已存有登录授权——订阅登录，例如 ChatGPT |
| 已登录 | 已存有经提供方自己的登录提示取得的密钥 |
| 按钮禁用并带忙碌提示 | 另一个浏览器标签页或界面正在运行该提供方的登录 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕——点击展开</summary>

本插件填充模型页所声明的两个座位，不向该页自身的代码添加任何东西。

### 两个座位，一个快照

`settings.models.provider-card` 以拥有它的 settings namespace 为键，因此在 `llm-pi-ai` 下注册一个条目即可触达该适配器族的每一张卡片；该区域随后只在提供方的 flow 提供订阅方式处渲染。`settings.models.footer` 承载对话框，它属于页面而非某张卡片：一次尝试会在其卡片滚出视野后继续存在，而且同时只有一次尝试在跑。两个座位接收同一个快照 store，因此卡片与对话框绝不会对「正在运行什么」产生分歧。

### flow 目录

Host 的 flow 列表按提供方路由联接：记录 scope 属于 pi-ai 适配器族的 flow 会在其记录 id 中给出提供方，而来自其他插件的 flow 指向的不是提供方，因此被略过。目录在挂载时、任何位置的尝试结算后、任何凭据记录变更后，以及重连后重新读取——因此在第二个标签页完成的登录无需轮询即可在此收敛。被拒绝的读取保留上一次的良好结果，而不是在尝试途中清空这些控件。

### 单次尝试

发起一次尝试会打开 Host 的流，并把它的帧折进快照：notice 累积为指引，prompt 成为待答提问，被撤回的 prompt 清除它，结算关闭该尝试。发起第二次尝试会撤回第一次，而这正是 Host 本就会拒绝的情形。没有结算就结束的流会被报告为取消，而不是留下一个转圈。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 插件入口：词典、两处座位注册、推送式失效 |
| [`src/client/store.ts`](src/client/store.ts) | flow 联接、运行中的尝试，以及 Host 操作 |
| [`src/client/SignInCard.tsx`](src/client/SignInCard.tsx) | 单张提供方卡片内的登录区域 |
| [`src/client/SignInDialog.tsx`](src/client/SignInDialog.tsx) | 尝试的指引、提问与结果 |
| [`src/client/SignInFooter.tsx`](src/client/SignInFooter.tsx) | 页面级对话框座位 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面从本插件所扩展的页面出发，走向其背后的 Host 侧。

- [ui-settings-models](../ui-settings-models/README.zh.md) — 声明本插件所填两个座位的模型页。
- [api-authorization-controller](../../api/authorization-controller/README.zh.md) — 此处每次调用背后的 Remote namespace。
- [dsh-authorization](../../credentials/authorization/README.zh.md) — 拥有 flow 与尝试生命周期的 seam。
- [llm-pi-ai](../../llm/llm-pi-ai/README.zh.md) — 为每个已安装提供方注册一个登录的适配器。
- [配置模型](../../../docs/user/guide/providers.zh.md) — 同时覆盖密钥与登录两类提供方的用户指南。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包是浏览器侧的配置界面，不注册任何面向模型的东西。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定了该界面到哪里为止；它们是本包当前的约束。

- **刷新页面会丢弃运行中的登录** — 尝试活在发起它的那条流里，因此人要从头开始。已完成的登录是持久的；只有未完成的会丢失。
- **退出登录只在本地遗忘** — 已存凭据被删除而不通知提供方，因此订阅会话在提供方一侧仍然有效，直到在那里吊销。
- **只有适配器族的提供方获得该座位** — 卡片座位以 pi-ai 的 settings namespace 为键，因此由非 LLM（大语言模型）适配器插件注册的 flow 在本页没有位置。
- **这里不提供收取密钥的登录** — 只以 API 密钥登录的提供方保留卡片自己的密钥字段，因为把同一份机密存成记录而非引用，会让人有两处地方要找。
- **登录不会添加该提供方的路由** — 已登录的提供方仍然需要它在模型页上的那一行，因为部署方提供哪些路由始终是 settings 的决定。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

None.

</details>

**Runtime invariant:** 不发布伴随实现。本包渲染 Host 拥有的登录状态，不拥有可独立观测的关系。
