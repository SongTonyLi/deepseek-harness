# Agent Note: Retry invalid JSON from the Auto reviewer

Status: implemented

English | [中文](2026-10-02-auto-review-json-retries.zh.md)

## Problem

The Auto reviewer can return explanatory prose despite its JSON instructions. Parsing that prose immediately fails an ordinary tool call before its body executes. The [original Auto decision](../feature/2026-08-28-auto-review.md) excludes retries, so a temporary formatting failure interrupts authorized project work.

## Decision

The reviewer retries only a completed response whose single final text block fails JSON parsing. The package's `maxJsonRetries` setting is a non-negative safe integer, defaults to `1`, and accepts `0` to disable retries. Each attempt uses the same frozen action facts, route, sampling settings, and cancellation signal. A retry appends a fixed JSON formatting reminder to the policy; the malformed response supplies neither instructions nor authorization and is not sent back to the reviewer.

Every attempt must pass the complete stream and risk/decision validation before its result can authorize execution. Valid denials, invalid decision objects, duplicate JSON members, provider failures, invalid stream completion, and cancelled reviews are not retried. Exhaustion returns a reviewer failure with `auto-review: reviewer output must be valid JSON`; it never executes the tool body. The [user-approval fallback](../feature/2026-09-24-auto-review-user-approval-fallback.md) still owns valid denials.

## Alternatives considered

**Extract a JSON object from surrounding prose.** A response can contain conflicting decisions or quoted examples. Requiring the entire response to parse avoids choosing an authorization from ambiguous text.

**Retry denials or every reviewer failure.** Repeated classification could replace a valid denial with an allow, while provider and stream errors require their own diagnosis. Formatting recovery stops before either case.

## Consequences

Malformed JSON can add model latency and token cost up to the configured retry limit. Reviewer attempts remain transient and add no Session events. Owner tests cover recovery, denial, exhaustion, disabled retries, PTC calls, and cancellation; the recorded TUI replay exercises a prose response followed by valid JSON through the shipped profile and production Bash tool.
