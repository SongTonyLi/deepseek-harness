# Agent Note: File-reference completion outside the session cwd

Status: implemented

English | [中文](2026-09-15-file-reference-outside-workspace.zh.md)

## Problem

`@` completion listed only paths inside the session working directory. A query of `../`, `~/`, or an absolute directory returned no candidates, so a terminal or browser user could not mention a sibling repository or a file outside the current directory even though the host `read` tool accepts those paths.

## Decision

Directory-scoped `@` queries that resolve outside the workspace list that directory live. The inserted mention keeps the user's spelling (`../other-repo/file`, `~/project/file`, or an absolute path). Bare fuzzy queries still search only the bounded workspace index. A directory whose final path is a symbolic link still yields no candidates, whether the query started inside the workspace or named the link from outside it. `FILE_REFERENCE_PROMPT` names those four spellings as user-referenced paths.

## Alternatives considered

**Index the parent tree or the home directory for a bare `@`.** Rejected because an unbounded traversal would put private files next to every empty `@` and consume the entry budget.

**Follow a directory symlink when the user typed its path.** Rejected because that is the same escape as a workspace-planted link; the user can name the real path instead.

**Lift the fence only in the terminal.** Rejected because Web and `dsh tui` share `file-reference-local`.

## Consequences

- Completion remains advisory: sandbox and filesystem policy decide whether `read` can open the mentioned path.
- Package specs cover sibling-repo `../`, mocked-home `~/`, absolute-outside, and symlink refusal; they do not scan a real home directory.

## Related decisions

Terminal `@` completion remains owned by [terminal surface as the shipped `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.md).
