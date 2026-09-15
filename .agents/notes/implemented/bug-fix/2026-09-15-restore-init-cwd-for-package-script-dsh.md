# Agent Note: Restore `INIT_CWD` for package-script `dsh` launches

Status: implemented

English | [中文](2026-09-15-restore-init-cwd-for-package-script-dsh.zh.md)

## Problem

The product CLI treats the invoking directory as the workspace root, but npm and pnpm run a package script with `process.cwd()` set to the package that owns the script. `pnpm --dir <checkout> dsh tui` from another project therefore recorded the checkout as `session.header.cwd`, loaded that checkout's `.env` and `AGENTS.md`, and sandboxed tools there. Direct `node …/bin.js` launches and children spawned with an explicit `cwd` while inheriting the manager's variables were not the same rewrite.

## Decision

Before argument parsing and `loadLayeredEnv`, the `dsh` bin restores `INIT_CWD` when it is an existing directory and `npm_package_json` names the package whose directory is the current cwd. That is the npm/pnpm script rewrite. A missing `INIT_CWD`, a missing `npm_package_json`, a spawn cwd that is not that package directory, or a stale `INIT_CWD` path leaves cwd unchanged. The installed PATH binary is unchanged: it has no script rewrite and keeps the spawn cwd.

## Alternatives considered

**Always `chdir` to `INIT_CWD` when the variable is set.** Rejected because test and embedding spawns copy the parent environment and pass their own `cwd`; those children would jump to the parent's invoking directory.

**Walk from `INIT_CWD` to a `.git` root.** Rejected because the existing workspace root is the invoking directory; instruction discovery already walks to project markers. Changing session cwd to the git root would retarget subdirectory launches of the installed binary.

**Document `cd` before `pnpm dsh` and leave cwd as the checkout.** Rejected because the CLI already promises the invoking directory, and `pnpm --dir` is the supported way to run a source checkout against another project.

## Consequences

- `pnpm --dir <checkout> dsh tui` from project P uses P as the session cwd, `.env` layer, and sandbox root.
- `pnpm dsh tui` from the checkout itself is unchanged: `INIT_CWD` equals the package directory.
- [Configuration source ownership](../architecture/2026-08-04-configuration-source-ownership.md) still owns which `.env` names are refused; this note only owns which directory is the invoking directory after a package-script rewrite.

## Related decisions

The invoking-directory environment layer remains owned by [configuration source ownership](../architecture/2026-08-04-configuration-source-ownership.md).
