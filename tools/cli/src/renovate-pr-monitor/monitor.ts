// Ported from scripts/renovate-pr-monitor.sh's main and on_shutdown.
import { setTimeout as sleep } from 'node:timers/promises'
import type { MonitorConfig } from './config.ts'
import { emitAllDone } from './events.ts'
import { claimLock, heartbeatLockAt, releaseLockAt } from '../pr-monitor/lock.ts'
import { renovateLockPath } from './lock.ts'
import { MonitorExit, ShutdownAbort } from './monitor-exit.ts'
import { sessionSummary, tick } from './tick.ts'
import { futureIso } from './time.ts'

export interface MonitorOptions {
  once: boolean
  dryRun: boolean
  verbose: boolean
}

const LOCK_LABEL = 'renovate-pr-monitor'
// Must stay well under HEARTBEAT_STALE_MS (pr-monitor/lock.ts) — that margin is what bounds it, not
// the tick cadence.
const HEARTBEAT_INTERVAL_MS = 180_000

export const runMonitor = async (config: MonitorConfig, opts: MonitorOptions): Promise<void> => {
  const { once, dryRun, verbose } = opts

  const shutdown = new AbortController()
  const onShutdownSignal = () => {
    shutdown.abort()
  }
  process.on('SIGINT', onShutdownSignal)
  process.on('SIGTERM', onShutdownSignal)

  // Accepted difference 2: --once never takes the lock.
  const lockPath = renovateLockPath()
  let lockAcquired = false
  let heartbeatTimer: NodeJS.Timeout | undefined

  try {
    if (!once) {
      const claim = claimLock(lockPath, LOCK_LABEL)
      if (!claim.acquired) {
        console.error(
          `[monitor] another renovate-pr-monitor loop is already running in this session (pid ${claim.heldBy.pid}, last heartbeat ${claim.heldBy.heartbeatAt}) — not starting a second`
        )
        throw new MonitorExit(1)
      }
      lockAcquired = true
      heartbeatTimer = setInterval(() => {
        heartbeatLockAt(lockPath, LOCK_LABEL)
      }, HEARTBEAT_INTERVAL_MS)
      heartbeatTimer.unref()
    }

    const modeTags: string[] = []
    if (!once) {
      modeTags.push('loop')
    }
    if (once) {
      modeTags.push('once')
    }
    if (verbose) {
      modeTags.push('verbose')
    }
    if (dryRun) {
      modeTags.push('dry-run')
    }
    console.log(
      `[monitor] starting — mode=${modeTags.join(' ')}, author=${config.author}, poll=${config.pollIntervalSeconds}s`
    )
    console.log(
      `[monitor] scope: owners=[${config.scopeOwners.join(' ')}] repos=[${config.scopeRepos.join(' ')}] excludes=[${config.scopeExcludes.join(' ')}]`
    )
    console.log(
      `[monitor] hold-for-human-prs=${config.holdForHumanPrs} nonhuman-authors=${JSON.stringify(config.nonhumanAuthors)}`
    )
    if (config.holdForHumanPrs && config.holdRelaxStartRaw !== null) {
      console.log(
        `[monitor] hold relaxed during ${config.holdRelaxStartRaw}:00-${config.holdRelaxEndRaw}:00 ${config.holdRelaxTz || '(local time)'}`
      )
    }
    console.log(`[monitor] state=${config.stateFile}`)

    if (once) {
      await tick(config, dryRun, verbose, shutdown.signal)
      return
    }

    while (!shutdown.signal.aborted) {
      heartbeatLockAt(lockPath, LOCK_LABEL)
      await tick(config, dryRun, verbose, shutdown.signal)
      const { merged, rebased, ciRetried, held, workDone, pendingCount } = sessionSummary()
      const sessionTotal = merged.length + rebased.length + ciRetried.length
      if (sessionTotal > 0 && !workDone && pendingCount === 0) {
        emitAllDone(merged, rebased, ciRetried, held, dryRun)
      }
      console.log(
        `[monitor] sleeping ${config.pollIntervalSeconds}s — next tick ~${futureIso(config.pollIntervalSeconds)}`
      )
      try {
        await sleep(config.pollIntervalSeconds * 1000, undefined, { signal: shutdown.signal })
      } catch {
        throw new ShutdownAbort()
      }
    }
    throw new ShutdownAbort()
  } catch (err) {
    // A shutdown signal — observed either between ticks above or from the shared gh-call path the
    // moment the in-flight gh call settles (gh.ts's runGh, tick.ts, routines.ts) — matches bash's
    // trap semantics: nothing past that point runs, and this is the one place that stops it and
    // exits 0. Any other exception is a crash: the lock is left in place, its last heartbeat frozen,
    // so scanMonitorDeaths can detect and report it (mailbox/monitor-deaths.ts's Renovate scan).
    if (err instanceof ShutdownAbort) {
      console.log('[monitor] received shutdown signal; exiting')
      if (lockAcquired) {
        releaseLockAt(lockPath)
      }
      throw new MonitorExit(0)
    }
    if (lockAcquired && err instanceof MonitorExit) {
      releaseLockAt(lockPath)
    }
    throw err
  } finally {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer)
    }
    process.off('SIGINT', onShutdownSignal)
    process.off('SIGTERM', onShutdownSignal)
  }
}
