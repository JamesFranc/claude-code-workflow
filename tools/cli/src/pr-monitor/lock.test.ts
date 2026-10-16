import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { claimLock, heartbeatLockAt, lockPath, releaseLockAt, stopLegacyMonitor } from './lock.ts'
import { storeDir } from './state.ts'
import { sessionScope, storePath } from '../workflow-store/store.ts'

// storeDir() is homedir()-relative (os.homedir() reads $HOME on POSIX) AND session-partitioned by
// process.env.CLAUDE_CODE_SESSION_ID (FLOW-156 Phase 4: pr-monitor moved from a global store to a
// per-session one) — override both so these tests never touch the real ~/.claude/workflow-state
// or a real operator's lock files, and so the partition is deterministic across a test.
let homeDir: string
let origHome: string | undefined
let origSessionId: string | undefined

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'pr-monitor-lock-test-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = `pr-monitor-lock-test-${homeDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)}`
  mkdirSync(storeDir(), { recursive: true })
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  if (origSessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = origSessionId
  try {
    rmSync(homeDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const lockFilePath = lockPath

// The pr-monitor lock is only a pre-FLOW-402 artefact now; these drive the primitives it shares
// with renovate-pr-monitor against that path.
const claimPr = (prNumber: string, repo: string): ReturnType<typeof claimLock> =>
  claimLock(lockPath(prNumber, repo), `${repo}#${prNumber}`)
const heartbeatPr = (prNumber: string, repo: string): void =>
  heartbeatLockAt(lockPath(prNumber, repo), `${repo}#${prNumber}`)
const releasePr = (prNumber: string, repo: string): void => releaseLockAt(lockPath(prNumber, repo))

const writeLockFile = (prNumber: string, repo: string, data: unknown): void => {
  writeFileSync(lockFilePath(prNumber, repo), JSON.stringify(data))
}

// The pre-FLOW-216 path under THIS process's own dirKey, for seeding a legacy lock file directly.
// lock.ts's legacyLockPath was deleted (with no production caller, an exported single-dirKey
// resolver sitting next to the swept plural is exactly how this class of gap reappears) — built
// inline here instead, matching store-scope.child.ts's own pattern.
const seedLegacyLockPath = (prNumber: string, repo: string): string =>
  join(storePath(sessionScope(), 'pr-monitor'), `${repo.replace(/\//g, '-')}-${prNumber}.lock`)

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// A sleeper that is NOT this process's child: sh backgrounds it and exits, so init/launchd adopts
// and reaps it. A direct child lingers as a zombie until this process's event loop reaps it, and
// kill(pid, 0) succeeds on a zombie — a blocking wait in stopLegacyMonitor would never see it exit.
const spawnOrphanSleeper = (): number => {
  const out = spawnSync('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' })
  const pid = Number(out.stdout.trim())
  assert.ok(Number.isInteger(pid) && pid > 0, 'precondition: orphan sleeper spawned with a pid')
  return pid
}

// A mocked process.kill for stopLegacyMonitor's positive-path tests: the pre-signal liveness check
// reads alive as normal, the SIGTERM call itself returns true and is recorded, and only a liveness
// check (signal 0) made AFTER that reports the pid dead — so waitForExit's poll returns at once
// instead of blocking the full STOP_EXIT_WAIT_MS, without also short-circuiting stopAtPath's own
// alive check.
const killReportingDeadAfterSignal = (): ((pid: number, signal?: string | number) => boolean) => {
  let signalled = false
  return (_pid: number, signal?: string | number): boolean => {
    if (signal === 'SIGTERM') {
      signalled = true
      return true
    }
    if (signal === 0 && signalled) {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    }
    return true
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('stopLegacyMonitor: a live pid is SIGTERMed (precise-pid, not pattern-kill) and the lock is removed', () => {
  const repo = 'owner/repo'
  const pr = '101'
  // An orphaned sleeper, not this test's own child: stopAtPath now blocks until the pid is gone
  // (waitForExit), and a direct child would read as alive for the whole wait as a zombie this
  // process's event loop hasn't reaped yet.
  const pid = spawnOrphanSleeper()
  try {
    const lockData = {
      pid,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    }
    writeLockFile(pr, repo, lockData)

    // No-blind-kill discipline: confirm the lock names exactly our spawned pid BEFORE
    // stopLegacyMonitor ever runs — stopLegacyMonitor must only ever act on the pid the lock itself
    // names.
    assert.equal(lockData.pid, pid, 'precondition: lock names our spawned pid, not some other')

    const result = stopLegacyMonitor(pr, repo)

    assert.equal(result, `stopped pid ${pid}`)
    assert.equal(existsSync(lockFilePath(pr, repo)), false, 'lock file removed on stop')

    assert.equal(isAlive(pid), false, 'the pid is dead when stopLegacyMonitor returns')
  } finally {
    // Belt-and-suspenders cleanup — never leave the sleeper running even if an assertion throws.
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

const STOP_HEARTBEAT_CHILD_SCRIPT = join(import.meta.dirname, 'test', 'stop-heartbeat.child.ts')

test('stopLegacyMonitor leaves no lock behind when the stopped monitor heartbeats after SIGTERM', async () => {
  const repo = 'owner/repo'
  const pr = '106'
  // Orphaned so it is reaped by init: a direct child lingers as a zombie, which still reads alive.
  const out = spawnSync(
    'sh',
    [
      '-c',
      '"$0" --experimental-transform-types "$1" "$2" "$3" >/dev/null 2>&1 & echo $!',
      process.execPath,
      STOP_HEARTBEAT_CHILD_SCRIPT,
      pr,
      repo,
    ],
    { env: process.env, encoding: 'utf8' }
  )
  const pid = Number(out.stdout.trim())
  assert.ok(Number.isInteger(pid) && pid > 0, 'precondition: orphaned child spawned with a pid')
  try {
    const deadline = Date.now() + 15_000
    let lockPid: number | undefined
    while (Date.now() < deadline) {
      if (existsSync(lockFilePath(pr, repo))) {
        lockPid = (JSON.parse(readFileSync(lockFilePath(pr, repo), 'utf-8')) as { pid: number }).pid
        if (lockPid === pid) {
          break
        }
      }
      await sleepMs(20)
    }
    assert.equal(lockPid, pid, 'precondition: the child acquired the lock naming its own pid')

    const result = stopLegacyMonitor(pr, repo)

    assert.equal(result, `stopped pid ${pid}`)

    // Three times the child's 200ms post-SIGTERM heartbeat delay — any post-SIGTERM write has
    // landed by now.
    await sleepMs(600)

    assert.equal(
      existsSync(lockFilePath(pr, repo)),
      false,
      'the post-SIGTERM heartbeat must not recreate the lock stopLegacyMonitor already removed'
    )
  } finally {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

test('stopLegacyMonitor: a stale heartbeat with a LIVE pid is NEVER killed (pid-reuse defense) — the stale lock is still removed', async () => {
  const repo = 'owner/repo'
  const pr = '104'
  // A real spawned sleeper that is genuinely alive — this simulates the dangerous case a stale lock
  // protects against: a getcwd-killed monitor leaves a stale lock, and the OS may have since reused
  // that exact pid for an unrelated live process. stopLegacyMonitor must never signal on pid match
  // alone — freshness (heartbeatAt within HEARTBEAT_STALE_MS) gates the kill exactly like
  // isLiveHolder gates claimPr's refuse-vs-reclaim.
  const child = spawn('sleep', ['30'])
  const pid = child.pid
  assert.ok(pid, 'precondition: the sleeper actually spawned with a pid')
  try {
    // 15 minutes ago — well past the 9-minute (HEARTBEAT_STALE_MS) freshness window.
    const staleHeartbeat = new Date(Date.now() - 15 * 60_000).toISOString()
    writeLockFile(pr, repo, { pid, startedAt: staleHeartbeat, heartbeatAt: staleHeartbeat })

    assert.equal(isAlive(pid), true, 'precondition: the sleeper is genuinely alive')

    const result = stopLegacyMonitor(pr, repo)

    assert.equal(result, null, 'a stale heartbeat is never treated as a live monitor')
    assert.equal(existsSync(lockFilePath(pr, repo)), false, 'stale lock is still removed')

    // Give any accidental signal a moment to land before asserting it did NOT.
    await sleepMs(200)
    assert.equal(isAlive(pid), true, 'the live pid was NEVER signaled — pid-reuse defense held')
  } finally {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

test('stopLegacyMonitor: a stale lock (dead pid) is a clean no-op and the stale lock is removed', () => {
  const repo = 'owner/repo'
  const pr = '102'
  // Deliberately not process.pid/ppid — a pid far past any real process table, guaranteed dead.
  const deadPid = 999_999_999
  writeLockFile(pr, repo, {
    pid: deadPid,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  })

  const result = stopLegacyMonitor(pr, repo)

  assert.equal(result, null)
  assert.equal(existsSync(lockFilePath(pr, repo)), false, 'stale lock removed')
})

test('stopLegacyMonitor: a missing lock is a clean no-op', () => {
  const repo = 'owner/repo'
  const pr = '103'

  assert.equal(existsSync(lockFilePath(pr, repo)), false, 'precondition: no lock file exists')

  const result = stopLegacyMonitor(pr, repo)

  assert.equal(result, null)
  assert.equal(existsSync(lockFilePath(pr, repo)), false, 'still no lock file')
})

// S2: both the lock's directory AND its filename changed under FLOW-216, so a monitor started under
// the pre-fix code is invisible to the current lockPath() alone — claimPr would let a fresh monitor
// start alongside it (two live monitors on one PR), and stopLegacyMonitor would report "no live
// monitor" while the old one keeps running for the PR's whole lifetime. But a legacy lock's
// filename is lossy (two differently-flattened repos can share one) and LockData carries no repo/PR
// identity, so stopLegacyMonitor can only IDENTIFY it, never verify it — it reports the live pid
// instead of signalling it, leaving both the process and the lock file untouched.
test('stopLegacyMonitor reports (never signals) a monitor whose lock predates FLOW-216 (legacy dir + filename)', async () => {
  const repo = 'owner/repo'
  const pr = '105'
  const child = spawn('sleep', ['30'])
  const pid = child.pid
  assert.ok(pid, 'precondition: sleeper spawned')
  try {
    const now = new Date().toISOString()
    const legacyPath = seedLegacyLockPath(pr, repo)
    mkdirSync(dirname(legacyPath), { recursive: true })
    writeFileSync(legacyPath, JSON.stringify({ pid, startedAt: now, heartbeatAt: now }))

    assert.equal(
      existsSync(lockFilePath(pr, repo)),
      false,
      'precondition: no lock at the current path'
    )

    const result = stopLegacyMonitor(pr, repo) ?? ''

    assert.match(result, new RegExp(`pid ${pid}`), 'reports the legacy pid')
    assert.doesNotMatch(result, /^stopped pid/, 'must not claim to have stopped it')
    assert.equal(existsSync(legacyPath), true, 'the live legacy lock file is left untouched')

    await sleepMs(200)
    assert.equal(isAlive(pid), true, 'the legacy incumbent was NEVER signalled')
  } finally {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

// Senior review (round after CR-1/CR-2 landed): a STALE legacy lock must also be left in place, not
// removed. Nothing ever reads a stale legacy lock (claimPr's legacy loop skips it via
// isLiveHolder, and reportLegacyHolders does not report it either), so deleting it buys nothing —
// and isLiveHolder is heartbeat-fresh AND pid-alive, so a pre-upgrade monitor that is merely
// STALLED (not dead) reads as stale here too; deleting its lock in that window acts on an identity
// this function does not have, the same mistake CR-1 exists to avoid on the signalling side.
test('stopLegacyMonitor leaves a stale legacy lock file in place (removing it would buy nothing)', () => {
  const repo = 'owner/repo'
  const pr = '108'
  const deadPid = 999_999_999
  const staleHeartbeat = new Date(Date.now() - 15 * 60_000).toISOString()
  const legacyPath = seedLegacyLockPath(pr, repo)
  mkdirSync(dirname(legacyPath), { recursive: true })
  writeFileSync(
    legacyPath,
    JSON.stringify({ pid: deadPid, startedAt: staleHeartbeat, heartbeatAt: staleHeartbeat })
  )

  const result = stopLegacyMonitor(pr, repo)

  assert.equal(result, null, 'a stale legacy lock is never treated as a live monitor')
  assert.equal(
    existsSync(legacyPath),
    true,
    'the stale legacy lock file is left in place — nothing ever reads it, so removing it buys nothing'
  )
})

test('claimPr: creates the pr-monitor dir when it does not exist (first-start ENOENT guard)', () => {
  const repo = 'owner/repo'
  const pr = '200'
  // Simulate a brand-new worktree+session: the pr-monitor/ store dir has not been created yet.
  rmSync(storeDir(), { recursive: true, force: true })
  assert.equal(existsSync(storeDir()), false, 'precondition: store dir absent')

  // Must not throw ENOENT — claimPr has to mkdir -p its own lock dir.
  claimPr(pr, repo)

  assert.equal(existsSync(lockFilePath(pr, repo)), true, 'lock file written on a fresh dir')
  assert.equal(
    statSync(storeDir()).mode & 0o777,
    0o700,
    'claimPr must create its lock directory 0700 via ensureDurableDir, not the default umask mode a bare mkdirSync would leave'
  )
  // Clean up the live lock we just acquired so it can't leak into other tests. releaseLock (not
  // stopLegacyMonitor) — claimPr recorded pid: process.pid (this test runner), and
  // stopLegacyMonitor would SIGTERM whatever live pid the lock names, i.e. itself.
  releasePr(pr, repo)
})

test('claimPr: an uncontended claim is acquired and records our pid', () => {
  const repo = 'owner/repo'
  const pr = '300'

  const result = claimPr(pr, repo)

  assert.deepEqual(result, { acquired: true })
  assert.equal(existsSync(lockFilePath(pr, repo)), true, 'lock file written')
  releasePr(pr, repo)
})

test('claimPr: a live fresh incumbent is refused, not killed', async () => {
  const repo = 'owner/repo'
  const pr = '301'
  const child = spawn('sleep', ['30'])
  const pid = child.pid
  assert.ok(pid, 'precondition: sleeper spawned')
  try {
    const now = new Date().toISOString()
    writeLockFile(pr, repo, { pid, startedAt: now, heartbeatAt: now })

    const result = claimPr(pr, repo)

    assert.equal(result.acquired, false, 'claim refused — incumbent is live and fresh')
    assert.ok(result.acquired === false && result.heldBy.pid === pid, 'reports the incumbent pid')

    // The incumbent must NOT have been signalled and the lock must still name IT, not us.
    await sleepMs(200)
    assert.equal(isAlive(pid), true, 'the live incumbent was never signalled')
    const onDisk = JSON.parse(readFileSync(lockFilePath(pr, repo), 'utf-8'))
    assert.equal(onDisk.pid, pid, 'lock still owned by the incumbent, not the refused newcomer')
  } finally {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

const LOCK_SCOPE_CHILD_SCRIPT = join(import.meta.dirname, 'test', 'lock-scope.child.ts')

const runLockScopeChild = (cwd: string, args: string[]): string => {
  mkdirSync(cwd, { recursive: true })
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', LOCK_SCOPE_CHILD_SCRIPT, ...args],
    { cwd, env: process.env, encoding: 'utf-8' }
  )
  assert.equal(result.status, 0, `child exited nonzero: ${result.stderr}`)
  return result.stdout.trim()
}

// Locks do not fold: with a live legacy holder in TWO sibling dirKeys, a naive "report the first
// one found" implementation would name only one pid — the user kills it, believes `--stop` finished
// the job, and the second keeps polling and waking them. stopLegacyMonitor must report every live
// legacy holder it finds, not just the first. claimPr may still refuse on the first live holder
// alone (any one is sufficient grounds to refuse) — deterministic because legacySiblingStoreDirs
// sorts its traversal, not because there is only one to find.
test('stopLegacyMonitor reports EVERY live legacy holder across sibling dirKeys, not just the first', async () => {
  const repo = 'owner/repo'
  const pr = '307'
  const dirA = join(homeDir, 'worktree-a')
  const dirB = join(homeDir, 'worktree-b')

  const childA = spawn('sleep', ['30'])
  const childB = spawn('sleep', ['30'])
  const pidA = childA.pid
  const pidB = childB.pid
  assert.ok(pidA, 'precondition: sleeper A spawned')
  assert.ok(pidB, 'precondition: sleeper B spawned')
  try {
    const now = new Date().toISOString()
    runLockScopeChild(dirA, ['write-legacy-lock', pr, repo, String(pidA), now])
    runLockScopeChild(dirB, ['write-legacy-lock', pr, repo, String(pidB), now])

    const stopResult = runLockScopeChild(dirA, ['stop', pr, repo])
    // Bare-digit assert.match(new RegExp(`${pid}`)) is a substring match: if one pid were a digit
    // substring of the other (123 vs 1234), the assertion for the MISSING pid would still pass
    // against a report naming only the other — the exact vacuity this test exists to avoid. Anchor
    // on the holder count (what "every holder" actually claims) and use \b-bounded pid matches.
    assert.match(
      stopResult,
      /^2 pre-FLOW-216 monitors are running/,
      'reports the count of live legacy holders'
    )
    assert.match(stopResult, new RegExp(`\\b${pidA}\\b`), 'reports pid A')
    assert.match(
      stopResult,
      new RegExp(`\\b${pidB}\\b`),
      'ALSO reports pid B — not just the first found'
    )

    await sleepMs(200)
    assert.equal(isAlive(pidA), true, 'sleeper A was never signalled')
    assert.equal(isAlive(pidB), true, 'sleeper B was never signalled')
  } finally {
    for (const pid of [pidA, pidB]) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
})

test('claimPr: a stale-heartbeat lock is reclaimed even when its pid is alive, without signalling it', async () => {
  const repo = 'owner/repo'
  const pr = '302'
  const child = spawn('sleep', ['30'])
  const pid = child.pid
  assert.ok(pid, 'precondition: sleeper spawned')
  try {
    const stale = new Date(Date.now() - 15 * 60_000).toISOString()
    writeLockFile(pr, repo, { pid, startedAt: stale, heartbeatAt: stale })

    const result = claimPr(pr, repo)

    assert.equal(result.acquired, true, 'stale-heartbeat lock is reclaimable')
    const onDisk = JSON.parse(readFileSync(lockFilePath(pr, repo), 'utf-8'))
    assert.equal(onDisk.pid, process.pid, 'lock now owned by us')
    await sleepMs(200)
    assert.equal(isAlive(pid), true, 'the reused pid was NEVER signalled (no kill path remains)')
  } finally {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    releasePr(pr, repo)
  }
})

test('claimPr: a live incumbent with a calendar-invalid heartbeat is refused, not reclaimed (FLOW-226 finding 546d87ce456c)', async () => {
  const repo = 'owner/repo'
  const pr = '304'
  const child = spawn('sleep', ['30'])
  const pid = child.pid
  assert.ok(pid, 'precondition: sleeper spawned')
  try {
    // Shape-valid (matches LOCK_TIMESTAMP_SHAPE) but calendar-invalid: Date.parse yields NaN.
    writeLockFile(pr, repo, {
      pid,
      startedAt: '2024-01-01T00:00:00.000Z',
      heartbeatAt: '2024-13-01T00:00:00.000Z',
    })

    const result = claimPr(pr, repo)

    assert.equal(
      result.acquired,
      false,
      'a live pid must refuse the claim even with a NaN heartbeat age'
    )
    assert.ok(result.acquired === false && result.heldBy.pid === pid, 'reports the incumbent pid')
    await sleepMs(200)
    assert.equal(isAlive(pid), true, 'the live incumbent was never signalled')
  } finally {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

test('stopLegacyMonitor: a live incumbent with a calendar-invalid heartbeat is refused, not stopped (FLOW-226 finding b822b0c3c2ac)', async () => {
  const repo = 'owner/repo'
  const pr = '305'
  const child = spawn('sleep', ['30'])
  const pid = child.pid
  assert.ok(pid, 'precondition: sleeper spawned')
  try {
    // Shape-valid (matches LOCK_TIMESTAMP_SHAPE) but calendar-invalid: Date.parse yields NaN.
    // Not process.pid: our own pid would make every ownership path agree regardless of this
    // branch, so a real, independently-owned live pid is required to pin the assertion to it.
    writeLockFile(pr, repo, {
      pid,
      startedAt: '2024-01-01T00:00:00.000Z',
      heartbeatAt: '2024-13-01T00:00:00.000Z',
    })

    const result = stopLegacyMonitor(pr, repo)

    assert.equal(
      result,
      `refusing to stop pid ${pid}: heartbeatAt "2024-13-01T00:00:00.000Z" is unreadable, so the lock's age cannot be established and the pid may have been reused`
    )
    await sleepMs(200)
    assert.equal(isAlive(pid), true, 'the live incumbent was never signalled')
    assert.equal(
      existsSync(lockFilePath(pr, repo)),
      true,
      'the lock is left in place, not removed as if it were merely stale'
    )
  } finally {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

test('claimPr: a lock naming a dead pid is reclaimed', () => {
  const repo = 'owner/repo'
  const pr = '303'
  const now = new Date().toISOString()
  writeLockFile(pr, repo, { pid: 999_999_999, startedAt: now, heartbeatAt: now })

  const result = claimPr(pr, repo)

  assert.equal(result.acquired, true, 'dead-pid lock reclaimed')
  releasePr(pr, repo)
})

test('lockPath: acme/foo-bar and acme-foo/bar resolve to different lock files (FLOW-216 collision fix)', () => {
  // Both flatten to `acme-foo-bar` under a naive `/` → `-` join. Reachable now that FLOW-216 removed
  // the cwd-derived directory that used to keep them apart by accident.
  const pathA = lockPath('7', 'acme/foo-bar')
  const pathB = lockPath('7', 'acme-foo/bar')
  assert.notEqual(pathA, pathB, 'two distinct repos must never share one lock file')
})

// Deadline for the parent-side readiness barrier below — bounds only the wait BEFORE GO is
// broadcast. What bounds the race itself after GO is claimPr's own no-sleep claim loop
// (CLAIM_MAX_ATTEMPTS/CLAIM_TAIL_ATTEMPTS in lock.ts), not this constant.
const READY_BARRIER_TIMEOUT_MS = 5000

// Backstop for tests that await their spawned child directly, with no readiness barrier of their
// own to bound the wait if the child process never completes — a stalled module load, a `close`
// that never fires — regardless of what its own internal logic would otherwise do.
const SPAWN_TIMEOUT_BACKSTOP_MS = 5000

// Surfaces exit code, signal, stdout, and stderr to the caller instead of picking a pass/fail
// verdict itself, so each test asserts what its own scenario requires. Listens on 'close', not
// 'exit': stdio can still be open when 'exit' fires, and stderr content is load-bearing here.
const runLockRaceChild = (
  args: [pr: string, repo: string, readyPath: string, goPath: string],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs?: number
): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}> =>
  new Promise((resolve, reject) => {
    const raceChild = join(import.meta.dirname, 'test', 'lock.race-child.ts')
    const child = spawn(process.execPath, ['--experimental-transform-types', raceChild, ...args], {
      env,
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout: stdout.trim(), stderr }))
  })

test('claimPr: under 8-way concurrent contention for the same PR, exactly one process wins and none are signalled', async () => {
  const repo = 'owner/repo'
  const pr = '304'
  const N = 8
  const barrierDir = mkdtempSync(join(tmpdir(), 'pr-monitor-race-barrier-'))
  const goPath = join(barrierDir, 'go')
  const readyPaths = Array.from({ length: N }, (_, i) => join(barrierDir, `ready.${i}`))

  try {
    const children = readyPaths.map((readyPath) => runLockRaceChild([pr, repo, readyPath, goPath]))

    // Genuine readiness barrier (not a wall-clock guess): wait until every child has signalled
    // READY (written its ready file — after spawn/module-load, before calling claimPr) before
    // broadcasting GO, so all N children reach claimPr at (as close as possible to) the same
    // instant.
    const deadline = Date.now() + READY_BARRIER_TIMEOUT_MS
    while (readyPaths.some((p) => !existsSync(p)) && Date.now() < deadline) {
      await sleepMs(5)
    }
    assert.ok(
      readyPaths.every((p) => existsSync(p)),
      'precondition: all children signalled ready before GO'
    )
    writeFileSync(goPath, '')

    const results = await Promise.all(children)

    assert.ok(
      results.every((r) => r.code === 0),
      `every child must exit 0 on both ACQUIRED and REFUSED, got: ${results
        .map((r) => `${r.code}:${r.stderr}`)
        .join(', ')}`
    )
    const lines = results.map((r) => r.stdout)
    const acquired = lines.filter((line) => line.includes('ACQUIRED'))
    const refused = lines.filter((line) => line.includes('REFUSED'))
    assert.equal(acquired.length, 1, `expected exactly one ACQUIRED, got: ${lines.join(', ')}`)
    assert.equal(refused.length, N - 1, `expected the rest REFUSED, got: ${lines.join(', ')}`)

    releasePr(pr, repo)
  } finally {
    rmSync(barrierDir, { recursive: true, force: true })
  }
})

test('lock.race-child exits non-zero with a diagnostic when GO never arrives (FLOW-261 finding d9bc082eaab8)', async () => {
  const barrierDir = mkdtempSync(join(tmpdir(), 'pr-monitor-race-timeout-'))
  const readyPath = join(barrierDir, 'ready')
  const goPath = join(barrierDir, 'go') // deliberately never written
  try {
    const { code, signal, stdout, stderr } = await runLockRaceChild(
      ['304', 'owner/repo', readyPath, goPath],
      { ...process.env, RACE_CHILD_GO_TIMEOUT_MS: '300' },
      SPAWN_TIMEOUT_BACKSTOP_MS
    )
    assert.ok(
      existsSync(readyPath),
      'precondition: the child reached READY before it started waiting'
    )
    assert.notEqual(signal, 'SIGTERM', 'the child must exit rather than stall, for any reason')
    assert.notEqual(
      code,
      0,
      'a child that never sees GO must exit non-zero, not hang or print a result'
    )
    assert.match(
      stderr,
      /lock-race-child: timed out after 300ms waiting for GO at/,
      'the diagnostic must name the timeout'
    )
    assert.ok(
      stderr.includes(goPath),
      'the diagnostic must name the specific goPath that never appeared'
    )
    // stdout carries ACQUIRED/REFUSED (see the 8-way contention test above) — empty here proves
    // claimPr was never reached, not just that the process eventually exited non-zero.
    assert.equal(stdout, '', 'a child that never sees GO must never reach claimPr')
  } finally {
    rmSync(barrierDir, { recursive: true, force: true })
  }
})

test('lock.race-child exits non-zero with a diagnostic when RACE_CHILD_GO_TIMEOUT_MS is malformed (FLOW-261 finding 2a448a7102e5)', async () => {
  const barrierDir = mkdtempSync(join(tmpdir(), 'pr-monitor-race-badtimeout-'))
  const readyPath = join(barrierDir, 'ready')
  const goPath = join(barrierDir, 'go')
  // Written before the child spawns: if a regression narrows or removes the guard, the child falls
  // straight through the barrier to a real claimPr call — it wins the lock, prints ACQUIRED, and
  // holds for its deliberate 2000ms before exiting (HOME is already isolated by this file's own
  // beforeEach), so a broken guard is caught by the exit-code assertion below rather than only by
  // the spawn timeout backstop.
  writeFileSync(goPath, '')
  try {
    const { code, signal, stderr } = await runLockRaceChild(
      ['304', 'owner/repo', readyPath, goPath],
      { ...process.env, RACE_CHILD_GO_TIMEOUT_MS: '15s' },
      SPAWN_TIMEOUT_BACKSTOP_MS
    )
    assert.notEqual(signal, 'SIGTERM', 'the child must exit rather than stall, for any reason')
    assert.notEqual(
      code,
      0,
      'a malformed RACE_CHILD_GO_TIMEOUT_MS must exit non-zero, not silently mis-parse to a short timeout'
    )
    assert.match(
      stderr,
      /RACE_CHILD_GO_TIMEOUT_MS must be a positive integer string, got "15s"/,
      'the diagnostic must name the variable and the malformed value received'
    )
    assert.ok(
      !existsSync(readyPath),
      'a malformed timeout must be rejected before the child ever signals READY'
    )
  } finally {
    rmSync(barrierDir, { recursive: true, force: true })
  }
})

test('lock.race-child exits non-zero with a diagnostic when RACE_CHILD_GO_TIMEOUT_MS is an oversized numeric string', async () => {
  const barrierDir = mkdtempSync(join(tmpdir(), 'pr-monitor-race-hugetimeout-'))
  const readyPath = join(barrierDir, 'ready')
  const goPath = join(barrierDir, 'go')
  // Written before the child spawns: if a regression narrows or removes the guard, the child falls
  // straight through the barrier to a real claimPr call — it wins the lock, prints ACQUIRED, and
  // holds for its deliberate 2000ms before exiting (HOME is already isolated by this file's own
  // beforeEach), so a broken guard is caught by the exit-code assertion below rather than only by
  // the spawn timeout backstop.
  writeFileSync(goPath, '')
  const oversizedNumeric = '9'.repeat(400)
  try {
    const { code, signal, stderr } = await runLockRaceChild(
      ['304', 'owner/repo', readyPath, goPath],
      { ...process.env, RACE_CHILD_GO_TIMEOUT_MS: oversizedNumeric },
      SPAWN_TIMEOUT_BACKSTOP_MS
    )
    assert.notEqual(signal, 'SIGTERM', 'the child must exit rather than stall, for any reason')
    assert.notEqual(
      code,
      0,
      'an oversized RACE_CHILD_GO_TIMEOUT_MS must exit non-zero, not silently parse to Infinity'
    )
    assert.match(
      stderr,
      new RegExp(
        `RACE_CHILD_GO_TIMEOUT_MS must be a positive integer string, got "${oversizedNumeric}"`
      ),
      'the diagnostic must name the variable and the malformed value received'
    )
    assert.ok(
      !existsSync(readyPath),
      'a malformed timeout must be rejected before the child ever signals READY'
    )
  } finally {
    rmSync(barrierDir, { recursive: true, force: true })
  }
})

test('heartbeatPr creates its lock file 0600 on a cold start (no prior lock)', () => {
  const repo = 'owner/repo'
  const pr = '500'
  assert.equal(existsSync(lockFilePath(pr, repo)), false, 'precondition: no lock file yet')

  heartbeatPr(pr, repo)

  assert.equal(existsSync(lockFilePath(pr, repo)), true, 'heartbeatPr created the lock file')
  assert.equal(
    statSync(lockFilePath(pr, repo)).mode & 0o777,
    0o600,
    'heartbeatPr must create its lock file 0600, not the default umask mode'
  )
})

test('heartbeatPr never overwrites a lock file it could not parse (FLOW-261 round 6 finding effee6802e40)', () => {
  const repo = 'owner/repo'
  const pr = '500'
  const path = lockFilePath(pr, repo)
  const garbage = 'not valid json — simulating a lock heartbeatPr cannot identify'
  writeFileSync(path, garbage)

  const originalConsoleError = console.error
  console.error = () => {}
  try {
    heartbeatPr(pr, repo)
  } finally {
    console.error = originalConsoleError
  }

  assert.equal(
    readFileSync(path, 'utf-8'),
    garbage,
    'heartbeatPr overwrote a lock file it could not parse, and therefore could not confirm it owned'
  )
})

test('heartbeatPr warns once per process about an unparseable lock, not on every call (FLOW-261 round 6 finding 61a4db1cb0c3)', () => {
  const repo = 'owner/repo'
  const pr = '501'
  const path = lockFilePath(pr, repo)
  writeFileSync(path, 'not valid json — simulating a lock heartbeatPr cannot identify')

  const originalConsoleError = console.error
  const messages: unknown[] = []
  console.error = (...args: unknown[]) => {
    messages.push(args[0])
  }
  try {
    heartbeatPr(pr, repo)
    heartbeatPr(pr, repo)
  } finally {
    console.error = originalConsoleError
  }

  assert.equal(
    messages.length,
    1,
    'expected exactly one diagnostic across two calls on the same path'
  )
  assert.equal(
    messages[0],
    `pr-monitor: lock file for ${repo}#${pr} is unreadable — heartbeats are suspended for it ` +
      `until the file is repaired, removed, or this process exits and a fresh claimLock ` +
      `reclaims it; this warning prints once per process`
  )
})

test('heartbeatPr creates its lock directory 0700 on a genuinely fresh store dir', () => {
  const repo = 'owner/repo'
  const pr = '501'
  rmSync(storeDir(), { recursive: true, force: true })
  assert.equal(existsSync(storeDir()), false, 'precondition: store dir absent')

  heartbeatPr(pr, repo)

  assert.equal(
    statSync(storeDir()).mode & 0o777,
    0o700,
    "heartbeatPr's writeLock must create its lock directory 0700 via ensureDurableDir, not the default umask mode a bare mkdirSync would leave"
  )
})

test('heartbeatPr repairs a stale tmp file left at 0644 back to 0600 before it lands on the lock path', () => {
  // writeLock's own `mode` option, like appendFileSync's and mkdirSync's elsewhere in this repo,
  // only takes effect when the call CREATES `tmp` — a `tmp` left over from a crash between an
  // earlier writeFileSync and its renameSync (writeLock's `tmp` name carries no per-call counter,
  // just the pid) keeps whatever mode it already had, and renameSync installs that mode on the
  // lock path along with the fresh content. Seed the exact tmp path writeLock will use, at the
  // wrong mode, before heartbeatPr ever runs.
  const repo = 'owner/repo'
  const pr = '501'
  const path = lockFilePath(pr, repo)
  const tmp = `${path}.tmp.${process.pid}`
  mkdirSync(dirname(tmp), { recursive: true })
  // writeFileSync's own `mode` option is masked by the process umask the same way appendFileSync's
  // is — seeding with { mode: 0o644 } directly could silently land at 0o600 under a strict umask
  // (e.g. 077), failing the precondition below on a healthy machine. chmodSync is not umask-masked,
  // so it seeds the exact mode regardless of the runner's umask.
  writeFileSync(tmp, 'stale')
  chmodSync(tmp, 0o644)
  assert.equal(statSync(tmp).mode & 0o777, 0o644, 'precondition: leftover tmp pre-exists at 0644')

  heartbeatPr(pr, repo)

  assert.equal(
    statSync(path).mode & 0o777,
    0o600,
    'heartbeatPr must repair a stale tmp file to 0600, not install it at its pre-existing mode'
  )
})

// --- Lock shape validation (FLOW-226) ---
//
// Every no-kill case below stubs process.kill and asserts it was NOT called. "Did not crash" is
// unusable as the assertion here: POSIX gives zero and negative pids process-GROUP meaning, so
// `process.kill(0, 0)` and `process.kill(-1, 0)` both return silently — not crashing IS the defect.
// The control at the end proves the stub still observes a kill when the lock is valid, so a
// zero-call assertion means rejection and not a broken harness.

const validIsoNow = (): string => new Date().toISOString()

test('stopLegacyMonitor: a lock naming pid 0 never reaches process.kill', (t) => {
  const repo = 'owner/repo'
  const pr = '910'
  writeLockFile(pr, repo, { pid: 0, startedAt: validIsoNow(), heartbeatAt: validIsoNow() })
  const killSpy = t.mock.method(process, 'kill', killReportingDeadAfterSignal())

  const result = stopLegacyMonitor(pr, repo)

  assert.equal(killSpy.mock.calls.length, 0, 'pid 0 signals the caller process group under POSIX')
  assert.equal(result, null)

  // Both assertions above are also satisfied by a stopLegacyMonitor that returns before reading the
  // lock at all. Re-run with the pid — and only the pid — made valid: the signal must land, which
  // it cannot if the zero above came from never getting that far.
  writeLockFile(pr, repo, {
    pid: process.pid,
    startedAt: validIsoNow(),
    heartbeatAt: validIsoNow(),
  })
  const stopped = stopLegacyMonitor(pr, repo)
  assert.deepEqual(
    killSpy.mock.calls.map((c) => c.arguments).filter((a) => a[1] === 'SIGTERM'),
    [[process.pid, 'SIGTERM']],
    'the same lock with only that field corrected is signalled exactly once, on its own pid'
  )
  assert.equal(stopped, `stopped pid ${process.pid}`)
})

test('claimPr: a lock naming pid -1 never reaches process.kill', (t) => {
  const repo = 'owner/repo'
  const pr = '911'
  writeLockFile(pr, repo, { pid: -1, startedAt: validIsoNow(), heartbeatAt: validIsoNow() })
  const killSpy = t.mock.method(process, 'kill', () => true)

  const result = claimPr(pr, repo)

  assert.equal(
    killSpy.mock.calls.length,
    0,
    'pid -1 signals every process the caller may signal under POSIX'
  )
  // Positive channel for the assertion above, which on its own is satisfied by an claimPr that
  // returned before doing anything at all. These two pin that it ran the whole way and treated the
  // -1 holder as reclaimable.
  assert.equal(result.acquired, true, 'the -1 lock was reclaimed, not merely left unsignalled')
  assert.equal(
    JSON.parse(readFileSync(lockFilePath(pr, repo), 'utf-8')).pid,
    process.pid,
    'the lock on disk now names this process'
  )
  releasePr(pr, repo)
})

test('stopLegacyMonitor: a numeric heartbeatAt never reaches process.kill', (t) => {
  const repo = 'owner/repo'
  const pr = '912'
  // `Date.now()` written through instead of `.toISOString()`. Read as literal epoch-ms by
  // `new Date(n)`, this looks freshly heartbeaten, and the pid here is this very process — so an
  // unvalidated read would SIGTERM the test runner itself.
  writeLockFile(pr, repo, {
    pid: process.pid,
    startedAt: validIsoNow(),
    heartbeatAt: Date.now(),
  })
  const killSpy = t.mock.method(process, 'kill', killReportingDeadAfterSignal())

  stopLegacyMonitor(pr, repo)

  assert.equal(killSpy.mock.calls.length, 0, 'a numeric heartbeat must not read as fresh')

  // Positive channel: the same lock with heartbeatAt — and only heartbeatAt — well-formed must
  // reach the signal, which pins the zero above to the validation rather than to a
  // stopLegacyMonitor that returned before reading anything.
  writeLockFile(pr, repo, {
    pid: process.pid,
    startedAt: validIsoNow(),
    heartbeatAt: validIsoNow(),
  })
  const result = stopLegacyMonitor(pr, repo)
  assert.deepEqual(
    killSpy.mock.calls.map((c) => c.arguments).filter((a) => a[1] === 'SIGTERM'),
    [[process.pid, 'SIGTERM']],
    'the same lock with only that field corrected is signalled exactly once, on its own pid'
  )
  assert.equal(result, `stopped pid ${process.pid}`)
})

test('stopLegacyMonitor: a numeric startedAt never reaches process.kill', (t) => {
  const repo = 'owner/repo'
  const pr = '913'
  writeLockFile(pr, repo, {
    pid: process.pid,
    startedAt: Date.now(),
    heartbeatAt: validIsoNow(),
  })
  const killSpy = t.mock.method(process, 'kill', killReportingDeadAfterSignal())

  stopLegacyMonitor(pr, repo)

  assert.equal(killSpy.mock.calls.length, 0, 'every LockData field is validated, not just the two')

  // Positive channel, as above: only startedAt changes, and the signal must then land.
  writeLockFile(pr, repo, {
    pid: process.pid,
    startedAt: validIsoNow(),
    heartbeatAt: validIsoNow(),
  })
  const result = stopLegacyMonitor(pr, repo)
  assert.deepEqual(
    killSpy.mock.calls.map((c) => c.arguments).filter((a) => a[1] === 'SIGTERM'),
    [[process.pid, 'SIGTERM']],
    'the same lock with only that field corrected is signalled exactly once, on its own pid'
  )
  assert.equal(result, `stopped pid ${process.pid}`)
})

test('stopLegacyMonitor: a valid lock still reaches process.kill with SIGTERM', (t) => {
  const repo = 'owner/repo'
  const pr = '914'
  writeLockFile(pr, repo, {
    pid: process.pid,
    startedAt: validIsoNow(),
    heartbeatAt: validIsoNow(),
  })
  const killSpy = t.mock.method(process, 'kill', killReportingDeadAfterSignal())

  const result = stopLegacyMonitor(pr, repo)

  const signalled = killSpy.mock.calls.map((c) => c.arguments)
  assert.deepEqual(
    signalled.filter((a) => a[1] === 'SIGTERM'),
    [[process.pid, 'SIGTERM']],
    'the control: a well-formed lock must still be signalled, exactly once, on its own pid'
  )
  assert.equal(result, `stopped pid ${process.pid}`)
})
