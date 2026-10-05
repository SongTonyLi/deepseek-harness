---
kind: upgrade-guide
description: "The Auto permission keeps the Apple container sandbox in the terminal instead of switching the session to full access, and its reviewer answers escalations."
---

# Auto keeps the container sandbox in the terminal

English | [中文](guide.zh.md)

## Change

Before, `/permission auto` wrote `danger-full-access`. In `dsh --profile tui` on the Apple container backend, the session's commands then ran on the host and its file tools could read the whole host, so the Auto reviewer was the only barrier.

Now, while a session runs on the Apple container backend, Auto writes `workspace-write` and commands stay confined in the container. A call that must leave it, such as a one-shot `sandbox_permissions` escalation or a read outside the workspace, is decided by the Auto reviewer instead of you; a call the reviewer denies still asks you. On every other backend, and in Web, Auto still writes `danger-full-access`.

A session saved with Auto at `danger-full-access` is confined at its next call once it runs on the container. Switching backends with `/sandbox` never widens a confined Auto session.

Affected: terminal users on macOS with the `container` CLI who use Auto, particularly for Darwin-native toolchains or files outside the workspace. `.git` is read-only in the container, so a commit needs an escalation that the reviewer decides.

## Migration

1. To run Auto on the host as before, switch the session to the local backend and select Auto again:

   ```text
   /sandbox local
   /permission auto
   ```

   To make the local backend the default for every session, set `backend: local` on the `sandbox-apple-container` row of your profile's `cordis.patch.yml`.
2. To keep the container, change nothing.
3. Confirm with `/sandbox`: the picker header prints `file policy: workspace-write` on the container and `file policy: danger-full-access` after step 1.
