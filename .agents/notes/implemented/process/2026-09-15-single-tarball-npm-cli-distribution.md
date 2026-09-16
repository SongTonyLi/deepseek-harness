# Agent Note: One npm tarball that installs the whole dsh runtime

Status: implemented

English | [中文](2026-09-15-single-tarball-npm-cli-distribution.zh.md)

## Problem

Installing `dsh` from npm means installing `@deepseek-ai/dsh` and resolving the roughly two hundred `@deepseek-ai/dsh-*` packages it depends on, each of which must already be published at a matching version. That works for the repository's own release, which publishes the whole family under one version from one tag, but it is unavailable to anyone distributing a build of this source they do not own the scope for: a fork that changes even one shared package cannot ship it, because npm resolves every other name to the published upstream copy. The terminal surface is exactly that case — `dsh-tui-app` depends on forked builds of `dsh-file-reference`, `dsh-host-plugin-inventory`, and `dsh-user-questions` — so there was no way to hand someone a single command that installs a terminal agent and starts it.

The two existing self-contained assemblies do not answer it either. The Desktop runtime installs the published `@deepseek-ai/*` packages from the registry into an Electron resource tree, so it presupposes the family release. The single-file executable stages the closure locally but compiles it into a `pkg` binary distributed through Python wheels, not through npm.

## Decision

`pnpm run build:npm-cli` assembles one npm package, `dsh-cli`, whose payload is the whole Node closure carried as `bundleDependencies`. The installed executable is `dsh`, and the package depends on no `@deepseek-ai` name at install time, so the registry never resolves a second copy of anything the payload already contains.

The payload is the runtime closure the single-file executable already defines, `python/sdk-runtime`, staged symlink-free by `pnpm deploy --legacy --config.node-linker=hoisted`. Reusing that manifest is what keeps the package honest about what a profile boot needs: plugins that `cordis.yml` names by string are not dependency edges of any package, and the closure manifest is where they are enumerated and gated by `verify-runtime-closure`.

Four properties of the staged tree are established by the build rather than assumed, because each one is invisible until a user runs the result:

- **`workspace:` ranges are pinned.** `pnpm deploy` leaves them in the nested manifests and npm cannot parse the protocol. Every range is rewritten to the version staged beside it, which is exact because the payload is closed.
- **Platform variants are unbundled.** Packages carrying `os`/`cpu` resolve one build per platform, so bundling the staged tree would publish a darwin-arm64-only package. The build drops those variants from the payload, removes their entries from bundled parent manifests, and declares each variant once in the published package's top-level `optionalDependencies`, letting npm select per install. The single declaration lets a global npm install materialize the selected variant instead of retaining an empty nested package directory. This covers ripgrep, sharp, koffi, `node-addon-require-builtin`, and the Landlock launcher; `node-pty` and `pi-tui` ship every prebuild inside one package and stay bundled.
- **Missing workspace peers are added.** A `workspace:` peer is satisfiable only from this repository, so pnpm's peer auto-installation cannot supply one and the deploy root's dependency list is the only thing that pulls it in. Where that list is short, the build packs the workspace package exactly as it would publish and unpacks it into the payload, repeating until nothing is unresolved. Assembling the terminal profile this way found two such gaps, `dsh-session-title-llm` and `dsh-util-workspace-path`, both reached through `dsh-base` and both invisible to `verify-runtime-closure`, which walks shipped agent presets rather than bundle patches.
- **The payload is proved closed before it is packed.** Every dependency and every non-optional peer of every payload package must resolve inside the payload. This check runs before the range pinning, because pinning drops the ranges it cannot resolve and would otherwise erase the evidence.

The shipped bin defaults a bare `dsh` to the `tui` profile and passes every other invocation through untouched, so `dsh web`, `dsh plugin`, `dsh --profile <name>`, and the app-owned flags behave as they do from a source checkout. It calls the launcher's exported `runCli` rather than relying on the module's `import.meta.main` self-dispatch, which is false for an importer. It answers `--version` itself with both versions, because the launcher reports the harness build it was assembled from and a package published under its own version line would otherwise look like it installed something else.

Packaging restores the files `pnpm deploy` rewrites to describe the repository's own install. A `--prod` deploy records `dev: false` in the workspace state, after which every `pnpm run` reads the workspace as stale and offers to purge the repository's dev dependencies.

## Verification

`pnpm run build:npm-cli` fails the build on an unresolvable runtime edge, which is the property a published tarball cannot recover from. The focused packaging test also pins root-only platform declarations, workspace-range normalization, unrelated optional-dependency preservation, and conflict detection before mutation. The assembled package was installed from its tarball into a clean global prefix, where `@vscode/ripgrep` resolves and executes the selected `rg` binary. The shipped command checks remain `dsh --version`, `dsh --help`, `dsh tui --help`, `dsh --profile headless --help`, and `dsh web --help`; a bare `dsh` under a pty initializes the `tui` profile, renders the session header, model, permission preset, and key hints, and exits cleanly with its resume hint. The presence of `@deepseek-ai/dsh-tui-app` in the installed tree proves the bundled payload was used rather than a registry copy, since that package is not published.

A model round trip is not covered: the smoke runs without a provider key, so the assembly is verified up to the first model request.

## Alternatives considered

**Publish the family under a scope the fork owns.** Rejected: rewriting `@deepseek-ai/dsh` to another scope at pack time works, but it publishes roughly 270 package names per fork and per release, and every consumer of the result inherits a parallel universe of names for packages whose sources are identical to upstream.

**Publish only the changed packages and let npm resolve the rest.** Rejected as incorrect rather than merely costly: npm resolves each name independently, so a payload mixing forked and upstream builds of the same version is exactly what the bundle exists to prevent.

**Bundle the closure into one file with a bundler.** Rejected: Cordis resolves plugin modules from `cordis.yml` by package name at runtime, and the harness launches worker threads and subprocesses that repeat that resolution, so a single-file build would have to reproduce module resolution rather than rely on it.

**Ship the tree under a directory npm does not strip and resolve it from the bin.** Rejected in favour of `bundleDependencies`, which is the supported mechanism for carrying a dependency tree in a tarball and needs no resolver of our own.

**Trim the payload to the terminal profile's closure.** Rejected: dropping `dsh-web-app` and `dsh-acp-app` would save part of a 22 MB tarball and turn `dsh web` and `dsh acp` into broken commands in the published build, and it would require a packaging-only fork of `apps/cli`'s dependency list that nothing else in the repository validates.

## Consequences

The cost is that the payload is a point-in-time snapshot. A bundled dependency's fix reaches users only when this package is rebuilt and republished, because npm cannot upgrade anything inside a bundle; the tarball is 22 MB for a 92 MB install, most of it code that also exists on the registry under its own name; and the published tree's lifecycle scripts are stripped, so anything a dependency would have done at install time must already hold in the staged tree. The assembly is also host-shaped in one respect this does not remove: the bundled portion is built on one machine, and only the `os`/`cpu` packages are resolved per install.

What it buys is a distribution that does not depend on owning a scope or on the family release, which is what makes the terminal surface installable at all from a fork. Everyone who installs gets the same bytes for everything except the native variants, so a report about a published build names one artifact. The closure check is the durable part: it states the property the payload has to satisfy and fails the build rather than the first launch, and it found two real gaps — `dsh-session-title-llm` and `dsh-util-workspace-path` — that `verify-runtime-closure` does not cover because it walks shipped agent presets rather than bundle patches. `dsh plugin` still shells out to pnpm, so managing out-of-tree plugins needs pnpm on `PATH` exactly as it does from a source install.
