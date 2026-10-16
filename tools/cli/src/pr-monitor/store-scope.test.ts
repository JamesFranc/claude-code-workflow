import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { cleanBaseline, compareStates, type PrState } from './state.ts'

// storeDir() is homedir()-relative (os.homedir() reads $HOME on POSIX) — override HOME so these
// tests never touch the real ~/.claude/workflow-state. Each test picks its own
// CLAUDE_CODE_SESSION_ID so tests never share a partition.
let homeDir: string

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'pr-monitor-store-scope-test-'))
})

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true })
})

const CHILD_SCRIPT = join(import.meta.dirname, 'test', 'store-scope.child.ts')

// Runs the action in a genuinely separate process — the pr-monitor dirKey is pinned per process
// by workflow-store/store.ts's resolveDirKey, so a same-process process.chdir() between two calls
// would resolve the same key and pass against the broken code. Only a real process boundary
// reaches the defect.
const runChild = (cwd: string, sessionId: string, args: string[]): string => {
  mkdirSync(cwd, { recursive: true })
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', CHILD_SCRIPT, ...args],
    {
      cwd,
      env: { ...process.env, HOME: homeDir, CLAUDE_CODE_SESSION_ID: sessionId },
      encoding: 'utf-8',
    }
  )
  assert.equal(result.status, 0, `child exited nonzero: ${result.stderr}`)
  return result.stdout.trim()
}

test('loadState finds a baseline saved from a different launch directory, same session (FLOW-216)', () => {
  const sessionId = 'flow-216-same-session'
  const dirRoot = join(homeDir, 'repo-root')
  const dirWorktree = join(homeDir, 'wt')
  const state = { ...cleanBaseline(), isDraft: false, headSha: 'abc123' }

  runChild(dirRoot, sessionId, ['save', '42', 'acme/widget', JSON.stringify(state)])
  const loaded = runChild(dirWorktree, sessionId, ['load', '42', 'acme/widget'])

  assert.notEqual(loaded, 'null', 'baseline saved from dirRoot must be visible from dirWorktree')
  const parsed = JSON.parse(loaded)
  assert.equal(parsed.isDraft, false)
  assert.equal(parsed.headSha, 'abc123')
})

// Anti-vacuity control for the test above: a loadState that always returned SOME state (e.g. never
// checked the PR key) would pass the cross-cwd test too. A different PR, never saved, must still
// come back null.
test('loadState for a different PR number, never saved, is still null (anti-vacuity control)', () => {
  const sessionId = 'flow-216-anti-vacuity'
  const dirRoot = join(homeDir, 'repo-root')
  const dirWorktree = join(homeDir, 'wt')
  const state = { ...cleanBaseline(), isDraft: false }

  runChild(dirRoot, sessionId, ['save', '42', 'acme/widget', JSON.stringify(state)])
  const loaded = runChild(dirWorktree, sessionId, ['load', '43', 'acme/widget'])

  assert.equal(loaded, 'null', 'a different PR must not resolve to the PR 42 baseline')
})

// The user's invariant: two sessions watching the same PR must keep independent baselines and
// independent wake streams. A fix that keyed the store on repo#prNumber alone would let the first
// watcher's save mask the transition from every other watcher — this must never happen.
//
// 3a is the mechanism: B cannot see A's store at all. 3b is the behaviour the user actually cares
// about, and the one 3a alone cannot prove: B must still EMIT when A consumes a transition first.
test('3a — two different sessions watching the same PR keep independent baselines (mechanism)', () => {
  const dir = join(homeDir, 'repo-root')
  const state = { ...cleanBaseline(), isDraft: false }

  runChild(dir, 'flow-216-session-a', ['save', '42', 'acme/widget', JSON.stringify(state)])
  const loaded = runChild(dir, 'flow-216-session-b', ['load', '42', 'acme/widget'])

  assert.equal(loaded, 'null', "a different session must not see another session's baseline")
})

test("3b — B still emits after A consumes the same transition (the user's required invariant)", () => {
  const dir = join(homeDir, 'repo-root')
  const prNumber = '42'
  const repo = 'acme/widget'
  // X: draft, green CI. Y: same commit, out of draft — a real READY_FOR_REVIEW transition.
  const baselineX: PrState = {
    ...cleanBaseline(),
    isDraft: true,
    ciChecks: { ci: 'success' },
    headSha: 'sha1',
  }
  const updateY: PrState = { ...baselineX, isDraft: false }
  // A copy, not updateY itself: compareStates mutates its `current` argument
  // (ciGreenOnDraftFired, coderabbitThrottleCount) — running the precondition against the same
  // object that gets serialized below and diffed again at the real assertion would let a later
  // edit to this fixture (e.g. changing Y to a draft with green CI) silently corrupt the real
  // assertion via a mutation this precondition caused, while still reporting green.
  assert.ok(
    compareStates(baselineX, { ...updateY }).length > 0,
    'precondition: X -> Y must itself be a real, non-empty transition'
  )

  // Both sessions independently observe and save the SAME starting baseline X.
  runChild(dir, 'flow-216-emit-a', ['save', prNumber, repo, JSON.stringify(baselineX)])
  runChild(dir, 'flow-216-emit-b', ['save', prNumber, repo, JSON.stringify(baselineX)])

  // A polls again, observes Y, and saves it — A has now consumed the transition.
  runChild(dir, 'flow-216-emit-a', ['save', prNumber, repo, JSON.stringify(updateY)])

  // B polls next. Its OWN loadState must still return X — not Y, not null. This is the assertion
  // that does the work: if the store were shared, B would load Y, and compareStates(Y, Y) is
  // empty. The store — not a local variable — has to sit between A's save and this comparison.
  const loadedB = JSON.parse(
    runChild(dir, 'flow-216-emit-b', ['load', prNumber, repo])
  ) as PrState | null

  // assert.ok (not notEqual) so TS narrows loadedB to PrState below — matches the `PrState | null`
  // annotation above, which says what this line actually tests instead of asserting non-null in
  // the type while checking it again at runtime.
  assert.ok(loadedB !== null, "B's own baseline must still be present")
  assert.deepEqual(loadedB, baselineX, "B must have loaded its own X — not A's Y")

  // Diffing B's own loaded baseline against Y via the real compareStates — the same function
  // poll.ts calls — must still be a genuine, non-empty transition for B.
  const changes = compareStates(loadedB, updateY)
  assert.ok(changes.length > 0, 'B must still emit on the transition A already consumed')
  assert.ok(
    changes.some((c) => c.type === 'READY_FOR_REVIEW'),
    `expected a READY_FOR_REVIEW change, got: ${JSON.stringify(changes)}`
  )
})

// Migration: an in-flight monitor's baseline lives at the pre-FLOW-216 cwd-keyed path. The first
// read after upgrading must adopt it rather than falling back to cleanBaseline() — which is the
// exact spurious-wake this ticket fixes, reintroduced once at upgrade if adoption is missing.
//
// The legacy file is left in place, not removed: a pre-upgrade monitor may still be RUNNING and
// reading/writing it directly. Deleting it out from under that process reproduces the same
// spurious-wake symptom in the OLD process instead — adopt-and-leave, not adopt-and-remove (see
// adoptLegacy's comment in state.ts for the full reasoning and the residual trade this accepts).
test('loadState adopts a pre-FLOW-216 legacy baseline and leaves the legacy file in place', () => {
  const sessionId = 'flow-216-legacy-adopt'
  const dir = join(homeDir, 'repo-root')
  const state = { ...cleanBaseline(), isDraft: false, headSha: 'legacy-sha' }

  const result = JSON.parse(
    runChild(dir, sessionId, ['legacy-adopt', '42', 'acme/widget', JSON.stringify(state)])
  )

  assert.notEqual(result.loaded, null, 'the legacy baseline must be found on first read')
  assert.equal(result.loaded.headSha, 'legacy-sha')
  assert.equal(
    result.newExists,
    true,
    'the state is now persisted at the new (session-global) path'
  )
  assert.equal(
    result.legacyExists,
    true,
    'the legacy file is left in place — a pre-upgrade monitor may still own it'
  )
})

// B2: legacy adoption must look beyond the current cwd's own dirKey. Reading only sessionScope()'s
// own legacy path adopts correctly only when the first post-upgrade launch happens to be from the
// same directory the baseline was last written from — a new story's worktree defeats that
// immediately, and the bug doc's own reproduction found two legacy dirKeys for one session.
test('legacy adoption merges sibling dirKey directories per PR key, newest updatedAt wins', () => {
  const sessionId = 'flow-216-sibling-merge'
  const dirA = join(homeDir, 'repo-root')
  const dirB = join(homeDir, 'wt')
  const dirC = join(homeDir, 'third-dir') // triggers adoption; holds no legacy file of its own

  const oldTimestamp = new Date(Date.now() - 60 * 60_000).toISOString()
  const newTimestamp = new Date().toISOString()

  runChild(dirA, sessionId, [
    'legacy-write-raw',
    JSON.stringify({
      'acme/widget#42': {
        state: { ...cleanBaseline(), headSha: 'from-dirA' },
        updatedAt: oldTimestamp,
      },
    }),
  ])
  runChild(dirB, sessionId, [
    'legacy-write-raw',
    JSON.stringify({
      'acme/widget#42': {
        state: { ...cleanBaseline(), headSha: 'from-dirB' },
        updatedAt: newTimestamp,
      },
      'acme/widget#43': {
        state: { ...cleanBaseline(), headSha: 'dirB-only' },
        updatedAt: newTimestamp,
      },
    }),
  ])

  const loaded42 = JSON.parse(runChild(dirC, sessionId, ['load', '42', 'acme/widget']))
  const loaded43 = JSON.parse(runChild(dirC, sessionId, ['load', '43', 'acme/widget']))

  assert.equal(
    loaded42.headSha,
    'from-dirB',
    'the newer updatedAt across sibling dirKeys must win for the same PR key'
  )
  assert.equal(
    loaded43.headSha,
    'dirB-only',
    'a PR present in only ONE sibling legacy dir must still be adopted'
  )
  assert.equal(
    runChild(dirA, sessionId, ['legacy-exists']),
    'true',
    "dirA's legacy file is left in place (adopt-and-leave, not adopt-and-remove)"
  )
  assert.equal(
    runChild(dirB, sessionId, ['legacy-exists']),
    'true',
    "dirB's legacy file is left in place (adopt-and-leave, not adopt-and-remove)"
  )
})

// B4: reordering readStoreRaw to try legacy first leaves every other test in this file green — it
// reintroduces the stale-baseline resurrection the code comment above readStoreRaw claims to
// prevent. The new path, once present, must win outright, even with a legacy file still on disk —
// and, since legacy is never even consulted in this case, that legacy file must be left untouched
// (a hypothetical "merge both, newest wins" implementation could satisfy the headSha assertion
// alone depending on write order, while still reading and removing a legacy file it should never
// have touched).
test('the new path wins over a surviving legacy file — a stale baseline must never resurrect a live one', () => {
  const dir = join(homeDir, 'repo-root')
  const sessionId = 'flow-216-new-wins'
  const newState = { ...cleanBaseline(), isDraft: false, headSha: 'new-sha' }
  const legacyState = { ...cleanBaseline(), isDraft: true, headSha: 'legacy-sha' }

  const result = JSON.parse(
    runChild(dir, sessionId, [
      'seed-both',
      '42',
      'acme/widget',
      JSON.stringify(newState),
      JSON.stringify(legacyState),
    ])
  )

  assert.equal(
    result.loaded.headSha,
    'new-sha',
    'the new path must win regardless of a surviving legacy file'
  )
  assert.equal(
    result.legacyExists,
    true,
    'the legacy file must be left alone — never even read — once the new path exists'
  )
})

// B5 / the FLOW-216 bug doc: pin the state key format with a test rather than leaving it an
// accident of the current implementation. `/` and `#` cannot appear in a GitHub owner or repo
// name, so `${repo}#${prNumber}` is unambiguous — but only if nothing ever flattens the `/` (the
// exact mistake the lock filename made, fixed separately by Task 4).
//
// Also pins the file mode atomicWrite gives state.json (0o600, tightened from writeStore's old
// default-umask write) — a real, user-visible change to a file under ~/.claude/ that nothing else
// guards. Without this, a future refactor that hand-rolls writeStore again (reintroducing a bare
// writeFileSync) silently restores 0644 and nothing goes red.
test('state key is `${repo}#${prNumber}`, unflattened — pinned against an accidental future change', () => {
  const dir = join(homeDir, 'repo-root')
  const state = { ...cleanBaseline() }

  const result = JSON.parse(
    runChild(dir, 'flow-216-prkey-format', [
      'save-and-dump',
      '7',
      'foo/acme',
      JSON.stringify(state),
    ])
  )
  const dump = JSON.parse(result.raw)

  assert.deepEqual(
    Object.keys(dump.prs),
    ['foo/acme#7'],
    'the on-disk store key must be exactly `${repo}#${prNumber}`, not a flattened/sanitized repo'
  )
  assert.equal(result.mode, 0o600, 'state.json must be written 0600 via atomicWrite')
})

// The same colliding pair used for the lock filename fix (lock.test.ts): `acme/foo-bar` and
// `acme-foo/bar` both flatten to `acme-foo-bar` under a naive `/` -> `-` join. A test using repos
// that merely differ (e.g. 'foo/acme' vs 'bar/acme') would pass by arithmetic even under that
// flattening — this pair is chosen because it is a REAL collision if `/` is ever flattened.
test('two repos that would collide if `/` were ever flattened do not collide in one store', () => {
  const dir = join(homeDir, 'repo-root')
  const sessionId = 'flow-216-prkey-distinct'
  const stateFoo = { ...cleanBaseline(), headSha: 'foo-sha' }
  const stateBar = { ...cleanBaseline(), headSha: 'bar-sha' }

  runChild(dir, sessionId, ['save', '7', 'acme/foo-bar', JSON.stringify(stateFoo)])
  runChild(dir, sessionId, ['save', '7', 'acme-foo/bar', JSON.stringify(stateBar)])

  const loadedFoo = JSON.parse(runChild(dir, sessionId, ['load', '7', 'acme/foo-bar']))
  const loadedBar = JSON.parse(runChild(dir, sessionId, ['load', '7', 'acme-foo/bar']))

  assert.equal(
    loadedFoo.headSha,
    'foo-sha',
    "acme/foo-bar#7 must not resolve to acme-foo/bar#7's state"
  )
  assert.equal(
    loadedBar.headSha,
    'bar-sha',
    "acme-foo/bar#7 must not resolve to acme/foo-bar#7's state"
  )
})

// NEW-1: a non-ENOENT read failure on the current path (EACCES, EIO, a directory where the file
// should be, ...) must degrade to an empty store, not crash the process. the --ack-comment
// process has no try/catch around loadState/saveState — origin/main's equivalent read sat inside
// loadStore's own try and degraded on ANY error; a bare re-throw here would fail every poll of
// the PR, which is worse than the one spurious wake a degrade-to-empty costs.
//
// Simulated with a directory in place of the file (EISDIR), not chmod 000 (EACCES): chmod-000 does
// not fail for root, so a test built on it would silently prove nothing on a root CI runner — the
// same vacuity class as this story's other traps (in-process chdir, foo/acme vs bar/acme). The
// precondition, not the outcome, is what makes a permission-based check real.
test('a non-ENOENT read failure on the current path degrades to empty — no crash, no legacy merge', () => {
  const dir = join(homeDir, 'repo-root')
  const sessionId = 'flow-216-unreadable-current'
  const legacyState = { ...cleanBaseline(), headSha: 'legacy-sha' }

  const result = JSON.parse(
    runChild(dir, sessionId, [
      'unreadable-current-with-legacy',
      '42',
      'acme/widget',
      JSON.stringify(legacyState),
    ])
  )

  assert.equal(result.threw, false, 'a non-ENOENT read failure must not crash the process')
  assert.equal(
    result.loaded,
    null,
    'degrades to an empty store — no data resurrected from a corrupted read'
  )
  assert.equal(
    result.legacyExists,
    true,
    'the legacy file must be left untouched — never merged over an unreadable-but-possibly-newer current file'
  )
})

// N5: Date.parse of an unparseable updatedAt is NaN, and any comparison against NaN is false — so
// an entry with a garbage timestamp must never be adopted at all, not just "usually lose to a valid
// competitor". A single, uncontested garbage entry is the simplest deterministic proof: it has no
// competing entry to lose to, so adopting it here would only be possible if the guard were missing
// entirely.
test('a legacy entry with an unparseable updatedAt is never adopted, even uncontested', () => {
  const sessionId = 'flow-216-nan-timestamp-guard'
  const dir = join(homeDir, 'repo-root')

  runChild(dir, sessionId, [
    'legacy-write-raw',
    JSON.stringify({
      'acme/widget#42': {
        state: { ...cleanBaseline(), headSha: 'garbage-timestamp-entry' },
        updatedAt: 'not-a-real-timestamp',
      },
    }),
  ])

  const loaded = runChild(dir, sessionId, ['load', '42', 'acme/widget'])

  assert.equal(loaded, 'null', 'an unparseable-timestamp entry must never win adoption')
})
