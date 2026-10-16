import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  loadRegistry,
  registryFilePath,
  registryLeaves,
  registryRoot,
  removeRegistryNode,
  RegistryUnreadableError,
  upsertRegistryNode,
  type RegistryNode,
} from './registry.ts'

// registryFilePath/loadRegistry resolve through the durable store, which is homedir()-relative —
// override HOME so these tests never touch the real ~/.claude/workflow-state store (mirrors
// state.test.ts).
let homeDir: string
let origHome: string | undefined
let rawId: string

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'registry-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
  rawId = `raw-${Math.floor(Math.random() * 1e9)}`
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  rmSync(homeDir, { recursive: true, force: true })
})

test('loadRegistry: empty when nothing has been written', () => {
  assert.deepEqual(loadRegistry(rawId), [])
})

// A directory at the registry file's path rather than a chmod: root bypasses permission bits, so a
// mode-000 file stays readable under a root test runner and the fixture never reaches the branch
// under test. EISDIR comes back to every uid.
const plantUnreadableRegistry = (id: string): void => {
  mkdirSync(registryFilePath(id), { recursive: true })
  assert.throws(
    () => readFileSync(registryFilePath(id), 'utf-8'),
    /EISDIR/,
    'precondition: the fixture must actually be unreadable, or these tests observe nothing'
  )
}

test('loadRegistry: throws for an unreadable registry rather than reporting it empty', () => {
  plantUnreadableRegistry(rawId)

  assert.throws(
    () => loadRegistry(rawId),
    /exists but could not be read \(EISDIR\)/,
    'an unreadable registry must not arrive at a caller as an empty one'
  )
})

// A file where the registry's own parent directory belongs, rather than at the registry path
// itself: readFileSync fails resolving that path component before the registry file is ever
// reached, so the failure is ENOTDIR — a code that says nothing about whether the registry exists.
const plantObstructedRegistryDir = (id: string): void => {
  const registryPath = registryFilePath(id)
  const obstruction = dirname(dirname(registryPath))
  mkdirSync(dirname(obstruction), { recursive: true })
  writeFileSync(obstruction, '')
  assert.throws(
    () => readFileSync(registryPath, 'utf-8'),
    /ENOTDIR/,
    'precondition: the fixture must actually block traversal, or this test observes nothing'
  )
}

test('loadRegistry: a code that does not confirm existence is not reported as "exists" (FLOW-226 finding b2d087382421)', () => {
  plantObstructedRegistryDir(rawId)

  assert.throws(
    () => loadRegistry(rawId),
    /could not be confirmed to exist or be read \(ENOTDIR\)/,
    'ENOTDIR fires resolving a path component before the registry is ever reached'
  )
})

test('loadRegistry: EISDIR gets no ownership advice, since a directory is not an ownership problem (FLOW-226 finding b2d087382421)', () => {
  plantUnreadableRegistry(rawId)

  assert.throws(
    () => loadRegistry(rawId),
    (error: unknown) => {
      assert.doesNotMatch((error as Error).message, /owner and permissions/)
      return true
    }
  )
})

test('loadRegistry: an ABSENT registry is still empty, not a throw (the two stay distinct)', () => {
  assert.deepEqual(loadRegistry(rawId), [], 'absent is the one case that legitimately reads empty')
})

test('upsertRegistryNode: refuses to write over a registry it could not read', () => {
  const existing: RegistryNode = { internalId: 'a', externalId: rawId, key: null, parentId: null }
  upsertRegistryNode(rawId, existing)
  assert.deepEqual(loadRegistry(rawId), [existing], 'precondition: a node is recorded')

  rmSync(registryFilePath(rawId))
  plantUnreadableRegistry(rawId)

  assert.throws(
    () =>
      upsertRegistryNode(rawId, { internalId: 'b', externalId: rawId, key: null, parentId: null }),
    /exists but could not be read/,
    'reading the registry as empty here would replace every recorded node with the one being added'
  )
})

test('loadRegistry: readable-but-untrustworthy content throws instead of reading as empty (FLOW-226 finding bf5657b06ac9)', () => {
  const existing: RegistryNode = { internalId: 'a', externalId: rawId, key: null, parentId: null }
  upsertRegistryNode(rawId, existing)
  assert.deepEqual(loadRegistry(rawId), [existing], 'precondition: a node is recorded')

  const parseArm = /exists but does not parse as JSON/
  const shapeArm = /parses, but its nodes field is not an array of nodes/
  const corruptions: [string, string, RegExp][] = [
    ['unparseable JSON', '{"nodes": [', parseArm],
    ['no nodes field at all', '{}', shapeArm],
    ['a nodes field that is not an array', '{"nodes": {"a": {}}}', shapeArm],
    ['an array holding something that is not a node', '{"nodes": ["a"]}', shapeArm],
    [
      'a node missing a required field',
      '{"nodes": [{"internalId": "a", "externalId": "x"}]}',
      shapeArm,
    ],
  ]
  for (const [label, content, arm] of corruptions) {
    writeFileSync(registryFilePath(rawId), content)
    assert.throws(
      () => loadRegistry(rawId),
      // The subclass relationship is the fix: every site routes on RegistryUnreadableError alone.
      // runStopGate's resolveSessionId catch falls through to `allow` when nothing matches — the
      // FLOW-157 deafness surface this ticket exists to remove, so a sibling class would go deaf
      // there silently. The others rethrow, where a sibling would surface as an uncaught throw
      // instead — loud, but still not this error's contract: stop-gate's pollTargets and
      // isSessionLive catches, check's releasedAnswers catch, and workflow-state's
      // resolveOpenItems.
      // The message arm is checked alongside it because parse and shape need different repairs.
      (error: unknown) =>
        error instanceof RegistryUnreadableError && arm.test((error as Error).message),
      `${label}: must route through the same fail-closed path an unreadable registry does`
    )
    assert.throws(
      () =>
        upsertRegistryNode(rawId, {
          internalId: 'b',
          externalId: rawId,
          key: null,
          parentId: null,
        }),
      (error: unknown) => error instanceof RegistryUnreadableError,
      `${label}: reading it as empty would replace every recorded node with the one being added`
    )
  }
})

test('loadRegistry: a pre-FLOW-205 node carrying an unread excess key is still a node', () => {
  mkdirSync(dirname(registryFilePath(rawId)), { recursive: true })
  writeFileSync(
    registryFilePath(rawId),
    '{"nodes": [{"internalId": "a", "externalId": "x", "key": null, "parentId": null, "level": 2}]}'
  )

  assert.equal(loadRegistry(rawId).length, 1, 'excess JSON keys parse fine and must stay accepted')
})

test('upsertRegistryNode: adds a node', () => {
  const node: RegistryNode = { internalId: 'a', externalId: rawId, key: null, parentId: null }
  upsertRegistryNode(rawId, node)
  assert.deepEqual(loadRegistry(rawId), [node])
})

test('upsertRegistryNode: same internalId replaces, not duplicates', () => {
  upsertRegistryNode(rawId, { internalId: 'a', externalId: rawId, key: null, parentId: null })
  upsertRegistryNode(rawId, {
    internalId: 'a',
    externalId: rawId,
    key: 'FLOW-173',
    parentId: null,
  })
  const nodes = loadRegistry(rawId)
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].key, 'FLOW-173')
})

test('removeRegistryNode: removes only the named node', () => {
  upsertRegistryNode(rawId, { internalId: 'a', externalId: rawId, key: null, parentId: null })
  upsertRegistryNode(rawId, {
    internalId: 'b',
    externalId: `${rawId}:FLOW-173`,
    key: 'FLOW-173',
    parentId: 'a',
  })
  removeRegistryNode(rawId, 'a')
  const nodes = loadRegistry(rawId)
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].internalId, 'b')
})

test('removeRegistryNode: missing internalId is a no-op', () => {
  upsertRegistryNode(rawId, { internalId: 'a', externalId: rawId, key: null, parentId: null })
  removeRegistryNode(rawId, 'does-not-exist')
  assert.equal(loadRegistry(rawId).length, 1)
})

test('registryLeaves: a single node is its own leaf', () => {
  const nodes: RegistryNode[] = [{ internalId: 'a', externalId: rawId, key: null, parentId: null }]
  assert.deepEqual(
    registryLeaves(nodes).map((n) => n.internalId),
    ['a']
  )
})

test('registryLeaves: root -> ticket -> pr chain returns only the pr (deepest node)', () => {
  const nodes: RegistryNode[] = [
    { internalId: 'root', externalId: rawId, key: null, parentId: null },
    { internalId: 'ticket', externalId: `${rawId}:FLOW-173`, key: 'FLOW-173', parentId: 'root' },
    { internalId: 'pr', externalId: `${rawId}:FLOW-173:pr`, key: 'pr', parentId: 'ticket' },
  ]
  assert.deepEqual(
    registryLeaves(nodes).map((n) => n.internalId),
    ['pr']
  )
})

test('registryLeaves: root + two sibling children returns both children', () => {
  const nodes: RegistryNode[] = [
    { internalId: 'root', externalId: rawId, key: null, parentId: null },
    { internalId: 'k1', externalId: `${rawId}:K1`, key: 'K1', parentId: 'root' },
    { internalId: 'k2', externalId: `${rawId}:K2`, key: 'K2', parentId: 'root' },
  ]
  assert.deepEqual(
    registryLeaves(nodes)
      .map((n) => n.internalId)
      .sort(),
    ['k1', 'k2']
  )
})

test('registryRoot: finds the parentId===null node', () => {
  const nodes: RegistryNode[] = [
    { internalId: 'root', externalId: rawId, key: null, parentId: null },
    { internalId: 'k1', externalId: `${rawId}:K1`, key: 'K1', parentId: 'root' },
  ]
  assert.equal(registryRoot(nodes)?.internalId, 'root')
})

test('registryRoot: undefined when no node has parentId===null', () => {
  const nodes: RegistryNode[] = [
    { internalId: 'k1', externalId: `${rawId}:K1`, key: 'K1', parentId: 'root-not-in-set' },
  ]
  assert.equal(registryRoot(nodes), undefined)
})

test('registry file lands under sessions/<partition>/ and resolves from a different cwd', () => {
  upsertRegistryNode(rawId, { internalId: 'a', externalId: rawId, key: null, parentId: null })
  const path = registryFilePath(rawId)
  assert.ok(path.includes(join('sessions')))

  const elsewhere = mkdtempSync(join(tmpdir(), 'registry-test-chdir-'))
  const origCwd = process.cwd()
  try {
    process.chdir(elsewhere)
    const nodes = loadRegistry(rawId)
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0].internalId, 'a')
  } finally {
    process.chdir(origCwd)
    rmSync(elsewhere, { recursive: true, force: true })
  }
})
