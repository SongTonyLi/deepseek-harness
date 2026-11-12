/**
 * Default values of the container provider's Config fields: environment names
 * and file names withheld from confined commands, and host directories that a
 * host-bound execution of a container session cannot read.
 * @module @deepseek-ai/dsh-sandbox-apple-container/defaults
 */

/**
 * Environment names the shim withholds from the guest by default: host-specific
 * paths and session plumbing, plus every credential-shaped name, even one a
 * composition passes deliberately.
 */
export const DEFAULT_ENV_DENYLIST: readonly string[] = [
  'PATH', 'HOME', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'OLDPWD', 'SHLVL', 'SSH_AUTH_SOCK',
  '__CF*', 'XPC_*', 'DYLD_*', 'TERM_PROGRAM*',
  '*KEY*', '*TOKEN*', '*SECRET*', '*PASSWORD*', '*PASSWD*', '*CREDENTIAL*', '*COOKIE*', '*PRIVATE*', 'AWS_*',
]

/** File names hidden from confined commands and host file tools by default: environment files, private keys, and credential stores. */
export const DEFAULT_HIDDEN_FILES: readonly string[] = [
  '.env', '.env.*', '.envrc', '*.pem', '*.key', '*.p12', '*.pfx',
  'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '.npmrc', '.pypirc', '.netrc', '.git-credentials',
]

/**
 * Host directories whose file contents host-bound executions of container
 * sessions cannot read by default: user homes and attached volumes.
 */
export const DEFAULT_HOST_BOUND_UNREADABLE_ROOTS: readonly string[] = ['/Users', '/Volumes']
