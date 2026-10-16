import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolveSessionId,
  resolveSessionTarget,
  resolveRawSessionId,
  resolveLinkAddTarget,
} from './session-id.ts'
import { upsertRegistryNode } from './registry.ts'

// ---------------------------------------------------------------------------
// Helpers (mirrors status.test.ts) — stub the ai-workflow-app binary for the board-resolve path.
// ---------------------------------------------------------------------------

const writeStub = (dir: string, exitCode: number, stdout = ''): string => {
  const path = join(dir, 'ai-workflow-app')
  const stdoutLine = stdout ? `echo ${JSON.stringify(stdout)}` : ''
  writeFileSync(path, `#!/usr/bin/env bash\n${stdoutLine}\nexit ${exitCode}\n`)
  chmodSync(path, 0o755)
  return path
}

// Deletes itself the moment it runs, then exits with `exitCode` — used to prove a caller resolves
// the bin exactly once: a caller that re-resolves after invoking this would find the path gone,
// even though this exact binary is what the invocation actually ran.
const writeSelfDeletingStub = (dir: string, exitCode: number): string => {
  const path = join(dir, 'ai-workflow-app')
  writeFileSync(path, `#!/usr/bin/env bash\nrm -- "$0"\nexit ${exitCode}\n`)
  chmodSync(path, 0o755)
  return path
}

const boardRow = (opts: {
  id: string
  externalId: string
  parentId?: string | null
  lifecycle?: string
}): unknown => ({
  session: {
    id: opts.id,
    systemId: 'claude-workflow',
    externalId: opts.externalId,
    title: opts.externalId,
    phase: 'implementation',
    lifecycle: opts.lifecycle ?? 'active',
    parentId: opts.parentId ?? null,
  },
  status: 'ok',
  openItemCount: 0,
})

/** Register a root, plus one child per key in `childKeys` (internal ids child1, child2, ...). */
const seedRoot = (childKeys: string[] = []): void => {
  upsertRegistryNode(rawId, { internalId: 'root', externalId: rawId, key: null, parentId: null })
  childKeys.forEach((k, i) => {
    upsertRegistryNode(rawId, {
      internalId: `child${i + 1}`,
      externalId: `${rawId}:${k}`,
      key: k,
      parentId: 'root',
    })
  })
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmpDir: string
let origBin: string | undefined
let origSessionId: string | undefined
let rawId: string
let homeDir: string
let origHome: string | undefined

// registryFilePath resolves through the durable store, which is homedir()-relative — override
// HOME so these tests never touch the real ~/.claude/workflow-state.
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'session-id-test-'))
  origBin = process.env.AI_WORKFLOW_APP_BIN
  // A test that forgets to wire its own stub must resolve to "dashboard unavailable" (an existing,
  // handled no-op), never fall through resolveDashboardBin's PATH lookup to the REAL installed
  // ai-workflow-app and drive it against the real board database. Wired tests overwrite this.
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'no-such-ai-workflow-app')
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  rawId = `test-session-id-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  homeDir = mkdtempSync(join(tmpdir(), 'session-id-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
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
// resolveRawSessionId / tryResolveRawSessionId — unchanged, sanity only
// ---------------------------------------------------------------------------

test('resolveRawSessionId: throws when no id available', () => {
  delete process.env.CLAUDE_CODE_SESSION_ID
  assert.throws(() => resolveRawSessionId())
})

// ---------------------------------------------------------------------------
// Single node
// ---------------------------------------------------------------------------

test('resolveSessionId/resolveSessionTarget: single node registered → both return it', () => {
  upsertRegistryNode(rawId, { internalId: 'node-a', externalId: rawId, key: null, parentId: null })
  assert.equal(resolveSessionId(), 'node-a')
  assert.equal(resolveSessionTarget(), 'node-a')
})

// ---------------------------------------------------------------------------
// Epic -> story chain
// ---------------------------------------------------------------------------

test('resolveSessionId/resolveSessionTarget: epic->story chain → both resolve to the story (sole leaf)', () => {
  upsertRegistryNode(rawId, { internalId: 'epic', externalId: rawId, key: null, parentId: null })
  upsertRegistryNode(rawId, {
    internalId: 'story',
    externalId: `${rawId}:FLOW-173`,
    key: 'FLOW-173',
    parentId: 'epic',
  })
  assert.equal(resolveSessionId(), 'story')
  assert.equal(resolveSessionTarget(), 'story')
})

// ---------------------------------------------------------------------------
// Sibling ambiguity
// ---------------------------------------------------------------------------

test('resolveSessionId: sibling leaves → returns the root', () => {
  upsertRegistryNode(rawId, { internalId: 'root', externalId: rawId, key: null, parentId: null })
  upsertRegistryNode(rawId, {
    internalId: 'k1',
    externalId: `${rawId}:K1`,
    key: 'K1',
    parentId: 'root',
  })
  upsertRegistryNode(rawId, {
    internalId: 'k2',
    externalId: `${rawId}:K2`,
    key: 'K2',
    parentId: 'root',
  })
  assert.equal(resolveSessionId(), 'root')
})

test('resolveSessionTarget: sibling leaves with no --key → throws listing the leaf keys', () => {
  upsertRegistryNode(rawId, { internalId: 'root', externalId: rawId, key: null, parentId: null })
  upsertRegistryNode(rawId, {
    internalId: 'k1',
    externalId: `${rawId}:K1`,
    key: 'K1',
    parentId: 'root',
  })
  upsertRegistryNode(rawId, {
    internalId: 'k2',
    externalId: `${rawId}:K2`,
    key: 'K2',
    parentId: 'root',
  })
  assert.throws(
    () => resolveSessionTarget(),
    (err: Error) => {
      assert.match(err.message, /K1/)
      assert.match(err.message, /K2/)
      return true
    }
  )
})

test('resolveSessionTarget: --key targets the named sibling', () => {
  upsertRegistryNode(rawId, { internalId: 'root', externalId: rawId, key: null, parentId: null })
  upsertRegistryNode(rawId, {
    internalId: 'k1',
    externalId: `${rawId}:K1`,
    key: 'K1',
    parentId: 'root',
  })
  upsertRegistryNode(rawId, {
    internalId: 'k2',
    externalId: `${rawId}:K2`,
    key: 'K2',
    parentId: 'root',
  })
  assert.equal(resolveSessionTarget(undefined, 'K1'), 'k1')
  assert.equal(resolveSessionTarget(undefined, 'K2'), 'k2')
})

test('resolveSessionTarget: --key naming an absent node throws', () => {
  upsertRegistryNode(rawId, { internalId: 'root', externalId: rawId, key: null, parentId: null })
  assert.throws(() => resolveSessionTarget(undefined, 'NOPE'), /NOPE/)
})

test('resolveSessionTarget: --key not-found message lists real keys only, never the root', () => {
  upsertRegistryNode(rawId, { internalId: 'root', externalId: rawId, key: null, parentId: null })
  upsertRegistryNode(rawId, {
    internalId: 'k1',
    externalId: `${rawId}:K1`,
    key: 'K1',
    parentId: 'root',
  })
  // n.key === key (a string) can never match the root's key: null, so the root is not in the
  // lookup's own search space and must not appear as a false remedy.
  assert.throws(
    () => resolveSessionTarget(undefined, 'NOPE'),
    (err: Error) => {
      assert.match(err.message, /K1/)
      assert.doesNotMatch(err.message, /<root>/)
      return true
    }
  )
})

// ---------------------------------------------------------------------------
// Explicit internal id: an explicit id must be VERIFIED (a node in this session's own registry,
// or a live board node for this session) before it is trusted. A typo, a stale id, or another
// session's internal id is never passed through unverified.
// ---------------------------------------------------------------------------

test('resolveSessionId/resolveSessionTarget: explicit id verified in the local registry is returned verbatim', () => {
  const uuid = '11111111-2222-3333-4444-555555555555'
  upsertRegistryNode(rawId, { internalId: uuid, externalId: rawId, key: null, parentId: null })
  assert.equal(resolveSessionId(uuid), uuid)
  assert.equal(resolveSessionTarget(uuid), uuid)
})

test('resolveSessionTarget: an unverified explicit id (not in the registry or board) throws rather than leaking through', () => {
  const uuid = '11111111-2222-3333-4444-555555555555'
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  assert.throws(() => resolveSessionTarget(uuid), /not a live node/)
})

test('resolveSessionId: an unverified explicit id falls back to normal leaf-based resolution, not returned verbatim', () => {
  const uuid = '11111111-2222-3333-4444-555555555555'
  upsertRegistryNode(rawId, { internalId: 'node-a', externalId: rawId, key: null, parentId: null })
  assert.equal(
    resolveSessionId(uuid),
    'node-a',
    'the unverified uuid is ignored; the sole leaf resolves instead'
  )
})

test('resolveSessionTarget: an explicit value that is ANOTHER raw session id (a whole different session, not a node of this one) throws, never leaking through to the backend', () => {
  const otherRawId = `other-raw-session-${rawId}`
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  assert.throws(() => resolveSessionTarget(otherRawId), /not a live node/)
})

test('resolveSessionTarget: an explicit internal id verified via the BOARD (not yet in the local registry) is returned verbatim', () => {
  const boardOnlyId = 'board-only-node-id'
  writeStub(
    tmpDir,
    0,
    JSON.stringify([boardRow({ id: boardOnlyId, externalId: `${rawId}:FLOW-1` })])
  )
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'ai-workflow-app')
  assert.equal(resolveSessionTarget(boardOnlyId), boardOnlyId)
})

test('resolveSessionTarget: an explicit internal id present on the board but ENDED is not verified — throws', () => {
  const endedId = 'ended-node-id'
  const path = join(tmpDir, 'ai-workflow-app')
  writeFileSync(
    path,
    `#!/usr/bin/env bash\necho ${JSON.stringify(
      JSON.stringify([
        {
          session: {
            id: endedId,
            systemId: 'claude-workflow',
            externalId: `${rawId}:FLOW-1`,
            title: 'x',
            phase: 'implementation',
            lifecycle: 'ended',
            parentId: null,
          },
          status: 'ok',
          openItemCount: 0,
        },
      ])
    )}\nexit 0\n`
  )
  chmodSync(path, 0o755)
  process.env.AI_WORKFLOW_APP_BIN = path
  assert.throws(() => resolveSessionTarget(endedId), /not a live node/)
})

test('resolveSessionId/resolveSessionTarget: explicit rawId itself is NOT treated as internal', () => {
  // No registry entries — an explicit id equal to the raw session id falls through to registry
  // resolution (empty → board-resolve → raw id fallback for resolveSessionId; throw for target).
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  assert.equal(resolveSessionId(rawId), rawId)
  assert.throws(() => resolveSessionTarget(rawId))
})

test('resolveSessionTarget: an explicit MINTED root external id is NOT treated as internal either', () => {
  // FLOW-190: looksExternal must recognize a minted root's external id — not just the legacy bare
  // rawId the test above covers — via isSessionExternalId(explicit, rawId) rather than a narrower
  // two-arm check, which would misread the minted shape as an internal id; in resolveSessionTarget
  // that means throwing "not a live node" instead of falling through correctly. Uncovered until
  // now.
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  const mintedRootId = `${rawId}_a1b2c3d4`
  assert.throws(
    () => resolveSessionTarget(mintedRootId),
    /no active board session for this Claude session/,
    'falls through to the empty-registry/no-board path, the SAME failure a bare rawId hits — not "not a live node", which is what treating it as an internal id would throw'
  )
})

// ---------------------------------------------------------------------------
// Empty registry: resolveSessionTarget board-resolves; resolveSessionId does NOT (it returns the
// raw id straight away — a live session always has a non-empty registry, so an empty registry
// means "nothing entered yet", not "pointer lost", and resolveSessionId's hot/background callers
// (read, stop-gate, mailbox check) must not pay a subprocess round-trip for that common case).
// ---------------------------------------------------------------------------

test('resolveSessionTarget: empty registry + board has our root → resolves it', () => {
  writeStub(tmpDir, 0, JSON.stringify([boardRow({ id: 'board-root-id', externalId: rawId })]))
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'ai-workflow-app')
  assert.equal(resolveSessionTarget(), 'board-root-id')
})

test('resolveSessionId: empty registry, even with a board root available → returns the raw id (never touches the board)', () => {
  writeStub(tmpDir, 0, JSON.stringify([boardRow({ id: 'board-root-id', externalId: rawId })]))
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'ai-workflow-app')
  assert.equal(resolveSessionId(), rawId)
})

test('resolveSessionId: empty registry + no board → returns the raw id', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  assert.equal(resolveSessionId(), rawId)
})

test('resolveSessionTarget: empty registry + no board → throws', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  assert.throws(() => resolveSessionTarget())
})

// Regression for FLOW-250: when the binary itself cannot be found at all,
// the thrown message must say so and name `session enter`'s own availability-gate return as a
// possible cause — not the generic "run session enter first" text, which reads as though nothing
// was ever entered when the more likely story for this specific cause is that it was, and the app
// was unreachable throughout.
test('resolveSessionTarget: empty registry + binary entirely absent → message distinguishes the cause from the generic "nothing entered" one', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  assert.throws(
    () => resolveSessionTarget(),
    /not reachable to check the board for one/,
    'the absent-binary cause gets its own message, distinct from the generic "run session enter first" one'
  )
})

// Regression for FLOW-250: the keyless zero-leaf/unreachable-bin message must not end with "or
// pass --key <key> if you already know the target" — unactionable, since a
// zero-leaf registry is necessarily an EMPTY registry (registryLeaves is empty only when there are
// no nodes to begin with, barring a parent cycle) and --key resolves only against that same local
// registry, never the board.
test('resolveSessionTarget: empty registry + no board → message does not offer the unactionable --key remedy', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  assert.throws(
    () => resolveSessionTarget(),
    (err: Error) => {
      // A positive assertion alongside the absence: deleting this whole branch (or its message)
      // would also make --key vanish from the thrown text, so absence alone cannot tell "the --key
      // clause was dropped" apart from "the branch was dropped". Pinning the content that only this
      // arm produces closes that gap.
      assert.match(
        err.message,
        /not reachable to check the board for one/,
        'this is still the bin-unreachable arm, not some other branch that also happens to omit --key'
      )
      assert.match(
        err.message,
        /Make ai-workflow-app reachable, then run `dashboard session enter`/,
        'the remedy names the one concrete next step, not a bare "try again"'
      )
      assert.doesNotMatch(
        err.message,
        /--key/,
        '--key can never resolve here: the registry that makes this branch unactionable for it is the same one --key would search'
      )
      return true
    }
  )
})

// Regression for FLOW-250: an explicit --session id absent from the local registry distinguishes
// "checked the board" from "board unreachable" the same way the keyless path already does —
// isLiveBoardNode threads the resolver's own single bin resolution through to fetchBoardNodes
// instead of re-resolving internally, so the message cannot claim a board check that never
// happened.
test('resolveSessionTarget: explicit id absent from registry, bin unreachable → message does not claim the board was checked', () => {
  const uuid = '11111111-2222-3333-4444-555555555555'
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  assert.throws(
    () => resolveSessionTarget(uuid),
    (err: Error) => {
      assert.doesNotMatch(
        err.message,
        /checked the local registry and the board/,
        'ai-workflow-app was never reachable, so the board was never actually checked'
      )
      assert.match(err.message, /not a live node/)
      assert.match(err.message, /not reachable to check the board/)
      return true
    }
  )
})

// Same single-resolve race as the pre-existing keyless test below, for the explicit-id path: bin
// must be resolved once and that answer reused for isLiveBoardNode AND the message decision — a
// caller that re-resolves after isLiveBoardNode's own invocation would find this exact binary gone
// (it deletes itself on run) and wrongly claim the board was never reachable.
test('resolveSessionTarget: explicit id — bin present at board-check time but gone by the time the message is chosen → reuses the one resolve, not a second one', () => {
  const uuid = '11111111-2222-3333-4444-555555555555'
  const stubPath = writeSelfDeletingStub(tmpDir, 1)
  process.env.AI_WORKFLOW_APP_BIN = stubPath
  assert.throws(
    () => resolveSessionTarget(uuid),
    (err: Error) => {
      assert.doesNotMatch(
        err.message,
        /not reachable to check the board/,
        'a board attempt was actually made through this exact binary — the message must not claim it was never reachable'
      )
      assert.match(
        err.message,
        /checked the local registry and the board/,
        'falls through to the "checked ... board" message instead, since a check genuinely happened'
      )
      return true
    }
  )
})

test('resolveSessionTarget: explicit id absent from registry AND board, bin reachable → message says both were checked', () => {
  const uuid = '11111111-2222-3333-4444-555555555555'
  writeStub(tmpDir, 0, JSON.stringify([]))
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'ai-workflow-app')
  assert.throws(
    () => resolveSessionTarget(uuid),
    /not a live node for this session \(checked the local registry and the board\)/,
    'the binary genuinely answered, so the "checked ... the board" claim is now true'
  )
})

// Regression for FLOW-250: the bin must be resolved exactly once and
// that single answer reused for both the board attempt and the message — not re-resolved after,
// which can disagree with what the attempt actually used if the binary's availability changes in
// between (a real difference, not hypothetical: the board attempt below runs the resolved binary,
// and that exact invocation is what makes it vanish before a second resolve could see it).
test('resolveSessionTarget: bin present at board-check time but gone by the time the message is chosen → message reflects the board attempt actually made', () => {
  const stubPath = writeSelfDeletingStub(tmpDir, 1)
  process.env.AI_WORKFLOW_APP_BIN = stubPath
  assert.throws(
    () => resolveSessionTarget(),
    (err: Error) => {
      assert.doesNotMatch(
        err.message,
        /not reachable to check the board for one/,
        'a board attempt was actually made through this exact binary — the message must not claim it was never reachable'
      )
      assert.match(
        err.message,
        /run `dashboard session enter` first/,
        'falls through to the generic message instead, since a check genuinely happened'
      )
      return true
    }
  )
})

// ---------------------------------------------------------------------------
// resolveViaBoard's root match must be genuinely active — an ended/closed root must not be
// silently resolved as if it were still live.
// ---------------------------------------------------------------------------

test('resolveSessionTarget: empty registry + board has our root but it is ENDED → not resolved, throws', () => {
  writeStub(
    tmpDir,
    0,
    JSON.stringify([boardRow({ id: 'board-root-id', externalId: rawId, lifecycle: 'ended' })])
  )
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'ai-workflow-app')
  assert.throws(() => resolveSessionTarget())
})

// ---------------------------------------------------------------------------
// resolveLinkAddTarget (FLOW-209) — `session enter` keyless targets the root (enter.ts,
// `key ? ... : rootExternalId`); plain resolveSessionTarget keyless targets the sole LEAF instead.
// This resolver closes that asymmetry for `link add`: keyless is refused once the root has
// children, and --root is the explicit way to name a root whose key is always null. (A `--leaf`
// flag existed briefly but was removed — traced to source, its two intended callers both always
// target the root; see FLOW-209.)
// ---------------------------------------------------------------------------

test('resolveLinkAddTarget: root with no children, keyless → resolves to the root (unchanged single-node behavior)', () => {
  seedRoot()
  assert.equal(resolveLinkAddTarget(), 'root')
})

test('resolveLinkAddTarget: root with one child, keyless → throws (anti-regression: old code silently returned the child)', () => {
  seedRoot(['K1'])
  assert.throws(
    () => resolveLinkAddTarget(),
    (err: Error) => {
      assert.match(err.message, /--root/)
      assert.match(err.message, /K1/)
      return true
    }
  )
})

test('resolveLinkAddTarget: root with two children, keyless → throws, message lists both child keys', () => {
  seedRoot(['K1', 'K2'])
  assert.throws(
    () => resolveLinkAddTarget(),
    (err: Error) => {
      assert.match(err.message, /--root/)
      assert.match(err.message, /K1/)
      assert.match(err.message, /K2/)
      return true
    }
  )
})

test('resolveLinkAddTarget: root with children, --root → resolves to the root', () => {
  seedRoot(['K1'])
  assert.equal(resolveLinkAddTarget(undefined, undefined, true), 'root')
})

test('resolveLinkAddTarget: --key on a keyed node with children present → unchanged, resolves to that node', () => {
  seedRoot(['K1', 'K2'])
  assert.equal(resolveLinkAddTarget(undefined, 'K1'), 'child1')
})

// All three "usage error" tests below assert /mutually exclusive/, not just the flag names — the
// ambiguity-refusal message (tested above) also mentions --root and --key as part of telling the
// reader which to pass, so a bare /--root/ or /--key/ match cannot tell the two error types apart.
// "mutually exclusive" appears only in the exclusivity-check message.

test('resolveLinkAddTarget: --root and --key together → usage error', () => {
  seedRoot(['K1'])
  assert.throws(
    () => resolveLinkAddTarget(undefined, 'K1', true),
    (err: Error) => {
      assert.match(err.message, /mutually exclusive/)
      assert.match(err.message, /--root/)
      assert.match(err.message, /--key/)
      return true
    }
  )
})

test('resolveLinkAddTarget: --root and --session together → usage error', () => {
  seedRoot()
  assert.throws(
    () => resolveLinkAddTarget('some-explicit-id', undefined, true),
    (err: Error) => {
      assert.match(err.message, /mutually exclusive/)
      assert.match(err.message, /--root/)
      assert.match(err.message, /--session/)
      return true
    }
  )
})

test('resolveLinkAddTarget: --key and --session together → usage error', () => {
  seedRoot(['K1'])
  assert.throws(
    () => resolveLinkAddTarget('some-explicit-id', 'K1'),
    (err: Error) => {
      assert.match(err.message, /mutually exclusive/)
      assert.match(err.message, /--key/)
      assert.match(err.message, /--session/)
      return true
    }
  )
})

test('resolveLinkAddTarget: --root with no session id available → throws', () => {
  delete process.env.CLAUDE_CODE_SESSION_ID
  assert.throws(() => resolveLinkAddTarget(undefined, undefined, true), /No session id/)
})

test('resolveLinkAddTarget: --root with no root recorded locally (registry empty) → throws', () => {
  // Nothing registered for this rawId at all — loadRegistry returns [], registryRoot finds nothing.
  assert.throws(
    () => resolveLinkAddTarget(undefined, undefined, true),
    /no root is recorded locally/
  )
})
