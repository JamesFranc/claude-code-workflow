import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  chmodSync,
  mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

// ---------------------------------------------------------------------------
// Helpers (shared pattern from dashboard.test.ts / rotate.test.ts / enter.test.ts)
// ---------------------------------------------------------------------------

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), 'leave-test-'))

// The real register CLI mints the id (FLOW-132); this stub mocks that by deterministically
// deriving a fake "minted uuid" from --external-id (and --parent-external-id, if present) so
// tests can predict what enter.ts will read back, matching the register JSON stdout contract:
// {"id":"<uuid>","parentId":"<uuid>"|null}. `session end`/`session heartbeat` calls still take
// --id (unchanged, out of scope) and don't read stdout, so the stub's JSON there is unused.
const mockNodeId = (externalId: string): string => `mock-uuid-${externalId}`

/** Write a stub binary that records its argv, mocks a minted-id JSON response on stdout
 * (register's contract), optionally writes stderr, and exits with the given code. */
const writeStub = (dir: string, exitCode: number, stderr = ''): string => {
  const path = join(dir, 'ai-workflow-app')
  const stderrLine = stderr ? `echo ${JSON.stringify(stderr)} >&2` : ''
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `echo "$@" >> ${JSON.stringify(join(dir, 'calls.log'))}`,
      stderrLine,
      'ext=""',
      'parentExt=""',
      'args=("$@")',
      'for ((i=0; i<$#; i++)); do',
      '  if [ "${args[$i]}" = "--external-id" ]; then ext="${args[$((i+1))]}"; fi',
      '  if [ "${args[$i]}" = "--parent-external-id" ]; then parentExt="${args[$((i+1))]}"; fi',
      'done',
      'if [ -n "$parentExt" ]; then',
      '  printf \'{"id":"mock-uuid-%s","parentId":"mock-uuid-%s"}\\n\' "$ext" "$parentExt"',
      'else',
      '  printf \'{"id":"mock-uuid-%s","parentId":null}\\n\' "$ext"',
      'fi',
      `exit ${exitCode}`,
      '',
    ].join('\n')
  )
  chmodSync(path, 0o755)
  return path
}

const readCalls = (dir: string): string[] => {
  const log = join(dir, 'calls.log')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf-8').split('\n').filter(Boolean)
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { runEnter } from './enter.ts'
import { runLeave, runEnd } from './lifecycle.ts'
import { loadState, stateFilePath } from './state.ts'
import { loadRegistry, registryLeaves, registryRoot, upsertRegistryNode } from './registry.ts'
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'

const resetExitCode = (): void => setRequestedExitCode(0)
const exitCodeIsError = (): boolean => {
  const code = getRequestedExitCode()
  return code !== undefined && code !== 0
}

/** Suppress and capture stderr written during fn(), then restore it. */
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

// The registry-era replacement for "what does the active pointer name" — the sole live leaf, or
// null when there isn't exactly one (nothing entered, or more than one live leaf).
const soleLeaf = (rawId: string): string | null => {
  const leaves = registryLeaves(loadRegistry(rawId))
  return leaves.length === 1 ? leaves[0].internalId : null
}

// FLOW-190: the root's external id is minted per top-level board session (`rawId_<suffix>`), so a
// node's internal id can no longer be precomputed as mockNodeId(`${rawId}:key`) — read it back from
// the registry after the node has actually been entered.
const nodeIdForKey = (key: string): string => {
  const node = loadRegistry(rawId).find((n) => n.key === key)
  if (node === undefined) throw new Error(`no registry node with key ${key}`)
  return node.internalId
}

const externalIdForKey = (key: string): string => {
  const node = loadRegistry(rawId).find((n) => n.key === key)
  if (node === undefined) throw new Error(`no registry node with key ${key}`)
  return node.externalId
}

const rootNodeId = (): string => {
  const root = registryRoot(loadRegistry(rawId))
  if (root === undefined) throw new Error('no root registered yet')
  return root.internalId
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

let tmpDir: string
let origBin: string | undefined
let origSessionId: string | undefined
let rawId: string
let homeDir: string
let origHome: string | undefined

// stateFilePath/registryFilePath resolve through the durable store, which is homedir()-relative —
// override HOME so these tests never touch the real ~/.claude/workflow-state.
beforeEach(() => {
  tmpDir = makeTempDir()
  origBin = process.env.AI_WORKFLOW_APP_BIN
  // A test that forgets to wire its own stub must resolve to "dashboard unavailable" (an existing,
  // handled no-op), never fall through resolveDashboardBin's PATH lookup to the REAL installed
  // ai-workflow-app and drive it against the real board database. Wired tests overwrite this.
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'no-such-ai-workflow-app')
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  rawId = `test-leave-session-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  homeDir = mkdtempSync(join(tmpdir(), 'leave-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
  resetExitCode()
})

afterEach(() => {
  if (origBin === undefined) delete process.env.AI_WORKFLOW_APP_BIN
  else process.env.AI_WORKFLOW_APP_BIN = origBin
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

test('runLeave: leaf with a parent ends the leaf and repoints the pointer to the parent', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('EPIC-1', 'architecture')
  const epicId = nodeIdForKey('EPIC-1')

  runEnter('FLOW-106', 'implementation', 'My Story', 'EPIC-1')
  const leafId = nodeIdForKey('FLOW-106')

  assert.equal(soleLeaf(rawId), leafId, 'precondition: leaf is the sole registry leaf')

  runLeave()

  const calls = readCalls(tmpDir)
  assert.ok(
    calls.some((c) => c.includes('session end') && c.includes(`--id ${leafId}`)),
    'ends the leaf (runEnd argv)'
  )
  assert.equal(soleLeaf(rawId), epicId, 'epic becomes the sole leaf after leaving the ticket')
  assert.equal(exitCodeIsError(), false, 'no error exit code on a clean leave')
})

test('runLeave: three-level nesting (epic -> ticket -> pr) pops exactly one level per leave', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('EPIC-1', 'architecture')
  const epicId = nodeIdForKey('EPIC-1')

  runEnter('FLOW-106', 'implementation', 'My Story', 'EPIC-1')
  const ticketId = nodeIdForKey('FLOW-106')

  runEnter('PR-42', 'pr', 'My PR', 'FLOW-106')
  const prId = nodeIdForKey('PR-42')

  assert.equal(soleLeaf(rawId), prId, 'the pr node is the sole leaf after three enters')

  runLeave()
  const callsAfterFirstLeave = readCalls(tmpDir)
  assert.ok(
    callsAfterFirstLeave.some((c) => c.includes('session end') && c.includes(`--id ${prId}`)),
    'first leave ends the pr node'
  )
  assert.equal(soleLeaf(rawId), ticketId, 'first leave pops exactly one level: pr -> ticket')

  runLeave()
  const callsAfterSecondLeave = readCalls(tmpDir)
  assert.ok(
    callsAfterSecondLeave.some((c) => c.includes('session end') && c.includes(`--id ${ticketId}`)),
    'second leave ends the ticket node'
  )
  assert.equal(soleLeaf(rawId), epicId, 'second leave pops exactly one level: ticket -> epic')

  runLeave()
  const callsAfterThirdLeave = readCalls(tmpDir)
  assert.ok(
    callsAfterThirdLeave.some((c) => c.includes('session end') && c.includes(`--id ${epicId}`)),
    'third leave ends the epic node'
  )
  // FLOW-118: EPIC-1 was entered with a key and no parent-key, so it now defaults to a child of
  // the root (parent-external-id = rawId), not a parentless node — enter.ts stubs that implicit
  // root into the registry (FLOW-173), so it becomes the sole remaining leaf here rather than the
  // registry going empty.
  assert.equal(
    soleLeaf(rawId),
    rootNodeId(),
    'third leave pops the top level: the stubbed root becomes the sole leaf'
  )
})

test('runLeave: nothing ever entered — informative no-op, exit 0, without --root', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  assert.deepEqual(loadRegistry(rawId), [], 'precondition: nothing entered')

  runLeave()

  // No-op BEFORE any dashboard call — there is no backend session to end either way.
  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 0, 'no-op: nothing to end')
  assert.deepEqual(loadRegistry(rawId), [], 'registry stays empty')
  assert.equal(exitCodeIsError(), false, 'a no-op is not an error')
})

test('runLeave: nothing ever entered — informative no-op, exit 0, WITH --root too (no backend session to end either way)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  assert.deepEqual(loadRegistry(rawId), [], 'precondition: nothing entered')

  runLeave(undefined, true)

  // "Nothing entered" is not "at the root" — --root has nothing to override here.
  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 0, 'no-op: nothing to end, even with --root')
  assert.deepEqual(loadRegistry(rawId), [], 'registry stays empty')
  assert.equal(exitCodeIsError(), false, 'a no-op is not an error')
})

test('runLeave: --root DOES end a genuinely entered root (the case --root exists for)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter(undefined, 'prd', 'My Root Title')
  const rootId = rootNodeId()
  assert.equal(
    soleLeaf(rawId),
    rootId,
    'precondition: the explicitly-entered root is the sole leaf'
  )

  runLeave(undefined, true)

  const calls = readCalls(tmpDir)
  assert.ok(
    calls.some((c) => c.includes('session end') && c.includes(`--id ${rootId}`)),
    'ends the entered root'
  )
  assert.deepEqual(loadRegistry(rawId), [], 'registry empties once the root is left deliberately')
  assert.equal(exitCodeIsError(), false, 'no error exit code on a deliberate --root leave')

  try {
    rmSync(stateFilePath(rootId))
  } catch {
    /* ignore */
  }
})

test('runLeave: --root with a child present refuses and ends nothing', () => {
  // registryLeaves excludes the root once it has a child, so the no-target path below resolves to
  // the CHILD leaf — a root guard scoped to `target.parentId === null && !root` never fires there,
  // silently ignoring --root and ending the child, exit 0. Three things must hold, not just the
  // exit code: an exit-code-only check would pass on a version that refuses AFTER already ending
  // the child.
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('EPIC-1', 'architecture')
  nodeIdForKey('EPIC-1') // asserts the epic node was actually registered
  const rootId = rootNodeId()

  const nodesBefore = loadRegistry(rawId)

  runLeave(undefined, true)

  assert.ok(
    !readCalls(tmpDir).some((c) => c.includes('session end')),
    'nothing was ended on the board'
  )
  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
  assert.deepEqual(
    loadRegistry(rawId),
    nodesBefore,
    'the registry is completely unchanged — the child is still recorded, so is the root'
  )

  try {
    rmSync(stateFilePath(rootId))
  } catch {
    /* ignore */
  }
})

test('runLeave: mid-tree leave (leaf has a real parent) is unaffected by the root guard', () => {
  // Regression guard: the root check must not fire for an ordinary non-root leaf.
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('EPIC-1', 'architecture')
  const epicId = nodeIdForKey('EPIC-1')

  runEnter('FLOW-106', 'implementation', 'My Story', 'EPIC-1')
  const ticketId = nodeIdForKey('FLOW-106')

  runLeave()

  const calls = readCalls(tmpDir)
  assert.ok(
    calls.some((c) => c.includes('session end') && c.includes(`--id ${ticketId}`)),
    'a mid-tree leave still ends the leaf — not refused'
  )
  assert.equal(soleLeaf(rawId), epicId, 'epic becomes the sole leaf after leaving the ticket')
  assert.equal(exitCodeIsError(), false, 'no error exit code on a mid-tree leave')
})

test('runLeave: leave at the top-most entered node (defaults to a child of the root) repoints to the root', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('EPIC-1', 'architecture')
  const epicId = nodeIdForKey('EPIC-1')
  const rootId = rootNodeId()

  runLeave()

  const calls = readCalls(tmpDir)
  assert.ok(
    calls.some((c) => c.includes('session end') && c.includes(`--id ${epicId}`)),
    'ends the entered node'
  )
  // FLOW-118: entering with a key and no parent-key defaults to a child of the root
  // (parent-external-id = rawId); enter.ts stubs that implicit root into the registry, so it
  // becomes the sole leaf here rather than the registry going empty.
  assert.equal(soleLeaf(rawId), rootId, 'the stubbed root becomes the sole leaf')
})

test('runLeave: idempotent — calling leave twice in a row does not throw; the second call (now at root) is refused without --root', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-106', 'implementation')

  const rootId = rootNodeId()

  runLeave()
  // FLOW-118: FLOW-106 was entered with a key and no parent-key, so it defaults to a child of
  // the root (parent-external-id = rawId) — enter.ts stubs that implicit root into the registry,
  // so the first leave leaves it as the sole remaining leaf.
  assert.equal(soleLeaf(rawId), rootId, 'the stubbed root is the sole leaf after the first leave')

  // The root stub has parentId: null (it IS the root) — the sole leaf's parentId is null, so
  // the second call hits the root guard and is refused without --root rather than popping further.
  assert.doesNotThrow(() => runLeave(), 'second leave does not throw — it refuses cleanly')
  assert.equal(
    soleLeaf(rawId),
    rootId,
    'the root stub is still the sole leaf — refused, not removed'
  )
  assert.equal(exitCodeIsError(), true, 'the refused second call sets an error exit code')

  // --root confirms the deliberate override still works at this same point.
  runLeave(undefined, true)
  assert.deepEqual(
    loadRegistry(rawId),
    [],
    'the registry empties once the root itself is left deliberately'
  )
})

test('dead end: enter(K) -> leave -> enter(K) again re-registers and repoints to raw:K', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-106', 'implementation', 'My Story')
  const externalId = externalIdForKey('FLOW-106')
  const nodeId = nodeIdForKey('FLOW-106')
  const rootId = rootNodeId()

  runLeave()
  // FLOW-118: FLOW-106 defaults to a child of the root (parent-external-id = rawId) with no
  // parent-key — enter.ts stubs that implicit root into the registry, so leave leaves it as the
  // sole leaf rather than clearing the registry entirely.
  assert.equal(
    soleLeaf(rawId),
    rootId,
    'precondition: the stubbed root is the sole leaf after leave'
  )

  runEnter('FLOW-106', 'implementation', 'My Story')

  assert.equal(soleLeaf(rawId), nodeId, 'FLOW-106 is the sole leaf again (re-entered)')

  const calls = readCalls(tmpDir)
  const registerCalls = calls.filter(
    (c) => c.includes('session register') && c.includes(`--external-id ${externalId}`)
  )
  assert.equal(
    registerCalls.length,
    2,
    're-entering K calls session register again (reactivation lives in Repo A)'
  )

  const state = loadState(nodeId)
  assert.equal(state!.registered, true, 'state marks registered again after re-entry')
})

test('runLeave: re-entering a ticket WITHOUT --parent-key still pops to its epic, not root', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('EPIC-1', 'architecture')
  const epicId = nodeIdForKey('EPIC-1')

  runEnter('FLOW-106', 'implementation', 'My Story', 'EPIC-1')
  const ticketId = nodeIdForKey('FLOW-106')

  // Focus back onto the ticket without repeating --parent-key (the real-world shape of this bug:
  // a plain re-enter/refocus call omits it since the caller already established the nesting once).
  runEnter('FLOW-106', 'implementation', 'My Story')
  assert.equal(soleLeaf(rawId), ticketId, 'precondition: the ticket is the sole leaf again')

  runLeave()

  assert.equal(
    soleLeaf(rawId),
    epicId,
    'leave pops to the epic (the real parent), not the root — the registry parentId must not have been clobbered on re-enter (FLOW-173 review)'
  )
})

// ---------------------------------------------------------------------------
// Tests: leave --key, and the >1-leaf branch
// ---------------------------------------------------------------------------

test('runLeave: sibling leaves with no --key fails loud, exit 1, no session end call, registry untouched', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('EPIC-1', 'architecture')
  runEnter('FLOW-A', 'implementation', 'Node A', 'EPIC-1')
  const nodeA = nodeIdForKey('FLOW-A')
  runEnter('FLOW-B', 'implementation', 'Node B', 'EPIC-1')
  const nodeB = nodeIdForKey('FLOW-B')

  const leavesBefore = registryLeaves(loadRegistry(rawId))
    .map((n) => n.internalId)
    .sort()
  assert.deepEqual(leavesBefore, [nodeA, nodeB].sort(), 'precondition: A and B are both leaves')

  runLeave()

  const calls = readCalls(tmpDir)
  assert.ok(
    !calls.some((c) => c.includes('session end')),
    'no session end argv emitted on the ambiguity refusal'
  )
  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero on ambiguity')
  const leavesAfter = registryLeaves(loadRegistry(rawId))
    .map((n) => n.internalId)
    .sort()
  assert.deepEqual(
    leavesAfter,
    [nodeA, nodeB].sort(),
    'both leaves remain in the registry, untouched'
  )
})

test('runLeave: --key targets the named sibling; the other becomes the sole leaf afterward', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('EPIC-1', 'architecture')
  runEnter('FLOW-A', 'implementation', 'Node A', 'EPIC-1')
  const nodeA = nodeIdForKey('FLOW-A')
  runEnter('FLOW-B', 'implementation', 'Node B', 'EPIC-1')
  const nodeB = nodeIdForKey('FLOW-B')

  runLeave(undefined, false, 'FLOW-A')

  const callsAfterFirstLeave = readCalls(tmpDir)
  assert.ok(
    callsAfterFirstLeave.some((c) => c.includes('session end') && c.includes(`--id ${nodeA}`)),
    'ends A specifically (the --key-targeted node)'
  )
  assert.equal(
    registryLeaves(loadRegistry(rawId)).some((n) => n.internalId === nodeA),
    false,
    'A removed from the registry'
  )
  assert.equal(soleLeaf(rawId), nodeB, 'B is now the sole leaf')

  // Prove the ambiguity is actually resolved, not just A removed: a plain runLeave() (no --key)
  // now succeeds against B, the sole remaining leaf.
  runLeave()
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session end') && c.includes(`--id ${nodeB}`)),
    'a follow-up plain leave now succeeds against B'
  )
})

test('runLeave: --root --key K is self-contradictory and refuses', () => {
  // --key resolves the target to the named CHILD via resolveLeafTarget — a root guard scoped to
  // `target.parentId === null && !root` never fires there because the target isn't the root, so
  // --root would be silently ignored and the keyed child ended anyway. --key names a child; --root
  // asserts the target IS the root; that pairing is self-contradictory and must refuse — no caller
  // in skills/commands/agents pairs them (the only `leave --root` usages are bare), so nothing
  // depends on a silent-child-end outcome.
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('EPIC-1', 'architecture')
  runEnter('FLOW-A', 'implementation', 'Node A', 'EPIC-1')
  nodeIdForKey('FLOW-A') // asserts the child node was actually registered

  const nodesBefore = loadRegistry(rawId)

  runLeave(undefined, true, 'FLOW-A')

  assert.ok(
    !readCalls(tmpDir).some((c) => c.includes('session end')),
    'nothing was ended on the board'
  )
  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
  assert.deepEqual(
    loadRegistry(rawId),
    nodesBefore,
    'the registry is completely unchanged — FLOW-A is still recorded'
  )
})

test('runLeave: --root refusal message does not render "active children ()" when no root is recorded at all', () => {
  // Distinct from the test above: here the registry has NO node with parentId === null anywhere
  // (a partial/inconsistent local state — e.g. a node whose ancestor was never itself entered
  // locally). registryRoot(nodes) returns undefined, so naively listing "the root's children"
  // would filter nothing and render the empty parenthetical "active children ()". The message must
  // name this narrower case instead of claiming a root (with or without children) that isn't there.
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  upsertRegistryNode(rawId, {
    internalId: 'ghost-child-id',
    externalId: `${rawId}_deadbeef:K`,
    key: 'K',
    parentId: 'never-locally-recorded-ancestor-id',
  })

  const stderr = captureStderr(() => {
    runLeave(undefined, true, 'K')
  })

  assert.ok(!stderr.includes('active children ()'), 'never renders the empty-parens bug')
  assert.ok(
    stderr.includes('no root is recorded locally'),
    'names the narrower case instead of a false "has children" claim'
  )
  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
  assert.ok(
    loadRegistry(rawId).some((n) => n.internalId === 'ghost-child-id'),
    'nothing removed from the registry'
  )
})

test('runLeave: --root refusal names "not this target\'s ancestor" when a root IS recorded but has no children (CodeRabbit)', () => {
  // A third distinct situation from the two tests above: a root IS recorded locally (registryRoot
  // resolves, unlike the "no root at all" test above), but the resolved --key target's parentId
  // points at some OTHER, never-locally-recorded ancestor — not this root's internalId. The root
  // has zero children in this registry (its subtree and the target's are disconnected), so
  // filtering for "the root's children" finds nothing, same underlying shape as the empty-parens
  // bug but without the visible empty parens (children.length === 0, not merely childNames === '').
  // Claiming "the root has active children" here would still be false — there's a recorded root,
  // it just isn't this target's ancestor. Distinguish it from both other messages.
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  // Keyless enter: THIS node itself becomes the recorded root (parentId: null), with no children of
  // its own — a keyed enter (e.g. runEnter('EPIC-1', ...)) would instead compose EPIC-1 as
  // a CHILD of an implicit root stub, defeating the "zero children" setup this test needs.
  runEnter(undefined, 'architecture', 'Real unrelated root')

  upsertRegistryNode(rawId, {
    internalId: 'ghost-child-id',
    externalId: `${rawId}_deadbeef:K`,
    key: 'K',
    parentId: 'never-locally-recorded-ancestor-id',
  })

  const stderr = captureStderr(() => {
    runLeave(undefined, true, 'K')
  })

  assert.ok(!stderr.includes('active children'), 'never claims the recorded root has children')
  assert.ok(!stderr.includes('no root is recorded locally'), 'a root IS recorded — not that case')
  assert.ok(
    stderr.includes("not this target's ancestor"),
    "names the actual situation: a root is recorded, but not as this target's ancestor"
  )
  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
  assert.ok(
    loadRegistry(rawId).some((n) => n.internalId === 'ghost-child-id') &&
      loadRegistry(rawId).some((n) => n.parentId === null),
    'nothing removed from the registry'
  )
})

test('runLeave: --key naming an absent node fails loud (no session end call)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-A', 'implementation', 'Node A')

  runLeave(undefined, false, 'NOPE')

  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
  assert.ok(
    !readCalls(tmpDir).some((c) => c.includes('session end')),
    'no session end argv emitted for an unknown --key'
  )
})

test('runLeave: --key naming a non-leaf (has a live child) is refused, no session end call, registry unchanged', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('EPIC-1', 'architecture')
  const epicId = nodeIdForKey('EPIC-1')
  runEnter('FLOW-A', 'implementation', 'Node A', 'EPIC-1')
  nodeIdForKey('FLOW-A') // asserts the child node was actually registered

  const nodesBefore = loadRegistry(rawId)

  // EPIC-1 has a live child (FLOW-A) — popping it would orphan FLOW-A. Must be refused.
  runLeave(undefined, false, 'EPIC-1')

  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
  assert.ok(
    !readCalls(tmpDir).some((c) => c.includes('session end')),
    'no session end argv emitted for a non-leaf --key target'
  )
  assert.deepEqual(
    loadRegistry(rawId),
    nodesBefore,
    'registry is completely unchanged by the refusal'
  )
  // Sanity: EPIC-1 really was not a leaf (FLOW-A was its live child).
  assert.equal(
    registryLeaves(nodesBefore).some((n) => n.internalId === epicId),
    false,
    'precondition: EPIC-1 was not a leaf'
  )
})

test('runLeave: --key naming a root-shaped leaf still hits the root guard without --root', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  // A plain no-key root can never be --key-targeted (its registry key is null, not a string), so
  // this exercises the OTHER way a KEYED node ends up parentId: null: enter a child with
  // --parent-key naming an ancestor that was never itself entered — enter.ts stubs that ancestor in
  // with its own key but parentId: null, because ancestry beyond the one edge its register response
  // names isn't known locally.
  runEnter('FLOW-CHILD', 'implementation', 'Child', 'GHOST-PARENT')
  nodeIdForKey('FLOW-CHILD') // asserts the child node was actually registered
  const ghostParentId = nodeIdForKey('GHOST-PARENT')
  assert.equal(
    loadRegistry(rawId).find((n) => n.key === 'GHOST-PARENT')?.parentId,
    null,
    'precondition: the stubbed GHOST-PARENT is root-shaped (parentId: null)'
  )

  // Leave the child so GHOST-PARENT becomes a leaf itself (nothing points to it anymore).
  runLeave(undefined, false, 'FLOW-CHILD')
  assert.equal(
    registryLeaves(loadRegistry(rawId)).some((n) => n.key === 'GHOST-PARENT'),
    true,
    'precondition: GHOST-PARENT is now a leaf (its only child was just left)'
  )

  // --key naming GHOST-PARENT (a leaf, but parentId: null) without --root must still refuse.
  runLeave(undefined, false, 'GHOST-PARENT')

  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero — the root guard fired')
  assert.ok(
    !readCalls(tmpDir).some(
      (c) => c.includes('session end') && c.includes(`--id ${ghostParentId}`)
    ),
    'GHOST-PARENT was never ended — the root guard blocked it, --key did not bypass it'
  )
  assert.equal(
    loadRegistry(rawId).some((n) => n.internalId === ghostParentId),
    true,
    'GHOST-PARENT is still in the registry — the refusal did not remove it'
  )
})

// ---------------------------------------------------------------------------
// Explicit --session <internal id> targets that node directly, mirroring --key, instead of being
// (wrongly) treated as if it named the raw session id.
// ---------------------------------------------------------------------------

test('runLeave: --session <internal id> targets that specific leaf, same as --key', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('EPIC-1', 'architecture')
  runEnter('FLOW-A', 'implementation', 'Node A', 'EPIC-1')
  const nodeA = nodeIdForKey('FLOW-A')
  runEnter('FLOW-B', 'implementation', 'Node B', 'EPIC-1')
  const nodeB = nodeIdForKey('FLOW-B')

  // Previously this would treat nodeA (an internal id, not the raw session id) AS the raw id,
  // look up an empty registry, and report "nothing to leave" instead of ending A.
  runLeave(nodeA)

  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session end') && c.includes(`--id ${nodeA}`)),
    'ends A specifically (the --session-targeted internal id)'
  )
  assert.equal(
    registryLeaves(loadRegistry(rawId)).some((n) => n.internalId === nodeA),
    false,
    'A removed from the registry'
  )
  assert.equal(soleLeaf(rawId), nodeB, 'B is now the sole leaf, untouched')
})

test('runLeave: --session <internal id> naming a non-leaf is refused, same as --key', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('EPIC-1', 'architecture')
  const epicId = nodeIdForKey('EPIC-1')
  runEnter('FLOW-A', 'implementation', 'Node A', 'EPIC-1')
  nodeIdForKey('FLOW-A') // asserts the child node was actually registered

  runLeave(epicId)

  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
  assert.ok(
    !readCalls(tmpDir).some((c) => c.includes('session end')),
    'no session end argv emitted — EPIC-1 has a live child (FLOW-A)'
  )
  assert.equal(
    loadRegistry(rawId).some((n) => n.internalId === epicId),
    true,
    'the non-leaf target is still in the registry — the refusal did not remove it'
  )
})

test('runLeave: --session equal to the raw session id itself is NOT internal-id targeting — falls through to the normal sole-leaf path', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-A', 'implementation', 'Node A')
  const nodeA = nodeIdForKey('FLOW-A')

  // session === rawId is the ordinary "confirm which Claude session" form every other verb
  // accepts (a hook passing --session $CLAUDE_CODE_SESSION_ID) — it must resolve via the normal
  // sole-leaf path, not attempt (and fail) an internal-id lookup for rawId itself.
  runLeave(rawId)

  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session end') && c.includes(`--id ${nodeA}`)),
    'ends the sole leaf normally — rawId-as-session was not mistaken for an internal-id target'
  )
})

test('runLeave: --session equal to the MINTED root external id is ALSO NOT internal-id targeting', () => {
  // FLOW-190: explicitInternalTarget must recognize a minted root's own external id — not just the
  // legacy bare rawId the test above covers — so it uses `isSessionExternalId(session, rawId)`
  // rather than a narrower two-arm check (`session !== rawId && !session.startsWith(rawId +
  // ':')`), which would satisfy neither arm for this shape and misread the root as an internal id,
  // erroring "no active board session with id ...". Uncovered until now.
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-A', 'implementation', 'Node A')
  const nodeA = nodeIdForKey('FLOW-A')
  const mintedRootExternalId = registryRoot(loadRegistry(rawId))!.externalId

  runLeave(mintedRootExternalId)

  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session end') && c.includes(`--id ${nodeA}`)),
    'ends the sole leaf normally — the minted root external id was not mistaken for an internal-id target'
  )
})

// ---------------------------------------------------------------------------
// Tests: runEnd removes the ended node's registry entry directly
// ---------------------------------------------------------------------------

test('runEnd: removes the ended node from the registry', () => {
  const externalId = `${rawId}:DIRECT-END`
  const nodeId = mockNodeId(externalId)
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  upsertRegistryNode(rawId, { internalId: nodeId, externalId, key: 'DIRECT-END', parentId: null })
  assert.ok(
    loadRegistry(rawId).some((n) => n.internalId === nodeId),
    'precondition: node is in the registry'
  )

  runEnd(nodeId)

  assert.equal(
    loadRegistry(rawId).some((n) => n.internalId === nodeId),
    false,
    'runEnd removes the registry entry'
  )
})

test('runLeave: unavailable rawId (no session id at all) does not throw', () => {
  delete process.env.CLAUDE_CODE_SESSION_ID
  assert.doesNotThrow(() => runLeave(), 'runLeave must not throw with no resolvable session id')
})

// ---------------------------------------------------------------------------
// runEnd fails loud rather than end a fell-through node: a stale --session must not fall through
// to the sole leaf (ending an unrelated node), and a bare `end` with >1 leaf must not fall through
// to the root (ending the whole epic). Both are destructive.
// ---------------------------------------------------------------------------

test('runEnd: --session naming a stale/unknown id fails loud — nothing ended, registry untouched', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-A', 'implementation', 'Node A')
  const nodesBefore = loadRegistry(rawId)

  runEnd('totally-unknown-stale-id')

  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
  assert.ok(
    !readCalls(tmpDir).some((c) => c.includes('session end')),
    'no session end argv emitted for an unverified --session id'
  )
  assert.deepEqual(loadRegistry(rawId), nodesBefore, 'registry is completely unchanged')
})

test('runEnd: bare end with two sibling leaves fails loud — root not ended, no session end call', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('EPIC-1', 'architecture')
  const epicId = nodeIdForKey('EPIC-1')
  runEnter('FLOW-A', 'implementation', 'Node A', 'EPIC-1')
  nodeIdForKey('FLOW-A') // asserts the child node was actually registered
  runEnter('FLOW-B', 'implementation', 'Node B', 'EPIC-1')
  nodeIdForKey('FLOW-B') // asserts the child node was actually registered

  const nodesBefore = loadRegistry(rawId)

  runEnd()

  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero on ambiguity')
  const calls = readCalls(tmpDir)
  assert.ok(
    !calls.some((c) => c.includes('session end') && c.includes(`--id ${epicId}`)),
    'the root (EPIC-1) is NOT ended on a bare, ambiguous end'
  )
  assert.ok(
    !calls.some((c) => c.includes('session end')),
    'no session end argv emitted at all on the ambiguity refusal'
  )
  assert.deepEqual(loadRegistry(rawId), nodesBefore, 'registry is completely unchanged')
})

test('runEnd: bare end with exactly one leaf ends it (unchanged behavior)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-A', 'implementation', 'Node A')
  const nodeA = nodeIdForKey('FLOW-A')

  runEnd()

  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session end') && c.includes(`--id ${nodeA}`)),
    'ends the sole leaf'
  )
  assert.equal(exitCodeIsError(), false, 'no error exit code when there is exactly one leaf')
  assert.equal(
    loadRegistry(rawId).some((n) => n.internalId === nodeA),
    false,
    'the ended node is removed from the registry'
  )
})

// The same class as runItemAdd/enter's corrupt-state guards (stateFileIsCorrupt/refuseCorruptState,
// state.ts), at the last site that still read past it. `loadState(...)?.openItemIds ?? []` reads an
// unreadable file as a node with nothing open, so the withdraw is skipped and `session end` still
// fires — the session leaves the board with its items still open on it, and no one is told.
test('runEnd: refuses to end a session whose state file is present and unreadable, rather than ending it with items left open (FLOW-226 finding e931a33aee1d)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-A', 'implementation', 'Node A')
  const nodeA = nodeIdForKey('FLOW-A')
  assert.ok(
    existsSync(stateFilePath(nodeA)),
    'precondition: entering wrote a state file, so the fixture below damages real state'
  )
  // Parses perfectly and still resolves to null — the arm a syntax fixture would miss, on the very
  // field runEnd reads.
  const damaged = '{"registered":true,"phase":"implementation","openItemIds":"item-1"}'
  writeFileSync(stateFilePath(nodeA), damaged)
  const nodesBefore = loadRegistry(rawId)

  const stderrOut = captureStderr(() => runEnd())

  // The board call first: it is the harm, and a red that names it is worth more than one naming
  // the exit code the refusal happens to set on its way there.
  const calls = readCalls(tmpDir)
  assert.ok(
    !calls.some((c) => c.includes('session end')),
    'no session end argv — the board keeps the node rather than closing one whose items are unread'
  )
  assert.ok(
    !calls.some((c) => c.includes('item withdraw')),
    'and nothing is withdrawn either — acting on items nobody read is the other half of the trade'
  )
  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
  assert.ok(
    stderrOut.includes(stateFilePath(nodeA)) && stderrOut.includes('refusing to end this session'),
    `stderr names the file and the refusal, got: ${stderrOut}`
  )
  assert.deepEqual(loadRegistry(rawId), nodesBefore, 'registry is completely unchanged')
  assert.equal(
    readFileSync(stateFilePath(nodeA), 'utf8'),
    damaged,
    'the damaged file is preserved for hand repair, not overwritten'
  )

  // The fixture is what caused all of the above: repair it and the same call ends the node.
  resetExitCode()
  writeFileSync(
    stateFilePath(nodeA),
    '{"registered":true,"phase":"implementation","openItemIds":[]}'
  )

  runEnd()

  assert.equal(exitCodeIsError(), false, 'a readable state file ends normally')
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session end') && c.includes(`--id ${nodeA}`)),
    'and the session end argv the refusal withheld is emitted once the file is readable'
  )
})

// The caller-side half of runEnd's guard. runEnd returns void, so runLeave cannot see that it
// refused, and its own removeRegistryNode runs either way — deleting the last handle for the repair
// the refusal asks for, after making no board call at all. That leaves the board node alive with
// its items open and nothing local left to resolve, which is worse than the bad end it replaced.
test('runLeave: refuses on an unreadable state file instead of deleting the registry entry after runEnd declined to end the node (FLOW-226 finding d91a51ac6217)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('EPIC-1', 'architecture')
  runEnter('FLOW-A', 'implementation', 'Node A', 'EPIC-1')
  const nodeA = nodeIdForKey('FLOW-A')
  assert.ok(
    existsSync(stateFilePath(nodeA)),
    'precondition: entering wrote a state file, so the fixture below damages real state'
  )
  const damaged = '{"registered":true,"phase":"implementation","openItemIds":"item-1"}'
  writeFileSync(stateFilePath(nodeA), damaged)
  const nodesBefore = loadRegistry(rawId)
  const callsBefore = readCalls(tmpDir).length

  const stderrOut = captureStderr(() => runLeave())

  assert.deepEqual(
    loadRegistry(rawId),
    nodesBefore,
    'the registry entry survives — it is the only handle left for the repair the refusal asks for'
  )
  assert.equal(
    readCalls(tmpDir).length,
    callsBefore,
    'no board call of any kind — leaving a live node on the board with no local entry is the orphan'
  )
  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
  assert.ok(
    stderrOut.includes(stateFilePath(nodeA)) && stderrOut.includes('refusing to end this session'),
    `stderr names the file and the refusal, got: ${stderrOut}`
  )

  // The fixture is what caused it: repair the file and the same call leaves normally.
  resetExitCode()
  writeFileSync(
    stateFilePath(nodeA),
    '{"registered":true,"phase":"implementation","openItemIds":[]}'
  )

  runLeave()

  assert.equal(exitCodeIsError(), false, 'a readable state file leaves normally')
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session end') && c.includes(`--id ${nodeA}`)),
    'and the board call the refusal withheld is emitted once the file is readable'
  )
  assert.equal(
    loadRegistry(rawId).some((n) => n.internalId === nodeA),
    false,
    'and the registry entry is removed, as it always was on a clean leave'
  )
})

test('runLeave --root: refuses on an unreadable state file too — the root path reaches the same pair', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  // Registered directly rather than via runEnter: runEnter mints a root ABOVE the key it is given,
  // so the root would have a child and --root would stop at the has-active-children refusal before
  // ever reaching the guard under test.
  const externalId = `${rawId}:ROOT-LEAVE`
  const rootNodeId = mockNodeId(externalId)
  upsertRegistryNode(rawId, {
    internalId: rootNodeId,
    externalId,
    key: 'ROOT-LEAVE',
    parentId: null,
  })
  mkdirSync(dirname(stateFilePath(rootNodeId)), { recursive: true })
  writeFileSync(
    stateFilePath(rootNodeId),
    '{"registered":true,"phase":"architecture","openItemIds":"item-1"}'
  )
  const nodesBefore = loadRegistry(rawId)
  const callsBefore = readCalls(tmpDir).length

  const stderrOut = captureStderr(() => runLeave(undefined, true))

  assert.deepEqual(loadRegistry(rawId), nodesBefore, 'the root entry survives --root as well')
  assert.equal(readCalls(tmpDir).length, callsBefore, 'no board call on the --root path either')
  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
  assert.ok(
    stderrOut.includes('refusing to end this session'),
    `stderr explains the refusal, got: ${stderrOut}`
  )
})

test('runEnd: --session equal to the MINTED root external id is NOT internal-id targeting either', () => {
  // FLOW-190: runEnd's explicitInternalTarget shares runLeave's isSessionExternalId check — a
  // minted root's own external id must fall through to the normal sole-leaf path, not be misread as
  // an internal node id (which would error "no active session ... to end"). Uncovered until now.
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-A', 'implementation', 'Node A')
  const nodeA = nodeIdForKey('FLOW-A')
  const mintedRootExternalId = registryRoot(loadRegistry(rawId))!.externalId

  runEnd(mintedRootExternalId)

  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session end') && c.includes(`--id ${nodeA}`)),
    'ends the sole leaf normally — the minted root external id was not mistaken for an internal-id target'
  )
  assert.equal(exitCodeIsError(), false, 'no error exit code')
})

test('runEnd: verified --session <live internal id> ends it (unchanged behavior)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('EPIC-1', 'architecture')
  runEnter('FLOW-A', 'implementation', 'Node A', 'EPIC-1')
  const nodeA = nodeIdForKey('FLOW-A')
  runEnter('FLOW-B', 'implementation', 'Node B', 'EPIC-1')
  const nodeB = nodeIdForKey('FLOW-B')

  // An explicit --session naming a live registry node (A) resolves and ends it even though B, a
  // sibling leaf, also exists — verification via the registry means this is not "ambiguous".
  runEnd(nodeA)

  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session end') && c.includes(`--id ${nodeA}`)),
    'ends A specifically (the verified --session target)'
  )
  assert.equal(exitCodeIsError(), false, 'no error exit code for a verified explicit target')
  assert.equal(
    loadRegistry(rawId).some((n) => n.internalId === nodeA),
    false,
    'A removed from the registry'
  )
  assert.equal(soleLeaf(rawId), nodeB, 'B is untouched and now the sole leaf')
})

test('runLeave: internal runLeave -> runEnd(target.internalId) path still ends cleanly under the new fail-loud runEnd, even with multiple sibling leaves present', () => {
  // Guard against the new runEnd ambiguity check (>1 leaf, no explicit target -> fail loud)
  // mis-firing on runLeave's OWN internal call. runLeave always resolves its target itself first
  // (sole leaf, or --key/--session on ambiguity) and calls runEnd(target.internalId) with an
  // already-verified explicit id — that must take runEnd's explicit-target branch (resolved via
  // resolveSessionTarget's registry-membership check) and succeed silently, never the no-target
  // ambiguity branch, regardless of how many OTHER leaves are still live at call time.
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('EPIC-1', 'architecture')
  runEnter('FLOW-A', 'implementation', 'Node A', 'EPIC-1')
  const nodeA = nodeIdForKey('FLOW-A')
  runEnter('FLOW-B', 'implementation', 'Node B', 'EPIC-1')
  const nodeB = nodeIdForKey('FLOW-B')

  runLeave(undefined, false, 'FLOW-A')

  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session end') && c.includes(`--id ${nodeA}`)),
    'runLeave --key FLOW-A still ends A cleanly through the new fail-loud runEnd'
  )
  assert.equal(
    exitCodeIsError(),
    false,
    'no error exit code — the internal call never hits the ambiguity branch'
  )
  assert.equal(
    loadRegistry(rawId).some((n) => n.internalId === nodeA),
    false,
    'A removed from the registry'
  )
  assert.equal(soleLeaf(rawId), nodeB, 'B, the other live leaf, is untouched')
})

// Guards runEnd's own withdrawn gate: an unconditional second removeRegistryNode call here would
// bypass it, which is why runLeave has none — runEnd(target.internalId) already removes the node
// itself, gated on withdrawn succeeding. Exercised through runLeave, not runEnd directly —
// dashboard.test.ts's equivalent withdraw-fails coverage never went through runLeave, which is
// exactly what let that second call go unnoticed.
test('runLeave: a withdraw that fails to clear the ledger holds off removing the registry entry too', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0)

  runEnter('EPIC-1', 'architecture')
  runEnter('FLOW-A', 'implementation', 'Node A', 'EPIC-1')
  const nodeA = nodeIdForKey('FLOW-A')
  writeFileSync(
    stateFilePath(nodeA),
    JSON.stringify({ registered: true, phase: 'pr', openItemIds: ['item-1'] })
  )

  // Swapped to a failing stub only now — the tree above must be built with a succeeding one, or
  // runEnter's own register calls fail before there is a leaf to leave.
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 1)

  runLeave()

  const calls = readCalls(tmpDir)
  assert.ok(
    calls.some((c) => c.includes('item withdraw') && c.includes('--all') && c.includes(nodeA)),
    'still attempts the withdraw'
  )
  assert.ok(
    !calls.some((c) => c.includes('session end')),
    'never marks the session ended once the withdraw failed'
  )
  assert.ok(
    loadRegistry(rawId).some((n) => n.internalId === nodeA),
    'registry entry survives a failed withdraw, so a retry can still find it by internal id'
  )
})

// ---------------------------------------------------------------------------
// The zero-leaves "nothing to leave" message shares resolveSessionTarget's own
// never-entered-vs-entered-while-unreachable ambiguity and needs the same distinguishing text.
// ---------------------------------------------------------------------------

test('runLeave: zero leaves + ai-workflow-app unreachable → message distinguishes the cause from the generic empty-registry one', () => {
  // beforeEach already points AI_WORKFLOW_APP_BIN at a nonexistent binary — no stub wired here.
  const stderr = captureStderr(() => {
    runLeave()
  })
  assert.match(
    stderr,
    /not reachable to check the board for one/,
    'the unreachable-binary cause gets its own message, distinct from the plain "nothing to leave" one'
  )
  assert.equal(
    exitCodeIsError(),
    false,
    'zero leaves is a no-op regardless of cause — every sibling zero-leaves test asserts this channel too'
  )
})

// Regression for FLOW-250: the zero-leaf/unreachable-bin message here must not offer a --key
// remedy — --key would search this same empty local registry (nodes.find((n) => n.key === key)),
// the same registry that already makes this branch unactionable, so there is no key it could ever
// resolve.
test('runLeave: zero leaves + ai-workflow-app unreachable → message does not offer the unactionable --key remedy', () => {
  // beforeEach already points AI_WORKFLOW_APP_BIN at a nonexistent binary — no stub wired here.
  const stderr = captureStderr(() => {
    runLeave()
  })
  // A positive assertion alongside the absence: deleting the whole bin-unreachable branch (or its
  // message) would also make --key vanish from stderr, so absence alone cannot tell "the --key
  // clause was dropped" apart from "the branch was dropped". Pinning the content that only this
  // arm produces closes that gap.
  assert.match(
    stderr,
    /not reachable to check the board for one/,
    'this is still the bin-unreachable arm, not some other branch that also happens to omit --key'
  )
  assert.match(
    stderr,
    /making ai-workflow-app reachable now would not change what a retry finds here/,
    'the message says why there is no remedy to offer, not a bare "try again"'
  )
  assert.ok(
    !stderr.includes('--key'),
    '--key can never resolve here: the registry it would search is the same empty one that made this branch unactionable'
  )
  assert.equal(
    exitCodeIsError(),
    false,
    'zero leaves is a no-op regardless of cause — every sibling zero-leaves test asserts this channel too'
  )
})

test('runLeave: zero leaves + ai-workflow-app reachable → plain "nothing to leave" message, no unreachable-binary text', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  const stderr = captureStderr(() => {
    runLeave()
  })
  assert.match(stderr, /nothing to leave — no active board session for this session/)
  assert.ok(
    !stderr.includes('not reachable to check the board for one'),
    'binary is reachable, so the message never claims otherwise'
  )
})
