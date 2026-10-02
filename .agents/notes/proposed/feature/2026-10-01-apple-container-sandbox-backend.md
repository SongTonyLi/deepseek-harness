# Agent Note: Apple container sandbox backend

Status: proposed

## Problem

The terminal (TUI) profile confines bash, terminal, and PTC subprocesses with macOS Seatbelt through `@deepseek-ai/dsh-sandbox-local`. Seatbelt shares the host kernel, the host toolchain, and every readable host file, so a confined command can read anything the user can read and is only stopped from writing. Apple's [`container`](https://github.com/apple/container) runs each Linux container in its own lightweight virtual machine on Apple silicon and macOS 26, which bounds both reads and writes to what is explicitly mounted. TUI users on macOS want that VM boundary as the default confinement, with a per-session way to fall back to Seatbelt for projects that need the host toolchain.

The [subprocess sandbox decision](../../implemented/feature/2026-07-06-sandbox.md) rejected containers as `ctx.sandbox` backends because `confine(argv)` presupposes a shared filesystem. With the workspace bind-mounted at its own absolute host path, the shared-filesystem premise holds for the workspace, which is the only host area any confined mode may write. This note amends that decision for this backend only.

## Proposal

### Package

`@deepseek-ai/dsh-sandbox-apple-container` at `packages/sandbox/sandbox-apple-container/` registers as `ctx.sandbox` and implements `confine(argv, policy, signal)`.

Each session's backend is `container` or `local`. The `local` backend delegates every call to an embedded `@deepseek-ai/dsh-sandbox-local` provider mounted in an isolated child context, so `local` is byte-for-byte today's Seatbelt behavior. `danger-full-access` never reaches `confine`, so it runs on the host under both backends.

### Container lifecycle

- One container per `(canonical workspace root, confined mode)`, shared by every session and subagent in that workspace and mode, so a parent and its subagents see one Linux world.
- Created on first use with `container run -d --init --rm --label dsh.pid=<pid> --mount type=bind,source=<root>,target=<root>[,readonly] <image> sleep infinity`; `readonly` is set for `read-only`. When the lexical root differs from the canonical root, the lexical path is mounted too. A root containing `,` fails loud because `--mount` cannot express it.
- The `-v src:dst:ro` form is not used: `container` 1.5.0 mis-parses it into a read-write mount at a different path.
- At plugin load, the `workspace-write` container for the configured workspace root starts in the background so the first image pull does not block the first command.
- On dispose, every owned container is deleted with `container delete --force`. At load, containers labelled with a `dsh.pid` whose process no longer exists are deleted.
- When `container system status` reports the API server stopped and `autoStart` is true, the plugin runs `container system start` once. A missing executable or a failed start throws `SandboxUnavailableError` naming `/sandbox local` as the fallback.

### Execution shim

`confine` returns `[process.execPath, <exec-shim.js>, <executable>, <container>, <denylist>, '--', ...argv]`. The host-side shim:

1. Uses its own `process.cwd()` as the guest working directory (`-w`).
2. Writes its environment, minus the `envDenylist` keys and any value containing a newline, to a private temporary `--env-file`, so values never appear in process arguments.
3. Adds `-i`, plus `-t` when stdin is a TTY.
4. Runs the argv under `setsid -w sh -c` in the guest; the wrapper records its process-group id in `/run/dsh-<token>.pid` and a start sentinel in `/run/dsh-<token>.started`, and removes both after a zero exit.
5. On `SIGTERM`, `SIGINT`, or `SIGHUP`, runs `container exec <id> sh -c 'kill -<sig> -$(cat /run/dsh-<token>.pid)'`, because `container` 1.5.0 does not forward signals through `container exec`, then exits with `128 + signal number`.
6. After a nonzero exit, removes the token files and checks the start sentinel. A missing sentinel means the runtime failed before the command started: the shim prints `dsh-container-exec: ` followed by the reason and exits 125.

The shim resolves from the built `lib/` entry like the windows-acl runner, with the tsx source fallback. The image must provide `sh` and util-linux `setsid`.

### Confinement facts

- `enforcement: 'full'`: host file effects are limited to the mounted workspace, and the guest cannot read unmounted host paths.
- `denialSignatures: ['read-only file system']`, so a `read-only` write denial feeds the existing escalation path, whose approved retry runs in the `workspace-write` container.
- `runnerFailureRules: [{ allowedExitCodes: [125], fatalSignatures: ['dsh-container-exec: '] }]`. The `container` CLI's own `Error:` lines are not matched, because ordinary commands print the same prefix.
- A cached container is re-inspected at most once per `recheckMs` per confine; a container that disappeared is recreated.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `backend` | `container` | Deployment default backend for sessions without a recorded choice |
| `executable` | `container` | The `container` CLI, resolved on `PATH` |
| `image` | `node:22-bookworm` | OCI image every owned container runs |
| `cpus`, `memory` | unset | Per-container resources; unset uses `container` system defaults |
| `autoStart` | `true` | Start the `container` API server once when it is stopped |
| `recheckMs` | `10000` | Minimum interval between liveness checks of a cached container |
| `envDenylist` | host-specific keys (`PATH`, `HOME`, `TMPDIR`, `SHELL`, `USER`, `LOGNAME`, `PWD`, `OLDPWD`, `SHLVL`, `SSH_AUTH_SOCK`, `__CF*`, `XPC_*`, `DYLD_*`, `TERM_PROGRAM*`) | Environment keys the shim does not forward; a trailing `*` matches a prefix |
| `local` | `{}` | Config passed to the embedded `dsh-sandbox-local` |

### Session state and model visibility

- A log-only `sandbox/backend` session event records a runtime switch, following the `sandbox/mode` precedent; the `sandboxBackend` session-projection unit folds it. The effective backend is the last event's value, otherwise the deployment default. Agentless calls use the deployment default.
- A `sandbox:backend` runtime-context contribution at the centrally allocated `SANDBOX_BACKEND` order tells the model, when the session resolves to the `container` backend and a confined mode, that confined commands run in a Linux container from image `<image>`, that only the workspace root is shared with the host, and that writes elsewhere stay inside the container. Under `local` or `danger-full-access` the contribution is empty.
- The provider registers a shared `/sandbox` command on `ctx.commands`. `/sandbox` reports the backend, image, and container state; `/sandbox container` and `/sandbox local` append `sandbox/backend`, and the next confined call uses the new backend.

### TUI

- `packages/bundle/tui-app/cordis.patch.yml` replaces the base `sandbox` entry with this package and sets `backend` to `container` on macOS arm64 and `local` elsewhere, so Linux CI keeps local confinement.
- The TUI already dispatches unknown slash commands to `ctx.commands`, so `/sandbox` needs no terminal-local handler.

## Alternatives considered

**An environment-coherent capability group** (`subprocess-container`, `fs-container`, and `sandbox-container`, like the SSH family) — keeps the original decision intact, but is several times larger, and filesystem tools would see the container root instead of the user's Mac outside the workspace. The workspace bind mount gives both sides the same workspace view at a fraction of the cost.

**A shell executor only** (`bash-container` replacing `bash-sandbox`) — terminals, PTC, and every other `ctx.sandbox` consumer would keep running under Seatbelt, so one session would mix two confinement worlds.

**`container run --rm` per command** — measured at about 0.8 s per call against about 0.07 s for `container exec` into a running container.

**One container per session** — stronger isolation between sessions, but subagents would lose the parent's guest-side state (installed packages, `/tmp` files), and every session would pay a VM start.

**`container machine`** — mounts the whole home directory read-write, forwards the SSH agent, grants all capabilities, and configures passwordless sudo; that is closer to unconfined host execution than to a sandbox.

**Alpine as the default image** — musl and missing `bash`, `git`, and util-linux `setsid` break common agent commands.

## Acceptance criteria

- `pnpm dsh --profile tui` on a macOS 26 host with `container` installed runs bash tool calls inside the `node:22-bookworm` container; `uname -s` reports `Linux`.
- In `read-only` mode a write under the workspace fails with `Read-only file system` and offers the existing escalation; in `workspace-write` mode the write lands in the host workspace owned by the host user.
- Aborting a running command kills the guest process group.
- `/sandbox` shows the backend and container state; `/sandbox local` makes the next command run under Seatbelt on the host; the choice survives `/resume`.
- Without `container` on `PATH`, a confined call fails with `SANDBOX_UNAVAILABLE` whose message names `/sandbox local`.
- Unit tests reach 100% per-file coverage with a fake `container` executable; a real-runtime e2e test self-skips when `container` is absent; a keyless TUI snapshot covers `/sandbox`.

## Risks

- Darwin-native binaries in the workspace, such as `node_modules` native addons built on the host, do not run in the Linux guest; `/sandbox local` is the fallback.
- Host filesystem tools and guest commands disagree about paths outside the workspace.
- Terminal resizes (`SIGWINCH`) do not reach guest processes.
- The first command after install waits for a roughly 400 MB image pull when the background warm-up has not finished.
- Builds older than this change refuse logs containing `sandbox/backend`, as with any new required event.
- Upstream `container` releases are product versions; the `-v` parsing and signal-forwarding workarounds must be revisited on upgrade.
