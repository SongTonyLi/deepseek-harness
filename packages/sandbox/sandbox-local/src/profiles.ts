/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { workspaceWritableRoots, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    for (const root of workspaceWritableRoots(policy)) args.push('--bind', root, root)
  }
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', ...workspaceWritableRoots(policy))
  }
  return landlockGrantArgs({ readOnly: ['/'], readWrite })
}

/** Quote one path or regular expression as an SBPL string literal. */
function sbplString(text: string): string {
  return `"${text.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * A read restriction the Seatbelt rung adds to a write profile. File contents
 * and directory listings under `deniedRoots` are unreadable except under
 * `readableRoots`, and a file whose name matches a `hiddenNames` glob is
 * unreadable everywhere. Metadata such as existence and size stays readable.
 * Paths must be canonical, because Seatbelt matches resolved paths.
 */
export interface SeatbeltReadFence {
  /** Canonical directories whose file contents are unreadable. */
  readonly deniedRoots: readonly string[]
  /** Canonical files or directories readable inside the denied roots. */
  readonly readableRoots: readonly string[]
  /** File-name globs where `*` matches within one name and ASCII letters match either case. */
  readonly hiddenNames: readonly string[]
}

/**
 * Translate a file-name glob into an SBPL regular expression for the last
 * path component, matching `nameGlobMatcher` for ASCII names. An empty glob
 * or one containing `/` matches no file name and yields no expression.
 * @param glob - one hidden-name glob.
 * @returns the expression, or `undefined` when the glob cannot match a name.
 */
function hiddenNameRegex(glob: string): string | undefined {
  if (glob === '' || glob.includes('/')) return undefined
  let body = ''
  for (const char of glob) {
    if (char === '*') body += '[^/]*'
    else if (/^[A-Za-z]$/u.test(char)) body += `[${char.toLowerCase()}${char.toUpperCase()}]`
    else if (char === '^' || char === '\\') body += `[\\${char}]`
    else body += `[${char}]`
  }
  return `/${body}$`
}

/**
 * The SBPL forms of one read fence, in the order Seatbelt's last-match rule
 * needs: the denial, the readable exceptions, then hidden names.
 * @param fence - the restriction to express.
 * @returns forms appended after the write rules.
 */
function readFenceForms(fence: SeatbeltReadFence): string[] {
  const forms: string[] = []
  if (fence.deniedRoots.length > 0) {
    forms.push(`(deny file-read-data ${fence.deniedRoots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
    if (fence.readableRoots.length > 0) {
      forms.push(`(allow file-read-data ${fence.readableRoots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
    }
  }
  const hidden = fence.hiddenNames.map(hiddenNameRegex).filter(regex => regex !== undefined)
  if (hidden.length > 0) forms.push(`(deny file-read-data ${hidden.map(regex => `(regex ${sbplString(regex)})`).join(' ')})`)
  return forms
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * workspace-owned writable roots (workspace plus explicit extra directories)
 * come from the shared {@link writableRoots} helper (canonical, deduplicated)
 * so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart; the helper adds the
 * documented Seatbelt temp areas.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @param fence - optional read restriction appended after the write rules.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy, fence?: SeatbeltReadFence): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  if (fence !== undefined) forms.push(...readFenceForms(fence))
  return ['-p', forms.join(' ')]
}
