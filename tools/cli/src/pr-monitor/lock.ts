import {
  chmodSync,
  existsSync,
  linkSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { ensureDurableDir } from '../workflow-store/store.ts'
import { blockingSleep, legacySiblingStoreDirs, storeDir } from './state.ts'

const HEARTBEAT_STALE_MS = 9 * 60_000 // ~3 missed 3-minute polls
const STOP_EXIT_WAIT_MS = 5_000
const STOP_EXIT_POLL_MS = 20
const LOCK_SUFFIX = '.lock'
const CLAIM_MAX_ATTEMPTS = 10 // no sleep between attempts — synchronous fs calls only, so all 10 finish in milliseconds
const CLAIM_TAIL_ATTEMPTS = 3 // loop-exhaustion tail; same no-sleep discipline as the CLAIM_MAX_ATTEMPTS loop above

export interface LockData {
  pid: number
  startedAt: string
  heartbeatAt: string
}

export type AcquireResult = { acquired: true } | { acquired: false; heldBy: LockData }

// `#` cannot appear in a GitHub owner or repo name, so it separates unambiguously. A `-` join
// cannot: `acme/foo-bar` and `acme-foo/bar` both flatten to `acme-foo-bar`, giving two different
// repos one lock file. Reachable since FLOW-216 removed the cwd-derived directory that used to keep
// them apart by accident.
export const lockPath = (prNumber: string, repo: string): string =>
  join(storeDir(), `${repo.replace(/\//g, '#')}#${prNumber}${LOCK_SUFFIX}`)

// Every pre-FLOW-216 legacy lock file for THIS session, one per sibling dirKey directory (see
// legacySiblingStoreDirs in state.ts). A monitor started before this fix's lock relocation is
// invisible under lockPath() — or under a single, current-dirKey-only guess — alone:
// it may have been launched from a DIFFERENT directory than whichever one stopLegacyMonitor
// happens to run from now.
//
// What a legacy lock can and cannot tell a caller: legacyLockPaths
// deliberately reproduces the pre-FLOW-216 lossy filename join (`repo.replace(/\//g, '-')`), so
// `acme/foo-bar` and `acme-foo/bar` can share ONE legacy lock file, and LockData carries no repo or
// PR field to disambiguate them. What this path actually observes is "a file with this name exists
// and names a live pid" — never "this PR's monitor is running". stopLegacyMonitor must treat
// every legacy result as identification, not proof: it reports a live legacy holder and never
// signals it, because a legacy result cannot pass the verification a signal needs.
//
// Locks do not fold the way legacy STATE files do (state.ts's adoptLegacy: per-key, newest-
// updatedAt-wins merge). The bug doc's own reproduction — "same session, different cwd: both run" —
// means a PR watched across N pre-upgrade worktrees can have N separate, genuinely LIVE legacy
// locks, one per sibling dirKey, at the moment this scan runs. Collapsing that to "the first one
// found" and reporting only it is a silent loss: the caller acts on one and believes the job done
// while N-1 keep running.
const legacyLockPaths = (prNumber: string, repo: string): string[] => {
  const filename = `${repo.replace(/\//g, '-')}-${prNumber}.lock`
  return legacySiblingStoreDirs()
    .map((dir) => join(dir, filename))
    .filter((path) => existsSync(path))
}

// A persisted lock row is `unknown` at runtime whatever the `LockData` type this file reads it
// through says, so the shape is validated rather than asserted — parseability is not shape.
//
// An unchecked `pid <= 0` reaches isProcessAlive's `process.kill(pid, 0)` with nothing to catch:
// POSIX gives zero and negative pids process-GROUP meaning (`0` is the caller's own group, `-1` is
// every process the caller may signal), so both return without throwing and isProcessAlive reads
// that silence as "alive" — and the same value reaches stopAtPath's real
// `process.kill(existing.pid, 'SIGTERM')`, which would signal a whole group instead of the one
// recorded process, breaking the precise-pid discipline stopLegacyMonitor's contract claims.
//
// A malformed `heartbeatAt` cuts both ways once it reaches `new Date(...).getTime()`: a non-date
// string yields NaN, which fails every comparison and misreads a live holder as reclaimable; a raw
// number (`Date.now()` written through instead of `.toISOString()`) is read as literal epoch-ms, so
// a recent one reads as fresh and misreads a dead holder as live, blocking a reclaim that should
// succeed. `typeof === 'string'` closes the raw-number case outright. The shape test narrows the
// non-date string rather than closing it: it constrains digit positions, not calendar validity, so
// `2024-13-01T00:00:00.000Z` matches and still yields NaN. isLiveHolder handles that NaN explicitly
// (see its own comment) rather than let it fail the freshness comparison and misread a live holder
// as reclaimable. A parseability test is not the alternative: `new Date`/`Date.parse` stringify or
// numeric-coerce whatever they are handed before parsing, so a non-string can still yield a
// plausible date.
//
// The shape is `Date.prototype.toISOString()`'s own millisecond precision, because every timestamp
// this file writes comes from `new Date().toISOString()` — claimLock and heartbeatLockAt are
// its only writers.
//
// `startedAt` is checked against the same pattern for a different reason: it never reaches
// `getTime()` (nothing prints it), so a malformed value there is
// a display bug rather than the live/dead misread above.
const LOCK_TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const isValidLockData = (data: unknown): data is LockData => {
  if (!data || typeof data !== 'object') {
    return false
  }
  const row = data as Partial<Record<keyof LockData, unknown>>
  if (typeof row.pid !== 'number' || !Number.isInteger(row.pid) || row.pid <= 0) {
    return false
  }
  if (typeof row.startedAt !== 'string' || !LOCK_TIMESTAMP_SHAPE.test(row.startedAt)) {
    return false
  }
  if (typeof row.heartbeatAt !== 'string' || !LOCK_TIMESTAMP_SHAPE.test(row.heartbeatAt)) {
    return false
  }
  return true
}

const readLock = (path: string): LockData | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    return isValidLockData(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Plain (non-exclusive) overwrite — only for heartbeatLockAt, which calls this after confirming
// the existing lock names its own pid, or after observing the path empty. That emptiness
// observation is TOCTOU-stale, not a gate: readLock, existsSync and this function's own
// renameSync are three separate syscalls, so another process's claimLock can complete its
// exclusive create in the gap and this call then renames over that fresh, valid lock — both
// processes then believe they hold it. claimLock never goes through here for
// exactly this reason: it uses tryExclusiveClaim below instead, which is what actually adjudicates
// ownership under contention.
//
// writeFileSync's mode option only applies when the call creates `tmp` — a leftover from an
// earlier crash between this writeFileSync and its renameSync (or from before this repo pinned
// 0o600 at all) would otherwise keep whatever mode it already had, and renameSync installs that
// mode on `path` along with the fresh content. The chmodSync repairs `tmp` unconditionally, right
// before it becomes `path`, so the file that lands is always 0o600 regardless of what `tmp`
// started at.
const writeLock = (path: string, data: LockData): void => {
  ensureDurableDir(dirname(path))
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH = no such process; EPERM = exists but not signalable by us (treat as alive)
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// A lock still held by a genuinely-running monitor: its pid is alive AND its heartbeat is within
// the stale window. A stale heartbeat means the monitor died and the OS may have reused its pid
// for an unrelated process (see lock.test.ts pid-reuse defense) — reclaimable, not a live holder.
//
// A shape-valid but calendar-invalid heartbeatAt (LOCK_TIMESTAMP_SHAPE's own residual — see its
// comment) yields NaN here, and NaN fails every comparison, so the age check alone would always
// read that holder as stale regardless of whether its process is actually running. Falling back to
// isProcessAlive in that case keeps a genuinely alive holder with a corrupted heartbeat from being
// reclaimed and reported as an abnormal death.
const isLiveHolder = (data: LockData): boolean => {
  const heartbeatAge = heartbeatAgeMs(data)
  if (Number.isNaN(heartbeatAge)) {
    return isProcessAlive(data.pid)
  }
  return heartbeatAge < HEARTBEAT_STALE_MS && isProcessAlive(data.pid)
}

const heartbeatAgeMs = (data: LockData): number => Date.now() - new Date(data.heartbeatAt).getTime()

export const readDeadHolder = (path: string): { pid: number; heartbeatAt: string } | null => {
  const data = readLock(path)
  // readLock returns null for a file that is unreadable, unparseable, or parseable but not a
  // valid LockData — a torn write mid-rename, say. Skip rather than report: we cannot name a
  // trustworthy pid or heartbeat for it, and a wake line that says "something died, no details"
  // is worse than the next poll's, which will read it whole.
  if (data === null || isLiveHolder(data)) {
    return null
  }
  return { pid: data.pid, heartbeatAt: data.heartbeatAt }
}

let claimPublishCounter = 0
let claimStealCounter = 0

// Attempt the exclusive publish; true means our data is confirmed on disk, false means someone
// else currently holds `path` (EEXIST). Any other failure propagates — this never silently
// swallows a real fs error.
//
// Writes the complete JSON to a unique temp file first, THEN atomically installs it with an
// exclusive (no-overwrite) hard link — never a direct `writeFileSync(path, ..., { flag: 'wx' })`.
// A direct wx-write makes only the CREATE exclusive, not the WRITE atomic: `path` would briefly
// exist with a truncated/partial body while the write completes.
const tryExclusiveClaim = (path: string, data: LockData): boolean => {
  const tempPath = `${path}.publish.${process.pid}.${claimPublishCounter++}.tmp`
  writeFileSync(tempPath, JSON.stringify(data), { mode: 0o600 })
  try {
    linkSync(tempPath, path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err
    }
    return false
  } finally {
    // Never leak the temp: the successful case links a SECOND directory entry to the same inode
    // (removing this one leaves `path`'s content intact), and the EEXIST/throw cases mean the
    // temp was never installed anywhere at all.
    rmSync(tempPath, { force: true })
  }
}

// Atomic claim + steal-and-verify: a stale file is renamed off-path so this process holds the sole
// reference to it, then re-read before being discarded. Liveness is isLiveHolder (pid-alive AND
// heartbeat-fresh).
// Refuse-and-report, never supersede-by-kill: a live, fresh incumbent is reported back to the
// caller untouched — this function writes nothing and signals nothing when it refuses.
//
// This is provably single-winner for two near-simultaneous starts (N=2). At N≥3 there is a restore
// residual: while one racer holds a live winner's file off-path mid steal-and-verify, a third racer
// can win the now-empty path, and the first racer's restore then clobbers that fresh win. Out of
// scope here — the user confirmed duplicate agents racing to start a monitor on one PR is not a
// concern — and self-healing even if hit, since a loser simply refuses and exits. Not claiming
// atomicity this code doesn't deliver.
export const claimLock = (path: string, label: string): AcquireResult => {
  ensureDurableDir(dirname(path))

  const ours = (): LockData => {
    const now = new Date().toISOString()
    return { pid: process.pid, startedAt: now, heartbeatAt: now }
  }

  // Fast path: skip straight to reporting a known live incumbent. Purely an optimization — the
  // exclusive-create loop below, not this check, is what decides ownership under contention.
  const existing = readLock(path)
  if (existing && existing.pid !== process.pid && isLiveHolder(existing)) {
    return { acquired: false, heldBy: existing }
  }

  for (let attempt = 0; attempt < CLAIM_MAX_ATTEMPTS; attempt++) {
    if (tryExclusiveClaim(path, ours())) {
      return { acquired: true }
    }

    const current = readLock(path)
    if (current && isLiveHolder(current)) {
      return { acquired: false, heldBy: current }
    }

    // Looks stale by our read, but do not blindly unlink — steal it via an atomic rename so we
    // hold the sole reference to whatever is actually at `path` right now, then re-verify it.
    const stealPath = `${path}.steal.${process.pid}.${claimStealCounter++}.tmp`
    try {
      renameSync(path, stealPath)
    } catch (renameErr) {
      if ((renameErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw renameErr
      }
      // Another racer already reclaimed or removed it between our read and our rename attempt —
      // retry the exclusive create.
      continue
    }

    const stolen = readLock(stealPath)
    if (stolen && isLiveHolder(stolen)) {
      // We detached a LIVE winner that appeared after our stale read — restore it untouched and
      // refuse cleanly, rather than discarding a claim that isn't ours to discard, and NEVER
      // signal it.
      renameSync(stealPath, path)
      return { acquired: false, heldBy: stolen }
    }
    // Genuinely stale (dead pid, or unparseable): discard and retry the claim.
    rmSync(stealPath, { force: true })
  }

  // Loop-exhaustion tail — only a sustained multi-way storm reaches it; every
  // write here stays gated behind the same exclusive create as every attempt above, so it can
  // never itself produce a second, competing "win".
  for (let tailAttempt = 0; tailAttempt < CLAIM_TAIL_ATTEMPTS; tailAttempt++) {
    if (tryExclusiveClaim(path, ours())) {
      return { acquired: true }
    }
    const owner = readLock(path)
    if (owner && isLiveHolder(owner)) {
      return { acquired: false, heldBy: owner }
    }
    // Transiently absent, or stale (dead/unparseable) — retry the gated create once more.
  }
  // Exceptionally unlikely to be reached — fail loudly rather than fabricate an ownership answer
  // either way (a bare acquired:true would falsely claim a write that never happened; a
  // fabricated heldBy would falsely deny a legitimate win).
  throw new Error(`claimLock: could not resolve lock ownership for ${label}`)
}

// Paths this process has already warned about below — printed once per process per path, not once
// per heartbeat: renovate-pr-monitor's loop calls heartbeatLockAt every cycle, so an unconditional
// log would repeat every cycle for an unchanged condition.
const warnedUnparseableLockPaths = new Set<string>()

export const heartbeatLockAt = (path: string, label: string): void => {
  const existing = readLock(path)
  if (existing) {
    // A newer monitor reclaimed our (stale) lock; don't clobber it if our poll fires before we
    // exit.
    if (existing.pid !== process.pid) {
      return
    }
  } else if (existsSync(path)) {
    // readLock returned null because the file couldn't be read as a valid lock, not because it's
    // absent — a cold start (genuinely nothing at `path`, see "heartbeatPr creates its lock file
    // 0600 on a cold start" in lock.test.ts) is the one null case this function must still write
    // through; this is the other one, and it names no pid we can confirm as ours. The no-op is
    // otherwise permanent and silent — nothing else in this module repairs or removes the file, and
    // every later poll hits the same branch — so a corrupt lock would stop this monitor's liveness
    // publishing with nothing to explain why; the warning below is what makes that diagnosable.
    if (!warnedUnparseableLockPaths.has(path)) {
      warnedUnparseableLockPaths.add(path)
      console.error(
        `pr-monitor: lock file for ${label} is unreadable — heartbeats are suspended ` +
          `for it until the file is repaired, removed, or this process exits and a fresh ` +
          `claimLock reclaims it; this warning prints once per process`
      )
    }
    return
  }
  const startedAt = existing?.startedAt ?? new Date().toISOString()
  writeLock(path, { pid: process.pid, startedAt, heartbeatAt: new Date().toISOString() })
}

export const releaseLockAt = (path: string): void => {
  const existing = readLock(path)
  if (existing && existing.pid === process.pid) {
    try {
      rmSync(path)
    } catch {
      // already gone
    }
  }
}

// Used by stopLegacyMonitor and stopLegacyMonitors for current-format lock paths only — those
// paths are collision-free by construction (Task 4's `#` separator), so signalling and removing
// there act on a verified identity. Legacy paths go through reportLegacyHolders instead (below),
// which never calls this: see its own comment for why signalling and removing a legacy lock are
// both unsafe. Reuses isLiveHolder directly: one definition of "alive" gates the kill here and
// claimLock's refuse-vs-reclaim decision, rather than two that could drift. This is the ONLY
// deliberate-takeover path (claimLock never signals — see its refuse-and-report contract above).
// Stale (heartbeat too old, or pid not alive) or missing are both a clean no-op — a stale lock is
// still removed so it never masks a future claimLock check. An unreadable heartbeat on a still-live
// pid is a third state: the age cannot be established, so the pid may have been reused — refused,
// not no-opped, and the lock is left in place rather than removed, the same reasoning as the EPERM
// branch below.
//
// Returns `null` — not the human-facing "no live monitor" string — when nothing live was found at
// `path`: stopLegacyMonitor uses that to decide whether to also check for a legacy holder, and a
// control decision should never ride on string equality with prose a later edit could reword.
const stopAtPath = (path: string, existing: LockData | null): string | null => {
  if (existing) {
    if (isLiveHolder(existing)) {
      if (Number.isNaN(heartbeatAgeMs(existing))) {
        return `refusing to stop pid ${existing.pid}: heartbeatAt ${JSON.stringify(existing.heartbeatAt)} is unreadable, so the lock's age cannot be established and the pid may have been reused`
      }
      try {
        process.kill(existing.pid, 'SIGTERM')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ESRCH') {
          // Not a self-exit race (ESRCH) — the signal did not land (e.g. EPERM). Don't claim
          // success and don't remove the lock: a live monitor may still hold it.
          return `failed to stop pid ${existing.pid}: ${code ?? (error as Error).message}`
        }
        // ESRCH: the process exited between our liveness check and the kill call — already
        // stopped, fall through to the normal removed-lock report below.
      }
      if (!waitForExit(existing.pid)) {
        return `sent SIGTERM to pid ${existing.pid}, but it had not exited after ${STOP_EXIT_WAIT_MS / 1000}s — lock left in place; re-run --stop, or kill ${existing.pid} yourself`
      }
      removeLockIfHeldBy(path, existing.pid)
      return `stopped pid ${existing.pid}`
    }
    // Stale (heartbeat too old, or pid recorded but not alive) — never signal a possibly-reused
    // pid. An unreadable heartbeat on a still-live pid is handled above, before this branch is
    // reached, and refused rather than treated as stale.
    try {
      rmSync(path)
    } catch {
      // already gone
    }
  }
  return null
}

// SIGTERM is asynchronous: kill() returns before the target has exited, and until it has, an
// in-flight heartbeatLockAt can find the lock gone and take its cold-start branch, writing it back
// after --stop removed it (FLOW-281). Waiting for the pid to disappear is what makes the removal
// below final.
const waitForExit = (pid: number): boolean => {
  const deadline = Date.now() + STOP_EXIT_WAIT_MS
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) {
      return false
    }
    blockingSleep(STOP_EXIT_POLL_MS)
  }
  return true
}

// A new monitor can claim the path between the stopped pid's exit and this call — only a lock
// still naming the pid we stopped is ours to remove.
const removeLockIfHeldBy = (path: string, pid: number): void => {
  if (readLock(path)?.pid === pid) {
    rmSync(path, { force: true })
  }
}

// A legacy lock is unverifiable (see legacyLockPaths' comment above) — the filename collision means
// the pid it names might belong to an entirely unrelated repo. Signalling on it would contradict
// this module's own stated discipline (claimLock's "Refuse-and-report, never supersede-by-kill"),
// so this reports a live legacy holder instead of killing it — the user can confirm and `kill
// <pid>` themselves, which this module cannot do safely on their behalf.
//
// Also never folds: a live legacy holder is collected from EVERY sibling dirKey, not just the
// first (see legacyLockPaths' comment on why locks don't merge the way legacy state files do). A
// report naming one pid when three are running would look like `--stop` succeeded while two kept
// polling and waking the agent — the false negative this ticket exists to close, displaced one
// level down and harder to notice because the command appears to work.
//
// A STALE legacy lock (dead pid, or heartbeat past HEARTBEAT_STALE_MS) is left in place too, not
// removed — the same adopt-and-leave reasoning state.ts's adoptLegacy now applies to legacy state
// files. Deleting buys nothing: nothing ever reads a stale legacy lock (this function does not
// report it), so removal is pure risk for zero benefit. And isLiveHolder is heartbeat-fresh AND
// pid-alive — a pre-upgrade monitor that is alive but merely STALLED (machine sleep, SIGSTOP, a GC
// pause past HEARTBEAT_STALE_MS) reads as stale here even though it is still running; deleting its
// lock in that window is acting on an identity this function does not have, the same mistake CR-1
// exists to avoid on the signalling side. Self-healing regardless — its own next heartbeat
// recreates the file — so leaving it costs only one inert file until then.
const reportLegacyHolders = (prNumber: string, repo: string): string | null => {
  const livePids: number[] = []
  for (const legacyPath of legacyLockPaths(prNumber, repo)) {
    const existing = readLock(legacyPath)
    if (existing && isLiveHolder(existing)) {
      livePids.push(existing.pid)
    }
  }
  if (livePids.length === 0) {
    return null
  }
  if (livePids.length === 1) {
    return (
      `a pre-FLOW-216 monitor is running (pid ${livePids[0]}) — this lock predates the current ` +
      `format and cannot be verified as this PR's; stop it manually: kill ${livePids[0]}`
    )
  }
  return (
    `${livePids.length} pre-FLOW-216 monitors are running (pids ${livePids.join(', ')}) — these ` +
    `locks predate the current format and cannot be verified as this PR's; stop them manually: ` +
    `kill ${livePids.join(' ')}`
  )
}

// `pr-monitor` (register or `--stop`) clears what a background monitor of an older version left
// behind: terminate the exact pid recorded in the lock (precise-pid discipline — never
// pattern-kill). Checks the current lock path first — that path is collision-free by construction
// (Task 4's `#` separator), so signalling there is safe. If nothing live is found there, reports
// every sibling dirKey's live pre-FLOW-216 legacy holder (reportLegacyHolders) instead of
// signalling any of them — and leaves stale ones in place too, untouched (see reportLegacyHolders'
// own comment for why removing them is also unsafe).
export const stopLegacyMonitor = (prNumber: string, repo: string): string | null => {
  const path = lockPath(prNumber, repo)
  return stopAtPath(path, readLock(path)) ?? reportLegacyHolders(prNumber, repo)
}

// Every background monitor left by an older version in this session's partition, not only the one
// for the PR being registered: each polled and woke the session on its own. The registered PR's own
// lock goes through stopLegacyMonitor; every other per-PR lock file is stopped the same precise-pid
// way. The Renovate monitor's lock (renovate-pr-monitor.lock) names no PR and is never touched.
export const stopLegacyMonitors = (prNumber: string, repo: string): string[] => {
  const own = lockPath(prNumber, repo)
  const ownMessage = stopLegacyMonitor(prNumber, repo)
  const dir = dirname(own)
  const others = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((name) => name.endsWith(LOCK_SUFFIX) && name.includes('#') && join(dir, name) !== own)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name)
      const message = stopAtPath(path, readLock(path))
      return message === null ? [] : [`${name}: ${message}`]
    })

  return ownMessage === null ? others : [ownMessage, ...others]
}
