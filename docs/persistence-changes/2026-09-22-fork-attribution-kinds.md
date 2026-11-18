---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-22-fork-attribution-kinds

English | [中文](2026-09-22-fork-attribution-kinds.zh.md)

## Summary

Record the terminal, continuation, reminder, and work-state notice attribution kinds alongside the retry message source. This transition builds on the Timeline priority notice record, which is its predecessor for each root both records change.

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
    previous: "2026-11-05-timeline-priority-notice"
    after: "6a741cea1919b7178b2e30d38ef1814da4af9e979bc70c093f54380a5c60ab5f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "94ed843642dbeb1b02c6a35e0d5bb96c071a48283a9de74b30fa2d6cb5d669d5"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "b5de2f0370e8ccce85c00e24cfa966aba660ecf6f403a28241a2f1b5637c950b"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "f80605cc21b9b582b68e2e816b20f0d8390425665971840b4881e4d00aef0b0a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing `retry` and earlier message records remain readable, and the Session header remains V4. Each added kind is an attribution-only `MessageSourceMap` entry qualified with `@persistenceAttribution`. Readers without its producer preserve the kind and `form`/`summary` metadata and derive the message from its content without attribution-specific validation, replay, or authority projection. A producer reads its own kind only to avoid injecting the same notice twice. Records written before the Timeline priority notice, and records written after it without these kinds, are read under the same rule.

<a id="verification"></a>
## Verification

Package suites for the eight packages that carry the `@persistenceAttribution` marker passed on the merged tree: no-progress-reminder, goal-round-driver, compaction-basic, tmux-context, action-cards, user-questions, working-directory, and tui-app. 1976 tests passed across 111 files, with one pre-existing skip.

<a id="dev-note"></a>
## Dev Note

None.
