// Shared by store-race-child.ts and lock.race-child.ts: reads RACE_CHILD_GO_TIMEOUT_MS from the
// environment and returns a positive-integer millisecond bound. An unset variable defaults to
// 15000. Any other value that is not a bare positive integer — including '' (which `??` lets
// through, `parseInt` would then turn into NaN, and a NaN deadline never expires), a
// partial-parse string like '15s' or '1e3' (which `parseInt` would silently truncate to 15 or 1),
// and an oversized numeric string like '9'.repeat(400) (which `Number` parses to Infinity, not a
// safe integer, silently reintroducing the same unbounded wait) —
// exits the process non-zero with a diagnostic naming the variable and the value received, so a
// malformed override fails loudly instead of silently reintroducing an unbounded wait.
const GO_TIMEOUT_MS_DEFAULT = 15_000

export const readRaceChildGoTimeoutMs = (): number => {
  const raw = process.env.RACE_CHILD_GO_TIMEOUT_MS
  if (raw === undefined) return GO_TIMEOUT_MS_DEFAULT

  const parsed = Number(raw)
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(parsed)) {
    console.error(
      `race-child: RACE_CHILD_GO_TIMEOUT_MS must be a positive integer string, got ${JSON.stringify(raw)}`
    )
    process.exit(1)
  }

  return parsed
}
