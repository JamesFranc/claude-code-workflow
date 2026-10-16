import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { runStopGate, MAX_BLOCKS, hasPendingWork, isSessionLive } from './stop-gate.ts'
import { saveState as saveDashboardState, stateFilePath, hashId } from '../dashboard/state.ts'
import { pollTargets } from './check.ts'
import { upsertRegistryNode, registryFilePath } from '../dashboard/registry.ts'
import { resolveSessionId } from '../dashboard/session-id.ts'
import { load, sessionScope, storePath } from '../workflow-store/store.ts'

// A stub ai-workflow-app that answers 'session list' with the given JSON; all other calls
// emit '{}'. Mirrors mailbox.test.ts's writeAnswersStub/boardRow pattern.
const writeBoardStub = (dir: string, sessionListJson: string): string => {
  const path = join(dir, 'ai-workflow-app')
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `if echo "$@" | grep -q 'session list'; then`,
      `  echo ${JSON.stringify(sessionListJson)}`,
      `else`,
      `  echo '{}'`,
      `fi`,
      'exit 0',
    ].join('\n') + '\n'
  )
  chmodSync(path, 0o755)
  return path
}

// A stub ai-workflow-app that answers 'session list' with the given JSON and 'answers' with the
// given released items; all other calls emit '{}'.
const writeBoardStubWithAnswers = (
  dir: string,
  sessionListJson: string,
  answersJson: string
): string => {
  const path = join(dir, 'ai-workflow-app')
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `if echo "$@" | grep -q 'session list'; then`,
      `  echo ${JSON.stringify(sessionListJson)}`,
      `elif [ "$1" = answers ]; then`,
      `  echo ${JSON.stringify(answersJson)}`,
      `else`,
      `  echo '{}'`,
      `fi`,
      'exit 0',
    ].join('\n') + '\n'
  )
  chmodSync(path, 0o755)
  return path
}

const boardRow = (opts: { id: string; externalId: string; lifecycle: string }): unknown => ({
  session: {
    id: opts.id,
    systemId: 'claude-workflow',
    externalId: opts.externalId,
    title: opts.externalId,
    phase: 'implementation',
    lifecycle: opts.lifecycle,
    parentId: null,
  },
  status: 'ok',
  openItemCount: 0,
})

// ---------------------------------------------------------------------------
// Output capture
// ---------------------------------------------------------------------------

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

// Full stdout (`allow`, or `block\n<reason>`), trailing newline stripped.
const gate = (session?: string): string =>
  captureStdout(() => runStopGate(session)).replace(/\n$/, '')
// Just the decision line, for tests that don't care about the reason text.
const decision = (session?: string): string => gate(session).split('\n')[0]!
// ---------------------------------------------------------------------------
// Raw gate-state file access — the gate's own state file is private to stop-gate.ts, so the
// FLOW-186 tests below read/write it directly at the same durable path the gate itself uses
// (mirrors stop-gate.ts's own gateName/loadGateState/saveGateState).
// ---------------------------------------------------------------------------

interface RawGateState {
  attempts?: number
  signature?: string
  resetForStartedAt?: number // retired field: an old file may still carry it
}

const gateStateName = (id: string): string => `mailbox-gate-${hashId(id)}.json`

const readGateState = (id: string): RawGateState | null => {
  const content = load(sessionScope(), gateStateName(id))
  if (content === null) {
    return null
  }
  return JSON.parse(content) as RawGateState
}

const writeGateState = (id: string, state: RawGateState): void => {
  const path = storePath(sessionScope(), gateStateName(id))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2))
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

let tmpDir: string
let origSessionId: string | undefined
let origBin: string | undefined
// Each test assigns its own session id here (rather than a local const) purely for readability at
// call sites — dashboard-<hash>.json and mailbox-gate-<hash>.json
// both resolve through the durable store (FLOW-156 Phases 2-3), so the temp-HOME teardown below
// cleans up every one of them; no per-prefix tmpdir() cleanup is needed.
let sessionId: string | undefined
let homeDir: string
let origHome: string | undefined

// Every sink here resolves through the durable store, which is homedir()-relative — override HOME
// so these tests never touch the real ~/.claude/workflow-state.
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'stop-gate-test-'))
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  origBin = process.env.AI_WORKFLOW_APP_BIN
  // Default to a nonexistent binary so resolveDashboardBin() returns null without probing
  // PATH — a unit test must never reach the real ai-workflow-app / production server. Tests
  // that need a real board response override this in-body with their own stub.
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  process.env.CLAUDE_CODE_SESSION_ID = `stop-gate-session-${tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)}`
  sessionId = undefined
  homeDir = mkdtempSync(join(tmpdir(), 'stop-gate-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
})

afterEach(() => {
  if (origSessionId === undefined) {
    delete process.env.CLAUDE_CODE_SESSION_ID
  } else {
    process.env.CLAUDE_CODE_SESSION_ID = origSessionId
  }
  if (origBin === undefined) {
    delete process.env.AI_WORKFLOW_APP_BIN
  } else {
    process.env.AI_WORKFLOW_APP_BIN = origBin
  }
  if (origHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = origHome
  }
  try {
    rmSync(homeDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('stop-gate: unresolvable session id → allow', () => {
  delete process.env.CLAUDE_CODE_SESSION_ID
  assert.equal(decision(), 'allow')
})

test('stop-gate: no pending work → allow, and a subsequent re-arm starts fresh (gate was cleared)', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  sessionId = `stop-gate-cleared-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId

  // No dashboard state — nothing pending.
  assert.equal(decision(), 'allow', 'no pending work allows')

  // Arm on a board-confirmed-live, quiet session — MAX_BLOCKS(2) blocks, then the 3rd call exhausts.
  saveDashboardState(sessionId, { registered: true, phase: 'prd', openItemIds: [] })
  const setBoard = (lifecycle: string): void => {
    process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(
      tmpDir,
      JSON.stringify([boardRow({ id: sessionId!, externalId: sessionId!, lifecycle })])
    )
  }
  setBoard('active')
  assert.equal(decision(), 'block', 'call 1 blocks')
  assert.equal(decision(), 'block', 'call 2 blocks')
  assert.equal(decision(), 'allow', 'call 3 allows (exhausted)')

  // The board ends the session — pending work goes false, gate must clear (not just report allow).
  setBoard('ended')
  assert.equal(decision(), 'allow', 'no pending work allows')

  // Re-arm (same signature as the first arm). If the gate file were not actually cleared above,
  // this would resume from the exhausted attempts count and allow immediately.
  setBoard('active')
  assert.equal(decision(), 'block', 're-arming after a clear starts fresh, not from the old count')
})

// ---------------------------------------------------------------------------
// The gate's own MAX_BLOCKS attempt counter is keyed by the same
// canonical rawId key as the rest of the gate state — the resolved anchor drifting mid-sequence must
// not silently reset the counter to a fresh file.
// ---------------------------------------------------------------------------

test('stop-gate: the MAX_BLOCKS attempt counter survives an anchor drift mid-sequence', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  const rawId = `stop-gate-drift-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  sessionId = rawId

  const nodeA = `${rawId}:A`
  upsertRegistryNode(rawId, { internalId: nodeA, externalId: nodeA, key: 'A', parentId: null })
  saveDashboardState(nodeA, { registered: true, phase: 'implementation', openItemIds: [] })
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(
    tmpDir,
    JSON.stringify([boardRow({ id: nodeA, externalId: nodeA, lifecycle: 'active' })])
  )
  assert.equal(resolveSessionId(), nodeA, 'precondition: the anchor is A (the sole leaf)')

  assert.equal(decision(), 'block', 'call 1 (anchor=A): attempts -> 1')
  assert.equal(decision(), 'block', 'call 2 (anchor=A): attempts -> 2 (at MAX_BLOCKS)')

  // The registry grows a real root and sibling B, reparenting A underneath it — the anchor for
  // the NEXT call resolves to the root (registryLeaves > 1, ambiguity fallback), not A.
  const rootId = `${rawId}:root`
  upsertRegistryNode(rawId, { internalId: rootId, externalId: rawId, key: null, parentId: null })
  upsertRegistryNode(rawId, { internalId: nodeA, externalId: nodeA, key: 'A', parentId: rootId })
  const nodeB = `${rawId}:B`
  upsertRegistryNode(rawId, { internalId: nodeB, externalId: nodeB, key: 'B', parentId: rootId })
  assert.equal(resolveSessionId(), rootId, 'precondition: the anchor drifted from A to the root')

  // Without the fix, this 3rd call would read a FRESH gate-state file keyed to the new anchor
  // (rootId), silently resetting attempts to 0, and block again — defeating the FLOW-136 bound.
  assert.equal(
    decision(),
    'allow',
    'call 3 (drifted anchor): still the exhausting allow — the counter survived the drift'
  )
})

// ---------------------------------------------------------------------------
// FLOW-157: block on a board-confirmed-live, quiet session
// ---------------------------------------------------------------------------

test('stop-gate: quiet-live session (board confirms active) blocks with a generalized reason', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  sessionId = `stop-gate-quiet-live-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  saveDashboardState(sessionId, { registered: true, phase: 'prd', openItemIds: [] })
  const sessionListJson = JSON.stringify([
    boardRow({ id: sessionId, externalId: sessionId, lifecycle: 'active' }),
  ])
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(tmpDir, sessionListJson)

  const out = gate(sessionId)
  const lines = out.split('\n')

  assert.equal(lines[0], 'block', 'a board-confirmed-live, quiet session blocks (call 1)')
  assert.ok(
    !/is waiting on you/i.test(out),
    'the pending-item lead sentence must not appear when nothing is pending'
  )
  assert.ok(
    !/dashboard items? [0-9a-f]{8}/i.test(out),
    'no concrete item id is named — there is no item to name'
  )
  assert.ok(
    out.includes('Nothing is pending'),
    'reason is generalized truthfully for the no-concrete-item case'
  )
})

test('stop-gate: open items allow the stop — the wake mod answers them', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  sessionId = `stop-gate-open-items-allow-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  saveDashboardState(sessionId, { registered: true, phase: 'review', openItemIds: ['item-abc'] })
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(
    tmpDir,
    JSON.stringify([boardRow({ id: sessionId, externalId: sessionId, lifecycle: 'active' })])
  )

  assert.equal(gate(sessionId), 'allow')
})

test('stop-gate: open items clear an exhausted counter', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  sessionId = `stop-gate-open-items-clear-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  saveDashboardState(sessionId, { registered: true, phase: 'review', openItemIds: ['item-abc'] })
  writeGateState(sessionId, { attempts: MAX_BLOCKS + 1, signature: JSON.stringify({ items: [] }) })

  assert.equal(decision(sessionId), 'allow')
  assert.equal(readGateState(sessionId), null, 'the stored gate state is removed')
})

test('stop-gate: a released, unconsumed item blocks the stop and names its consume command', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  sessionId = `stop-gate-released-blocks-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  saveDashboardState(sessionId, { registered: true, phase: 'review', openItemIds: ['item-abc'] })
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStubWithAnswers(
    tmpDir,
    JSON.stringify([boardRow({ id: sessionId, externalId: sessionId, lifecycle: 'active' })]),
    JSON.stringify([{ id: 'item-abc', type: 'question', response: 'yes' }])
  )

  const out = gate(sessionId)

  assert.equal(
    out,
    'block\n' +
      'Released board items are still unconsumed. Reading an answer never consumes it, and an ' +
      'unconsumed item stays released on the board, reading as unanswered. ' +
      'Act on each one, then consume it:\n' +
      '[dashboard] item item-abc (question): yes\n' +
      `  → act on it, then consume it: \`dashboard item consume --item item-abc --session ${resolveSessionId(sessionId)}\`\n` +
      `This gate releases after ${MAX_BLOCKS} attempts either way.`
  )
})

test('stop-gate: a released comment blocks even with no open item of the agent’s own', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  sessionId = `stop-gate-released-comment-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  saveDashboardState(sessionId, { registered: true, phase: 'review', openItemIds: [] })
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStubWithAnswers(
    tmpDir,
    JSON.stringify([boardRow({ id: sessionId, externalId: sessionId, lifecycle: 'active' })]),
    JSON.stringify([{ id: 'comment-1', type: 'comment', response: 'one thing' }])
  )

  const out = gate(sessionId)

  const node = resolveSessionId(sessionId)
  assert.equal(
    out,
    'block\n' +
      'Released board items are still unconsumed. Reading an answer never consumes it, and an ' +
      'unconsumed item stays released on the board, reading as unanswered. ' +
      'Act on each one, then consume it:\n' +
      '[dashboard] item comment-1 (comment): one thing\n' +
      '  → reply on the board, not only in the terminal, unless it asks nothing and gives you nothing to act on: ' +
      `\`dashboard item add --type info --answers comment-1 --session ${node} --prompt "$(cat "<tmpfile>")"\`` +
      ' (a question instead only when the comment raises a decision that earns one),' +
      ` then consume it: \`dashboard item consume --item comment-1 --session ${node}\`\n` +
      `This gate releases after ${MAX_BLOCKS} attempts either way.`
  )
})

test('stop-gate: released items release the stop after MAX_BLOCKS attempts', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  sessionId = `stop-gate-released-bounded-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  saveDashboardState(sessionId, { registered: true, phase: 'review', openItemIds: ['item-abc'] })
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStubWithAnswers(
    tmpDir,
    JSON.stringify([boardRow({ id: sessionId, externalId: sessionId, lifecycle: 'active' })]),
    JSON.stringify([{ id: 'item-abc', type: 'question', response: 'yes' }])
  )

  for (let attempt = 1; attempt <= MAX_BLOCKS; attempt++) {
    assert.equal(decision(sessionId), 'block', `attempt ${attempt} blocks`)
  }
  assert.equal(decision(sessionId), 'allow', 'the bound releases it')
})

test('stop-gate: a newly released item re-arms an exhausted counter', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  sessionId = `stop-gate-released-rearm-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  saveDashboardState(sessionId, { registered: true, phase: 'review', openItemIds: ['item-abc'] })
  const sessionListJson = JSON.stringify([
    boardRow({ id: sessionId, externalId: sessionId, lifecycle: 'active' }),
  ])
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStubWithAnswers(
    tmpDir,
    sessionListJson,
    JSON.stringify([{ id: 'item-abc', type: 'question', response: 'yes' }])
  )
  for (let attempt = 1; attempt <= MAX_BLOCKS; attempt++) {
    assert.equal(decision(sessionId), 'block', `attempt ${attempt} blocks`)
  }
  assert.equal(decision(sessionId), 'allow', 'the counter is exhausted on the first release')

  process.env.AI_WORKFLOW_APP_BIN = writeBoardStubWithAnswers(
    tmpDir,
    sessionListJson,
    JSON.stringify([
      { id: 'item-abc', type: 'question', response: 'yes' },
      { id: 'item-def', type: 'question', response: 'no' },
    ])
  )

  assert.equal(decision(sessionId), 'block', 'a newly released item blocks again')
})

test('stop-gate: a failed answers read ends the loop, so a down board costs one call', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  const rawId = `stop-gate-released-failfast-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  sessionId = rawId
  const nodeA = `${rawId}:A`
  const nodeB = `${rawId}:B`
  upsertRegistryNode(rawId, { internalId: nodeA, externalId: nodeA, key: 'A', parentId: null })
  upsertRegistryNode(rawId, { internalId: nodeB, externalId: nodeB, key: 'B', parentId: null })
  saveDashboardState(nodeA, { registered: true, phase: 'review', openItemIds: ['item-a'] })
  saveDashboardState(nodeB, { registered: true, phase: 'review', openItemIds: ['item-b'] })
  const log = join(tmpDir, 'answers.log')
  const stub = join(tmpDir, 'ai-workflow-app')
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      `if [ "$1" = answers ]; then echo "$*" >> ${JSON.stringify(log)}; exit 1; fi`,
      `echo '{}'`,
      'exit 0',
    ].join('\n') + '\n'
  )
  chmodSync(stub, 0o755)
  process.env.AI_WORKFLOW_APP_BIN = stub
  assert.equal(pollTargets(rawId, resolveSessionId()).length, 2, 'precondition: two nodes')

  assert.equal(gate(), 'allow', 'a failed read blocks nothing')
  assert.equal(
    readFileSync(log, 'utf8').trim().split('\n').length,
    1,
    'one answers call, not one per node'
  )
})

test('stop-gate: an unparseable answers read ends the loop after one call', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  const rawId = `stop-gate-released-unparseable-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  sessionId = rawId
  const nodeA = `${rawId}:A`
  const nodeB = `${rawId}:B`
  upsertRegistryNode(rawId, { internalId: nodeA, externalId: nodeA, key: 'A', parentId: null })
  upsertRegistryNode(rawId, { internalId: nodeB, externalId: nodeB, key: 'B', parentId: null })
  saveDashboardState(nodeA, { registered: true, phase: 'review', openItemIds: ['item-a'] })
  saveDashboardState(nodeB, { registered: true, phase: 'review', openItemIds: ['item-b'] })
  const log = join(tmpDir, 'answers.log')
  const stub = join(tmpDir, 'ai-workflow-app')
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      `if [ "$1" = answers ]; then echo "$*" >> ${JSON.stringify(log)}; echo 'not json'; exit 0; fi`,
      `echo '{}'`,
      'exit 0',
    ].join('\n') + '\n'
  )
  chmodSync(stub, 0o755)
  process.env.AI_WORKFLOW_APP_BIN = stub
  assert.equal(pollTargets(rawId, resolveSessionId()).length, 2, 'precondition: two nodes')

  assert.equal(gate(), 'allow', 'an unparseable read blocks nothing')
  assert.equal(
    readFileSync(log, 'utf8').trim().split('\n').length,
    1,
    'one answers call, not one per node'
  )
})

test('stop-gate: an empty anchor phase omits the phase clause entirely (FLOW-223)', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  sessionId = `stop-gate-flow223-empty-phase-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  saveDashboardState(sessionId, { registered: true, phase: '', openItemIds: [] })
  const sessionListJson = JSON.stringify([
    boardRow({ id: sessionId, externalId: sessionId, lifecycle: 'active' }),
  ])
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(tmpDir, sessionListJson)

  const out = gate(sessionId)

  assert.equal(out.split('\n')[0], 'block', 'a quiet-live session with no phase still blocks')
  assert.ok(
    !out.includes('``'),
    'no empty backtick pair — the phase clause is omitted, never emitted blank'
  )
  assert.ok(
    !/You are in the/.test(out),
    'with no phase recorded the reason must not claim a phase at all'
  )
  assert.ok(/continue/i.test(out), 'the keep-working instruction still lands without a phase')
})

test('stop-gate: quiet-live session is told to keep working, not to park (FLOW-223)', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  sessionId = `stop-gate-flow223-keep-working-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  saveDashboardState(sessionId, { registered: true, phase: 'implementation', openItemIds: [] })
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(
    tmpDir,
    JSON.stringify([boardRow({ id: sessionId, externalId: sessionId, lifecycle: 'active' })])
  )

  const out = gate(sessionId)

  assert.equal(out.split('\n')[0], 'block', 'an active node with zero items still blocks')
  assert.ok(out.includes('Nothing is pending on the board'))
  assert.ok(!/receiver|mailbox watch/.test(out), 'the reason names no receiver')
  assert.ok(
    out.includes('you have no wake path and you keep working'),
    'the fallback lands: no nameable wake path means keep working'
  )
  assert.ok(!/you may stop/i.test(out), 'with zero open items the reason must NOT authorise a stop')
  assert.ok(/continue/i.test(out), 'the reason tells the agent to carry on with the work')
  assert.ok(
    out.includes('dashboard item add'),
    'the reason names the one action that would make waiting legitimate — posting an item'
  )
  assert.ok(
    out.includes('implementation'),
    'the reason names the active phase so the agent knows what to carry on with'
  )
})

test('stop-gate: the keep-working carve-out binds and cannot readmit the bug (FLOW-223)', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  sessionId = `stop-gate-flow223-carveout-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  saveDashboardState(sessionId, { registered: true, phase: 'implementation', openItemIds: [] })
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(
    tmpDir,
    JSON.stringify([boardRow({ id: sessionId, externalId: sessionId, lifecycle: 'active' })])
  )

  const out = gate(sessionId)

  assert.equal(out.split('\n')[0], 'block', 'the carve-out scenario still blocks')
  assert.ok(
    out.includes('ONLY if you can name'),
    'the carve-out is a forbid with a nameable condition, not an invitation to judge'
  )
  assert.ok(
    !/an open dashboard item/.test(out),
    'an open item is never offered as a wake path here — this body only runs when there are none'
  )
})

test('stop-gate: quiet-live session bound preserved — block, block, allow on the third call', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  sessionId = `stop-gate-quiet-live-bound-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  saveDashboardState(sessionId, { registered: true, phase: 'prd', openItemIds: [] })
  const sessionListJson = JSON.stringify([
    boardRow({ id: sessionId, externalId: sessionId, lifecycle: 'active' }),
  ])
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(tmpDir, sessionListJson)

  assert.equal(decision(), 'block', 'call 1 blocks')
  assert.equal(decision(), 'block', 'call 2 blocks')
  assert.equal(
    decision(),
    'allow',
    'call 3 allows — MAX_BLOCKS still bounds a stable empty (quiet-live) signature'
  )
})

test('stop-gate: board-confirmed terminal session allows and clears the gate', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  sessionId = `stop-gate-terminal-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  saveDashboardState(sessionId, { registered: true, phase: 'prd', openItemIds: [] })
  const setBoard = (lifecycle: string): void => {
    process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(
      tmpDir,
      JSON.stringify([boardRow({ id: sessionId!, externalId: sessionId!, lifecycle })])
    )
  }

  // Spend the whole budget while the board says active.
  setBoard('active')
  for (let i = 0; i < MAX_BLOCKS; i += 1) {
    assert.equal(decision(), 'block')
  }
  assert.equal(decision(), 'allow', 'precondition: the budget is spent')

  setBoard('ended')
  assert.equal(decision(), 'allow', 'a board-confirmed terminal session allows')

  // Prove the gate was actually cleared (not merely reporting allow): the same board going active
  // again must block fresh rather than resume from the spent budget.
  setBoard('active')
  assert.equal(
    decision(),
    'block',
    're-arming after the terminal allow starts fresh (gate cleared)'
  )
})

// ---------------------------------------------------------------------------
// A gate state file written by an earlier version
// ---------------------------------------------------------------------------

test('stop-gate: a gate state file carrying the retired resetForStartedAt still loads', () => {
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  sessionId = `stop-gate-legacy-state-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  saveDashboardState(sessionId, { registered: true, phase: 'prd', openItemIds: [] })
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(
    tmpDir,
    JSON.stringify([boardRow({ id: sessionId, externalId: sessionId, lifecycle: 'active' })])
  )

  writeGateState(sessionId, {
    attempts: 1,
    signature: JSON.stringify({ items: [] }),
    resetForStartedAt: 1,
  })

  assert.equal(
    decision(),
    'block',
    'call 1: the old file loads as attempts: 1 (not treated as corrupt/null)'
  )
  assert.equal(
    decision(),
    'allow',
    'call 2: exhausts — proves attempts continued from the loaded 1, not a reset-to-0 fresh file'
  )
})

// ---------------------------------------------------------------------------
// An unreadable registry. The gate must PRINT block and return normally: hooks/mailbox-watch.sh
// maps any non-zero exit from this command back to `allow` with stderr discarded, so a throw that
// escapes the process is indistinguishable from a decision to release the session.
// ---------------------------------------------------------------------------

const plantUnreadableRegistry = (rawId: string): void => {
  rmSync(registryFilePath(rawId), { recursive: true, force: true })
  mkdirSync(registryFilePath(rawId), { recursive: true })
  assert.throws(
    () => readFileSync(registryFilePath(rawId), 'utf-8'),
    /EISDIR/,
    'precondition: the fixture must actually be unreadable, or these tests observe nothing'
  )
}

test('stop-gate: an unreadable registry blocks, and does so without throwing out of the command', () => {
  sessionId = `stop-gate-unreadable-${tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  saveDashboardState(sessionId, { registered: true, phase: 'prd', openItemIds: [] })
  plantUnreadableRegistry(sessionId)

  // Not assert.doesNotThrow around the decision: an escaping throw is the failure mode under test,
  // and capturing the decision proves the command produced one rather than merely surviving.
  const printed = gate(sessionId)

  assert.equal(printed.split('\n')[0], 'block')
  assert.match(printed, /could not be loaded/)
})

// A file where the registry's own parent directory belongs, rather than at the registry path
// itself: readFileSync fails resolving that path component before the registry file is ever
// reached, so the failure is ENOTDIR — a code that says nothing about whether the registry exists.
const plantObstructedRegistryDir = (rawId: string): void => {
  const registryPath = registryFilePath(rawId)
  const obstruction = dirname(dirname(registryPath))
  mkdirSync(dirname(obstruction), { recursive: true })
  writeFileSync(obstruction, '')
  assert.throws(
    () => readFileSync(registryPath, 'utf-8'),
    /ENOTDIR/,
    'precondition: the fixture must actually block traversal, or this test observes nothing'
  )
}

test('stop-gate: an unreadable registry names a remedy that holds for every code, not an ownership repair (FLOW-226 finding 7b691e9cea48)', () => {
  sessionId = `stop-gate-unreadable-reason-eisdir-${tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  saveDashboardState(sessionId, { registered: true, phase: 'prd', openItemIds: [] })
  plantUnreadableRegistry(sessionId)

  const reason = gate(sessionId)
  assert.doesNotMatch(
    reason,
    /ownership or permissions/,
    'a directory sitting at the registry path (EISDIR) is not an ownership problem'
  )
  assert.match(
    reason,
    /exists but could not be read \(EISDIR\)/,
    "the helper's own EISDIR phrase must survive into the printed reason, not just the remedy"
  )
  assert.match(
    reason,
    /Inspect and repair or remove the file by hand/,
    'the remedy must still tell the agent something to do'
  )
})

test('stop-gate: an unreadable-by-ENOTDIR registry gets the same non-ownership remedy (FLOW-226 finding 7b691e9cea48)', () => {
  sessionId = `stop-gate-unreadable-reason-enotdir-${tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  // No saveDashboardState: it shares the registry's directory ancestry and would pre-create the
  // very path this fixture needs to plant a file at instead.
  plantObstructedRegistryDir(sessionId)

  const reason = gate(sessionId)
  assert.doesNotMatch(
    reason,
    /ownership or permissions/,
    "a path component blocking traversal (ENOTDIR) says nothing about the file existing to be chmod'd"
  )
  assert.match(
    reason,
    /could not be confirmed to exist or be read \(ENOTDIR\)/,
    "the helper's own existence-hedge phrase must survive into the printed reason, not just the remedy"
  )
  assert.match(
    reason,
    /Inspect and repair or remove the file by hand/,
    'the remedy must still tell the agent something to do'
  )
})

test('stop-gate: an unreadable registry does NOT borrow the no-session-id answer (control)', () => {
  delete process.env.CLAUDE_CODE_SESSION_ID
  assert.equal(decision(), 'allow', 'no session id keeps its original permissive answer')
})

test("stop-gate: an unreadable registry blocks where a readable one allows on a SIBLING's open item", () => {
  const anchor = `stop-gate-sibling-${tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)}`
  const leaf = `${anchor}-leaf`
  sessionId = anchor
  process.env.CLAUDE_CODE_SESSION_ID = anchor
  // The anchor itself has nothing pending; only the sibling does, and only the registry names it.
  saveDashboardState(anchor, { registered: true, phase: 'prd', openItemIds: [] })
  saveDashboardState(leaf, { registered: true, phase: 'prd', openItemIds: ['item-9'] })
  upsertRegistryNode(anchor, { internalId: anchor, externalId: anchor, key: null, parentId: null })
  upsertRegistryNode(anchor, {
    internalId: leaf,
    externalId: anchor,
    key: 'FLOW-9',
    parentId: anchor,
  })

  assert.equal(decision(anchor), 'allow', 'precondition: readable registry sees the sibling item')

  plantUnreadableRegistry(anchor)

  assert.equal(
    decision(anchor),
    'block',
    'reading the registry as empty here drops the sibling and releases a session with an item open'
  )
})

// A second, independent read site: `resolveSessionId` returns the explicit --session value
// straight through (no registry touched at all) when there is no ambient CLAUDE_CODE_SESSION_ID —
// so the outer try/catch around `resolveSessionId` never fires, and the FIRST read of this
// session's registry happens later, at the gate's own `pollTargets` call. That call used to be
// bare.
test("stop-gate: an unreadable registry does not escape the gate's own pollTargets call when --session is explicit and no ambient session id ever touched the registry first", () => {
  delete process.env.CLAUDE_CODE_SESSION_ID
  const explicitSession = `stop-gate-explicit-unreadable-${tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)}`
  plantUnreadableRegistry(explicitSession)

  let printed = ''
  assert.doesNotThrow(() => {
    printed = gate(explicitSession)
  }, "an unreadable registry hit via the gate's own pollTargets call must not escape runStopGate")
  assert.equal(
    printed.split('\n')[0],
    'block',
    'an uncertain registry must still reach a real decision, not silently allow'
  )
  assert.doesNotMatch(
    printed,
    /Nothing is pending/i,
    'the sibling set this registry read failed to enumerate may not be empty'
  )
  assert.match(
    printed,
    /registry .* could not be read/i,
    'the reason must name the unreadable registry, not fall back to the empty-board text'
  )
})

test('stop-gate: an exhausted counter on a readable empty board re-arms when the registry turns unreadable (finding d925ca987fed)', () => {
  // No ambient CLAUDE_CODE_SESSION_ID: resolveSessionId's own registry read (guarded separately,
  // above) must not fire first and short-circuit straight to `block` before computeSignature/the
  // attempt counter are ever reached — the same reason the pollTargets test above deletes it.
  delete process.env.CLAUDE_CODE_SESSION_ID
  sessionId = `stop-gate-signature-registry-${tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)}`
  saveDashboardState(sessionId, { registered: true, phase: 'prd', openItemIds: [] })
  writeGateState(sessionId, { attempts: MAX_BLOCKS + 3, signature: JSON.stringify({ items: [] }) })

  plantUnreadableRegistry(sessionId)

  assert.equal(
    decision(sessionId),
    'block',
    'a signature blind to registry-unreadability would still match the stored one and stay released'
  )
})

// ---------------------------------------------------------------------------
// A live leaf whose own state file is present and cannot be turned into an open-item list. The
// gate already BLOCKS on one — hasPendingWork counts it as pending — so what is under test is what
// the block says, and what the counter does about it.
// ---------------------------------------------------------------------------

const plantCorruptState = (id: string): void => {
  mkdirSync(dirname(stateFilePath(id)), { recursive: true })
  writeFileSync(stateFilePath(id), '{"registered": true, "openItemIds": 3}')
}

test('stop-gate: a leaf whose open-item list could not be read does not block while reporting nothing is pending (FLOW-226 finding 9ec0d5b31b60)', () => {
  sessionId = `stop-gate-corrupt-state-${tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  plantCorruptState(sessionId)

  const printed = gate(sessionId)

  assert.equal(printed.split('\n')[0], 'block', 'precondition: an unreadable open set still blocks')
  assert.doesNotMatch(
    printed,
    /Nothing is pending/i,
    'blocking BECAUSE something may be pending, while telling the agent nothing is, is the defect'
  )
  assert.match(printed, /cannot be determined/, 'it says what is unknown instead')
  assert.match(printed, new RegExp(sessionId), 'and names the leaf whose state could not be read')
})

test('stop-gate: a leaf whose only defect is deferredIdCounter is not reported as an open set that could not be read (FLOW-226)', () => {
  sessionId = `stop-gate-counter-only-${tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  // deferredIdCounter is the one stateFileIsCorrupt arm loadState never consults: openItemIds
  // below is read, and read as empty.
  saveDashboardState(sessionId, {
    registered: true,
    phase: 'review',
    openItemIds: [],
    deferredIdCounter: -5,
  })
  // Board-confirmed live, so the gate still arms on a leaf with nothing open — otherwise
  // isSessionLive short-circuits to `allow` and there is no reason text to assert on.
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(
    tmpDir,
    JSON.stringify([boardRow({ id: sessionId, externalId: sessionId, lifecycle: 'active' })])
  )

  const printed = gate(sessionId)

  assert.equal(printed.split('\n')[0], 'block', 'precondition: the gate armed and built a reason')
  assert.doesNotMatch(
    printed,
    /cannot be determined/,
    `an open set that read fine is not "invisible to this gate", printed reason was: ${printed}`
  )
  assert.match(
    printed,
    /Nothing is pending/i,
    `the zero-item reason is the true one for an empty open set, printed reason was: ${printed}`
  )
})

test('stop-gate: a live leaf going unreadable re-arms the block counter (FLOW-226 finding 9ec0d5b31b60)', () => {
  sessionId = `stop-gate-corrupt-signature-${tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  // Board-confirmed live, so the gate arms on a leaf with nothing open. Without that the quiet
  // board fails isSessionLive, clearGateState WIPES the counter, and the exhausted state
  // this test needs is never reached — it would then pass without comparing a signature at all.
  saveDashboardState(sessionId, { registered: true, phase: 'review', openItemIds: [] })
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(
    tmpDir,
    JSON.stringify([boardRow({ id: sessionId, externalId: sessionId, lifecycle: 'active' })])
  )

  for (let i = 0; i < MAX_BLOCKS; i += 1) {
    assert.equal(
      decision(sessionId),
      'block',
      'precondition: the gate is armed and spending budget'
    )
  }
  assert.equal(decision(sessionId), 'allow', 'precondition: the budget is spent')

  plantCorruptState(sessionId)

  assert.equal(
    decision(sessionId),
    'block',
    'a live leaf whose open set went from "empty" to "unreadable" is a change — without the ' +
      'unreadable ids in the signature both read as items: [] and the gate stays exhausted'
  )
})

test('stop-gate: an unreadable state file blocks with the repair reason even when other items are open', () => {
  const anchor = `stop-gate-mixed-${tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)}`
  const corrupt = `${anchor}-corrupt`
  sessionId = anchor
  process.env.CLAUDE_CODE_SESSION_ID = anchor
  saveDashboardState(anchor, { registered: true, phase: 'prd', openItemIds: ['item-1'] })
  upsertRegistryNode(anchor, { internalId: anchor, externalId: anchor, key: null, parentId: null })
  upsertRegistryNode(anchor, {
    internalId: corrupt,
    externalId: anchor,
    key: 'FLOW-9',
    parentId: anchor,
  })
  plantCorruptState(corrupt)

  const printed = gate(anchor)

  assert.equal(printed.split('\n')[0], 'block', 'the open-item allow must not fire')
  assert.match(printed, /cannot be determined/)
  assert.ok(printed.includes(corrupt), 'the reason names the corrupt node')
  assert.ok(printed.includes('item-1'), 'and the items that did read')
})

test('stop-gate: no reason text mentions launching a receiver', () => {
  const unique = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  const reasons: string[] = []

  // keep-working
  sessionId = `stop-gate-reasons-keep-${unique}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  saveDashboardState(sessionId, { registered: true, phase: 'prd', openItemIds: [] })
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(
    tmpDir,
    JSON.stringify([boardRow({ id: sessionId, externalId: sessionId, lifecycle: 'active' })])
  )
  reasons.push(gate(sessionId))

  // unknown pending
  sessionId = `stop-gate-reasons-unknown-${unique}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  plantCorruptState(sessionId)
  reasons.push(gate(sessionId))

  // unreadable registry
  sessionId = `stop-gate-reasons-registry-${unique}`
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  plantUnreadableRegistry(sessionId)
  reasons.push(gate(sessionId))

  for (const reason of reasons) {
    assert.equal(reason.split('\n')[0], 'block', 'precondition: each case built a reason')
    assert.doesNotMatch(reason, /mailbox watch|run_in_background|2147483647|receiver/)
  }
})

// ---------------------------------------------------------------------------
// FLOW-226: a degraded state file must not read as "nothing pending". These drive hasPendingWork
// and isSessionLive — the gate's own liveness decision — rather than loadState in isolation.
// ---------------------------------------------------------------------------

// Writes a raw state file body, bypassing saveState, so a shape saveState would never produce
// can be put on disk at the path loadState actually reads.
const writeRawDashboardState = (sessionId: string, body: string): void => {
  mkdirSync(dirname(stateFilePath(sessionId)), { recursive: true })
  writeFileSync(stateFilePath(sessionId), body)
}

test('stop-gate: a well-formed state with an open item is pending (control)', () => {
  const id = process.env.CLAUDE_CODE_SESSION_ID!
  writeRawDashboardState(id, JSON.stringify({ registered: true, phase: 'x', openItemIds: ['I-1'] }))

  assert.equal(hasPendingWork(id), true, 'precondition: the fixture reaches the real read path')
})

test('stop-gate: a well-formed state with NO open items is not pending (control: the assertion discriminates)', () => {
  const id = process.env.CLAUDE_CODE_SESSION_ID!
  writeRawDashboardState(id, JSON.stringify({ registered: true, phase: 'x', openItemIds: [] }))

  assert.equal(hasPendingWork(id), false)
})

test('stop-gate: a numeric openItemIds is treated as pending, not as an empty board', () => {
  const id = process.env.CLAUDE_CODE_SESSION_ID!
  // `openItemIds: 3` gives `.length` of undefined, which is falsy — the exact shape that read as
  // "nothing open" before this fix.
  writeRawDashboardState(id, JSON.stringify({ registered: true, phase: 'x', openItemIds: 3 }))

  assert.equal(hasPendingWork(id), true)
})

test('stop-gate: unparseable JSON is treated as pending, matching the uncertain-outcome rule', () => {
  const id = process.env.CLAUDE_CODE_SESSION_ID!
  writeRawDashboardState(id, '{not json')

  assert.equal(hasPendingWork(id), true)
})

test('stop-gate: a present but unreadable state file is pending, and is not once it reads again (FLOW-157)', () => {
  const id = process.env.CLAUDE_CODE_SESSION_ID!
  // A directory at the file's path rather than a chmod: root bypasses permission bits, so a
  // mode-000 file is still readable under a root test runner and the fixture would never reach the
  // branch under test. EISDIR comes back to every uid.
  mkdirSync(stateFilePath(id), { recursive: true })
  assert.throws(
    () => readFileSync(stateFilePath(id), 'utf-8'),
    /EISDIR/,
    'precondition: the fixture must actually be unreadable, or this test observes nothing'
  )

  assert.equal(hasPendingWork(id), true, 'an unreadable board must not read as an empty one')

  rmSync(stateFilePath(id), { recursive: true, force: true })
  writeRawDashboardState(id, JSON.stringify({ registered: true, phase: 'x', openItemIds: [] }))
  assert.equal(
    hasPendingWork(id),
    false,
    'the same session, genuinely empty and readable, is not pending — so the true above came from ' +
      'the unreadability and not from a predicate that answers true for everything'
  )
})

test('stop-gate: a state file that is absent entirely is NOT pending (an absent board is not a corrupt one)', () => {
  const id = process.env.CLAUDE_CODE_SESSION_ID!
  assert.equal(
    existsSync(stateFilePath(id)),
    false,
    'precondition: nothing on disk for this session'
  )

  assert.equal(hasPendingWork(id), false)
})

test('stop-gate: a state whose only defect is deferredIdCounter is answered from its open set, not counted as unreadable (FLOW-226)', () => {
  const id = process.env.CLAUDE_CODE_SESSION_ID!
  // deferredIdCounter is the one stateFileIsCorrupt arm loadState never consults, so this state
  // comes back intact. The uncertain-outcome rule above is about an open set this process could
  // not read; this one read fine.
  saveDashboardState(id, {
    registered: true,
    phase: 'x',
    openItemIds: [],
    deferredIdCounter: -5,
  })

  assert.equal(
    hasPendingWork(id),
    false,
    'an empty open set that read fine is not pending — a counter that would recycle an issued ' +
      'deferred id is a reason to refuse to MINT one, not evidence the open set is unknown'
  )

  saveDashboardState(id, {
    registered: true,
    phase: 'x',
    openItemIds: ['I-1'],
    deferredIdCounter: -5,
  })
  assert.equal(
    hasPendingWork(id),
    true,
    'the same defect with a real open item is still pending — the answer tracks the open set, so ' +
      'the false above is not a predicate that went blind on this fixture'
  )
})

test('stop-gate: a corrupt state file counts the session as live', () => {
  const id = process.env.CLAUDE_CODE_SESSION_ID!
  writeRawDashboardState(id, JSON.stringify({ registered: true, phase: 'x', openItemIds: 3 }))
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(
    tmpDir,
    JSON.stringify([boardRow({ id, externalId: id, lifecycle: 'ended' })])
  )

  // A TERMINAL board, so the lifecycle arm cannot be what makes this live — leaving hasPendingWork
  // as the only candidate. With `lifecycle: 'active'` this test passed even with the corrupt-field
  // arms removed from state.ts, because the two arms agree on that value and the lifecycle one
  // answered first.
  assert.equal(isSessionLive(id, id), true)
})

test('stop-gate: the lifecycle arm alone counts the session as live (control)', () => {
  const id = process.env.CLAUDE_CODE_SESSION_ID!
  saveDashboardState(id, { registered: true, phase: 'implementation', openItemIds: [] })
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(
    tmpDir,
    JSON.stringify([boardRow({ id, externalId: id, lifecycle: 'active' })])
  )

  assert.equal(hasPendingWork(id), false, 'nothing pending, so only the lifecycle arm can carry it')
  assert.equal(isSessionLive(id, id), true)
})

test('stop-gate: an ended board does not count the session as live (control)', () => {
  const id = process.env.CLAUDE_CODE_SESSION_ID!
  saveDashboardState(id, { registered: true, phase: 'implementation', openItemIds: [] })
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(
    tmpDir,
    JSON.stringify([boardRow({ id, externalId: id, lifecycle: 'ended' })])
  )

  assert.equal(isSessionLive(id, id), false)
})

test('stop-gate: an unreadable registry counts the session as live on a board that would otherwise end it', () => {
  const id = process.env.CLAUDE_CODE_SESSION_ID!
  saveDashboardState(id, { registered: true, phase: 'implementation', openItemIds: [] })
  process.env.AI_WORKFLOW_APP_BIN = writeBoardStub(
    tmpDir,
    JSON.stringify([boardRow({ id, externalId: id, lifecycle: 'ended' })])
  )

  assert.equal(
    isSessionLive(id, id),
    false,
    'precondition: with the registry readable this exact fixture is not live'
  )

  plantUnreadableRegistry(id)

  assert.equal(
    isSessionLive(id, id),
    true,
    'only the registry changed, so the session counted as live because the gate could not enumerate its leaves'
  )
})
