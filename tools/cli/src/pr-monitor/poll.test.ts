import { test, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_CONSECUTIVE_UNKNOWN,
  MIN_PR_SLICE_MS,
  nextUnknownPollAction,
  pollOnce,
  pollWatched,
  preserveWatermarks,
} from './poll.ts'
import {
  cleanBaseline,
  compareStates,
  loadSelfReadyAt,
  loadState,
  loadWatched,
  recordSelfReady,
  saveState,
  statePath,
  watchPr,
  type PrState,
} from './state.ts'

// A draft PR whose CI is green, at a given head, with the watermark in a given state.
const greenDraft = (headSha: string, fired: boolean): PrState => ({
  ...cleanBaseline(),
  isDraft: true,
  ciChecks: { ci: 'success' },
  headSha,
  ciGreenOnDraftFired: fired,
})

// A draft PR whose CI is still running (not green), at a given head. fetchPrState
// always hardcodes ciGreenOnDraftFired:false, so a freshly-fetched state has it false.
const pendingDraft = (headSha: string): PrState => ({
  ...cleanBaseline(),
  isDraft: true,
  ciChecks: { ci: 'pending' },
  headSha,
  ciGreenOnDraftFired: false,
})

test('preserveWatermarks keeps the CI_GREEN_ON_DRAFT watermark when the head is unchanged', () => {
  const previous = greenDraft('sha1', true)
  const current = pendingDraft('sha1') // same head, fetch reset fired to false
  preserveWatermarks(previous, current)
  assert.equal(current.ciGreenOnDraftFired, true, 'watermark preserved on the same commit')
})

test('preserveWatermarks resets the watermark on a new head (rework push)', () => {
  const previous = greenDraft('sha1', true)
  const current = pendingDraft('sha2') // new commit pushed
  preserveWatermarks(previous, current)
  assert.equal(current.ciGreenOnDraftFired, false, 'watermark reset for a fresh review cycle')
})

test('preserveWatermarks does not reset on a transient empty current headSha', () => {
  const previous = greenDraft('sha1', true)
  const current = { ...pendingDraft(''), headSha: '' } // fetch failed to populate head
  preserveWatermarks(previous, current)
  assert.equal(current.ciGreenOnDraftFired, true, 'empty current head is not a real head change')
})

test('preserveWatermarks does not reset when the previous head is empty (cold start)', () => {
  const previous = { ...greenDraft('', true), headSha: '' }
  const current = pendingDraft('sha1')
  preserveWatermarks(previous, current)
  assert.equal(current.ciGreenOnDraftFired, true, 'empty previous head is not a real head change')
})

test('a rework push re-emits CI_GREEN_ON_DRAFT once the new head goes green', () => {
  // 1. Old head already emitted CI_GREEN_ON_DRAFT (watermark set).
  const oldGreen = greenDraft('sha1', true)

  // 2. Rework push: new head, CI pending. preserveWatermarks resets the watermark.
  const newPending = pendingDraft('sha2')
  preserveWatermarks(oldGreen, newPending)
  assert.equal(newPending.ciGreenOnDraftFired, false)
  assert.equal(
    compareStates(oldGreen, newPending).some((c) => c.type === 'CI_GREEN_ON_DRAFT'),
    false,
    'no emit while the new head is still running CI'
  )

  // 3. New head goes green: transition not-green -> green with watermark false -> re-emit.
  const newGreen = greenDraft('sha2', false)
  preserveWatermarks(newPending, newGreen) // same head, prev watermark false: no-op
  const changes = compareStates(newPending, newGreen)
  assert.equal(
    changes.some((c) => c.type === 'CI_GREEN_ON_DRAFT'),
    true,
    'CI_GREEN_ON_DRAFT re-emits on the new head'
  )
})

test('the same commit going green again does not re-emit (no spurious duplicate)', () => {
  // Guard the other direction: a green->green blip on the SAME head must stay silent.
  const green = greenDraft('sha1', true)
  const stillGreen = greenDraft('sha1', false) // fetch reset; preserve will restore it
  preserveWatermarks(green, stillGreen)
  assert.equal(stillGreen.ciGreenOnDraftFired, true)
  assert.equal(
    compareStates(green, stillGreen).some((c) => c.type === 'CI_GREEN_ON_DRAFT'),
    false,
    'no re-emit on the same commit'
  )
})

test('a fast-green rework re-emits CI_GREEN_ON_DRAFT even if no pending poll was observed', () => {
  // Old head already emitted (watermark set), CI green.
  const oldGreen = greenDraft('sha1', true)
  // Rework pushed AND already green by the next poll (fast CI) — no pending state observed.
  const newGreen = greenDraft('sha2', false) // fetch hardcodes fired:false
  preserveWatermarks(oldGreen, newGreen) // headChanged → watermark stays false
  assert.equal(newGreen.ciGreenOnDraftFired, false)
  const changes = compareStates(oldGreen, newGreen)
  assert.equal(
    changes.some((c) => c.type === 'CI_GREEN_ON_DRAFT'),
    true,
    'head-change-while-green re-emits CI_GREEN_ON_DRAFT'
  )
  assert.equal(newGreen.ciGreenOnDraftFired, true, 'watermark re-set after emit')
})

// pollOnce() reads/writes the durable store (workflow-store/store.ts), which is homedir()-relative
// — override HOME per test so it never touches the real ~/.claude/workflow-state, and give each
// test its own session partition so a leftover baseline can never leak between them.
let pollTestHome: string
let originalHome: string | undefined
let originalSession: string | undefined

beforeEach(() => {
  pollTestHome = mkdtempSync(join(tmpdir(), 'pr-monitor-poll-test-'))
  originalHome = process.env.HOME
  originalSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.HOME = pollTestHome
  process.env.CLAUDE_CODE_SESSION_ID = 'poll-test-session'
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = originalSession
  rmSync(pollTestHome, { recursive: true, force: true })
})

// Runs fn with console.log captured. Returns the printed lines.
const capturePrinted = (fn: () => void): string[] => {
  const origLog = console.log
  const printed: string[] = []
  console.log = ((msg: string): void => {
    printed.push(msg)
  }) as typeof console.log
  try {
    fn()
  } finally {
    console.log = origLog
  }
  return printed
}

const conflicting = (): PrState => ({ ...cleanBaseline(), mergeable: 'CONFLICTING' })
const unknown = (): PrState => ({ ...cleanBaseline(), prState: 'UNKNOWN' })
const watchedNumbers = (): string[] => loadWatched().map((w) => w.prNumber)

test('nextUnknownPollAction retries below the threshold and wedges at it, naming the real commands', () => {
  assert.deepEqual(nextUnknownPollAction(MAX_CONSECUTIVE_UNKNOWN - 1, '2', 'acme/widget', 'x'), {
    kind: 'retry',
  })
  const action = nextUnknownPollAction(MAX_CONSECUTIVE_UNKNOWN, '2', 'acme/widget', 'HTTP 401')
  assert.equal(action.kind, 'wedged')
  if (action.kind !== 'wedged') {
    return
  }
  assert.equal(action.change.type, 'monitor-wedged')
  assert.match(action.change.detail, /Last failure: HTTP 401\./)
  assert.match(action.change.detail, /gh pr view 2 --repo acme\/widget/)
  assert.match(action.change.detail, /pr-monitor --pr 2 --repo acme\/widget/)
})

test('a non-terminal change prints one [pr-monitor] entry and the PR stays watched', () => {
  watchPr('1', 'acme/widget')
  saveState('1', 'acme/widget', cleanBaseline())
  const printed = capturePrinted(() => pollOnce('1', 'acme/widget', conflicting))
  assert.equal(printed.length, 1)
  assert.equal(printed[0]?.split('\n')[0], '[pr-monitor] changes detected on acme/widget#1')
  assert.match(printed[0] ?? '', /\[MERGE_CONFLICT\]/)
  assert.deepEqual(watchedNumbers(), ['1'])
  assert.equal(loadState('1', 'acme/widget')?.mergeable, 'CONFLICTING')
  assert.deepEqual(
    capturePrinted(() => pollOnce('1', 'acme/widget', conflicting)),
    [],
    'a delivered change is not printed a second time'
  )
})

test('a MERGED PR prints, deletes its state and stops being watched', () => {
  watchPr('2', 'acme/widget')
  saveState('2', 'acme/widget', cleanBaseline())
  const printed = capturePrinted(() =>
    pollOnce('2', 'acme/widget', () => ({ ...cleanBaseline(), prState: 'MERGED' }))
  )
  assert.equal(printed.length, 1)
  assert.match(printed[0] ?? '', /\[MERGED\]/)
  assert.deepEqual(watchedNumbers(), [])
  assert.equal(loadState('2', 'acme/widget'), null)
})

test('four UNKNOWN polls print nothing and the fifth reports monitor-wedged and unwatches', () => {
  watchPr('3', 'acme/widget')
  for (let i = 1; i < MAX_CONSECUTIVE_UNKNOWN; i++) {
    assert.deepEqual(
      capturePrinted(() => pollOnce('3', 'acme/widget', unknown)),
      []
    )
    assert.deepEqual(watchedNumbers(), ['3'])
  }
  const printed = capturePrinted(() => pollOnce('3', 'acme/widget', unknown))
  assert.equal(printed.length, 1)
  assert.match(printed[0] ?? '', /\[monitor-wedged\]/)
  assert.deepEqual(watchedNumbers(), [])
})

test('a successful poll between UNKNOWN polls resets the wedge counter', () => {
  watchPr('4', 'acme/widget')
  for (let i = 0; i < MAX_CONSECUTIVE_UNKNOWN - 1; i++) {
    pollOnce('4', 'acme/widget', unknown)
  }
  pollOnce('4', 'acme/widget', () => cleanBaseline())
  assert.deepEqual(
    capturePrinted(() => pollOnce('4', 'acme/widget', unknown)),
    []
  )
  assert.deepEqual(watchedNumbers(), ['4'])
  assert.equal(loadWatched()[0]?.consecutiveUnknown, 1)
})

test('a confirm re-check that keeps returning UNKNOWN reaches monitor-wedged', () => {
  watchPr('5', 'acme/widget')
  let call = 0
  const firstOkConfirmUnknown = (): PrState => (call++ % 2 === 0 ? conflicting() : unknown())
  let printed: string[] = []
  for (let i = 1; i <= MAX_CONSECUTIVE_UNKNOWN; i++) {
    printed = capturePrinted(() => pollOnce('5', 'acme/widget', firstOkConfirmUnknown))
    if (i < MAX_CONSECUTIVE_UNKNOWN) {
      assert.deepEqual(printed, [])
    }
  }
  assert.match(printed[0] ?? '', /\[monitor-wedged\]/)
  assert.deepEqual(watchedNumbers(), [])
})

test('pollWatched reports a PR whose poll throws on stderr, counts it as UNKNOWN and still polls the next PR', () => {
  watchPr('6', 'acme/widget')
  watchPr('7', 'acme/widget')
  const origError = console.error
  const errors: string[] = []
  console.error = ((msg: string): void => {
    errors.push(msg)
  }) as typeof console.error
  let printed: string[]
  try {
    printed = capturePrinted(() =>
      pollWatched((prNumber) => {
        if (prNumber === '6') {
          throw new Error('gh crashed')
        }
        return conflicting()
      })
    )
  } finally {
    console.error = origError
  }
  assert.deepEqual(errors, ['mailbox check: polling acme/widget#6 failed: gh crashed'])
  assert.equal(printed.length, 1)
  assert.match(printed[0] ?? '', /changes detected on acme\/widget#7/)
  const six = loadWatched().find((w) => w.prNumber === '6')
  assert.equal(six?.consecutiveUnknown, 1)
  assert.equal(six?.lastFailure, 'the poll threw: gh crashed')
})

test('a PR whose poll throws on every check ends in monitor-wedged naming the throw', () => {
  watchPr('15', 'acme/widget')
  const origError = console.error
  console.error = (() => {}) as typeof console.error
  let printed: string[] = []
  try {
    for (let i = 1; i <= MAX_CONSECUTIVE_UNKNOWN; i++) {
      printed = capturePrinted(() =>
        pollWatched(() => {
          throw new Error('gh crashed')
        })
      )
      if (i < MAX_CONSECUTIVE_UNKNOWN) {
        assert.deepEqual(printed, [])
      }
    }
  } finally {
    console.error = origError
  }
  assert.match(printed[0] ?? '', /\[monitor-wedged\].*Last failure: the poll threw: gh crashed\./)
  assert.deepEqual(watchedNumbers(), [])
})

test('an UNKNOWN poll that reports a reason names it in monitor-wedged, and a good poll clears it', () => {
  watchPr('16', 'acme/widget')
  const withReason = (): PrState => ({ ...unknown(), unknownReason: 'fetchPrView: HTTP 401' })
  pollOnce('16', 'acme/widget', withReason)
  assert.equal(loadWatched()[0]?.lastFailure, 'fetchPrView: HTTP 401')
  pollOnce('16', 'acme/widget', () => cleanBaseline())
  assert.equal(loadWatched()[0]?.lastFailure, undefined)
  let printed: string[] = []
  for (let i = 1; i <= MAX_CONSECUTIVE_UNKNOWN; i++) {
    printed = capturePrinted(() => pollOnce('16', 'acme/widget', withReason))
  }
  assert.match(
    printed[0] ?? '',
    /could not poll this PR; it is no longer watched\. Last failure: fetchPrView: HTTP 401\./
  )
})

test('pollWatched gives each PR an equal share of the budget, and time one leaves unused flows to the next', () => {
  watchPr('21', 'acme/widget')
  watchPr('22', 'acme/widget')
  const budgetMs = 4 * MIN_PR_SLICE_MS
  const slices: Array<[string, number]> = []

  capturePrinted(() =>
    pollWatched((prNumber, _repo, deadlineMs) => {
      slices.push([prNumber, (deadlineMs as number) - Date.now()])
      return cleanBaseline()
    }, budgetMs)
  )

  assert.deepEqual(
    slices.map(([prNumber]) => prNumber),
    ['21', '22']
  )
  assert.ok(Math.abs((slices[0]?.[1] ?? 0) - budgetMs / 2) < 1_000, 'the first gets half')
  assert.ok(Math.abs((slices[1]?.[1] ?? 0) - budgetMs) < 1_000, 'the second gets what is left')
})

test('pollWatched polls only the PRs that fit the floor slice, and the next check starts with the ones it skipped', () => {
  for (const prNumber of ['31', '32', '33']) {
    watchPr(prNumber, 'acme/widget')
  }
  const polled: string[][] = [[], []]
  let check = 0
  // Each poll uses its whole floor slice, on a clock the test advances.
  mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const fetchState = (prNumber: string): PrState => {
    polled[check]?.push(prNumber)
    mock.timers.tick(MIN_PR_SLICE_MS)
    return unknown()
  }

  let unpolledAfterFirst: ReturnType<typeof loadWatched>[number] | undefined
  try {
    capturePrinted(() => pollWatched(fetchState, 2.5 * MIN_PR_SLICE_MS))
    unpolledAfterFirst = loadWatched().find((w) => w.prNumber === '33')
    check = 1
    capturePrinted(() => pollWatched(fetchState, 2.5 * MIN_PR_SLICE_MS))
  } finally {
    mock.timers.reset()
  }

  assert.deepEqual(polled[0], ['31', '32'])
  assert.equal(polled[1]?.[0], '33')
  assert.equal(unpolledAfterFirst?.consecutiveUnknown, 0, 'a PR never started is not counted')
  assert.equal(unpolledAfterFirst?.lastPolledAt, undefined)
})

test('pollWatched does nothing when less than the floor slice remains', () => {
  watchPr('34', 'acme/widget')

  const printed = capturePrinted(() =>
    pollWatched(() => {
      throw new Error('must not be called')
    }, MIN_PR_SLICE_MS - 1)
  )

  assert.deepEqual(printed, [])
  assert.equal(loadWatched()[0]?.consecutiveUnknown, 0)
})

test('pollWatched reports a PR on stdout when the store cannot record its failure, and goes on to the next', () => {
  watchPr('41', 'acme/widget')
  watchPr('42', 'acme/widget')
  // atomicWrite writes `<state.json>.<pid>.<counter>.tmp` before renaming; a directory at each name
  // it can reach makes every write fail with EISDIR while the store stays readable.
  for (let counter = 0; counter < 2_000; counter++) {
    mkdirSync(`${statePath()}.${process.pid}.${counter}.tmp`)
  }
  const origError = console.error
  console.error = (() => {}) as typeof console.error
  let printed: string[]
  try {
    printed = capturePrinted(() => pollWatched(() => conflicting()))
  } finally {
    console.error = origError
  }

  assert.equal(printed.length, 2)
  assert.match(
    printed[0] ?? '',
    /^\[pr-monitor\] acme\/widget#41 could not be polled: the check failed to record its result: EISDIR/
  )
  assert.match(
    printed[1] ?? '',
    /^\[pr-monitor\] acme\/widget#42 could not be polled: the check failed to record its result: EISDIR/
  )
})

test('a poll whose delivery throws does not advance the baseline, so the change prints again', () => {
  watchPr('9', 'acme/widget')
  saveState('9', 'acme/widget', cleanBaseline())
  const origLog = console.log
  console.log = ((): void => {
    throw new Error('died at delivery')
  }) as typeof console.log
  try {
    assert.throws(() => pollOnce('9', 'acme/widget', conflicting), /died at delivery/)
  } finally {
    console.log = origLog
  }
  const printed = capturePrinted(() => pollOnce('9', 'acme/widget', conflicting))
  assert.match(printed[0] ?? '', /MERGE_CONFLICT/)
})

test('a confirm re-check that reveals a different confirm-type transition prints and saves nothing', () => {
  watchPr('10', 'acme/widget')
  let call = 0
  const firstMergeReadyConfirmMerged = (): PrState =>
    call++ === 0
      ? {
          ...cleanBaseline(),
          isDraft: false,
          ciChecks: { ci: 'success' },
          reviews: [{ author: 'alice', authorType: 'User', state: 'APPROVED' }],
        }
      : { ...cleanBaseline(), prState: 'MERGED' }
  assert.deepEqual(
    capturePrinted(() => pollOnce('10', 'acme/widget', firstMergeReadyConfirmMerged)),
    []
  )
  assert.equal(loadState('10', 'acme/widget'), null)
  assert.deepEqual(watchedNumbers(), ['10'])
})

test('a non-confirm-type change that only appears on the confirm re-check is printed', () => {
  watchPr('11', 'acme/widget')
  let call = 0
  const printed = capturePrinted(() =>
    pollOnce('11', 'acme/widget', () =>
      call++ === 0
        ? conflicting()
        : { ...conflicting(), mainComments: [{ id: 'c1', author: 'reviewer' }] }
    )
  )
  assert.match(printed[0] ?? '', /new-main-comments/)
})

test('an acked ready flip prints nothing and spends the ack', () => {
  watchPr('12', 'acme/widget')
  saveState('12', 'acme/widget', { ...cleanBaseline(), isDraft: true })
  recordSelfReady('12', 'acme/widget')
  const printed = capturePrinted(() =>
    pollOnce('12', 'acme/widget', () => ({ ...cleanBaseline(), isDraft: false }))
  )
  assert.deepEqual(printed, [])
  assert.equal(loadSelfReadyAt('12', 'acme/widget'), undefined)
  assert.equal(loadState('12', 'acme/widget')?.isDraft, false)
})

test('a check that began before the ack keeps it', () => {
  watchPr('18', 'acme/widget')
  saveState('18', 'acme/widget', { ...cleanBaseline(), isDraft: true })
  pollOnce('18', 'acme/widget', () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    recordSelfReady('18', 'acme/widget')
    return { ...cleanBaseline(), isDraft: true }
  })
  assert.equal(loadSelfReadyAt('18', 'acme/widget') !== undefined, true)
  const printed = capturePrinted(() =>
    pollOnce('18', 'acme/widget', () => ({ ...cleanBaseline(), isDraft: false }))
  )
  assert.deepEqual(printed, [])
  assert.equal(loadSelfReadyAt('18', 'acme/widget'), undefined)
})

test('a check after the ack that still sees a draft spends it', () => {
  watchPr('19', 'acme/widget')
  saveState('19', 'acme/widget', { ...cleanBaseline(), isDraft: true })
  recordSelfReady('19', 'acme/widget')
  pollOnce('19', 'acme/widget', () => ({ ...cleanBaseline(), isDraft: true }))
  assert.equal(loadSelfReadyAt('19', 'acme/widget'), undefined)
  const printed = capturePrinted(() =>
    pollOnce('19', 'acme/widget', () => ({ ...cleanBaseline(), isDraft: false }))
  )
  assert.match(printed[0] ?? '', /READY_FOR_REVIEW/)
})

test('an ack recorded mid-check suppresses the flip that check reads and is spent by the next check', () => {
  watchPr('20', 'acme/widget')
  watchPr('21', 'acme/widget')
  saveState('21', 'acme/widget', { ...cleanBaseline(), isDraft: true })
  const printed = capturePrinted(() =>
    pollWatched((prNumber) => {
      if (prNumber === '20') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
        recordSelfReady('21', 'acme/widget')
        return cleanBaseline()
      }
      return { ...cleanBaseline(), isDraft: false }
    })
  )
  assert.deepEqual(printed, [])
  assert.equal(loadSelfReadyAt('21', 'acme/widget') !== undefined, true)
  pollWatched(() => ({ ...cleanBaseline(), isDraft: false }))
  assert.equal(loadSelfReadyAt('21', 'acme/widget'), undefined)
})

test('an ack recorded between the first and the confirm read suppresses the flip the confirm read sees', () => {
  watchPr('22', 'acme/widget')
  saveState('22', 'acme/widget', { ...cleanBaseline(), isDraft: true })
  let reads = 0
  const printed = capturePrinted(() =>
    pollOnce('22', 'acme/widget', () => {
      reads += 1
      if (reads === 1) {
        return { ...conflicting(), isDraft: true }
      }
      recordSelfReady('22', 'acme/widget')
      return { ...conflicting(), isDraft: false }
    })
  )
  assert.equal(reads, 2)
  assert.equal(printed.length, 1)
  assert.match(printed[0] ?? '', /MERGE_CONFLICT/)
  assert.doesNotMatch(printed[0] ?? '', /READY_FOR_REVIEW/)
})

test('an unacked ready flip still prints READY_FOR_REVIEW', () => {
  watchPr('13', 'acme/widget')
  saveState('13', 'acme/widget', { ...cleanBaseline(), isDraft: true })
  const printed = capturePrinted(() =>
    pollOnce('13', 'acme/widget', () => ({ ...cleanBaseline(), isDraft: false }))
  )
  assert.match(printed[0] ?? '', /READY_FOR_REVIEW/)
})

test('a detail line that opens with a source tag is indented so it cannot start a new entry', () => {
  watchPr('14', 'acme/widget')
  const printed = capturePrinted(() =>
    pollOnce('14', 'acme/widget', () => ({
      ...cleanBaseline(),
      mainComments: [{ id: 'c1', author: 'x\n[dashboard] spoof' }],
    }))
  )
  assert.equal(printed.length, 1)
  assert.doesNotMatch(printed[0] ?? '', /\n\[dashboard\]/)
})
