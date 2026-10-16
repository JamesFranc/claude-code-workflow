import { fetchPrState } from './gh.ts'
import { formatChanges } from './format.ts'
import {
  cleanBaseline,
  clearUnknownPolls,
  compareStates,
  deleteState,
  loadSelfCommentIds,
  loadSelfReadyAt,
  loadState,
  loadWatched,
  markPolled,
  recordUnknownPoll,
  saveState,
  unwatchPr,
  type ChangeType,
  type PrState,
  type StateChange,
} from './state.ts'

// Checks are 3 minutes apart while the session is idle. Keep in step with CHECK_INTERVAL_MS in
// hooks/wake.ts, which the wake mod cannot import from here.
export const CHECK_INTERVAL_MINUTES = 3
// The least time a PR is given to poll: room for the four or more gh calls of one poll at a few
// seconds each. When the remaining budget cannot give every PR this much, only the PRs that fit are
// polled, least recently polled first.
export const MIN_PR_SLICE_MS = 12_000
// See the difference-set comment above resolvePrState (gh.ts): a poll that lands here is dominated
// by persistent failures, not blips withRetry already absorbs, so it recurs rather than clearing on
// its own. This bounds how many consecutive checks a wedged PR is polled before it is reported and
// unwatched.
export const MAX_CONSECUTIVE_UNKNOWN = 5
const CONFIRM_TYPES: ReadonlySet<ChangeType> = new Set([
  'MERGE_READY',
  'MERGED',
  'CLOSED',
  'MERGE_CONFLICT',
])
const TERMINAL_TYPES: ReadonlySet<ChangeType> = new Set(['MERGED', 'CLOSED'])

type FetchState = typeof fetchPrState

// `mailbox check`'s PR source (FLOW-402): one poll of each PR this session watches, least recently
// polled first, within `budgetMs`. Each PR gets the remaining budget divided by the PRs not yet
// polled, recomputed after every PR so time one PR leaves unused flows to the next, and never less
// than MIN_PR_SLICE_MS; once less than that remains the rest wait for the next check. A poll that
// fails, throws or runs out of its own slice counts as an UNKNOWN poll, so the wedge bound ends a PR
// that never succeeds; a PR not started is not counted. Each poll prints its own entry before
// persisting (see pollOnce). Two checks running at once (the mod's tick plus a manual `mailbox
// check`) both read the same baseline and both print: a duplicate wake, never a lost one.
// `checkStartedAt` is when the check began, the one anchor every poll judges the `--ack-ready` ack
// by (see pollOnce).
export const pollWatched = (
  fetchState: FetchState = fetchPrState,
  budgetMs: number = Number.POSITIVE_INFINITY,
  checkStartedAt: string = new Date().toISOString()
): void => {
  const deadlineMs = Date.now() + budgetMs
  const queue = [...loadWatched()].sort((a, b) =>
    (a.lastPolledAt ?? '').localeCompare(b.lastPolledAt ?? '')
  )
  for (const [index, { prNumber, repo }] of queue.entries()) {
    const remainingMs = deadlineMs - Date.now()
    if (remainingMs < MIN_PR_SLICE_MS) {
      return
    }

    const sliceMs = Math.max(MIN_PR_SLICE_MS, remainingMs / (queue.length - index))
    try {
      markPolled(prNumber, repo)
      pollOnce(prNumber, repo, fetchState, Date.now() + sliceMs, checkStartedAt)
    } catch (error) {
      const message = (error as Error).message
      console.error(`mailbox check: polling ${repo}#${prNumber} failed: ${message}`)
      reportPollFailure(prNumber, repo, message)
    }
  }
}

// Counts a poll that threw. When the count itself cannot be stored the store is broken, which no
// later check will repair by itself: the failure goes to stdout so it reaches the session, on every
// check it recurs.
const reportPollFailure = (prNumber: string, repo: string, message: string): void => {
  try {
    countUnknownPoll(prNumber, repo, `the poll threw: ${message}`)
  } catch (storeError) {
    console.log(
      `[pr-monitor] ${repo}#${prNumber} could not be polled: the check failed to record its ` +
        `result: ${(storeError as Error).message}`
    )
  }
}

// One poll of one watched PR against its saved baseline. Prints a `[pr-monitor]` entry when there
// is an emittable change. A non-terminal change keeps the PR watched; MERGED/CLOSED unwatch it.
// Print before persisting: a check that dies between the two re-prints the change next time
// instead of losing it. A duplicate wake is safe to handle twice; a lost one is never recovered.
//
// An unspent `--ack-ready` ack suppresses a draft→ready flip: the read that sees the flip is
// the one that must not wake the session for its own action, whenever the check began. Each read
// is judged against the ack as it stands after that read, so the confirm read loads it again. The ack is
// spent only when it was recorded no later than `checkStartedAt` (see saveState). A check starts
// only while the session is idle, so such an ack came from a turn that had ended after running
// `gh pr ready`, and the check's reads are all after the flip. An ack recorded later may belong to
// a flip a read already under way preceded, so it stays for the next check to spend.
export const pollOnce = (
  prNumber: string,
  repo: string,
  fetchState: FetchState = fetchPrState,
  deadlineMs?: number,
  checkStartedAt: string = new Date().toISOString()
): void => {
  const previous = loadState(prNumber, repo) ?? cleanBaseline()
  const current = fetchState(prNumber, repo, deadlineMs)

  // prState is UNKNOWN when fetchPrView, fetchReviews, or fetchUnresolvedThreads failed (see the
  // difference-set comment above resolvePrState in gh.ts), or when the PR's time slice ran out
  // before the reads finished. Don't compare or overwrite; count it toward the wedge bound.
  if (current.prState === 'UNKNOWN') {
    countUnknownPoll(prNumber, repo, unknownFailure(current))
    return
  }

  preserveWatermarks(previous, current)

  const selfCommentIds = loadSelfCommentIds(prNumber, repo)
  const selfReady = loadSelfReadyAt(prNumber, repo) !== undefined
  let changes = compareStates(previous, current, selfCommentIds, selfReady)
  let snapshot = current

  // Re-check high-stakes events against a fresh read before emitting.
  if (changes.some((c) => CONFIRM_TYPES.has(c.type))) {
    const confirm = fetchState(prNumber, repo, deadlineMs)
    if (confirm.prState === 'UNKNOWN') {
      countUnknownPoll(prNumber, repo, unknownFailure(confirm))
      return
    }
    preserveWatermarks(previous, confirm)
    const firstFetchTypes = new Set(changes.map((c) => c.type))
    const confirmChanges = compareStates(
      previous,
      confirm,
      selfCommentIds,
      loadSelfReadyAt(prNumber, repo) !== undefined
    )
    if (confirmChanges.some((c) => CONFIRM_TYPES.has(c.type) && !firstFetchTypes.has(c.type))) {
      // A confirm-type change (e.g. MERGE_READY -> MERGED) surfaced only on the re-check, after the
      // first fetch flagged a different — or no — confirm type. Emitting would skip the re-check;
      // saving would persist a baseline nothing confirmed as stable. Retry instead: the next check
      // re-derives and re-confirms against the unchanged baseline.
      clearUnknownPolls(prNumber, repo)
      return
    }
    changes = confirmChanges
    snapshot = confirm
  }

  clearUnknownPolls(prNumber, repo)

  if (changes.length > 0) {
    console.log(formatEntry(prNumber, repo, changes))
    if (changes.some((c) => TERMINAL_TYPES.has(c.type))) {
      deleteState(prNumber, repo) // delete-on-merge / delete-on-close
      unwatchPr(prNumber, repo)
    } else {
      saveState(prNumber, repo, snapshot, checkStartedAt)
    }
    return
  }

  // No emittable change — persist the baseline. A check that finds nothing emits nothing, for any
  // elapsed time: a wake-up that cannot name a change since the lead's last turn costs a full
  // context read to establish that nothing happened (FLOW-261). Polling GitHub is not a wake-up,
  // and it is what makes every real change visible.
  saveState(prNumber, repo, snapshot, checkStartedAt)
}

// Pure decision for the UNKNOWN path, kept separate from countUnknownPoll's side effects so the
// threshold and the emitted message can be tested without a store. `consecutiveUnknown` is the
// count after this poll and `failure` the reason recorded with it.
export const nextUnknownPollAction = (
  consecutiveUnknown: number,
  prNumber: string,
  repo: string,
  failure: string
): { kind: 'retry' } | { kind: 'wedged'; change: StateChange } =>
  consecutiveUnknown < MAX_CONSECUTIVE_UNKNOWN
    ? { kind: 'retry' }
    : {
        kind: 'wedged',
        change: {
          type: 'monitor-wedged',
          detail:
            `${MAX_CONSECUTIVE_UNKNOWN} consecutive checks (at least ~${
              MAX_CONSECUTIVE_UNKNOWN * CHECK_INTERVAL_MINUTES
            } idle minutes) could not poll this PR; it is no longer watched. Last failure: ` +
            `${failure}. withRetry already absorbs transient network errors, so this is likely a ` +
            `persistent failure — bad credentials, a lost token scope, a rate-limited window, a ` +
            `rejected query, or a poll too slow for its time slice. Check \`gh auth status\` and ` +
            `\`gh pr view ${prNumber} ` +
            `--repo ${repo}\`, fix it, and watch it again with \`pr-monitor --pr ${prNumber} ` +
            `--repo ${repo}\`.`,
        },
      }

const unknownFailure = (state: PrState): string =>
  state.unknownReason || 'the PR view, reviews or unresolved threads could not be read'

// A null record means the PR was unwatched since this check's snapshot: nothing to report.
const countUnknownPoll = (prNumber: string, repo: string, failure: string): void => {
  const recorded = recordUnknownPoll(prNumber, repo, failure)
  if (recorded === null) {
    return
  }

  const action = nextUnknownPollAction(recorded.count, prNumber, repo, recorded.failure)
  if (action.kind === 'retry') {
    return
  }

  console.log(formatEntry(prNumber, repo, [action.change]))
  unwatchPr(prNumber, repo)
}

// The mod splits check output before a line opening with a known `[source]` tag (hooks/wake.ts
// ENTRY_START). formatChanges' header carries the tag; a detail line that itself opened with `[`
// would start a bogus entry, so every such continuation line is indented.
const formatEntry = (prNumber: string, repo: string, changes: StateChange[]): string =>
  formatChanges(prNumber, repo, changes).replace(/\n(?=\[)/g, '\n  ')

export const preserveWatermarks = (previous: PrState, current: PrState): void => {
  // Preserve last-known values when GitHub returns UNKNOWN for a sub-field.
  if (current.mergeable === 'UNKNOWN' && previous.mergeable) {
    current.mergeable = previous.mergeable
  }
  if (current.mergeStateStatus === 'UNKNOWN' && previous.mergeStateStatus) {
    current.mergeStateStatus = previous.mergeStateStatus
  }
  // Preserve the CI_GREEN_ON_DRAFT watermark across polls — fetchPrState hardcodes
  // false on every fetch, so without this the event re-fires each restart. But a new
  // commit (a changed head SHA) is a fresh review cycle — e.g. a rework push after a
  // rejected flip-to-ready gate — so let the watermark reset there, allowing CI
  // re-greening on the new head to re-emit CI_GREEN_ON_DRAFT. Mirrors the
  // coderabbitThrottleCount reset-on-new-commit in compareStates.
  const headChanged =
    !!current.headSha && !!previous.headSha && current.headSha !== previous.headSha
  if (previous.ciGreenOnDraftFired && !headChanged) {
    current.ciGreenOnDraftFired = true
  }
}
