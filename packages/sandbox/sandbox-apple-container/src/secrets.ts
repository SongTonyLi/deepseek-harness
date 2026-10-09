/**
 * Workspace scan for files the container hides from confined commands. The
 * scan runs when a container starts, because `container` masks only paths
 * that exist at creation; files created later are hidden from host file tools
 * by the read scope but stay readable inside the running container.
 * @module @deepseek-ai/dsh-sandbox-apple-container/secrets
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nameGlobMatcher } from '@deepseek-ai/dsh-sandbox'

/** How far and where {@link findHiddenFiles} walks. */
export interface HiddenFileScan {
  /** File-name globs to hide (`*` wildcard, case-insensitive). */
  names: readonly string[]
  /** Directory depth below the root to search; 0 searches only the root's own entries. */
  maxDepth: number
  /** Directory names never descended into. */
  skipDirs: readonly string[]
}

/**
 * Find files and symlinks under `root` whose name matches a hidden-name glob,
 * without following symlinked directories. Sibling directories are read
 * concurrently, so the scan never blocks the event loop on a large workspace.
 * @param root - the canonical workspace root.
 * @param scan - names, depth, and skipped directory names.
 * @returns absolute paths in sorted order; unreadable directories are skipped.
 */
export async function findHiddenFiles(root: string, scan: HiddenFileScan): Promise<string[]> {
  const hidden = nameGlobMatcher(scan.names)
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // The directory vanished or is unreadable; the guest cannot read it through the mount either.
      return
    }
    const children: Promise<void>[] = []
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < scan.maxDepth && !scan.skipDirs.includes(entry.name)) children.push(walk(path, depth + 1))
      } else if (hidden(entry.name)) {
        found.push(path)
      }
    }
    await Promise.all(children)
  }
  await walk(root, 0)
  return found.sort()
}
