// Ported from scripts/renovate-pr-monitor.sh's tick, handle_pr, hold_relaxed_now and
// repo_has_open_human_pr.
import { classify, isFailingCheck, type GhPrDetails, type RenovatePrState } from './classify.ts'
import { type MonitorConfig, repoIsExcluded } from './config.ts'
import { emitEvent, emitMajorsEvent, markAgentBusy, type MajorPr } from './events.ts'
import { listOpenPrs, listRenovatePrs, repoIsArchived, viewPr } from './gh.ts'
import {
  type BoardItem,
  deletePrState,
  ensureState,
  getBoardItem,
  getPrState,
  patchPrState,
  prunePrState,
} from './state.ts'
import {
  markMergeNow,
  mergeThrottle,
  routineCiRetry,
  routineMerge,
  routineRebase,
} from './routines.ts'
import { ShutdownAbort } from './monitor-exit.ts'
import { nowIsoSeconds } from './time.ts'

const sessionMerged: string[] = []
const sessionRebased: string[] = []
const sessionCiRetried: string[] = []
const sessionMajors: MajorPr[] = []
let tickWorkDone = false
let tickPendingCount = 0
let tickHeld: string[] = []
const humanPrCache = new Map<string, boolean>()

export const sessionSummary = () => ({
  merged: sessionMerged,
  rebased: sessionRebased,
  ciRetried: sessionCiRetried,
  held: tickHeld,
  workDone: tickWorkDone,
  pendingCount: tickPendingCount,
})

export const tick = async (
  config: MonitorConfig,
  dryRun: boolean,
  verbose: boolean,
  shutdownSignal?: AbortSignal
): Promise<void> => {
  tickWorkDone = false
  tickPendingCount = 0
  tickHeld = []
  humanPrCache.clear()
  ensureState(config.stateFile, dryRun, config.legacyStateFile)

  const result = await listRenovatePrs(config, shutdownSignal)
  if (result.kind === 'search-failed') {
    console.error(`[tick] gh search failed: ${result.stderr}`)
    console.error('gh search returned no results to union — skipping this tick')
    tickPendingCount += 1
    return
  }
  if (result.stderr !== '') {
    console.error(`[tick] gh search warning: ${result.stderr}`)
  }

  const prs = result.prs
  if (result.complete) {
    const openKeys = prs.map((pr) => `${pr.repository.nameWithOwner}#${pr.number}`)
    prunePrState(config.stateFile, openKeys, Math.floor(Date.now() / 1000), dryRun)
  } else {
    console.log('[tick] search incomplete (a scope failed or hit its limit) — not pruning state')
    tickPendingCount += 1
  }

  console.log(`[tick] ${nowIsoSeconds()} — found ${prs.length} open Renovate PR(s) in scope`)

  for (const pr of prs) {
    if (shutdownSignal?.aborted) {
      throw new ShutdownAbort()
    }
    const prKey = `${pr.repository.nameWithOwner}#${pr.number}`
    const repo = pr.repository.nameWithOwner

    if (repoIsExcluded(config, repo)) {
      if (verbose) {
        console.log(`[tick] ${prKey} — skip (excluded repo)`)
      }
      continue
    }
    if (await repoIsArchived(repo, shutdownSignal)) {
      if (verbose) {
        console.log(`[tick] ${prKey} — skip (archived repo)`)
      }
      continue
    }

    const prDetails = await viewPr(repo, pr.number, shutdownSignal)
    if (prDetails === null) {
      console.log(`[tick] ${prKey} — gh pr view failed; skipping`)
      tickPendingCount += 1
      continue
    }

    const stateEntry = getPrState(config.stateFile, prKey, config.legacyStateFile)
    const boardItem = getBoardItem(config.stateFile, prKey, config.legacyStateFile) ?? null
    await handlePr(
      prKey,
      repo,
      prDetails,
      stateEntry,
      boardItem,
      config,
      dryRun,
      verbose,
      shutdownSignal
    )
  }

  if (shutdownSignal?.aborted) {
    throw new ShutdownAbort()
  }
  if (sessionMajors.length > 0) {
    emitMajorsEvent(sessionMajors, dryRun)
  }

  console.log('[tick] done — no escalations')
}

const handlePr = async (
  prKey: string,
  repo: string,
  prDetails: GhPrDetails,
  stateEntry: RenovatePrState | undefined,
  boardItem: BoardItem | null,
  config: MonitorConfig,
  dryRun: boolean,
  verbose: boolean,
  shutdownSignal?: AbortSignal
): Promise<void> => {
  const prNumber = prDetails.number
  const headSha = prDetails.headRefOid
  const title = prDetails.title
  const nowIso = nowIsoSeconds()
  const nowEpochSeconds = Math.floor(Date.now() / 1000)

  const headChanged = stateEntry?.headSha !== headSha

  let priorRetries = 0
  if (stateEntry !== undefined && !headChanged) {
    priorRetries = stateEntry.ciRetries ?? 0
  }

  const cls = classify(prDetails, stateEntry ?? null, nowEpochSeconds, boardItem)

  const clearBlockedSince =
    stateEntry?.blockedSince !== undefined &&
    (headChanged || (cls !== 'blocked' && cls !== 'blocked-stuck'))

  patchPrState(
    config.stateFile,
    prKey,
    {
      headSha,
      lastSeenAt: nowIso,
      ciRetries: priorRetries,
      ...(clearBlockedSince ? { blockedSince: undefined } : {}),
    },
    dryRun
  )

  if (
    verbose ||
    (cls !== 'skip' &&
      cls !== 'ci-pending' &&
      cls !== 'agent-busy' &&
      cls !== 'left-alone' &&
      cls !== 'major-skip' &&
      cls !== 'blocked')
  ) {
    console.log(`[tick] ${prKey} — ${cls} — ${title}`)
  }

  switch (cls) {
    case 'agent-busy':
    case 'left-alone':
      tickHeld.push(prKey)
      return

    case 'skip':
    case 'ci-pending':
      tickPendingCount += 1
      return

    case 'major':
      sessionMajors.push({ key: prKey, url: prDetails.url, title })
      return

    case 'major-skip':
      return

    case 'needs-rebase': {
      const rc = await routineRebase(repo, prNumber, dryRun, shutdownSignal)
      if (rc === 'ok') {
        if (!dryRun) {
          console.log(`[tick] ${prKey} — rebased onto base; will wait for CI next tick`)
          sessionRebased.push(prKey)
          tickWorkDone = true
          tickPendingCount += 1
        }
      } else if (rc === 'conflict') {
        console.log(`[tick] ${prKey} — update-branch hit conflicts; escalating`)
        markAgentBusy(config.stateFile, prKey, dryRun)
        emitEvent('rebase-conflict', prDetails, {}, dryRun)
      } else {
        console.log(`[tick] ${prKey} — update-branch failed unexpectedly; escalating`)
        markAgentBusy(config.stateFile, prKey, dryRun)
        emitEvent('unknown', prDetails, { rawState: 'update-branch failed' }, dryRun)
      }
      return
    }

    case 'ci-failed': {
      if (priorRetries < config.maxCiRetries) {
        const retryResult = await routineCiRetry(repo, headSha, dryRun, shutdownSignal)
        if (retryResult.outcome === 'ok') {
          if (!dryRun) {
            patchPrState(config.stateFile, prKey, { ciRetries: priorRetries + 1 }, false)
            console.log(`[tick] ${prKey} — CI retry #${priorRetries + 1} queued`)
            sessionCiRetried.push(prKey)
            tickWorkDone = true
            tickPendingCount += 1
          }
          return
        }
        if (retryResult.outcome === 'no-failed-run') {
          console.log(`[tick] ${prKey} — no failed workflow run to retry; escalating`)
        } else {
          markAgentBusy(config.stateFile, prKey, dryRun)
          if (retryResult.queued > 0) {
            patchPrState(config.stateFile, prKey, { ciRetries: priorRetries + 1 }, dryRun)
          }
          emitEvent(
            'unknown',
            prDetails,
            { rawState: `CI retry failed: ${retryResult.error}` },
            dryRun
          )
          return
        }
      } else {
        console.log(`[tick] ${prKey} — CI still failing after ${priorRetries} retries; escalating`)
      }
      markAgentBusy(config.stateFile, prKey, dryRun)
      const failing = prDetails.statusCheckRollup
        .filter(isFailingCheck)
        .map((item) => (item.__typename === 'CheckRun' ? item.name : item.context))
      emitEvent('ci-failed', prDetails, { ciRetries: priorRetries, failingJobs: failing }, dryRun)
      return
    }

    case 'rebase-conflict':
      markAgentBusy(config.stateFile, prKey, dryRun)
      emitEvent('rebase-conflict', prDetails, {}, dryRun)
      return

    case 'blocked':
      if (headChanged || stateEntry?.blockedSince === undefined) {
        patchPrState(config.stateFile, prKey, { blockedSince: nowIso }, dryRun)
      }
      tickPendingCount += 1
      return

    case 'blocked-stuck':
      markAgentBusy(config.stateFile, prKey, dryRun)
      emitEvent('unknown', prDetails, { rawState: `blocked: ${prDetails.reviewDecision}` }, dryRun)
      return

    case 'needs-approval':
    case 'mergeable': {
      if (
        config.holdForHumanPrs &&
        !holdRelaxedNow(config) &&
        (await repoHasOpenHumanPr(config, repo, shutdownSignal))
      ) {
        console.log(`[tick] ${prKey} — merge held (${cls})`)
        tickHeld.push(prKey)
        return
      }
      await mergeThrottle(config.mergeDelaySeconds, dryRun, shutdownSignal)
      const rc = await routineMerge(repo, prNumber, headSha, dryRun, shutdownSignal)
      if (rc === 'ok') {
        markMergeNow(Math.floor(Date.now() / 1000))
        if (!dryRun) {
          console.log(`[tick] ${prKey} — merged (${cls})`)
          deletePrState(config.stateFile, prKey, false)
          sessionMerged.push(prKey)
          tickWorkDone = true
        }
      } else if (rc === 'race') {
        console.log(`[tick] ${prKey} — merge skipped (head moved); will retry next tick`)
        tickPendingCount += 1
      } else {
        console.log(`[tick] ${prKey} — merge failed unexpectedly; escalating`)
        markAgentBusy(config.stateFile, prKey, dryRun)
        emitEvent('unknown', prDetails, { rawState: 'merge failed' }, dryRun)
      }
      return
    }

    default:
      markAgentBusy(config.stateFile, prKey, dryRun)
      emitEvent('unknown', prDetails, { rawState: cls }, dryRun)
  }
}

// -- hold_relaxed_now --

const currentHourInZone = (timeZone: string): number => {
  const tz = timeZone === '' ? undefined : timeZone
  try {
    return hourInZone(tz)
  } catch {
    return hourInZone('UTC')
  }
}

const hourInZone = (timeZone: string | undefined): number =>
  Number.parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(
      new Date()
    ),
    10
  )

const holdRelaxedNow = (config: MonitorConfig): boolean => {
  if (config.holdRelaxStart === null || config.holdRelaxEnd === null) {
    return false
  }
  const cur = currentHourInZone(config.holdRelaxTz)
  const start = config.holdRelaxStart
  const end = config.holdRelaxEnd
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end
}

// -- repo_has_open_human_pr --

interface OpenPrSummary {
  isDraft: boolean
  author: { is_bot: boolean; login: string }
}

const repoHasOpenHumanPr = async (
  config: MonitorConfig,
  repo: string,
  signal?: AbortSignal
): Promise<boolean> => {
  const cached = humanPrCache.get(repo)
  if (cached !== undefined) {
    return cached
  }

  const result = await listOpenPrs(repo, signal)
  if (result.code !== 0) {
    console.log(
      `[tick] ${repo} — couldn't check for human PRs (gh pr list failed); holding merges this tick (fail-closed)`
    )
    humanPrCache.set(repo, true)
    return true
  }
  const prs = JSON.parse(result.stdout) as OpenPrSummary[]
  const hasHuman = prs.some((pr) => {
    if (pr.isDraft || pr.author.is_bot) {
      return false
    }
    const login = pr.author.login.toLowerCase()
    if (login.endsWith('[bot]')) {
      return false
    }
    return !config.nonhumanAuthors.includes(login)
  })
  if (hasHuman) {
    console.log(
      `[tick] ${repo} — open non-draft human PR present; holding Renovate merges this tick`
    )
    humanPrCache.set(repo, true)
    return true
  }
  humanPrCache.set(repo, false)
  return false
}
