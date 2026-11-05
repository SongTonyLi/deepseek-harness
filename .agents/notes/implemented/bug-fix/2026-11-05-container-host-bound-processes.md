# Agent Note: Host-bound processes confine on the host under a read fence

Status: implemented

English | [中文](2026-11-05-container-host-bound-processes.zh.md)

## Problem

The terminal profile's [Apple container backend](../feature/2026-10-01-apple-container-sandbox-backend.md) runs every confined argv in a Linux VM through `container exec`. The Node PTC worker that runs workflows starts the host Node executable and a host bootstrap file, and it talks to the host over a control pipe that the subprocess provider passes at file descriptor 7. The guest has neither file, and `container exec` forwards only stdin, stdout, and stderr. On a Mac with the `container` CLI, every workflow in a confined session therefore failed before its first child started:

```text
Error: workflow run failed: workflow execution failed (worker-exit): Node process exited (127, signal null): sh: 1: /opt/homebrew/Cellar/node/25.9.0_2/bin/node: not found
```

Switching the session to `/sandbox local` or to full access was the only workaround.

## Decision

`SandboxProvider.confineHostBound(argv, policy, { runtimePaths }, signal)` wraps a host-bound execution: a process that must stay in the subprocess provider's execution world, because it starts that world's executable or files outside the shared workspace, or because it inherits descriptors beyond stdio. The base implementation is `confine`, which every host-kernel provider already applies in that world. The Node PTC worker calls it and names its executable plus the bootstrap's script directory, or the source checkout, as runtime paths.

The container backend overrides it. A local-backend session gets the inherited local chain unchanged. A container session gets the local Seatbelt chain with the policy's write rules plus a read fence, which `LocalSandboxProvider.confineWithReadFence` adds to the profile. The fence denies `file-read-data` under `hostBoundUnreadableRoots`, `/Users` and `/Volumes` by default. It allows it again under the container read scope, the policy's writable roots, and the runtime paths, and it denies it for `hiddenFiles` names everywhere. Seatbelt applies the last matching rule and matches resolved paths, so symlinks and firmlinked spellings stay inside the fence, and it refuses a new hard link to a denied file. Only the Seatbelt rung expresses the fence; another runner or a configured `runnerCommand` fails closed with `SANDBOX_UNSUPPORTED_POLICY`.

Work the worker starts keeps its own confinement: a workflow child's commands still run in the container.

## Alternatives considered

**Run the worker in the guest.** It needs the guest's Node in place of the host executable, the bootstrap inside the guest, and a relay that multiplexes the control channel with program output over `container exec` stdio on both sides; `container run --publish-socket` publishes a socket only when the container starts. That is a second transport beside the [SSH helper](../../../../packages/ssh/ssh/README.md), and a worker on the guest image's Node 22 would diverge from the host runtime.

**Confine the worker with plain Seatbelt.** A workflow script reaches Node through its hook functions, because the workflow VM is not a security boundary. Without a read fence, a script could read keys and other repositories that the container keeps away from commands and file tools.

**An allow-list read fence.** Denying every read outside named roots must also name every directory Node reads to start, and those differ across Homebrew, nvm, and asdf installations.

**Detect PTC argv inside `confine`.** The provider would guess intent from argv shape, and other host-bound consumers could not opt in.

**Hide the workflow tool in container sessions.** The tool is registered once per composition, while the backend changes per session through `/sandbox`.

## Consequences

Workflows complete in the terminal profile's default container sessions, and their children keep running commands in the VM. A script that escapes the workflow VM can read host paths outside `/Users` and `/Volumes`, such as `/etc`, `/opt`, and the temp areas, and it can read file metadata everywhere. It cannot read file contents in home directories outside the workspace, the read-only mounts, the writable roots, and its runtime files, and it cannot read secret files. The guest exposes none of those host paths, so the fence is weaker than the VM.

The experimental Python PTC runtime still calls `confine` and fails in container sessions.

Unit tests pin the Seatbelt fence text, the protected wrap's refusals, the provider routing, and the worker's runtime paths. A Seatbelt end-to-end test proves that the fence denies contents, symlink aliases, listings, new hard links, and case variants of hidden names. A terminal end-to-end test runs a workflow in a workspace-write container session through the shipped profile and fails without this change. Both end-to-end tests skip where their runtime is unavailable.

## Related decisions

- [Apple container sandbox backend](../feature/2026-10-01-apple-container-sandbox-backend.md) — the backend and its read scope.
- [Reuse the PTC Node sandbox for workflows](../architecture/2026-09-13-workflow-ptc-sandbox-reuse.md) — why workflows run in the PTC process.
