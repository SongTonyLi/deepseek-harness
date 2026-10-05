---
description: "Add experimental per-call Auto review, using the current agent's model before tools execute with Full access, or confined where the sandbox backend confines reads."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-auto-review

English | [中文](README.zh.md)

## Summary

Add Auto review to the current-session permission pickers. Before each native or PTC inner tool call, the current agent's provider and model assess the pending action; an allowed call executes with Full access, or confined in the container while the session runs on the Apple container backend, and a denied call asks the user. The shipped TUI profile includes this layer. Default Web keeps its three permission modes until it is switched on from the Web sidebar's Plugins page or installed explicitly. Auto review is experimental: it can allow unsafe actions, deny useful work, and spend additional tokens.

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

### Install into a profile

From this source checkout, install the package into the Web profile through the existing CLI:

```sh
pnpm dsh plugin --profile web add ./packages/experimental/auto-review
```

The CLI initializes the profile when needed and appends this package's declared patch after the base and Web layers. Reconciliation activates the patch as a profile layer; a package without `dsh.bundle.patch` is only an installed dependency. Select `Auto review` with its superscript `EXP` badge in the composer or `/permission` picker and confirm the current-session risk dialog. An explicit `/permission auto` command switches directly. General settings and future-session defaults do not offer Auto.

Remove the layer through the same CLI:

```sh
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-experimental-auto-review
```

### What you get

Auto reviews every supported call once before its body, including each started PTC `tools.*` inner call. It classifies actual effects: ordinary project-local work and exact cleanup of objects created in this Session are low risk and allowed; irreversible deletion of pre-existing objects, production operations, external writes, and security changes are medium risk and require explicit current human or direct-parent authorization of the action, target, and scope. Sensitive exfiltration across a trust boundary is high risk and always denied. Ambiguous effects and unresolved authorization conflicts are denied. Selecting Auto sets the `ask` approval policy, so a denied call asks the user and executes only after approval; a rejected or cancelled approval leaves its body unexecuted. A delegated in-process child pins the `never` policy, so its denials are final. Malformed reviewer responses and technical failures fail the call with their specific error and never execute it.

A final denial uses the ordinary tool card. The collapsed row identifies Auto review; expanded output states that the body did not execute and displays the optional reason. [The Web permission package](../../client/ui-permission-presets/README.md) owns picker interaction, and [the tool UI](../../client/ui-tool/README.md) owns reason display.

### Auto on the container backend

While a session runs on the [Apple container backend](../../sandbox/sandbox-apple-container/README.md), Auto keeps the sandbox: selecting it writes `workspace-write` instead of `danger-full-access`, so allowed commands run confined in the container. A call that has to leave the container, such as the model's one-shot `sandbox_permissions` escalation or a read outside the workspace, is decided by the reviewer instead of the user: an allowed call answers every approval it raises while it runs. A call the reviewer denied still asks the user about the call itself, and any approval it then raises reaches the user as well. The outer `run_code` transport is not reviewed, so an escalation of its own process still asks the user.

A session recorded while Auto always wrote `danger-full-access` is confined at its next call once its backend confines reads. A backend switch never widens a confined Auto session, so after `/sandbox local` select Auto again to return to Full access on the host. Backends that confine writes alone keep Auto at Full access.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the package itself as the `auto-review` row. [`src/index.ts`](src/index.ts) requires the approval, LLM, permission, Session, and tools services, then installs the preset contribution and prepended pre-execute listener in one effect. After the review settles, a denial reads the Session's approval policy: under `never` it is final; under `ask` the listener delegates to later pre-execute listeners and returns the tools pipeline's `ask` decision only when they allow the call, so a later denial, cancellation, or `ask` (with its own reason) takes precedence. The `ask` decision carries an English audited reason and localized prompt text that keeps the raw reviewer reason. The [permission owner](../../interaction/permission-presets/README.md) supplies the current identity and process catalog; Auto writes the `ask` approval policy with Full access's sandbox value, or with `workspace-write` while the session's backend confines reads, and does not change tool definitions.

Two more listeners keep Auto on a confining backend. Before any call body, the pre-execute listener calls the preset service's `confineAuto(session)`, which narrows a session that still has `danger-full-access` while its backend confines reads by appending only the sandbox mode, so the approval policy a delegated child pins is unchanged; it runs for the unreviewed `run_code` transport too, and a rejected change, such as the persistent-terminal fence, fails the call instead of running it under the stale mode. A prepended `approval/request` listener answers `allowed-once` for a request that names a call the reviewer allowed, that is still running, in a session still in Auto; a downstream listener's own ask for that call is not covered, and `tools/post-execute` forgets the call when it settles.

The reviewer reconstructs five sections from the current Session surface and pending execution: fixed policy, cwd-only environment, sourced project constraints, filtered sourced history, and the complete pending action. Native schema comes from the latest request header. A PTC binding freezes its schema and carries it through the scheduler into transient execution metadata; start and settle events never serialize description or parameters. Main-agent `system/message` nodes, assistant text and reasoning, and tool results are excluded. The outer review input is a frozen `RequestUserInput` without durable identity or source; retained history keeps its original source attribution in the review text. [The decision record](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.md) owns authority, lifecycle, and child-inheritance rationale.

Unloading closes selection and review admission, migrates live Auto Sessions through the existing preset writer, then aborts and drains reviews before withdrawing the listener and contribution. A session at `danger-full-access` becomes Full access, which writes the `never` approval policy through the Session writer without queuing a policy-change notice; a session at `workspace-write` becomes Workspace Write, which writes the `ask` approval policy only when the session does not have it already. The model sees the new policy in the next runtime-context snapshot. Each session keeps its sandbox value, and persistent terminals survive the migration. A persisted Auto Session cannot publish without the complete integration; reopening it after installation is an explicit user action. Reinstalling the layer restores the option but does not switch live Sessions back to Auto.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — publication policy and dependency isolation.
- [Web bundle](../../bundle/web-app/README.md) — the stable profile this patch extends.
- [Auto review decision](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.md) — fixed risk policy, authority, and lifecycle.
- [Tools](../../core/tools/README.md) — execution, cancellation, and PTC result propagation.

-----

<a id="model-experience"></a>
## Model Experience

### Per-call reviewer

#### What the model sees

The reviewer uses the latest `request/header.config` provider and model with the shipped adapter's default reasoning. The `temperature` setting accepts numbers from `0` through `2` or `provider-default`, which omits the request parameter; the plugin defaults to `0`, while the bundle selects `provider-default` only for the `tui` profile so providers that reject temperature can review calls. Its fixed `REVIEW_POLICY` replaces human approval for exactly one action: allow executes immediately, worded as with full host access even when the session keeps the container, so the reviewer judges every call as if it had that access. The other four sections contain only the retained facts described above. It returns one strict JSON text object with `risk` and `decision`; deny may include a string `reason`. Reasoning blocks may precede that single text block. Only `low + allow`, `medium + allow/deny`, and `high + deny` are valid.

#### Token effect

One additional model request per supported call. When a completed text response is invalid JSON, `maxJsonRetries` permits additional requests (default `1`, non-negative safe integer; `0` disables retries). Each retry reuses the frozen action facts and appends a fixed formatting reminder to the policy without including the malformed response. Valid denials, invalid risk/decision objects, provider or stream failures, and cancelled reviews are not retried. Exhausted JSON retries fail the call without executing its body. Requests have no caching, truncation, compaction, or separate small output budget; an oversized request fails with the provider error.

#### KV Cache effect

The fixed reviewer policy can share a prefix; retained history and the pending action vary per call. Auto adds no dedicated runtime context or mode-switch prompt to the main agent. Selecting Auto on the container backend, or confining a session recorded at full access, changes the existing sandbox policy and backend contributions once; the new snapshot is appended after retained history, so the cached prefix is unchanged.

### Tool denial

#### What the model sees

Under the `ask` approval policy, the model sees only the approval outcome, such as `the user rejected tool "<name>"`, or the approved call's ordinary result. A final denial message is `Auto review rejected tool "<name>"; its body was not executed`. A reviewer failure message is `Auto review of tool "<name>" failed; its body was not executed: <error>`. Ordinary native error rendering prefixes each message with `Error: `. PTC uses the existing inner-call exception and catch behavior; a caught denial does not force the outer `run_code` to fail. The raw optional reason is durable structured error detail for users, never main-model content. Risk, reviewer prompt, reasoning, and raw response are not persisted.

#### Token effect

A denied or failed call contributes only its ordinary error result to the main conversation.

#### KV Cache effect

The denial appends an ordinary tool result; it does not rewrite earlier context or hide existing model-visible information.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The shipped TUI profile includes Auto review. Default Web, Headless, General settings, and new-session defaults omit it until this layer is switched on.
- Auto provides no file sandbox of its own. On a backend that confines reads it keeps that backend's `workspace-write` confinement, and elsewhere it runs with Full access. The outer `run_code` transport and direct Node effects inside a PTC program do not pass through inner-tool review.
- The fixed reviewer policy words every allow as full host access and the reviewer is not told the session's sandbox mode, so it can deny a call the container would have contained.
- A reviewer allow that answers an approval is logged as an ordinary `approval/decided` event with the `allowed-once` outcome. The audit trail does not record that the reviewer, not the user, granted it, and the reviewer's risk and decision are not persisted.
- Model classification can be wrong. There are no deterministic tool exemptions, persistent grants, or configurable policy. Formatting retries cannot correct a valid but mistaken classification.
- In-process Auto children review their own calls. Out-of-process children retain their native permission systems after the parent delegation call is allowed.
- The reviewer reads the Session action history through the deprecated synchronous `snapshotEvents()` reader under a line-scoped waiver. Prior calls, PTC starts, and the direct parent's initial prompt have no projection or paged reader yet, so the migration stays deferred by [the synchronous-read decision](../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
