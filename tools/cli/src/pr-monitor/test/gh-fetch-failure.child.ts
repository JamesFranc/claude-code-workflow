// Minimal child for gh.test.ts's fetchReviews/fetchUnresolvedThreads failure-signal tests. Calls
// fetchPrState against the fake `gh` on PATH the parent test sets up (test/fake-gh/gh), and prints
// the resulting prState to stdout so the caller can confirm resolvePrState's UNKNOWN wiring fired —
// the tests themselves assert on stderr, which is where the console.error diagnostics land.
import { fetchPrState } from '../gh.ts'

// An optional fourth argument is a deadline in milliseconds from now, and adds the UNKNOWN reason.
const [, , prNumber, repo, deadlineMs] = process.argv
const result = fetchPrState(
  prNumber,
  repo,
  deadlineMs === undefined ? undefined : Date.now() + Number(deadlineMs)
)
console.log(result.prState)
if (deadlineMs !== undefined) {
  console.log(result.unknownReason)
}
