---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-22-fork-attribution-kinds

English | [中文](2026-09-22-fork-attribution-kinds.zh.md)

## Summary

Record the terminal, continuation, reminder, and work-state notice attribution kinds.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-22-fork-attribution-kinds
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-22-action-card-status"
    after: "aecd7efd2039c07af034cdf97b66e1a80fe2bf51567d5fe27dec4925c0baf505"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-22-action-card-status"
    after: "0c346de2cbed1004158179312d21389d424e22168f6b0de154832ed78d19b6d2"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-22-action-card-status"
    after: "3d50e53da47c6f3b9d98921bcf0f92d1317977cae5ff9d410e35a4e80b247db0"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-22-action-card-status"
    after: "7c4c498b64a748d30fb80d9042094c3a2cb0a1ac27169519c28baf03e8f3cece"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Each added kind is an attribution-only `MessageSourceMap` entry on a user or developer source slot, qualified with `@persistenceAttribution`. Existing records keep their recorded kinds unchanged, and the Session header remains V4. A reader without the producer preserves the kind and its `form`/`summary` metadata, derives the message from its content alone, and needs no validation, replay, or authority projection; only the producing plugin reads its own kind, to avoid injecting the same notice twice.

<a id="verification"></a>
## Verification

The producing plugins' unit suites assert the recorded source on each injected notice, and the terminal transcript suite draws an unowned notice as injected context from the recorded kind alone.

<a id="dev-note"></a>
## Dev Note

None.
