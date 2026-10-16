import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanBaseline,
  compareStates,
  deleteState,
  loadSelfCommentIds,
  loadState,
  loadWatched,
  markPolled,
  recordSelfComment,
  recordUnknownPoll,
  saveState,
  statePath,
  storeDir,
  storeLockPath,
  type CoderabbitStatus,
  type PrState,
  type ReviewThread,
  unwatchPr,
  watchPr,
} from './state.ts'
import { toReviewThreads } from './gh.ts'
import { atomicWrite } from '../workflow-store/store.ts'

const withCoderabbit = (status: CoderabbitStatus, overrides: Partial<PrState> = {}): PrState => ({
  ...cleanBaseline(),
  coderabbitStatus: status,
  headSha: 'sha1',
  ...overrides,
})

test('none to rate-limited emits CODERABBIT_RATE_LIMITED with occurrence 1', () => {
  const prev = withCoderabbit('none')
  const curr = withCoderabbit('rate-limited', { coderabbitCooloffMinutes: 34 })
  const changes = compareStates(prev, curr)
  const evt = changes.find((c) => c.type === 'CODERABBIT_RATE_LIMITED')
  assert.ok(evt, 'expected a CODERABBIT_RATE_LIMITED event')
  assert.match(evt.detail, /occurrence 1/)
  assert.match(evt.detail, /~34m/)
  assert.equal(curr.coderabbitThrottleCount, 1)
})

test('a persistent rate-limited banner does not re-emit', () => {
  const prev = withCoderabbit('rate-limited', { coderabbitThrottleCount: 1 })
  const curr = withCoderabbit('rate-limited', { coderabbitCooloffMinutes: 20 })
  const changes = compareStates(prev, curr)
  assert.equal(
    changes.some((c) => c.type === 'CODERABBIT_RATE_LIMITED'),
    false
  )
  assert.equal(curr.coderabbitThrottleCount, 1) // carried, not incremented
})

test('repeated throttles on the same commit accumulate the occurrence count', () => {
  const prev = withCoderabbit('none', { coderabbitThrottleCount: 3 })
  const curr = withCoderabbit('rate-limited', { coderabbitCooloffMinutes: 10 })
  const evt = compareStates(prev, curr).find((c) => c.type === 'CODERABBIT_RATE_LIMITED')
  assert.ok(evt, 'expected a CODERABBIT_RATE_LIMITED event')
  assert.match(evt.detail, /occurrence 4/)
  assert.equal(curr.coderabbitThrottleCount, 4)
})

test('a new headSha resets the throttle count', () => {
  const prev = withCoderabbit('none', { coderabbitThrottleCount: 3, headSha: 'old' })
  const curr = withCoderabbit('rate-limited', { coderabbitCooloffMinutes: 10, headSha: 'new' })
  const evt = compareStates(prev, curr).find((c) => c.type === 'CODERABBIT_RATE_LIMITED')
  assert.ok(evt, 'expected a CODERABBIT_RATE_LIMITED event')
  assert.match(evt.detail, /occurrence 1/)
  assert.equal(curr.coderabbitThrottleCount, 1)
})

test('unknown cooloff still emits with a fallback note', () => {
  const prev = withCoderabbit('none')
  const curr = withCoderabbit('rate-limited', { coderabbitCooloffMinutes: null })
  const evt = compareStates(prev, curr).find((c) => c.type === 'CODERABBIT_RATE_LIMITED')
  assert.ok(evt, 'expected a CODERABBIT_RATE_LIMITED event')
  assert.match(evt.detail, /cooloff unknown/)
})

test('none to paused emits CODERABBIT_PAUSED', () => {
  const prev = withCoderabbit('none')
  const curr = withCoderabbit('paused')
  assert.equal(
    compareStates(prev, curr).some((c) => c.type === 'CODERABBIT_PAUSED'),
    true
  )
})

test('rate-limited to none clears without a spurious event', () => {
  const prev = withCoderabbit('rate-limited', { coderabbitThrottleCount: 2 })
  const curr = withCoderabbit('none')
  const changes = compareStates(prev, curr)
  assert.equal(
    changes.some((c) => c.type.startsWith('CODERABBIT_')),
    false
  )
})

test('a direct draft→ready flip that is not merge-ready emits READY_FOR_REVIEW', () => {
  const prev: PrState = {
    ...cleanBaseline(),
    isDraft: true,
    ciChecks: { ci: 'success' },
    headSha: 'sha1',
  }
  const curr: PrState = {
    ...cleanBaseline(),
    isDraft: false,
    ciChecks: { ci: 'success' },
    headSha: 'sha1',
  }
  const changes = compareStates(prev, curr)
  assert.equal(
    changes.some((c) => c.type === 'READY_FOR_REVIEW'),
    true
  )
  assert.equal(
    changes.some((c) => c.type === 'MERGE_READY'),
    false
  )
})

test('a draft→ready flip that is already merge-ready emits MERGE_READY, not READY_FOR_REVIEW', () => {
  const prev: PrState = {
    ...cleanBaseline(),
    isDraft: true,
    ciChecks: { ci: 'success' },
    headSha: 'sha1',
    reviews: [{ author: 'alice', authorType: 'User', state: 'APPROVED' }],
    mergeStateStatus: 'CLEAN',
  }
  const curr: PrState = { ...prev, isDraft: false }
  const changes = compareStates(prev, curr)
  assert.equal(
    changes.some((c) => c.type === 'MERGE_READY'),
    true
  )
  assert.equal(
    changes.some((c) => c.type === 'READY_FOR_REVIEW'),
    false
  )
})

test('no READY_FOR_REVIEW while the PR stays ready (transition only)', () => {
  const prev: PrState = {
    ...cleanBaseline(),
    isDraft: false,
    ciChecks: { ci: 'success' },
    headSha: 'sha1',
  }
  const curr: PrState = {
    ...cleanBaseline(),
    isDraft: false,
    ciChecks: { ci: 'success' },
    headSha: 'sha1',
  }
  assert.equal(
    compareStates(prev, curr).some((c) => c.type === 'READY_FOR_REVIEW'),
    false
  )
})

// --- FLOW-175: latest-decision-per-author approval counting ---

const readyGreenClean = (reviews: PrState['reviews']): PrState => ({
  ...cleanBaseline(),
  isDraft: false,
  prState: 'OPEN',
  ciChecks: { ci: 'success' },
  unresolvedThreads: [],
  mergeStateStatus: 'CLEAN',
  mergeable: 'MERGEABLE',
  headSha: 'sha1',
  reviews,
})

// --- An unreadable thread list must not read as "no open threads" (FLOW-226) ---
//
// fetchUnresolvedThreads is the only fetcher whose failure is fail-OPEN. fetchCiChecks returns {},
// which fails `checks.length > 0`; fetchReviews returns [], which fails `approvals.length > 0`;
// but an empty thread list makes the no-open-threads term TRUE. The claim under test is the
// suppressed emission, not the flag.

const mergeReadyExcept = (overrides: Partial<PrState>): PrState => ({
  ...cleanBaseline(),
  isDraft: false,
  ciChecks: { ci: 'success' },
  reviews: [{ author: 'alice', authorType: 'User', state: 'APPROVED' }],
  mergeStateStatus: 'CLEAN',
  headSha: 'sha1',
  ...overrides,
})

const openThread: ReviewThread = { path: 'a.ts', line: 1, isResolved: false }

test('a failed thread fetch emits no MERGE_READY on a PR whose threads are still open (FLOW-226)', () => {
  // The last readable poll saw an open thread; this poll could not read the list at all, so it
  // carries the empty list a failure produces. Nothing resolved that thread in between.
  const previous = mergeReadyExcept({ isDraft: true, unresolvedThreads: [openThread] })
  const current = mergeReadyExcept({ unresolvedThreads: [], fetchFailed: true })
  assert.equal(
    compareStates(previous, current).some((c) => c.type === 'MERGE_READY'),
    false,
    'an unreadable thread list was reported as no open threads'
  )
})

test('a successful zero-thread fetch still emits MERGE_READY (FLOW-226 control)', () => {
  const previous = mergeReadyExcept({ isDraft: true, unresolvedThreads: [openThread] })
  const current = mergeReadyExcept({ unresolvedThreads: [], fetchFailed: false })
  assert.equal(
    compareStates(previous, current).some((c) => c.type === 'MERGE_READY'),
    true,
    'without this the suppression above proves only that MERGE_READY was broken outright'
  )
})

// The flag has to survive the store, not just the poll: isMergeReady runs on `previous` too, and
// `previous` is whatever loadState returns.
test('a failed thread fetch stays failed across the store round-trip (FLOW-226)', () => {
  withIsolatedStore('flow-226-fetch-failed-roundtrip', () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', mergeReadyExcept({ fetchFailed: true }))
    assert.equal(loadState('7', 'owner/repo')?.fetchFailed, true)

    const reloaded = loadState('7', 'owner/repo')
    assert.ok(reloaded)
    assert.equal(
      compareStates(reloaded, mergeReadyExcept({ fetchFailed: false })).some(
        (c) => c.type === 'MERGE_READY'
      ),
      true,
      'the first trustworthy read after a failure must still fire the edge'
    )
  })
})

// A legacy entry's empty thread list may be an unreadable fetch, and there is no way to tell now.
// Defaulting it to succeeded would let it read merge-ready as `previous` and swallow the next real
// MERGE_READY -- a suppressed true positive, which is silent. Defaulting it to failed can only
// cost one redundant emission of a statement that is true when it is made.
// Same rule as fetchFailed above, for the checks read: an entry written before the field existed
// carries a check set nothing recorded the completeness of, so it cannot be called green.
test('a stored entry predating ciChecksFetchFailed loads as failed (FLOW-226)', () => {
  withIsolatedStore('flow-226-ci-checks-failed-legacy', () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', mergeReadyExcept({ ciChecksFetchFailed: false }))

    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    const entry = raw.prs['owner/repo#7']
    assert.ok('ciChecksFetchFailed' in entry.state, 'setup: the field must be there to remove')
    delete entry.state.ciChecksFetchFailed
    writeFileSync(statePath(), JSON.stringify(raw))

    const loaded = loadState('7', 'owner/repo')
    assert.ok(loaded)
    assert.equal(loaded.ciChecksFetchFailed, true)
    assert.equal(
      compareStates({ ...loaded, isDraft: true }, loaded).some((c) => c.type === 'MERGE_READY'),
      false,
      'a legacy entry was reported as every check green'
    )
  })
})

// isCiGreenOnDraft is the second consumer of the green test and gates its own event, so it needs
// its own guard and its own proof — a fix to isMergeReady alone leaves this one reading truncated.
test('a draft with a truncated green checks read emits no CI_GREEN_ON_DRAFT (FLOW-226)', () => {
  const draft = (ciChecksFetchFailed: boolean): PrState => ({
    ...cleanBaseline(),
    isDraft: true,
    ciChecks: { build: 'success' },
    ciChecksFetchFailed,
    headSha: 'sha1',
  })
  const emits = (state: PrState): boolean =>
    compareStates({ ...state, ciChecks: {}, ciChecksFetchFailed: false }, state).some(
      (c) => c.type === 'CI_GREEN_ON_DRAFT'
    )

  assert.equal(emits(draft(false)), true, 'a complete green run on a draft must still emit')
  assert.equal(
    emits(draft(true)),
    false,
    'a truncated check set was reported as every check green on a draft'
  )
})

test('a stored entry predating fetchFailed loads as failed, not as a clean read (FLOW-226)', () => {
  withIsolatedStore('flow-226-fetch-failed-legacy', () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', mergeReadyExcept({ fetchFailed: false }))

    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    const entry = raw.prs['owner/repo#7']
    assert.ok('fetchFailed' in entry.state, 'setup: the field must be there before it is removed')
    delete entry.state.fetchFailed
    writeFileSync(statePath(), JSON.stringify(raw))

    assert.equal(loadState('7', 'owner/repo')?.fetchFailed, true)
  })
})

// Plants a state object the type system would reject, which is the point: the store is JSON on
// disk that a crash, a partial write or an older build can leave in any shape at all.
const plantRawState = (prNumber: string, rawState: unknown): void => {
  mkdirSync(storeDir(), { recursive: true })
  writeFileSync(
    statePath(),
    JSON.stringify({
      prs: { [`owner/repo#${prNumber}`]: { state: rawState, updatedAt: new Date().toISOString() } },
    })
  )
}

// `null` is the discriminating input, not `""`. Both are wrong shapes, but `""` reaches
// compareStates' own `.map` and throws there, and that throw absorbs the mutation: remove the
// guard and the test goes red on a TypeError without ever evaluating the merge decision, which
// leaves the collapse this test exists for unproven. `?? []` swallows `null` silently instead, so
// it survives every mechanism upstream and fails on the assertion itself.
test('a persisted thread list of null is told apart from a genuinely empty one (FLOW-226)', () => {
  withIsolatedStore('flow-226-thread-list-shape', () => {
    const ready = mergeReadyExcept({ unresolvedThreads: [], fetchFailed: false })

    plantRawState('7', ready)
    const genuinelyEmpty = loadState('7', 'owner/repo')
    assert.ok(genuinelyEmpty)
    const emptyEmits = compareStates(genuinelyEmpty, mergeReadyExcept({})).some(
      (c) => c.type === 'MERGE_READY'
    )

    plantRawState('7', { ...ready, unresolvedThreads: null })
    const wrongShape = loadState('7', 'owner/repo')
    assert.ok(wrongShape, 'a wrong-shaped field must not discard the entry')
    const wrongShapeEmits = compareStates(wrongShape, mergeReadyExcept({})).some(
      (c) => c.type === 'MERGE_READY'
    )

    // Asserted against the merge decision, not the normalizer's return value: `[]` is what BOTH
    // produce for the list itself, so the list cannot discriminate them.
    assert.equal(emptyEmits, false, 'a genuinely empty list must still read as merge-ready')
    assert.equal(
      wrongShapeEmits,
      true,
      'a thread list that could not be read was reported as no open threads'
    )
    assert.notEqual(
      wrongShapeEmits,
      emptyEmits,
      'the two states must not reach the merge decision as the same answer'
    )
  })
})

// The shapes `null` cannot cover: these reach a `.map`/`.filter` in compareStates, which poll.ts
// does not guard, so before the fix they crashed the poll rather than collapsing quietly. Asserted
// separately because their failure is a throw, and a throw cannot be told apart from the
// assertion above firing for its own reason.
test('a persisted thread list of the wrong type fails closed instead of throwing (FLOW-226)', () => {
  withIsolatedStore('flow-226-thread-list-throwing-shapes', () => {
    for (const shape of ['', { length: 0 }, {}, 0]) {
      plantRawState(
        '7',
        mergeReadyExcept({ fetchFailed: false, unresolvedThreads: shape as never })
      )
      const loaded = loadState('7', 'owner/repo')
      assert.ok(loaded, `a thread list of ${JSON.stringify(shape)} discarded the entry`)
      assert.equal(
        compareStates(loaded, mergeReadyExcept({})).some((c) => c.type === 'MERGE_READY'),
        true,
        `a thread list of ${JSON.stringify(shape)} was reported as no open threads`
      )
    }
  })
})

// botComments has no silent route: `null` normalizes to `[]` both before and after the fix, so
// the only observable difference is the throw a non-array used to cause in compareStates.
test('a persisted botComments of the wrong type does not throw in compareStates (FLOW-226)', () => {
  withIsolatedStore('flow-226-bot-comments-shape', () => {
    const newComment = { id: 'c1', author: 'bot', body: 'hi' }

    for (const shape of ['', [null], {}]) {
      plantRawState('7', mergeReadyExcept({ botComments: shape as never }))
      const loaded = loadState('7', 'owner/repo')
      assert.ok(loaded, `a botComments of ${JSON.stringify(shape)} discarded the entry`)
      const changes = compareStates(
        loaded,
        mergeReadyExcept({ botComments: [newComment] as never })
      )
      assert.equal(
        changes.some((c) => c.type === 'NEW_BOT_COMMENTS'),
        true,
        `a botComments of ${JSON.stringify(shape)} lost the new bot comment`
      )
    }
  })
})

// normalizeState runs inside loadStore's try, whose catch returns an empty store. A `.map` over a
// wrong shape therefore throws where nothing reports it, and the entry that is discarded is every
// entry -- including PRs whose own state was written perfectly.
test("one PR's malformed reviews does not discard another PR's persisted state (FLOW-226)", () => {
  withIsolatedStore('flow-226-normalize-blast-radius', () => {
    mkdirSync(storeDir(), { recursive: true })
    const now = new Date().toISOString()
    writeFileSync(
      statePath(),
      JSON.stringify({
        prs: {
          'owner/repo#7': { state: mergeReadyExcept({ headSha: 'intact' }), updatedAt: now },
          'owner/repo#8': { state: { ...mergeReadyExcept({}), reviews: '' }, updatedAt: now },
        },
      })
    )

    assert.equal(
      loadState('7', 'owner/repo')?.headSha,
      'intact',
      'a malformed neighbour discarded the state of a PR that was written correctly'
    )
    assert.ok(loadState('8', 'owner/repo'), 'the malformed entry itself must survive too')
  })
})

// Object.values(['success']) is ['success'], so an array where a record belongs satisfies
// `every(s => s === 'success')` and reads as a full green CI run.
test('a persisted ciChecks array does not read as every check green (FLOW-226)', () => {
  withIsolatedStore('flow-226-cichecks-shape', () => {
    plantRawState('7', { ...mergeReadyExcept({}), ciChecks: ['success'] })
    const loaded = loadState('7', 'owner/repo')
    assert.ok(loaded)
    assert.equal(
      compareStates(loaded, mergeReadyExcept({})).some((c) => c.type === 'MERGE_READY'),
      true,
      'an array of status strings was accepted as the set of CI checks'
    )
  })
})

// The ternary's own consumer. `ciChecksFetchFailed` gates the merge decision, but the per-check
// diffing below it reads `Object.entries(current.ciChecks)` regardless of the flag, and an array
// there yields one entry per index -- check names "0" and "1" with no run behind them.
test('a persisted ciChecks array is normalized away, not kept by index (FLOW-226)', () => {
  withIsolatedStore('flow-226-cichecks-normalized', () => {
    plantRawState('7', { ...mergeReadyExcept({}), ciChecks: ['success', 'failure'] })
    const loaded = loadState('7', 'owner/repo')
    assert.ok(loaded)
    assert.deepEqual(
      Object.keys(loaded.ciChecks),
      [],
      'an array survived normalization, so its indices became CI check names'
    )
  })
})

// A non-array object with a non-string value (e.g. a boolean or number) passed the old shape check
// too -- it only excluded arrays, never checked what the values inside actually were.
test('a persisted ciChecks with a non-string value is normalized away, not kept as-is (FLOW-226)', () => {
  withIsolatedStore('flow-226-cichecks-value-shape', () => {
    plantRawState('7', {
      ...mergeReadyExcept({}),
      ciChecksFetchFailed: false,
      ciChecks: { build: 200 },
    })
    const loaded = loadState('7', 'owner/repo')
    assert.ok(loaded)
    assert.deepEqual(loaded.ciChecks, {}, 'a non-string check value survived normalization')
    assert.equal(
      loaded.ciChecksFetchFailed,
      true,
      'a wrong-shaped ciChecks did not force ciChecksFetchFailed'
    )
  })
})

// `??` fires only on null and undefined, so a falsy NON-boolean in the store file passes straight
// through: `!(0 ?? true)` is `true`, and a corrupted `fetchFailed` then reads as "the fetch
// succeeded" over the empty thread list a failed fetch leaves behind.
const assertFalsyFieldNormalizes = (
  sessionId: string,
  field: 'fetchFailed' | 'isDraft' | 'coderabbitSkipped' | 'ciGreenOnDraftFired',
  saved: PrState,
  expected: boolean
): void => {
  withIsolatedStore(sessionId, () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', saved)

    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    const entry = raw.prs['owner/repo#7']
    assert.ok(field in entry.state, `setup: ${field} must be present before it is corrupted`)
    entry.state[field] = 0
    writeFileSync(statePath(), JSON.stringify(raw))
    assert.equal(
      JSON.parse(readFileSync(statePath(), 'utf8')).prs['owner/repo#7'].state[field],
      0,
      `setup: ${field} must read back as 0 from the store file before the reload`
    )

    const loaded = loadState('7', 'owner/repo')
    assert.ok(
      loaded,
      'the corrupted entry must still load, or the assertion below passes vacuously'
    )
    assert.equal(
      loaded.headSha,
      saved.headSha,
      'the loaded entry must be the planted one, not a fresh baseline'
    )
    assert.equal(
      loaded[field],
      expected,
      `${field} came back as ${JSON.stringify(loaded[field])}; a persisted 0 must normalize to ${expected}`
    )
  })
}

test('a persisted fetchFailed of 0 loads as failed, not as a clean read (FLOW-226)', () => {
  assertFalsyFieldNormalizes(
    'flow-226-falsy-fetch-failed',
    'fetchFailed',
    mergeReadyExcept({ fetchFailed: false }),
    true
  )
})

test('a persisted isDraft of 0 loads as a draft, not as ready for review (FLOW-226)', () => {
  assertFalsyFieldNormalizes(
    'flow-226-falsy-is-draft',
    'isDraft',
    mergeReadyExcept({ isDraft: false }),
    true
  )
})

test('a persisted coderabbitSkipped of 0 loads as not skipped (FLOW-226)', () => {
  assertFalsyFieldNormalizes(
    'flow-226-falsy-coderabbit-skipped',
    'coderabbitSkipped',
    mergeReadyExcept({ coderabbitSkipped: true }),
    false
  )
})

// `??` fires only on null and undefined, so a wrong-TYPE non-boolean value in the store file
// passes straight through unlike the booleanOr fields above: a numeric headSha survives into
// `.slice(0, 7)` (compareStates) and a string throttle count survives into `+ 1` (recordCoderabbitRun).
test('a persisted headSha of the wrong type normalizes to empty, not passed through (FLOW-226)', () => {
  withIsolatedStore('flow-226-headsha-wrong-shape', () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', mergeReadyExcept({ headSha: 'sha1' }))

    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    raw.prs['owner/repo#7'].state.headSha = 12345
    writeFileSync(statePath(), JSON.stringify(raw))

    const loaded = loadState('7', 'owner/repo')
    assert.ok(loaded, 'the corrupted entry must still load')
    assert.equal(typeof loaded.headSha, 'string', 'a non-string headSha must normalize to a string')
    assert.equal(loaded.headSha, '', 'a wrong-typed headSha falls back to empty, not the raw value')
  })
})

test('a persisted coderabbitThrottleCount of the wrong type normalizes to 0, not passed through (FLOW-226)', () => {
  withIsolatedStore('flow-226-throttle-wrong-shape', () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', mergeReadyExcept({ coderabbitThrottleCount: 3, headSha: 'sha1' }))

    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    raw.prs['owner/repo#7'].state.coderabbitThrottleCount = 'not-a-number'
    writeFileSync(statePath(), JSON.stringify(raw))

    const loaded = loadState('7', 'owner/repo')
    assert.ok(loaded, 'the corrupted entry must still load')
    assert.equal(
      typeof loaded.coderabbitThrottleCount,
      'number',
      'a non-number throttle count must normalize to a number'
    )
    assert.equal(loaded.coderabbitThrottleCount, 0, 'a wrong-typed count falls back to 0')
  })
})

test('a persisted ciGreenOnDraftFired of 0 loads as not fired (FLOW-226)', () => {
  assertFalsyFieldNormalizes(
    'flow-226-falsy-ci-green-fired',
    'ciGreenOnDraftFired',
    mergeReadyExcept({ ciGreenOnDraftFired: true }),
    false
  )
})

// Previous poll: a draft (so isMergeReady(previous) is false and a MERGE_READY transition
// is possible).
const draftPrevious: PrState = { ...cleanBaseline(), isDraft: true, headSha: 'sha1' }

// The founding defect's end state, reached through the store rather than asserted on a field.
const assertMergeReadyAfterPlantedFetchFailed = (
  sessionId: string,
  onDisk: unknown,
  expected: boolean
): void => {
  withIsolatedStore(sessionId, () => {
    mkdirSync(storeDir(), { recursive: true })
    saveState('7', 'owner/repo', mergeReadyExcept({ fetchFailed: false }))

    const raw = JSON.parse(readFileSync(statePath(), 'utf8'))
    raw.prs['owner/repo#7'].state.fetchFailed = onDisk
    writeFileSync(statePath(), JSON.stringify(raw))

    const loaded = loadState('7', 'owner/repo')
    assert.ok(loaded, 'the planted entry must load, or the assertion below passes vacuously')
    assert.equal(
      compareStates(draftPrevious, loaded).some((c) => c.type === 'MERGE_READY'),
      expected,
      `a persisted fetchFailed of ${JSON.stringify(onDisk)} reached the wrong MERGE_READY verdict`
    )
  })
}

test('a persisted fetchFailed of 0 keeps MERGE_READY from firing (FLOW-226)', () => {
  assertMergeReadyAfterPlantedFetchFailed('flow-226-merge-ready-falsy', 0, false)
})

// Positive control for the test above: the identical entry carrying a real `false` does reach
// MERGE_READY, so the suppression is the corrupted value and not a fixture that never qualified.
test('a persisted fetchFailed of false still reaches MERGE_READY (FLOW-226)', () => {
  assertMergeReadyAfterPlantedFetchFailed('flow-226-merge-ready-boolean', false, true)
})

test('MERGE_READY fires when the sole reviewer APPROVED then COMMENTED (FLOW-175)', () => {
  const curr = readyGreenClean([
    { author: 'coderabbitai', authorType: 'Bot', state: 'APPROVED' },
    { author: 'coderabbitai', authorType: 'Bot', state: 'COMMENTED' },
  ])
  assert.equal(
    compareStates(draftPrevious, curr).some((c) => c.type === 'MERGE_READY'),
    true
  )
})

test('a trailing CHANGES_REQUESTED after APPROVED is not merge-ready', () => {
  const curr = readyGreenClean([
    { author: 'alice', authorType: 'User', state: 'APPROVED' },
    { author: 'alice', authorType: 'User', state: 'CHANGES_REQUESTED' },
  ])
  assert.equal(
    compareStates(draftPrevious, curr).some((c) => c.type === 'MERGE_READY'),
    false
  )
})

test('the latest decision wins: CHANGES_REQUESTED then APPROVED then COMMENTED is approved', () => {
  const curr = readyGreenClean([
    { author: 'alice', authorType: 'User', state: 'CHANGES_REQUESTED' },
    { author: 'alice', authorType: 'User', state: 'APPROVED' },
    { author: 'alice', authorType: 'User', state: 'COMMENTED' },
  ])
  assert.equal(
    compareStates(draftPrevious, curr).some((c) => c.type === 'MERGE_READY'),
    true
  )
})

test('a DISMISSED review after APPROVED is not merge-ready', () => {
  const curr = readyGreenClean([
    { author: 'alice', authorType: 'User', state: 'APPROVED' },
    { author: 'alice', authorType: 'User', state: 'DISMISSED' },
  ])
  assert.equal(
    compareStates(draftPrevious, curr).some((c) => c.type === 'MERGE_READY'),
    false
  )
})

test('MERGE_READY counts APPROVED-then-COMMENTED as a standing approval, not a retracted one', () => {
  const previous = cleanBaseline()
  const current: PrState = {
    ...cleanBaseline(),
    isDraft: false,
    ciChecks: { build: 'success' },
    reviews: [
      { author: 'coderabbitai', authorType: 'Bot', state: 'APPROVED' },
      { author: 'coderabbitai', authorType: 'Bot', state: 'COMMENTED' },
    ],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
  }
  const changes = compareStates(previous, current)
  assert.ok(changes.some((c) => c.type === 'MERGE_READY'))
})

test('MERGE_READY does not fire when the latest decision requests changes', () => {
  const previous = cleanBaseline()
  const current: PrState = {
    ...cleanBaseline(),
    isDraft: false,
    ciChecks: { build: 'success' },
    reviews: [
      { author: 'reviewer', authorType: 'User', state: 'APPROVED' },
      { author: 'reviewer', authorType: 'User', state: 'CHANGES_REQUESTED' },
    ],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
  }
  const changes = compareStates(previous, current)
  assert.ok(!changes.some((c) => c.type === 'MERGE_READY'))
})

test('a standing CHANGES_REQUESTED from another author blocks merge readiness (FLOW-175)', () => {
  const curr = readyGreenClean([
    { author: 'alice', authorType: 'User', state: 'APPROVED' },
    { author: 'bob', authorType: 'User', state: 'CHANGES_REQUESTED' },
  ])
  assert.equal(
    compareStates(draftPrevious, curr).some((c) => c.type === 'MERGE_READY'),
    false
  )
})

// --- FLOW-261: a pre-upgrade store must still load ---

test('a store entry written by the pre-FLOW-261 version (carrying `quiet`) still loads', () => {
  // FLOW-261 dropped QuietClock from StoreEntry. A monitor upgrading in place reads a file its
  // previous version wrote, so the reader must tolerate the dropped field rather than reject the
  // file — rejecting it would fall back to cleanBaseline() and re-emit every transition already
  // seen, which is the exact wake this story removes.
  const originalHome = process.env.HOME
  const originalSession = process.env.CLAUDE_CODE_SESSION_ID
  const homeDir = mkdtempSync(join(tmpdir(), 'flow261-'))
  process.env.HOME = homeDir
  process.env.CLAUDE_CODE_SESSION_ID = 'flow-261-legacy-store-test'
  try {
    const legacy = {
      prs: {
        'owner/repo#7': {
          state: { prState: 'OPEN', isDraft: true, headSha: 'abc123' },
          updatedAt: new Date().toISOString(),
          quiet: {
            fingerprint: 'deadbeef',
            stableSince: new Date().toISOString(),
            stallFired: true,
          },
        },
      },
    }
    atomicWrite(statePath(), JSON.stringify(legacy))
    const loaded = loadState('7', 'owner/repo')
    assert.ok(loaded)
    assert.equal(loaded?.headSha, 'abc123')
    assert.equal(loaded?.prState, 'OPEN')
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = originalSession
  }
})

// --- FLOW-261: suppress self-posted review threads ---

test('a thread whose first comment this session posted does not emit NEW_THREADS', () => {
  const previous: PrState = { ...cleanBaseline(), unresolvedThreads: [] }
  const current: PrState = {
    ...cleanBaseline(),
    unresolvedThreads: [
      {
        path: 'src/a.ts',
        line: 10,
        isResolved: false,
        firstCommentBody: 'claude says: fixed in 1234567.',
        firstCommentId: 'PRRC_self',
      },
    ],
  }
  const changes = compareStates(previous, current, ['PRRC_self'])
  assert.ok(!changes.some((c) => c.type === 'NEW_THREADS'))
})

test('a thread from any other participant still emits NEW_THREADS while a self-reply is suppressed', () => {
  const previous: PrState = { ...cleanBaseline(), unresolvedThreads: [] }
  const current: PrState = {
    ...cleanBaseline(),
    unresolvedThreads: [
      {
        path: 'src/a.ts',
        line: 10,
        isResolved: false,
        firstCommentBody: 'mine',
        firstCommentId: 'PRRC_self',
      },
      {
        path: 'src/b.ts',
        line: 20,
        isResolved: false,
        firstCommentBody: 'theirs',
        firstCommentId: 'PRRC_other',
      },
    ],
  }
  const changes = compareStates(previous, current, ['PRRC_self'])
  const newThreads = changes.filter((c) => c.type === 'NEW_THREADS')
  assert.equal(newThreads.length, 1)
  assert.match(newThreads[0].detail, /src\/b\.ts/)
  assert.doesNotMatch(newThreads[0].detail, /src\/a\.ts/)
  assert.match(newThreads[0].detail, /1 new unresolved review thread/)
})

test('a thread with no recorded id still emits — suppression is opt-in per comment, never a default', () => {
  const previous: PrState = { ...cleanBaseline(), unresolvedThreads: [] }
  const current: PrState = {
    ...cleanBaseline(),
    unresolvedThreads: [
      {
        path: 'src/a.ts',
        line: 10,
        isResolved: false,
        firstCommentBody: 'finding',
        firstCommentId: '',
      },
    ],
  }
  const changes = compareStates(previous, current, ['PRRC_self'])
  assert.ok(changes.some((c) => c.type === 'NEW_THREADS'))
})

test('compareStates reports a new main comment and suppresses one this session posted', () => {
  const previous = { ...cleanBaseline(), isDraft: false }
  const current = {
    ...cleanBaseline(),
    isDraft: false,
    mainComments: [
      { id: 'IC_theirs', author: 'octo-reviewer' },
      { id: 'IC_mine', author: 'octo-reviewer' },
      { id: 'PRR_mine', author: 'octo-reviewer' },
    ],
  }
  const types = compareStates(previous, current, ['IC_mine', 'PRR_mine']).map((c) => c.type)
  assert.deepEqual(types, ['new-main-comments'])
  const detail = compareStates(previous, current, ['IC_mine', 'PRR_mine']).find(
    (c) => c.type === 'new-main-comments'
  )?.detail
  assert.equal(detail, '1 new main review comment from: octo-reviewer')
})

test('a thread opened by another participant that this session later replied into still emits — only the first comment identifies the thread', () => {
  const previous: PrState = { ...cleanBaseline(), unresolvedThreads: [] }
  const rawThreads = toReviewThreads([
    {
      isResolved: false,
      path: 'src/a.ts',
      line: 10,
      comments: {
        nodes: [
          { id: 'PRRC_other', author: { login: 'reviewer' }, body: 'theirs' },
          { id: 'PRRC_self', author: { login: 'octo-reviewer' }, body: 'claude says: fixed' },
        ],
      },
    },
  ])
  assert.equal(rawThreads[0].firstCommentId, 'PRRC_other')
  const current: PrState = { ...cleanBaseline(), unresolvedThreads: rawThreads }
  const changes = compareStates(previous, current, ['PRRC_self'])
  assert.ok(changes.some((c) => c.type === 'NEW_THREADS'))
})

const withIsolatedStore = (sessionId: string, fn: () => void): void => {
  const originalHome = process.env.HOME
  const originalSession = process.env.CLAUDE_CODE_SESSION_ID
  const homeDir = mkdtempSync(join(tmpdir(), 'flow261-selfcomments-'))
  process.env.HOME = homeDir
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  try {
    fn()
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = originalSession
  }
}

test('readStoreRaw: a code that does not confirm existence is not reported as "exists" (FLOW-226 finding 582cd68b4540)', () => {
  withIsolatedStore('flow-226-readstoreraw-existence', () => {
    // A file where the store's own directory belongs, rather than at state.json itself: readFileSync
    // fails resolving that path component before state.json is ever reached, so the failure is
    // ENOTDIR — a code that says nothing about whether the store exists.
    mkdirSync(join(storeDir(), '..'), { recursive: true })
    writeFileSync(storeDir(), '')
    assert.throws(
      () => readFileSync(statePath(), 'utf-8'),
      /ENOTDIR/,
      'precondition: the fixture must actually block traversal, or this test observes nothing'
    )

    const originalConsoleError = console.error
    const errors: unknown[] = []
    console.error = (...args: unknown[]) => {
      errors.push(args[0])
    }
    try {
      assert.doesNotThrow(() => loadState('7', 'owner/repo'))
    } finally {
      console.error = originalConsoleError
    }

    const message = errors.find((msg) => typeof msg === 'string') as string | undefined
    assert.ok(message, 'expected a diagnostic for the unreadable store')
    assert.match(message, /could not be confirmed to exist or be read \(ENOTDIR\)/)
    assert.doesNotMatch(message, /^pr-monitor: state store exists/)
  })
})

test('recordSelfComment persists across a store reload and is idempotent per id', () => {
  withIsolatedStore('flow-261-record-persist', () => {
    recordSelfComment('7', 'owner/repo', 'PRRC_a')
    recordSelfComment('7', 'owner/repo', 'PRRC_a')
    recordSelfComment('7', 'owner/repo', 'PRRC_b')
    assert.deepEqual(loadSelfCommentIds('7', 'owner/repo'), ['PRRC_a', 'PRRC_b'])
  })
})

test('recordSelfComment before any poll does not fabricate a PR baseline', () => {
  withIsolatedStore('flow-261-record-no-baseline', () => {
    recordSelfComment('7', 'owner/repo', 'PRRC_a')
    assert.equal(loadState('7', 'owner/repo'), null)
  })
})

test('deleteState drops the self-comment ids with the PR entry', () => {
  withIsolatedStore('flow-261-delete-drops-ids', () => {
    saveState('7', 'owner/repo', cleanBaseline())
    recordSelfComment('7', 'owner/repo', 'PRRC_a')
    deleteState('7', 'owner/repo')
    assert.deepEqual(loadSelfCommentIds('7', 'owner/repo'), [])
  })
})

test('saveState on a no-change poll cycle does not drop previously recorded self-comment ids', () => {
  withIsolatedStore('flow-261-savestate-preserves-ids', () => {
    recordSelfComment('7', 'owner/repo', 'PRRC_a')
    saveState('7', 'owner/repo', cleanBaseline())
    assert.deepEqual(loadSelfCommentIds('7', 'owner/repo'), ['PRRC_a'])
  })
})

test('a store lock naming a dead pid is reclaimed immediately, not after the staleness window (FLOW-261 round 4 finding e7dec286ee42)', () => {
  withIsolatedStore('flow-261-lock-dead-pid', () => {
    mkdirSync(storeDir(), { recursive: true })
    const lockPath = storeLockPath()
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999_999, acquiredAt: new Date().toISOString() })
    )
    assert.ok(
      existsSync(storeLockPath()),
      'setup: the planted dead-pid lock must exist at the real store lock path before the reclaim'
    )

    saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'reclaimed-dead-pid' })

    assert.equal(loadState('7', 'owner/repo')?.headSha, 'reclaimed-dead-pid')
    const surviving = existsSync(storeLockPath()) ? readFileSync(storeLockPath(), 'utf8') : null
    assert.equal(
      surviving,
      null,
      `a dead pid must not read as a live holder; the lock file survived holding ${surviving}`
    )
  })
})

test('a store lock with an unparseable acquiredAt is reclaimed, not held forever (FLOW-261 round 4 finding 6ad03bea3071)', () => {
  withIsolatedStore('flow-261-lock-bad-date', () => {
    mkdirSync(storeDir(), { recursive: true })
    const lockPath = storeLockPath()
    // pid 1, not process.pid: on the held-forever path the lock is never acquired, so
    // releaseStoreLock's ownership check decides whether the file survives — our own pid would
    // make it remove the planted file there too and the assertion below would hold either way.
    writeFileSync(lockPath, JSON.stringify({ pid: 1, acquiredAt: 'not-a-date' }))
    assert.ok(
      existsSync(storeLockPath()),
      'setup: the planted unparseable-date lock must exist at the real store lock path before the reclaim'
    )

    saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'reclaimed-bad-date' })

    assert.equal(loadState('7', 'owner/repo')?.headSha, 'reclaimed-bad-date')
    const surviving = existsSync(storeLockPath()) ? readFileSync(storeLockPath(), 'utf8') : null
    assert.equal(
      surviving,
      null,
      `an unparseable acquiredAt must not hold the lock; the lock file survived holding ${surviving}`
    )
  })
})

test("exhausting the store lock wait budget on a live foreign holder degrades instead of crashing the monitor, and never deletes that holder's lock (FLOW-261 round 4 findings f4ee53151a78, d71fee5b5489)", () => {
  withIsolatedStore('flow-261-lock-degrade', () => {
    mkdirSync(storeDir(), { recursive: true })
    const lockPath = storeLockPath()
    const foreignPid = process.ppid
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: foreignPid, acquiredAt: new Date().toISOString() })
    )
    const originalConsoleError = console.error
    const errors: unknown[] = []
    console.error = (...args: unknown[]) => {
      errors.push(args[0])
    }
    try {
      assert.doesNotThrow(() =>
        saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'degraded-write' })
      )
    } finally {
      console.error = originalConsoleError
    }
    assert.ok(
      errors.some(
        (msg) => typeof msg === 'string' && msg.includes('could not acquire the store write lock')
      ),
      'expected a diagnostic instead of a thrown error'
    )
    assert.equal(loadState('7', 'owner/repo')?.headSha, 'degraded-write')
    const survivingLock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number }
    assert.equal(
      survivingLock.pid,
      foreignPid,
      "releaseStoreLock must never delete a lock it doesn't own"
    )
  })
})

test('a live holder with a calendar-invalid acquiredAt is degraded around, not reclaimed (FLOW-226 finding 7fa1fa3e7d27)', () => {
  withIsolatedStore('flow-226-lock-nan-age', () => {
    mkdirSync(storeDir(), { recursive: true })
    const lockPath = storeLockPath()
    const foreignPid = process.ppid
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: foreignPid, acquiredAt: '2024-13-01T00:00:00.000Z' })
    )
    const originalConsoleError = console.error
    const errors: unknown[] = []
    console.error = (...args: unknown[]) => {
      errors.push(args[0])
    }
    try {
      assert.doesNotThrow(() =>
        saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'nan-age-degraded-write' })
      )
    } finally {
      console.error = originalConsoleError
    }
    assert.ok(
      errors.some(
        (msg) => typeof msg === 'string' && msg.includes('could not acquire the store write lock')
      ),
      'expected a diagnostic instead of a thrown error'
    )
    assert.equal(loadState('7', 'owner/repo')?.headSha, 'nan-age-degraded-write')
    const survivingLock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number }
    assert.equal(
      survivingLock.pid,
      foreignPid,
      'a live holder with an unparseable-but-shape-valid acquiredAt must not have its lock stolen'
    )
  })
})

test('releaseStoreLock never deletes a lock it could not read well enough to identify as its own (FLOW-261 round 5 finding 849f8457bd67)', () => {
  withIsolatedStore('flow-261-lock-release-null-branch', () => {
    mkdirSync(storeDir(), { recursive: true })
    const lockPath = storeLockPath()
    const foreignPid = process.ppid
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: foreignPid, acquiredAt: new Date().toISOString() })
    )

    // Replaces the still-present foreign lock with unparseable content the instant acquireStoreLock
    // gives up on it and degrades — console.error is the last statement degradeStoreLockAcquire runs
    // before returning, so this lands deterministically between "acquire gave up" and "this call's
    // own release() runs," with no timing race: readStoreLockData will return null for it exactly as
    // it would for a lock this process genuinely could not parse.
    const garbageLockContent = 'not valid json — simulating an unparseable foreign lock'
    const originalConsoleError = console.error
    console.error = () => {
      writeFileSync(lockPath, garbageLockContent)
    }
    try {
      saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'release-null-branch' })
    } finally {
      console.error = originalConsoleError
    }

    assert.equal(loadState('7', 'owner/repo')?.headSha, 'release-null-branch')
    assert.equal(
      readFileSync(lockPath, 'utf-8'),
      garbageLockContent,
      "releaseStoreLock must never delete a lock it doesn't own"
    )
  })
})

test('an abandoned store lock temp file older than the staleness window is reaped on the next acquire', () => {
  withIsolatedStore('flow-261-lock-reap', () => {
    mkdirSync(storeDir(), { recursive: true })
    const lockPath = storeLockPath()
    const abandonedTemp = `${lockPath}.999999.0.tmp`
    writeFileSync(abandonedTemp, JSON.stringify({ pid: 999_999_999, acquiredAt: 'irrelevant' }))
    const old = new Date(Date.now() - 40_000)
    utimesSync(abandonedTemp, old, old)

    saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'reap-check' })

    assert.equal(loadState('7', 'owner/repo')?.headSha, 'reap-check')
    assert.ok(
      !existsSync(abandonedTemp),
      'an abandoned temp file past the staleness window must be reaped, not left to litter the store dir'
    )
    assert.deepEqual(
      readdirSync(storeDir()).filter((name) => name.endsWith('.tmp')),
      [],
      'no other temp file should remain either'
    )
  })
})

// recordSelfComment (the --ack-comment process) and saveState (the poller's every-cycle write) each
// do a whole-store read-modify-write in a SEPARATE os process, with no shared call stack — a
// single-process test cannot exercise the interleaving a lost update needs. Real child processes,
// barrier-synchronized like lock.race-child.ts's mandatory multi-process test, are required.
const storeRaceChild = join(import.meta.dirname, 'test', 'store-race-child.ts')

// Deadline for the parent-side readiness barrier below — bounds only the wait BEFORE GO is
// broadcast. What bounds the race itself after GO is the store lock's bounded retry-then-degrade
// loop (STORE_LOCK_MAX_ATTEMPTS/STORE_LOCK_RETRY_DELAY_MS in state.ts), not this constant.
const READY_BARRIER_TIMEOUT_MS = 5000

// Backstop for tests that await their spawned child directly, with no readiness barrier of their
// own to bound the wait if the child process never completes — a stalled module load, a `close`
// that never fires — regardless of what its own internal logic would otherwise do.
const SPAWN_TIMEOUT_BACKSTOP_MS = 5000

// Surfaces exit code, signal, stdout, and stderr to the caller instead of picking a pass/fail
// verdict itself — mirroring lock.test.ts's runLockRaceChild — so each test asserts what its own
// scenario requires and can isolate HOME/CLAUDE_CODE_SESSION_ID per call. Listens on 'close', not
// 'exit': stdio can still be open when 'exit' fires, and stderr content is load-bearing here.
const runStoreRaceChild = (
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs?: number
): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', storeRaceChild, ...args],
      { env, ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }) }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout: stdout.trim(), stderr }))
  })

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('recordSelfComment run concurrently with saveState across repeated real cross-process races never loses the recorded id (FLOW-261 finding 226a2a5d12a8)', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'flow261-store-race-'))
  const originalHome = process.env.HOME
  const originalSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.HOME = homeDir
  process.env.CLAUDE_CODE_SESSION_ID = 'flow-261-store-race'
  const TRIALS = 20
  try {
    for (let trial = 0; trial < TRIALS; trial++) {
      const commentId = `PRRC_race_${trial}`
      const barrierDir = mkdtempSync(join(tmpdir(), 'flow261-store-race-barrier-'))
      const goPath = join(barrierDir, 'go')
      const readyRecord = join(barrierDir, 'ready.record')
      const readySave = join(barrierDir, 'ready.save')
      try {
        const recordPromise = runStoreRaceChild([
          'record',
          '7',
          'owner/repo',
          commentId,
          readyRecord,
          goPath,
        ])
        const savePromise = runStoreRaceChild([
          'save',
          '7',
          'owner/repo',
          `sha-${trial}`,
          readySave,
          goPath,
        ])

        // Genuine readiness barrier (not a wall-clock guess): wait until both children have
        // signalled ready before broadcasting GO, so both reach their racy call at (as close as
        // possible to) the same instant.
        const deadline = Date.now() + READY_BARRIER_TIMEOUT_MS
        while ((!existsSync(readyRecord) || !existsSync(readySave)) && Date.now() < deadline) {
          await sleepMs(5)
        }
        assert.ok(
          existsSync(readyRecord) && existsSync(readySave),
          'precondition: both children signalled ready before GO'
        )
        writeFileSync(goPath, '')

        const [recordResult, saveResult] = await Promise.all([recordPromise, savePromise])
        assert.equal(recordResult.code, 0, `record child failed: ${recordResult.stderr}`)
        assert.equal(saveResult.code, 0, `save child failed: ${saveResult.stderr}`)
      } finally {
        rmSync(barrierDir, { recursive: true, force: true })
      }

      assert.ok(
        loadSelfCommentIds('7', 'owner/repo').includes(commentId),
        `trial ${trial}: recorded id ${commentId} was lost to a concurrent saveState write`
      )
      // The lock's correctness cuts both ways: asserting only the recordSelfComment side would
      // pass a lock that let recordSelfComment win every race and silently dropped saveState's
      // write — itself a lost update of the same class this test exists to catch.
      assert.equal(
        loadState('7', 'owner/repo')?.headSha,
        `sha-${trial}`,
        `trial ${trial}: saveState's headSha write was lost to a concurrent recordSelfComment write`
      )
    }
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = originalSession
  }
})

test('store-race-child exits non-zero with a diagnostic when GO never arrives (FLOW-261 finding d9bc082eaab8)', async () => {
  const barrierDir = mkdtempSync(join(tmpdir(), 'flow261-store-race-timeout-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'flow261-store-race-timeout-home-'))
  const readyPath = join(barrierDir, 'ready')
  const goPath = join(barrierDir, 'go') // deliberately never written
  const originalHome = process.env.HOME
  const originalSession = process.env.CLAUDE_CODE_SESSION_ID
  try {
    const { code, signal, stderr } = await runStoreRaceChild(
      ['record', '7', 'owner/repo', 'unused', readyPath, goPath],
      {
        ...process.env,
        HOME: homeDir,
        CLAUDE_CODE_SESSION_ID: 'flow-261-store-race-timeout',
        RACE_CHILD_GO_TIMEOUT_MS: '300',
      },
      SPAWN_TIMEOUT_BACKSTOP_MS
    )
    assert.ok(
      existsSync(readyPath),
      'precondition: the child reached READY before it started waiting'
    )
    assert.notEqual(signal, 'SIGTERM', 'the child must exit rather than stall, for any reason')
    assert.notEqual(code, 0, 'a child that never sees GO must exit non-zero, not hang or exit 0')
    assert.match(
      stderr,
      /store-race-child: timed out after 300ms waiting for GO at/,
      'the diagnostic must name the timeout'
    )
    assert.ok(
      stderr.includes(goPath),
      'the diagnostic must name the specific goPath that never appeared'
    )
    // store-race-child never writes stdout, so asserting it here would prove nothing; the store
    // file's absence is the real observable — it exists only once writeStore's atomicWrite has run,
    // so its absence proves recordSelfComment was never called, not just that the process exited.
    process.env.HOME = homeDir
    process.env.CLAUDE_CODE_SESSION_ID = 'flow-261-store-race-timeout'
    assert.ok(
      !existsSync(statePath()),
      'a child that never sees GO must never call recordSelfComment'
    )
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = originalSession
    rmSync(barrierDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('store-race-child exits non-zero with a diagnostic when RACE_CHILD_GO_TIMEOUT_MS is empty (FLOW-261 finding 2a448a7102e5)', async () => {
  const barrierDir = mkdtempSync(join(tmpdir(), 'flow261-store-race-badtimeout-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'flow261-store-race-badtimeout-home-'))
  const readyPath = join(barrierDir, 'ready')
  const goPath = join(barrierDir, 'go')
  // Written before the child spawns: if a regression narrows or removes the guard, the child falls
  // straight through the barrier to a real recordSelfComment call — HOME below is isolated so that
  // fallthrough can never touch the operator's real store, and a broken guard is still caught by
  // the exit-code assertion below rather than only by the spawn timeout backstop.
  writeFileSync(goPath, '')
  try {
    const { code, signal, stderr } = await runStoreRaceChild(
      ['record', '7', 'owner/repo', 'unused', readyPath, goPath],
      {
        ...process.env,
        HOME: homeDir,
        CLAUDE_CODE_SESSION_ID: 'flow-261-store-race-badtimeout',
        RACE_CHILD_GO_TIMEOUT_MS: '',
      },
      SPAWN_TIMEOUT_BACKSTOP_MS
    )
    assert.notEqual(signal, 'SIGTERM', 'the child must exit rather than stall, for any reason')
    assert.notEqual(
      code,
      0,
      'an empty RACE_CHILD_GO_TIMEOUT_MS must exit non-zero, not silently default to an unbounded wait'
    )
    assert.match(
      stderr,
      /RACE_CHILD_GO_TIMEOUT_MS must be a positive integer string, got ""/,
      'the diagnostic must name the variable and the empty value received'
    )
    assert.ok(
      !existsSync(readyPath),
      'a malformed timeout must be rejected before the child ever signals READY'
    )
  } finally {
    rmSync(barrierDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  }
})

// --- Store lock shape validation (FLOW-226) ---
//
// Each case asserts the lock file is GONE, not that the write landed: acquireStoreLock degrades to
// an unlocked write rather than failing, so a lock wrongly read as live still produces a successful
// saveState either way. The file's fate is what discriminates. Reclaimed, it is stolen by rename,
// re-created naming this process, and removed by releaseStoreLock's ownership check on the way out.
// Wrongly read as live, it is never acquired, so that same ownership check does not match and the
// planted row is still there afterwards.
//
// Every fixture therefore plants a FOREIGN pid. A planted `process.pid` would satisfy the ownership
// check on the degrade path too, removing the file on both paths and making the assertion vacuous.
//
// The control for all three is the existing live-foreign-holder degrade case above, whose fixture
// is a valid pid with a valid ISO acquiredAt: it must keep its lock file. A validator that rejected
// everything would reclaim there too, and that test would fail.

test('a store lock naming pid 0 is reclaimed, not read as a live process group (FLOW-226)', () => {
  withIsolatedStore('flow-226-store-lock-pid-zero', () => {
    mkdirSync(storeDir(), { recursive: true })
    writeFileSync(storeLockPath(), JSON.stringify({ pid: 0, acquiredAt: new Date().toISOString() }))

    saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'reclaimed-pid-zero' })

    assert.equal(loadState('7', 'owner/repo')?.headSha, 'reclaimed-pid-zero')
    const surviving = existsSync(storeLockPath()) ? readFileSync(storeLockPath(), 'utf8') : null
    assert.equal(
      surviving,
      null,
      `pid 0 must not read as a live holder; the lock file survived holding ${surviving}`
    )
  })
})

test('a store lock naming pid -1 is reclaimed, not read as every signalable process (FLOW-226)', () => {
  withIsolatedStore('flow-226-store-lock-pid-negative', () => {
    mkdirSync(storeDir(), { recursive: true })
    writeFileSync(
      storeLockPath(),
      JSON.stringify({ pid: -1, acquiredAt: new Date().toISOString() })
    )

    saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'reclaimed-pid-negative' })

    assert.equal(loadState('7', 'owner/repo')?.headSha, 'reclaimed-pid-negative')
    const surviving = existsSync(storeLockPath()) ? readFileSync(storeLockPath(), 'utf8') : null
    assert.equal(
      surviving,
      null,
      `pid -1 must not read as a live holder; the lock file survived holding ${surviving}`
    )
  })
})

test('a store lock with a numeric acquiredAt is reclaimed, not read as freshly acquired (FLOW-226)', () => {
  withIsolatedStore('flow-226-store-lock-numeric-date', () => {
    mkdirSync(storeDir(), { recursive: true })
    // `Date.now()` written through instead of `.toISOString()`. Read as literal epoch-ms it looks
    // freshly acquired, and pid 1 is signalable by nobody here, so `process.kill(1, 0)` throws
    // EPERM and isStoreLockProcessAlive reads it as a live foreign holder — held forever, since
    // nothing else ever reclaims it.
    writeFileSync(storeLockPath(), JSON.stringify({ pid: 1, acquiredAt: Date.now() }))

    saveState('7', 'owner/repo', { ...cleanBaseline(), headSha: 'reclaimed-numeric-date' })

    assert.equal(loadState('7', 'owner/repo')?.headSha, 'reclaimed-numeric-date')
    const surviving = existsSync(storeLockPath()) ? readFileSync(storeLockPath(), 'utf8') : null
    assert.equal(
      surviving,
      null,
      `a numeric acquiredAt must not read as fresh; the lock file survived holding ${surviving}`
    )
  })
})

const withBotComment = (bodyHash: string | undefined): PrState =>
  mergeReadyExcept({
    botComments: [
      bodyHash === undefined
        ? { id: 'cr-summary', author: 'coderabbitai' }
        : { id: 'cr-summary', author: 'coderabbitai', bodyHash },
    ],
  })

test('an edited bot comment emits bot-comments-edited (FLOW-373)', () => {
  const changes = compareStates(withBotComment('before'), withBotComment('after'))
  assert.deepEqual(
    changes.filter((c) => c.type === 'bot-comments-edited' || c.type === 'NEW_BOT_COMMENTS'),
    [{ type: 'bot-comments-edited', detail: '1 edited top-level bot comment from: coderabbitai' }]
  )
})

test('an unchanged bot comment emits nothing (FLOW-373)', () => {
  const changes = compareStates(withBotComment('same'), withBotComment('same'))
  assert.equal(
    changes.some((c) => c.type === 'bot-comments-edited'),
    false
  )
})

test('a bot comment saved before bodyHash existed is not read as edited (FLOW-373)', () => {
  const changes = compareStates(withBotComment(undefined), withBotComment('after'))
  assert.equal(
    changes.some((c) => c.type === 'bot-comments-edited'),
    false
  )
})

// --- FLOW-402: the watched-PR registry ---

test('watchPr registers a PR once and keeps its original registeredAt', () => {
  withIsolatedStore('flow-402-watch', () => {
    watchPr('7', 'a/b')
    const first = loadWatched()
    assert.equal(first.length, 1)
    assert.equal(first[0]?.prNumber, '7')
    assert.equal(first[0]?.repo, 'a/b')
    assert.equal(first[0]?.consecutiveUnknown, 0)
    watchPr('7', 'a/b')
    assert.deepEqual(loadWatched(), first)
  })
})

test('saveState keeps the watched registry through its whole-store rewrite', () => {
  withIsolatedStore('flow-402-save-keeps-watched', () => {
    watchPr('7', 'a/b')
    saveState('7', 'a/b', cleanBaseline())
    assert.deepEqual(
      loadWatched().map((w) => w.prNumber),
      ['7']
    )
  })
})

test('recordUnknownPoll on an unwatched PR returns null and creates nothing', () => {
  withIsolatedStore('flow-402-unknown-unwatched', () => {
    assert.equal(recordUnknownPoll('7', 'a/b', 'x'), null)
    assert.deepEqual(loadWatched(), [])
    watchPr('7', 'a/b')
    assert.deepEqual(recordUnknownPoll('7', 'a/b', 'first'), { count: 1, failure: 'first' })
    assert.deepEqual(recordUnknownPoll('7', 'a/b', 'second'), { count: 2, failure: 'second' })
    assert.equal(loadWatched()[0]?.lastFailure, 'second')
  })
})

test('markPolled stamps a watched PR and creates nothing for an unwatched one', () => {
  withIsolatedStore('flow-402-mark-polled', () => {
    watchPr('9', 'acme/widget')

    markPolled('9', 'acme/widget', '2026-01-02T03:04:05.000Z')
    markPolled('10', 'acme/widget', '2026-01-02T03:04:05.000Z')

    assert.deepEqual(
      loadWatched().map((w) => [w.prNumber, w.lastPolledAt]),
      [['9', '2026-01-02T03:04:05.000Z']]
    )
  })
})

test('unwatchPr reports whether the PR was watched', () => {
  withIsolatedStore('flow-402-unwatch', () => {
    assert.equal(unwatchPr('7', 'a/b'), false)
    watchPr('7', 'a/b')
    assert.equal(unwatchPr('7', 'a/b'), true)
    assert.deepEqual(loadWatched(), [])
  })
})

test('a malformed watched entry is dropped and a bad counter reads as 0', () => {
  withIsolatedStore('flow-402-malformed-watched', () => {
    const at = new Date().toISOString()
    atomicWrite(
      statePath(),
      JSON.stringify({
        prs: {},
        watched: {
          'a/b#1': { prNumber: '1', registeredAt: at, consecutiveUnknown: 1 },
          'a/b#2': { prNumber: '2', repo: 'a/b', registeredAt: at, consecutiveUnknown: -3 },
        },
      })
    )
    const watched = loadWatched()
    assert.deepEqual(
      watched.map((w) => [w.prNumber, w.consecutiveUnknown]),
      [['2', 0]]
    )
  })
})
