// The Renovate monitor's own loop-level lock: acquire before the first tick, heartbeat during the
// loop, release on a deliberate exit only — a crash leaves it in place, its last heartbeat frozen,
// so scanMonitorDeaths can detect and report it. Reuses pr-monitor/lock.ts's generic path-keyed
// claimLock / heartbeatLockAt / releaseLockAt (Task 2's extraction) with this module's own path.
import { join } from 'node:path'
import { storeDir } from '../pr-monitor/state.ts'

export const RENOVATE_LOCK_FILENAME = 'renovate-pr-monitor.lock'

export const renovateLockPath = (rawSessionId?: string): string =>
  join(storeDir(rawSessionId), RENOVATE_LOCK_FILENAME)
