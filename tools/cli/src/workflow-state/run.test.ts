import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { runRecordEntry, runCheck, runBypass, runBanner } from './run.ts'
import { markWorkflowEntered, loadWorkflowState, workflowStateFilePath } from './state.ts'
import { registryFilePath } from '../dashboard/registry.ts'
import { stateFilePath } from '../dashboard/state.ts'
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'

const resetExitCode = (): void => setRequestedExitCode(0)
const exitCodeIsError = (): boolean => {
  const code = getRequestedExitCode()
  return code !== undefined && code !== 0
}

let tmpDir: string
let id: string
let origSessionId: string | undefined
let homeDir: string
let origHome: string | undefined

// workflowStateFilePath resolves through the durable store, which is homedir()-relative —
// override HOME so these tests never touch the real ~/.claude/workflow-state.
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'workflow-run-test-'))
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  id = `test-workflow-run-${uniqueId}`
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = id
  homeDir = mkdtempSync(join(tmpdir(), 'workflow-run-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
  resetExitCode()
})

afterEach(() => {
  if (origSessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = origSessionId
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

/** Suppress and capture stdout written during fn(), then restore it. */
const captureStdout = (fn: () => void): string => {
  const chunks: string[] = []
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk))
    return true
  }
  try {
    fn()
  } finally {
    process.stdout.write = orig
  }
  return chunks.join('')
}

test('runRecordEntry: writes a marker readable by loadWorkflowState, with key', () => {
  const output = captureStdout(() => runRecordEntry('implementation', 'FLOW-147'))

  const state = loadWorkflowState(id)
  assert.equal(state?.workflow?.phase, 'implementation', 'phase round-trips')
  assert.equal(state?.workflow?.key, 'FLOW-147', 'key round-trips')
  assert.ok(output.includes('entry recorded'), 'prints a confirmation')
})

test('runRecordEntry: key is optional — omitting it omits the field entirely', () => {
  captureStdout(() => runRecordEntry('implementation', undefined))

  const state = loadWorkflowState(id)
  assert.ok(state?.workflow, 'marker written without a key')
  assert.ok(!('key' in state!.workflow!), 'key field is omitted, not defaulted, when absent')
})

test('runRecordEntry: distinct from bypass — does not touch the bypass field', () => {
  captureStdout(() => runRecordEntry('implementation', 'FLOW-147'))

  const state = loadWorkflowState(id)
  assert.equal(state?.bypass, undefined, 'runRecordEntry never records a bypass')
})

test('runRecordEntry: stamps provenance via=record-entry (FLOW-147 review round 4 Fix B)', () => {
  captureStdout(() => runRecordEntry('implementation', 'FLOW-147'))

  const state = loadWorkflowState(id)
  assert.equal(state?.workflow?.via, 'record-entry', 'marker traces back to the record-entry verb')
})

test('runRecordEntry: blank --phase is rejected (PR #214 sweep)', () => {
  assert.throws(
    () => runRecordEntry('', 'FLOW-147'),
    /--phase must not be empty/,
    'empty string phase throws'
  )
  // Assert the state FILE was never created, not just that a read returns null — null is also
  // what a corrupt/unparseable file would produce, so it can't prove nothing was written.
  assert.equal(
    existsSync(workflowStateFilePath(id)),
    false,
    'no marker file written when phase is rejected'
  )
})

test('runRecordEntry: whitespace-only --phase is rejected (PR #214 sweep)', () => {
  assert.throws(
    () => runRecordEntry('   ', 'FLOW-147'),
    /--phase must not be empty/,
    'whitespace-only phase throws'
  )
  assert.equal(
    existsSync(workflowStateFilePath(id)),
    false,
    'no marker file written when phase is rejected'
  )
})

test('runRecordEntry: blank --key is normalized to omitted, not rejected', () => {
  captureStdout(() => runRecordEntry('implementation', '   '))

  const state = loadWorkflowState(id)
  assert.ok(state?.workflow, 'marker still written — a blank key is cosmetic, not a defect')
  assert.ok(!('key' in state!.workflow!), 'blank key is normalized away, not stored as whitespace')
})

test('runRecordEntry: non-blank phase/key are unaffected by the new guards', () => {
  captureStdout(() => runRecordEntry('implementation', 'FLOW-147'))

  const state = loadWorkflowState(id)
  assert.equal(state?.workflow?.phase, 'implementation', 'phase unaffected')
  assert.equal(state?.workflow?.key, 'FLOW-147', 'key unaffected')
})

test('runRecordEntry: stores the trimmed phase, not the raw padded value (PR #214 follow-up nit)', () => {
  const output = captureStdout(() => runRecordEntry('  implementation  ', 'FLOW-147'))

  const state = loadWorkflowState(id)
  assert.equal(state?.workflow?.phase, 'implementation', 'stored phase is trimmed')
  assert.ok(output.includes('phase=implementation'), 'confirmation also uses the trimmed value')
  assert.ok(!output.includes('phase=  implementation'), 'confirmation does not echo raw padding')
})

test('runCheck: marker present — no requested exit code', () => {
  markWorkflowEntered(id, { phase: 'implementation', via: 'record-entry' })

  captureStdout(() => runCheck())

  assert.equal(exitCodeIsError(), false, 'no error exit code requested when a marker exists')
})

test('runCheck: bypass only — passes', () => {
  captureStdout(() => runBypass('proof'))
  resetExitCode()

  captureStdout(() => runCheck())

  assert.equal(exitCodeIsError(), false, 'no error exit code requested when a bypass exists')
})

test('runCheck: neither marker nor bypass — requested exit code 3', () => {
  captureStdout(() => runCheck())

  assert.equal(getRequestedExitCode(), 3, 'exit code 3 requested when neither is present')
})

test('runCheck: a blank-phase marker on disk is treated as absent — requested exit code 3 (FLOW-147 PR #214 follow-up, M8)', () => {
  // A marker written by some path with an unguarded blank phase (dashboard/enter.ts's writer,
  // before this fix, had no equivalent to runRecordEntry's guard). The gate must treat it as
  // no-workflow, not as a pass.
  mkdirSync(dirname(workflowStateFilePath(id)), { recursive: true })
  writeFileSync(
    workflowStateFilePath(id),
    JSON.stringify({ workflow: { phase: '', enteredAt: '2026-01-01', via: 'dashboard-enter' } })
  )

  captureStdout(() => runCheck())

  assert.equal(getRequestedExitCode(), 3, 'a blank-phase marker does not satisfy the check')
})

test('runBanner: no state — prints NO WORKFLOW ACTIVE naming all three entry skills', () => {
  const output = captureStdout(() => runBanner())

  assert.ok(output.startsWith('Workflow status:'), 'starts with the contract prefix')
  assert.ok(output.includes('NO WORKFLOW ACTIVE'), 'names the no-workflow state')
  assert.ok(output.includes('JTBD'), 'names JTBD')
  assert.ok(output.includes('Quick Change'), 'names Quick Change')
  assert.ok(output.includes('Systematic Debugging'), 'names Systematic Debugging')
})

test('runBanner: no state — still reports open items symmetrically with the active branch', () => {
  const output = captureStdout(() => runBanner())

  assert.ok(output.includes('open items: 0'), 'open items count is present even with no workflow')
})

test('runBanner: marker present — prints phase, key, and via', () => {
  markWorkflowEntered(id, { phase: 'implementation', key: 'FLOW-147', via: 'record-entry' })

  const output = captureStdout(() => runBanner())

  assert.ok(output.startsWith('Workflow status:'), 'starts with the contract prefix')
  assert.ok(output.includes('phase=implementation'), 'includes the phase')
  assert.ok(output.includes('key=FLOW-147'), 'includes the key')
  assert.ok(
    output.includes('via=record-entry'),
    'includes provenance (FLOW-147 review round 4 Fix B)'
  )
})

const plantUnreadableRegistry = (rawId: string): void => {
  rmSync(registryFilePath(rawId), { recursive: true, force: true })
  mkdirSync(registryFilePath(rawId), { recursive: true })
  assert.throws(
    () => readFileSync(registryFilePath(rawId), 'utf-8'),
    /EISDIR/,
    'precondition: the fixture must actually be unreadable, or this test observes nothing'
  )
}

test('runBanner: an unreadable registry does not delete the whole banner — open items reads "unknown"', () => {
  markWorkflowEntered(id, { phase: 'implementation', key: 'FLOW-147', via: 'record-entry' })
  plantUnreadableRegistry(id)

  let output = ''
  assert.doesNotThrow(() => {
    output = captureStdout(() => runBanner())
  }, 'an unreadable registry must not escape runBanner and drop the workflow-status half')

  assert.ok(output.startsWith('Workflow status:'), 'starts with the contract prefix')
  assert.ok(output.includes('phase=implementation'), 'workflow half survives the registry failure')
  assert.ok(output.includes('open items: unknown'), 'open items is marked unknown, not silently 0')
})

test('runBanner: a corrupt state file reads "unknown", not a confident 0 (FLOW-226 finding 71d415d1d781)', () => {
  markWorkflowEntered(id, { phase: 'implementation', key: 'FLOW-147', via: 'record-entry' })
  // With no registry, resolveSessionId falls through to the raw id — so this is the file the
  // banner's own open-item read reaches.
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(stateFilePath(id), '{"registered": true, "openItemIds": 3}')

  const output = captureStdout(() => runBanner())

  assert.ok(output.includes('phase=implementation'), 'the workflow half still prints')
  assert.ok(
    output.includes('open items: unknown'),
    'a count this process could not read is not reported as 0'
  )
})

test('runBanner: a state file that is present and unreadable still reads "unknown" (FLOW-226)', () => {
  markWorkflowEntered(id, { phase: 'implementation', key: 'FLOW-147', via: 'record-entry' })
  // A directory at the file's path rather than a chmod: root bypasses permission bits, so a
  // mode-000 file stays readable under a root test runner and the fixture would never reach the
  // arm under test. EISDIR comes back to every uid.
  mkdirSync(stateFilePath(id), { recursive: true })
  assert.throws(
    () => readFileSync(stateFilePath(id), 'utf-8'),
    /EISDIR/,
    'precondition: the fixture must actually be unreadable, or this test observes nothing'
  )

  const output = captureStdout(() => runBanner())

  assert.ok(
    output.includes('open items: unknown'),
    `an open set this process could not read stays unknown, banner was: ${output}`
  )
})

test('runBanner: a state whose only defect is deferredIdCounter reports its real open count, not "unknown" (FLOW-226)', () => {
  markWorkflowEntered(id, { phase: 'implementation', key: 'FLOW-147', via: 'record-entry' })
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  // deferredIdCounter is the one stateFileIsCorrupt arm loadState never consults, so openItemIds
  // below is a list this process really did read — two entries, so the count cannot be mistaken
  // for a `?? 0` default.
  writeFileSync(
    stateFilePath(id),
    '{"registered":true,"openItemIds":["i-1","i-2"],"deferredIdCounter":-5}'
  )

  const output = captureStdout(() => runBanner())

  assert.match(
    output,
    /open items: 2\n/,
    `a count that read fine is reported rather than masked, banner was: ${output}`
  )
})

test('runBypass: writes a bypass record readable by loadWorkflowState', () => {
  captureStdout(() => runBypass('proof reason'))

  const state = loadWorkflowState(id)
  assert.equal(state?.bypass?.reason, 'proof reason', 'bypass reason round-trips')
  assert.ok(state?.bypass?.grantedAt, 'grantedAt is present')
})

test('runBypass: blank --reason is rejected (PR #214 CodeRabbit finding)', () => {
  assert.throws(() => runBypass(''), /--reason must not be empty/, 'empty string reason throws')
  // Assert the state FILE was never created, not just that a read returns null — see the
  // runRecordEntry rejection tests above for why the null idiom can't prove this.
  assert.equal(
    existsSync(workflowStateFilePath(id)),
    false,
    'no bypass file written when reason is rejected'
  )
})

test('runBypass: whitespace-only --reason is rejected (PR #214 CodeRabbit finding)', () => {
  assert.throws(
    () => runBypass('   '),
    /--reason must not be empty/,
    'whitespace-only reason throws'
  )
  assert.equal(
    existsSync(workflowStateFilePath(id)),
    false,
    'no bypass file written when reason is rejected'
  )
})

test('runBypass: non-blank reason is unaffected by the new guard', () => {
  captureStdout(() => runBypass('genuine reason'))

  const state = loadWorkflowState(id)
  assert.equal(state?.bypass?.reason, 'genuine reason', 'unaffected — still round-trips')
})

test('runBypass: stores the trimmed reason, not the raw padded value (PR #214 follow-up nit)', () => {
  const output = captureStdout(() => runBypass('  genuine reason  '))

  const state = loadWorkflowState(id)
  assert.equal(state?.bypass?.reason, 'genuine reason', 'stored reason is trimmed')
  assert.ok(
    output.includes('bypass recorded for this session: genuine reason'),
    'confirmation also uses the trimmed value'
  )
})
