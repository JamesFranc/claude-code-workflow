// Ported from scripts/renovate-pr-monitor.sh's emit_event, emit_all_done, emit_majors_event and
// mark_agent_busy. A live (non-dry-run) emission ends the process — bash's `exit 0` becomes a
// throw of MonitorExit, caught by the command entry point.
import type { GhPrDetails } from './classify.ts'
import { uniqueByKey } from './gh.ts'
import { MonitorExit } from './monitor-exit.ts'
import { patchPrState } from './state.ts'
import { nowIsoSeconds } from './time.ts'

const GITHUB_PR_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/pull/

const prUrlOwnerRepo = (url: string): { owner: string | null; repo: string | null } => {
  const m = GITHUB_PR_URL_RE.exec(url)
  return { owner: m?.[1] ?? null, repo: m?.[2] ?? null }
}

export type MonitorEvent = 'rebase-conflict' | 'ci-failed' | 'unknown'

export const emitEvent = (
  eventType: MonitorEvent,
  pr: GhPrDetails,
  context: Record<string, unknown>,
  dryRun: boolean
): void => {
  if (dryRun) {
    console.log(`[dry-run] would emit event=${eventType} on ${pr.url}`)
    return
  }
  const { owner, repo } = prUrlOwnerRepo(pr.url)
  const eventJson = {
    event: eventType,
    pr: {
      owner,
      repo,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      headBranch: pr.headRefName,
      headSha: pr.headRefOid,
      baseBranch: pr.baseRefName,
    },
    context,
  }
  console.log(JSON.stringify(eventJson, null, 2))
  console.log('')
  console.log(`Monitor exiting: ${eventType} on ${eventJson.pr.url}`)
  console.log('See skills/renovate-prs/references/monitor-runbook.md for the remediation runbook.')
  throw new MonitorExit(0)
}

export const emitAllDone = (
  merged: readonly string[],
  rebased: readonly string[],
  ciRetried: readonly string[],
  held: readonly string[],
  dryRun: boolean
): void => {
  if (dryRun) {
    console.log('[dry-run] would emit event=all-done with session summary')
    throw new MonitorExit(0)
  }
  const total = merged.length + rebased.length + ciRetried.length
  const eventJson = {
    event: 'all-done',
    summary: { merged, rebased, ciRetried, held, totalActions: total },
  }
  console.log(JSON.stringify(eventJson, null, 2))
  console.log('')
  console.log(
    `Monitor exiting: all-done — ${total} action(s) completed across this session (${held.length} PR(s) held).`
  )
  console.log(
    'See skills/renovate-prs/references/monitor-runbook.md for the all-done runbook (board retitle + restart).'
  )
  throw new MonitorExit(0)
}

export interface MajorPr {
  key: string
  url: string
  title: string
}

export const emitMajorsEvent = (majors: readonly MajorPr[], dryRun: boolean): void => {
  const deduped = uniqueByKey(majors, (m) => m.key)
  if (dryRun) {
    console.log(`[dry-run] would emit event=majors-for-review for ${deduped.length} PR(s):`)
    for (const m of deduped) {
      console.log(`  - ${m.key} — ${m.title}`)
    }
    return
  }
  const eventJson = { event: 'majors-for-review', majors: deduped }
  console.log(JSON.stringify(eventJson, null, 2))
  console.log('')
  console.log(
    `Monitor exiting: majors-for-review — ${deduped.length} major bump(s) need your review (not auto-merged).`
  )
  console.log(
    'See skills/renovate-prs/references/monitor-runbook.md for the majors-for-review runbook (board question + mark notified + restart).'
  )
  throw new MonitorExit(0)
}

// Caller is expected to emit the event immediately after (so a crashed Claude session can be
// recovered via the 2h timeout in state.ts's prunePrState).
export const markAgentBusy = (stateFile: string, prKey: string, dryRun: boolean): void => {
  if (dryRun) {
    console.log(`[dry-run] would mark agentBusy on ${prKey}`)
    return
  }
  patchPrState(stateFile, prKey, { agentBusy: true, agentStartedAt: nowIsoSeconds() }, false)
}
