// Minimal race-test helper for ledger.test.ts's mandatory multi-process next-round test. Reads
// ticket/round/reviewedSha/readyPath/goPath from argv (HOME comes from the inherited environment —
// the test spawns every child with the same overridden HOME so they all race for the same ledger).
// The round to race for is passed in rather than read here: two children each calling readLedger
// after GO cannot be forced to observe the same round under real OS scheduling — a child delayed
// past the other's full claim-and-append cycle legitimately reads the round the winner already
// advanced to, and correctly races for THAT round instead. That is not a shared-round bug; it is two
// callers correctly serializing on different rounds, and asserting against it only proves how fast
// this machine schedules two processes, not whether the exclusive claim holds. Racing on a round
// fixed before GO removes that dependency entirely: both children contend on the exact same claim
// file no matter how long either is descheduled after that point. Calls claimRoundAdvance and
// appendEvent directly (both exported by ledger.ts) rather than through runNextRound, precisely to
// avoid the internal readLedger this test's design was working around — runNextRound's own
// read-then-close flow is exercised by the module's plain single-process tests instead. Signals
// READY only once this module has finished loading, then blocks on a genuine readiness barrier until
// the parent broadcasts GO — a bash-level barrier fires before node even starts, so node's own
// startup jitter would leak into the measured race window; this signals ready from inside node, after
// startup, so the barrier release is what actually controls when the race begins. All non-racy setup
// happens BEFORE the wait loop, matching lock.race-child.ts calling claimLock the instant GO
// appears with nothing in between it and the wait: any work inserted between the wait loop and the
// racy call widens the window in which two children can miss each other, turning a forced-overlap
// race into a legitimate serialization that fails indistinguishably from a real CAS break. Prints
// exactly one line: '0' if this caller won the claim (and has appended round-reviewed/round for it,
// the same two events runNextRound's own success path appends), '9' if refused — matching
// runNextRound's own exit codes for the same two outcomes.
import { existsSync, writeFileSync } from 'node:fs'
import { appendEvent, claimRoundAdvance } from '../ledger.ts'

const [, , ticket, roundArg, reviewedSha, readyPath, goPath] = process.argv
const round = Number(roundArg)
if (!Number.isInteger(round) || round <= 0) {
  throw new Error(
    `next-round.race-child: expected a positive integer round, got ${JSON.stringify(roundArg)}`
  )
}

writeFileSync(readyPath, '')

// Block until GO appears. A synchronous Atomics.wait poll (not an async setInterval) so this truly
// blocks — no event-loop yield that could let Node reorder our claim attempt relative to siblings
// still waiting.
const sab = new Int32Array(new SharedArrayBuffer(4))
while (!existsSync(goPath)) {
  Atomics.wait(sab, 0, 0, 5)
}

if (claimRoundAdvance(ticket, round)) {
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: new Date().toISOString(),
    round,
    reviewedSha,
    stance: 'adversarial',
  })
  appendEvent(ticket, { kind: 'round', at: new Date().toISOString(), round: round + 1 })
  console.log('0')
} else {
  console.log('9')
}
