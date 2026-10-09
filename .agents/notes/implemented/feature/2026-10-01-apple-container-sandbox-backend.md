# Agent Note: Apple container sandbox backend

Status: implemented

English | [中文](2026-10-01-apple-container-sandbox-backend.zh.md)

## Problem

The terminal profile confined bash, terminal, and PTC subprocesses with macOS Seatbelt through `@deepseek-ai/dsh-sandbox-local`. Seatbelt shares the host kernel, the host toolchain, and every readable host file, so a confined command could read anything the user can read, including keys, other repositories, and `.env` files, and was only stopped from writing. The model's `read`, `grep`, and `glob` tools read the host without any confinement. Apple's [`container`](https://github.com/apple/container) runs each Linux container in its own lightweight VM on Apple silicon and macOS 26, which bounds both reads and writes to what is explicitly mounted.

The [historical subprocess sandbox decision](../../archived/feature/2026-07-06-sandbox.md) rejected containers as `ctx.sandbox` backends because `confine(argv)` presupposes a shared filesystem. With the workspace bind-mounted at its own absolute host path, the shared-filesystem premise holds for every path a confined mode may write, so this note narrows that rule for a VM backend of this form.

## Decision

`@deepseek-ai/dsh-sandbox-apple-container` subclasses `LocalSandboxProvider` and registers as `ctx.sandbox`. Each session's backend is `container` or `local`: `local` calls the inherited local chain, and `container` wraps the argv in an exec shim that runs it inside a VM. The terminal bundle disables the base `sandbox` row and inserts this package with `backend: auto`, which selects `container` on macOS on Apple silicon when the `container` CLI resolves and `local` on every other host, so the npm-installed CLI behaves the same as before off the Mac.

### Containers

The provider owns one container per canonical workspace root and confined mode, shared by every session and subagent in that workspace and mode. It runs `node:22-bookworm` by default, with the workspace bind-mounted at its canonical and lexical paths (read-only under `read-only`), `.git` mounted read-only under `workspace-write`, configured extra directories such as skill roots mounted read-only, and secret files present at start masked to `/dev/null`. Disposal deletes owned containers; load deletes containers whose labelled owner process has exited; the default-mode container warms in the background.

### Execution shim

`confine` returns `[node, exec-shim.js, <executable>, <container>, <run dir>, <denylist>, '--', ...argv]`. The host-side shim carries the spawn's working directory, writes the environment minus credential-shaped names and URLs with embedded credentials to a private `--env-file`, and runs the argv under `setsid -w` in the guest. `container` 1.5.0 does not forward signals through `container exec`, so the shim signals the recorded guest process group itself. A start sentinel separates a runtime failure (exit 125 with a `dsh-container-exec: ` line, matched by the runner-failure rule) from a command that ran and failed. The guest writes the sentinel into a private host run directory mounted writable at `/run/dsh`, so the shim checks it on the host instead of paying a second `container exec` (about 60 ms) after every non-zero exit; the cost is one host directory that guest commands can write even under `read-only`, which DSH only deletes and never executes or reads. The built shim depends only on Node built-ins, so it runs under plain Node from the bundled npm package.

### Read scope

`SandboxProvider.readScope(policy)` reports the host paths confined processes can read; the base implementation returns `undefined` for unconfined reads. The container backend returns the workspace and extra mounts, minus hidden file names. `SandboxPolicyService.canRead` resolves the session policy and checks a canonicalized path against the scope, and the `read`, `edit`, `write`, `str_replace_editor`, `grep`, and `glob` tools refuse paths outside it before observing them; `grep` also excludes hidden names. The model's file tools therefore never read more than its confined commands.

### Session state and model visibility

A log-only `sandbox/backend` event records a `/sandbox` switch, folded by the `sandboxBackend` projection; the configured default applies before any switch. The shared `/sandbox` command on `ctx.commands` reports and switches the backend, and refuses `container` on unsupported hosts. A `sandbox:backend` runtime-context contribution tells the model, under the container backend and a confined mode, that commands run in a Linux container, that only the workspace is shared, and that secret files are hidden.

## Alternatives considered

**An environment-coherent capability group** (`subprocess-container`, `fs-container`, and `sandbox-container`, like the SSH family) — keeps the original rule intact, but is several times larger, and filesystem tools would lose the user's Mac outside the workspace. The workspace bind mount plus the read scope gives both sides the same view at a fraction of the cost.

**A shell executor only** (`bash-container` replacing `bash-sandbox`) — terminals, PTC, and every other `ctx.sandbox` consumer would keep running under Seatbelt, so one session would mix two confinement worlds.

**`container run --rm` per command** — measured at about 0.8 s per call against about 0.07 s for `container exec` into a running container.

**One container per session** — stronger isolation between sessions, but subagents would lose the parent's guest-side state and every session would pay a VM start.

**`container machine`** — mounts the whole home directory read-write, forwards the SSH agent, grants all capabilities, and configures passwordless sudo; that is closer to unconfined host execution than to a sandbox.

**Read confinement inside `ctx.fs`** — the filesystem provider also serves harness reads such as skills and settings that must reach paths outside the workspace, so the fence sits in the model-facing tools that read on the model's behalf.

**An environment allowlist** — would drop variables the harness passes deliberately, such as pager settings; a credential-shaped denylist that applies even to explicit entries keeps those while withholding keys and tokens.

**Alpine as the default image** — musl and missing `bash`, `git`, and util-linux `setsid` break common agent commands.

## Consequences

Confined commands on a supported Mac cannot read or change host files outside the workspace, cannot see secret files present at start or credential environment variables, and cannot plant Git hooks for the host to run. The model's file tools share that read view. Off the Mac, the terminal profile keeps the previous local sandbox.

The cost is a different toolchain: Darwin-native binaries in the workspace do not run in the Linux guest, so those projects use `/sandbox local`. Secret files created after a container starts stay readable inside it until it restarts, `.git` writes need an escalation, terminal resizes do not reach the guest, subagents start on the default backend, and the first command after install may wait for the image pull. The Auto permission keeps this backend instead of switching to full access ([Auto keeps the sandbox](../bug-fix/2026-10-04-auto-keeps-container-sandbox.md)). Builds older than this change refuse logs containing `sandbox/backend`. The `-v` parsing, signal-forwarding, and single-file-mount workarounds must be revisited when `container` is upgraded.

## Testing

Unit tests drive the provider, pool, runtime, shim, scan, and host resolution against a fake `container` CLI at full per-file coverage, and each file tool's read fence has its own suite. `tests/apple-container.e2e.ts` runs against the real runtime and checks the Linux guest, host-visible workspace writes, unreadable host files and secrets, read-only `.git`, read-only denial classification, and cancellation; it skips where `container system status` fails.
