import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  loadWorkflowState,
  markWorkflowEntered,
  recordBypass,
  clearWorkflowState,
  workflowStateFilePath,
} from './state.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

let tmpDir: string
let id: string
let homeDir: string
let origHome: string | undefined

// workflowStateFilePath resolves through the durable store, which is homedir()-relative —
// override HOME so these tests never touch the real ~/.claude/workflow-state.
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'workflow-state-test-'))
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  id = `test-workflow-${uniqueId}`
  homeDir = mkdtempSync(join(tmpdir(), 'workflow-state-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  try {
    rmSync(homeDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('marker round-trips through markWorkflowEntered/loadWorkflowState', () => {
  markWorkflowEntered(id, { phase: 'implementation', key: 'FLOW-147', via: 'record-entry' })

  const state = loadWorkflowState(id)
  assert.equal(state!.workflow!.phase, 'implementation', 'phase round-trips')
  assert.equal(state!.workflow!.key, 'FLOW-147', 'key round-trips')
  assert.ok(state!.workflow!.enteredAt.length > 0, 'enteredAt is present')
})

test('markWorkflowEntered without key omits the field entirely', () => {
  markWorkflowEntered(id, { phase: 'implementation', via: 'record-entry' })

  const state = loadWorkflowState(id)
  assert.ok(!('key' in state!.workflow!), 'key field is omitted, not defaulted, when absent')
})

test('markWorkflowEntered preserves an existing bypass (spread rule)', () => {
  recordBypass(id, 'pre-existing bypass')
  markWorkflowEntered(id, { phase: 'implementation', via: 'record-entry' })

  const state = loadWorkflowState(id)
  assert.equal(state!.bypass!.reason, 'pre-existing bypass', 'bypass survives the marker write')
  assert.equal(state!.workflow!.phase, 'implementation', 'marker was also written')
})

test('recordBypass preserves an existing workflow marker (spread rule)', () => {
  markWorkflowEntered(id, { phase: 'implementation', key: 'FLOW-147', via: 'record-entry' })
  recordBypass(id, 'explicit exception')

  const state = loadWorkflowState(id)
  assert.equal(state!.workflow!.phase, 'implementation', 'marker survives the bypass write')
  assert.equal(state!.workflow!.key, 'FLOW-147', 'marker key survives the bypass write')
  assert.equal(state!.bypass!.reason, 'explicit exception', 'bypass was also written')
})

test('loadWorkflowState returns null for a missing file', () => {
  assert.equal(loadWorkflowState(id), null, 'no file has ever been written for this id')
})

test('clearWorkflowState is idempotent (double-clear does not throw)', () => {
  markWorkflowEntered(id, { phase: 'implementation', via: 'record-entry' })
  clearWorkflowState(id)
  assert.equal(loadWorkflowState(id), null, 'state is gone after the first clear')

  assert.doesNotThrow(() => clearWorkflowState(id), 'clearing an already-missing file is a no-op')
})

test('re-markWorkflowEntered overwrites phase/key (re-entry updates the marker)', () => {
  markWorkflowEntered(id, { phase: 'design', key: 'FLOW-100', via: 'record-entry' })
  markWorkflowEntered(id, { phase: 'implementation', key: 'FLOW-147', via: 'dashboard-enter' })

  const state = loadWorkflowState(id)
  assert.equal(state!.workflow!.phase, 'implementation', 'phase reflects the latest entry')
  assert.equal(state!.workflow!.key, 'FLOW-147', 'key reflects the latest entry')
  assert.equal(state!.workflow!.via, 'dashboard-enter', 'via reflects the latest entry too')
})

test('markWorkflowEntered: provenance round-trips for both writers (FLOW-147 review round 4 Fix B)', () => {
  markWorkflowEntered(id, { phase: 'implementation', via: 'dashboard-enter' })
  assert.equal(
    loadWorkflowState(id)!.workflow!.via,
    'dashboard-enter',
    'dashboard-enter provenance round-trips'
  )

  markWorkflowEntered(id, { phase: 'implementation', via: 'record-entry' })
  assert.equal(
    loadWorkflowState(id)!.workflow!.via,
    'record-entry',
    'record-entry provenance round-trips'
  )
})

test('loadWorkflowState normalizes an invalid marker ({"workflow":{}}) to absent, not open-the-gate', () => {
  // Simulate a corrupt/partial write: a workflow object present but missing its required fields.
  // Must not be treated as "workflow entered" — that would open the gate and print phase=undefined.
  mkdirSync(dirname(workflowStateFilePath(id)), { recursive: true })
  writeFileSync(workflowStateFilePath(id), JSON.stringify({ workflow: {} }))

  const state = loadWorkflowState(id)
  assert.equal(state!.workflow, undefined, 'an invalid marker normalizes to undefined, not {}')
})

test('loadWorkflowState rejects a marker whose key is not a string (FLOW-147 review round 3, M7 nit)', () => {
  // key must be type-checked exactly like phase/enteredAt — a non-string key must invalidate
  // the whole marker, not get spread in as-is.
  mkdirSync(dirname(workflowStateFilePath(id)), { recursive: true })
  writeFileSync(
    workflowStateFilePath(id),
    JSON.stringify({ workflow: { phase: 'implementation', enteredAt: '2026-01-01', key: 12345 } })
  )

  const state = loadWorkflowState(id)
  assert.equal(state!.workflow, undefined, 'a non-string key invalidates the entire marker')
})

test('loadWorkflowState rejects a marker with a bogus via (FLOW-147 review round 4 Fix B)', () => {
  // via must be exactly 'dashboard-enter' or 'record-entry' — anything else (a typo, a made-up
  // writer name, a future verb that forgot to update the union) invalidates the whole marker,
  // the same way an invalid phase/enteredAt/key does. An untraceable marker is exactly the gap
  // provenance closes, so a marker with unrecognized provenance must not be trusted either.
  mkdirSync(dirname(workflowStateFilePath(id)), { recursive: true })
  writeFileSync(
    workflowStateFilePath(id),
    JSON.stringify({
      workflow: { phase: 'implementation', enteredAt: '2026-01-01', via: 'some-made-up-verb' },
    })
  )

  const state = loadWorkflowState(id)
  assert.equal(state!.workflow, undefined, 'a bogus via invalidates the entire marker')
})

test('loadWorkflowState rejects a marker with a blank phase (FLOW-147 PR #214 follow-up, M8)', () => {
  // The blank-phase invariant belongs at the read layer, not just in the writers: this is where
  // EVERY marker — from every current and future writer — passes through before the gate sees
  // it. dashboard/enter.ts's own writer had no run-layer guard equivalent to runRecordEntry's/
  // runBypass's, so a blank --phase there wrote an unusable marker that still opened the gate.
  mkdirSync(dirname(workflowStateFilePath(id)), { recursive: true })
  writeFileSync(
    workflowStateFilePath(id),
    JSON.stringify({ workflow: { phase: '', enteredAt: '2026-01-01', via: 'dashboard-enter' } })
  )

  const state = loadWorkflowState(id)
  assert.equal(state!.workflow, undefined, 'a blank phase invalidates the entire marker')
})

// FLOW-183 live reproduction: the marker must be readable from a DIFFERENT real working
// directory than the one it was recorded under. Drives the actual CLI (main.ts) in two separate
// subprocesses, each launched with its own real `cwd` — not an in-process chdir() — because
// store.ts's resolveDirKey() pins its result for the lifetime of the process (FLOW-165), so an
// in-process chdir after the first store access would not re-resolve a stale cwd-derived key.
// Two real process launches are what actually reproduces the cwd-coupling defect.
test('cross-cwd: a marker recorded in one directory is found from a different directory (FLOW-183)', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'workflow-state-cwd-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'workflow-state-cwd-b-'))
  try {
    const recordResult = runCliIn(dirA, [
      'workflow-state',
      'record-entry',
      '--phase',
      'implementation',
      '--key',
      'FLOW-183',
    ])
    assert.equal(
      recordResult.status,
      0,
      `record-entry in dir A succeeded (stderr: ${recordResult.stderr})`
    )

    const checkResult = runCliIn(dirB, ['workflow-state', 'check'])
    assert.equal(
      checkResult.status,
      0,
      'a marker recorded under dir A is found when checked from dir B'
    )

    const bannerResult = runCliIn(dirB, ['workflow-state', 'banner'])
    assert.ok(
      bannerResult.stdout.includes('phase=implementation'),
      'phase read back correctly from dir B'
    )
    assert.ok(bannerResult.stdout.includes('key=FLOW-183'), 'key read back correctly from dir B')
  } finally {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('same-cwd: recording and reading from the same directory still works (no regression)', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'workflow-state-cwd-same-'))
  try {
    const recordResult = runCliIn(dirA, [
      'workflow-state',
      'record-entry',
      '--phase',
      'implementation',
      '--key',
      'FLOW-183',
    ])
    assert.equal(recordResult.status, 0, `record-entry succeeded (stderr: ${recordResult.stderr})`)

    const checkResult = runCliIn(dirA, ['workflow-state', 'check'])
    assert.equal(checkResult.status, 0, 'the same-directory read still finds the marker')
  } finally {
    rmSync(dirA, { recursive: true, force: true })
  }
})

/** Spawn the real CLI (main.ts) with a given real cwd, sharing this test's session id/HOME. */
const runCliIn = (
  cwd: string,
  args: string[]
): { stdout: string; stderr: string; status: number | null } => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, ...args],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_SESSION_ID: id,
        HOME: homeDir,
      },
    }
  )
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}
