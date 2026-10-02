---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-01-sandbox-backend-event

English | [中文](2026-10-01-sandbox-backend-event.zh.md)

## Summary

Adds the log-only `sandbox/backend` Session event, which records a `/sandbox` switch between the Apple container and local sandbox backends.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-01-sandbox-backend-event
baseline: false
changes:
  - root: "event:sandbox/backend"
    previous: null
    after: "d4625f12f4753a49ecbd0822fb534207e5d087be05992290cd7eedf23812a9d3"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs contain no `sandbox/backend` events and replay unchanged; the configured default backend applies to them. The event is required-on-read, so builds older than this change refuse a log that contains it, as with any new event type.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/sandbox/sandbox-apple-container: 58 tests passed, including the /sandbox switch and its projected backend.

<a id="dev-note"></a>
## Dev Note

None.
