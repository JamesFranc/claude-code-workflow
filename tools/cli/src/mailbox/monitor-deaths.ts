import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readDeadHolder } from '../pr-monitor/lock.ts'
import { storeDir } from '../pr-monitor/state.ts'
import { renovateLockPath } from '../renovate-pr-monitor/lock.ts'
import { atomicWrite } from '../workflow-store/store.ts'

export interface DeadRenovateMonitor {
  renovate: true
  pid: number
  heartbeatAt: string
}

export type MonitorDeath = DeadRenovateMonitor

// Beside state.json and the .lock files, in the same session partition — a ledger of deaths already
// reported to THIS session's agent, so an unhandled wake does not become a wake every poll interval.
const LEDGER_FILENAME = 'deaths-reported.json'

// key -> signature. See deathKey/deathSignature below for what each side means.
type Ledger = Record<string, string>

export interface MonitorDeathScan {
  // Every monitor currently dead, reported or not — what the ledger is rewritten to.
  all: MonitorDeath[]
  // The subset the agent has not been told about yet — what gets printed.
  unreported: MonitorDeath[]
}

// Whether this session's Renovate monitor is dead and not yet reported. A death whose signature
// already matches the ledger is silent: the agent was told, and it either acted (restarting the
// monitor, which refreshes the lock and ends the death) or chose not to. Re-reporting it on the next
// poll would be an immediate-return loop, the same failure shape the dashboard consume-before-re-arm
// rule exists to prevent.
export const scanMonitorDeaths = (rawSessionId?: string): MonitorDeathScan => {
  const all: MonitorDeath[] = []
  const renovateDeath = readDeadHolder(renovateLockPath(rawSessionId))
  if (renovateDeath !== null) {
    all.push({ renovate: true, ...renovateDeath })
  }
  const ledger = loadLedger(rawSessionId)
  const unreported = all.filter((death) => ledger[deathKey()] !== deathSignature(death))
  return { all, unreported }
}

// Rewrite the ledger to exactly `all` — the caller passes MonitorDeathScan.all, never the
// `unreported` subset. Passing the subset would drop the entries of deaths reported on an earlier
// poll and still dead now, and each would be re-reported next poll: the wake loop this ledger
// exists to prevent, reintroduced by the recording step itself.
//
// Rewriting rather than merging is also the pruning: a monitor that was dead and has since been
// restarted is absent from `all`, so its entry goes. It also drops the `owner/repo#N` keys a
// pre-FLOW-402 ledger holds for pr-monitor deaths. Losing it is safe — a restarted monitor's lock
// carries a new pid and heartbeat, so if it dies again the signature differs and it reports again.
export const recordMonitorDeathsReported = (all: MonitorDeath[], rawSessionId?: string): void => {
  const ledger: Ledger = {}
  for (const death of all) {
    ledger[deathKey()] = deathSignature(death)
  }
  atomicWrite(ledgerPath(rawSessionId), JSON.stringify(ledger, null, 2))
}

// One wake line per dead monitor. Carries the restart command literally so the handler has nothing
// to reconstruct.
export const formatMonitorDeath = (death: MonitorDeath): string =>
  `[renovate-pr-monitor] dead-monitor — the monitor loop (pid ${death.pid}) exited without ` +
  `emitting an event; last heartbeat ${death.heartbeatAt}. No further event can arrive. ` +
  `Restart it: renovate-pr-monitor`

// Identity of the MONITOR (the single Renovate loop) — stable across restarts of it.
const deathKey = (): string => 'renovate-pr-monitor'

// Identity of THIS DEATH. Both fields are frozen the moment the process stops writing, so the pair
// is stable while the death lasts and necessarily different for a later death of a restarted
// monitor (a new process has a new pid, and even a recycled pid heartbeats at a new time).
const deathSignature = (death: MonitorDeath): string => `${death.pid}:${death.heartbeatAt}`

const ledgerPath = (rawSessionId?: string): string => join(storeDir(rawSessionId), LEDGER_FILENAME)

// Absent (nothing reported yet) or unparseable (a torn write) both mean "no record" — fail toward
// reporting, since a duplicate wake costs one redundant restart and a suppressed wake costs exactly
// the indefinite stall this ticket is about.
const loadLedger = (rawSessionId?: string): Ledger => {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(rawSessionId), 'utf-8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    return parsed as Ledger
  } catch {
    return {}
  }
}
