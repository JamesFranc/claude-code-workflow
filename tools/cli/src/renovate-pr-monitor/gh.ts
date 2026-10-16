// Ported from scripts/renovate-pr-monitor.sh's gh wrappers: gh_list_renovate_prs, gh_view_pr and
// repo_is_archived, plus one wrapper per remaining `gh` call the routines and tick use. Every call
// is spawned through PATH with argv byte-identical to the bash, and gh's own --jq flag does the
// same filtering it does there — this module never shells out to a separate jq.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GhPrDetails } from './classify.ts'
import type { MonitorConfig } from './config.ts'
import { ShutdownAbort } from './monitor-exit.ts'

const execFileAsync = promisify(execFile)

export interface GhCallResult {
  code: number
  stdout: string
  stderr: string
}

// The one shared gh-call path every wrapper below routes through, so a shutdown signal only ever
// needs checking here: before dispatch (never issue another call once aborted), and after the call
// settles either way (never act on a result — success or failure — produced after the signal fired).
const runGh = async (args: string[], signal?: AbortSignal): Promise<GhCallResult> => {
  if (signal?.aborted) {
    throw new ShutdownAbort()
  }
  try {
    const { stdout, stderr } = await execFileAsync('gh', args, { encoding: 'utf-8' })
    if (signal?.aborted) {
      throw new ShutdownAbort()
    }
    return { code: 0, stdout, stderr }
  } catch (err) {
    if (err instanceof ShutdownAbort) {
      throw err
    }
    if (signal?.aborted) {
      throw new ShutdownAbort()
    }
    const e = err as { code?: unknown; stdout?: string; stderr?: string }
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }
  }
}

// -- gh_list_renovate_prs --

const SEARCH_FIELDS = 'repository,number,title,url'

export interface RenovatePrSearchItem {
  number: number
  title: string
  url: string
  repository: { nameWithOwner: string }
}

export type ListRenovatePrsResult =
  | { kind: 'ok'; prs: RenovatePrSearchItem[]; complete: boolean; stderr: string }
  | { kind: 'search-failed'; stderr: string }

const SEARCH_LIMIT = 100

const searchArgs = (
  config: MonitorConfig,
  scopeFlag: '--owner' | '--repo',
  values: string[]
): string[] => [
  'search',
  'prs',
  '--author',
  config.author,
  '--state',
  'open',
  '--limit',
  String(SEARCH_LIMIT),
  '--json',
  SEARCH_FIELDS,
  ...values.flatMap((v) => [scopeFlag, v]),
]

// bash's $(...) command substitution strips all trailing newlines.
export const trimTrailingNewlines = (s: string): string => s.replace(/\n+$/, '')

const tryParseJsonArray = (stdout: string): RenovatePrSearchItem[] | undefined => {
  try {
    return JSON.parse(stdout) as RenovatePrSearchItem[]
  } catch {
    return undefined
  }
}

// Runs the owner search, then the repo search — each only if that scope is configured — and
// unions the results. If no search produced parseable JSON, the union has nothing to work with
// ('search-failed'). `complete` is true only when every configured scope exited zero, parsed, and
// returned fewer than SEARCH_LIMIT items — the caller prunes vanished PRs from state only when it
// is. A nonzero-exit scope's parseable stdout is still unioned in, just not trusted for
// completeness. Any stderr from either call is combined and returned so the caller can log it
// without failing the tick over it.
export const listRenovatePrs = async (
  config: MonitorConfig,
  signal?: AbortSignal
): Promise<ListRenovatePrsResult> => {
  const results: GhCallResult[] = []
  if (config.scopeOwners.length > 0) {
    results.push(await runGh(searchArgs(config, '--owner', config.scopeOwners), signal))
  }
  if (config.scopeRepos.length > 0) {
    results.push(await runGh(searchArgs(config, '--repo', config.scopeRepos), signal))
  }

  const parsed = results.map((r) => tryParseJsonArray(r.stdout))
  const stderr = trimTrailingNewlines(results.map((r) => r.stderr).join(''))
  if (parsed.every((p) => p === undefined)) {
    return { kind: 'search-failed', stderr }
  }

  const complete = parsed.every(
    (p, i) => results[i].code === 0 && p !== undefined && p.length < SEARCH_LIMIT
  )
  const items = parsed.flatMap((p) => p ?? [])
  return {
    kind: 'ok',
    prs: uniqueByKey(items, (item) => `${item.repository.nameWithOwner}#${item.number}`),
    complete,
    stderr,
  }
}

// jq's unique_by(f): group by f, sorted by the key string, keeping the first (in original array
// order) element of each group.
export const uniqueByKey = <T>(items: readonly T[], keyFn: (item: T) => string): T[] => {
  const firstByKey = new Map<string, T>()
  for (const item of items) {
    const key = keyFn(item)
    if (!firstByKey.has(key)) {
      firstByKey.set(key, item)
    }
  }
  return [...firstByKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, item]) => item)
}

// -- gh_view_pr --

const VIEW_FIELDS =
  'number,title,url,headRefName,headRefOid,mergeStateStatus,mergeable,baseRefName,statusCheckRollup,reviewDecision,body'

export const viewPr = async (
  repo: string,
  prNumber: number,
  signal?: AbortSignal
): Promise<GhPrDetails | null> => {
  const result = await runGh(
    ['pr', 'view', String(prNumber), '--repo', repo, '--json', VIEW_FIELDS],
    signal
  )
  return result.code === 0 ? (JSON.parse(result.stdout) as GhPrDetails) : null
}

// -- repo_is_archived --
//
// Only a definitive answer is cached (process-lifetime). A failed or unrecognized result is not
// cached and fails open (treated as not-archived) for this call only.
const archivedCache = new Map<string, boolean>()

export const repoIsArchived = async (repo: string, signal?: AbortSignal): Promise<boolean> => {
  const cached = archivedCache.get(repo)
  if (cached !== undefined) {
    return cached
  }

  const result = await runGh(
    ['repo', 'view', repo, '--json', 'isArchived', '--jq', '.isArchived'],
    signal
  )
  if (result.code !== 0) {
    console.error(
      `[repo_is_archived] ${repo} — gh repo view failed (rc=${result.code}); not caching, rechecking next tick`
    )
    return false
  }
  const archived = result.stdout.trim()
  if (archived === 'true' || archived === 'false') {
    const isArchived = archived === 'true'
    archivedCache.set(repo, isArchived)
    return isArchived
  }
  console.error(
    `[repo_is_archived] ${repo} — unexpected isArchived value '${archived}'; not caching, rechecking next tick`
  )
  return false
}

// -- routine_rebase --

export const updateBranch = (
  repo: string,
  prNumber: number,
  signal?: AbortSignal
): Promise<GhCallResult> => runGh(['pr', 'update-branch', '--repo', repo, String(prNumber)], signal)

// -- routine_ci_retry --

const RUN_LIST_FAILED_FILTER =
  '.[] | select(.conclusion == "failure" or .conclusion == "timed_out"\n' +
  '            or .conclusion == "cancelled" or .conclusion == "startup_failure") | .databaseId'

export const listFailedRunIds = (
  repo: string,
  headSha: string,
  signal?: AbortSignal
): Promise<GhCallResult> =>
  runGh(
    [
      'run',
      'list',
      '--repo',
      repo,
      '--commit',
      headSha,
      '--limit',
      '100',
      '--json',
      'databaseId,conclusion',
      '--jq',
      RUN_LIST_FAILED_FILTER,
    ],
    signal
  )

export const rerunRun = (
  runId: string,
  repo: string,
  signal?: AbortSignal
): Promise<GhCallResult> => runGh(['run', 'rerun', runId, '--failed', '--repo', repo], signal)

// -- routine_merge / detect_merge_method --

export const currentHeadRefOid = (
  repo: string,
  prNumber: number,
  signal?: AbortSignal
): Promise<GhCallResult> =>
  runGh(
    ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'headRefOid', '--jq', '.headRefOid'],
    signal
  )

export const repoMergeFlags = (repo: string, signal?: AbortSignal): Promise<GhCallResult> =>
  runGh(
    ['repo', 'view', repo, '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed'],
    signal
  )

export const approvePr = (
  repo: string,
  prNumber: number,
  signal?: AbortSignal
): Promise<GhCallResult> =>
  runGh(['pr', 'review', '--approve', '--repo', repo, String(prNumber)], signal)

export const mergePr = (
  repo: string,
  prNumber: number,
  method: string,
  expectedSha: string,
  signal?: AbortSignal
): Promise<GhCallResult> =>
  runGh(
    [
      'pr',
      'merge',
      `--${method}`,
      '--delete-branch',
      '--match-head-commit',
      expectedSha,
      '--repo',
      repo,
      String(prNumber),
    ],
    signal
  )

// -- repo_has_open_human_pr --

export const listOpenPrs = (repo: string, signal?: AbortSignal): Promise<GhCallResult> =>
  runGh(
    ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'isDraft,author'],
    signal
  )
