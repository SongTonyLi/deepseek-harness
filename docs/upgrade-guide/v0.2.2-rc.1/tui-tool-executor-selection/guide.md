---
kind: upgrade-guide
description: "TUI ignores DSH_TOOLS_MODE and selects tool execution through executor plugins."
---

# Select the TUI tool executor with a patch

English | [中文](guide.zh.md)

## Change

The TUI no longer forwards `DSH_TOOLS_MODE` to the removed `dsh-tools.mode` setting. It ignores that environment variable and inherits native execution from `dsh-base`, matching the other shipped profiles. Launch environments that selected PTC with `DSH_TOOLS_MODE=ptc` must use an executor patch instead. Passing `mode` directly to `dsh-tools` remains an error; the [executor migration](../../v0.2.1-rc.2/tool-executor-plugins/guide.md) documents custom compositions.

## Migration

1. Remove `DSH_TOOLS_MODE` from shell startup files, launch scripts, and service environments. Native execution needs no patch.
2. For PTC, save the following as `ptc.yml` and launch with `dsh --profile tui --patch ./ptc.yml`. The shipped base already mounts the PTC runtime.

```yaml
- id: tool-executor-native
  disabled: true

- id: tool-executor-ptc
  disabled: false
```

3. Confirm that the model receives only `run_code` in PTC mode, or the individual tools in native mode. A leftover `DSH_TOOLS_MODE` value does not override the patch.
