# Agent Note: Browser provider sign-in

Status: implemented

[English](2026-09-14-browser-provider-sign-in.md) | 中文

## Problem

提供方登录的 Host 一半随[凭据记录与授权 flow](../architecture/2026-08-13-credential-records-and-authorization-flows.zh.md) 发布，随后就无处可跑。`llm-pi-ai` 为每个已安装 pi-ai 提供方注册一个 flow，`dsh-authorization` 拥有尝试的生命周期，凭据 seam 以跨进程刷新加锁存储该授权。那篇记录在结尾恰好点名了缺失的东西：「把 notice 与 prompt 送到浏览器的 wire 契约，以及 Models 页上发起登录的控件。」

由此带来三个后果。`@deepseek-ai/dsh-authorization` 不出现在任何 `cordis.patch.yml` 中，因此 `llm-pi-ai` 的 `ctx.inject(['authorization'], …)` 从未触发，这些 flow 在运行时并不存在。没有任何 Remote namespace 公开该 seam，所以即便存在也没有界面能触达。而 `docs/user/guide/providers.md` 告诉用户「通过 OAuth 登录的提供方（例如 Codex）暂不支持」——这是事实，也正是 ChatGPT 订阅无法用于已安装目录早已描述的 GPT-5 与 GPT-6 系列 Codex 模型的原因。

## Decision

两个包加一处组合变更，seam 与适配器均不改动。

**`dsh-api-authorization-controller` 承载对话。** 仓库中其他每个 Remote 方法都是一元的，但一次授权尝试是一场对话：flow 在运行期间说话，并提出它要等待回答的问题。因此 `begin` 成为仓库第四个 stream 模式的 Remote，为 flow 所说的每一件事产出一个帧——`notice`、`prompt`、`prompt-withdrawn`，以及终止性的 `settled`。回答以自己的调用（`answer`/`decline`）朝另一个方向传递并指明该帧的 `promptId`，因为 Remote 载体在一条流内没有上行通道。seam 自身「每个键同时只跑一次尝试」的规则正是让待答提问表不产生歧义的原因：每个键的一个表项只可能属于一条流。

其中三个选择承担了主要分量：

- **流的存续期就是尝试的存续期。** 关闭它即撤回该尝试，并撤回仍然打开的每个提问，这样 flow 的 `await` 会结算，而不是等待一个再也不会到来的回答。`cancel(key)` 与之并存，供已不再持有该流的界面使用——seam 本就是为这种传输形态提供它的。
- **生成器是惰性的。** 尝试在载体拉取第一帧时开始，而不是在 `begin` 返回时。否则一条无人消费的流会在进程的整个生命周期里占住那个键，而这正是 seam 的撤回规则要防止的卡死状态。
- **`begin` 的每一种失败都是流失败。** 校验、缺失的 seam、seam 的拒绝，以及出错的 flow，全都经由同一条路径到达，因此界面只写一个错误分支，而不必区分被拒绝的打开与失败的读取。

**`dsh-client-ui-settings-signin` 是独立插件，而不是对 Models 页的修改。** Models 页早已声明 `settings.models.provider-card`（以 settings namespace 为键）与 `settings.models.footer`，正是为此：让插件添加提供方适配器的 UI，而该页无需知道它意味着什么。登录填充两者——卡片座位注册在每个适配器族的 settings namespace 下（`llm-pi-ai` 与 `llm-cursor`），因此这些族的每条路由都会获得它；页脚座位承载对话框，它属于页面而非卡片，因为一次尝试会在其卡片滚出视野后继续存在，且同时只有一次在跑。两个座位共享一个快照 store，因此卡片与对话框不可能对「正在运行什么」产生分歧。

卡片只提供订阅方式。`llm-pi-ai` 为全部 38 个已安装提供方注册登录，但其中 31 个只提示输入 API 密钥——而卡片本就为它准备了一等字段，并把它存为 settings profile 所指明的引用。在其旁再提供 pi-ai 的密钥提示，会把同一份机密改存为记录，让「我的密钥在哪」有两个答案。该判定是否定式的（除 `api-key` 之外的每个方式 id），因此提供方新增第二种订阅方式时无需改代码即可出现，而第二条密钥路径永远不会。

flow 目录按提供方路由联接：记录 scope 为适配器族 settings namespace（`llm-pi-ai` 或 `llm-cursor`）的 flow 会在其记录 id 中给出提供方，而来自其他插件的 flow 指向的不是提供方，因此被略过。`authorization/settled` 与 `credentials/record-updated` 加入转发事件白名单，因此在第二个标签页完成的登录无需轮询即可收敛。

**base bundle 挂载 seam；web bundle 挂载 controller 与该插件。** seam 自身不提供任何 flow，因此把它挂进 `dsh-base` 不会要求任何人登录——无头或 ACP 组合保持不变，而让这些登录可触达的是那里本就存在的 `llm-pi-ai` 与 `llm-cursor` 行。

`authorization/settled` 的 Cordis `Events` 声明从 authorization 包的 `index.ts` 移到其浏览器安全的 `types.ts`，与凭据 seam 声明其两个事件的方式一致：转发白名单的 Client face 必须读到 Host 所发出的同一份声明，而不引入仅 Host 可用的服务类型。

## Alternatives considered

**在流内回答提问。** 双工流可以把一场对话保持在一次调用里。Remote 载体每条流是单向的，因此这意味着在 Remote 之外再加一套协议——正是 `docs/api-gateway.md` 为独立数据协议保留的那件事。用两次调用配合 `promptId` 则按原样复用载体。

**改为轮询一个一元的 `state(key)`。** 它避免了仓库的第四条流。它也把浏览器回调的竞态变成轮询间隔，丢失 notice 与紧随其后的提问之间的顺序，并让设备码流无法及时显示它的验证码。

**把登录控件直接放进 `ui-settings-models`。** 包更少，而且该页本就拥有提供方行。它也把适配器族的关切塞进了刻意不了解适配器族的页面，而那两个扩展座位的存在恰恰是为了让这类 UI 从外部到来。独立的包还让组合可以去掉登录而不失去 Models 页。

**提供 flow 注册的每一种方式，包括密钥提示。** 那是 seam 的完整供给，而且能让用户不碰密钥字段就配置任意提供方。它也会让一个提供方的同一份机密有两处存放位置——记录与引用——而只有该提供方自己的 README 解释请求会解析哪一处。

**把登录方法加进现有的 `credentials` namespace。** 两者在屏幕上相邻，在种类上却不相邻：一个写入调用方已经持有的取值，另一个运行一场带生命周期、单尝试规则与取消的对话。合并会让一个 namespace 拥有两套失败词汇。

**让登录成功后自动添加该提供方的路由。** 它能让 Codex 一键可用。它也会让一次登录写入 `settings.yaml`，而部署方提供哪些路由是 Models 页拥有的 settings 决定；那一行仍然是用户的明确动作。

## Consequences

用户可以在设置 → 模型中登录 ChatGPT Plus 或 Pro 账号，并以该订阅使用 Codex 模型。卡片显示已存的内容——订阅授权与提供方提示取得的密钥读法不同——而退出登录在本地忘记该记录，README 与用户指南都说明这不会在提供方一侧吊销任何东西。

Remote 面新增一个 namespace 与两个失败代码：`authorization/rejected`（在 `reason` 中携带 seam 自己的代码）与 `authorization/no-prompt`。转发事件白名单新增两个条目。没有任何会话事件、settings 键或存储格式发生变化，这里也没有任何东西进入模型请求。

有两项限制是继承而非修复的：一次尝试不可持久，因此登录途中刷新会丢弃它；每个键只允许一次尝试且是拒绝而非并入，每行上的 `inFlight` 让界面得以提前展示这一点。第三项是刻意的：只有记录 scope 为适配器族 settings namespace（`llm-pi-ai` 或 `llm-cursor`）的 flow 获得 Models 页座位，因为来自非适配器插件的 flow 没有可落座的提供方卡片。

共享的浏览器启动 fixture 新增一个 `authorization/list` 默认值，因为现在每个整客户端 roster 规格都会启动一个在挂载时读取该目录的插件。

## Testing

controller 套件覆盖 namespace 及其方法集合、缺失 seam 与缺失 provider 的诊断、格式错误的键、三种提问类型及其回答与拒答路径、flow 以自身信号撤回的提问、通过关闭流与通过第二次 `cancel` 调用的撤回、出错的 flow、返回却未提交的 flow、包含被拒绝删除在内的退出登录，以及在较早的流仍在被读完时较新的尝试保住自己的提问。一个真实组合测试通过实际 Loader 启动 seam、凭据存储、一个裸 `llm-pi-ai` 行与该 controller，并断言在未配置任何提供方的情况下列出 Codex 订阅登录——这正是手工挂载的 `ctx.plugin` 给不出的保障。

浏览器套件覆盖 flow 联接及其 scope 过滤、单次尝试的帧折入快照、回答与拒答路径、被拒绝的回答清除其提问、失败的流与从未结算的流、关闭时与第二次尝试时的撤回、带拒绝的退出登录、两处座位注册及其键与 locale、三种推送式失效、迟到的声明与声明方重载，以及两个座位共享一个 store。组件规格覆盖每种卡片状态与每种对话框状态，包括可复制的设备码。

此处未覆盖：无密钥的 Web e2e 场景。尝试的帧来自会打开浏览器并与外部端点通信的真实提供方 flow，因此脚本化的场景断言的将是本包自己的替身而非组装后的界面；Models 页的 golden 仍是该页本身的组装证据。
