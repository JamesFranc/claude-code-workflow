// Minimal race-test helper for state.test.ts's mandatory multi-process store-write test. Reads
// mode/prNumber/repo/payload/readyPath/goPath from argv (HOME and CLAUDE_CODE_SESSION_ID come from
// the inherited environment — the test spawns every child with the same overridden values so they
// race for the same store). Validates RACE_CHILD_GO_TIMEOUT_MS before doing anything else: a value
// that is not a bare positive integer prints a diagnostic naming the variable and the value
// received to stderr and exits non-zero. Only once that passes does it signal READY, then block on
// a genuine readiness barrier until the parent broadcasts GO or the validated bound (default
// 15000ms) expires. On GO, mode 'save' calls saveState with a PrState carrying a large `ciChecks`
// map (padding the critical section so a genuinely concurrent sibling has a realistic chance to
// land inside it, without needing a hook into state.ts's internals); mode 'record' calls
// recordSelfComment with `payload` as the comment id. On expiry instead, it never calls either: it
// prints a diagnostic naming the timeout and the goPath to stderr and exits non-zero, so a parent
// that never broadcasts GO fails the test loudly rather than hanging. All non-racy setup —
// including the ciChecks map, the timeout validation, and the barrier's own sab/goDeadline —
// happens BEFORE this module signals READY: that universal is what makes readyPath's absence a
// correctness signal a caller can assert on (a malformed override, or any other setup regression,
// must be rejected before READY, not just before the racy call), not only a tightness measure on
// the post-GO race window.
import { existsSync, writeFileSync } from 'node:fs'
import { cleanBaseline, recordSelfComment, saveState } from '../state.ts'
import { readRaceChildGoTimeoutMs } from './race-child-go-timeout.ts'

const [, , mode, prNumber, repo, payload, readyPath, goPath] = process.argv

const goTimeoutMs = readRaceChildGoTimeoutMs()

// Built here, above the READY signal, not after it — see the header comment above for why.
const ciChecks: Record<string, string> = {}
if (mode === 'save') {
  for (let i = 0; i < 20_000; i++) ciChecks[`check-${i}`] = 'success'
}

const sab = new Int32Array(new SharedArrayBuffer(4))
const goDeadline = Date.now() + goTimeoutMs
writeFileSync(readyPath, '')

while (!existsSync(goPath)) {
  if (Date.now() >= goDeadline) {
    console.error(`store-race-child: timed out after ${goTimeoutMs}ms waiting for GO at ${goPath}`)
    process.exit(1)
  }
  Atomics.wait(sab, 0, 0, 5)
}

if (mode === 'save') {
  saveState(prNumber, repo, { ...cleanBaseline(), ciChecks, headSha: payload })
} else if (mode === 'record') {
  recordSelfComment(prNumber, repo, payload)
} else {
  throw new Error(`store-race-child: unknown mode ${JSON.stringify(mode)}`)
}
