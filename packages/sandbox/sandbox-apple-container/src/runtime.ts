/**
 * Typed calls to the Apple `container` CLI: API-server status and start,
 * container state, detached runs, deletion, and listing. Each call spawns the
 * configured executable once and never touches containers it was not asked
 * about.
 * @module @deepseek-ai/dsh-sandbox-apple-container/runtime
 */

import { execFile } from 'node:child_process'

/** Exit status and output of one CLI call. */
export interface CliResult {
  /** Process exit status. */
  code: number
  /** Captured standard output. */
  stdout: string
  /** Captured standard error. */
  stderr: string
}

/** Lifecycle state of a named container: running, present but not running, or absent. */
export type ContainerState = 'running' | 'stopped' | 'missing'

/** One host directory bind-mounted into a container. */
export interface ContainerMount {
  /** Absolute host directory. */
  source: string
  /** Absolute guest path. */
  target: string
  /** Mount read-only. */
  readonly: boolean
}

/** What {@link ContainerRuntime.run} starts. */
export interface ContainerSpec {
  /** Container name (`--name`). */
  name: string
  /** Bind mounts. */
  mounts: readonly ContainerMount[]
  /** Labels (`--label key=value`). */
  labels: Readonly<Record<string, string>>
}

/** One listed container and its labels. */
export interface ListedContainer {
  /** Container id (its name). */
  id: string
  /** Container labels. */
  labels: Readonly<Record<string, string>>
}

/** Runtime settings shared by every call. */
export interface RuntimeOptions {
  /** The `container` CLI executable. */
  executable: string
  /** OCI image reference every started container runs. */
  image: string
  /** CPUs per container; absent uses the system default. */
  cpus?: number
  /** Memory per container (`container` size syntax); absent uses the system default. */
  memory?: string
  /** Start the API server once when `container system status` fails. */
  autoStart: boolean
}

/** First non-empty line of CLI output, for error messages. */
function firstLine(result: CliResult): string {
  return `${result.stderr}\n${result.stdout}`.split('\n').map(line => line.trim()).find(line => line !== '') ?? `exit ${result.code}`
}

/**
 * Typed `container` CLI client. Methods reject with an `Error` naming the
 * failed operation and the CLI's first output line.
 */
export class ContainerRuntime {
  constructor(private readonly options: RuntimeOptions) {}

  /**
   * Ensure the API server answers, starting it once with the default kernel
   * when `autoStart` is set.
   * @throws {Error} when the server is stopped and cannot be started.
   */
  async ensureService(): Promise<void> {
    const status = await this.call(['system', 'status'])
    if (status.code === 0) return
    if (!this.options.autoStart) {
      throw new Error(`the container API server is not running (${firstLine(status)}); run \`container system start\``)
    }
    const start = await this.call(['system', 'start', '--enable-kernel-install'])
    if (start.code !== 0) throw new Error(`container system start failed: ${firstLine(start)}`)
  }

  /**
   * Read a container's state.
   * @param name - the container name.
   * @returns `missing` when inspection fails, otherwise running or stopped.
   */
  async state(name: string): Promise<ContainerState> {
    const result = await this.call(['inspect', name])
    if (result.code !== 0) return 'missing'
    const [entry] = JSON.parse(result.stdout) as { status?: { state?: string } }[]
    return entry?.status?.state === 'running' ? 'running' : 'stopped'
  }

  /**
   * Start a detached container that idles until deleted.
   * @param spec - name, mounts, and labels.
   * @throws {Error} when `container run` fails.
   */
  async run(spec: ContainerSpec): Promise<void> {
    const result = await this.call([
      'run', '--detach', '--init', '--rm', '--name', spec.name,
      ...Object.entries(spec.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
      ...this.options.cpus === undefined ? [] : ['--cpus', String(this.options.cpus)],
      ...this.options.memory === undefined ? [] : ['--memory', this.options.memory],
      ...spec.mounts.flatMap(mount => ['--mount', `type=bind,source=${mount.source},target=${mount.target}${mount.readonly ? ',readonly' : ''}`]),
      this.options.image, 'sleep', 'infinity',
    ])
    if (result.code !== 0) throw new Error(`container run failed: ${firstLine(result)}`)
  }

  /**
   * Delete a container, stopping it first; an absent container is not an error.
   * @param name - the container name.
   */
  async remove(name: string): Promise<void> {
    await this.call(['delete', '--force', name])
  }

  /**
   * List every container with its labels.
   * @returns the containers, or an empty list when listing fails.
   */
  async list(): Promise<ListedContainer[]> {
    const result = await this.call(['list', '--all', '--format', 'json'])
    if (result.code !== 0) return []
    const entries = JSON.parse(result.stdout) as { configuration: { id: string; labels?: Record<string, string> } }[]
    return entries.map(entry => ({ id: entry.configuration.id, labels: entry.configuration.labels ?? {} }))
  }

  /** Run the CLI once; a spawn failure (such as a missing executable) rejects. */
  private call(args: readonly string[]): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      execFile(this.options.executable, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== 'number') {
          reject(new Error(`cannot run ${JSON.stringify(this.options.executable)}: ${error.message}`))
          return
        }
        resolve({ code: error === null ? 0 : error.code as number, stdout, stderr })
      })
    })
  }
}
