import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// Helpers (mirrors read.test.ts / item.test.ts)
// ---------------------------------------------------------------------------

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), 'status-test-'))

/** Write a stub binary that records its argv, echoes the given stdout, and exits with exitCode. */
const writeStub = (dir: string, exitCode: number, stdout = '', stderr = ''): string => {
  const path = join(dir, 'ai-workflow-app')
  const stderrLine = stderr ? `echo ${JSON.stringify(stderr)} >&2` : ''
  const stdoutLine = stdout ? `echo ${JSON.stringify(stdout)}` : ''
  writeFileSync(
    path,
    `#!/usr/bin/env bash\necho "$@" >> ${JSON.stringify(join(dir, 'calls.log'))}\n${stderrLine}\n${stdoutLine}\nexit ${exitCode}\n`
  )
  chmodSync(path, 0o755)
  return path
}

const readCalls = (dir: string): string[] => {
  const log = join(dir, 'calls.log')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf-8').split('\n').filter(Boolean)
}

// A `session list` row shaped like the live board response (verified 2026-07-09).
const boardRow = (opts: {
  id: string
  systemId: string
  externalId: string
  phase?: string
  lifecycle?: string
  parentId?: string | null
  openItemCount?: number
}): unknown => ({
  session: {
    id: opts.id,
    systemId: opts.systemId,
    externalId: opts.externalId,
    title: opts.externalId,
    phase: opts.phase ?? 'implementation',
    lifecycle: opts.lifecycle ?? 'active',
    parentId: opts.parentId ?? null,
  },
  status: 'ok',
  openItemCount: opts.openItemCount ?? 0,
})

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { runStatus, resolveBoardLifecycle } from './status.ts'
import { saveState, stateFilePath } from './state.ts'
import { upsertRegistryNode } from './registry.ts'
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
const stateFilesToClean: string[] = []

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
  rawId = `test-status-session-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  homeDir = mkdtempSync(join(tmpdir(), 'status-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
  resetExitCode()
  stateFilesToClean.length = 0
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

// No CLAUDE_CODE_SESSION_ID and no --session: resolveRawSessionId throws inside buildReport —
// proving the try/catch around it reuses the thrown message and sets exit 1 instead of letting
// the throw escape uncaught.
test('runStatus: no session id — refuses cleanly instead of throwing', () => {
  delete process.env.CLAUDE_CODE_SESSION_ID

  let stderrOut = ''
  let stdoutOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => {
      stdoutOut = captureStdout(() => runStatus(true))
    })
  })

  assert.ok(
    stderrOut.includes('No session id: pass --session or set CLAUDE_CODE_SESSION_ID'),
    'stderr carries resolveRawSessionId’s own message'
  )
  assert.equal(stdoutOut, '', 'a refusal must not print a report onto stdout')
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
})

test('runStatus: dashboard unavailable — reports local state, boardNodes empty, exit stays 0', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  upsertRegistryNode(rawId, {
    internalId: 'some-node-id',
    externalId: rawId,
    key: null,
    parentId: null,
  })

  const stdoutOut = captureStdout(() => runStatus(true))
  const report = JSON.parse(stdoutOut) as {
    rawSessionId: string
    dashboardAvailable: boolean
    localActiveSessionId: string | null
    boardNodes: unknown[]
  }

  assert.equal(report.rawSessionId, rawId, 'carries the raw session id')
  assert.equal(report.dashboardAvailable, false, 'reports unavailable')
  assert.equal(report.localActiveSessionId, 'some-node-id', 'carries the pointer')
  assert.deepEqual(report.boardNodes, [], 'no board nodes when unavailable')
  assert.equal(exitCodeIsError(), false, 'no error exit code')
})

// The text formatter must not render `board nodes: (none)` for both "checked the board, it had
// nothing" and "never checked the board" — the same defect class fixed for resolveSessionTarget's
// messages, one channel over (stdout formatting, not stderr).
test('runStatus: dashboard unavailable, text format — board nodes says "not checked", not "(none)"', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')

  const stdoutOut = captureStdout(() => runStatus(false))

  assert.ok(
    stdoutOut.includes('board nodes:\n  (unknown — dashboard unavailable, not checked)'),
    'never-checked must not render as the same "(none)" a genuine empty board gets'
  )
  assert.ok(
    !stdoutOut.includes('board nodes:\n  (none)'),
    'the checked-and-empty rendering must not appear on the never-checked path'
  )
})

// Positive control for the test above: a board that WAS reached and genuinely has nothing still
// renders "(none)", not the unavailable wording — proving the two paths remain distinguishable in
// both directions, not just that the unavailable path changed.
test('runStatus: dashboard available, empty board, text format — board nodes says "(none)"', () => {
  const stubBin = writeStub(tmpDir, 0, '[]')
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  const stdoutOut = captureStdout(() => runStatus(false))

  assert.ok(
    stdoutOut.includes('board nodes:\n  (none)'),
    'a genuinely empty, actually-checked board still reports "(none)"'
  )
  assert.ok(
    !stdoutOut.includes('not checked'),
    'a checked board must not carry the unavailable wording'
  )
})

test('runStatus: board filtering — only our root and our keyed child appear', () => {
  const rows = [
    boardRow({ id: 'root-id', systemId: 'claude-workflow', externalId: rawId }),
    boardRow({ id: 'child-id', systemId: 'claude-workflow', externalId: `${rawId}:FLOW-1` }),
    boardRow({
      id: 'other-system-id',
      systemId: 'some-other-system',
      externalId: `${rawId}:FLOW-2`,
    }),
    boardRow({
      id: 'other-session-id',
      systemId: 'claude-workflow',
      externalId: 'other-raw-session',
    }),
    boardRow({ id: 'lookalike-id', systemId: 'claude-workflow', externalId: `${rawId}-extra` }),
    // FLOW-190: a minted root and its keyed child must pass the filter too — this is the shape
    // parseBoardNodes' isSessionExternalId call exists for, and it had zero coverage with a minted
    // fixture until now (every other row above predates the minting change).
    boardRow({
      id: 'minted-root-id',
      systemId: 'claude-workflow',
      externalId: `${rawId}_a1b2c3d4`,
    }),
    boardRow({
      id: 'minted-child-id',
      systemId: 'claude-workflow',
      externalId: `${rawId}_a1b2c3d4:FLOW-3`,
    }),
    // A minted-SHAPED lookalike (right delimiter, wrong suffix — not hex) must still be excluded,
    // proving the suffix-shape check runs, not just a bare `${rawId}_` prefix test.
    boardRow({
      id: 'minted-lookalike-id',
      systemId: 'claude-workflow',
      externalId: `${rawId}_ZZZZZZZZ`,
    }),
  ]
  const stubBin = writeStub(tmpDir, 0, JSON.stringify(rows))
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  const stdoutOut = captureStdout(() => runStatus(true))
  const report = JSON.parse(stdoutOut) as { boardNodes: Array<{ id: string }> }

  const ids = report.boardNodes.map((n) => n.id).sort()
  assert.deepEqual(
    ids,
    ['child-id', 'minted-child-id', 'minted-root-id', 'root-id'],
    'our legacy root/child AND our minted root/child pass the filter; the minted-shaped lookalike does not'
  )
})

test('runStatus: dangling registry entry — a registry node absent from the board but with cached state', () => {
  const rows = [boardRow({ id: 'root-id', systemId: 'claude-workflow', externalId: rawId })]
  const stubBin = writeStub(tmpDir, 0, JSON.stringify(rows))
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  const danglingId = 'dangling-node-id'
  upsertRegistryNode(rawId, {
    internalId: danglingId,
    externalId: `${rawId}:dangling`,
    key: 'dangling',
    parentId: null,
  })
  saveState(danglingId, {
    registered: true,
    phase: 'implementation',
    openItemIds: [],
    parentId: null,
  })
  stateFilesToClean.push(danglingId)

  const stdoutOut = captureStdout(() => runStatus(true))
  const report = JSON.parse(stdoutOut) as {
    localNodes: Array<{ sessionId: string }>
    boardNodes: Array<{ id: string }>
  }

  assert.ok(
    report.localNodes.some((n) => n.sessionId === danglingId),
    'dangling registry entry still surfaces in localNodes'
  )
  assert.ok(
    !report.boardNodes.some((n) => n.id === danglingId),
    'the dangling id is not on the board — that is the drift'
  )
})

// ---------------------------------------------------------------------------
// FLOW-173: localActiveSessionId is the sole registry leaf, not a stored pointer
// ---------------------------------------------------------------------------

test('runStatus: localActiveSessionId is null when the registry has zero nodes (nothing entered)', () => {
  const stubBin = writeStub(tmpDir, 0, '[]')
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  const stdoutOut = captureStdout(() => runStatus(true))
  const report = JSON.parse(stdoutOut) as { localActiveSessionId: string | null }

  assert.equal(report.localActiveSessionId, null, 'null when nothing has been entered')
})

test('runStatus: localActiveSessionId is the sole registry leaf when unambiguous', () => {
  const stubBin = writeStub(tmpDir, 0, '[]')
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  upsertRegistryNode(rawId, {
    internalId: 'root-node',
    externalId: rawId,
    key: null,
    parentId: null,
  })
  upsertRegistryNode(rawId, {
    internalId: 'child-node',
    externalId: `${rawId}:FLOW-1`,
    key: 'FLOW-1',
    parentId: 'root-node',
  })
  stateFilesToClean.push('root-node', 'child-node')

  const stdoutOut = captureStdout(() => runStatus(true))
  const report = JSON.parse(stdoutOut) as { localActiveSessionId: string | null }

  assert.equal(report.localActiveSessionId, 'child-node', 'the sole leaf (the deepest node)')
})

test('runStatus: localActiveSessionId is null when the registry has multiple live leaves (ambiguous)', () => {
  const stubBin = writeStub(tmpDir, 0, '[]')
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  upsertRegistryNode(rawId, {
    internalId: 'root-node',
    externalId: rawId,
    key: null,
    parentId: null,
  })
  upsertRegistryNode(rawId, {
    internalId: 'k1-node',
    externalId: `${rawId}:K1`,
    key: 'K1',
    parentId: 'root-node',
  })
  upsertRegistryNode(rawId, {
    internalId: 'k2-node',
    externalId: `${rawId}:K2`,
    key: 'K2',
    parentId: 'root-node',
  })
  stateFilesToClean.push('root-node', 'k1-node', 'k2-node')

  const stdoutOut = captureStdout(() => runStatus(true))
  const report = JSON.parse(stdoutOut) as { localActiveSessionId: string | null }

  assert.equal(report.localActiveSessionId, null, 'null on sibling ambiguity, not a guess')
})

test('runStatus: localLeafIds surfaces both ids even when neither has cached local state (localNodes alone would show nothing to recover with)', () => {
  const stubBin = writeStub(tmpDir, 0, '[]')
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  // Registry-only nodes — never saveState-d (mirrors enter.ts's implicit-root stub, or any leaf
  // that was entered but never had an item posted to it). loadState(...) returns null for both.
  upsertRegistryNode(rawId, {
    internalId: 'root-node',
    externalId: rawId,
    key: null,
    parentId: null,
  })
  upsertRegistryNode(rawId, {
    internalId: 'k1-node',
    externalId: `${rawId}:K1`,
    key: 'K1',
    parentId: 'root-node',
  })
  upsertRegistryNode(rawId, {
    internalId: 'k2-node',
    externalId: `${rawId}:K2`,
    key: 'K2',
    parentId: 'root-node',
  })

  const stdoutOut = captureStdout(() => runStatus(true))
  const report = JSON.parse(stdoutOut) as {
    localActiveSessionId: string | null
    localLeafIds: string[]
    localNodes: Array<{ sessionId: string }>
  }

  assert.equal(report.localActiveSessionId, null, 'ambiguous — no single active leaf')
  assert.deepEqual(
    report.localLeafIds.sort(),
    ['k1-node', 'k2-node'],
    'both live leaf ids are surfaced regardless of cached state — the user has something to recover with'
  )
  assert.ok(
    !report.localNodes.some((n) => n.sessionId === 'k1-node' || n.sessionId === 'k2-node'),
    'sanity: localNodes alone really would have shown neither id (no cached state to report)'
  )
})

test('runStatus: malformed payload — stderr message, non-zero requested exit, no stdout', () => {
  const stubBin = writeStub(tmpDir, 0, 'not json')
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runStatus(true))
  })

  assert.ok(
    stderrOut.includes('could not parse session list output'),
    'stderr reports the parse failure'
  )
  assert.equal(exitCodeIsError(), true, 'non-zero exit code requested')
  assert.equal(stdoutOut, '', 'no stdout on a parse failure')
})

test('runStatus: empty stdout is a fault, not an empty board — fails closed, no silent repair-worthy report', () => {
  // Measured directly against the real ai-workflow-app (2026-07-09) — three separate
  // zero-row `session list` queries (--lifecycle ended --status hung, --lifecycle ended --status
  // waiting, --lifecycle closed --status waiting) all printed the literal `[]`, exit 0. A
  // zero-session board never produces empty stdout on a clean exit — so empty stdout here is a
  // fault. Treating it as an empty board was fail-open exactly where /restart-jobs reads "the
  // board does not have this node" and repairs (clears the pointer, forgets state) on the strength
  // of that report — a malfunction driving a mutation. Must fail closed, like every other
  // malformed shape, with its own distinct message.
  const stubBin = writeStub(tmpDir, 0, '')
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runStatus(true))
  })

  assert.ok(
    stderrOut.includes('session list returned empty output'),
    'stderr names the fault distinctly from invalid JSON or an unknown field'
  )
  assert.equal(
    exitCodeIsError(),
    true,
    'non-zero exit code requested — a fault, not an empty board'
  )
  assert.equal(
    stdoutOut,
    '',
    'no stdout on a fault — nothing for /restart-jobs to misread as "board has nothing"'
  )
})

test('runStatus: binary present but the invocation fails — stderr from invokeDashboardBin, non-zero exit, no stdout', () => {
  // With a single resolveDashboardBin() call, "available but the call itself fails" (non-zero
  // exit) must still surface loud, invoked once — the stub binary here exists (unlike the
  // "dashboard unavailable" test above), so this exercises the other branch of the single
  // resolve.
  const stubBin = writeStub(tmpDir, 1, '', 'ai-workflow-app: boom')
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runStatus(true))
  })

  assert.ok(stderrOut.includes('boom'), 'stderr surfaces the failure detail')
  assert.equal(exitCodeIsError(), true, 'non-zero exit code requested')
  assert.equal(stdoutOut, '', 'no stdout on an available-but-failing call')
})

test('runStatus: a null row (not merely a missing key) is rejected, not crashed on', () => {
  // `[null]` survives JSON.parse — a naive `(row as {session?}).session` access on a null row
  // throws "Cannot read properties of null (reading 'session')" and crashes the process (exit
  // !== 0 with no structured report) instead of hitting the documented parse-failure path.
  const stubBin = writeStub(tmpDir, 0, JSON.stringify([null]))
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    assert.doesNotThrow(() => {
      stdoutOut = captureStdout(() => runStatus(true))
    }, 'a null row must not crash runStatus')
  })

  assert.ok(
    stderrOut.includes('could not parse session list output'),
    'a null row is reported as a parse failure, not a crash'
  )
  assert.equal(exitCodeIsError(), true, 'non-zero exit code requested')
  assert.equal(stdoutOut, '', 'no stdout on a parse failure')
})

test('runStatus: a row with a null session (not merely a missing key) is rejected, not crashed on', () => {
  // `[{"session":null}]` also survives JSON.parse — `session.systemId` on a null session throws
  // "Cannot read properties of null (reading 'systemId')" the same way.
  const stubBin = writeStub(tmpDir, 0, JSON.stringify([{ session: null }]))
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    assert.doesNotThrow(() => {
      stdoutOut = captureStdout(() => runStatus(true))
    }, 'a null session must not crash runStatus')
  })

  assert.ok(
    stderrOut.includes('could not parse session list output'),
    'a null session is reported as a parse failure, not a crash'
  )
  assert.equal(exitCodeIsError(), true, 'non-zero exit code requested')
  assert.equal(stdoutOut, '', 'no stdout on a parse failure')
})

test('runStatus: a row with the session key absent (not null) is rejected the same way', () => {
  // [null] and [{session: null}] were both covered, but a row where `session` is simply absent —
  // `[{}]` — was asserted nowhere. The guard (`typeof session !== 'object' || session === null`)
  // rejects `undefined` too (typeof undefined !== 'object'), so this should hit the identical "row
  // 0: session is not an object" error as the null-session case, not fall through to reading a
  // property off undefined.
  const stubBin = writeStub(tmpDir, 0, JSON.stringify([{}]))
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    assert.doesNotThrow(() => {
      stdoutOut = captureStdout(() => runStatus(true))
    }, 'an absent session key must not crash runStatus')
  })

  assert.ok(
    stderrOut.includes('row 0: session is not an object'),
    'an absent session key is reported with the same error as a null session'
  )
  assert.equal(exitCodeIsError(), true, 'non-zero exit code requested')
  assert.equal(stdoutOut, '', 'no stdout on a parse failure')
})

test('runStatus: a row with a non-string id is rejected (identity-bearing, like externalId)', () => {
  // `String(session.id)` on a missing/non-string id silently mints the literal
  // id "undefined", which then flows into candidateIds/loadState/--forget.
  const rows = [
    { session: { systemId: 'claude-workflow', externalId: rawId, lifecycle: 'active' } },
  ]
  const stubBin = writeStub(tmpDir, 0, JSON.stringify(rows))
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runStatus(true))
  })

  assert.ok(
    stderrOut.includes('could not parse session list output'),
    'a missing id is reported as a parse failure'
  )
  assert.equal(stdoutOut, '', 'no stdout on a parse failure')
})

test('runStatus: a row with an unrecognized lifecycle value is rejected', () => {
  // lifecycle must not be typed `string` — any junk value would flow straight to the agent even
  // though /restart-jobs branches on the literal 'ended'/'closed' values.
  const rows = [
    { session: { id: 'x', systemId: 'claude-workflow', externalId: rawId, lifecycle: 'zombie' } },
  ]
  const stubBin = writeStub(tmpDir, 0, JSON.stringify(rows))
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  const stderrOut = captureStderr(() => {
    captureStdout(() => runStatus(true))
  })

  assert.ok(
    stderrOut.includes('could not parse session list output'),
    'an unrecognized lifecycle value is reported as a parse failure'
  )
})

test('runStatus: a paused row for this session parses, and its siblings survive alongside it', () => {
  // LIFECYCLE_VALUES must include 'paused' (a real DB lifecycle) — omitting it makes
  // parseBoardNodes reject the WHOLE payload the moment one of this session's own rows is paused,
  // not just that row: a paused sibling would poison every other node's visibility too.
  const rows = [
    boardRow({
      id: 'root-id',
      systemId: 'claude-workflow',
      externalId: rawId,
      lifecycle: 'active',
    }),
    boardRow({
      id: 'paused-id',
      systemId: 'claude-workflow',
      externalId: `${rawId}:FLOW-1`,
      lifecycle: 'paused',
    }),
  ]
  const stubBin = writeStub(tmpDir, 0, JSON.stringify(rows))
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  const stdoutOut = captureStdout(() => runStatus(true))
  const report = JSON.parse(stdoutOut) as {
    boardNodes: Array<{ id: string; lifecycle: string }>
  }

  const ids = report.boardNodes.map((n) => n.id).sort()
  assert.deepEqual(
    ids,
    ['paused-id', 'root-id'],
    'the paused row and its active sibling both survive'
  )
  const paused = report.boardNodes.find((n) => n.id === 'paused-id')
  assert.equal(paused?.lifecycle, 'paused', 'the paused row keeps its real lifecycle value')
})

test('runStatus: a non-numeric openItemCount degrades to 0 instead of NaN/null', () => {
  // Number(junk) is NaN, and JSON.stringify(NaN) silently emits `null`, violating
  // the declared `number` type on the wire. Not identity-bearing, so this degrades rather than
  // rejecting the whole payload.
  const rows = [
    {
      session: { id: 'x', systemId: 'claude-workflow', externalId: rawId, lifecycle: 'active' },
      openItemCount: 'not-a-number',
    },
  ]
  const stubBin = writeStub(tmpDir, 0, JSON.stringify(rows))
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  const stdoutOut = captureStdout(() => runStatus(true))
  const report = JSON.parse(stdoutOut) as { boardNodes: Array<{ openItemCount: number }> }

  assert.equal(
    report.boardNodes[0]!.openItemCount,
    0,
    'a non-numeric count degrades to 0, not NaN/null'
  )
})

// FLOW-211: openItemCounts (REV-72) parses through to the real `dashboard session status`
// integration boundary, not just through the item-add guard's fail-open path. Direct proof that
// parseItemCounts is exercised: a full, valid triple survives...
test('runStatus: a full openItemCounts triple parses through to the report', () => {
  const rows = [
    {
      session: { id: 'x', systemId: 'claude-workflow', externalId: rawId, lifecycle: 'active' },
      openItemCount: 2,
      openItemCounts: { question: 1, approval: 1, comment: 0 },
    },
  ]
  const stubBin = writeStub(tmpDir, 0, JSON.stringify(rows))
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  const stdoutOut = captureStdout(() => runStatus(true))
  const report = JSON.parse(stdoutOut) as {
    boardNodes: Array<{ openItemCounts?: { question: number; approval: number; comment: number } }>
  }

  assert.deepEqual(
    report.boardNodes[0]!.openItemCounts,
    { question: 1, approval: 1, comment: 0 },
    'the full breakdown survives parsing unchanged'
  )
})

// ...and a partial breakdown (missing a key) is reported as unknown, not as a partial count. This
// is the second mutation on parseItemCounts itself, distinct from the guard's fail-open behavior.
test('runStatus: a partial openItemCounts (missing a key) reports as absent, not a partial count', () => {
  const rows = [
    {
      session: { id: 'x', systemId: 'claude-workflow', externalId: rawId, lifecycle: 'active' },
      openItemCount: 1,
      openItemCounts: { question: 1 },
    },
  ]
  const stubBin = writeStub(tmpDir, 0, JSON.stringify(rows))
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  const stdoutOut = captureStdout(() => runStatus(true))
  const report = JSON.parse(stdoutOut) as { boardNodes: Array<{ openItemCounts?: unknown }> }

  assert.equal(
    report.boardNodes[0]!.openItemCounts,
    undefined,
    'a partial breakdown is unknown, not a partial count'
  )
})

// A negative count is exactly as malformed as a missing key — `Number.isFinite` alone would accept
// it, so this pins the `Number.isInteger(n) && n >= 0` tightening rather than just probing it.
test('runStatus: a negative openItemCounts value reports as absent, not a negative count', () => {
  const rows = [
    {
      session: { id: 'x', systemId: 'claude-workflow', externalId: rawId, lifecycle: 'active' },
      openItemCount: 1,
      openItemCounts: { question: -1, approval: 0, comment: 0 },
    },
  ]
  const stubBin = writeStub(tmpDir, 0, JSON.stringify(rows))
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  const stdoutOut = captureStdout(() => runStatus(true))
  const report = JSON.parse(stdoutOut) as { boardNodes: Array<{ openItemCounts?: unknown }> }

  assert.equal(
    report.boardNodes[0]!.openItemCounts,
    undefined,
    'a negative count fails the isCount check and reports as unknown'
  )
})

// A non-integer is exactly as malformed as a negative one — `Number.isFinite` alone would accept
// it, so this pins the `Number.isInteger(n)` conjunct specifically (the negative-count test above
// only pins `n >= 0`; dropping `Number.isInteger` turns nothing red without this one).
test('runStatus: a non-integer openItemCounts value reports as absent, not a fractional count', () => {
  const rows = [
    {
      session: { id: 'x', systemId: 'claude-workflow', externalId: rawId, lifecycle: 'active' },
      openItemCount: 1,
      openItemCounts: { question: 1.5, approval: 0, comment: 0 },
    },
  ]
  const stubBin = writeStub(tmpDir, 0, JSON.stringify(rows))
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  const stdoutOut = captureStdout(() => runStatus(true))
  const report = JSON.parse(stdoutOut) as { boardNodes: Array<{ openItemCounts?: unknown }> }

  assert.equal(
    report.boardNodes[0]!.openItemCounts,
    undefined,
    'a non-integer count fails the isCount check and reports as unknown'
  )
})

test('runStatus: candidateIds always includes the raw session id, even with no pointer and no board node', () => {
  // With an empty registry (nothing entered), resolveSessionId falls back to the
  // raw id, so item state can be written under the raw id — without including it as a candidate,
  // that local node could never be reported or --forget-ten.
  const stubBin = writeStub(tmpDir, 0, '[]')
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  saveState(rawId, {
    registered: true,
    phase: 'implementation',
    openItemIds: ['item-1'],
    parentId: null,
  })
  stateFilesToClean.push(rawId)

  const stdoutOut = captureStdout(() => runStatus(true))
  const report = JSON.parse(stdoutOut) as { localNodes: Array<{ sessionId: string }> }

  assert.ok(
    report.localNodes.some((n) => n.sessionId === rawId),
    'the raw session id is always a candidate, so its local state (if any) is always reported'
  )
})

test('runStatus: --json emits parseable JSON with exactly the documented keys', () => {
  const rows = [boardRow({ id: 'root-id', systemId: 'claude-workflow', externalId: rawId })]
  const stubBin = writeStub(tmpDir, 0, JSON.stringify(rows))
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  const stdoutOut = captureStdout(() => runStatus(true))
  const report = JSON.parse(stdoutOut) as Record<string, unknown>

  assert.deepEqual(
    Object.keys(report).sort(),
    [
      'boardNodes',
      'corruptLocalNodes',
      'dashboardAvailable',
      'localActiveSessionId',
      'localLeafIds',
      'localNodes',
      'rawSessionId',
    ].sort(),
    'report has exactly the documented keys'
  )
  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'exactly one board call')
  assert.ok(calls[0]!.includes('session list'), 'calls session list')
})

// ---------------------------------------------------------------------------
// resolveBoardLifecycle (FLOW-157)
// ---------------------------------------------------------------------------

test('resolveBoardLifecycle: bin absent → unknown', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')

  const lifecycle = resolveBoardLifecycle(rawId, 'some-session-id')

  assert.equal(lifecycle, 'unknown', 'bin absent collapses to unknown')
})

test('resolveBoardLifecycle: our node matched by id → its lifecycle', () => {
  const sessionId = 'node-uuid-1'
  const rows = [
    boardRow({
      id: sessionId,
      systemId: 'claude-workflow',
      externalId: rawId,
      lifecycle: 'active',
    }),
  ]
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, JSON.stringify(rows))

  const lifecycle = resolveBoardLifecycle(rawId, sessionId)

  assert.equal(lifecycle, 'active', 'matched by id, reports the node lifecycle')
})

test('resolveBoardLifecycle: our node matched by externalId (sessionId passed as the raw id) → its lifecycle', () => {
  const rows = [
    boardRow({
      id: 'some-other-uuid',
      systemId: 'claude-workflow',
      externalId: rawId,
      lifecycle: 'active',
    }),
  ]
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, JSON.stringify(rows))

  const lifecycle = resolveBoardLifecycle(rawId, rawId)

  assert.equal(lifecycle, 'active', 'matched by externalId when sessionId is the raw id')
})

test('resolveBoardLifecycle: our MINTED root matched by isRootExternalId (sessionId passed as the raw id) → its lifecycle', () => {
  // FLOW-190: the second arm must use `isRootExternalId(n.externalId, sessionId)` rather than
  // `n.externalId === sessionId`, so a minted root — not just the legacy bare-rawId shape the test
  // above covers — resolves here. Uncovered until now.
  const rows = [
    boardRow({
      id: 'some-other-uuid',
      systemId: 'claude-workflow',
      externalId: `${rawId}_a1b2c3d4`,
      lifecycle: 'active',
    }),
  ]
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, JSON.stringify(rows))

  const lifecycle = resolveBoardLifecycle(rawId, rawId)

  assert.equal(lifecycle, 'active', 'matched by isRootExternalId when sessionId is the raw id')
})

test('resolveBoardLifecycle: our node ended → ended', () => {
  const sessionId = 'node-uuid-ended'
  const rows = [
    boardRow({ id: sessionId, systemId: 'claude-workflow', externalId: rawId, lifecycle: 'ended' }),
  ]
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, JSON.stringify(rows))

  assert.equal(resolveBoardLifecycle(rawId, sessionId), 'ended')
})

test('resolveBoardLifecycle: our node closed → closed', () => {
  const sessionId = 'node-uuid-closed'
  const rows = [
    boardRow({
      id: sessionId,
      systemId: 'claude-workflow',
      externalId: rawId,
      lifecycle: 'closed',
    }),
  ]
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, JSON.stringify(rows))

  assert.equal(resolveBoardLifecycle(rawId, sessionId), 'closed')
})

test('resolveBoardLifecycle: session list returns no matching node → unknown', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '[]')

  assert.equal(resolveBoardLifecycle(rawId, 'some-session-id'), 'unknown')
})

test('resolveBoardLifecycle: malformed session list output → unknown, no throw', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{}')

  let lifecycle: string | undefined
  assert.doesNotThrow(() => {
    lifecycle = resolveBoardLifecycle(rawId, 'some-session-id')
  }, 'malformed output must not throw')
  assert.equal(lifecycle, 'unknown')
})

// resolveBoardLifecycle calls findBoardNodeFor with NO opts — the non-quiet default — unlike
// item.ts's approval guard, which passes `{ quiet: true }` deliberately (it reads the board before
// a mutation it then still performs, so a failed read must not poison that mutation's exit code).
// resolveBoardLifecycle has no such mutation to protect: an available-but-failing session list call
// must surface loudly here, same as invokeDashboardBin does by default. Nothing exercised this
// branch before — every other resolveBoardLifecycle test above uses a binary that succeeds (exit 0)
// even when its payload is malformed.
test('resolveBoardLifecycle: available-but-failing session list surfaces loudly (non-quiet default)', () => {
  const stubBin = writeStub(tmpDir, 1, '', 'ai-workflow-app: boom')
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  let lifecycle: string | undefined
  const stderrOut = captureStderr(() => {
    lifecycle = resolveBoardLifecycle(rawId, 'some-session-id')
  })

  assert.ok(stderrOut.includes('boom'), 'stderr surfaces the failure detail')
  assert.equal(exitCodeIsError(), true, 'non-zero exit code requested — no quiet suppression here')
  assert.equal(
    lifecycle,
    'unknown',
    'the caller still gets a usable value despite the loud failure'
  )
})

test('runStatus: constraint guard — no verdict, drift, stale, ok, recommendation, or severity key', () => {
  const rows = [boardRow({ id: 'root-id', systemId: 'claude-workflow', externalId: rawId })]
  const stubBin = writeStub(tmpDir, 0, JSON.stringify(rows))
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  const stdoutOut = captureStdout(() => runStatus(true))
  const report = JSON.parse(stdoutOut) as Record<string, unknown>

  for (const forbidden of ['drift', 'stale', 'ok', 'recommendation', 'severity']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(report, forbidden),
      false,
      `SessionStatusReport must not carry a "${forbidden}" key — judging drift is the agent's job`
    )
  }
})

// ---------------------------------------------------------------------------
// A candidate whose state file is present and cannot be turned into state — unreadable, or read
// and carrying a load-bearing field of the wrong shape, which is what the fixture below plants.
// `status` is the command the person diagnosing exactly that is running, and `loadState` returns
// null for it and for a session with no state file at all alike.
// ---------------------------------------------------------------------------

test('runStatus: a state file that is present and unreadable is reported, not dropped as absent (FLOW-226 finding 4ca1fb82219c)', () => {
  mkdirSync(dirname(stateFilePath(rawId)), { recursive: true })
  writeFileSync(stateFilePath(rawId), '{"registered": true, "openItemIds": 3}')
  stateFilesToClean.push(rawId)

  const report = JSON.parse(captureStdout(() => runStatus(true))) as {
    localNodes: Array<{ sessionId: string }>
    corruptLocalNodes: Array<{ sessionId: string; reason: string }>
  }

  assert.deepEqual(
    report.localNodes.filter((n) => n.sessionId === rawId),
    [],
    'it is not a node whose fields this process read — every one of them is unread'
  )
  assert.deepEqual(
    report.corruptLocalNodes.map((n) => n.sessionId),
    [rawId],
    'and it is not silently absent either, which is what made it indistinguishable from a session ' +
      'that never had local state'
  )
  assert.match(
    report.corruptLocalNodes[0]!.reason,
    /openItemIds/,
    'the reason names the field that could not be read, so the repair is actionable'
  )
})

test('runStatus: a session with genuinely no state file reports neither a node nor a read failure', () => {
  const report = JSON.parse(captureStdout(() => runStatus(true))) as {
    localNodes: Array<{ sessionId: string }>
    corruptLocalNodes: unknown[]
  }

  assert.deepEqual(
    report.localNodes.filter((n) => n.sessionId === rawId),
    [],
    'nothing was written for this session'
  )
  assert.deepEqual(
    report.corruptLocalNodes,
    [],
    'absent is not a fault — the control that keeps the test above from passing on any null state'
  )
})
