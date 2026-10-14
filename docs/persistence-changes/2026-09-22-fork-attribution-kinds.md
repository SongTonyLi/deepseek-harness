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
    previous: "2026-10-13-user-rpc-principal"
    after: "8f46cfe00d9b7cef2188da411a30d9088ab0a376ba36f523839c48e5375adc6f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "b3e4411741ee4e0ec5ce40eb2054bac73e66c4586161748c3896ddbf41a0eac1"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "a4ccffb0fe337434bfbc4d054d092e0a97c0bbf2049b3a893e75e2434b3a77c1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "ecff517267d800dd81577a288bf654e14272d2eef1d00003fdb77144cd1b079d"
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
