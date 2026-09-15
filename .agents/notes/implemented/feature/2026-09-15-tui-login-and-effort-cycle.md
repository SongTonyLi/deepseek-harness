# Agent Note: TUI `/login` and Shift+Tab effort cycling

Status: implemented

English | [中文](2026-09-15-tui-login-and-effort-cycle.zh.md)

## Problem

The terminal already had `/signin` for every authorization method a flow declared, including key-collecting `api-key` logins that the Models card hides because the card already has a key field. Users who want subscription-backed model access from `dsh tui` had no command that matched that card. Changing reasoning effort required `/model` and a second picker, even when only the effort of the already selected model needed to move.

## Decision

`/login` is a terminal-local command next to `/signin`. It lists and starts only subscription methods: every method whose id is not `api-key`, the same predicate the Models card uses. `/signin` still offers every method a flow declares, including empty method lists. A flow that only collects a key is absent from `/login`; naming it as `/login <key>` reports that it has no subscription sign-in.

Shift+Tab, consumed before the editor, advances the bound `ModelSelectionRef` through the current model's adapter-owned efforts from `llm.resolveModelInfo`, wrapping through the provider default (no `reasoningEffort` field). A model with fewer than two efforts is a no-op besides a notice. Rapid presses serialize so each cycle sees the previous selection. The change applies from the next request and is not written as the saved default; `/model save` remains the explicit persist.

## Alternatives considered

**Make `/signin` subscription-only, or treat `/login` as a pure alias.** Rejected because existing `/signin` tests and flows include `api-key` and empty method lists; collapsing them would remove a working key-collecting path. `/login` is the subscription command; `/signin` stays the general one.

**Open the `/model` effort picker on Shift+Tab.** Rejected because the request is to change the current model's effort in place. Cycling the resolved effort list matches that, while `/model` remains the way to change provider/model.

**Share `isSubscriptionMethod` from the Web sign-in package.** Rejected because the terminal must not import a client plugin. The predicate is the documented `api-key` id rule, restated next to `/login`.

## Consequences

- Subscription sign-in from the terminal does not offer a second place to paste the same API key the Models card already collects.
- Effort cycling can fail loud when no LLM catalog is composed or the current route cannot be resolved; it does not invent an effort vocabulary.
- Package specs cover `/login` filtering and Shift+Tab cycling over a fake terminal; they do not persist the cycled effort through `/model save`.

## Related decisions

The terminal surface, `/signin`, and `/model` effort picker remain owned by [terminal surface as the shipped `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.md).
