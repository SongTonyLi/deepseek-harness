# Agent Note: session-controller continuation move and its compatibility

Status: implemented

English | [中文](2026-11-12-session-controller-continuation-compatibility.zh.md)

## Problem

The upstream sync keeps the fork's move of the continuation projection out of `SessionController` and into the `session-continuation` plugin. The direct test harness now registers that projection before constructing the controller, so blocking the first projection registration no longer exercises assistant-stream observation during list initialization.

## Decision

The user accepts option A: [the initialization spec](../../../../packages/api/session-controller/tests/controller.host.spec.ts) gates the first `sessionListMetadata` registration. This preserves its assertion that an assistant-stream frame arriving during the controller's list initialization remains observable. The adjustment is test-only: it adds no production composition change or controller-owned fallback mount and leaves the shared continuation admission behavior unchanged.

The [sync decisions](2026-11-12-fork-runtime-decisions-after-upstream-sync.md) reference this choice. The [manual-continuation decision](../feature/2026-10-26-manual-generation-continuation.md) retains the admission-policy rationale. Mounting `terminal-controller` in the TUI remains deferred and is not part of this decision.

## Facts

1. **Mounting.** The [Web layer](../../../../packages/bundle/web-app/cordis.patch.yml) mounts `session-controller` and the separate `terminal-controller`. The shared [base layer](../../../../packages/bundle/base/cordis.patch.yml) mounts `session-continuation`. The [TUI layer](../../../../packages/bundle/tui-app/cordis.patch.yml) mounts neither controller.
2. **Injection.** The fork adds `sessionContinuation` to [`SessionController.inject`](../../../../packages/api/session-controller/src/index.ts); `upstream/master` does not require it. Cordis's [`Fiber._refresh()`](../../../../vendor/cordis/src/fiber.ts) keeps a plugin inactive while a required service is missing, so a Cordis-managed controller now needs that service. Direct construction followed by an explicit init call, as in the test harness, does not itself exercise the plugin's injection check.
3. **Initialization order.** [`SessionController` initialization](../../../../packages/api/session-controller/src/index.ts) creates `HistoryController` before awaiting `listState.initialize()`. [`HistoryController`](../../../../packages/api/session-controller/src/history/controller.ts) attaches the [assistant-stream listener](../../../../packages/api/session-controller/src/history/assistant-stream.ts) during construction. In `upstream/master`, `commands.initialize()` registers the continuation projection between these two steps; the fork removes that call. The projection now registers in [`SessionContinuation` initialization](../../../../packages/session/session-continuation/src/index.ts). The fork's [direct harness](../../../../packages/api/session-controller/tests/test-remote.ts) awaits `ctx.plugin(SessionContinuation)` before constructing `TestController`, so registration precedes the listener in that harness. This is not a claim about construction order in every possible composition.
4. **Recorded failure.** With the upstream selector, [the initialization spec](../../../../packages/api/session-controller/tests/controller.host.spec.ts), “keeps assistant stream observation live while list initialization awaits”, reports assistant-stream revision 0 instead of 1 in the recorded sync run. Its spy gates the first projection registration after installation. In the fork's harness that registration is the continuation projection, before the controller's listener exists, so the synthetic start frame misses the controller's accumulator. This explains the test mismatch; it does not establish production frame loss during list initialization. The accepted selector instead gates `sessionListMetadata`.
5. **Harness differences.** The fork's [`test-remote.ts`](../../../../packages/api/session-controller/tests/test-remote.ts) imports and awaits `SessionContinuation` before `new TestController`; `upstream/master` has neither addition. [`continuation.host.spec.ts`](../../../../packages/api/session-controller/tests/continuation.host.spec.ts) imports the moved projection from its new package. The separate [`session.client.spec.ts`](../../../../packages/api/session-controller/tests/session.client.spec.ts) difference supplies a deterministic request id for a steering assertion; it does not change continuation initialization.
6. **Type compatibility.** [`session-controller/src/types.ts`](../../../../packages/api/session-controller/src/types.ts) imports and re-exports `SessionRequestId` from [`session-continuation/src/types.ts`](../../../../packages/session/session-continuation/src/types.ts), preserving the existing import path and brand. The latter file also declares `SessionProjectionMap.conversationContinuation: SessionSeq | null` and `MessageSourceMap['retry-rpc']` with the same fields as upstream. These are module augmentations, not separately exported fields removed from the controller API. They remain reachable through the controller types' import/re-export, so moving their declarations alone does not demonstrate a public type break. The Web's [input hub](../../../../packages/client/ui-conversation/src/client/input/hub.ts) and [input bar](../../../../packages/client/ui-conversation/src/client/skeleton/InputBar.tsx) still read `conversationContinuation`. Published declaration resolution has not been independently checked in this documentation review.
7. **Runtime dependency.** [`commands.ts`](../../../../packages/api/session-controller/src/commands.ts) imports `SessionContinuationBusyError` and delegates empty-prompt admission to `ctx.sessionContinuation.retry`. The controller's [`package.json`](../../../../packages/api/session-controller/package.json) declares `@deepseek-ai/dsh-session-continuation` as both a development and a peer dependency.
8. **Empty-prompt routing.** [`@Remote('prompt')`](../../../../packages/api/session-controller/src/index.ts) gives empty content the source kind `retry`. [`commands.ts`](../../../../packages/api/session-controller/src/commands.ts) requires queue mode for this path and maps an unavailable continuation or an admission failure to `session/agent-busy`.

## Compatibility with the TUI and terminal-controller

`session-controller` serves Session Remote operations; [`terminal-controller`](../../../../packages/api/terminal-controller/src/index.ts) manages Session-owned terminals. The latter is not the TUI application. The shipped TUI and base patches mount neither controller, and the TUI's [source](../../../../packages/bundle/tui-app/src/app.ts) and [manifest](../../../../packages/bundle/tui-app/package.json) have no imports or dependencies on either controller package. The session-controller spec mismatch is therefore not evidence that terminal-controller must be mounted in the TUI.

The TUI's `/retry` uses the shared `sessionContinuation` service directly and imports `SessionContinuationBusyError` and `SessionRequestId` from the continuation package. Changes to that package can affect both Web retries and TUI retries even though the TUI bypasses the Session Remote controller. This coupling needs verification independently of the controller's test selector. Mounting terminal-controller in the TUI remains deferred; this note neither implements it nor certifies its compatibility with the TUI.

## Alternatives considered

**B. Source guard.** Making `SessionController` mount `SessionContinuation` when absent adds composition ownership to the controller to accommodate direct construction. The bundle already supplies the service, and the spec can target list initialization without changing production ownership. The test-only adjustment avoids that additional lifecycle and ordering responsibility.

**C. Keep the upstream selector without another change.** The recorded direct-harness run fails one of eight tests because the selector blocks continuation setup rather than list initialization. Keeping that selector leaves the check failing without testing the intended interleaving; it does not justify changing the shared continuation behavior.

## Consequences

- The spec continues to observe frames during list initialization without changing shared continuation admission or the TUI's direct `/retry` path.
- The fork changes an upstream test file, so later upstream syncs may conflict on that selector.
- The controller's accumulator cannot observe frames emitted before its listener attaches. The direct-harness failure demonstrates that limitation, not a production boot race or an ordering guarantee for arbitrary compositions.
- Terminal-controller mounting in the TUI remains deferred. The controller spec is not a substitute for verifying that separate integration.

## Verification

These are retained results from the sync work, not fresh test runs for this documentation update or a terminal-controller/TUI compatibility check.

- Target spec with option A: 1 file / 8 tests pass. With the upstream selector: 1 test fails and 7 pass; expected revision 1, received revision 0.
- `pnpm exec vitest run packages/api/session-controller` with option A: 51 files / 1,135 tests pass.
- `packages/experimental/liveshare`, `packages/experimental/client-ui-cot-translation`, and `packages/test-support/client-runtime` with option A: 156 files pass; 1,577 tests pass and 1 is an expected failure.
