import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storeDir } from '../pr-monitor/state.ts'
import { renovateLockPath } from '../renovate-pr-monitor/lock.ts'
import { formatMonitorDeath, scanMonitorDeaths } from './monitor-deaths.ts'

let homeDir: string
let origHome: string | undefined
let origSessionId: string | undefined

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'monitor-deaths-renovate-test-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = `monitor-deaths-renovate-test-${homeDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)}`
  mkdirSync(storeDir(), { recursive: true })
})

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = origHome
  }
  if (origSessionId === undefined) {
    delete process.env.CLAUDE_CODE_SESSION_ID
  } else {
    process.env.CLAUDE_CODE_SESSION_ID = origSessionId
  }
  try {
    rmSync(homeDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const staleHeartbeat = (): string => new Date(Date.now() - 15 * 60_000).toISOString()

test('scanMonitorDeaths: a dead Renovate lock reports with the Renovate restart line', () => {
  const renovateHeartbeat = staleHeartbeat()
  writeFileSync(
    renovateLockPath(),
    JSON.stringify({ pid: 222, startedAt: renovateHeartbeat, heartbeatAt: renovateHeartbeat })
  )

  const scan = scanMonitorDeaths()

  assert.deepEqual(scan.unreported.map(formatMonitorDeath), [
    `[renovate-pr-monitor] dead-monitor — the monitor loop (pid 222) exited without emitting an ` +
      `event; last heartbeat ${renovateHeartbeat}. No further event can arrive. Restart it: ` +
      `renovate-pr-monitor`,
  ])
})
