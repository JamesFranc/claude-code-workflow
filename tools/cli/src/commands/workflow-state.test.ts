import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadWorkflowState } from '../workflow-state/state.ts'

// FLOW-148: parseNonBlankString('--phase') must reject a blank --phase at the Stricli CLI
// boundary (commands/workflow-state.ts), not just in the run-layer guard runRecordEntry already
// had since FLOW-147. Spawns the real CLI (main.ts) — the same pattern commands/dashboard.test.ts
// uses — so a future flag-definition regression (e.g. reverting to plain `parse: String`) fails
// here instead of shipping unnoticed, since a direct call to runRecordEntry bypasses the Stricli
// flag layer entirely and would not catch it.

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

let rawId: string
let origSessionId: string | undefined
let homeDir: string
let origHome: string | undefined

// loadWorkflowState (called directly, in-process) resolves through the durable store, which is
// homedir()-relative AND session-partitioned by process.env.CLAUDE_CODE_SESSION_ID — override
// both HERE (not just in the spawned child's env below) so the parent's direct read lands in the
// same partition the child CLI process wrote to, and neither touches the real
// ~/.claude/workflow-state.
beforeEach(() => {
  const uniqueId = `${Date.now()}-${Math.random()}`.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  rawId = `test-workflow-state-cmd-${uniqueId}`
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  homeDir = mkdtempSync(join(tmpdir(), 'workflow-state-cmd-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
})

afterEach(() => {
  if (origSessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = origSessionId
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  try {
    rmSync(homeDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const runCli = (args: string[]): { stdout: string; stderr: string; status: number | null } => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_SESSION_ID: rawId,
      },
    }
  )
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

test('CLI: workflow-state record-entry --phase "" is rejected at the CLI boundary (FLOW-148)', () => {
  const { stderr, status } = runCli(['workflow-state', 'record-entry', '--phase', ''])

  assert.notEqual(status, 0, 'exits non-zero')
  assert.ok(
    stderr.includes('--phase must not be blank'),
    'the blank-phase rejection reaches the CLI boundary, not just the run-layer guard'
  )
  assert.equal(
    loadWorkflowState(rawId),
    null,
    'no workflow marker was written — the CLI boundary rejected before runRecordEntry ran'
  )
})

test('CLI: workflow-state record-entry --phase implementation succeeds (control)', () => {
  const { status } = runCli(['workflow-state', 'record-entry', '--phase', 'implementation'])

  assert.equal(status, 0, 'exits 0 for a non-blank phase')
  const state = loadWorkflowState(rawId)
  assert.equal(state?.workflow?.phase, 'implementation', 'the marker was actually recorded')
})
