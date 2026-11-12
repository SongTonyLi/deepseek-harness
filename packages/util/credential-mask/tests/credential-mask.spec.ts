/** Credential masking for display: the masker and the format tables its scanner reads. */
import { describe, expect, it } from 'vitest'
import { formatTables } from '../src/format-tables.ts'
import { createCredentialMasker } from '../src/index.ts'

// Samples are assembled at run time so the repository holds no literal in a credential format.
const hex = (length: number): string => '0123456789abcdef'.repeat(8).slice(0, length)
const stars = (length: number): string => '*'.repeat(length)
const join = (...parts: string[]): string => parts.join('')

describe('createCredentialMasker', () => {
  const masker = createCredentialMasker()

  it('keeps the first eight characters of a key and masks every other character', () => {
    const key = join('sk', '-', hex(32))
    expect(masker.mask(`${key}用这个`)).toBe(key.slice(0, 8) + stars(27) + '用这个')
  })

  it('masks only the password of an address that carries credentials', () => {
    expect(masker.mask('postgres://admin:p4ss-W0rd@db.internal:5432/app'))
      .toBe(`postgres://admin:${stars(9)}@db.internal:5432/app`)
  })

  it('keeps line breaks around a masked credential', () => {
    const key = join('sk', '-', hex(32))
    expect(masker.mask(`first\n${key}\nlast`)).toBe(`first\n${key.slice(0, 8)}${stars(27)}\nlast`)
  })

  it('leaves ordinary prose and addresses without a password unchanged', () => {
    const prose = '把密码改一下，token 用量也看看，password=hunter2'
    expect(masker.mask(prose)).toBe(prose)
    const address = 'https://example.com:8080/a@b git@github.com:o/r.git'
    expect(masker.mask(address)).toBe(address)
  })

  it('draws the same text from separate maskers, whatever each drew before', () => {
    const key = join('sk', '-', hex(32))
    const other = createCredentialMasker()
    expect(other.mask('postgres://admin:p4ss-W0rd@db.internal:5432/app')).toBe(`postgres://admin:${stars(9)}@db.internal:5432/app`)
    expect(masker.mask(`${key}用这个`)).toBe(other.mask(`${key}用这个`))
  })
})

describe('formatTables', () => {
  it('gives each owner separate lookup storage with the same formats', () => {
    const first = formatTables()
    const second = formatTables()
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(first.classes).not.toBe(second.classes)
    expect(first.literalMin).not.toBe(second.literalMin)
    expect(first.ending).not.toBe(second.ending)
  })

  it('finds format starts through grouped literals only, so scanning cannot backtrack', () => {
    const literals = formatTables().prefixSource.replace(/\\./gu, '').replaceAll('(?:', '').replaceAll(')', '')
    expect(literals.split('|').length).toBeGreaterThan(20)
    expect(literals).not.toMatch(/[*+?{}()[\].^$]/u)
  })
})
