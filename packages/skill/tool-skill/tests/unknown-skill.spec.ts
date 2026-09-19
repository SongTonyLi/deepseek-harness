import { describe, expect, it } from 'vitest'
import {
  CLOSED_SKILL_CATALOG_LINE,
  CLOSED_SKILL_CATALOG_THIS_TURN,
  compareCatalogNames,
  formatUnknownSkillError,
  isSubsequenceOf,
  levenshteinDistance,
  rankClosestCatalogNames,
  unknownSkillLine,
} from '@deepseek-ai/dsh-tool-skill'

describe('unknown-skill diagnostics', () => {
  it('orders catalog names by code point', () => {
    expect(compareCatalogNames('aaab', 'aaac')).toBeLessThan(0)
    expect(compareCatalogNames('aaac', 'aaab')).toBeGreaterThan(0)
    expect(compareCatalogNames('aaab', 'aaab')).toBe(0)
  })

  it('computes Levenshtein insert, delete, substitute, and empty-string distances', () => {
    expect(levenshteinDistance('abc', 'abc')).toBe(0)
    expect(levenshteinDistance('', 'abc')).toBe(3)
    expect(levenshteinDistance('abc', '')).toBe(3)
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3)
    expect(levenshteinDistance('code-review', 'code-reveiw')).toBe(2)
  })

  it('detects ordered subsequences including empty needles', () => {
    expect(isSubsequenceOf('', '')).toBe(true)
    expect(isSubsequenceOf('', 'abc')).toBe(true)
    expect(isSubsequenceOf('drv', 'dsh-review')).toBe(true)
    expect(isSubsequenceOf('dsh-review', 'drv')).toBe(false)
    expect(isSubsequenceOf('zzz', 'dsh-review')).toBe(false)
    expect(isSubsequenceOf('a', '')).toBe(false)
  })

  it('ranks prefix, subsequence, and nearby names and omits exact matches', () => {
    expect(rankClosestCatalogNames('code-reveiw', ['code-review', 'code-search', 'other-skill']))
      .toEqual(['code-review'])
    expect(rankClosestCatalogNames('dsh', ['dsh-refactor', 'dsh-review', 'yyyyyy']))
      .toEqual(['dsh-review', 'dsh-refactor'])
    expect(rankClosestCatalogNames('drv', ['dsh-review', 'alpha']))
      .toEqual(['dsh-review'])
    expect(rankClosestCatalogNames('code-review-extra', ['code-review']))
      .toEqual(['code-review'])
    expect(rankClosestCatalogNames('xxdsh-reviewyy', ['dsh-review']))
      .toEqual(['dsh-review'])
    expect(rankClosestCatalogNames('listed', ['listed']))
      .toEqual([])
    expect(rankClosestCatalogNames('zzzzz', ['alpha', 'beta']))
      .toEqual([])
  })

  it('keeps distance-4 names, drops distance-5 names that are not prefix or subsequence, and caps at three', () => {
    expect(rankClosestCatalogNames('aaaa', ['aaab', 'bbbb'])).toEqual(['aaab', 'bbbb'])
    expect(rankClosestCatalogNames('aaaaa', ['bbbbb'])).toEqual([])
    expect(rankClosestCatalogNames('aaaa', ['aaae', 'aaad', 'aaac', 'aaab']))
      .toEqual(['aaab', 'aaac', 'aaad'])
  })

  it('formats unknown-skill errors for empty, matching, and capped catalogs', () => {
    expect(formatUnknownSkillError('missing', [])).toBe([
      unknownSkillLine('missing'),
      'No close catalog name matches.',
      'The skill catalog is empty.',
      CLOSED_SKILL_CATALOG_LINE,
    ].join('\n'))
    expect(formatUnknownSkillError('code-reveiw', ['code-review', 'other-skill'])).toBe([
      unknownSkillLine('code-reveiw'),
      'Closest catalog names: `code-review`',
      'Valid skill names: `code-review`, `other-skill`',
      CLOSED_SKILL_CATALOG_LINE,
    ].join('\n'))
    const names = Array.from({ length: 42 }, (_, index) => `skill-${String(index).padStart(2, '0')}`)
    const formatted = formatUnknownSkillError('missing', names)
    expect(formatted).toContain('`skill-39` (+2 more)')
    expect(formatted).not.toContain('`skill-40`')
    expect(CLOSED_SKILL_CATALOG_THIS_TURN).toContain('task tool (read/edit/write/bash)')
  })
})
