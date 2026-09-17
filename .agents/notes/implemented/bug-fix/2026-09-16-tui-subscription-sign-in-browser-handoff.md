# Agent Note: TUI subscription sign-in browser handoff

Status: implemented

English | [中文](2026-09-16-tui-subscription-sign-in-browser-handoff.zh.md)

## Problem

pi-ai's OAuth logins never open a browser themselves: they emit an `auth_url` or `device_code` event and immediately race a manual-code prompt against a localhost callback. The Web Models page renders the notice URL as a real link, so sign-in works there. The terminal printed the URL into the transcript and focused the manual-code modal; nothing opened and nothing was clickable, so subscription sign-in was unusable — OpenAI Codex even instructs "A browser window should open", and Anthropic offers no device-code alternative. The terminal also threw a plain `Error` when a sign-in prompt was dismissed, reporting a human "no" as a failure instead of the `cancelled` the seam defines, and `/login` never said that a dormant provider route still needs its settings profile before the stored credential is usable.

## Decision

`AuthorizationNotice` gains `openInBrowser?: true`, carried through the Remote `AuthorizationNoticeFrame` into the sign-in client store. llm-pi-ai's relay sets it only for pi-ai `auth_url` and `device_code` events, never for an `info` link, because only the flow knows an authorization destination from an informational page. The terminal's notify handler always prints message, URL, and code, and for a marked notice fire-and-forget hands the URL to the default browser through `openNativeUrl`, a new `dsh-native-command` export holding the credential-scrubbed helper launcher the Web app previously kept private; the Web app now consumes the same export. The terminal suppresses the handoff for SSH launches, hosts without a desktop, and the new `--no-open` invocation / `openBrowser` config, and reports an opener failure as a notice beside the URL, never as a sign-in failure. A dismissed sign-in prompt throws `AuthorizationDeclinedError`, so it settles as `cancelled`. The READMEs record that signing in stores the credential without activating a dormant route (`/settings llm-pi-ai providers.<id> {}` first).

## Alternatives considered

**Open every notice URL automatically.** Rejected because pi-ai `info.links` maps into the same `url` field; an informational link must not pop a browser. The explicit flag keeps the distinction where the flow knows it.

**Open the browser inside the llm-pi-ai flow.** Rejected because browser handoff is a surface concern: headless compositions run the same flows, and the seam already routes human interaction through the request's interaction.

**Call the existing `openNativePath(url)`.** Rejected because that opener is filesystem-only and would run `wslpath -w` on the URL under WSL.

**Teach the authorization seam to create the provider route after a commit.** Rejected because route configuration belongs to the LLM configurable-provider and settings capability; deriving settings paths from credential keys would couple the two seams. Documentation names the prerequisite instead.

## Consequences

- `/login` and `/signin` on a desktop local launch open marked authorization pages in the default browser while the URL and code stay printed as the fallback; SSH and `--no-open` leave the manual and device-code paths intact.
- A dismissed sign-in prompt settles as `cancelled` in the terminal, matching the Web.
- The notice vocabulary, its Remote frame, and the sign-in client store all carry `openInBrowser`; the Web dialog renders links exactly as before.
- `dsh-tui-app` depends on `dsh-native-command` and `dsh-launch-environment`; `dsh-web-app` drops its private launcher and the `open` and `dsh-subprocess` edges.

## Related decisions

The terminal command remains owned by [TUI `/login` and Shift+Tab effort cycling](../feature/2026-09-15-tui-login-and-effort-cycle.md), the Web surface by [browser provider sign-in](../feature/2026-09-14-browser-provider-sign-in.md), and the seam vocabulary by [credential records and authorization flows](../architecture/2026-08-13-credential-records-and-authorization-flows.md).
