---
kind: upgrade-guide
description: "Custom Session Controller compositions must mount the shared continuation service."
---

# Session Controller requires the continuation service

English | [中文](guide.zh.md)

## Change

`SessionController` requires `sessionContinuation` for failed-turn retry admission. Custom compositions that mounted the controller without this service must add it; the shipped base and sdk-minimal bundles supply it. Existing Session retry source fields, the `conversationContinuation` projection key, checkpoint version, and wire view remain unchanged.

## Migration

1. Add `@deepseek-ai/dsh-session-continuation` to the dependencies and Cordis configuration of each custom Session Controller composition. Keep `@deepseek-ai/dsh-session-projection` mounted as well; the continuation service requires it.
2. In direct Host compositions, mount the projection registry and await `ctx.plugin(SessionContinuation)` before activating the Session Controller. Do not construct the service directly, because registration occurs during service activation.
3. Confirm the controller activates and an eligible failed turn can accept an empty retry. Recheck custom RPC consumers' authorization and request deduplication; those responsibilities remain with the caller. See the [service reference](../../../../packages/session/session-continuation/README.md) for eligibility and failures.
