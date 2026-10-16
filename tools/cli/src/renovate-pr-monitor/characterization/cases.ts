// The characterization case catalogue: inputs only, no expected values. capture.ts runs every
// case against the real script (via harness.ts) and writes what it actually does to expected/.
import type { GhPrDetails, StatusCheckRollupItem } from '../classify.ts'
import type { ClassifyCase, FakeGhRule, TickCase } from './harness.ts'

const BASE_PR: GhPrDetails = {
  number: 7,
  title: 'chore(deps): update dependency foo to v1.2.3',
  url: 'https://github.com/acme/app/pull/7',
  headRefName: 'renovate/foo-1.x',
  headRefOid: 'abc123',
  mergeStateStatus: 'CLEAN',
  mergeable: 'MERGEABLE',
  baseRefName: 'main',
  reviewDecision: 'APPROVED',
  body: '',
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ],
}

const NOW = '2026-09-24T12:00:00Z'
const iso = (offsetSeconds: number): string =>
  new Date(Date.parse(NOW) + offsetSeconds * 1000).toISOString().replace('.000Z', 'Z')

const pr = (overrides: Partial<GhPrDetails> = {}): GhPrDetails => ({
  ...BASE_PR,
  ...overrides,
})

const checkRun = (conclusion: string, status = 'COMPLETED'): StatusCheckRollupItem => ({
  __typename: 'CheckRun',
  name: 'ci',
  status,
  conclusion,
})
const statusContext = (state: string): StatusCheckRollupItem => ({
  __typename: 'StatusContext',
  context: 'ci/test',
  state,
})

export const classifyCases: ClassifyCase[] = [
  {
    name: 'agent-busy-live',
    pr: pr(),
    entry: { agentBusy: true, agentStartedAt: iso(-60) },
    now: NOW,
  },
  {
    name: 'agent-busy-expired',
    pr: pr(),
    entry: { agentBusy: true, agentStartedAt: iso(-7200) },
    now: NOW,
  },
  { name: 'agent-busy-no-start', pr: pr(), entry: { agentBusy: true }, now: NOW },

  {
    name: 'major-title',
    pr: pr({ title: 'chore(deps): update dependency foo to v2.0.0 (major)' }),
    entry: null,
    now: NOW,
  },
  {
    name: 'major-branch-dash',
    pr: pr({ headRefName: 'renovate/major-foo' }),
    entry: null,
    now: NOW,
  },
  {
    name: 'major-branch-slash',
    pr: pr({ headRefName: 'renovate/major/foo' }),
    entry: null,
    now: NOW,
  },
  {
    name: 'major-table-cell',
    pr: pr({ body: '| Update | Change |\n|---|---|\n| major | x |' }),
    entry: null,
    now: NOW,
  },
  {
    name: 'major-arrow-npm',
    pr: pr({ body: '| foo | `^1.2.3` → `^2.0.0` |' }),
    entry: null,
    now: NOW,
  },
  {
    name: 'major-arrow-docker',
    pr: pr({ body: '| foo | `v1` -> `v2` |' }),
    entry: null,
    now: NOW,
  },
  {
    name: 'minor-arrow',
    pr: pr({ body: '| foo | `1.2.3` → `1.3.0` |' }),
    entry: null,
    now: NOW,
  },
  {
    name: 'digest-row-not-major',
    pr: pr({ body: '| foo | digest | `1031993` → `2d178f2` |' }),
    entry: null,
    now: NOW,
  },
  {
    name: 'arrow-outside-table',
    pr: pr({ body: 'Bumps `1.0.0` → `2.0.0` in the changelog.' }),
    entry: null,
    now: NOW,
  },
  {
    name: 'major-skip',
    pr: pr({ title: 'chore(deps): update dependency foo to v2.0.0 (major)' }),
    entry: { majorNotified: true },
    now: NOW,
  },
  {
    name: 'major-beats-dirty',
    pr: pr({
      title: 'chore(deps): update dependency foo to v2.0.0 (major)',
      mergeStateStatus: 'DIRTY',
    }),
    entry: null,
    now: NOW,
  },
  {
    name: 'busy-beats-major',
    pr: pr({ title: 'chore(deps): update dependency foo to v2.0.0 (major)' }),
    entry: { agentBusy: true, agentStartedAt: iso(-60) },
    now: NOW,
  },

  { name: 'dirty', pr: pr({ mergeStateStatus: 'DIRTY' }), entry: null, now: NOW },
  { name: 'behind', pr: pr({ mergeStateStatus: 'BEHIND' }), entry: null, now: NOW },
  { name: 'unknown-merge-state', pr: pr({ mergeStateStatus: 'UNKNOWN' }), entry: null, now: NOW },

  {
    name: 'pending-checkrun',
    pr: pr({ statusCheckRollup: [checkRun('', 'IN_PROGRESS')] }),
    entry: null,
    now: NOW,
  },
  {
    name: 'pending-checkrun-queued',
    pr: pr({ statusCheckRollup: [checkRun('', 'QUEUED')] }),
    entry: null,
    now: NOW,
  },
  {
    name: 'pending-status-context',
    pr: pr({ statusCheckRollup: [statusContext('PENDING')] }),
    entry: null,
    now: NOW,
  },
  {
    name: 'pending-beats-failed',
    pr: pr({ statusCheckRollup: [checkRun('', 'IN_PROGRESS'), checkRun('FAILURE')] }),
    entry: null,
    now: NOW,
  },

  {
    name: 'failed-checkrun',
    pr: pr({ statusCheckRollup: [checkRun('FAILURE')] }),
    entry: null,
    now: NOW,
  },
  {
    name: 'failed-checkrun-cancelled',
    pr: pr({ statusCheckRollup: [checkRun('CANCELLED')] }),
    entry: null,
    now: NOW,
  },
  {
    name: 'failed-checkrun-timed-out',
    pr: pr({ statusCheckRollup: [checkRun('TIMED_OUT')] }),
    entry: null,
    now: NOW,
  },
  {
    name: 'failed-checkrun-action-required',
    pr: pr({ statusCheckRollup: [checkRun('ACTION_REQUIRED')] }),
    entry: null,
    now: NOW,
  },
  {
    name: 'failed-checkrun-startup-failure',
    pr: pr({ statusCheckRollup: [checkRun('STARTUP_FAILURE')] }),
    entry: null,
    now: NOW,
  },
  {
    name: 'failed-status-error',
    pr: pr({ statusCheckRollup: [statusContext('ERROR')] }),
    entry: null,
    now: NOW,
  },
  {
    name: 'skipped-and-neutral',
    pr: pr({ statusCheckRollup: [checkRun('SKIPPED'), checkRun('NEUTRAL')] }),
    entry: null,
    now: NOW,
  },
  { name: 'empty-rollup', pr: pr({ statusCheckRollup: [] }), entry: null, now: NOW },
  { name: 'clean', pr: pr(), entry: null, now: NOW },
  { name: 'has-hooks', pr: pr({ mergeStateStatus: 'HAS_HOOKS' }), entry: null, now: NOW },

  {
    name: 'needs-approval',
    pr: pr({
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'REVIEW_REQUIRED',
      mergeable: 'MERGEABLE',
    }),
    entry: null,
    now: NOW,
  },
  {
    name: 'blocked-changes-requested',
    pr: pr({ mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED' }),
    entry: null,
    now: NOW,
  },
  {
    name: 'blocked-review-conflicting',
    pr: pr({
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'REVIEW_REQUIRED',
      mergeable: 'CONFLICTING',
    }),
    entry: null,
    now: NOW,
  },
  {
    name: 'blocked-approved',
    pr: pr({ mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED' }),
    entry: null,
    now: NOW,
  },
  {
    name: 'blocked-at-threshold',
    pr: pr({ mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED' }),
    entry: { headSha: BASE_PR.headRefOid, blockedSince: iso(-7200) },
    now: NOW,
  },
  {
    name: 'blocked-under-threshold',
    pr: pr({ mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED' }),
    entry: { headSha: BASE_PR.headRefOid, blockedSince: iso(-7199) },
    now: NOW,
  },
  {
    name: 'blocked-since-other-head',
    pr: pr({ mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED' }),
    entry: { headSha: 'an-old-sha', blockedSince: iso(-99999) },
    now: NOW,
  },

  { name: 'unstable', pr: pr({ mergeStateStatus: 'UNSTABLE' }), entry: null, now: NOW },
  { name: 'draft-state', pr: pr({ mergeStateStatus: 'DRAFT' }), entry: null, now: NOW },

  {
    name: 'left-alone',
    pr: pr(),
    entry: null,
    now: NOW,
    boardItem: { item: 'x', outcome: 'leave' },
  },
  {
    name: 'left-alone-beats-busy',
    pr: pr(),
    entry: { agentBusy: true, agentStartedAt: iso(-60) },
    now: NOW,
    boardItem: { item: 'x', outcome: 'leave' },
  },
  {
    name: 'dispatch-outcome-classifies-normally',
    pr: pr(),
    entry: null,
    now: NOW,
    boardItem: { item: 'x', outcome: 'dispatch' },
  },
]

// -- tick cases --

const FULL_VIEW_FIELDS =
  'number,title,url,headRefName,headRefOid,mergeStateStatus,mergeable,baseRefName,statusCheckRollup,reviewDecision,body'

const searchStub = (
  owner: string,
  repo: string,
  number: number,
  title = BASE_PR.title
): Record<string, unknown> => ({
  number,
  title,
  url: `https://github.com/${owner}/${repo}/pull/${number}`,
  repository: { nameWithOwner: `${owner}/${repo}` },
})

const searchRule = (prs: unknown[]): FakeGhRule => ({ match: 'search prs', stdout: prs })
const searchOwnerRule = (owner: string, prs: unknown[]): FakeGhRule => ({
  match: `search prs.*--owner ${owner}`,
  stdout: prs,
})
const searchRepoRule = (repo: string, prs: unknown[]): FakeGhRule => ({
  match: `search prs.*--repo ${repo}(?: |$)`,
  stdout: prs,
})
const archivedRule = (archived = false): FakeGhRule => ({
  match: 'isArchived',
  stdout: { isArchived: archived },
})
const viewRule = (details: GhPrDetails): FakeGhRule => ({
  match: FULL_VIEW_FIELDS,
  stdout: details,
})
const viewFailsRule = (): FakeGhRule => ({ match: FULL_VIEW_FIELDS, exit: 1, stderr: 'HTTP 502\n' })
const raceGuardRule = (sha: string): FakeGhRule => ({ match: 'headRefOid --jq', stdout: sha })
const squashRule = (): FakeGhRule => ({
  match: 'squashMergeAllowed',
  stdout: { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false },
})
const approveRule = (): FakeGhRule => ({ match: 'pr review', stdout: '' })
const mergeRule = (exit = 0, stderr?: string): FakeGhRule => ({
  match: 'pr merge',
  stdout: '',
  ...(stderr !== undefined ? { stderr } : {}),
  ...(exit !== 0 ? { exit } : {}),
})
const updateBranchRule = (exit = 0, stderr?: string): FakeGhRule => ({
  match: 'update-branch',
  stdout: '',
  ...(stderr !== undefined ? { stderr } : {}),
  ...(exit !== 0 ? { exit } : {}),
})
const runListRule = (runs: unknown[]): FakeGhRule => ({ match: 'run list', stdout: runs })
const runRerunRule = (): FakeGhRule => ({ match: 'run rerun', stdout: '' })
const prListRule = (prs: unknown[] | null, exit = 0): FakeGhRule =>
  exit === 0 ? { match: 'pr list', stdout: prs } : { match: 'pr list', exit, stderr: 'HTTP 502\n' }

const mergeFlow = (headSha: string): FakeGhRule[] => [
  raceGuardRule(headSha),
  squashRule(),
  approveRule(),
  mergeRule(),
]

const CLEAN_PR = pr({ number: 1, url: 'https://github.com/acme/foo/pull/1' })
const BEHIND_PR = pr({
  number: 1,
  url: 'https://github.com/acme/foo/pull/1',
  mergeStateStatus: 'BEHIND',
})
const DIRTY_PR = pr({
  number: 1,
  url: 'https://github.com/acme/foo/pull/1',
  mergeStateStatus: 'DIRTY',
})
const NEEDS_APPROVAL_PR = pr({
  number: 1,
  url: 'https://github.com/acme/foo/pull/1',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'REVIEW_REQUIRED',
  mergeable: 'MERGEABLE',
})
const BLOCKED_CHANGES_REQUESTED_PR = pr({
  number: 1,
  url: 'https://github.com/acme/foo/pull/1',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'CHANGES_REQUESTED',
})
const BLOCKED_APPROVED_PR = pr({
  number: 1,
  url: 'https://github.com/acme/foo/pull/1',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'APPROVED',
})
const FAILED_CHECKRUN_PR = pr({
  number: 1,
  url: 'https://github.com/acme/foo/pull/1',
  headRefOid: 'failedsha1',
  statusCheckRollup: [checkRun('FAILURE')],
})
const FAILED_STATUS_PR = pr({
  number: 1,
  url: 'https://github.com/acme/foo/pull/1',
  headRefOid: 'failedsha1',
  statusCheckRollup: [statusContext('ERROR')],
})
const MAJOR_PR = pr({
  number: 1,
  url: 'https://github.com/acme/foo/pull/1',
  title: 'chore(deps): update dependency foo to v2.0.0 (major)',
})
const UNSTABLE_PR = pr({
  number: 1,
  url: 'https://github.com/acme/foo/pull/1',
  mergeStateStatus: 'UNSTABLE',
})

export const tickCases: TickCase[] = [
  { name: 'empty-search', env: {}, gh: [searchRule([])], state: null, now: NOW },

  {
    name: 'search-fails',
    env: {},
    gh: [{ match: 'search prs', exit: 1, stderr: 'HTTP 502\n' }],
    state: null,
    now: NOW,
  },

  {
    name: 'search-succeeds-with-stderr',
    env: {},
    gh: [{ match: 'search prs', stdout: [], stderr: 'warning: rate limit approaching\n' }],
    state: null,
    now: NOW,
  },

  {
    name: 'owner-and-repo-scope',
    env: { RENOVATE_MONITOR_SCOPE: 'acme/* other/lib' },
    gh: [
      searchOwnerRule('acme', [searchStub('acme', 'foo', 1)]),
      searchRepoRule('other/lib', [searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(
        pr({
          number: 1,
          url: 'https://github.com/acme/foo/pull/1',
          statusCheckRollup: [checkRun('', 'IN_PROGRESS')],
        })
      ),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'owner-and-repo-one-fails',
    env: { RENOVATE_MONITOR_SCOPE: 'acme/* other/lib' },
    gh: [
      searchOwnerRule('acme', [searchStub('acme', 'foo', 1)]),
      { match: 'search prs.*--repo other/lib(?: |$)', exit: 1, stderr: 'HTTP 500\n' },
      archivedRule(false),
      viewRule(
        pr({
          number: 1,
          url: 'https://github.com/acme/foo/pull/1',
          statusCheckRollup: [checkRun('', 'IN_PROGRESS')],
        })
      ),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'partial-scope-keeps-state',
    env: { RENOVATE_MONITOR_SCOPE: 'acme/* other/lib' },
    gh: [
      searchOwnerRule('acme', [searchStub('acme', 'foo', 1)]),
      { match: 'search prs.*--repo other/lib(?: |$)', exit: 1, stderr: 'HTTP 500\n' },
      archivedRule(false),
      viewRule(
        pr({
          number: 1,
          url: 'https://github.com/acme/foo/pull/1',
          statusCheckRollup: [checkRun('', 'IN_PROGRESS')],
        })
      ),
    ],
    state: {
      prs: {
        'acme/gone#7': { headSha: 'x', ciRetries: 1, lastSeenAt: iso(-999) },
      },
    },
    now: NOW,
  },

  {
    name: 'nonzero-exit-parseable-stdout-keeps-state',
    env: { RENOVATE_MONITOR_SCOPE: 'acme/* other/lib' },
    gh: [
      searchOwnerRule('acme', [searchStub('acme', 'foo', 1)]),
      { match: 'search prs.*--repo other/lib(?: |$)', stdout: [], exit: 1, stderr: 'HTTP 500\n' },
      archivedRule(false),
      viewRule(
        pr({
          number: 1,
          url: 'https://github.com/acme/foo/pull/1',
          statusCheckRollup: [checkRun('', 'IN_PROGRESS')],
        })
      ),
    ],
    state: {
      prs: {
        'acme/gone#7': { headSha: 'x', ciRetries: 1, lastSeenAt: iso(-999) },
      },
    },
    now: NOW,
  },

  {
    name: 'search-over-100',
    env: { RENOVATE_MONITOR_EXCLUDE: 'acme/excluded' },
    gh: [
      searchRule(
        Array.from({ length: 150 }, (_, i) =>
          searchStub('acme', 'excluded', i + 1, 'chore(deps): bump')
        )
      ),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'capped-scope-keeps-state',
    env: { RENOVATE_MONITOR_EXCLUDE: 'acme/excluded' },
    gh: [
      searchRule(
        Array.from({ length: 150 }, (_, i) =>
          searchStub('acme', 'excluded', i + 1, 'chore(deps): bump')
        )
      ),
    ],
    state: {
      prs: {
        'acme/gone#7': { headSha: 'x', ciRetries: 1, lastSeenAt: iso(-999) },
      },
    },
    now: NOW,
  },

  {
    name: 'mergeable-merges',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(CLEAN_PR),
      ...mergeFlow('abc123'),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'merge-race',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(CLEAN_PR),
      raceGuardRule('def456'),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'merge-fails',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(CLEAN_PR),
      raceGuardRule('abc123'),
      squashRule(),
      approveRule(),
      { match: 'pr merge', exit: 1, stderr: 'protected branch\n' },
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'merge-refused-head-moved',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(CLEAN_PR),
      { ...raceGuardRule('abc123'), once: true },
      squashRule(),
      approveRule(),
      mergeRule(1, 'GraphQL: Head branch was modified\n'),
      raceGuardRule('def456'),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'needs-approval-approves',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(NEEDS_APPROVAL_PR),
      ...mergeFlow('abc123'),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'needs-rebase-rebases',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(BEHIND_PR),
      updateBranchRule(),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'rebase-conflict-event',
    env: {},
    gh: [searchRule([searchStub('acme', 'foo', 1)]), archivedRule(false), viewRule(DIRTY_PR)],
    state: null,
    now: NOW,
  },

  {
    name: 'update-branch-conflict',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(BEHIND_PR),
      updateBranchRule(1, 'merge conflict\n'),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'ci-failed-first-retry',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(FAILED_CHECKRUN_PR),
      runListRule([{ databaseId: 111, conclusion: 'failure' }]),
      runRerunRule(),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'ci-failed-at-max',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(FAILED_CHECKRUN_PR),
    ],
    state: {
      prs: {
        'acme/foo#1': { headSha: 'failedsha1', ciRetries: 2, lastSeenAt: iso(-900) },
      },
    },
    now: NOW,
  },

  {
    name: 'ci-failed-new-head-resets',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(FAILED_CHECKRUN_PR),
      runListRule([{ databaseId: 111, conclusion: 'failure' }]),
      runRerunRule(),
    ],
    state: {
      prs: {
        'acme/foo#1': { headSha: 'an-old-sha', ciRetries: 2, lastSeenAt: iso(-900) },
      },
    },
    now: NOW,
  },

  {
    name: 'ci-failed-status-context',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(FAILED_STATUS_PR),
      runListRule([]),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'major-event',
    env: {},
    gh: [searchRule([searchStub('acme', 'foo', 1)]), archivedRule(false), viewRule(MAJOR_PR)],
    state: null,
    now: NOW,
  },

  {
    name: 'major-skip-quiet',
    env: {},
    gh: [searchRule([searchStub('acme', 'foo', 1)]), archivedRule(false), viewRule(MAJOR_PR)],
    state: {
      prs: { 'acme/foo#1': { majorNotified: true, headSha: 'abc123', lastSeenAt: iso(-900) } },
    },
    now: NOW,
  },

  {
    name: 'blocked-not-review',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(BLOCKED_CHANGES_REQUESTED_PR),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'blocked-records-since',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(BLOCKED_APPROVED_PR),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'blocked-at-threshold-escalates',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(BLOCKED_APPROVED_PR),
    ],
    state: {
      prs: {
        'acme/foo#1': {
          headSha: BLOCKED_APPROVED_PR.headRefOid,
          blockedSince: iso(-7200),
          lastSeenAt: iso(-900),
        },
      },
    },
    now: NOW,
  },

  {
    name: 'blocked-new-head-resets',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(BLOCKED_APPROVED_PR),
    ],
    state: {
      prs: {
        'acme/foo#1': {
          headSha: 'an-old-sha',
          blockedSince: iso(-99999),
          lastSeenAt: iso(-900),
        },
      },
    },
    now: NOW,
  },

  {
    name: 'excluded-repo',
    env: { RENOVATE_MONITOR_EXCLUDE: 'acme/foo' },
    gh: [searchRule([searchStub('acme', 'foo', 1)])],
    state: null,
    now: NOW,
  },

  {
    name: 'archived-repo',
    env: {},
    gh: [searchRule([searchStub('acme', 'foo', 1)]), archivedRule(true)],
    state: null,
    now: NOW,
  },

  {
    name: 'pr-view-fails',
    env: {},
    gh: [searchRule([searchStub('acme', 'foo', 1)]), archivedRule(false), viewFailsRule()],
    state: null,
    now: NOW,
  },

  {
    name: 'unknown-class',
    env: {},
    gh: [searchRule([searchStub('acme', 'foo', 1)]), archivedRule(false), viewRule(UNSTABLE_PR)],
    state: null,
    now: NOW,
  },

  {
    name: 'agent-busy-live',
    env: {},
    gh: [searchRule([searchStub('acme', 'foo', 1)]), archivedRule(false), viewRule(CLEAN_PR)],
    state: {
      prs: {
        'acme/foo#1': {
          agentBusy: true,
          agentStartedAt: iso(-60),
          headSha: 'abc123',
          lastSeenAt: iso(-60),
        },
      },
    },
    now: NOW,
  },

  {
    name: 'agent-busy-stale-pruned',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(CLEAN_PR),
      ...mergeFlow('abc123'),
    ],
    state: {
      prs: {
        'acme/foo#1': {
          agentBusy: true,
          agentStartedAt: iso(-7201),
          headSha: 'abc123',
          lastSeenAt: iso(-7201),
        },
      },
    },
    now: NOW,
  },

  {
    name: 'left-alone-quiet',
    env: {},
    gh: [searchRule([searchStub('acme', 'foo', 1)]), archivedRule(false), viewRule(CLEAN_PR)],
    state: {
      prs: {},
      boardItems: { 'acme/foo#1': { item: 'x', outcome: 'leave' } },
    },
    now: NOW,
  },

  {
    name: 'agent-busy-expired-keeps-ci-retries',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(FAILED_CHECKRUN_PR),
    ],
    state: {
      prs: {
        'acme/foo#1': {
          headSha: 'failedsha1',
          ciRetries: 2,
          agentBusy: true,
          agentStartedAt: iso(-7201),
        },
      },
    },
    now: NOW,
  },

  {
    name: 'closed-pr-pruned',
    env: {},
    gh: [searchRule([])],
    state: {
      prs: { 'acme/other#99': { headSha: 'x', ciRetries: 0, lastSeenAt: iso(-999) } },
    },
    now: NOW,
  },

  {
    name: 'human-pr-hold',
    env: { RENOVATE_MONITOR_HOLD_FOR_HUMAN_PRS: 'true' },
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(CLEAN_PR),
      prListRule([{ isDraft: false, author: { is_bot: false, login: 'alice' } }]),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'human-pr-bot-only',
    env: { RENOVATE_MONITOR_HOLD_FOR_HUMAN_PRS: 'true' },
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(CLEAN_PR),
      prListRule([
        { isDraft: false, author: { is_bot: false, login: 'renovate[bot]' } },
        { isDraft: true, author: { is_bot: false, login: 'carol' } },
      ]),
      ...mergeFlow('abc123'),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'human-pr-list-fails',
    env: { RENOVATE_MONITOR_HOLD_FOR_HUMAN_PRS: 'true' },
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(CLEAN_PR),
      prListRule(null, 1),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'human-pr-relaxed',
    env: {
      RENOVATE_MONITOR_HOLD_FOR_HUMAN_PRS: 'true',
      RENOVATE_MONITOR_HOLD_RELAX_HOURS: '0-8',
      RENOVATE_MONITOR_HOLD_RELAX_TZ: 'America/New_York',
    },
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(CLEAN_PR),
      ...mergeFlow('abc123'),
    ],
    state: null,
    now: '2026-09-24T07:00:00Z',
  },

  {
    name: 'human-pr-relax-wraps',
    env: {
      RENOVATE_MONITOR_HOLD_FOR_HUMAN_PRS: 'true',
      RENOVATE_MONITOR_HOLD_RELAX_HOURS: '22-6',
    },
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(CLEAN_PR),
      ...mergeFlow('abc123'),
    ],
    state: null,
    now: '2026-09-24T23:00:00Z',
  },

  {
    name: 'bad-scope',
    env: { RENOVATE_MONITOR_SCOPE: '' },
    gh: [],
    state: null,
    now: NOW,
  },

  // Pinned from hooks/test-renovate-pr-monitor-ci-retry.sh, before Task 4 drops that harness.
  {
    name: 'ci-retry-skipped-newer',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(FAILED_CHECKRUN_PR),
      runListRule([
        { databaseId: 36020982017, conclusion: 'skipped' },
        { databaseId: 36020981000, conclusion: 'failure' },
      ]),
      runRerunRule(),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'ci-retry-two-failed',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(FAILED_CHECKRUN_PR),
      runListRule([
        { databaseId: 3, conclusion: 'success' },
        { databaseId: 2, conclusion: 'timed_out' },
        { databaseId: 1, conclusion: 'failure' },
      ]),
      runRerunRule(),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'ci-retry-refused',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(FAILED_CHECKRUN_PR),
      runListRule([{ databaseId: 7, conclusion: 'failure' }]),
      {
        match: 'run rerun',
        exit: 1,
        stderr: 'run 7 cannot be rerun; This workflow run cannot be retried\n',
      },
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'ci-retry-many-runs',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(FAILED_CHECKRUN_PR),
      runListRule([
        ...Array.from({ length: 20 }, (_, i) => ({ databaseId: 100 + i, conclusion: 'success' })),
        { databaseId: 999, conclusion: 'failure' },
      ]),
      runRerunRule(),
    ],
    state: null,
    now: NOW,
  },

  {
    name: 'ci-retry-partial-refused',
    env: {},
    gh: [
      searchRule([searchStub('acme', 'foo', 1)]),
      archivedRule(false),
      viewRule(FAILED_CHECKRUN_PR),
      runListRule([
        { databaseId: 8, conclusion: 'failure' },
        { databaseId: 7, conclusion: 'failure' },
      ]),
      { match: 'run rerun 8', stdout: '' },
      {
        match: 'run rerun',
        exit: 1,
        stderr: 'run 7 cannot be rerun; This workflow run cannot be retried\n',
      },
    ],
    state: null,
    now: NOW,
  },

  // Pinned from hooks/test-renovate-pr-monitor-state.sh, before Task 4 drops that harness.
  // Covers both `migration` and `dry-run` scenarios in one case: runTick always produces a
  // dryRun capture alongside the live one, and state_ensure never writes under --dry-run, so
  // dryRun.state is the untouched legacy fixture and live.state proves the migration.
  {
    name: 'state-migration',
    env: {},
    gh: [searchRule([searchStub('acme', 'foo', 1)]), archivedRule(false), viewRule(MAJOR_PR)],
    state: {
      prs: {
        'acme/foo#1': {
          head_sha: 'abc123',
          ci_retries: 0,
          agent_busy: false,
          agent_started_at: iso(-600),
          major_notified: true,
          last_seen_at: '2026-06-01T00:00:00Z',
        },
      },
    },
    now: NOW,
  },

  // Covers both `null-entry` and `non-object-entry` scenarios: state_load's
  // `select(type=="object")` drops every non-object shape the same way.
  {
    name: 'state-invalid-entries',
    env: {},
    gh: [searchRule([])],
    state: {
      prs: {
        'acme/foo#2': null,
        'acme/foo#3': 'oops',
        'acme/foo#4': [1, 2],
        'acme/foo#5': true,
        'acme/foo#6': 42,
      },
    },
    now: NOW,
  },
]
