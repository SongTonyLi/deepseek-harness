/**
 * The writable-root derivation shared by every enforcement dialect that
 * expresses a mode as a canonical allow-list: `workspace-write` means "the
 * workspace root plus the platform temp areas", and this module is that
 * meaning's one home. The Seatbelt profile
 * (`@deepseek-ai/dsh-sandbox-local`) and the in-process filesystem fence
 * (`@deepseek-ai/dsh-fs-sandbox`) both derive their allow-list here, so "the
 * write tool cannot write /tmp but bash can" asymmetries cannot arise between
 * them. The bwrap and Landlock dialects keep their own grant spellings (an
 * ephemeral `/tmp` mount, launcher-owned flags) — the honest per-runner
 * differences recorded in the sandbox RFC — with parity pinned by test.
 *
 * @module dsh-sandbox/roots
 */

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { SandboxExecutionPolicy, SandboxReadScope } from './index.ts'

/**
 * Resolve a granted root to the path the enforcement layer actually compares:
 * canonical (symlinks resolved), because both Seatbelt filters and the fs
 * fence's containment check match resolved paths — `/tmp` IS `/private/tmp`
 * on darwin, and an as-spelled grant would match nothing.
 * @param path - the root as configured or platform-reported.
 * @returns the canonical path, or the spelling as-is when resolution fails
 *   (a missing root matches nothing until it exists — the conservative
 *   outcome; inventing a fallback would grant a path the caller never named).
 */
export function canonicalPath(path: string): string {
  try {
    // Node's JavaScript realpath implementation lexically collapses `..`
    // before resolving a preceding symlink on some platforms. The native
    // implementation follows the filesystem's component-by-component lookup,
    // matching chdir/spawn and the enforcement layers this identity feeds.
    return realpathSync.native(path)
  } catch {
    // realpathSync.native failed: the path (or a prefix) is missing or unreadable.
    return path
  }
}

/**
 * The roots one confined execution may WRITE under — the mode's meaning as a
 * canonical, deduplicated allow-list. `read-only` allows nothing;
 * `workspace-write` allows the policy's workspace root, the host `/tmp`, and
 * the per-user platform temp dir (`os.tmpdir()` — the real temp area for
 * mkstemp-family tools; omitting it would deny what the mode promises).
 * @param policy - the file-effect policy to derive the allow-list from.
 * @returns the canonical writable roots; empty exactly under `read-only`.
 */
export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  return [...new Set([policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath))]
}

/**
 * Canonicalize a path that may not exist yet: the deepest existing ancestor
 * resolves through symlinks and the missing remainder is appended, after
 * lexical `.`/`..` collapse.
 * @param path - an absolute or process-relative path.
 * @returns the canonical spelling a containment check compares.
 */
function canonicalTarget(path: string): string {
  const absolute = resolve(path)
  const canonical = canonicalPath(absolute)
  if (canonical !== absolute) return canonical
  const parent = dirname(absolute)
  return parent === absolute ? absolute : join(canonicalTarget(parent), basename(absolute))
}

/**
 * Compile file-name globs, where `*` matches any run of characters and
 * matching ignores case, into one predicate. Compile once and reuse the
 * predicate when testing many names.
 * @param globs - patterns such as `.env.*` or `id_rsa*`.
 * @returns whether a single path component matches any whole pattern; always false for no globs.
 */
export function nameGlobMatcher(globs: readonly string[]): (name: string) => boolean {
  if (globs.length === 0) return () => false
  const patterns = globs.map(glob => glob.split('*').map(part => part.replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`)).join('.*'))
  const regex = new RegExp(`^(?:${patterns.join('|')})$`, 'iu')
  return name => regex.test(name)
}

/**
 * Whether the canonical file name of `path` matches a hidden-name glob of
 * `scope`, so a symlink cannot rename a hidden target into view.
 * @param path - the host path a reader is about to open or search.
 * @param scope - the read scope from `SandboxProvider.readScope`.
 * @returns true when the path is hidden regardless of its root.
 */
export function isHiddenIn(path: string, scope: SandboxReadScope): boolean {
  return nameGlobMatcher(scope.hiddenNames)(basename(canonicalTarget(path)))
}

/**
 * Whether `path` is readable within `scope`: it lies inside a root after both
 * are canonicalized (so neither `..` nor a symlink can leave the roots), and
 * its file name matches no hidden-name glob.
 * @param path - the host path a reader is about to open or search.
 * @param scope - the read scope from `SandboxProvider.readScope`.
 * @returns true when the path may be read.
 */
export function isReadableIn(path: string, scope: SandboxReadScope): boolean {
  if (isHiddenIn(path, scope)) return false
  const target = canonicalTarget(path)
  return scope.roots.some((root) => {
    const canonicalRoot = canonicalTarget(root)
    return target === canonicalRoot || target.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`)
  })
}
