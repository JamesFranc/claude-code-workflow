import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockPath } from '../pr-monitor/lock.ts'
import { renovateLockPath } from '../renovate-pr-monitor/lock.ts'
import { storeDir } from '../pr-monitor/state.ts'
import { scanMonitorDeaths, recordMonitorDeathsReported } from './monitor-deaths.ts'

// storeDir() is homedir()-relative AND session-partitioned by CLAUDE_CODE_SESSION_ID — override
// both so these tests never touch the real ~/.claude/workflow-state or a real operator's ledger.
// Duplicated from lock.test.ts's own fixture, per this repo's per-file duplicate-helper convention
// (lock.test.ts's own beforeEach/afterEach) — including its afterEach rmSync of homeDir (an earlier
// version of this file's afterEach restored the env vars but never removed the temp dir itself,
// leaking one per test run).
let homeDir: string
let origHome: string | undefined
let origSessionId: string | undefined

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'monitor-deaths-test-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = `monitor-deaths-test-${homeDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)}`
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

const writeDeadRenovateLock = (pid: number, heartbeatAt: string, rawSessionId?: string): void => {
  writeFileSync(
    renovateLockPath(rawSessionId),
    JSON.stringify({ pid, startedAt: heartbeatAt, heartbeatAt })
  )
}

const staleHeartbeat = (): string => new Date(Date.now() - 15 * 60_000).toISOString()

test('scanMonitorDeaths: a first-seen death is unreported', () => {
  writeDeadRenovateLock(999_999_999, staleHeartbeat())

  const scan = scanMonitorDeaths()

  assert.equal(scan.unreported.length, 1)
  assert.deepEqual(scan.unreported, scan.all)
})

test('scanMonitorDeaths: after recording, the same death is silent', () => {
  writeDeadRenovateLock(999_999_999, staleHeartbeat())

  const first = scanMonitorDeaths()
  recordMonitorDeathsReported(first.all)
  const second = scanMonitorDeaths()

  assert.deepEqual(second.unreported, [], 'already-reported death is silent')
  assert.equal(second.all.length, 1, 'still dead — just not re-reported')
})

test('scanMonitorDeaths: a NEW death of the same monitor reports again', () => {
  writeDeadRenovateLock(111, staleHeartbeat())
  const first = scanMonitorDeaths()
  recordMonitorDeathsReported(first.all)

  // Overwrite with a NEW dead pid — a restart-then-re-death.
  writeDeadRenovateLock(222, staleHeartbeat())
  const second = scanMonitorDeaths()

  assert.equal(second.unreported.length, 1, 'a new signature reports again, not just a new key')
  assert.equal(second.unreported[0]!.pid, 222)
})

test('scanMonitorDeaths: a dead pr-monitor lock is not reported (FLOW-402: no process to die)', () => {
  writeFileSync(
    lockPath('500', 'owner/repo'),
    JSON.stringify({
      pid: 999_999_999,
      startedAt: staleHeartbeat(),
      heartbeatAt: staleHeartbeat(),
    })
  )

  const scan = scanMonitorDeaths()

  assert.deepEqual(scan.all, [])
  assert.deepEqual(scan.unreported, [])
})

test('recordMonitorDeathsReported: prunes the entry once the monitor is no longer dead, and drops pr-monitor keys', () => {
  writeDeadRenovateLock(999_999_991, staleHeartbeat())
  const ledgerFile = join(storeDir(), 'deaths-reported.json')
  writeFileSync(ledgerFile, JSON.stringify({ 'owner/repo#503': '1:2026-01-01T00:00:00.000Z' }))
  const first = scanMonitorDeaths()
  recordMonitorDeathsReported(first.all)
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(ledgerFile, 'utf-8')) as Record<string, string>),
    ['renovate-pr-monitor'],
    'the old pr-monitor key is gone, the Renovate death is recorded'
  )

  rmSync(renovateLockPath()) // stands in for a restart

  recordMonitorDeathsReported(scanMonitorDeaths().all)

  assert.deepEqual(JSON.parse(readFileSync(ledgerFile, 'utf-8')), {})
})

test('scanMonitorDeaths: an unparseable ledger reports rather than suppresses', () => {
  writeDeadRenovateLock(999_999_995, staleHeartbeat())
  writeFileSync(join(storeDir(), 'deaths-reported.json'), '{{{')

  const scan = scanMonitorDeaths()

  assert.equal(
    scan.unreported.length,
    1,
    'a torn/corrupt ledger fails toward reporting, not silence'
  )
})

// scanMonitorDeaths' loadLedger call and recordMonitorDeathsReported's ledgerPath call both take
// rawSessionId, and every other test here omits it, so all of them fall through to the ambient env
// var and could never catch the ledger half being silently dropped. Reachable in production:
// resolveRawSessionId prefers an explicit --session over the env var. The second existsSync is the
// whole test: without it, this passes even if the ledger were written into the wrong partition.
test('scanMonitorDeaths / recordMonitorDeathsReported: the ledger is pinned to the session id passed in, not the ambient env', () => {
  const sessionA = 'flow-224-monitor-deaths-test-session-a'
  mkdirSync(storeDir(sessionA), { recursive: true })
  writeDeadRenovateLock(999_999_999, staleHeartbeat(), sessionA)

  const scan = scanMonitorDeaths(sessionA)
  assert.equal(
    scan.unreported.length,
    1,
    "precondition: session A's own query finds its dead monitor"
  )

  recordMonitorDeathsReported(scan.all, sessionA)

  assert.equal(
    existsSync(join(storeDir(sessionA), 'deaths-reported.json')),
    true,
    "the ledger is written into session A's own partition"
  )
  assert.equal(
    existsSync(join(storeDir(), 'deaths-reported.json')),
    false,
    'the ledger must NOT leak into the ambient-env partition'
  )

  const second = scanMonitorDeaths(sessionA)
  assert.equal(
    second.unreported.length,
    0,
    'recorded against the RIGHT partition, so session A sees it silenced on the next scan'
  )
})
