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
    previous: "2026-10-05-working-directory-attribution"
    after: "3657a134850d96e4ca1c9f54bae79a5bb8f6b40eea412d8f5f362c6e9292d3bb"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "9ba59a2a9237a9f5eebb860f46c08c1f5f719d26712ee8579eda8bf885bc7838"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "e8597919599b39fdd41b62528bdfa009817050cc821d109982b408a773b9844b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "bbc82c00f7d5080f24f5038c38ef9502030af02572d1c1deb47c6be43f7e39ab"
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
