/** Select source or built bootstrap assets in the mounted execution world. */
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** Deployment-owned worker invocation in the subprocess execution world. */
export type LaunchConfig = {
  /** Start a separately installed Node executable and JavaScript bootstrap. */
  kind: 'node-script'
  /** Executable name or path resolved by the subprocess provider. */
  executable: string
  /** Absolute preinstalled bootstrap; omitted maps this package's bootstrap into the execution world. */
  bootstrapPath?: string
} | {
  /** Start the private PTC worker embedded in a packaged executable. */
  kind: 'embedded'
  /** Packaged executable name or path resolved by the subprocess provider. */
  executable: string
}

/**
 * Resolve the local carrier default or validate an explicit execution-world invocation.
 * @param config - explicit remote or local worker configuration; omitted selects this carrier.
 * @returns the worker invocation without guessing from the execution world's paths.
 */
export function resolveLaunch(config?: LaunchConfig): LaunchConfig {
  const launch: LaunchConfig = config ?? { kind: 'pkg' in process ? 'embedded' : 'node-script', executable: process.execPath }
  if (launch.executable.length === 0) throw new Error('ptc-runtime-node: launch.executable must be non-empty')
  if (launch.kind === 'node-script' && launch.bootstrapPath !== undefined && !isAbsolute(launch.bootstrapPath)) {
    throw new Error('ptc-runtime-node: launch.bootstrapPath must be absolute')
  }
  return launch
}

/** A worker invocation's arguments and the paths its bootstrap reads, both in the process world. */
export interface WorkerBootstrap {
  /** Arguments following the resolved Node executable. */
  readonly args: string[]
  /** Paths the bootstrap reads to start: the directory of its script, or this source checkout. */
  readonly readPaths: string[]
}

/**
 * Select explicit arguments without inheriting host loader or inspector flags.
 * @param fs - Filesystem mapping host bootstrap assets into the process world.
 * @param config - resolved worker invocation.
 * @param maxMessageBytes - Validated frame and queued-write limit.
 * @returns Arguments following the resolved Node executable, and the paths they make the worker read.
 */
export function workerBootstrap(fs: Pick<FileSystem, 'processPathFromHostPath'>, config: LaunchConfig, maxMessageBytes: number): WorkerBootstrap {
  switch (config.kind) {
    case 'embedded':
      return { args: [String(maxMessageBytes)], readPaths: [] }
    case 'node-script': {
      const script = scriptBootstrap(fs, config.bootstrapPath, maxMessageBytes)
      return { args: ['--experimental-vm-modules', ...script.args], readPaths: script.readPaths }
    }
    /* v8 ignore next -- Callers supply the resolved, closed LaunchConfig union. */
    default: return assertNever(config)
  }
}

function scriptBootstrap(
  fs: Pick<FileSystem, 'processPathFromHostPath'>, bootstrapPath: string | undefined, maxMessageBytes: number,
): WorkerBootstrap {
  if (bootstrapPath !== undefined) return { args: [bootstrapPath, String(maxMessageBytes)], readPaths: [dirname(bootstrapPath)] }
  const mapped = (path: string): string => {
    const result = fs.processPathFromHostPath(path)
    if (result === undefined) throw new Error(`PTC runtime bootstrap is unavailable in the subprocess execution world: ${path}`)
    return result
  }
  /* v8 ignore next 4 -- built-lib.e2e.ts executes the bundled provider and sibling process.js under plain Node. */
  if (!new URL(import.meta.url).pathname.endsWith('.ts')) {
    const script = mapped(fileURLToPath(new URL('./process.js', import.meta.url)))
    return { args: [script, String(maxMessageBytes)], readPaths: [dirname(script)] }
  }
  const entry = mapped(fileURLToPath(new URL('./process.ts', import.meta.url)))
  const subprocess = dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess/package.json')))
  const helper = mapped(resolve(subprocess, 'src/control.ts'))
  const source = `const {openInheritedControlChannel}=await import(${JSON.stringify(pathToFileURL(helper).href)});const {runNodeMain}=await import(${JSON.stringify(pathToFileURL(entry).href)});await runNodeMain(openInheritedControlChannel(),${maxMessageBytes},process);`
  // Source modules import workspace packages and their dependencies from anywhere in this checkout.
  const checkout = mapped(resolve(fileURLToPath(new URL('../../../../', import.meta.url))))
  return { args: ['--input-type=module', '--eval', source], readPaths: [checkout] }
}
