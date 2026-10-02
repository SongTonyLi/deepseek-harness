---
kind: upgrade-guide
description: "The terminal profile confines commands in an Apple container VM on macOS on Apple silicon, and its sandbox row moves to `sandbox-apple-container`."
---

# The terminal profile confines commands in an Apple container on macOS

English | [中文](guide.zh.md)

## Change

Before, `dsh --profile tui` confined bash, terminal, and PTC commands with the base `sandbox` row (`@deepseek-ai/dsh-sandbox-local`, Seatbelt on macOS), and the model's file tools could read any host path.

Now the terminal bundle disables that row and inserts `sandbox-apple-container` (`@deepseek-ai/dsh-sandbox-apple-container`) with `backend: auto`. On macOS on Apple silicon with the [`container`](https://github.com/apple/container) CLI installed, confined commands run in a Linux VM that mounts only the workspace, `.git` is read-only under `workspace-write`, secret files and credential environment variables are hidden, and `read`, `edit`, `write`, `str_replace_editor`, `grep`, and `glob` refuse paths outside the workspace and the read-only skill roots. On every other host, the row keeps the previous local sandbox. `/sandbox` reports and switches a session's backend.

Affected: macOS terminal users whose commands need host-only tools or read paths outside the workspace, and profile patches that configure the `sandbox` row.

## Migration

1. To use the container, install and start it: `brew install container`, then `container system start`.
2. To keep the previous behavior for one session, run `/sandbox local`. To keep it for every session, add this to your profile's `cordis.patch.yml`:

   ```yaml
   - id: sandbox-apple-container
     config:
       backend: local
   ```

3. Move any configuration you set on the `sandbox` row (`runnerCommand`, `runnerFailureSignatures`, `probeTimeoutMs`) to the `sandbox-apple-container` row; the `sandbox` row is disabled in the terminal profile.
4. Confirm with `/sandbox`: it prints `backend container` with the image and container state, or `backend local`.
