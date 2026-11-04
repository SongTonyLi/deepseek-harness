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
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "2c8a1d2db845f53f79de0eaf79b149d5d821bf31d186880a94642c0de8d9109b"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "1288035c34b3a630c6992672f16ea19c3e336a15c9ded5af24b114e1dbf0e59a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "5c8b5610277b8600b418e3790ea80c3dcedcced5bb0bcffff3945d66d20fa29c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "adc3a3ecaf30c00e5d2c32ce70b986a9450b979a8121263849a526b2b8ab4c8b"
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
