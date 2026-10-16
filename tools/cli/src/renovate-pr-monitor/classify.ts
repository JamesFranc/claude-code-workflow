// Ported from scripts/renovate-pr-monitor.sh's `classify`: buckets one Renovate PR into the
// terminal action code the routines in routines.ts key off. See
// characterization/harness.ts's runClassify for how the characterization table drives this.
import { AGENT_BUSY_TIMEOUT_SECONDS, BLOCKED_ESCALATE_SECONDS } from './config.ts'
import type { BoardItem } from './state.ts'

export type ClassifyResult =
  | 'agent-busy'
  | 'left-alone'
  | 'major'
  | 'major-skip'
  | 'rebase-conflict'
  | 'needs-rebase'
  | 'skip'
  | 'ci-pending'
  | 'ci-failed'
  | 'mergeable'
  | 'needs-approval'
  | 'blocked'
  | 'blocked-stuck'
  | 'unknown'

export type StatusCheckRollupItem =
  | { __typename: 'CheckRun'; name: string; status: string; conclusion: string }
  | { __typename: 'StatusContext'; context: string; state: string }

// The fields gh_view_pr requests via `gh pr view --json`.
export interface GhPrDetails {
  number: number
  title: string
  url: string
  headRefName: string
  headRefOid: string
  mergeStateStatus: string
  mergeable: string
  baseRefName: string
  statusCheckRollup: StatusCheckRollupItem[]
  reviewDecision: string
  body: string
}

export interface RenovatePrState {
  headSha?: string
  ciRetries?: number
  agentBusy?: boolean
  agentStartedAt?: string
  majorNotified?: boolean
  lastSeenAt?: string
  blockedSince?: string
}

export const classify = (
  pr: GhPrDetails,
  entry: RenovatePrState | null,
  nowEpochSeconds: number,
  boardItem: BoardItem | null
): ClassifyResult => {
  if (boardItem?.outcome === 'leave') {
    return 'left-alone'
  }

  if (entry?.agentBusy === true && entry.agentStartedAt !== undefined) {
    const startedEpoch = Date.parse(entry.agentStartedAt) / 1000
    if (nowEpochSeconds - startedEpoch < AGENT_BUSY_TIMEOUT_SECONDS) {
      return 'agent-busy'
    }
  }

  if (prIsMajor(pr)) {
    return entry?.majorNotified === true ? 'major-skip' : 'major'
  }

  if (pr.mergeStateStatus === 'DIRTY') {
    return 'rebase-conflict'
  }
  if (pr.mergeStateStatus === 'BEHIND') {
    return 'needs-rebase'
  }
  if (pr.mergeStateStatus === 'UNKNOWN') {
    return 'skip'
  }

  if (checksAnyPending(pr.statusCheckRollup)) {
    return 'ci-pending'
  }
  if (checksAnyFailed(pr.statusCheckRollup)) {
    return 'ci-failed'
  }

  if (pr.mergeStateStatus === 'CLEAN' || pr.mergeStateStatus === 'HAS_HOOKS') {
    return 'mergeable'
  }
  if (pr.mergeStateStatus === 'BLOCKED') {
    if (pr.reviewDecision === 'REVIEW_REQUIRED' && pr.mergeable === 'MERGEABLE') {
      return 'needs-approval'
    }
    if (pr.reviewDecision === 'CHANGES_REQUESTED') {
      return 'blocked-stuck'
    }
    const blockedSince = entry?.headSha === pr.headRefOid ? entry.blockedSince : undefined
    if (
      blockedSince !== undefined &&
      nowEpochSeconds - Date.parse(blockedSince) / 1000 >= BLOCKED_ESCALATE_SECONDS
    ) {
      return 'blocked-stuck'
    }
    return 'blocked'
  }

  return 'unknown'
}

// True iff any statusCheckRollup entry is still running (not yet completed).
const checksAnyPending = (rollup: StatusCheckRollupItem[]): boolean =>
  rollup.some(
    (item) =>
      (item.__typename === 'CheckRun' && item.status !== 'COMPLETED') ||
      (item.__typename === 'StatusContext' && item.state === 'PENDING')
  )

const FAILING_CHECKRUN_CONCLUSIONS = new Set([
  'FAILURE',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
])
const FAILING_STATUS_CONTEXT_STATES = new Set(['FAILURE', 'ERROR'])

// Shared between checksAnyFailed and tick.ts's ci-failed context builder, so the two can never
// disagree about which conclusions/states count as failed.
export const isFailingCheck = (item: StatusCheckRollupItem): boolean =>
  (item.__typename === 'CheckRun' &&
    item.status === 'COMPLETED' &&
    FAILING_CHECKRUN_CONCLUSIONS.has(item.conclusion)) ||
  (item.__typename === 'StatusContext' && FAILING_STATUS_CONTEXT_STATES.has(item.state))

const checksAnyFailed = (rollup: StatusCheckRollupItem[]): boolean => rollup.some(isFailingCheck)

const MAJOR_TITLE_SUFFIX = /\(major\)/
const MAJOR_TABLE_CELL = /\|\s*major\s*\|/
const DIGEST_TABLE_CELL = /\|\s*(digest|pinDigest)\s*\|/
const VERSION_ARROW_ROW = /`([^`]*)`\s*(→|->)\s*`([^`]*)`/

const prIsMajor = (pr: GhPrDetails): boolean => {
  if (MAJOR_TITLE_SUFFIX.test(pr.title)) {
    return true
  }
  if (
    pr.headRefName.startsWith('renovate/major-') ||
    pr.headRefName.startsWith('renovate/major/')
  ) {
    return true
  }

  for (const line of pr.body.split('\n')) {
    if (!line.startsWith('|')) {
      continue
    }
    // Digest/pinDigest rows hold image SHA shorthands, not version numbers, so the
    // version-increase check below would trip on arbitrary leading digits.
    if (DIGEST_TABLE_CELL.test(line)) {
      continue
    }
    if (MAJOR_TABLE_CELL.test(line)) {
      return true
    }

    const arrow = VERSION_ARROW_ROW.exec(line)
    if (arrow) {
      const from = leadingInt(arrow[1])
      const to = leadingInt(arrow[3])
      if (from !== null && to !== null && to > from) {
        return true
      }
    }
  }
  return false
}

// The first run of digits in s (after any non-digit prefix like "v" or "^"), or null if there is
// none. Used to compare version major components.
const leadingInt = (s: string): number | null => {
  const m = /^[^0-9]*([0-9]+)/.exec(s)
  return m ? Number.parseInt(m[1], 10) : null
}
