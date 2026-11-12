# Agent Note: fork decisions that differ from upstream after the sync

Status: implemented

English | [中文](2026-11-12-fork-runtime-decisions-after-upstream-sync.zh.md)

## Problem

This fork tracks upstream master as of PR #8278 and differs from it in four decisions: a read-fence refusal in the local sandbox, a credential matcher kept in a static Client utility, an `interrupt_agent` tool that the terminal profile enables while upstream's built-in configurations disable it (PR #7986), and rescope exemptions for four files that name the `cordis` agent-preset id. The code shows what each decision does but not why it differs from upstream; this note records the reasons.

## Decision

The user accepts the test-only `sessionListMetadata` selector adjustment recorded in [session-controller continuation compatibility](2026-11-12-session-controller-continuation-compatibility.md). It preserves the shared continuation service without adding a controller-owned mount; mounting `terminal-controller` in the TUI remains deferred.

### Read-fence refusal keeps its code string

Upstream has no read fence. No upstream package contains `confineWithReadFence` or `SANDBOX_UNSUPPORTED_POLICY`, and upstream's commit `refactor(sandbox): remove obsolete unsupported-policy error` removed the `SandboxUnsupportedPolicyError` export from `@deepseek-ai/dsh-sandbox`. The refusal exists only in this fork.

When the selected runner or a configured `runnerCommand` cannot enforce a read fence, the local provider refuses the execution before a process starts, with the code `SANDBOX_UNSUPPORTED_POLICY`. The refusal is `SandboxUnsupportedPolicyError`, a package-local `HarnessError` subclass in [errors.ts](../../../../packages/sandbox/sandbox-local/src/errors.ts); `@deepseek-ai/dsh-sandbox` exports no class for it ([entry](../../../../packages/sandbox/sandbox/src/index.ts)). The class is thrown in two branches of `wrap` in [index.ts](../../../../packages/sandbox/sandbox-local/src/index.ts): the `runnerCommand` branch and the non-Seatbelt branch.

The specs key on the code string. [local.spec.ts](../../../../packages/sandbox/sandbox-local/tests/local.spec.ts) asserts both refusals by code and message, and [provider.spec.ts](../../../../packages/sandbox/sandbox-apple-container/tests/provider.spec.ts) asserts the code for the Apple container backend, whose [README](../../../../packages/sandbox/sandbox-apple-container/README.md) documents it. The read fence itself is recorded in [Host-bound processes confine on the host under a read fence](../bug-fix/2026-11-05-container-host-bound-processes.md).

### The credential matcher lives in a static utility

The credential scanner and its format tables live in `@deepseek-ai/dsh-util-credential-mask` ([README](../../../../packages/util/credential-mask/README.md)). Upstream keeps them in `@deepseek-ai/dsh-client-ui-secret-mask`. The utility is a statically linked Client library: [PLATFORM_MODULES](../../../../packages/client/web/src/platform.ts) lists it, and [seed.ts](../../../../packages/client/web/src/seed.ts) seeds it into the shell's module table.

The terminal surface has one owner: [app.ts](../../../../packages/bundle/tui-app/src/app.ts) creates one masker with `createCredentialMasker()` and passes it to `UserBlock` in [blocks.ts](../../../../packages/bundle/tui-app/src/blocks.ts) and to `renderQueuePanel` in [queue-panel.ts](../../../../packages/bundle/tui-app/src/queue-panel.ts). The masker's type, `CredentialMasker`, has one method, `mask(text)`, which returns the display text. The Web `secret` rule creates its own `CredentialScanner` in each `createSecretRule()` call ([secret-rule.ts](../../../../packages/client/ui-secret-mask/src/client/secret-rule.ts)), because it needs the match ranges (`start` and `end`) that `mask(text)` does not return.

The client rules forbid a feature plugin from runtime-importing another feature plugin's values, and they place shared runtime code in a narrow static owner such as `client/store`, `ui-primitives`, or a browser-safe utility package ([export discipline](../../../../packages/client/AGENTS.md#export-discipline-client-plugin-packages)). The utility's [manifest](../../../../packages/util/credential-mask/package.json) declares no `dependencies`, only the `@deepseek-ai/cordis` peer and development dependencies that harness packages declare. The matching algorithm and its budgets are recorded in [linear credential matching and performance gates for user text](../testing/2026-10-11-user-text-credential-matching.md).

### The terminal profile keeps interrupt_agent on

The terminal profile, `packages/bundle/tui-app`, is not in upstream. Its [tool-subagent-control row](../../../../packages/bundle/tui-app/cordis.patch.yml) sets `config.interrupt: true`, so the terminal's tool set includes `interrupt_agent`. The shipped base ([row](../../../../packages/bundle/base/cordis.patch.yml)) and the Web [`standard`](../../../../packages/bundle/web-app/presets/standard.patch.yml), [`cordis`](../../../../packages/bundle/web-app/presets/cordis.patch.yml), and [`ptc`](../../../../packages/bundle/web-app/presets/ptc.patch.yml) presets set `interrupt: false`. Within `packages/bundle`, only the terminal row enables it. The [plugin](../../../../packages/subagent/tool-subagent-control/src/index.ts) defaults to `true` for compositions that omit the setting.

The terminal profile enables Agent Teams by default ([row](../../../../packages/bundle/tui-app/cordis.patch.yml)). The Team surface reaches teammates through the standard control tools, `interrupt_agent` among them ([tool-agent-team](../../../../packages/team/tool-agent-team/README.md)). Built-in configurations disable the tool by default ([agent-team](../../../../packages/team/agent-team/README.md)).

### Four files keep the cordis preset id under the rescope gate

The fork adds four entries for the bare `cordis` name to `GENERIC_SKIPS` in [rescope-vendor.ts](../../../../scripts/rescope-vendor.ts): [creator-persona.e2e.ts](../../../../apps/web/tests/creator-persona.e2e.ts), [agent-scopes.spec.ts](../../../../packages/experimental/cua/tests/agent-scopes.spec.ts), and the English [subagent-interrupt-default guide](../../../../docs/upgrade-guide/v0.2.2-rc.1/subagent-interrupt-default/guide.md). The Chinese `guide.zh.md` is the fourth entry. The product-identifier table in [rescope-vendor.spec.ts](../../../../scripts/rescope-vendor.spec.ts) lists all four files and asserts that rescoping changes none of them.

The rescope gate rewrites the bare `cordis` name to `@deepseek-ai/cordis` in delimited name tokens, YAML `name:` scalars, and TypeScript or JavaScript module specifiers. In these four files the bare name is product data, the `cordis` agent-preset id: creator-persona selects it as its default preset and asserts the session's preset id, agent-scopes lists it among its presets, and the subagent-interrupt guide names it in its change and migration steps. Upstream's rescope list has no entry for any of the four files.

A `GENERIC_SKIPS` entry for a file and the token `cordis` makes the token rule skip every quoted bare `cordis` in that file, including quoted module specifiers in Markdown prose, so the product strings stay unchanged. The module-syntax pass in `rewriteModules` still rewrites a bare `cordis` module specifier in a skipped TypeScript or JavaScript file and in its TypeScript or JavaScript fences. None of the four files has such a specifier: creator-persona uses only quoted preset ids, agent-scopes imports the scoped `@deepseek-ai/cordis` and uses quoted preset ids, and both guides' fences are YAML.

The code comment above the `ui-agent-preset` entries records that renaming the bare name changed which preset the creator flow stages and which id the roster reports.

## Alternatives considered

**Export the class from `@deepseek-ai/dsh-sandbox`.** It lost because upstream removed that export, and no package outside `sandbox-local` constructs or imports the class, so a shared export would add a public type with no consumer.

**Keep the scanner in `dsh-client-ui-secret-mask` and import it from the terminal surface.** It lost because the client rules name narrow static owners for shared runtime code, and a feature plugin is not one.

**Place the scanner in `client/store` or `ui-primitives`.** It lost because `client/store` owns the snapshot-store engine and `ui-primitives` holds the shared controls, and the scanner has neither responsibility ([layering rules](../../../../packages/client/AGENTS.md#layering-red-lines)).

**Keep the disabled base row for the terminal.** It lost because the terminal profile enables Agent Teams by default, and the Team surface reaches teammates through `interrupt_agent`, which the built-in configurations disable.

**Enable the tool in the shared base.** It lost because upstream turned it off in built-in configurations in PR #7986, and the Web presets keep that setting.

**Rename the bare `cordis` in the four files like its other uses.** It lost because the bare name is the preset id these files select, assert, and document, and the code comment above the `ui-agent-preset` entries records that renaming it changed which preset the creator flow stages and which id the roster reports.

## Consequences

- **Read-fence refusal:** A caller that recognizes the refusal matches the code string, because the class is not re-exported from `sandbox-local`'s entry or from `dsh-sandbox`. Changing the string requires updating `errors.ts`, the JSDoc that names it, both specs that assert it, and each README that documents it.
- **Credential matcher:** The Web `secret` rule and the terminal surface share one utility, so a scanner change reaches both surfaces. Adding a static Client library means editing `PLATFORM_MODULES` and `seed.ts` together. The `satisfies Record<PlatformModule, unknown>` clause in `getStaticModules()` is the compile-time check for that pair, and its comment states that a word added to `PLATFORM_MODULES` without a static import, or the reverse, fails to compile.
- **Interrupt tool:** The terminal's tool set includes `interrupt_agent`, which the base and Web presets omit. The terminal row sets the value explicitly, so a change to the base row does not alter the terminal.
- **Rescope exemptions:** The four files keep their product values. Upstream's list has 76 entries for the bare name, and the fork adds these four. Any other eligible file that quotes the bare name is rewritten unless the list names it.
