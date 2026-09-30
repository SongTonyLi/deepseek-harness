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
    previous: "2026-09-21-user-question-reply"
    after: "ea172c2ed8dec7d79a4192b9a6d8b9b0ece1883a987ad8ef4613e066abe77173"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "d9a3a8f54bfacf46732d4aa79259ffb76061a639decb9da29e44731cbcb24652"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "e73681a0c49ce85084e62b0f05c4babc972942f6e8954253edacf5ed57e89fb1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "9340955242dc4d086197eafa06ec6319116e9ee447d71f4dc4a9d12ba616eb10"
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
