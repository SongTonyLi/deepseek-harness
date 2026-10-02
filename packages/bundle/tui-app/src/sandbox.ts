/** Sandbox backend selection with a live preview of file access. */

import type { AppleContainerSandboxProvider } from '@deepseek-ai/dsh-sandbox-apple-container'
import type { Session } from '@deepseek-ai/dsh-session'
import { wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { PickPrompt } from './prompts.ts'
import type { Palette } from './style.ts'

/**
 * Preview the highlighted backend without changing session policy. Enter applies
 * the choice through the caller; Escape keeps the recorded backend.
 */
export class SandboxPrompt extends PickPrompt {
  constructor(
    palette: Palette,
    provider: Pick<AppleContainerSandboxProvider, 'backendFor' | 'containerSupported'>,
    session: Session,
    private readonly policy: Parameters<AppleContainerSandboxProvider['readScope']>[0],
  ) {
    const current = provider.backendFor(session)
    super(palette, 'Sandbox backend', [
      ...provider.containerSupported ? [{ value: 'container', label: 'Container', description: 'Linux VM · isolated host access' }] : [],
      { value: 'local', label: 'Local', description: 'This host · native tools and paths' },
    ], {
      current,
      body: [
        `current: ${current} · file policy: ${policy.mode} · Esc keeps it`,
        ...provider.containerSupported ? [] : ['Container unavailable: requires macOS on Apple silicon and the container CLI.'],
      ],
    })
  }

  protected override listLines(width: number): string[] {
    const lines = super.listLines(width).flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)))
    const selected = this.selected()
    if (selected === null) return lines
    const container = selected.value === 'container'
    const unrestricted = this.policy.mode === 'danger-full-access'
    const writes = this.policy.mode === 'read-only'
      ? 'BLOCKED · file modifications'
      : this.policy.mode === 'workspace-write'
        ? 'ALLOWED · workspace writes except provider-protected paths; temporary areas may be writable'
        : 'UNRESTRICTED · host file modifications'
    const preview = [
      this.palette.bold(`Access preview · ${selected.label.replace(' ✓', '')}`),
      `Workspace: ${this.policy.workspaceRoot}`,
      unrestricted
        ? this.palette.warning('! Sandbox bypassed: commands run on the host, regardless of backend choice.')
        : `Commands → ${container ? 'Linux container → shared workspace' : 'host → native file sandbox'}`,
      `${this.policy.mode === 'read-only' ? '−' : '+'} ${writes}`,
      ...container && !unrestricted ? [
        '+ READ · workspace and configured read-only mounts',
        '− HOST ACCESS · other host paths and configured secret-file patterns hidden',
        '  Guest files outside shared mounts are not visible to host file tools.',
      ] : [
        '+ READ · host paths (subject to OS permissions)',
        ...unrestricted ? [] : ['− WRITE · outside permitted paths; provider-protected paths remain blocked'],
      ],
      'Backend changes do not change file policy or approval settings: use /permission.',
      'Wider access requires approved one-shot escalation when approvals are enabled.',
    ]
    const inner = Math.max(1, width - 2)
    return [...lines, '', ...preview.flatMap(line => wrapTextWithAnsi(line, inner).map(part => `  ${part}`))]
  }
}
