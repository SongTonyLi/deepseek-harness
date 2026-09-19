/**
 * Model-facing unknown-skill diagnostics: closest catalog names, a capped
 * name list, and the closed-catalog rule.
 *
 * @module @deepseek-ai/dsh-tool-skill/unknown-skill
 */

/** Consecutive unknown loads on one live agent that close `skill` for the rest of the turn. */
export const UNKNOWN_SKILL_STREAK_LIMIT = 3

/** Maximum Levenshtein distance that still qualifies a catalog name as close. */
export const MAX_CLOSE_SKILL_DISTANCE = 4

/** Maximum closest catalog names included in an unknown-skill error. */
export const MAX_CLOSE_SKILL_SUGGESTIONS = 3

/** Maximum model-invocable names listed in an unknown-skill error. */
export const MAX_LISTED_CATALOG_NAMES = 40

/**
 * Refusal after {@link UNKNOWN_SKILL_STREAK_LIMIT} consecutive unknown skill
 * loads on the same live agent in the same turn.
 */
export const CLOSED_SKILL_CATALOG_THIS_TURN = 'The skill catalog is closed this turn. The next action must be a task tool (read/edit/write/bash), not another skill load.'

/**
 * First line of every unknown-skill error. Existing `toContain` assertions
 * match this exact sentence.
 * @param name - the requested skill name.
 * @returns the historical unknown-skill sentence.
 */
export function unknownSkillLine(name: string): string {
  return `skill "${name}" is unknown or no longer available`
}

/**
 * Closed-catalog instruction appended to every unknown-skill error.
 */
export const CLOSED_SKILL_CATALOG_LINE = 'The skill catalog is closed: use only listed names. Do not invent names.'

/**
 * Levenshtein edit distance between two strings (insert, delete, substitute).
 * @param left - first string.
 * @param right - second string.
 * @returns the non-negative edit distance.
 */
export function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length
  return levenshteinRows(left, right)
}

/**
 * Whether `needle` is an ordered subsequence of `haystack`.
 * @param needle - characters that must appear in order.
 * @param haystack - string that may contain those characters.
 * @returns whether every needle character appears in order in haystack.
 */
export function isSubsequenceOf(needle: string, haystack: string): boolean {
  let index = 0
  for (const character of haystack) {
    if (character === needle[index]) index += 1
    if (index === needle.length) return true
  }
  return index === needle.length
}

/**
 * Rank model-invocable catalog names nearest to a requested name.
 * A candidate qualifies when its Levenshtein distance is at most
 * {@link MAX_CLOSE_SKILL_DISTANCE} or it is a prefix or subsequence of the
 * other string. The requested name itself is omitted.
 * @param name - the requested skill name.
 * @param catalogNames - model-invocable names in catalog order.
 * @returns at most {@link MAX_CLOSE_SKILL_SUGGESTIONS} names, nearest first,
 *   then code-point order.
 */
export function rankClosestCatalogNames(name: string, catalogNames: readonly string[]): string[] {
  return catalogNames
    .filter(candidate => candidate !== name)
    .map(candidate => ({ candidate, distance: levenshteinDistance(name, candidate) }))
    .filter(entry => qualifiesCloseName(name, entry.candidate, entry.distance))
    .sort((left, right) => left.distance - right.distance || compareCatalogNames(left.candidate, right.candidate))
    .slice(0, MAX_CLOSE_SKILL_SUGGESTIONS)
    .map(entry => entry.candidate)
}

/**
 * Build the model-facing unknown-skill error. The first line is
 * {@link unknownSkillLine}; later lines add closest names or a no-match
 * notice, the catalog list or an empty-catalog notice, and
 * {@link CLOSED_SKILL_CATALOG_LINE}.
 * @param name - the requested skill name.
 * @param catalogNames - model-invocable names in catalog order.
 * @returns the multiline error message without the tools `Error: ` wrapper.
 */
export function formatUnknownSkillError(name: string, catalogNames: readonly string[]): string {
  return [
    unknownSkillLine(name),
    closestNamesLine(name, catalogNames),
    catalogNames.length === 0 ? 'The skill catalog is empty.' : listedNamesLine(catalogNames),
    CLOSED_SKILL_CATALOG_LINE,
  ].join('\n')
}

function qualifiesCloseName(name: string, candidate: string, distance: number): boolean {
  return distance <= MAX_CLOSE_SKILL_DISTANCE
    || candidate.startsWith(name)
    || name.startsWith(candidate)
    || isSubsequenceOf(name, candidate)
    || isSubsequenceOf(candidate, name)
}

function closestNamesLine(name: string, catalogNames: readonly string[]): string {
  const closest = rankClosestCatalogNames(name, catalogNames)
  return closest.length === 0
    ? 'No close catalog name matches.'
    : `Closest catalog names: ${quoteNames(closest)}`
}

function listedNamesLine(catalogNames: readonly string[]): string {
  const shown = catalogNames.slice(0, MAX_LISTED_CATALOG_NAMES)
  const extra = catalogNames.length - shown.length
  const listed = `Valid skill names: ${quoteNames(shown)}`
  return extra === 0 ? listed : `${listed} (+${String(extra)} more)`
}

function quoteNames(names: readonly string[]): string {
  return names.map(name => `\`${name}\``).join(', ')
}

/**
 * Code-point order for catalog names, matching the skill registry sort.
 * @param left - first name.
 * @param right - second name.
 * @returns negative when `left` precedes `right`, zero when equal, positive otherwise.
 */
export function compareCatalogNames(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function levenshteinRows(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 0; i < left.length; i += 1) {
    const current = [i + 1]
    for (let j = 0; j < right.length; j += 1) {
      const substitution = left[i] === right[j] ? 0 : 1
      current.push(Math.min(
        (current[j] ?? 0) + 1,
        (previous[j + 1] ?? 0) + 1,
        (previous[j] ?? 0) + substitution,
      ))
    }
    previous = current
  }
  return previous[right.length] ?? 0
}
