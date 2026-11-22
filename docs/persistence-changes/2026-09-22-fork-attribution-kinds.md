---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-22-fork-attribution-kinds

English | [中文](2026-09-22-fork-attribution-kinds.zh.md)

## Summary

Record the terminal, continuation, reminder, and work-state notice attribution kinds alongside the retry message source. This transition builds on the sdk-user message source record, which is its predecessor for each root both records change.

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
    previous: "2026-11-19-cua-input-notices"
    after: "2ecd066011ceee26a6e3ea9834328615aac76689668fbbdbc7a44991c557c671"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-19-cua-input-notices"
    after: "c9310f6d8131040e838c44d889942f30bd119f653b815e3779f41a1b651f936e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-19-cua-input-notices"
    after: "8b71dae5f77cf8f2b541ee92ebed2448aa180ad1178c7f12ef2060ea175fdbdd"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-19-cua-input-notices"
    after: "1c6578c0e2377ed3b717310f7d8a50f722da22145ed022813bc29386c7deab60"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing `retry` and earlier message records remain readable, and the Session header remains V4. Each added kind is an attribution-only `MessageSourceMap` entry qualified with `@persistenceAttribution`. Readers without its producer preserve the kind and `form`/`summary` metadata and derive the message from its content without attribution-specific validation, replay, or authority projection. A producer reads its own kind only to avoid injecting the same notice twice. Records written before the Timeline priority notice, and records written after it without these kinds, are read under the same rule.

<a id="verification"></a>
## Verification

Package suites for the eight packages that carry the `@persistenceAttribution` marker passed on the merged tree: no-progress-reminder, goal-round-driver, compaction-basic, tmux-context, action-cards, user-questions, working-directory, and tui-app. 1995 tests passed across 113 files, with one pre-existing skip.

<a id="dev-note"></a>
## Dev Note

None.
