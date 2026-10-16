// Ported from scripts/renovate-pr-monitor.sh's routine_rebase, routine_ci_retry, routine_merge,
// detect_merge_method and merge_throttle.
import { setTimeout as sleep } from 'node:timers/promises'
import {
  approvePr,
  currentHeadRefOid,
  listFailedRunIds,
  mergePr,
  repoMergeFlags,
  rerunRun,
  trimTrailingNewlines,
  updateBranch,
} from './gh.ts'
import { ShutdownAbort } from './monitor-exit.ts'

export type RebaseOutcome = 'ok' | 'conflict' | 'failed'

export const routineRebase = async (
  repo: string,
  prNumber: number,
  dryRun: boolean,
  signal?: AbortSignal
): Promise<RebaseOutcome> => {
  if (dryRun) {
    console.log(`[dry-run] would rebase ${repo}#${prNumber}`)
    return 'ok'
  }
  const result = await updateBranch(repo, prNumber, signal)
  if (result.code === 0) {
    return 'ok'
  }
  const output = trimTrailingNewlines(result.stdout + result.stderr)
  if (/conflict|cannot be updated/i.test(output)) {
    return 'conflict'
  }
  console.error(`[routine_rebase] ${repo}#${prNumber} unexpected failure: ${output}`)
  return 'failed'
}

export type CiRetryOutcome =
  | { outcome: 'ok'; queued: number }
  | { outcome: 'no-failed-run' }
  | { outcome: 'error'; queued: number; error: string }

export const routineCiRetry = async (
  repo: string,
  headSha: string,
  dryRun: boolean,
  signal?: AbortSignal
): Promise<CiRetryOutcome> => {
  if (dryRun) {
    console.log(`[dry-run] would retry failed jobs on ${repo}@${headSha}`)
    return { outcome: 'ok', queued: 0 }
  }
  const listed = await listFailedRunIds(repo, headSha, signal)
  if (listed.code !== 0) {
    const error = `gh run list exited ${listed.code}`
    console.error(`[routine_ci_retry] ${repo}@${headSha} — ${error}`)
    return { outcome: 'error', queued: 0, error }
  }
  const runIds = listed.stdout
    .trim()
    .split(/\s+/)
    .filter((id) => id.length > 0)
  if (runIds.length === 0) {
    console.error(`[routine_ci_retry] ${repo}@${headSha} — no failed workflow run`)
    return { outcome: 'no-failed-run' }
  }
  let queued = 0
  for (const runId of runIds) {
    const result = await rerunRun(runId, repo, signal)
    if (result.code !== 0) {
      const output = trimTrailingNewlines(result.stdout + result.stderr)
      const error = `gh run rerun ${runId} failed: ${output}`
      console.error(`[routine_ci_retry] ${repo}@${headSha} — ${error}`)
      return { outcome: 'error', queued, error }
    }
    queued += 1
  }
  return { outcome: 'ok', queued }
}

export type MergeMethod = 'squash' | 'merge' | 'rebase'

export const detectMergeMethod = async (
  repo: string,
  signal?: AbortSignal
): Promise<MergeMethod | null> => {
  const flags = await repoMergeFlags(repo, signal)
  if (flags.code !== 0) {
    console.error(
      `[detect_merge_method] ${repo} — gh repo view failed: ${trimTrailingNewlines(flags.stderr)}`
    )
    return null
  }
  const parsed = JSON.parse(flags.stdout) as {
    squashMergeAllowed?: boolean
    mergeCommitAllowed?: boolean
    rebaseMergeAllowed?: boolean
  }
  const squashOk = parsed.squashMergeAllowed === true
  const mergeOk = parsed.mergeCommitAllowed === true
  const rebaseOk = parsed.rebaseMergeAllowed === true
  if (squashOk) {
    return 'squash'
  }
  if (mergeOk) {
    return 'merge'
  }
  if (rebaseOk) {
    return 'rebase'
  }
  console.error(
    `[detect_merge_method] ${repo} — no merge strategies allowed (squash=${squashOk} merge=${mergeOk} rebase=${rebaseOk})`
  )
  return null
}

export type MergeOutcome = 'ok' | 'race' | 'failed'

export const routineMerge = async (
  repo: string,
  prNumber: number,
  expectedSha: string,
  dryRun: boolean,
  signal?: AbortSignal
): Promise<MergeOutcome> => {
  if (dryRun) {
    console.log(
      `[dry-run] would approve + merge ${repo}#${prNumber} (expected head ${expectedSha})`
    )
    return 'ok'
  }

  const raceGuard = await currentHeadRefOid(repo, prNumber, signal)
  if (raceGuard.code !== 0) {
    console.error(
      `[routine_merge] ${repo}#${prNumber} — race-guard gh failed: ${trimTrailingNewlines(raceGuard.stdout + raceGuard.stderr)}`
    )
    return 'failed'
  }
  const currentSha = raceGuard.stdout.trim()
  if (currentSha !== expectedSha) {
    console.error(
      `[routine_merge] ${repo}#${prNumber} — head moved (${expectedSha} -> ${currentSha}); skipping this tick`
    )
    return 'race'
  }

  const method = await detectMergeMethod(repo, signal)
  if (method === null) {
    return 'failed'
  }

  const approved = await approvePr(repo, prNumber, signal)
  if (approved.code !== 0) {
    console.error(
      `[routine_merge] ${repo}#${prNumber} — approve returned non-zero (may already be approved); continuing`
    )
  }

  const merged = await mergePr(repo, prNumber, method, expectedSha, signal)
  if (merged.stdout) {
    process.stdout.write(merged.stdout)
  }
  if (merged.stderr) {
    process.stderr.write(merged.stderr)
  }
  if (merged.code === 0) {
    return 'ok'
  }
  const after = await currentHeadRefOid(repo, prNumber, signal)
  const afterSha = after.code === 0 ? after.stdout.trim() : null
  if (afterSha !== null && afterSha !== expectedSha) {
    console.error(
      `[routine_merge] ${repo}#${prNumber} — merge refused, head moved (${expectedSha} -> ${afterSha}); skipping this tick`
    )
    return 'race'
  }
  return 'failed'
}

let sessionLastMergeEpoch = 0

export const markMergeNow = (nowEpochSeconds: number): void => {
  sessionLastMergeEpoch = nowEpochSeconds
}

export const mergeThrottle = async (
  mergeDelaySeconds: number,
  dryRun: boolean,
  signal?: AbortSignal
): Promise<void> => {
  if (mergeDelaySeconds <= 0) {
    return
  }
  if (sessionLastMergeEpoch === 0) {
    return
  }

  const elapsed = Math.floor(Date.now() / 1000) - sessionLastMergeEpoch
  const remaining = mergeDelaySeconds - elapsed
  if (remaining <= 0) {
    return
  }

  if (dryRun) {
    console.log(`[dry-run] would wait ${remaining}s (inter-merge delay) before this merge`)
    return
  }
  console.log(`[tick] inter-merge delay — sleeping ${remaining}s before next merge`)
  try {
    await sleep(remaining * 1000, undefined, { signal })
  } catch {
    throw new ShutdownAbort()
  }
}
