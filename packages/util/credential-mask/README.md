---
description: "Credential recognition and display masking for user text, shared by the terminal and the browser: a linear scanner over published credential formats and the masked text it draws."
kind: "package-library"
---

# @deepseek-ai/dsh-util-credential-mask

English | [中文](README.zh.md)

## Summary

Callers can recognize credentials in user text by their published formats and draw them masked without importing a UI plugin. The masked text keeps line breaks and each provider prefix, and the input is never changed, so copy, export, and model requests keep the original text. The package has no runtime dependencies.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Mask text for display

`createCredentialMasker()` returns a `CredentialMasker` whose `mask(text)` returns the display form of `text`: a provider key keeps its first eight characters and replaces the rest with `MASK`, the password of an address that carries credentials is masked entirely, and a private key block keeps its first and last lines. The owner creates one masker and passes it to the code that draws text; each masker owns its scanner and keeps the last text it drew until it draws another.

```ts
import { createCredentialMasker } from '@deepseek-ai/dsh-util-credential-mask'

const masker = createCredentialMasker()
const sample = `sk-${'0123456789abcdef'.repeat(2)}`
// The first eight characters of the key stay readable; the rest mask.
const shown = masker.mask(`use ${sample} for the call`)
```

### Scan for credentials

`new CredentialScanner(formatTables())` finds the nearest credential at or after an offset through `match(text, from)`. Each node carries the original `start` and `end` and the display form `data.masked`. The scanner allocates nothing before it returns a node and memoizes the last queried text, so queries over one text share their work.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`formatTables()` derives independent lookup tables from the published credential formats. Each scanner owner creates its tables once and reuses them through its scanner. Each format check is a bounded character comparison or a sticky `[class]*` run that stops at the first character outside its class, so no format backtracks. A literal-only alternation finds where a format can begin, and the scan resumes inside a literal that can overlap the next one.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `createCredentialMasker()`, `CredentialMasker`, and the package exports |
| [`src/credential-formats.ts`](src/credential-formats.ts) | The published credential formats and their character classes |
| [`src/format-tables.ts`](src/format-tables.ts) | Lookup tables derived from the formats |
| [`src/credential-scanner.ts`](src/credential-scanner.ts) | The linear scanner that returns the nearest credential range |
| [`src/credential-masks.ts`](src/credential-masks.ts) | Display forms of credential ranges, built from shared mark strings |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Utility package map](../README.md) — adjacent stateless helpers.
- [Client secret rule](../../client/ui-secret-mask/README.md) — the browser `secret` user-text rule that wraps this scanner.
- [Credential matching performance](../../../.agents/notes/implemented/testing/2026-10-11-user-text-credential-matching.md) — the linear matcher and its time and allocation gates.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Recognition is format-based** — free-form passwords and `name=value` assignments without a published format stay plain.
- **The memo keeps one text** — a masker or scanner retains the last text it queried until a query for another text.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
