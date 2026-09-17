/**
 * Host-native command execution and path-opening utilities.
 * @module @deepseek-ai/dsh-native-command
 */

export { runNativeCommand } from './runner.ts'
export type { NativeCommandRunner } from './runner.ts'
export { openNativeUrl } from './url-opener.ts'
export {
  canOpenNativePath,
  nativeFileManager,
  revealNativePath,
  openNativePath,
  openNativeTextFile,
} from './path-opener.ts'
export type {
  NativeFileManager,
  PathOpenerInternals,
  PathOpenerRunner,
} from './path-opener.ts'
