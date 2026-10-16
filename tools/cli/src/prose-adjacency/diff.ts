export interface Pair {
  first: string
  second: string
}

export interface ProseAdjacencyResult {
  // The two weaker instruments, reported alongside the adjacency diff so the output shows the gap
  // between them rather than asserting it. See Task 7 / the command's `brief`: word-multiset
  // equality and character-count equality both hold on a pure reorder — they cannot see it move.
  wordMultisetIdentical: boolean
  charCountIdentical: boolean
  pairsBroken: Pair[]
  pairsCreated: Pair[]
}

export const diffProse = (before: string, after: string): ProseAdjacencyResult => {
  const beforeTokens = tokenize(before)
  const afterTokens = tokenize(after)

  const { removed: pairsBrokenKeys, added: pairsCreatedKeys } = multisetDiff(
    adjacentPairKeys(beforeTokens),
    adjacentPairKeys(afterTokens)
  )

  return {
    wordMultisetIdentical: isSameMultiset(beforeTokens, afterTokens),
    charCountIdentical: normalizeWhitespace(before).length === normalizeWhitespace(after).length,
    pairsBroken: pairsBrokenKeys.map(pairFromKey),
    pairsCreated: pairsCreatedKeys.map(pairFromKey),
  }
}

const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim()

const tokenize = (text: string): string[] => {
  const normalized = normalizeWhitespace(text)
  return normalized === '' ? [] : normalized.split(' ')
}

// Keyed as JSON tuples, not string concatenation — concatenation collides ("a"+"bc" === "ab"+"c")
// and prose words can contain arbitrary punctuation.
const adjacentPairKeys = (tokens: string[]): string[] => {
  const pairs: string[] = []
  for (let i = 0; i < tokens.length - 1; i++) {
    pairs.push(JSON.stringify([tokens[i], tokens[i + 1]]))
  }
  return pairs
}

const pairFromKey = (key: string): Pair => {
  const [first, second] = JSON.parse(key) as [string, string]
  return { first, second }
}

// Bag (multiset) difference: an element present `m` times on one side and `n` times on the other
// contributes `m - n` occurrences to whichever side has more, at that multiplicity — not just a
// present/absent flag. This matters because prose can legitimately repeat a word pair.
const multisetDiff = (
  before: readonly string[],
  after: readonly string[]
): { removed: string[]; added: string[] } => {
  const beforeCounts = countBy(before)
  const afterCounts = countBy(after)
  const keys = new Set([...beforeCounts.keys(), ...afterCounts.keys()])

  const removed: string[] = []
  const added: string[] = []
  for (const key of keys) {
    const beforeCount = beforeCounts.get(key) ?? 0
    const afterCount = afterCounts.get(key) ?? 0
    for (let i = 0; i < beforeCount - afterCount; i++) removed.push(key)
    for (let i = 0; i < afterCount - beforeCount; i++) added.push(key)
  }
  return { removed, added }
}

const isSameMultiset = (a: readonly string[], b: readonly string[]): boolean => {
  const countsA = countBy(a)
  const countsB = countBy(b)
  if (countsA.size !== countsB.size) return false
  for (const [key, count] of countsA) {
    if (countsB.get(key) !== count) return false
  }
  return true
}

const countBy = (items: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return counts
}
