import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), 'repair-test-'))

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { runRepair } from './repair.ts'
import { loadState, saveState, stateFilePath } from './state.ts'
import { loadRegistry, upsertRegistryNode } from './registry.ts'
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'

// ---------------------------------------------------------------------------
// Capture helpers
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

const captureStderr = (fn: () => void): string => {
  const chunks: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk))
    return true
  }
  try {
    fn()
  } finally {
    process.stderr.write = orig
  }
  return chunks.join('')
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

let tmpDir: string
let origSessionId: string | undefined
let rawId: string
let homeDir: string
let origHome: string | undefined
const stateFilesToClean: string[] = []

// stateFilePath/registryFilePath resolve through the durable store, which is homedir()-relative —
// override HOME so these tests never touch the real ~/.claude/workflow-state.
beforeEach(() => {
  tmpDir = makeTempDir()
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  rawId = `test-repair-session-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  homeDir = mkdtempSync(join(tmpdir(), 'repair-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
  stateFilesToClean.length = 0
  setRequestedExitCode(0)
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// No CLAUDE_CODE_SESSION_ID and no --session: resolveRawSessionId throws inside runRepair —
// proving the try/catch around it reuses the thrown message and sets exit 1 instead of letting
// the throw escape uncaught. Distinct from the deliberate "nothing to do"/"malformed id" throws
// elsewhere in this file: those are argument-validation failures, this is the same operability
// defect the rest of this file's throw-refusal tests guard against.
test('runRepair: no session id — refuses cleanly instead of throwing', () => {
  delete process.env.CLAUDE_CODE_SESSION_ID

  let stderrOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => runRepair({ forget: ['some-id'], dryRun: false }))
  })

  assert.ok(
    stderrOut.includes('No session id: pass --session or set CLAUDE_CODE_SESSION_ID'),
    'stderr carries resolveRawSessionId’s own message'
  )
  const code = getRequestedExitCode()
  assert.ok(code !== undefined && code !== 0, 'a caller must see this as a failure, not a success')
})

test('runRepair: --forget removes the state file AND the registry entry; idempotent on a second call', () => {
  const nodeId = 'node-to-forget'
  stateFilesToClean.push(nodeId)
  saveState(nodeId, { registered: true, phase: 'implementation', openItemIds: [], parentId: null })
  upsertRegistryNode(rawId, { internalId: nodeId, externalId: rawId, key: null, parentId: null })
  assert.notEqual(loadState(nodeId), null, 'precondition: state file exists')
  assert.equal(loadRegistry(rawId).length, 1, 'precondition: registry entry exists')

  runRepair({ forget: [nodeId], dryRun: false })
  assert.equal(loadState(nodeId), null, 'state file removed')
  assert.deepEqual(loadRegistry(rawId), [], 'registry entry removed')

  assert.doesNotThrow(
    () => runRepair({ forget: [nodeId], dryRun: false }),
    'a second --forget of the same id does not throw'
  )
  assert.equal(loadState(nodeId), null, 'still gone after the second forget')
})

// assertOperations is the first statement inside runRepair's try, so its "nothing to do" throw
// is caught there along with every other precondition failure. Same operability class as the "no
// session id" test above — a refusal message and exit 1, no stack, not a thrown Error the caller
// must catch itself.
test('runRepair: no operations (--forget empty) refuses cleanly instead of throwing', () => {
  let stderrOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => runRepair({ forget: [], dryRun: false }))
  })

  assert.ok(
    stderrOut.includes('nothing to do — pass --forget'),
    'stderr carries assertOperations’ own message'
  )
  const code = getRequestedExitCode()
  assert.ok(code !== undefined && code !== 0, 'a caller must see this as a failure, not a success')
})

test('runRepair: --dry-run prints the writes but changes nothing (proven against a real mutation)', () => {
  const nodeId = 'node-dry-run'
  stateFilesToClean.push(nodeId)
  saveState(nodeId, { registered: true, phase: 'implementation', openItemIds: [], parentId: null })
  upsertRegistryNode(rawId, { internalId: nodeId, externalId: rawId, key: null, parentId: null })

  // Non-vacuous proof: first confirm the SAME invocation WITHOUT --dry-run really does mutate, so
  // the --dry-run assertion below is not trivially true because nothing ever mutates anything.
  runRepair({ forget: [nodeId], dryRun: false })
  assert.equal(loadState(nodeId), null, 'proof: a real (non-dry-run) call DOES forget the state')
  assert.deepEqual(
    loadRegistry(rawId),
    [],
    'proof: a real (non-dry-run) call DOES forget the registry entry'
  )

  // Reset back to the pre-mutation state and re-run the identical operation with --dry-run.
  saveState(nodeId, { registered: true, phase: 'implementation', openItemIds: [], parentId: null })
  upsertRegistryNode(rawId, { internalId: nodeId, externalId: rawId, key: null, parentId: null })
  assert.notEqual(loadState(nodeId), null, 'precondition re-established: state file exists')
  assert.equal(loadRegistry(rawId).length, 1, 'precondition re-established: registry entry exists')

  const stdoutOut = captureStdout(() => runRepair({ forget: [nodeId], dryRun: true }))

  assert.ok(stdoutOut.includes('dry run'), 'stdout announces a dry run')
  // The split-op design produces TWO operations per forgotten id (state + registry) — assert
  // --dry-run actually lists both, not just a generic "dry run" banner, so a
  // future change that collapses them back to one combined op (or drops one line) is caught here
  // rather than only by the real-run fs-error test, which never exercises the dry-run path.
  assert.ok(stdoutOut.includes('would perform 2 write(s)'), 'dry-run reports both split ops')
  assert.ok(
    stdoutOut.includes(`forget cached state for ${nodeId}`),
    'dry-run lists the state-forget op'
  )
  assert.ok(
    stdoutOut.includes(`forget registry entry for ${nodeId}`),
    'dry-run lists the registry-forget op'
  )
  assert.notEqual(loadState(nodeId), null, 'dry-run: state file still present')
  assert.equal(loadRegistry(rawId).length, 1, 'dry-run: registry entry still present')
})

// A deliberate refusal and an uncaught throw both set exit 1, so exit code alone cannot tell them
// apart; a stack frame in stderr is what an uncaught throw prints and a caught refusal does not.
test('runRepair: malformed id refuses cleanly instead of throwing', () => {
  let stderrOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => runRepair({ forget: ['a b'], dryRun: false }))
  })

  assert.ok(
    stderrOut.includes('malformed session id: a b'),
    'stderr carries assertIdShape’s own message'
  )
  assert.ok(
    !/^\s+at\s/m.test(stderrOut),
    'no stack-frame line — a caught refusal prints only the message, not a thrown Error’s stack'
  )
})

test('runRepair: a real fs error on a later --forget id still shows what already landed', () => {
  // clearState must not swallow real errors like EACCES/EPERM/EISDIR — a throw partway through
  // the forget loop must not leave already-forgotten ids with zero output.
  // Simulate an fs error deterministically and portably (no permission tricks needed): a directory
  // at the exact path clearState would rmSync is a real, reproducible EISDIR-style throw (rmSync
  // on a non-empty-capable path without `recursive` fails).
  const goodId = 'node-forgettable'
  const badId = 'node-throws-on-forget'
  stateFilesToClean.push(goodId)
  saveState(goodId, { registered: true, phase: 'implementation', openItemIds: [], parentId: null })
  mkdirSync(stateFilePath(badId), { recursive: true })
  mkdirSync(join(stateFilePath(badId), 'not-empty'), { recursive: true })

  try {
    // Not captureStdout: it returns via try/finally with no catch, so a thrown fn() means the
    // capture call itself throws before ever handing back the accumulated chunks — exactly the
    // "no output at all" failure mode this test exists to rule out. Capture manually instead, so
    // whatever printed before the throw is still inspectable after it.
    const chunks: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      chunks.push(String(chunk))
      return true
    }
    let thrown: unknown
    try {
      runRepair({ forget: [goodId, badId], dryRun: false })
    } catch (err) {
      thrown = err
    } finally {
      process.stdout.write = origWrite
    }
    const stdoutOut = chunks.join('')

    assert.ok(
      thrown !== undefined,
      'clearState propagates the real fs error rather than swallowing it'
    )
    assert.ok(
      stdoutOut.includes(`done: forget cached state for ${goodId}`),
      'the first forget (state), which landed before the throw, is reported'
    )
    assert.ok(
      stdoutOut.includes(`done: forget registry entry for ${goodId}`),
      'the first forget (registry), which landed before the throw, is reported — split from the state write'
    )
    assert.ok(
      !stdoutOut.includes(badId),
      'the id that threw is not reported as done — it did not land'
    )
    assert.equal(loadState(goodId), null, 'the first forget really did land')
  } finally {
    rmSync(stateFilePath(badId), { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// FLOW-173: forgetting a node that is some other live node's parent orphans that child
// ---------------------------------------------------------------------------

test('runRepair: --forget of a node that is a live child parent warns, but still performs the forget', () => {
  const parentId = `${rawId}:EPIC`
  const childId = `${rawId}:CHILD`
  stateFilesToClean.push(parentId, childId)
  upsertRegistryNode(rawId, {
    internalId: parentId,
    externalId: parentId,
    key: 'EPIC',
    parentId: null,
  })
  upsertRegistryNode(rawId, { internalId: childId, externalId: childId, key: 'CHILD', parentId })

  const stderrOut = captureStderr(() => runRepair({ forget: [parentId], dryRun: false }))

  assert.ok(stderrOut.includes('warning'), 'stderr carries a warning')
  assert.ok(stderrOut.includes(parentId), 'warning names the forgotten id')
  assert.ok(stderrOut.includes('CHILD'), 'warning names the orphaned child')
  // The forget still lands — repair warns, it does not refuse (FLOW-133: stays deliberately dumb).
  assert.equal(
    loadRegistry(rawId).some((n) => n.internalId === parentId),
    false,
    'the parent registry entry is gone despite the warning'
  )
})

test('runRepair: --forget of a leaf (no children) does not warn', () => {
  const leafId = `${rawId}:LEAF`
  stateFilesToClean.push(leafId)
  upsertRegistryNode(rawId, { internalId: leafId, externalId: leafId, key: 'LEAF', parentId: null })

  const stderrOut = captureStderr(() => runRepair({ forget: [leafId], dryRun: false }))

  assert.equal(stderrOut, '', 'no warning when the forgotten node has no live children')
})

test('runRepair: --forget of BOTH a parent and its child in the same call does not warn (the whole subtree is being cleaned up)', () => {
  const parentId = `${rawId}:EPIC`
  const childId = `${rawId}:CHILD`
  stateFilesToClean.push(parentId, childId)
  upsertRegistryNode(rawId, {
    internalId: parentId,
    externalId: parentId,
    key: 'EPIC',
    parentId: null,
  })
  upsertRegistryNode(rawId, { internalId: childId, externalId: childId, key: 'CHILD', parentId })

  const stderrOut = captureStderr(() => runRepair({ forget: [parentId, childId], dryRun: false }))

  assert.equal(stderrOut, '', 'no orphan warning when the child is forgotten in the same call')
  assert.deepEqual(loadRegistry(rawId), [], 'both entries removed')
})

test('runRepair: --forget warning fires under --dry-run too (predicts it, does not suppress it)', () => {
  const parentId = `${rawId}:EPIC`
  const childId = `${rawId}:CHILD`
  stateFilesToClean.push(parentId, childId)
  upsertRegistryNode(rawId, {
    internalId: parentId,
    externalId: parentId,
    key: 'EPIC',
    parentId: null,
  })
  upsertRegistryNode(rawId, { internalId: childId, externalId: childId, key: 'CHILD', parentId })

  const stderrOut = captureStderr(() => runRepair({ forget: [parentId], dryRun: true }))

  assert.ok(stderrOut.includes('warning'), 'dry-run still predicts the orphan warning')
  assert.equal(
    loadRegistry(rawId).some((n) => n.internalId === parentId),
    true,
    'dry-run: the parent registry entry is untouched'
  )
})
