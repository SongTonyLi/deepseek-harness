---
kind: upgrade-guide
description: "TUI 忽略 DSH_TOOLS_MODE，并通过执行器插件选择工具执行方式。"
---

# 通过 patch 选择 TUI 工具执行器

[English](guide.md) | 中文

## 变更

TUI 不再把 `DSH_TOOLS_MODE` 转发到已移除的 `dsh-tools.mode` 设置。它忽略该环境变量，并从 `dsh-base` 继承原生执行方式，与其他内置配置档案一致。此前通过 `DSH_TOOLS_MODE=ptc` 选择 PTC 的启动环境必须改用执行器 patch。直接向 `dsh-tools` 传入 `mode` 仍会报错；[执行器迁移](../../v0.2.1-rc.2/tool-executor-plugins/guide.zh.md)介绍了自定义组合的迁移方式。

## 迁移

1. 从 shell 启动文件、启动脚本与服务环境中移除 `DSH_TOOLS_MODE`。原生执行不需要 patch。
2. 如需 PTC，将下列内容保存为 `ptc.yml`，并使用 `dsh --profile tui --patch ./ptc.yml` 启动。内置 base 已挂载 PTC 运行时。

```yaml
- id: tool-executor-native
  disabled: true

- id: tool-executor-ptc
  disabled: false
```

3. 确认 PTC 模式下模型只收到 `run_code`，原生模式下则收到各个独立工具。残留的 `DSH_TOOLS_MODE` 值不会覆盖该 patch。
