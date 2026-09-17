# Agent Note: TUI 订阅登录的浏览器交接

Status: implemented

[English](2026-09-16-tui-subscription-sign-in-browser-handoff.md) | 中文

## Problem

pi-ai 的 OAuth 登录自身从不打开浏览器：它们发出 `auth_url` 或 `device_code` 事件后，立刻让手输码提示与本地回调赛跑。Web 的 Models 页面把 notice 的 URL 渲染为真正的链接，因此那里可以登录。终端只是把 URL 打印进对话记录并把焦点交给手输码模态框；既没有打开也没有可点击的链接，订阅登录因此不可用——OpenAI Codex 的说明甚至写着「A browser window should open」，而 Anthropic 没有设备码替代路径。终端在登录提示被取消时还抛出普通 `Error`，把人的「不」报成失败，而非 seam 定义的 `cancelled`；`/login` 也从不说明休眠的提供方路由仍需要其 settings profile，存储的凭据才可用。

## Decision

`AuthorizationNotice` 新增 `openInBrowser?: true`，经 Remote 的 `AuthorizationNoticeFrame` 一路传入登录客户端 store。llm-pi-ai 的中继只为 pi-ai 的 `auth_url` 与 `device_code` 事件设置它，绝不用于 `info` 链接，因为只有 flow 知道授权目标页与信息页的区别。终端的 notify 处理始终打印消息、URL 与码，并对被标记的 notice 以即发即弃方式经 `openNativeUrl` 把 URL 交给默认浏览器——`openNativeUrl` 是 `dsh-native-command` 的新导出，承载 Web 应用先前私有的凭据擦除辅助启动器；Web 应用现在消费同一导出。终端在 SSH 启动、无桌面宿主以及新的 `--no-open` 调用项 / `openBrowser` 配置下抑制该交接，并把打开器失败报为 URL 旁的一条通知，绝不报成登录失败。被取消的登录提示抛出 `AuthorizationDeclinedError`，从而以 `cancelled` 结算。README 记录登录只存储凭据、不会激活休眠路由（先 `/settings llm-pi-ai providers.<id> {}`）。

## Alternatives considered

**自动打开每一条 notice URL。** 拒绝，因为 pi-ai 的 `info.links` 也映射进同一个 `url` 字段；信息链接绝不能弹出浏览器。显式标记把这一区分留在知情的 flow 一侧。

**在 llm-pi-ai 的 flow 内打开浏览器。** 拒绝，因为浏览器交接是界面职责：无头组合运行同一批 flow，而 seam 已经通过请求的 interaction 路由与人的交互。

**调用既有的 `openNativePath(url)`。** 拒绝，因为该打开器只面向文件系统，在 WSL 下会对 URL 执行 `wslpath -w`。

**让授权 seam 在提交后创建提供方路由。** 拒绝，因为路由配置属于 LLM 可配置提供方与 settings 能力；从凭据键推导 settings 路径会耦合两个 seam。改由文档点名该前置条件。

## Consequences

- 在桌面本地启动中，`/login` 与 `/signin` 会把被标记的授权页面在默认浏览器中打开，URL 与码始终打印作为后备；SSH 与 `--no-open` 保留手动与设备码路径。
- 被取消的登录提示在终端以 `cancelled` 结算，与 Web 一致。
- notice 词汇、其 Remote 帧与登录客户端 store 都携带 `openInBrowser`；Web 对话框与之前一样渲染链接。
- `dsh-tui-app` 依赖 `dsh-native-command` 与 `dsh-launch-environment`；`dsh-web-app` 删除其私有启动器以及 `open` 与 `dsh-subprocess` 两条依赖边。

## Related decisions

终端命令仍由 [TUI `/login` 与 Shift+Tab 推理强度循环](../feature/2026-09-15-tui-login-and-effort-cycle.zh.md) 拥有，Web 界面由 [浏览器提供方登录](../feature/2026-09-14-browser-provider-sign-in.zh.md) 拥有，seam 词汇由 [凭据记录与授权 flow](../architecture/2026-08-13-credential-records-and-authorization-flows.zh.md) 拥有。
