// Minimal race-test helper for lock.test.ts's mandatory multi-process claimLock test. Reads
// pr/repo/readyPath/goPath from argv (HOME and CLAUDE_CODE_SESSION_ID come from the inherited
// environment — the test spawns every child with the same overridden values so they all race for
// the same lock file). Validates RACE_CHILD_GO_TIMEOUT_MS before doing anything else: a value that
// is not a bare positive integer prints a diagnostic naming the variable and the value received to
// stderr and exits non-zero. Only once that passes does it signal READY, then block on a genuine
// readiness barrier until the parent broadcasts GO or the validated bound (default 15000ms) expires
// — a real barrier, not a wall-clock guess. All non-racy setup — including the timeout validation
// and the barrier's own sab/goDeadline — happens BEFORE this module signals READY: that universal
// is what makes readyPath's absence a correctness signal a caller can assert on (a malformed
// override, or any other setup regression, must be rejected before READY, not just before the racy
// call). On GO, calls claimLock at (as close as possible to) the same instant as every other child
// and prints exactly one line: ACQUIRED or REFUSED. A winner holds briefly afterward so it stays a
// live, fresh holder for the duration of the race. On expiry instead, it never calls claimLock: it
// prints a diagnostic naming the timeout and the goPath to stderr and exits non-zero, so a parent
// that never broadcasts GO fails the test loudly rather than hanging.
import { existsSync, writeFileSync } from 'node:fs'
import { claimLock, lockPath } from '../lock.ts'
import { readRaceChildGoTimeoutMs } from './race-child-go-timeout.ts'

const [, , prNumber, repo, readyPath, goPath] = process.argv

const goTimeoutMs = readRaceChildGoTimeoutMs()
const sab = new Int32Array(new SharedArrayBuffer(4))
const goDeadline = Date.now() + goTimeoutMs
writeFileSync(readyPath, '')

// Block until GO appears or the bound expires. A synchronous Atomics.wait poll (not an async
// setInterval) so this truly blocks — no event-loop yield that could let Node reorder our claim
// attempt relative to siblings still waiting.
while (!existsSync(goPath)) {
  if (Date.now() >= goDeadline) {
    console.error(`lock-race-child: timed out after ${goTimeoutMs}ms waiting for GO at ${goPath}`)
    process.exit(1)
  }
  Atomics.wait(sab, 0, 0, 5)
}

const result = claimLock(lockPath(prNumber, repo), `${repo}#${prNumber}`)
if (result.acquired) {
  console.log('ACQUIRED')
  await new Promise((resolve) => setTimeout(resolve, 2000))
} else {
  console.log('REFUSED')
}
