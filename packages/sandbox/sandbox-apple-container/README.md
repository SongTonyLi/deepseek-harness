---
description: "The Apple container sandbox backend for users and maintainers who run confined commands in a per-workspace Linux VM on macOS and switch sessions between the container and the local sandbox."
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-apple-container

English | [中文](README.zh.md)

## Summary

Use this package to run confined bash, terminal, and PTC commands inside an [Apple `container`](https://github.com/apple/container) Linux VM on macOS on Apple silicon. The VM mounts only the session workspace at its host path, so commands cannot read or change other host files, and the model's file tools are held to the same read scope. Secret files such as `.env` are masked, credential-shaped environment variables never reach the guest, and `.git` stays read-only. On every other host, and for sessions switched with `/sandbox local`, the package confines through the inherited local sandbox chain.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package in place of `@deepseek-ai/dsh-sandbox-local` as the `ctx.sandbox` provider, beside `@deepseek-ai/dsh-sandbox-policy`. The shipped terminal profile does so: it disables the base `sandbox` row and inserts this package with `backend: auto`.

### When to choose it

Choose it when confined commands should not see the user's home directory, keys, or other repositories, and the host is a Mac with Apple silicon, macOS 26, and the `container` CLI installed (`brew install container`, then `container system start`). Keep the local provider when commands need host-only toolchains, such as Xcode or Darwin-native `node_modules` binaries.

### Minimal configuration

```yaml
- id: sandbox
  disabled: true
- insert:
    - name: '@deepseek-ai/dsh-sandbox-apple-container'
      config:
        backend: auto
```

| Field | Default | Meaning |
|---|---|---|
| `backend` | `auto` | Default backend: `auto` selects `container` on macOS on Apple silicon when the CLI resolves and `local` elsewhere; `container` and `local` are fixed |
| `executable` | `container` | The `container` CLI, resolved on `PATH` when bare |
| `image` | `node:22-bookworm` | OCI image every owned container runs; it must provide `sh` and util-linux `setsid` |
| `cpus`, `memory` | unset | Per-container resources; unset uses the `container` system defaults |
| `autoStart` | `true` | Run `container system start` once when the API server is stopped |
| `recheckMs` | `10000` | Minimum interval between liveness checks of a cached container |
| `envDenylist` | host paths plus `*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*PASSWD*`, `*CREDENTIAL*`, `*COOKIE*`, `*PRIVATE*`, `AWS_*` | Environment name globs never forwarded to the guest, even when a composition passes them explicitly |
| `readOnlyMounts` | `[]` | Absolute host directories mounted read-only at their own paths and readable by file tools; the terminal profile mounts the user skill roots |
| `protectedPaths` | `['.git']` | Workspace-relative directories mounted read-only under `workspace-write` |
| `hiddenFiles` | `.env`, `.env.*`, `.envrc`, private-key and certificate names, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials` | File-name globs masked in the guest and refused by file tools |
| `hiddenFilesMaxDepth`, `hiddenFilesSkipDirs` | `8`, `['node_modules', '.git']` | Bounds of the workspace scan that finds files to mask when a container starts |

The fields of `@deepseek-ai/dsh-sandbox-local` also apply to the `local` backend. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-sandbox-apple-container) is the exhaustive source for every field and its JSDoc.

### Switching a session

`/sandbox` reports the session's backend, the image, and each owned container's state. `/sandbox container` and `/sandbox local` record a `sandbox/backend` event; the session's next confined call uses the new backend, and the choice survives restart. `/sandbox container` is refused on hosts that cannot run Apple `container`.

### What confinement covers

| Threat | Behavior under the container backend |
|---|---|
| A command reads host files outside the workspace | The path does not exist in the guest |
| A file tool reads outside the workspace | `read`, `edit`, `write`, `str_replace_editor`, `grep`, and `glob` refuse it through the read scope |
| A command or tool reads a secret file in the workspace | Masked to `/dev/null` in the guest; refused by file tools; excluded from `grep` |
| A credential reaches the guest environment | Denied names and URLs carrying `user:password@` are never forwarded |
| A command plants a Git hook or config the host later runs | `.git` is read-only under `workspace-write`; writes fail with `Read-only file system` and use the normal escalation |
| A command writes outside the workspace | The write lands in the container's own disk and never reaches the host |

`danger-full-access` bypasses `confine`, so it runs on the host under either backend.

### Failures and recovery

Missing CLI, a stopped API server that cannot start, or a failed `container run` rejects the confined call with `SANDBOX_UNAVAILABLE`, and the message names `/sandbox local`. A `read-only` write denial reports `Read-only file system`, which the tool layer offers for the standard one-time escalation. Invalid `envDenylist`, `readOnlyMounts`, `protectedPaths`, or `cpus` values fail at load.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Containers

The provider owns one container per canonical workspace root and confined mode, shared by every session and subagent in that workspace and mode. It starts with `container run --detach --init --rm`, labelled with the owning process id, bind-mounted with `--mount type=bind,…` (the `-v src:dst:ro` form is not used because `container` 1.5.0 misparses it), and idles on `sleep infinity`. A cached container is re-inspected at most once per `recheckMs` and restarted when gone; disposal deletes every owned container, and load deletes containers whose labelled process has exited. When the default backend is `container` and the deployment default mode is confined, the default-mode container starts in the background at load.

### Execution shim

`confine` returns `[node, exec-shim.js, <executable>, <container>, <denylist>, '--', ...argv]`. The shim runs on the host with the caller's working directory and environment, writes the filtered environment to a private `--env-file`, and runs `container exec -i [-t] -w <cwd>` with the argv under `setsid -w` in the guest. Because `container exec` does not forward signals, the shim records the guest process-group id and signals that group itself; a forwarded signal exits `128 + n`. A start sentinel separates a runtime failure, reported as `dsh-container-exec: …` with exit 125 and classified by the runner-failure rule, from a command that ran and failed. The built `lib/exec-shim.js` depends only on Node built-ins and runs under plain Node in the npm-installed CLI; a source checkout launches `src/exec-shim.ts` through tsx.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider: config, per-session routing, `readScope`, `/sandbox`, context contribution, warm-up and sweep |
| [`src/pool.ts`](src/pool.ts) | Owned containers, mounts, masks, liveness recheck, disposal |
| [`src/runtime.ts`](src/runtime.ts) | Typed `container` CLI calls |
| [`src/shim.ts`](src/shim.ts), [`src/exec-shim.ts`](src/exec-shim.ts) | Exec-shim logic and its process entry |
| [`src/secrets.ts`](src/secrets.ts) | Workspace scan for files to mask |
| [`src/host.ts`](src/host.ts) | Host support and `auto` resolution |
| [`src/session-backend.ts`](src/session-backend.ts) | The `sandbox/backend` event and its write path |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Process sandbox subsystem](../../../docs/subsystems/sandbox.md) — modes, per-call policy, and the read scope.
- [Apple container sandbox decision](../../../.agents/notes/implemented/feature/2026-10-01-apple-container-sandbox-backend.md) — why a VM backend joins the sandbox seam, and the alternatives.
- [Local provider](../sandbox-local/README.md) — the backend this package inherits for `local` sessions.

-----

<a id="model-experience"></a>
## Model Experience

### Container backend context

#### What the model sees

One `sandbox:backend` contribution in the runtime-context snapshot when the session resolves to the `container` backend under a confined mode; it is empty under `local` and `danger-full-access`. `<image>` and `<workspace root>` are JSON-quoted.

##### Container backend

```markdown
Commands confined by the DSH file sandbox run inside a Linux container from image <image>. Only the session workspace <workspace root> is shared with the host; files written elsewhere stay inside the container and are not visible to file tools. File tools cannot read host paths outside the workspace, and secret files such as `.env` and private keys are hidden from commands and file tools.
```

#### Token effect

About sixty tokens in the context snapshot of the first request and of each request after the backend or mode changes the text; unchanged requests add nothing.

#### KV Cache effect

The stable system prompt is unchanged. A changed context snapshot is appended after retained history, preserving the cached prefix; switching the backend or mode is the only package-owned change to the text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Masks cover files present at container start** — `container` masks only paths that exist at creation, so a secret file created later is readable by commands in the running container until it restarts; file tools refuse it immediately.
- **Single-file mounts are unsupported** — `container` 1.5.0 binds only directories, so protection works per directory (`.git`), not per file (`.git/config`).
- **Subagents start on the default backend** — a child session does not inherit its parent's `/sandbox` choice.
- **Terminal resizes do not reach the guest** — `container exec` does not forward `SIGWINCH`.
- **Host and guest toolchains differ** — Darwin-native binaries in the workspace do not run in the Linux guest; use `/sandbox local` for those projects.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Revisit the `-v` parsing, signal-forwarding, and single-file-mount workarounds when upgrading `container`; its releases are product versions, not semantic versions.

</details>
