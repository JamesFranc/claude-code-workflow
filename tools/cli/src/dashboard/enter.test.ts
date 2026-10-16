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
// Helpers (shared pattern from dashboard.test.ts / rotate.test.ts)
// ---------------------------------------------------------------------------

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), 'enter-test-'))

// The real register CLI mints the id (FLOW-132); this stub mocks that by deterministically
// deriving a fake "minted uuid" from --external-id (and --parent-external-id, if present) so
// tests can predict what enter.ts will read back, matching the register JSON stdout contract:
// {"id":"<uuid>","parentId":"<uuid>"|null}.
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

/** Like writeStub, but reports the registered node as `closed` — REV-66's declined-reactivation
 * outcome, which used to be indistinguishable from success. */
const writeClosedLifecycleStub = (dir: string): string => {
  const path = join(dir, 'ai-workflow-app')
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `echo "$@" >> ${JSON.stringify(join(dir, 'calls.log'))}`,
      'ext=""',
      'args=("$@")',
      'for ((i=0; i<$#; i++)); do',
      '  if [ "${args[$i]}" = "--external-id" ]; then ext="${args[$((i+1))]}"; fi',
      'done',
      'printf \'{"id":"mock-uuid-%s","parentId":null,"lifecycle":"closed"}\\n\' "$ext"',
      'exit 0',
      '',
    ].join('\n')
  )
  chmodSync(path, 0o755)
  return path
}

/** Like writeStub, but omits `id` from the register response — an older or misbehaving
 * ai-workflow-app build's malformed reply, which used to crash downstream with a raw TypeError
 * instead of a `dashboard:`-prefixed refusal. */
const writeMissingIdStub = (dir: string): string => {
  const path = join(dir, 'ai-workflow-app')
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `echo "$@" >> ${JSON.stringify(join(dir, 'calls.log'))}`,
      'printf \'{"parentId":null,"lifecycle":"active"}\\n\'',
      'exit 0',
      '',
    ].join('\n')
  )
  chmodSync(path, 0o755)
  return path
}

/** Like writeStub, but writes output that is not valid JSON at all — a genuinely malformed
 * register response (truncated pipe, a build that emits a stray warning line first), distinct from
 * writeMissingIdStub's well-formed-but-incomplete JSON. Used to prove parseRegisterOutput's bare
 * JSON.parse refuses cleanly rather than escaping as a raw stack trace. */
const writeMalformedJsonStub = (dir: string): string => {
  const path = join(dir, 'ai-workflow-app')
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `echo "$@" >> ${JSON.stringify(join(dir, 'calls.log'))}`,
      "printf 'not json at all\\n'",
      'exit 0',
      '',
    ].join('\n')
  )
  chmodSync(path, 0o755)
  return path
}

/** Like writeStub, but omits `parentId` from the register response entirely — a well-formed
 * response missing the field, distinct from writeMissingIdStub's missing `id`. Used to prove
 * parseRegisterOutput refuses an absent parentId rather than trusting it as `null`. */
const writeOmittedParentIdStub = (dir: string): string => {
  const path = join(dir, 'ai-workflow-app')
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `echo "$@" >> ${JSON.stringify(join(dir, 'calls.log'))}`,
      'printf \'{"id":"mock-uuid-omitted-parentid","lifecycle":"active"}\\n\'',
      'exit 0',
      '',
    ].join('\n')
  )
  chmodSync(path, 0o755)
  return path
}

/** Like writeStub, but writes a numeric `parentId` — a well-formed response whose parentId is
 * neither a string nor null. Used to prove parseRegisterOutput validates the field's shape rather
 * than trusting whatever JSON.parse returns for it. */
const writeNumericParentIdStub = (dir: string): string => {
  const path = join(dir, 'ai-workflow-app')
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `echo "$@" >> ${JSON.stringify(join(dir, 'calls.log'))}`,
      'printf \'{"id":"mock-uuid-numeric-parentid","parentId":42,"lifecycle":"active"}\\n\'',
      'exit 0',
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

// The registry-era replacement for "does the active pointer name this id" — look the node up by
// internalId in the raw session's registry.
const registryNode = (rawId: string, internalId: string) =>
  loadRegistry(rawId).find((n) => n.internalId === internalId)

// FLOW-190: the root's external id is minted, so a node's composed external/internal id can no
// longer be precomputed from the raw session id alone — look it up by key from the registry after
// the entering runEnter call has actually happened.
const registryNodeByKey = (rawId: string, key: string) =>
  loadRegistry(rawId).find((n) => n.key === key)

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

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { runEnter } from './enter.ts'
import { runLeave } from './lifecycle.ts'
import { loadState, saveState, stateFilePath, type DeferredQuestion } from './state.ts'
import {
  loadRegistry,
  registryLeaves,
  registryFilePath,
  registryRoot,
  upsertRegistryNode,
  isSessionExternalId,
  isRootExternalId,
} from './registry.ts'
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'
import { loadWorkflowState, workflowStateFilePath } from '../workflow-state/state.ts'

const resetExitCode = (): void => setRequestedExitCode(0)
const exitCodeIsError = (): boolean => {
  const code = getRequestedExitCode()
  return code !== undefined && code !== 0
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

// stateFilePath/registryFilePath/workflowStateFilePath resolve through the durable store, which is
// homedir()-relative — override HOME so these tests never touch the real ~/.claude/workflow-state.
beforeEach(() => {
  tmpDir = makeTempDir()
  origBin = process.env.AI_WORKFLOW_APP_BIN
  // A test that forgets to wire its own stub must resolve to "dashboard unavailable" (an existing,
  // handled no-op), never fall through resolveDashboardBin's PATH lookup to the REAL installed
  // ai-workflow-app and drive it against the real board database. Wired tests overwrite this.
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'no-such-ai-workflow-app')
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  rawId = `test-enter-session-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  homeDir = mkdtempSync(join(tmpdir(), 'enter-test-home-'))
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

test('runEnter: with a parent, registers with --parent-external-id, points raw at the minted leaf, records parentId', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-106', 'implementation', 'My Story', 'EPIC-1')

  // FLOW-190: the root is minted, so the composed external ids are read back from the registry
  // rather than precomputed from the raw session id.
  const registered = registryNodeByKey(rawId, 'FLOW-106')!
  const parentStub = registryNodeByKey(rawId, 'EPIC-1')!
  const externalId = registered.externalId
  const parentExternalId = parentStub.externalId
  const nodeId = registered.internalId
  const parentId = parentStub.internalId

  // The two `calls[0]!.includes(...)` checks below compare the argv against a value read back
  // from the SAME registry entry that call created — true for ANY composition rule, since both
  // sides are the same string. Pin the actual shape independently first.
  //
  // NOT via registryRoot(loadRegistry(rawId)): in THIS test that resolves to the EPIC-1 stub, not
  // the true minted root. EPIC-1 was never separately entered, so it has no registry node of its
  // own until enter.ts's reactivation-edge stub writes one — and that stub always records
  // `parentId: null` (ancestry beyond this one register response is unknown locally; see the stub's
  // own comment in enter.ts), which makes it satisfy registryRoot's `parentId === null` test even
  // though its externalId already carries a `:EPIC-1` suffix. The true root never gets its own
  // registry entry in this scenario (nothing was ever entered with no key/no parent-key), so its
  // external id is recovered here by stripping the known `:EPIC-1` suffix off the parent stub —
  // independent of `registered.externalId`, which is what makes this a real pin.
  const trueRootExternalId = parentStub.externalId.slice(0, -':EPIC-1'.length)
  assert.equal(
    registered.externalId,
    `${trueRootExternalId}:FLOW-106`,
    'FLOW-106 composes flat off the root, not nested through the EPIC-1 parent chain'
  )

  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'exactly one call')
  assert.ok(calls[0]!.includes('session register'), 'calls session register')
  assert.ok(calls[0]!.includes('--system-id claude-workflow'), 'includes --system-id')
  assert.ok(calls[0]!.includes(`--external-id ${externalId}`), 'includes --external-id <raw>:<key>')
  assert.ok(calls[0]!.includes('--title My Story'), 'includes --title')
  assert.ok(calls[0]!.includes('--phase implementation'), 'includes --phase')
  assert.ok(
    calls[0]!.includes(`--parent-external-id ${parentExternalId}`),
    'includes --parent-external-id <raw>:<parentKey>'
  )
  assert.ok(!calls[0]!.includes('--id '), 'never sends the removed --id flag')
  assert.ok(!calls[0]!.includes('--parent '), 'never sends the removed --parent flag')

  const node = registryNode(rawId, nodeId)
  assert.ok(node, 'registry contains the minted leaf id')
  assert.equal(node!.parentId, parentId, "registry node's parentId is the minted parent id")
  assert.equal(node!.key, 'FLOW-106', 'registry node key matches')

  const state = loadState(nodeId)
  assert.ok(state, 'state written, keyed by the minted id')
  assert.equal(state!.registered, true, 'registered true')
  assert.deepEqual(state!.openItemIds, [], 'openItemIds empty')
  assert.equal(state!.parentId, parentId, 'parentId recorded from the register response')

  try {
    rmSync(stateFilePath(nodeId))
  } catch {
    /* ignore */
  }
})

test('runEnter: key, no parent-key — child of the root (parent-external-id = rawId)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-107', 'implementation')

  // FLOW-190: the root is minted, so its external/internal id is read back from the registry.
  const registered = registryNodeByKey(rawId, 'FLOW-107')!
  const nodeId = registered.internalId
  const rootExternalId = registryRoot(loadRegistry(rawId))!.externalId
  const parentId = registryRoot(loadRegistry(rawId))!.internalId
  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'exactly one call')
  // FLOW-118 supersedes FLOW-117 here: key with no parent-key now defaults to a child of the
  // root, not a parentless node — so --parent-external-id IS present, pointing at the root id.
  assert.ok(
    calls[0]!.includes(`--parent-external-id ${rootExternalId}`),
    'includes --parent-external-id <root> (defaults to root)'
  )
  // FLOW-151: --title is only sent when explicitly passed — a plain re-enter (no --title) must
  // not clobber an already-set real title back down to the bare key (the live FLOW-149 incident).
  assert.ok(
    !calls[0]!.includes('--title'),
    'no --title flag when none was given — not even the key'
  )

  const node = registryNode(rawId, nodeId)
  assert.ok(node, 'registry contains the minted leaf id')
  assert.equal(
    node!.parentId,
    parentId,
    "registry node's parentId defaults to the root's minted id when no parent-key given"
  )
  const state = loadState(nodeId)
  assert.equal(
    state!.parentId,
    parentId,
    "parentId defaults to the root's minted id when no parent-key given"
  )

  try {
    rmSync(stateFilePath(nodeId))
  } catch {
    /* ignore */
  }
})

test('runEnter: no key — this IS the root (external-id = rawId, parentId null)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter(undefined, 'prd', 'My Root Title')

  // FLOW-190: the root's external id is minted, not literally rawId.
  const rootExternalId = registryRoot(loadRegistry(rawId))!.externalId
  const nodeId = registryRoot(loadRegistry(rawId))!.internalId
  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'exactly one call')
  assert.ok(
    calls[0]!.includes(`--external-id ${rootExternalId}`),
    'external-id is the minted root, no :key suffix'
  )
  assert.ok(!rootExternalId.includes(':'), 'a root carries no key suffix')
  assert.ok(
    !calls[0]!.includes('--parent-external-id'),
    'no --parent-external-id flag for the root'
  )
  assert.ok(calls[0]!.includes('--title My Root Title'), 'includes --title')

  const node = registryNode(rawId, nodeId)
  assert.ok(node, "registry contains the root's minted id")
  assert.equal(node!.parentId, null, 'registry node has no parent')
  assert.equal(node!.key, null, 'registry node has no key (this IS the root)')
  const state = loadState(nodeId)
  assert.ok(state, 'root state written, keyed by the minted id')
  assert.equal(state!.registered, true, 'registered true')
  assert.equal(state!.parentId, null, 'root has no parent')

  try {
    rmSync(stateFilePath(nodeId))
  } catch {
    /* ignore */
  }
})

test('runEnter: root with no key and no title omits --title (never sends the raw session id)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter(undefined, 'implementation')

  const rootExternalId = registryRoot(loadRegistry(rawId))!.externalId
  const nodeId = registryRoot(loadRegistry(rawId))!.internalId
  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'exactly one call')
  assert.ok(calls[0]!.includes(`--external-id ${rootExternalId}`), 'registers the root external id')
  assert.ok(
    !calls[0]!.includes('--title'),
    'no --title flag — backend preserves the existing title'
  )
  assert.ok(!calls[0]!.includes('--title ' + rawId), 'rawId is never passed as a --title value')
  assert.ok(registryNode(rawId, nodeId), "registry still contains the root's minted id")
  assert.ok(loadState(nodeId), 'root state still written')

  try {
    rmSync(stateFilePath(nodeId))
  } catch {
    /* ignore */
  }
})

test('runEnter: key with no prior plain-root enter also stubs the implicit root in the registry', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  // No prior `runEnter` for the plain root — EPIC-1 is entered directly, defaulting to a child
  // of the (never separately entered) root (FLOW-118).
  runEnter('EPIC-1', 'architecture')

  const nodes = loadRegistry(rawId)
  const epicId = registryNodeByKey(rawId, 'EPIC-1')!.internalId
  const rootId = registryRoot(nodes)!.internalId

  const rootNode = nodes.find((n) => n.internalId === rootId)
  assert.ok(rootNode, 'the implicit root is stubbed into the registry')
  assert.equal(rootNode!.key, null, 'root stub has no key')
  assert.equal(rootNode!.parentId, null, 'root stub has no parent')
  // The registry is empty at the top of this test (no prior root enter), so the mint branch of
  // resolveRootExternalId MUST run — `=== rawId` cannot legitimately hold here. A disjunct
  // accepting either shape would stay green even if minting regressed to the pre-fix `return
  // rawId`, so assert the minted shape specifically, not "legacy or minted."
  assert.ok(
    isRootExternalId(rootNode!.externalId, rawId),
    'root stub externalId satisfies isRootExternalId'
  )
  assert.notEqual(
    rootNode!.externalId,
    rawId,
    'root stub externalId is minted, not the bare raw id — this test starts with an empty registry'
  )
  const epicNode = nodes.find((n) => n.internalId === epicId)
  assert.ok(epicNode, 'EPIC-1 is in the registry')
  assert.equal(epicNode!.parentId, rootId, "EPIC-1's parent is the stubbed root's internal id")

  assert.deepEqual(
    registryLeaves(nodes).map((n) => n.internalId),
    [epicId],
    'EPIC-1 alone is the leaf — the root stub is not (EPIC-1 names it as parent)'
  )

  try {
    rmSync(stateFilePath(epicId))
  } catch {
    /* ignore */
  }
})

test('runEnter: --parent-key without --key throws (a parentless root cannot have a parent)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  assert.throws(
    () => runEnter(undefined, 'implementation', 'My Title', 'EPIC-1'),
    /--parent-key requires --key/,
    'throws when parent-key is given without a key'
  )

  // No side effects: nothing registered, no registry/state written.
  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 0, 'no dashboard call made before the guard throws')
  assert.deepEqual(loadRegistry(rawId), [], 'no registry node written')
})

test('runEnter: entering B while A is active is a focus-switch, not an implicit leave of A', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-A', 'implementation', 'Node A')
  const nodeA = registryNodeByKey(rawId, 'FLOW-A')!.internalId
  assert.ok(registryNode(rawId, nodeA), 'precondition: A is in the registry')

  runEnter('FLOW-B', 'implementation', 'Node B')
  const nodeB = registryNodeByKey(rawId, 'FLOW-B')!.internalId

  // Registry-era focus switch: both A and B are children of the (implicit, never separately
  // entered) root — neither names the other as parent — so both remain live leaves. Nothing
  // pops or moves; entering B is additive, not a pointer relocation.
  assert.ok(registryNode(rawId, nodeA), 'A is still in the registry after entering B')
  assert.ok(registryNode(rawId, nodeB), 'B is in the registry')
  const leafIds = registryLeaves(loadRegistry(rawId)).map((n) => n.internalId)
  assert.deepEqual(
    new Set(leafIds),
    new Set([nodeA, nodeB]),
    'A and B are both leaves (siblings under the implicit root, neither is a parent of the other)'
  )

  const stateB = loadState(nodeB)
  assert.ok(stateB, 'B state written')
  assert.equal(stateB!.registered, true, 'B registered')

  // A is not torn down: no `session end` call was ever made, and A's state file is untouched.
  const calls = readCalls(tmpDir)
  assert.ok(
    !calls.some((c) => c.includes('session end') && c.includes(nodeA)),
    'no session end argv emitted for A during the second enter'
  )
  const stateA = loadState(nodeA)
  assert.ok(stateA, 'A state file still exists')
  assert.equal(stateA!.registered, true, 'A remains registered/active (unfocused, not ended)')
  assert.deepEqual(stateA!.openItemIds, [], 'A state otherwise untouched')

  try {
    rmSync(stateFilePath(nodeA))
  } catch {
    /* ignore */
  }
  try {
    rmSync(stateFilePath(nodeB))
  } catch {
    /* ignore */
  }
})

test('runEnter: re-entering an active node preserves its already-tracked openItemIds', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-110', 'implementation', 'My Story')
  const nodeId = registryNodeByKey(rawId, 'FLOW-110')!.internalId

  // Seed the node's state as if an item was posted while it was active (mirrors runItemAdd).
  saveState(nodeId, {
    registered: true,
    phase: 'implementation',
    openItemIds: ['item-1'],
    parentId: null,
  })

  runEnter('FLOW-110', 'implementation', 'My Story')

  const state = loadState(nodeId)
  assert.deepEqual(
    state!.openItemIds,
    ['item-1'],
    're-entering the same active node must not wipe its tracked open items'
  )

  try {
    rmSync(stateFilePath(nodeId))
  } catch {
    /* ignore */
  }
})

test('runEnter: re-entering an active node preserves its deferred-question queue and id counter', () => {
  // Regression for FLOW-250: enter.ts's save was a constructor that named openItemIds/parentId but
  // not deferredQuestions/deferredIdCounter, so a re-enter — the first action of PR Feedback, and a
  // step in Team Dispatch and PR Lifecycle — silently destroyed any queue deferred during the phase
  // being left, and reset the counter, reopening the drained-queue id-recycling defect FLOW-250
  // already fixed once.
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-112', 'implementation', 'My Story')
  const nodeId = registryNodeByKey(rawId, 'FLOW-112')!.internalId

  const queued: DeferredQuestion[] = [
    {
      id: 'q1',
      lede: 'Should the retry live in the client or the caller?',
      body: '',
      recommend: 'Ship it',
      whyMine: 'scope',
      deferredAtPhase: 'implementation',
    },
  ]
  saveState(nodeId, {
    registered: true,
    phase: 'implementation',
    openItemIds: [],
    parentId: null,
    deferredQuestions: queued,
    deferredIdCounter: 1,
  })

  // Re-enter at a DIFFERENT phase — PR Feedback re-entering the ticket node left in implementation
  // — so a fixture that asserts only the queue and counter cannot pass by coincidence: `phase` only
  // reads back as `pr-feedback` if this call's own write actually ran.
  runEnter('FLOW-112', 'pr-feedback', 'My Story')

  const state = loadState(nodeId)
  assert.equal(state!.phase, 'pr-feedback', "re-entering must still record this call's own phase")
  assert.deepEqual(
    state!.deferredQuestions,
    queued,
    're-entering the same active node must not wipe its deferred-question queue'
  )
  assert.equal(
    state!.deferredIdCounter,
    1,
    're-entering the same active node must not reset the deferred-id counter'
  )

  try {
    rmSync(stateFilePath(nodeId))
  } catch {
    /* ignore */
  }
})

test('runEnter: refuses to re-enter over a present-but-unparseable state file, preserving it instead of overwriting it with a fresh one', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-112', 'implementation', 'My Story')
  const nodeId = registryNodeByKey(rawId, 'FLOW-112')!.internalId

  writeFileSync(stateFilePath(nodeId), '{not json')

  // A different title than the first enter's, with --retitle so the FLOW-180 silent-retitle guard
  // (which runs earlier, before this one) does not itself refuse the call — so a registry write on
  // the refused call would be observable: upsertRegistryNode's title tracks whatever was just sent
  // (enter.ts), so the guard running before that write (not after it) is what keeps the registry's
  // title at 'My Story'.
  const stderr = captureStderr(() =>
    runEnter('FLOW-112', 'pr-feedback', 'Renamed while refused', undefined, undefined, true)
  )

  assert.ok(
    stderr.includes('failed to parse') && stderr.includes('refusing to enter'),
    'stderr explains the refusal'
  )
  assert.equal(exitCodeIsError(), true, 'exit code set to error')
  assert.equal(
    readFileSync(stateFilePath(nodeId), 'utf8'),
    '{not json',
    'the damaged file is preserved untouched, not replaced with a fresh empty state'
  )
  assert.equal(
    registryNodeByKey(rawId, 'FLOW-112')!.title,
    'My Story',
    "the registry is never written on a refused enter — its title still reads the first call's, " +
      "not the refused second call's"
  )

  try {
    rmSync(stateFilePath(nodeId))
  } catch {
    /* ignore */
  }
})

test('runEnter: re-entering after leave/end starts with empty openItemIds (no stale ids carried)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-111', 'implementation', 'My Story')
  const nodeId = registryNodeByKey(rawId, 'FLOW-111')!.internalId

  // Seed an open item, then end the node the same way runLeave does (withdraws + clears). FLOW-111
  // was entered with a key and no parent-key, so per FLOW-118 it defaults to a CHILD of the
  // implicit root stub, not the root itself — a bare `runLeave()` ends it; `--root` here would be
  // refused since the resolved target isn't the root. The test isn't exercising either guard,
  // just runLeave's end+re-registration path.
  saveState(nodeId, {
    registered: true,
    phase: 'implementation',
    openItemIds: ['item-1'],
    parentId: null,
  })
  runLeave()

  runEnter('FLOW-111', 'implementation', 'My Story')

  const state = loadState(nodeId)
  assert.deepEqual(
    state!.openItemIds,
    [],
    're-entering a previously-ended node starts clean, no stale item ids carried over'
  )

  try {
    rmSync(stateFilePath(nodeId))
  } catch {
    /* ignore */
  }
})

test('runEnter: re-entering a nested node WITHOUT --parent-key preserves the established parentId', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-112', 'implementation', 'My Story', 'EPIC-1')
  const nodeId = registryNodeByKey(rawId, 'FLOW-112')!.internalId
  const parentId = registryNodeByKey(rawId, 'EPIC-1')!.internalId
  assert.equal(
    loadState(nodeId)!.parentId,
    parentId,
    'precondition: parentId recorded on first enter'
  )

  // Re-enter the SAME node with no --parent-key this time (e.g. a plain focus-back).
  runEnter('FLOW-112', 'implementation', 'My Story')

  assert.equal(
    loadState(nodeId)!.parentId,
    parentId,
    'local parentId is preserved, not clobbered, on a re-enter without --parent-key'
  )

  try {
    rmSync(stateFilePath(nodeId))
  } catch {
    /* ignore */
  }
})

test('runEnter: re-entering with a DIFFERENT --parent-key still keeps the original parentId', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-113', 'implementation', 'My Story', 'EPIC-1')
  const nodeId = registryNodeByKey(rawId, 'FLOW-113')!.internalId
  const originalParentId = registryNodeByKey(rawId, 'EPIC-1')!.internalId
  assert.equal(
    loadState(nodeId)!.parentId,
    originalParentId,
    'precondition: original parent recorded'
  )

  // Re-enter the SAME node claiming a different parent — the backend coalesces (preserve-if-set),
  // so the local copy must match, not diverge to the new value.
  runEnter('FLOW-113', 'implementation', 'My Story', 'EPIC-2')

  assert.equal(
    loadState(nodeId)!.parentId,
    originalParentId,
    'local parentId keeps the original, matching the backend coalesce, not the new --parent-key'
  )

  try {
    rmSync(stateFilePath(nodeId))
  } catch {
    /* ignore */
  }
})

test('runEnter: unavailable dashboard is a silent no-op, writes no pointer or state', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')

  assert.doesNotThrow(() => runEnter('FLOW-108', 'implementation'))

  assert.deepEqual(loadRegistry(rawId), [], 'no registry node written')
  assert.equal(exitCodeIsError(), false, 'exit code not set to error')
})

test('runEnter: available-but-failed invoke leaves pointer and state untouched', () => {
  const stubBin = writeStub(tmpDir, 1, 'boom')
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  captureStderr(() => runEnter('FLOW-109', 'implementation'))

  assert.deepEqual(loadRegistry(rawId), [], 'no registry node written on failure')
  assert.equal(exitCodeIsError(), true, 'exit code set to error')
})

// ---------------------------------------------------------------------------
// FLOW-147: workflow marker written unconditionally, before board interaction
// ---------------------------------------------------------------------------

test('runEnter: board unavailable — writes the marker and returns without throwing', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')

  assert.doesNotThrow(() => runEnter('FLOW-147', 'implementation'))

  const state = loadWorkflowState(rawId)
  assert.ok(state?.workflow, 'marker written even though the board is unavailable')
  assert.equal(state!.workflow!.phase, 'implementation', 'marker records the phase')
})

test('runEnter: stamps provenance via=dashboard-enter (FLOW-147)', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')

  runEnter('FLOW-147', 'implementation')

  const state = loadWorkflowState(rawId)
  assert.equal(
    state!.workflow!.via,
    'dashboard-enter',
    'the board-registering path traces its marker to dashboard-enter'
  )
})

test('runEnter: marker records key when --key passed, omits it for a root entry', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter('FLOW-147', 'implementation')
  const withKey = loadWorkflowState(rawId)
  assert.equal(withKey!.workflow!.key, 'FLOW-147', 'key recorded from --key')

  runEnter(undefined, 'prd')
  const rootEntry = loadWorkflowState(rawId)
  assert.ok(!('key' in rootEntry!.workflow!), 'key omitted for a root (no --key) entry')

  try {
    rmSync(stateFilePath(mockNodeId(`${rawId}:FLOW-147`)))
  } catch {
    /* ignore */
  }
  try {
    rmSync(stateFilePath(mockNodeId(rawId)))
  } catch {
    /* ignore */
  }
})

test('runEnter: board unavailable AND no session id resolvable — throw-free, no marker written', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  delete process.env.CLAUDE_CODE_SESSION_ID

  assert.doesNotThrow(() => runEnter('FLOW-147', 'implementation'))

  // Assert the state FILE was never created, not just that a read returns null — null is also
  // what a corrupt/unparseable file would produce, so it can't prove nothing was written.
  assert.equal(
    existsSync(workflowStateFilePath(rawId)),
    false,
    'no marker file written when no session id resolves'
  )
})

// Bin reachable (unlike the throw-free test above, where the earlier dashboardAvailable() gate
// exits first) and no CLAUDE_CODE_SESSION_ID: resolveRawSessionId throws inside runEnter's own
// register call — proving the try/catch around it reuses the thrown message and sets exit 1
// instead of letting the throw escape uncaught.
test('runEnter: board available, no session id resolvable — refuses cleanly instead of throwing', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  delete process.env.CLAUDE_CODE_SESSION_ID

  let stderrOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => runEnter('FLOW-147', 'implementation'))
  })

  assert.ok(
    stderrOut.includes('No session id: pass --session or set CLAUDE_CODE_SESSION_ID'),
    'stderr carries resolveRawSessionId’s own message'
  )
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
  assert.equal(
    readCalls(tmpDir).length,
    0,
    'the backend register call is never reached once resolution fails'
  )
})

test('runEnter: registration failure — marker is still written', () => {
  const stubBin = writeStub(tmpDir, 1, 'boom')
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  captureStderr(() => runEnter('FLOW-147', 'implementation'))

  const state = loadWorkflowState(rawId)
  assert.ok(state?.workflow, 'marker written even though registration failed')
  assert.equal(state!.workflow!.phase, 'implementation', 'marker records the phase')
})

test('runEnter: invalid args (--parent-key without --key) writes NO marker (FLOW-147)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  assert.throws(
    () => runEnter(undefined, 'implementation', 'My Title', 'EPIC-1'),
    /--parent-key requires --key/,
    'still throws for invalid args'
  )

  assert.equal(
    existsSync(workflowStateFilePath(rawId)),
    false,
    'a failed validation must not grant edit rights via a marker write'
  )
})

// ---------------------------------------------------------------------------
// FLOW-180: --retitle intent and the two structural guards
// ---------------------------------------------------------------------------

test('enter: a re-enter with a different --title and no --retitle throws and does not register', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter(undefined, 'prd', 'Epic title')
  assert.equal(readCalls(tmpDir).length, 1, 'precondition: first enter registered')

  assert.throws(
    () => runEnter(undefined, 'implementation', 'some bug'),
    /refusing to rename/,
    'throws refusing to rename'
  )
  assert.equal(readCalls(tmpDir).length, 1, 'the refused enter never reached the board')

  try {
    rmSync(stateFilePath(mockNodeId(rawId)))
  } catch {
    /* ignore */
  }
})

test('enter: --retitle allows the rename and forwards the new title', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter(undefined, 'prd', 'Epic title')
  runEnter(undefined, 'implementation', 'some-new-title', undefined, undefined, true)

  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 2, 'both calls reached the board')
  assert.ok(calls[1]!.includes('--title some-new-title'), 'second call forwards the new title')
  // A phase re-enter with --retitle is a second keyless enter — it must reuse the existing root,
  // not register a second, orphaned one.
  assert.equal(loadRegistry(rawId).length, 1, 're-enter reuses the root, it does not add a second')

  try {
    rmSync(stateFilePath(mockNodeId(rawId)))
  } catch {
    /* ignore */
  }
})

test('enter: a re-enter with no --title preserves the recorded title and sends no --title', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter(undefined, 'prd', 'Epic title')
  runEnter(undefined, 'implementation')

  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 2, 'both calls reached the board')
  assert.ok(!calls[1]!.includes('--title'), 'no --title sent on the title-less re-enter')

  const node = registryRoot(loadRegistry(rawId))
  assert.equal(node!.title, 'Epic title', 'registry still records the original title')

  try {
    rmSync(stateFilePath(mockNodeId(rawId)))
  } catch {
    /* ignore */
  }
})

test('enter: a re-enter with an identical --title is allowed', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter(undefined, 'prd', 'Epic title')
  assert.doesNotThrow(
    () => runEnter(undefined, 'implementation', 'Epic title'),
    'an identical title is not a rename'
  )

  try {
    rmSync(stateFilePath(mockNodeId(rawId)))
  } catch {
    /* ignore */
  }
})

test('enter: --retitle without --title throws', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  assert.throws(
    () => runEnter(undefined, 'implementation', undefined, undefined, undefined, true),
    /--retitle requires --title/
  )
})

test('enter: a keyed child under any parent is allowed — nesting is guidance, not a CLI rule (FLOW-205)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  runEnter(undefined, 'change', 'Ticket root')
  assert.doesNotThrow(
    () => runEnter('FLOW-1', 'implementation'),
    'the CLI no longer adjudicates nesting — this exact shape was the FLOW-180 refusal'
  )

  try {
    rmSync(stateFilePath(mockNodeId(rawId)))
  } catch {
    /* ignore */
  }
  try {
    rmSync(stateFilePath(mockNodeId(`${rawId}:FLOW-1`)))
  } catch {
    /* ignore */
  }
})

test('enter: the guard fails open on a pre-FLOW-180 registry', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  const nodeId = mockNodeId(rawId)
  const regPath = registryFilePath(rawId)
  mkdirSync(dirname(regPath), { recursive: true })
  writeFileSync(
    regPath,
    JSON.stringify({
      nodes: [{ internalId: nodeId, externalId: rawId, key: null, parentId: null }],
    })
  )

  assert.doesNotThrow(
    () => runEnter(undefined, 'implementation', 'a different title'),
    'the rename guard fails open on a pre-FLOW-180 node with no recorded title'
  )

  try {
    rmSync(stateFilePath(nodeId))
  } catch {
    /* ignore */
  }
})

test('enter: a refused enter does not write the workflow marker', () => {
  const nodeId = mockNodeId(rawId)
  const regPath = registryFilePath(rawId)
  mkdirSync(dirname(regPath), { recursive: true })
  writeFileSync(
    regPath,
    JSON.stringify({
      nodes: [
        { internalId: nodeId, externalId: rawId, key: null, parentId: null, title: 'Epic title' },
      ],
    })
  )

  assert.throws(() => runEnter(undefined, 'implementation', 'some bug'), /refusing to rename/)

  assert.equal(
    existsSync(workflowStateFilePath(rawId)),
    false,
    'a refused enter must not grant edit rights via a marker write, extending FLOW-147'
  )
})

// ---------------------------------------------------------------------------
// FLOW-190: the root external id is minted per top-level board session, not the raw session id
// ---------------------------------------------------------------------------

test('a keyless enter after leaving the root starts a NEW board session', () => {
  const rawId = 'raw-flow-190'
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0)

  runEnter(undefined, 'planning', 'First unit of work')
  const first = registryRoot(loadRegistry(rawId))
  assert.ok(first !== undefined, 'first enter records a root')

  runLeave(undefined, true)
  assert.equal(registryRoot(loadRegistry(rawId)), undefined, 'leave --root clears the root')

  runEnter(undefined, 'planning', 'Second unit of work')
  const second = registryRoot(loadRegistry(rawId))
  assert.ok(second !== undefined, 'second enter records a root')

  assert.notEqual(
    second.externalId,
    first.externalId,
    'the second top-level board session gets its own external id'
  )
  assert.ok(
    second.externalId.startsWith(`${rawId}_`),
    'minted root is namespaced by the raw session id'
  )
  assert.ok(!second.externalId.includes(':'), 'a root carries no key suffix')
})

test('a keyless re-enter with a live root reuses it rather than minting a new one', () => {
  const rawId = 'raw-flow-190-reuse'
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0)

  runEnter(undefined, 'planning', 'Unit of work')
  const first = registryRoot(loadRegistry(rawId))
  runEnter(undefined, 'implementation')
  const second = registryRoot(loadRegistry(rawId))

  assert.equal(second?.externalId, first?.externalId, 'phase re-enter keeps the same board node')
  // The assertion above is NOT sufficient on its own, and must not be trusted alone: `registryRoot`
  // is `find` (first match) while `upsertRegistryNode` APPENDS, so a broken reuse rule that minted a
  // second root would leave [N1, N2] and `registryRoot` would still return N1 — green in both
  // worlds. These two assert on things a second root actually changes.
  assert.equal(
    loadRegistry(rawId).length,
    1,
    'a re-enter reuses the root, it does not add a second'
  )
  const externalIds = new Set(
    readCalls(tmpDir)
      .map((c) => /--external-id (\S+)/.exec(c)?.[1])
      .filter((v): v is string => v !== undefined)
  )
  assert.equal(externalIds.size, 1, 'both enters registered the SAME external id')
})

test('a legacy root recorded as the raw session id is reused unchanged', () => {
  const rawId = 'raw-flow-190-legacy'
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0)
  upsertRegistryNode(rawId, {
    internalId: 'legacy-node',
    externalId: rawId,
    key: null,
    parentId: null,
  })

  runEnter(undefined, 'implementation')

  const calls = readCalls(tmpDir)
  assert.ok(
    calls.some(
      (c) => c.includes(`--external-id ${rawId} `) || c.endsWith(`--external-id ${rawId}`)
    ),
    're-registers the legacy root under its existing external id'
  )
})

test('enter refuses to record a node the board reports as closed', () => {
  const rawId = 'raw-flow-190-closed'
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  process.env.AI_WORKFLOW_APP_BIN = writeClosedLifecycleStub(tmpDir)

  const stderr = captureStderr(() => {
    runEnter(undefined, 'planning', 'Doomed')
  })

  assert.ok(stderr.includes('is closed, not active'), 'says why it refused')
  assert.equal(loadRegistry(rawId).length, 0, 'records nothing in the registry')
  // A refusal that printed and exited 0 would still pass a test that only checks stderr — the
  // exit code is the actual machine-readable signal callers act on.
  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
})

// A register response missing `id` would otherwise reach hashId(undefined) uncaught, surfacing a
// raw Node TypeError instead of a dashboard:-prefixed refusal.
test('enter refuses cleanly when the register response is missing id, instead of crashing downstream', () => {
  const rawId = 'raw-flow-250-missing-id'
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  process.env.AI_WORKFLOW_APP_BIN = writeMissingIdStub(tmpDir)

  const stderr = captureStderr(() => {
    runEnter(undefined, 'implementation')
  })

  assert.ok(
    stderr.includes('dashboard: could not parse session register output'),
    'says why it refused'
  )
  assert.equal(loadRegistry(rawId).length, 0, 'records nothing in the registry')
  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
})

// parseRegisterOutput's bare JSON.parse would otherwise throw a raw stack on genuinely malformed
// output instead of routing into the same clean-refusal path the missing-id case above already
// uses. The message must say "not valid JSON", never "missing id" — that would be false for
// output that never parsed at all.
test('enter refuses cleanly when the register response is not valid JSON, instead of crashing on JSON.parse', () => {
  const rawId = 'raw-flow-250-malformed-json'
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  process.env.AI_WORKFLOW_APP_BIN = writeMalformedJsonStub(tmpDir)

  const stderr = captureStderr(() => {
    runEnter(undefined, 'implementation')
  })

  assert.ok(
    stderr.includes('dashboard: could not parse session register output — not valid JSON'),
    'says why it refused, distinctly from the missing-id case'
  )
  assert.ok(
    !/^\s+at\s/m.test(stderr),
    `a usable refusal message, not a stack trace — got:\n${stderr}`
  )
  assert.equal(loadRegistry(rawId).length, 0, 'records nothing in the registry')
  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
})

test('enter refuses cleanly when the register response omits parentId, instead of trusting it as null', () => {
  const rawId = 'raw-flow-250-omitted-parentid'
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  process.env.AI_WORKFLOW_APP_BIN = writeOmittedParentIdStub(tmpDir)

  const stderr = captureStderr(() => {
    runEnter(undefined, 'implementation')
  })

  assert.ok(
    stderr.includes(
      'dashboard: could not parse session register output — parentId is not a string or null'
    ),
    'says why it refused'
  )
  assert.equal(loadRegistry(rawId).length, 0, 'records nothing in the registry')
  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
})

test('enter refuses cleanly when the register response has a numeric parentId, instead of trusting it', () => {
  const rawId = 'raw-flow-250-numeric-parentid'
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  process.env.AI_WORKFLOW_APP_BIN = writeNumericParentIdStub(tmpDir)

  const stderr = captureStderr(() => {
    runEnter(undefined, 'implementation')
  })

  assert.ok(
    stderr.includes(
      'dashboard: could not parse session register output — parentId is not a string or null'
    ),
    'says why it refused'
  )
  assert.equal(loadRegistry(rawId).length, 0, 'records nothing in the registry')
  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
})

test('a closed root already in the registry is refused, and left intact to be released', () => {
  const rawId = 'raw-flow-190-closed-known'
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  process.env.AI_WORKFLOW_APP_BIN = writeClosedLifecycleStub(tmpDir)
  const externalId = `${rawId}_ab12cd34`
  upsertRegistryNode(rawId, {
    internalId: mockNodeId(externalId),
    externalId,
    key: null,
    parentId: null,
  })

  const stderr = captureStderr(() => {
    runEnter(undefined, 'implementation')
  })

  assert.ok(stderr.includes('is closed, not active'), 'refuses')
  assert.ok(stderr.includes('leave --root'), 'advises releasing the root, which IS releasable here')
  const root = registryRoot(loadRegistry(rawId))
  assert.equal(root?.externalId, externalId, 'the stale root is left intact for `leave` to release')
  // A refusal that printed and exited 0 would still pass a test that only checks stderr here too.
  assert.equal(exitCodeIsError(), true, 'requested exit code is non-zero')
})

test('a minted root round-trips through the registry predicates', () => {
  const rawId = 'raw-flow-190-roundtrip'
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0)

  runEnter(undefined, 'planning', 'Round trip')
  // Minted by runEnter — NOT a literal. A hardcoded suffix would assert the assumption, not the code.
  const minted = registryRoot(loadRegistry(rawId))?.externalId
  assert.ok(minted !== undefined, 'a root was minted')
  // If minting regressed to `return rawId`, every assertion below still passes —
  // `isSessionExternalId(rawId, rawId)` and `isRootExternalId(rawId, rawId)` are both true
  // via the legacy arm, and `${rawId}:child` still satisfies the child checks the same way. This is
  // the one assertion in the test that a mint regression cannot pass.
  assert.notEqual(minted, rawId, 'the root actually minted, it is not the bare raw id')

  assert.ok(isSessionExternalId(minted, rawId), 'the mint output satisfies isSessionExternalId')
  assert.ok(isRootExternalId(minted, rawId), 'the mint output satisfies isRootExternalId')
  assert.ok(isSessionExternalId(`${minted}:child`, rawId), 'a keyed child of a minted root is ours')
  assert.ok(!isRootExternalId(`${minted}:child`, rawId), 'a keyed child is never a root')
})

test('the predicates anchor on the full raw session id, whatever it contains', () => {
  for (const rawId of ['a:b', 'has_underscore', 'plain']) {
    // `ab12cd34` is a PINNED 8-hex literal and must stay one — do NOT "simplify" it to derive from
    // MINTED_SUFFIX_LENGTH. It is the only assertion in the suite that is not self-referential, and
    // therefore the only one that catches a botched anti-revert restore: leave the pattern at 9
    // while `mintRootSuffix` also produces 9, and every round-trip test still passes (the code is
    // self-consistent) while every previously-minted 8-hex root has silently stopped matching.
    // This literal goes red in exactly that case.
    const minted = `${rawId}_ab12cd34`
    assert.ok(isSessionExternalId(rawId, rawId), `legacy root is ours (${rawId})`)
    assert.ok(isRootExternalId(rawId, rawId), `legacy root is a root (${rawId})`)
    assert.ok(isSessionExternalId(`${rawId}:KEY`, rawId), `legacy child is ours (${rawId})`)
    assert.ok(!isRootExternalId(`${rawId}:KEY`, rawId), `legacy child is not a root (${rawId})`)
    assert.ok(isSessionExternalId(minted, rawId), `minted root is ours (${rawId})`)
    assert.ok(isRootExternalId(minted, rawId), `minted root is a root (${rawId})`)
    assert.ok(isSessionExternalId(`${minted}:KEY`, rawId), `minted child is ours (${rawId})`)
    assert.ok(!isRootExternalId(`${minted}:KEY`, rawId), `minted child is not a root (${rawId})`)
  }
  // Neighbouring-session ids must never cross-match.
  assert.ok(!isSessionExternalId('raw-190-closed_ab12cd34', 'raw-190'), 'sibling prefix rejected')
  assert.ok(!isSessionExternalId('sess_a', 'sess'), 'short suffix rejected')
  assert.ok(!isSessionExternalId('sess_ab12cd3', 'sess'), '7-hex rejected')
  assert.ok(!isSessionExternalId('sess_ab12cd34e', 'sess'), '9-hex rejected')
  // A regression from `^[0-9a-f]{8}$` to a length-only check like `^.{8}$` would accept this — it
  // is the right LENGTH but not hex.
  assert.ok(!isSessionExternalId('sess_ZZZZZZZZ', 'sess'), 'non-hex 8-char suffix rejected')
})

test('runEnter: --parent-session nests this root under the other session’s sole leaf', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const leadRawId = `${rawId}-lead`
  upsertRegistryNode(leadRawId, {
    internalId: 'lead-root',
    externalId: `${leadRawId}_root`,
    key: null,
    parentId: null,
  })
  upsertRegistryNode(leadRawId, {
    internalId: 'lead-story',
    externalId: `${leadRawId}_root:FLOW-1`,
    key: 'FLOW-1',
    parentId: 'lead-root',
  })

  runEnter(undefined, 'permission', 'senior-r2 (teammate)', undefined, undefined, false, leadRawId)

  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'exactly one register call')
  assert.ok(
    calls[0]!.includes(`--parent-external-id ${leadRawId}_root:FLOW-1`),
    'registers under the lead’s current leaf'
  )
  const nodes = loadRegistry(rawId)
  assert.equal(nodes.length, 1, 'the lead’s node is not stubbed into this session’s registry')
  assert.equal(nodes[0]!.parentId, null, 'recorded locally as this session’s root')
  assert.equal(registryRoot(nodes)!.internalId, nodes[0]!.internalId, 'it is this session’s root')
  assert.equal(loadState(nodes[0]!.internalId)!.parentId, null, 'state records no local parent')
})

test('runEnter: --parent-session refuses when the other session has no live node', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  assert.throws(
    () => runEnter(undefined, 'permission', 'x', undefined, undefined, false, `${rawId}-lead`),
    /has no live board node to nest under/
  )
  assert.deepEqual(readCalls(tmpDir), [], 'nothing is registered')
  assert.deepEqual(loadRegistry(rawId), [], 'nothing is recorded')
})

test('runEnter: --parent-session refuses a --key', () => {
  assert.throws(
    () => runEnter('FLOW-1', 'permission', 'x', undefined, undefined, false, `${rawId}-lead`),
    /takes no --key or --parent-key/
  )
})

test('runEnter: --parent-session refuses its own session’s raw id (would parent the root with itself)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  upsertRegistryNode(rawId, {
    internalId: 'self-root',
    externalId: `${rawId}_root`,
    key: null,
    parentId: null,
  })

  assert.throws(
    () => runEnter(undefined, 'permission', 'x', undefined, undefined, false, rawId),
    /--parent-session names this session’s own id/
  )
  assert.deepEqual(readCalls(tmpDir), [], 'nothing is registered')
  assert.deepEqual(
    loadRegistry(rawId),
    [{ internalId: 'self-root', externalId: `${rawId}_root`, key: null, parentId: null }],
    'only the preset root remains, unchanged'
  )
})
