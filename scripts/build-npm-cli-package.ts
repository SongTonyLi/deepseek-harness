/**
 * Assemble the `dsh-cli` npm package: one self-contained tarball that installs
 * the terminal surface and its whole Node closure in a single `npm install`.
 *
 * The payload is the same verified runtime closure the single-file executable
 * ships (`python/sdk-runtime`), staged symlink-free by `pnpm deploy --legacy`
 * and carried as `bundleDependencies`. Three properties of that staged tree
 * make it unpublishable as-is, and this script establishes each one:
 *
 * - `pnpm deploy` leaves `workspace:` ranges in the nested manifests, which npm
 *   cannot parse. Every range is pinned to the version staged beside it.
 * - Native packages resolve one `os`/`cpu` variant per platform, so bundling the
 *   staged tree would publish a darwin-arm64-only package. Those variants are
 *   dropped from the payload and re-declared as top-level `optionalDependencies`
 *   covering every platform their parent knows.
 * - `dsh` requires `--profile`, so the shipped bin defaults a bare invocation to
 *   the tui profile and passes every other argument through untouched.
 *
 * @module scripts/build-npm-cli-package
 */

import { spawn } from 'node:child_process'
import { existsSync, globSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

/** The closure manifest whose dependencies define the published payload. */
const DEPLOY_ROOT_PACKAGE = 'dsh-python-runtime-closure'
/** Workspace `node_modules` the legacy hoister may leave direct dependencies in. */
const DEPLOY_SOURCE_NODE_MODULES = 'python/sdk-runtime/node_modules'
/** The published package name. */
const PACKAGE_NAME = 'dsh-cli'
/** The executable the package installs. */
const BIN_NAME = 'dsh'
/** The profile a bare `dsh` invocation boots. */
const DEFAULT_PROFILE = 'tui'
const root = resolve(import.meta.dirname, '..')

/** One package manifest, read from the staged tree. */
interface StagedManifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  devDependencies?: Record<string, string>
  os?: string[]
  cpu?: string[]
  [key: string]: unknown
}

/** Resolved command-line options. */
interface BuildOptions {
  /** Reuse an existing staged tree instead of deploying a new one. */
  readonly skipDeploy: boolean
  /** Reuse existing build artifacts instead of running `pnpm run build`. */
  readonly skipBuild: boolean
  /** Staging directory `pnpm deploy` writes. */
  readonly staging: string
  /** Publishable package directory this script writes. */
  readonly dist: string
  /** Version the published package carries. */
  readonly version: string
}

/**
 * Run a command, inheriting stdio, and reject on a non-zero exit.
 * @param label - subject named in the failure message.
 * @param command - executable to run.
 * @param args - arguments passed verbatim.
 * @param cwd - working directory.
 */
function run(label: string, command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((accept, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: 'inherit',
      shell: false,
      // pnpm's pre-run freshness check reinstalls the workspace, and under the
      // deploy's `--prod` that reinstall proposes purging the repository's dev
      // dependencies. Packaging reads the workspace; it never re-resolves it.
      env: { ...process.env, npm_config_verify_deps_before_run: 'false' },
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) accept()
      else reject(new Error(`build-npm-cli-package: ${label} exited with ${String(code ?? signal)}`))
    })
  })
}

/**
 * Read and parse one JSON manifest.
 * @param path - absolute manifest path.
 * @returns The parsed manifest.
 */
async function readManifest(path: string): Promise<StagedManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as StagedManifest
}

/**
 * Write a manifest back with a trailing newline.
 * @param path - absolute manifest path.
 * @param manifest - manifest to serialize.
 */
async function writeManifest(path: string, manifest: StagedManifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

/**
 * Identify build and diagnostic files the published payload omits.
 *
 * Unlike the Desktop runtime's policy this keeps every `node-pty` prebuild:
 * one tarball serves every platform, so the only per-platform payloads dropped
 * are the `os`/`cpu` packages re-declared as optional dependencies.
 * @param path - path relative to the staged tree.
 * @returns An omission reason, or undefined when the entry is copied.
 */
export function npmPayloadExclusion(path: string): string | undefined {
  const parts = path.split(/[\\/]/u)
  if (parts.some(part => ['.bin', '.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json'].includes(part))) {
    return 'package-manager metadata'
  }
  const file = parts.at(-1) ?? ''
  if (/\.(?:[cm]?[jt]s|css)\.map$/u.test(file)) return 'source map'
  if (/\.d\.[cm]?ts$/u.test(file)) return 'TypeScript declaration'
  if (/\.tsbuildinfo$/u.test(file)) return 'TypeScript build cache'
  const modulesIndex = parts.lastIndexOf('node_modules')
  if (modulesIndex === -1) return undefined
  const packageParts = parts.slice(modulesIndex + 1)
  const nameParts = packageParts[0]?.startsWith('@') ? 2 : 1
  const name = packageParts.slice(0, nameParts).join('/')
  const entry = packageParts.slice(nameParts).join('/')
  if (name === '@mixmark-io/domino' && (entry === 'test' || entry.startsWith('test/'))) return 'Domino test fixtures'
  if (name === 'node-pty' && entry.startsWith('prebuilds/') && file.endsWith('.pdb')) return 'node-pty debug symbols'
  return undefined
}

/** Stages the closure and rewrites it into a publishable package. */
class NpmPackageBuild {
  constructor(private readonly options: BuildOptions) {}

  /** Verify the closure covers every shipped preset before staging it. */
  async verifyClosure(): Promise<void> {
    await run('verify-runtime-closure', 'pnpm', ['run', 'verify-runtime-closure'], root)
  }

  /** Build workspace artifacts unless the caller reuses them. */
  async build(): Promise<void> {
    if (this.options.skipBuild) {
      console.log('build-npm-cli-package: reusing existing build artifacts (--skip-build)')
      return
    }
    await run('build', 'pnpm', ['run', 'build'], root)
  }

  /** Deploy the runtime closure into a symlink-free staging tree. */
  async deploy(): Promise<void> {
    const { staging } = this.options
    if (this.options.skipDeploy) {
      if (!existsSync(join(staging, 'node_modules'))) {
        throw new Error(`build-npm-cli-package: --skip-deploy needs an existing staged tree at ${staging}`)
      }
      console.log(`build-npm-cli-package: reusing staged tree at ${staging} (--skip-deploy)`)
      return
    }
    if (staging === root || root.startsWith(staging + sep)) {
      throw new Error(`build-npm-cli-package: refusing to clear ${staging}: it contains the repository root`)
    }
    await rm(staging, { recursive: true, force: true })
    const restoreWorkspaceState = await this.captureWorkspaceState()
    try {
      await this.runDeploy(staging)
    } finally {
      await restoreWorkspaceState()
    }
    await this.restoreLegacyHoists()
    await this.materializeStagedLinks()
  }

  /**
   * Snapshot the files `pnpm deploy` rewrites to describe the repository's own
   * install, so packaging leaves the workspace exactly as it found it.
   *
   * A `--prod` deploy records `dev: false` here. Every later `pnpm run` then
   * reads that as a stale workspace and offers to purge the repository's dev
   * dependencies to match.
   * @returns A callback restoring the captured contents.
   */
  private async captureWorkspaceState(): Promise<() => Promise<void>> {
    const paths = ['node_modules/.pnpm-workspace-state-v1.json', 'node_modules/.modules.yaml']
      .map(relative => resolve(root, relative))
      .filter(path => existsSync(path))
    const captured = await Promise.all(paths.map(async path => [path, await readFile(path)] as const))
    return async () => {
      await Promise.all(captured.map(([path, contents]) => writeFile(path, contents)))
    }
  }

  /**
   * Deploy the closure into the staging directory.
   * @param staging - the deploy target.
   */
  private async runDeploy(staging: string): Promise<void> {
    await run('deploy', 'pnpm', [
      '--filter', DEPLOY_ROOT_PACKAGE,
      'deploy',
      '--legacy',
      '--prod',
      '--config.allow-unused-patches=true',
      // The deploy reads the workspace; it must never decide the repository's
      // own node_modules is stale and offer to purge it.
      '--config.verify-deps-before-run=false',
      '--config.node-linker=hoisted',
      // The executable build resolves peers from a hand-maintained closure and
      // keeps this off. A published tarball has no such list to lean on: an
      // unsatisfied peer is only discoverable when Cordis loads the plugin, so
      // the payload installs every peer it declares.
      '--config.auto-install-peers=true',
      '--config.link-workspace-packages=true',
      staging,
    ], root)
  }

  /**
   * Restore direct packages pnpm's legacy hoister leaves beside the deploy
   * source rather than in the target.
   */
  private async restoreLegacyHoists(): Promise<void> {
    const { staging } = this.options
    const manifest = await readManifest(join(staging, 'package.json'))
    const source = resolve(root, DEPLOY_SOURCE_NODE_MODULES)
    const restored: string[] = []
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      const destination = join(staging, 'node_modules', dependency)
      if (existsSync(destination)) continue
      const origin = join(source, dependency)
      if (!existsSync(origin)) {
        throw new Error(`build-npm-cli-package: staged dependency ${dependency} is absent from both ${destination} and ${origin}`)
      }
      await mkdir(dirname(destination), { recursive: true })
      const nested = join(origin, 'node_modules')
      await cp(origin, destination, {
        recursive: true,
        dereference: true,
        filter: path => path !== nested && !path.startsWith(nested + sep),
      })
      restored.push(dependency)
    }
    if (restored.length > 0) console.log(`build-npm-cli-package: restored legacy deploy hoists: ${restored.join(', ')}`)
  }

  /** Replace every deploy-time link with real files. */
  private async materializeStagedLinks(): Promise<void> {
    const nodeModules = join(this.options.staging, 'node_modules')
    let remaining = await this.findSymlink(nodeModules)
    while (remaining !== undefined) {
      const segments = remaining.slice(nodeModules.length + 1).split(sep)
      const binIndex = segments.lastIndexOf('.bin')
      if (binIndex >= 0) {
        await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
        remaining = await this.findSymlink(nodeModules)
        continue
      }
      const origin = await realpath(remaining)
      const nested = join(origin, 'node_modules')
      await rm(remaining, { recursive: true, force: true })
      await cp(origin, remaining, {
        recursive: true,
        dereference: true,
        filter: path => path !== nested && !path.startsWith(nested + sep),
      })
      remaining = await this.findSymlink(nodeModules)
    }
  }

  /**
   * Return the first symbolic link below a directory.
   * @param directory - directory to search.
   * @returns The link path, or undefined when none remains.
   */
  private async findSymlink(directory: string): Promise<string | undefined> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if ((await lstat(path)).isSymbolicLink()) return path
      if (entry.isDirectory()) {
        const nested = await this.findSymlink(path)
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }

  /** Copy the staged tree into the publishable directory, dropping build residue. */
  async copyPayload(): Promise<void> {
    const { staging, dist } = this.options
    await rm(dist, { recursive: true, force: true })
    await mkdir(dist, { recursive: true })
    await cp(join(staging, 'node_modules'), join(dist, 'node_modules'), {
      recursive: true,
      dereference: true,
      filter: path => npmPayloadExclusion(path.slice(staging.length + 1)) === undefined,
    })
  }

  /**
   * List the packages at the top of the payload tree.
   * @returns Package names, scoped names included, sorted.
   */
  async payloadPackages(): Promise<string[]> {
    const nodeModules = join(this.options.dist, 'node_modules')
    const names: string[] = []
    for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (!entry.name.startsWith('@')) {
        names.push(entry.name)
        continue
      }
      for (const scoped of await readdir(join(nodeModules, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) names.push(`${entry.name}/${scoped.name}`)
      }
    }
    return names.sort()
  }

  /**
   * Index every workspace package by name.
   * @returns Absolute package directories by package name.
   */
  private async workspacePackages(): Promise<Map<string, string>> {
    const patterns = ['packages/*/*', 'apps/*', 'vendor/*', 'native/system', 'native/system/packages/*']
    const found = new Map<string, string>()
    for (const pattern of patterns) {
      for (const directory of globSync(pattern, { cwd: root })) {
        const manifestPath = resolve(root, directory, 'package.json')
        if (!existsSync(manifestPath)) continue
        const manifest = await readManifest(manifestPath)
        if (manifest.name !== undefined) found.set(manifest.name, resolve(root, directory))
      }
    }
    return found
  }

  /**
   * Add workspace packages the payload requires but the deploy left out.
   *
   * A `workspace:` peer is satisfiable only from this repository, so pnpm's
   * peer auto-installation cannot supply one and the deploy root's dependency
   * list is the only thing that pulls it in. Where that list is short of a
   * required peer the plugin fails to import at runtime, so each missing
   * package is packed exactly as it would publish and unpacked into the
   * payload, repeating until nothing is left unresolved.
   */
  async completePayload(): Promise<void> {
    const nodeModules = join(this.options.dist, 'node_modules')
    const workspace = await this.workspacePackages()
    const added: string[] = []
    for (let pass = 0; pass < 10; pass += 1) {
      const packages = await this.payloadPackages()
      const present = new Set(packages)
      const missing = new Set<string>()
      for (const name of packages) {
        for (const dependency of await this.requiredEdges(join(nodeModules, name, 'package.json'))) {
          if (present.has(dependency) || existsSync(join(nodeModules, name, 'node_modules', dependency))) continue
          if (!workspace.has(dependency)) {
            throw new Error(`build-npm-cli-package: ${name} requires ${dependency}, which is neither staged nor a workspace package`)
          }
          missing.add(dependency)
        }
      }
      if (missing.size === 0) {
        if (added.length > 0) console.log(`build-npm-cli-package: completed payload with ${added.length} workspace peers: ${added.join(', ')}`)
        return
      }
      for (const name of [...missing].sort()) {
        const directory = workspace.get(name)
        /* v8 ignore next -- the workspace lookup above already rejected an unknown name */
        if (directory === undefined) throw new Error(`build-npm-cli-package: no workspace directory for ${name}`)
        await this.unpackWorkspacePackage(name, directory, nodeModules)
        added.push(name)
      }
    }
    throw new Error('build-npm-cli-package: payload completion did not settle; the workspace peer graph may be cyclic')
  }

  /**
   * Pack one workspace package and unpack it into the payload.
   * @param name - the package name.
   * @param directory - its workspace directory.
   * @param nodeModules - the payload's module root.
   */
  private async unpackWorkspacePackage(name: string, directory: string, nodeModules: string): Promise<void> {
    const tarballs = resolve(this.options.dist, '..', 'dsh-cli-peers')
    await mkdir(tarballs, { recursive: true })
    await run(`pack ${name}`, 'pnpm', ['pack', '--pack-destination', tarballs], directory)
    const [tarball] = (await readdir(tarballs)).filter(entry => entry.endsWith('.tgz'))
    if (tarball === undefined) throw new Error(`build-npm-cli-package: pnpm pack produced no tarball for ${name}`)
    const destination = join(nodeModules, name)
    await mkdir(destination, { recursive: true })
    await run(`unpack ${name}`, 'tar', ['-xzf', join(tarballs, tarball), '-C', destination, '--strip-components=1'], root)
    await rm(join(tarballs, tarball), { force: true })
  }

  /**
   * The runtime edges a manifest requires: its dependencies and every peer it
   * does not mark optional.
   * @param manifestPath - absolute manifest path.
   * @returns Required package names.
   */
  private async requiredEdges(manifestPath: string): Promise<string[]> {
    const manifest = await readManifest(manifestPath)
    const optionalPeers = manifest.peerDependenciesMeta ?? {}
    return [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter(peer => optionalPeers[peer]?.optional !== true),
    ]
  }

  /**
   * Drop the host-only native variants and return every platform variant their
   * parents declare, so the published manifest can request one per platform.
   * @param packages - the payload's top-level package names.
   * @returns Optional dependencies covering every platform, by package name.
   */
  async liftPlatformVariants(packages: readonly string[]): Promise<Record<string, string>> {
    const nodeModules = join(this.options.dist, 'node_modules')
    const constrained = new Set<string>()
    const versions = new Map<string, string>()
    for (const name of packages) {
      const manifest = await readManifest(join(nodeModules, name, 'package.json'))
      if (manifest.version !== undefined) versions.set(name, manifest.version)
      if (manifest.os !== undefined || manifest.cpu !== undefined) constrained.add(name)
    }
    const lifted: Record<string, string> = {}
    for (const name of packages) {
      if (constrained.has(name)) continue
      const manifest = await readManifest(join(nodeModules, name, 'package.json'))
      const optional = manifest.optionalDependencies ?? {}
      if (!Object.keys(optional).some(variant => constrained.has(variant))) continue
      const parentVersion = versions.get(name)
      for (const [variant, range] of Object.entries(optional)) {
        // `workspace:` ranges only appear between packages this repository
        // versions together, so the parent's version names the variant exactly.
        if (!range.startsWith('workspace:')) lifted[variant] = range
        else if (parentVersion !== undefined) lifted[variant] = parentVersion
        else throw new Error(`build-npm-cli-package: ${name} has no version to pin its ${variant} variant`)
      }
    }
    for (const name of constrained) {
      await rm(join(nodeModules, name), { recursive: true, force: true })
      console.log(`build-npm-cli-package: unbundled host-only variant ${name}`)
    }
    return lifted
  }

  /**
   * Pin every `workspace:` range in the payload to the version staged beside it.
   *
   * npm rejects the workspace protocol outright, and the payload is closed:
   * the tree already contains the exact build each range refers to.
   * @param packages - the payload's top-level package names.
   */
  async pinWorkspaceRanges(packages: readonly string[]): Promise<void> {
    const nodeModules = join(this.options.dist, 'node_modules')
    const versions = new Map<string, string>()
    for (const name of packages) {
      const manifest = await readManifest(join(nodeModules, name, 'package.json'))
      if (manifest.version !== undefined) versions.set(name, manifest.version)
    }
    const sections = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'] as const
    let pinned = 0
    for (const name of packages) {
      const path = join(nodeModules, name, 'package.json')
      const manifest = await readManifest(path)
      let changed = false
      for (const section of sections) {
        const entries = manifest[section]
        if (entries === undefined) continue
        const rewritten: Record<string, string> = {}
        for (const [dependency, range] of Object.entries(entries)) {
          if (!range.startsWith('workspace:')) {
            rewritten[dependency] = range
            continue
          }
          const version = versions.get(dependency)
          // A workspace range pointing outside the payload survived the closure
          // check above, so it is an optional or development edge the
          // production deploy already dropped, and it is dropped here too.
          if (version !== undefined) rewritten[dependency] = version
          changed = true
          pinned += 1
        }
        manifest[section] = rewritten
      }
      // The published tree is installed, never built: a bundled lifecycle
      // script would run against a tree npm has already placed.
      if (manifest.scripts !== undefined) {
        delete manifest.scripts
        changed = true
      }
      if (changed) await writeManifest(path, manifest)
    }
    console.log(`build-npm-cli-package: pinned ${pinned} workspace ranges across ${packages.length} payload packages`)
  }

  /**
   * Reject a payload that cannot resolve one of its own imports.
   *
   * Every runtime edge in the tree — a dependency or a peer a package requires
   * rather than marks optional — must land inside the payload, because nothing
   * resolves outside it once the tarball is installed. A missing edge otherwise
   * surfaces as a module-not-found error the first time Cordis loads that
   * plugin, which is long after publication.
   * @param packages - the payload's top-level package names.
   * @param optional - platform variants npm resolves per install.
   */
  async verifyPayloadCloses(packages: readonly string[], optional: Record<string, string>): Promise<void> {
    const nodeModules = join(this.options.dist, 'node_modules')
    const present = new Set([...packages, ...Object.keys(optional)])
    const missing: string[] = []
    for (const name of packages) {
      for (const dependency of await this.requiredEdges(join(nodeModules, name, 'package.json'))) {
        // A package-local tree satisfies the edge without a hoisted entry.
        if (present.has(dependency) || existsSync(join(nodeModules, name, 'node_modules', dependency))) continue
        missing.push(`${name} -> ${dependency}`)
      }
    }
    if (missing.length > 0) {
      throw new Error(`build-npm-cli-package: payload cannot resolve ${missing.length} runtime edges:\n  ${missing.join('\n  ')}`)
    }
    console.log(`build-npm-cli-package: payload closes over ${packages.length} packages`)
  }

  /**
   * Write the published manifest, the default-profile bin, and the readme.
   * @param packages - bundled top-level package names.
   * @param optional - platform variants npm resolves per install.
   */
  async writePackage(packages: readonly string[], optional: Record<string, string>): Promise<void> {
    const { dist, version } = this.options
    const nodeModules = join(dist, 'node_modules')
    const dependencies: Record<string, string> = {}
    for (const name of packages) {
      const manifest = await readManifest(join(nodeModules, name, 'package.json'))
      if (manifest.version !== undefined) dependencies[name] = manifest.version
    }
    const harnessVersion = dependencies['@deepseek-ai/dsh']
    if (harnessVersion === undefined) throw new Error('build-npm-cli-package: the payload carries no @deepseek-ai/dsh to launch')
    await mkdir(join(dist, 'bin'), { recursive: true })
    await writeFile(
      join(dist, 'bin', `${BIN_NAME}.mjs`),
      BIN_SOURCE.replace('{{version}}', version).replace('{{harnessVersion}}', harnessVersion),
    )
    await writeManifest(join(dist, 'package.json'), {
      name: PACKAGE_NAME,
      version,
      description: 'The dsh terminal agent: an interactive TUI over the DeepSeek Harness, with its whole Node runtime bundled in one install.',
      license: 'MIT',
      type: 'module',
      bin: { [BIN_NAME]: `bin/${BIN_NAME}.mjs` },
      engines: { node: '^22.19.0 || >=24.0.0' },
      files: ['bin/'],
      dependencies,
      optionalDependencies: optional,
      bundleDependencies: [...packages],
    })
    await cp(join(root, 'LICENSE'), join(dist, 'LICENSE'))
    await writeFile(join(dist, 'README.md'), README_SOURCE.replace('{{version}}', version))
  }

  /** Pack the publishable directory and report the tarball. */
  async pack(): Promise<void> {
    await run('npm pack', 'npm', ['pack', '--pack-destination', root], this.options.dist)
  }
}

/** The installed executable: default a bare invocation to the tui profile. */
const BIN_SOURCE = `#!/usr/bin/env node
/**
 * The \`dsh\` executable installed by ${PACKAGE_NAME}.
 *
 * The launcher requires a profile, so a bare \`dsh\` boots ${DEFAULT_PROFILE}. Every
 * invocation that already carries arguments is passed through untouched, which
 * keeps \`dsh web\`, \`dsh plugin\`, \`dsh --profile <name>\`, \`dsh --help\` and the
 * app-owned flags behaving exactly as they do from a source checkout.
 *
 * The launcher module self-dispatches only under \`import.meta.main\`, which an
 * importer is not, so this calls the exported entry point directly.
 */
import { runCli } from '@deepseek-ai/dsh/lib/bin.js'

const argv = process.argv.slice(2)

// The launcher reports the harness version it was built from, which is not the
// version this package publishes. Reporting only one of the two would make an
// ordinary \`npm install dsh-cli@x\` look like it installed something else.
if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
  console.log('${PACKAGE_NAME} {{version}} (deepseek-harness {{harnessVersion}})')
  process.exit(0)
}

if (argv.length === 0) process.argv.push('${DEFAULT_PROFILE}')
await runCli()
`

/** The published readme. */
const README_SOURCE = `# dsh-cli

An interactive terminal agent built on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), published from the [SongTonyLi fork](https://github.com/SongTonyLi/deepseek-harness) that adds the terminal surface.

\`\`\`sh
npm install -g dsh-cli
export DEEPSEEK_API_KEY=...
dsh
\`\`\`

\`dsh\` with no arguments opens the terminal UI. The rest of the launcher grammar is unchanged:

| Command | Effect |
| --- | --- |
| \`dsh\` | the terminal UI (same as \`dsh tui\`) |
| \`dsh "fix the failing test"\` | opens the terminal UI on that prompt |
| \`dsh --profile headless "run the tests"\` | answer one task, print it, exit |
| \`dsh web\` | the browser UI |
| \`dsh plugin --profile tui add <package>\` | install a plugin into the profile |
| \`dsh --help\` | the full launcher grammar |

## What is bundled

The tarball carries the whole Node dependency closure, so the install needs no
workspace and no build step. Native packages that ship one build per platform —
ripgrep, the PTY backend's addons, sharp, koffi, and the Landlock launcher — are
ordinary optional dependencies, so npm resolves the right one for your machine.

Requires Node \`^22.19.0 || >=24.0.0\`. Version {{version}}; \`dsh --version\`
also reports the harness build the package was assembled from.

## License

MIT, as the upstream harness. This package is an independent fork build and is
not published by DeepSeek.
`

/**
 * Parse the command line.
 * @returns The resolved options.
 */
async function resolveOptions(): Promise<BuildOptions> {
  const { values } = parseArgs({
    options: {
      'skip-build': { type: 'boolean', default: false },
      'skip-deploy': { type: 'boolean', default: false },
      staging: { type: 'string', default: 'tmp/dsh-cli-staging' },
      dist: { type: 'string', default: 'tmp/dsh-cli-dist' },
      version: { type: 'string' },
    },
  })
  const rootManifest = await readManifest(join(root, 'package.json'))
  const version = values.version ?? rootManifest.version
  if (version === undefined) throw new Error('build-npm-cli-package: no version to publish')
  return {
    skipBuild: values['skip-build'],
    skipDeploy: values['skip-deploy'],
    staging: resolve(root, values.staging),
    dist: resolve(root, values.dist),
    version,
  }
}

/** Assemble and pack the published package. */
async function main(): Promise<void> {
  const options = await resolveOptions()
  const build = new NpmPackageBuild(options)
  await build.verifyClosure()
  await build.build()
  await build.deploy()
  await build.copyPayload()
  await build.completePayload()
  const optionalVariants = await build.liftPlatformVariants(await build.payloadPackages())
  const bundled = await build.payloadPackages()
  // Verification precedes pinning: pinning drops the workspace ranges it cannot
  // resolve, which is exactly the evidence an incomplete payload leaves behind.
  await build.verifyPayloadCloses(bundled, optionalVariants)
  await build.pinWorkspaceRanges(bundled)
  await build.writePackage(bundled, optionalVariants)
  await build.pack()
  console.log(`build-npm-cli-package: ${PACKAGE_NAME}@${options.version} bundles ${bundled.length} packages`)
}

if (import.meta.main) await main()
