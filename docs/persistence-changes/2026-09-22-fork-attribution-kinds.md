---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-22-fork-attribution-kinds

English | [中文](2026-09-22-fork-attribution-kinds.zh.md)

## Summary

Record the terminal, continuation, reminder, and work-state notice attribution kinds alongside the `retry` message source.

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
    previous: "2026-10-27-retry-control-input"
    after: "3a9f532fdce6b1065b89c210760639e13897c3b9780ae1aed38d58f1862464f8"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "c72bb925c77731c0c53faaf1c4734cf6090829c6cdcd781d23491da76d3f02a7"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "576e5323de7e752ffb4dfac8abd756976f0cfce7cbea116b77f3f654fe5755c8"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "c2574cff7c7c777baa5ee06efb5fee3e610f978642c78a0b8e08212918b16e4a"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing `retry` and earlier message records remain readable, and the Session header remains V4. Each added kind is an attribution-only `MessageSourceMap` entry qualified with `@persistenceAttribution`. Readers without its producer preserve the kind and `form`/`summary` metadata and derive the message from its content without attribution-specific validation, replay, or authority projection. A producer reads its own kind only to avoid injecting the same notice twice.

<a id="verification"></a>
## Verification

Focused no-progress reminder, goal-round driver, compaction, terminal side-agent, retry-input, and V3-to-V4 migration tests passed: 279 tests across seven files.

<a id="dev-note"></a>
## Dev Note

None.
