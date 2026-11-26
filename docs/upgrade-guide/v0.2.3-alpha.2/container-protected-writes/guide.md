---
kind: upgrade-guide
description: "Host file tools and host-bound workers now respect the Apple container backend’s protected paths."
---

# Protected writes in container sessions

English | [中文](guide.zh.md)

## Change

In a TUI container session with `workspace-write`, host file tools and host-bound workers could modify paths that the guest mounted read-only. They now refuse writes under `protectedPaths` (by default `.git`) and `readOnlyMounts`, including when a writable root also covers the target.

## Migration

1. Direct generated files and other routine edits to an ordinary writable workspace directory.
2. For an intentional repository metadata change, perform the operation yourself or review a one-call escalation. A confined file-tool write to a protected path reports `FS_SANDBOX_DENIED`.
