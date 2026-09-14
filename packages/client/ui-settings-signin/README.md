---
description: "Provider sign-in on the Web Models page: subscription and key logins, the attempt dialog with its codes and questions, and sign-out."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-signin

English | [中文](README.zh.md)

## Summary

This plugin lets Web users reach a provider through a subscription instead of an API key — a ChatGPT subscription for the OpenAI Codex models, and every other provider whose adapter ships a subscription login. That provider's card on the Models page gains its sign-in methods, a signed-in marker once a credential is stored, and a sign-out. A dialog carries the running attempt: the page to open, the code to type there, and any question the provider asks. A provider that only takes a key keeps the card it already had.

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

Open **Settings → Models**. A provider whose adapter ships a subscription login shows its sign-in buttons inside that provider's card, beside the ordinary API-key field. A provider whose only login collects an API key shows nothing new: that key belongs in the card's own field.

### Signing in

Choose the sign-in button; a provider offering more than one method shows one button per method, named after the method. The dialog then shows what the provider wants the human to do. A browser login shows the page to open as a link. A device-code login shows that page plus the short code to type there, with a copy button. A question the provider asks — pick a login method, paste a redirect URL, paste a key — appears as a field or a list of choices in the same dialog, and **Continue** sends the answer back. **Not now** declines the question, which cancels the sign-in; **Cancel** withdraws the whole attempt.

When the attempt ends the dialog says so: signed in, cancelled, or failed with the provider's own message. The card then shows the signed-in marker, and the provider's models become selectable once its route is configured.

### Signing out

**Sign out** forgets the stored credential on this machine. It does not tell the provider, so a session the provider still considers valid remains valid there; sign out in the provider's own account settings to revoke it.

### What each state means

A card shows one sign-in area per provider:

| State | What it means |
|---|---|
| Sign-in buttons and the hint | No credential is stored; this provider uses a subscription sign-in |
| Signed in with a provider subscription | A sign-in grant is stored — a subscription login, such as ChatGPT |
| Signed in | A key obtained through the provider's own login prompt is stored |
| Buttons held, with a busy line | Another browser tab or surface is running this provider's sign-in |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin fills the two seats the Models section declares and adds nothing to that section's own code.

### Two seats, one snapshot

`settings.models.provider-card` is keyed by the owning settings namespace, so registering one entry under `llm-pi-ai` reaches every card of that adapter family; the area then renders only where the provider's flow offers a subscription method. `settings.models.footer` carries the dialog, which belongs to the page rather than to a card: an attempt survives its card scrolling out of view, and only one runs at a time. Both seats receive the same snapshot store, so the card and the dialog can never disagree about what is running.

### The flow directory

The Host's flow list is joined by provider route: a flow whose record scope is the pi-ai adapter family names a provider in its record id, and a flow from any other plugin addresses something that is not a provider and is left alone. The directory is re-read at mount, after every attempt settles anywhere, after any credential record changes, and after a reconnect — so a sign-in completed in a second tab converges here without polling. A refused read keeps the last good rows rather than emptying the controls mid-attempt.

### One attempt

Starting an attempt opens the Host stream and folds its frames into the snapshot: notices accumulate as directions, a prompt becomes the open question, a withdrawn prompt clears it, and the settlement closes the attempt. Starting a second attempt withdraws the first, which is what the Host would refuse anyway. A stream that ends without settling is reported as a cancellation rather than left as a spinner.

### Source map

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Plugin entry: dictionaries, the two seat registrations, pushed invalidations |
| [`src/client/store.ts`](src/client/store.ts) | The flow join, the running attempt, and the Host operations |
| [`src/client/SignInCard.tsx`](src/client/SignInCard.tsx) | The sign-in area inside one provider card |
| [`src/client/SignInDialog.tsx`](src/client/SignInDialog.tsx) | The attempt's directions, question, and outcome |
| [`src/client/SignInFooter.tsx`](src/client/SignInFooter.tsx) | The page-level dialog seat |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages move from the page this plugin extends to the Host halves behind it.

- [ui-settings-models](../ui-settings-models/README.md) — the Models page declaring both seats this plugin fills.
- [api-authorization-controller](../../api/authorization-controller/README.md) — the Remote namespace behind every call here.
- [dsh-authorization](../../credentials/authorization/README.md) — the seam that owns the flows and the attempt lifecycle.
- [llm-pi-ai](../../llm/llm-pi-ai/README.md) — the adapter registering one login per installed provider.
- [Configure models](../../../docs/user/guide/providers.md) — the user guide covering both key and sign-in providers.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side configuration surface that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the surface stops; they are current package constraints.

- **Reloading the page abandons a running sign-in** — the attempt lives in the stream that started it, so the human starts over. A completed sign-in is durable; only an unfinished one is lost.
- **Sign-out forgets locally** — the stored credential is deleted without telling the provider, so a subscription session stays valid on the provider's side until revoked there.
- **Only adapter-family providers get the seat** — the card seat is keyed by the pi-ai settings namespace, so a flow registered by a plugin that is not an LLM adapter has no home on this page.
- **A key-collecting login is not offered here** — a provider whose only login prompts for an API key keeps the card's own key field, because storing the same secret as a record instead of a reference would leave two places to look for it.
- **Signing in does not add the provider's route** — a signed-in provider still needs its Models row, because which routes a deployment serves stays a settings decision.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package renders Host-owned sign-in state and owns no independently observable relation.
