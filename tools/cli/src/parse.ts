// Shared Stricli flag parser: a required string that must have non-blank content.
// Boundary validation for flags whose blank value would corrupt state or audit
// trails (e.g. a blank --phase minting a gate-satisfying workflow marker).
export const parseNonBlankString =
  (flagName: string) =>
  (value: string): string => {
    const trimmed = value.trim()
    if (trimmed.length === 0) throw new Error(`${flagName} must not be blank`)
    return trimmed
  }

// A git-sha-shaped string: 7-40 lowercase hex characters. Composes parseNonBlankString's blank
// check rather than duplicating the trim — an unshaped value (too short, too long, uppercase, or
// non-hex) corrupts reviewedShas for the same reason a blank one does, so it is rejected the same
// way. Lowercase only: `git rev-parse` never emits uppercase, and accepting mixed case would let two
// spellings of the same sha become two distinct keys in reviewedShas.
export const parseShaLike =
  (flagName: string) =>
  (value: string): string => {
    const trimmed = parseNonBlankString(flagName)(value)
    if (!/^[0-9a-f]{7,40}$/.test(trimmed))
      throw new Error(`${flagName} must be a 7-40 character lowercase hex sha, got: ${trimmed}`)
    return trimmed
  }
