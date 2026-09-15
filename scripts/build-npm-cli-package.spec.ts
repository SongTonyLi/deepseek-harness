import { describe, expect, it } from 'vitest'
import { npmPayloadExclusion } from './build-npm-cli-package.ts'

describe('npmPayloadExclusion', () => {
  it('keeps the runtime files a bundled package is imported through', () => {
    expect(npmPayloadExclusion('node_modules/@deepseek-ai/dsh-tui-app/lib/index.js')).toBeUndefined()
    expect(npmPayloadExclusion('node_modules/@deepseek-ai/dsh-tui-app/package.json')).toBeUndefined()
    expect(npmPayloadExclusion('node_modules/@deepseek-ai/dsh-tui-app/cordis.patch.yml')).toBeUndefined()
  })

  it('drops build and diagnostic files no install reads', () => {
    expect(npmPayloadExclusion('node_modules/@deepseek-ai/dsh/lib/types/index.d.ts')).toBe('TypeScript declaration')
    expect(npmPayloadExclusion('node_modules/@deepseek-ai/dsh/lib/index.js.map')).toBe('source map')
    expect(npmPayloadExclusion('node_modules/@deepseek-ai/dsh/lib/tsconfig.tsbuildinfo')).toBe('TypeScript build cache')
    expect(npmPayloadExclusion('node_modules/@mixmark-io/domino/test/fixture.js')).toBe('Domino test fixtures')
  })

  it('drops the package-manager metadata a published tree must not carry', () => {
    expect(npmPayloadExclusion('node_modules/.bin/dsh')).toBe('package-manager metadata')
    expect(npmPayloadExclusion('node_modules/.pnpm/lock.yaml')).toBe('package-manager metadata')
    expect(npmPayloadExclusion('node_modules/.modules.yaml')).toBe('package-manager metadata')
  })

  it('keeps every node-pty prebuild, because one tarball serves every platform', () => {
    for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']) {
      expect(npmPayloadExclusion(`node_modules/node-pty/prebuilds/${platform}/pty.node`)).toBeUndefined()
    }
    expect(npmPayloadExclusion('node_modules/node-pty/prebuilds/win32-x64/conpty.pdb')).toBe('node-pty debug symbols')
  })
})
