---
description: "Resume an eligible failed model turn without adding an instruction."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-continuation

English | [中文](README.zh.md)

## Summary

Resume eligible failed model work without adding instruction text to the conversation. The retry starts a new turn and preserves the failed turn in the Session log. Pending human input and active Agent work prevent admission.

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

Mount `@deepseek-ai/dsh-session-continuation` beside the Session projection registry. The shipped base and sdk-minimal bundles supply it; custom Session Controller compositions must also mount it. The service has no configuration fields.

Call `ctx.sessionContinuation.retry(agent, source)` with the exact live Agent and a `RetrySource` carrying `kind: 'retry'` and a branded `rpcId`. Optional `clientTimeZone` and `principal` fields preserve caller attribution. The caller owns authorization, request identity, deduplication, and presentation of errors.

The service returns `accepted` after queuing an empty retry, or `unavailable` without queuing one when the last turn is ineligible, any next-turn input is pending, or next-step human input is pending. Eligibility requires admitted human work or an empty retry, a failed attempt in the last request step, and an error ending with `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`, or `STREAM_CLOSED`. This manual policy is independent of automatic provider retries. Non-waking injected context remains queued for the next request.

The Agent maintenance lock protects the eligibility and inbox checks with admission. An active Agent or concurrent maintenance raises `SessionContinuationBusyError`; other admission failures propagate. A caller should report an unknown failure rather than assume the retry was accepted or retry it without its own deduplication policy.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service owns and awaits registration of the `conversationContinuation` projection. Its fixed-size fold derives eligibility from the complete Session log; checkpoints and suffix replay use state version 4. The wire view remains the eligible `turn/end` sequence or `null`. Unmounting the service releases its registration; Session preparation and recovery remain owned by the projection registry and Session loader.

The [service entry](src/index.ts) provides admission, the [projection](src/projection.ts) folds durable events, and the [types](src/types.ts) declare the retry source and wire projection. The Session Controller consumes the service and retains its RPC deduplication and Remote error handling.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session projection registry](../session-projection/README.md) — registration, recovery, and checkpoint lifecycle.
- [Session Controller](../../api/session-controller/README.md) — Remote prompt admission and request deduplication.
- [Manual generation continuation](../../../.agents/notes/implemented/feature/2026-10-26-manual-generation-continuation.md) — policy and durable input rationale.

-----

<a id="model-experience"></a>
## Model Experience

### Accepted retry

#### What the model sees

An accepted retry appends one user message with empty `content`. The next request includes that empty user turn, the retained history, and any queued non-waking context. The message adds no instruction text.

#### Token effect

The retry message contributes no instruction tokens. Tokens in the new request come from the retained history, queued context, and the provider framing of the empty user turn.

#### KV Cache effect

The empty user turn is appended after the retained history and does not replace earlier tokens. Queued context delivered with the new request extends the suffix. A refused retry adds no message.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Request deduplication is caller-owned** — submitting the same source again is not an idempotency guarantee. The Session Controller provides its own RPC request deduplication.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
