# Agent Note: Browser provider sign-in

Status: implemented

English | [中文](2026-09-14-browser-provider-sign-in.zh.md)

## Problem

The Host half of provider sign-in shipped with [credential records and authorization flows](../architecture/2026-08-13-credential-records-and-authorization-flows.md) and then had nowhere to run. `llm-pi-ai` registers one flow per installed pi-ai provider, `dsh-authorization` owns the attempt lifecycle, and the credential seam stores the grant with cross-process refresh locking. That note closed by naming exactly what was missing: "the wire contract that carries notices and prompts to the browser, and the Models-page control that starts a login."

Three consequences followed. `@deepseek-ai/dsh-authorization` appeared in no `cordis.patch.yml`, so `llm-pi-ai`'s `ctx.inject(['authorization'], …)` never fired and the flows did not exist at runtime. No Remote namespace exposed the seam, so no surface could have reached them anyway. And `docs/user/guide/providers.md` told users that "Providers that sign in with OAuth, such as Codex, are not supported here yet" — true, and the reason a ChatGPT subscription could not be used for the GPT-5 and GPT-6 Codex models the installed catalog already describes.

## Decision

Two packages and one composition change, with the seam and the adapter untouched.

**`dsh-api-authorization-controller` carries the conversation.** Every other Remote method in the repository is unary, but an authorization attempt is a conversation: the flow speaks while it runs, and it asks questions whose answers it waits for. `begin` is therefore the repository's fourth stream-mode Remote, yielding one frame per thing the flow said — `notice`, `prompt`, `prompt-withdrawn`, and a terminal `settled`. The answer travels the other way as its own call (`answer`/`decline`) naming the frame's `promptId`, because the Remote carrier has no upstream channel inside a stream. The seam's own single-attempt-per-key rule is what makes the pending-prompt table unambiguous: one entry per key can only belong to one stream.

Three choices carry the weight:

- **The stream is the attempt's lifetime.** Closing it withdraws the attempt and withdraws every question still open, so a flow's `await` settles instead of waiting for an answer that can no longer come. `cancel(key)` exists beside that for a surface that no longer holds the stream — the seam already provided it for exactly this transport shape.
- **The generator is lazy.** The attempt starts when the carrier pulls the first frame, not when `begin` returns. A stream nobody consumes would otherwise hold the key for the life of the process, which is the wedged state the seam's withdrawal rules exist to prevent.
- **Every `begin` failure is a stream failure.** Validation, an absent seam, a seam refusal, and a flow that broke all arrive through one path, so a surface writes one error branch instead of discriminating a rejected open from a failed read.

**`dsh-client-ui-settings-signin` is a separate plugin, not an edit to the Models page.** The Models page already declares `settings.models.provider-card` (keyed by settings namespace) and `settings.models.footer` for exactly this: a plugin that adds provider-adapter UI without the page learning what it means. Sign-in fills both — the card seat under each adapter-family settings namespace (`llm-pi-ai` and `llm-cursor`) so every route of those families gets it, and the footer seat for the dialog, which belongs to the page rather than a card because an attempt outlives its card scrolling out of view and only one runs at a time. Both seats share one snapshot store, so the card and the dialog cannot disagree about what is running.

The card offers subscription methods only. `llm-pi-ai` registers a login for all 38 installed providers, but 31 of those only prompt for an API key — which the card already has a first-class field for, storing it as a reference the settings profile names. Offering pi-ai's key prompt beside it would store the same secret as a record instead, leaving two answers to "where is my key". The predicate is negative (every method id but `api-key`), so a provider that adds a second subscription method appears without a code change while a second key path never does.

The flow directory is joined by provider route: a flow whose record scope is an adapter-family settings namespace (`llm-pi-ai` or `llm-cursor`) names a provider in its record id, and a flow from any other plugin addresses something that is not a provider and is left alone. `authorization/settled` and `credentials/record-updated` join the forwarded-event allowlist so a sign-in completed in a second tab converges without polling.

**The base bundle mounts the seam; the web bundle mounts the controller and the plugin.** The seam offers no flow of its own, so mounting it in `dsh-base` asks nobody to sign in — a headless or ACP composition is unchanged, and what makes the logins reachable are the `llm-pi-ai` and `llm-cursor` rows already there.

`authorization/settled`'s Cordis `Events` declaration moved from the authorization package's `index.ts` to its client-safe `types.ts`, matching how the credentials seam declares its two events: the forwarding allowlist's Client face must read the same declaration the Host emits without pulling a Host-only service type.

## Alternatives considered

**Answer prompts inside the stream.** A duplex stream would keep one conversation in one call. The Remote carrier is one-directional per stream, so this would mean a second protocol beside Remote — the exact thing `docs/api-gateway.md` reserves for a separate data protocol. Two calls with a `promptId` reuse the carrier as it is.

**Poll a unary `state(key)` instead of streaming.** It avoids the repository's fourth stream. It also turns a browser-callback race into a polling interval, loses the ordering between a notice and the question that follows it, and gives a device-code flow no way to show its code promptly.

**Put the sign-in controls in `ui-settings-models` directly.** Fewer packages, and the page already owns provider rows. It also puts an adapter-family concern inside the page that deliberately knows nothing about adapter families, and the two extension seats exist precisely so this kind of UI arrives from outside. A separate package also keeps a composition free to drop sign-in without losing the Models page.

**Offer every method the flow registers, key prompts included.** It is the seam's full offer, and it would let a user configure any provider without touching the key field. It would also give one provider two storage locations for one secret — a record and a reference — with only the provider's own README explaining which one a request resolves.

**Add the sign-in methods to the existing `credentials` namespace.** The two are adjacent on screen. They are not adjacent in kind: one writes a value the caller already has, the other runs a conversation with a lifecycle, a single-attempt rule, and cancellation. Folding them would give one namespace two failure vocabularies.

**Have a successful sign-in add the provider's route.** It would make Codex work in one click. It would also let a sign-in write `settings.yaml`, and which routes a deployment serves is a settings decision the Models page owns; the row stays the user's explicit act.

## Consequences

A user can sign in to a ChatGPT Plus or Pro account from Settings → Models and use the Codex models on that subscription. The card shows what is stored — a subscription grant and a provider-prompted key read differently — and sign-out forgets the record locally, which the README and the user guide both state does not revoke anything at the provider.

The Remote surface gains one namespace and two failure codes, `authorization/rejected` (carrying the seam's own code in `reason`) and `authorization/no-prompt`. The forwarded-event allowlist gains two entries. No session event, settings key, or storage format changes, and nothing here reaches a model request.

Two limits are inherited rather than fixed: an attempt is not durable, so reloading mid-sign-in abandons it, and one attempt per key is refused rather than joined, which `inFlight` on each row lets a surface show up front. A third is deliberate: only flows whose record scope is an adapter-family settings namespace (`llm-pi-ai` or `llm-cursor`) get a Models-page seat, because a flow from a non-adapter plugin has no provider card to sit in.

The shared browser-boot fixture gains an `authorization/list` default, since every whole-client roster spec now boots a plugin that reads the directory at mount.

## Testing

The controller suite covers the namespace and its method set, the absent-seam and absent-provider diagnostics, malformed keys, the three prompt kinds with their answer and decline paths, a prompt the flow withdrew by its own signal, withdrawal by closing the stream and by a second `cancel` call, a flow that failed, a flow that resolved without committing, sign-out including a refused delete, and a newer attempt keeping its prompts while an older stream is still being drained. A real-composition test boots the seam, the credential store, a bare `llm-pi-ai` row, and the controller through the actual Loader and asserts that the Codex subscription login is listed with no provider configured — the guard a hand-mounted `ctx.plugin` cannot give.

The browser suite covers the flow join and its scope filter, one attempt's frames folded into the snapshot, the answer and decline paths, a refused answer clearing its question, a failed and a never-settled stream, withdrawal on close and on a second attempt, sign-out with its refusal, both seat registrations with their keys and locale, the three pushed invalidations, late declaration and declarer reload, and the two seats sharing one store. Component specs cover every card state and every dialog state including the copyable device code.

Not covered here: a keyless Web e2e scenario. The attempt's frames come from a real provider flow that opens a browser and talks to an external endpoint, so a scripted one would assert this package's own double rather than the assembled surface; the Models-page goldens remain the assembled evidence for the page itself.
