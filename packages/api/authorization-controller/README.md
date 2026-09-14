---
description: "Host Remote owner for browser sign-in: the flow directory a configuration page lists, one streamed attempt with its questions, and sign-out."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-authorization-controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-authorization-controller` lets a browser configuration page sign a user in to a provider that cannot be configured with a key. It exposes the registered sign-in flows with their stored-credential state, runs one attempt as a stream carrying the flow's instructions and questions to the page, takes the answers back, and forgets a stored credential on sign-out. Choose it when a surface must run a sign-in conversation over the wire; a credential a deployment can supply as a value belongs to the `credentials` namespace instead. Prompt answers cross in one direction only, and no method here returns a secret.

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

Mount this package as a Loader entry in a profile that serves browser configuration. It registers the `authorization` Remote namespace whether or not the authorization seam is present, so a page can ask what can be signed into and get an honest empty answer.

### When to choose it

Mount it when a configuration surface must obtain a credential by talking to a human — an account sign-in, a one-time code, an account pick. A deployment that configures every provider with a key needs nothing here, and a headless or automation-only composition has no surface to sign in from. The flows themselves come from the plugins that own their credentials; this package offers none.

### Minimal mount

```yaml
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'
- id: authorization
  name: '@deepseek-ai/dsh-authorization'
- id: authorization-controller
  name: '@deepseek-ai/dsh-api-authorization-controller'
```

This package takes no configuration.

### Listing what can be signed into

`list()` answers one row per registered flow: the credential record it writes (split into the owning plugin's `scope` and its own `id`, which for an LLM adapter is the provider route), the flow's label, the methods it offers most preferred first, whether an attempt is already running for it anywhere, and whether a credential record is currently stored. A composition with no authorization seam answers an empty list rather than an error, because such a deployment genuinely has nothing to sign into. A mounted seam with no credential provider is a configuration mistake and says so by name.

### Running one attempt

`begin(request, signal)` is a stream. Each item is one frame: a `notice` carrying what the human must do and any page or code it refers to, a `prompt` carrying a question and the id an answer names, a `prompt-withdrawn` for a question the flow retired, and a final `settled` frame carrying `authorized` or `cancelled`. The attempt starts when the carrier pulls the first frame and ends when the stream does; closing the stream withdraws it. `cancel(key)` withdraws it from a call that no longer holds the stream, which is what a Cancel button on a re-rendered page uses.

A question is answered by a second call naming the frame's `promptId`: `answer(key, promptId, value)` with the typed text or the chosen option's id, or `decline(key, promptId)` when the human says no, which settles the attempt as `cancelled`. Only the attempt's own prompts can be answered, so a stale id is refused rather than silently applied to a newer attempt.

### Signing out

`signOut(key)` deletes the stored record. Removing an absent record succeeds, and the issuer is not told — the credential is forgotten locally only.

### Failures and recovery

Every failure of a `begin` call arrives as a stream failure rather than a rejected open, so a surface reads one failure path. `authorization/rejected` carries the refusal message and, when the seam had one, its code in `reason`: `NO_FLOW` when nothing claims the key, `UNKNOWN_METHOD` when the flow does not offer the named method, `ALREADY_IN_FLIGHT` when another surface is mid-attempt, and `NOT_COMMITTED` when a flow resolved without storing anything. A flow that simply failed carries only its own message. `authorization/no-prompt` answers a `promptId` nothing is waiting on. A malformed key or payload is `gateway/bad-request`, and an absent seam or credential provider is `gateway/internal` naming the row to mount.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The authorization seam owns the conversation and the one-attempt-per-key lifecycle. This package owns only what the wire adds to it.

### The stream is the attempt

The seam hands a running flow an interaction with `notify` and `prompt` callbacks, both of which are in-process. A browser is not, so each becomes a frame pushed into a queue the Remote carrier pulls, and `prompt` additionally parks on a promise that a later `answer` or `decline` call resolves. That is the whole translation: the pending-prompt table is keyed by the attempt's credential key, and the seam's own single-attempt rule is what keeps one table entry unambiguous.

The generator is deliberately lazy — the attempt starts on the first pull. A stream nobody consumes would otherwise hold the key for the life of the process, which is exactly the wedged state the seam's own withdrawal rules exist to prevent. When the stream closes, every question still open is withdrawn so the flow's `await` settles instead of waiting for an answer that can no longer come.

### Two kinds of withdrawal

A prompt carries its own signal so a flow racing a typed code against a browser callback can retire the losing question while the attempt continues. That rejection is deliberately not a decline: the seam reads `AuthorizationDeclinedError` as the human saying no, so a race the flow resolved itself must reject with something else or a later attempt would be misreported as a refusal.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The Remote service: request validation, the frame queue, the pending-prompt table, refusal mapping |
| [`src/types.ts`](src/types.ts) | Browser-safe flow view, begin request, frame union, and failure codes |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages move from the seam this package carries to the surface that drives it.

- [dsh-authorization](../../credentials/authorization/README.md) — the seam that owns the flows and the attempt lifecycle.
- [dsh-credentials](../../credentials/credentials/README.md) — the record store a flow commits through and this package deletes from.
- [ui-settings-signin](../../client/ui-settings-signin/README.md) — the Models-page surface that consumes this namespace.
- [API Gateway reference](../../../docs/api-gateway.md) — how a Remote method and its stream reach the browser.
- [Credential records and authorization flows](../../../.agents/notes/implemented/architecture/2026-08-13-credential-records-and-authorization-flows.md) — why the record and flow halves are shaped this way.

-----

<a id="model-experience"></a>
## Model Experience

None, as signing in is a configuration-time conversation with a human and no flow, notice, or prompt reaches a model request.

#### KV Cache effect

No invalidation; no sign-in state enters a request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are current package constraints, inherited from the seam it carries.

- **An attempt lives in the stream that started it** — reloading the page mid-sign-in abandons the attempt, because the seam has no durable store for one. The reloaded page sees the key free again and starts over.
- **Sign-out forgets locally** — `signOut` deletes the record without telling the issuer, so a provider that needs a server-side revoke has nowhere to declare it.
- **One attempt per key, refused rather than joined** — a second surface starting the same sign-in is refused with `ALREADY_IN_FLIGHT`; `inFlight` on the row is what lets it disable the button instead of discovering the state by error.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The authorization seam owns the attempt-lifecycle relation, and this package adds no independently observable one.
