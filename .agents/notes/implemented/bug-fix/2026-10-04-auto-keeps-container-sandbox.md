# Agent Note: Auto keeps the sandbox on a backend that confines reads

Status: implemented

English | [中文](2026-10-04-auto-keeps-container-sandbox.zh.md)

## Problem

[Auto review](../feature/2026-08-28-auto-review.md) bundles the Full access sandbox mode, `danger-full-access`, with its per-call reviewer. Every enforcing consumer skips confinement under that mode, so on the terminal profile's [Apple container backend](../feature/2026-10-01-apple-container-sandbox-backend.md) selecting Auto ran commands on the host and let the file tools read the whole host. The model-based reviewer became the only barrier, and the isolation the user had chosen was dropped without a prompt or a notice.

## Decision

Auto resolves its sandbox value for the session when it is selected. While the session's backend confines reads, `SandboxPolicyService.confinesReads(session)` is true and Auto writes `workspace-write`; otherwise Auto writes `danger-full-access` as before. Today only the container backend confines reads. The value is an ordinary logged `sandbox/mode`, so the persistent-terminal mode fence, the projections, and the model-visible policy text read the mode that is enforced. A stored Auto selection keeps its identity under either value, so a Session recorded before this decision still resolves to Auto and keeps its review gate.

The reviewer, not the user, answers the approvals a call raises. A prepended `approval/request` listener answers `allowed-once` for a request that names a call the reviewer allowed, while that call runs and the Session is still in Auto. That covers a one-shot `sandbox_permissions` escalation and a read outside the workspace. A reviewer denial still asks the user about the call, and the approvals of a call the user then allows reach the user as well. A downstream listener's own ask is never answered, and an escalation of the unreviewed `run_code` transport still asks the user. A delegated child pins `never`, so its escalations are rejected before any answerer runs.

Before any call body, including the `run_code` transport, the pre-execute listener calls the preset service's `confineAuto`, which narrows a session that still has `danger-full-access` while its backend confines reads. That covers a Session recorded before this decision and one switched to the container afterwards, and it appends only the sandbox mode, so the identity and the approval policy a delegated child pins are unchanged. The step only tightens: a backend switch never widens a confined Auto session, so after `/sandbox local` the user selects Auto again to return to Full access on the host. A rejected change, such as the terminal fence, fails the call instead of running it under the stale mode.

Unloading the integration migrates a confined Auto session to Workspace Write and any other Auto session to Full access, so migration keeps each session's sandbox value. The terminal's backend picker previews the container as confined for an Auto session that is still at full access.

## Alternatives considered

**Derive the confined mode when the policy resolves.** The log would keep `danger-full-access`, so switching from Full access to Auto would append no `sandbox/mode` event and the persistent-terminal fence would never fire. An unconfined terminal could outlive the switch inside a Session that claims container confinement, and the log, the model-visible policy, and enforcement would disagree.

**Keep full access and only warn.** The reviewer stays the only barrier and the reported bypass remains.

**Confine Auto on every backend.** Host-kernel providers confine writes alone, so `workspace-write` blocks unattended work such as package caches in the home directory and the model must escalate for each one. On the container those writes land in the VM. The Web copy also documents Auto as running without a sandbox.

**Ask the user for every escalation.** Auto would prompt more than Workspace Write does and lose its purpose of replacing prompts.

**Re-select Auto before each call.** Selecting Auto writes the whole bundle, including the `ask` approval policy, so a delegated child pinned to `never` would be unpinned and the reviewer could then answer its escalations. Narrowing writes the sandbox mode alone.

**Follow the backend in both directions.** A switch to `/sandbox local` would loosen the policy without a user choice of policy, and with persistent terminals open the next call would fail on the fence.

**Rewrite the mode when the backend event is appended.** Session observers run while the append is locked, so a reentrant append is rejected, and deferring it leaves a window where calls run under the stale mode.

**A fourth sandbox mode that keeps the container fully writable.** It changes the closed mode vocabulary and the durable event, and builds without it would refuse the log.

## Consequences

On the container, Auto confines commands to the VM and the workspace. `.git` is read-only there, so a commit needs an escalation that the reviewer decides, and Darwin-native toolchains do not run in the guest; `/sandbox local` followed by selecting Auto restores the previous full-access behavior.

A reviewer mistake can still grant one escalated call host access, the same exposure Auto had for every call before. The audit log records the answer as an ordinary `approval/decided` event, so it does not show that the reviewer rather than the user granted it. The fixed reviewer policy words every allow as full host access, so the reviewer judges confined calls as if they were unconfined.

A Session recorded before this decision is confined at its next call on the container, and the model reads the changed sandbox policy in its next snapshot, appended after retained history.

Unit tests pin the mode resolution, the stored-identity match, the answer and its exclusions, the tightening and its refusal to widen, and the unload migration. The auto-review composition test runs the real agent loop, Bash tool, executor, presets, approval service, and container provider routing with a recording stand-in for the VM, and fails on the earlier behavior.

## Related decisions

- [Auto review](../feature/2026-08-28-auto-review.md) — the reviewer, its authority, and the earlier Full access sandbox value.
- [Auto asks the user after a denial](../feature/2026-09-24-auto-review-user-approval-fallback.md) — the approval policy Auto writes.
- [Apple container sandbox backend](../feature/2026-10-01-apple-container-sandbox-backend.md) — the backend that confines reads.
