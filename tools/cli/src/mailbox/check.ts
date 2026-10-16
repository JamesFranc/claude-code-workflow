import { resolveSessionId, tryResolveRawSessionId } from '../dashboard/session-id.ts'
import { loadState } from '../dashboard/state.ts'
import { loadRegistry, RegistryUnreadableError } from '../dashboard/registry.ts'
import { invokeDashboardBin, resolveDashboardBin } from '../dashboard/invoke.ts'
import { formatReleasedEntry, parseReleasedItems } from '../dashboard/released.ts'
import { pollWatched } from '../pr-monitor/poll.ts'
import {
  formatMonitorDeath,
  recordMonitorDeathsReported,
  scanMonitorDeaths,
} from './monitor-deaths.ts'
import {
  formatTeammateDeath,
  recordTeammateDeathsReported,
  scanTeammateDeaths,
} from './teammate-deaths.ts'

// `mailbox check`: the wake mod's one call (hooks/wake.ts, FLOW-400). Runs every wake source once and
// prints one entry per thing worth waking for, each opening with its `[source]` tag; empty stdout
// means nothing to wake for. Released answers are printed on every check until consumed — the mod
// remembers which it already delivered. Every released-item entry ends with a line naming the
// command that consumes it, and a comment's also names the one that replies to it on the board.
// The PRs this session watches are polled within the check's time budget, least recently polled
// first (FLOW-402); a change is printed once, by that PR's own saved baseline.
// Deaths are printed once each, by their own ledgers.
// A released item's continuation lines are indented two spaces, so an answer's own text can never
// open a line with a `[source]` tag and be mistaken for a separate entry.
// Exit codes: 0 is a complete read; 3 is a partial one — there is no board binary, a board read
// failed, its output was unparseable, or the registry was unreadable, so the answers listed may be a
// subset of what is released; 2 is no session id. Death lines are printed whatever the exit.
export const PARTIAL_READ_EXIT = 3

// The mod kills a check at its CHECK_TIMEOUT_MS (hooks/wake.ts) and delivers nothing from a killed
// one: what a check prints reaches the session only when the process exits. So the whole check,
// from process start to exit, must end inside that timeout; this is its budget, kept below it.
const CHECK_TOTAL_BUDGET_MS = 100_000
// Test seam: MAILBOX_CHECK_BUDGET_MS replaces CHECK_TOTAL_BUDGET_MS. Nothing else sets it.
const BUDGET_OVERRIDE_ENV = 'MAILBOX_CHECK_BUDGET_MS'
// Held back from the PR reads for what runs after a PR's deadline: the store writes counting the
// failure and unwatching the PR, each of which waits up to a second on the store lock.
const TAIL_RESERVE_MS = 10_000

export const runCheck = (session?: string): void => {
  const rawId = tryResolveRawSessionId(session)
  if (rawId === null) {
    console.error('mailbox check: no session id: pass --session or set CLAUDE_CODE_SESSION_ID')
    process.exitCode = 2

    return
  }

  // `--session` is the authority: the mod passes it without the env var a call from the session's
  // own Bash has, and a `claude` launched from another session's shell inherits that session's id.
  // Every downstream read (node resolution, the registry, the state partition) keys on the env var.
  if (session !== undefined) {
    process.env.CLAUDE_CODE_SESSION_ID = session
  }

  // Cheapest first, PR reads last, and the PR reads get only what the budget has left: a slow gh
  // then costs PR lines, and the check still exits in time for the answers and deaths to be
  // delivered. Every source after the answers prints its own lines before recording them (see
  // each one).
  const answers = releasedAnswers(rawId)
  if (answers.entries.length > 0) {
    console.log(answers.entries.join('\n'))
  }
  monitorDeaths(rawId)
  teammateDeaths(rawId)
  pollPrs()
  if (answers.isPartial) {
    process.exitCode = PARTIAL_READ_EXIT
  }
}

// `performance.timeOrigin` is the process start, so the budget includes node's own startup. It is
// also the check's start, the anchor for the `--ack-ready` ack (see pollOnce).
const pollPrs = (): void => {
  const override = Number(process.env[BUDGET_OVERRIDE_ENV])
  const totalMs = Number.isFinite(override) && override > 0 ? override : CHECK_TOTAL_BUDGET_MS
  pollWatched(
    undefined,
    performance.timeOrigin + totalMs - TAIL_RESERVE_MS - Date.now(),
    new Date(performance.timeOrigin).toISOString()
  )
}

// Which session ids to poll `answers --session <id>` against: every registered node for the raw
// session, so a `--key`-targeted sibling item still wakes the session, and so does an item on a
// node that has a live child — an epic root above its story, or a story above its PR node
// (FLOW-255). Falls back to the single resolved session when the registry has nothing in it.
// Exported so stop-gate.ts aggregates open items over the same node set.
export const pollTargets = (rawId: string | undefined, sessionId: string): string[] => {
  if (rawId === undefined) {
    return [sessionId]
  }

  const nodes = loadRegistry(rawId)

  return nodes.length > 0 ? nodes.map((n) => n.internalId) : [sessionId]
}

// Released answers (and comments — `answers` is the released-items superset) across every registered
// node. A session that never entered the board has nothing to poll, so it makes no board call: the
// mod runs in every interactive session, teammates and non-workflow sessions included. The calls are
// quiet so that ai-workflow-app's own exit status stays out of this command's 0/3 contract.
const releasedAnswers = (rawId: string): { entries: string[]; isPartial: boolean } => {
  let isPartial = false
  let anchor: string
  let nodeIds: string[]
  try {
    anchor = resolveSessionId(rawId)
    nodeIds = pollTargets(rawId, anchor)
  } catch (error) {
    if (!(error instanceof RegistryUnreadableError)) {
      throw error
    }

    // The raw id does not come from the registry, so the anchor is still checkable. Going quiet
    // here would be the deaf outcome this command exists to remove.
    console.error(
      `mailbox check: ${error.message}; checking the anchor session only — ` +
        `other nodes cannot be enumerated until it is repaired`
    )
    isPartial = true
    anchor = rawId
    nodeIds = [rawId]
  }

  const isRegistered =
    nodeIds.length > 1 || nodeIds[0] !== anchor || loadState(anchor)?.registered === true
  if (!isRegistered) {
    return { entries: [], isPartial }
  }

  const bin = resolveDashboardBin()
  if (bin === null) {
    return { entries: [], isPartial: true }
  }

  const entries = nodeIds.flatMap((nodeId) => {
    const out = invokeDashboardBin(bin, ['answers', '--session', nodeId], { quiet: true })
    const items = out === null ? null : parseReleasedItems(out)
    if (items === null) {
      isPartial = true

      return []
    }

    return items.map((item) => formatReleasedEntry(item, nodeId).replace(/\n/g, '\n  '))
  })

  return { entries, isPartial }
}

// renovate-pr-monitor liveness (FLOW-224): a monitor that dies without emitting leaves the lead
// waiting on an event that can never arrive. Printed before recorded: a crash between the
// two costs a duplicate wake, whereas recording first would cost a lost one.
const monitorDeaths = (rawId: string): void => {
  const deaths = scanMonitorDeaths(rawId)
  if (deaths.unreported.length === 0) {
    return
  }

  console.log(deaths.unreported.map(formatMonitorDeath).join('\n'))
  recordMonitorDeathsReported(deaths.all, rawId)
}

// Teammate liveness (FLOW-358): a dead teammate leaves the lead waiting on a report or shutdown ack
// that can never arrive. Printed before recorded, for the same reason as monitorDeaths.
const teammateDeaths = (rawId: string): void => {
  const deaths = scanTeammateDeaths(rawId)
  if (deaths.unreported.length === 0) {
    return
  }

  console.log(deaths.unreported.map(formatTeammateDeath).join('\n'))
  recordTeammateDeathsReported(deaths.all, rawId)
}
