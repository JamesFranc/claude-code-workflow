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
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp dir, register cleanup, return the path. */
const makeTempDir = (): string => mkdtempSync(join(tmpdir(), 'dashboard-test-'))

/** Write a stub binary that records its argv and exits with the given code. */
const writeStub = (dir: string, exitCode: number, stderr = ''): string => {
  const path = join(dir, 'ai-workflow-app')
  const stderrLine = stderr ? `echo ${JSON.stringify(stderr)} >&2` : ''
  writeFileSync(
    path,
    `#!/usr/bin/env bash\necho "$@" >> ${JSON.stringify(join(dir, 'calls.log'))}\n${stderrLine}\nexit ${exitCode}\n`
  )
  chmodSync(path, 0o755)
  return path
}

/** Read all recorded calls from the stub's log file. */
const readCalls = (dir: string): string[] => {
  const log = join(dir, 'calls.log')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf-8').split('\n').filter(Boolean)
}

// ---------------------------------------------------------------------------
// Env / module isolation helpers
// ---------------------------------------------------------------------------
// node:test runs all tests in the same process, so we must save/restore env vars and
// reset the requestedExitCode between tests. Because the modules are ESM with top-level
// state (requestedExitCode), we import them once and poke the env around them.

import { runHeartbeat, runEnd, runLinkAdd } from './lifecycle.ts'
import { loadState, stateFilePath } from './state.ts'
import { upsertRegistryNode, loadRegistry } from './registry.ts'
// Capture stderr written by invokeDashboard
const captureStderr = (fn: () => void): string => {
  const chunks: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk: string | Uint8Array) => {
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
// State helpers for exit-code tracking between tests
// ---------------------------------------------------------------------------
// runtime-exit-code.ts uses a module-level variable. We import setRequestedExitCode
// directly so we can reset it between tests.
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'

const resetExitCode = () => setRequestedExitCode(0)
// After reset, getRequestedExitCode() returns 0 not undefined, but the main entrypoint
// only applies it if !== undefined. For test purposes, 0 is "no error requested" too.
// We'll compare strictly: we accept 0 or undefined as "not set to error".
const exitCodeIsError = () => {
  const code = getRequestedExitCode()
  return code !== undefined && code !== 0
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDir: string
let origBin: string | undefined
let origSessionId: string | undefined
let homeDir: string
let origHome: string | undefined
let origInvokeTimeout: string | undefined

// Every sink here resolves through the durable store, which is homedir()-relative — override
// HOME so these tests never touch the real ~/.claude/workflow-state.
beforeEach(() => {
  tmpDir = makeTempDir()
  origBin = process.env.AI_WORKFLOW_APP_BIN
  // A test that forgets to wire its own stub must resolve to "dashboard unavailable" (an existing,
  // handled no-op), never fall through resolveDashboardBin's PATH lookup to the REAL installed
  // ai-workflow-app and drive it against the real board database. Wired tests overwrite this.
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'no-such-ai-workflow-app')
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  // Use a per-test unique session id derived from the unique tmpDir path so that
  // state files from one test never bleed into the next.
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  process.env.CLAUDE_CODE_SESSION_ID = `test-session-${uniqueId}`
  homeDir = mkdtempSync(join(tmpdir(), 'dashboard-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
  origInvokeTimeout = process.env.DASHBOARD_INVOKE_TIMEOUT_MS
  resetExitCode()
})

afterEach(() => {
  if (origBin === undefined) {
    delete process.env.AI_WORKFLOW_APP_BIN
  } else {
    process.env.AI_WORKFLOW_APP_BIN = origBin
  }
  if (origSessionId === undefined) {
    delete process.env.CLAUDE_CODE_SESSION_ID
  } else {
    process.env.CLAUDE_CODE_SESSION_ID = origSessionId
  }
  if (origHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = origHome
  }
  if (origInvokeTimeout === undefined) {
    delete process.env.DASHBOARD_INVOKE_TIMEOUT_MS
  } else {
    process.env.DASHBOARD_INVOKE_TIMEOUT_MS = origInvokeTimeout
  }
  // Clean up temp dir
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

test('unavailable: runHeartbeat is a silent no-op', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')

  const stderrOut = captureStderr(() => {
    runHeartbeat()
  })

  assert.equal(stderrOut, '', 'no stderr when unavailable')
  assert.equal(exitCodeIsError(), false, 'exit code not set to error')
})

test('unavailable + no session id: heartbeat/end/linkAdd are silent no-ops, no throw', () => {
  // Binary unavailable AND no CLAUDE_CODE_SESSION_ID → must not throw (contract: unavailable = silent no-op)
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  delete process.env.CLAUDE_CODE_SESSION_ID

  const stderrOut = captureStderr(() => {
    assert.doesNotThrow(() => runHeartbeat(), 'runHeartbeat must not throw when unavailable')
    assert.doesNotThrow(() => runEnd(), 'runEnd must not throw when unavailable')
    assert.doesNotThrow(
      () => runLinkAdd('ticket', 'FLOW-100', 'https://example.com'),
      'runLinkAdd must not throw when unavailable'
    )
  })

  assert.equal(stderrOut, '', 'no stderr output')
  assert.equal(exitCodeIsError(), false, 'exit code not set to error')
})

// Bin reachable, no CLAUDE_CODE_SESSION_ID and no --session: resolveRawSessionId throws inside
// runHeartbeat's own fallback-target resolution — proving the try/catch around
// it reuses the thrown message and sets exit 1 instead of letting the throw escape uncaught.
test('no session id: runHeartbeat refuses cleanly instead of throwing', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0)
  delete process.env.CLAUDE_CODE_SESSION_ID

  let stderrOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => runHeartbeat())
  })

  assert.ok(
    stderrOut.includes('No session id: pass --session or set CLAUDE_CODE_SESSION_ID'),
    'stderr carries resolveRawSessionId’s own message'
  )
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
})

test('timeout: a hung binary is treated as a loud failure (non-zero exit, stderr written)', () => {
  // Stub sleeps 2s; override timeout to 100ms via env seam → spawnSync ETIMEDOUT
  const sleepStub = join(tmpDir, 'ai-workflow-app')
  writeFileSync(sleepStub, '#!/usr/bin/env bash\nsleep 2\n')
  chmodSync(sleepStub, 0o755)
  process.env.AI_WORKFLOW_APP_BIN = sleepStub
  process.env.DASHBOARD_INVOKE_TIMEOUT_MS = '100'

  const stderrOut = captureStderr(() => {
    runHeartbeat()
  })

  assert.ok(stderrOut.length > 0, 'stderr written on timeout')
  assert.ok(stderrOut.includes('failed'), 'stderr mentions failure')
  assert.equal(exitCodeIsError(), true, 'non-zero exit code requested on timeout')
})

// Heartbeat / end / link add pass expected argv
test('heartbeat passes --id to session heartbeat', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!

  runHeartbeat()

  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'one call')
  assert.ok(calls[0]!.includes('session heartbeat'), 'calls session heartbeat')
  assert.ok(calls[0]!.includes('--id'), 'includes --id flag')
  assert.ok(calls[0]!.includes(sessionId), 'includes the session id')
})

test('end passes --id to session end', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!

  runEnd()

  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'one call')
  assert.ok(calls[0]!.includes('session end'), 'calls session end')
  assert.ok(calls[0]!.includes(sessionId), 'includes the session id')
})

test('end: withdraws open items and marks session ended', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  upsertRegistryNode(sessionId, {
    internalId: sessionId,
    externalId: sessionId,
    key: null,
    parentId: null,
  })

  // Seed session state with an open item.
  mkdirSync(dirname(stateFilePath(sessionId)), { recursive: true })
  writeFileSync(
    stateFilePath(sessionId),
    JSON.stringify({ registered: true, phase: 'pr', openItemIds: ['item-1'] })
  )

  runEnd()

  const calls = readCalls(tmpDir)
  assert.ok(
    calls.some((c) => c.includes('item withdraw') && c.includes('--all') && c.includes(sessionId)),
    'withdraws all open items for the session'
  )
  assert.ok(
    calls.some((c) => c.includes('session end') && c.includes(sessionId)),
    'marks the session ended'
  )
  const state = loadState(sessionId)
  assert.deepEqual(state!.openItemIds, [], 'open items cleared after withdraw')
})

test('end: a withdraw that fails to clear the ledger holds off marking the session ended', () => {
  const stubBin = writeStub(tmpDir, 1)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  upsertRegistryNode(sessionId, {
    internalId: sessionId,
    externalId: sessionId,
    key: null,
    parentId: null,
  })

  mkdirSync(dirname(stateFilePath(sessionId)), { recursive: true })
  writeFileSync(
    stateFilePath(sessionId),
    JSON.stringify({ registered: true, phase: 'pr', openItemIds: ['item-1'] })
  )

  runEnd()

  const calls = readCalls(tmpDir)
  assert.ok(
    calls.some((c) => c.includes('item withdraw') && c.includes('--all') && c.includes(sessionId)),
    'still attempts the withdraw'
  )
  assert.ok(
    !calls.some((c) => c.includes('session end')),
    'never marks the session ended once the withdraw failed'
  )
})

test('end: a withdraw that fails to clear the ledger holds off removing the registry entry too', () => {
  const stubBin = writeStub(tmpDir, 1)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  upsertRegistryNode(sessionId, {
    internalId: sessionId,
    externalId: sessionId,
    key: null,
    parentId: null,
  })

  mkdirSync(dirname(stateFilePath(sessionId)), { recursive: true })
  writeFileSync(
    stateFilePath(sessionId),
    JSON.stringify({ registered: true, phase: 'pr', openItemIds: ['item-1'] })
  )

  runEnd()

  const nodes = loadRegistry(sessionId)
  assert.ok(
    nodes.some((n) => n.internalId === sessionId),
    'registry entry survives a failed withdraw, so a retry can still find it by internal id'
  )
})

test('end: a corrupt state file refuses rather than treating it as an empty ledger', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  upsertRegistryNode(sessionId, {
    internalId: sessionId,
    externalId: sessionId,
    key: null,
    parentId: null,
  })

  mkdirSync(dirname(stateFilePath(sessionId)), { recursive: true })
  writeFileSync(stateFilePath(sessionId), '{not json')

  const stderrOut = captureStderr(() => {
    runEnd()
  })

  assert.ok(
    stderrOut.includes('failed to parse') && stderrOut.includes('refusing to end this session'),
    'stderr explains the refusal'
  )
  assert.equal(exitCodeIsError(), true, 'exit code set to error')
  assert.ok(
    !readCalls(tmpDir).some((c) => c.includes('session end')),
    'never marks the session ended on a corrupt state file'
  )
  const nodes = loadRegistry(sessionId)
  assert.ok(
    nodes.some((n) => n.internalId === sessionId),
    'registry entry survives — corrupt state is not treated as empty'
  )
  assert.equal(
    readFileSync(stateFilePath(sessionId), 'utf8'),
    '{not json',
    'the damaged file is preserved untouched'
  )
})

test('end: a session-end call that fails outright holds off removing the registry entry', () => {
  const stubBin = writeStub(tmpDir, 1)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  upsertRegistryNode(sessionId, {
    internalId: sessionId,
    externalId: sessionId,
    key: null,
    parentId: null,
  })

  runEnd()

  const calls = readCalls(tmpDir)
  assert.ok(
    calls.some((c) => c.includes('session end') && c.includes(sessionId)),
    'still attempts session end'
  )
  const nodes = loadRegistry(sessionId)
  assert.ok(
    nodes.some((n) => n.internalId === sessionId),
    'registry entry survives a failed session-end call'
  )
})

test('link add passes --session --kind --label --url to link add', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  // runLinkAdd is a mutation verb (resolveLinkAddTarget, which falls through to
  // resolveSessionTarget in this single-root-no-children case) — it needs a live registered
  // session to resolve against, unlike the old lenient raw-id fallback.
  upsertRegistryNode(sessionId, {
    internalId: sessionId,
    externalId: sessionId,
    key: null,
    parentId: null,
  })

  runLinkAdd('ticket', 'FLOW-100', 'https://jira.example.com/FLOW-100')

  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'one call')
  assert.ok(calls[0]!.includes('link add'), 'calls link add')
  assert.ok(calls[0]!.includes('--session'), 'includes --session flag')
  assert.ok(calls[0]!.includes(sessionId), 'includes session id')
  assert.ok(calls[0]!.includes('--kind ticket'), 'includes --kind ticket')
  assert.ok(calls[0]!.includes('--label FLOW-100'), 'includes --label')
  assert.ok(calls[0]!.includes('--url'), 'includes --url flag')
})

// FLOW-209: these two call runLinkAdd directly — a handler-level check that the `root` param is
// threaded through to resolveLinkAddTarget, not a claim about the real CLI flag-parsing boundary
// (see commands/dashboard.test.ts for that). resolveLinkAddTarget still throws on the keyless
// refusal; runLinkAdd catches it and reports it via stderr + exit code instead of re-throwing, so
// the second test below asserts doesNotThrow, not throws.
test('link add: --root resolves to the root even when a PR-level child exists (direct call through runLinkAdd — see commands/dashboard.test.ts for real-subprocess coverage)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  // Root gets its OWN internal id, distinct from the raw session id and from the branch child's —
  // a substring check against sessionId could not tell "resolved via registryRoot" apart from a
  // coincidental fallback that happens to return the raw session id verbatim.
  upsertRegistryNode(sessionId, {
    internalId: 'root-node-id',
    externalId: sessionId,
    key: null,
    parentId: null,
  })
  upsertRegistryNode(sessionId, {
    internalId: 'branch-child',
    externalId: `${sessionId}:some-branch`,
    key: 'some-branch',
    parentId: 'root-node-id',
  })

  runLinkAdd('ticket', 'FLOW-100', 'https://jira.example.com/FLOW-100', undefined, undefined, true)

  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'one call')
  assert.equal(
    calls[0],
    'link add --session root-node-id --kind ticket --label FLOW-100 --url https://jira.example.com/FLOW-100',
    'exact argv: targets the root by its own id, not the branch child'
  )
  assert.ok(!calls[0]!.includes('branch-child'), 'never names the branch child')
})

test('link add: keyless call refuses (not throws) once the root has a child — clean stderr + exit code, not a stack trace (direct call through runLinkAdd — see commands/dashboard.test.ts for real-subprocess coverage)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  upsertRegistryNode(sessionId, {
    internalId: 'root-node-id',
    externalId: sessionId,
    key: null,
    parentId: null,
  })
  upsertRegistryNode(sessionId, {
    internalId: 'branch-child',
    externalId: `${sessionId}:some-branch`,
    key: 'some-branch',
    parentId: 'root-node-id',
  })

  const stderrOut = captureStderr(() => {
    assert.doesNotThrow(() => runLinkAdd('ticket', 'FLOW-100', 'https://jira.example.com/FLOW-100'))
  })

  assert.ok(stderrOut.includes('--root'), 'the resolver message reached stderr')
  assert.ok(stderrOut.includes('some-branch'), 'names the actual child key')
  assert.ok(
    !stderrOut.includes('resolveLinkAddTarget'),
    'no stack frame — a usable message, not a trace'
  )
  assert.equal(exitCodeIsError(), true, 'exit code set to error')
  assert.equal(readCalls(tmpDir).length, 0, 'refused before ever invoking the dashboard binary')
})

test('link add: --root --kind ticket refuses when that ticket has its own node under the root (FLOW-351)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  upsertRegistryNode(sessionId, {
    internalId: 'epic-root',
    externalId: sessionId,
    key: null,
    parentId: null,
  })
  upsertRegistryNode(sessionId, {
    internalId: 'story-node',
    externalId: `${sessionId}:FLOW-100`,
    key: 'FLOW-100',
    parentId: 'epic-root',
  })

  const stderrOut = captureStderr(() => {
    runLinkAdd(
      'ticket',
      'FLOW-100',
      'https://jira.example.com/FLOW-100',
      undefined,
      undefined,
      true
    )
  })

  assert.equal(
    stderrOut,
    'dashboard link add: FLOW-100 has its own board node (FLOW-100) — --root would attach its ' +
      'ticket link to the session root instead. Pass --key FLOW-100 (resolve it with ' +
      '`dashboard session key --ticket FLOW-100`).\n',
    'names the key to use instead'
  )
  assert.equal(getRequestedExitCode(), 1, 'exit code set to 1')
  assert.equal(readCalls(tmpDir).length, 0, 'refused before ever invoking the dashboard binary')
})

test('link add: --root --kind ticket refuses without guessing a --key when the ticket has more than one node (FLOW-351)', () => {
  const stubBin = writeStub(tmpDir, 0)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  upsertRegistryNode(sessionId, {
    internalId: 'epic-root',
    externalId: sessionId,
    key: null,
    parentId: null,
  })
  upsertRegistryNode(sessionId, {
    internalId: 'story-node',
    externalId: `${sessionId}:FLOW-100`,
    key: 'FLOW-100',
    parentId: 'epic-root',
  })
  upsertRegistryNode(sessionId, {
    internalId: 'story-node-resumed',
    externalId: `${sessionId}:FLOW-100-resumed`,
    key: 'FLOW-100-resumed',
    parentId: 'epic-root',
  })

  const stderrOut = captureStderr(() => {
    runLinkAdd(
      'ticket',
      'FLOW-100',
      'https://jira.example.com/FLOW-100',
      undefined,
      undefined,
      true
    )
  })

  assert.equal(
    stderrOut,
    'dashboard link add: FLOW-100 has its own board node (FLOW-100, FLOW-100-resumed) — --root ' +
      'would attach its ticket link to the session root instead. Which one the link belongs to ' +
      "is not this verb's call — resolve it with `dashboard session key --ticket FLOW-100` " +
      '(it names every match and refuses to guess).\n',
    'names both matches, proposes no single --key guess, points at the verb that resolves it'
  )
  assert.equal(getRequestedExitCode(), 1, 'exit code set to 1')
  assert.equal(readCalls(tmpDir).length, 0, 'refused before ever invoking the dashboard binary')
})

// 5. State backwards-compat: loadState on JSON missing openItemIds returns defaults
test('state backwards-compat: missing openItemIds gets safe default', () => {
  const sessionId = 'compat-test-session'
  const stateFile = stateFilePath(sessionId)

  // Write a state file that's missing the FLOW-101 openItemIds field
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, JSON.stringify({ registered: true, phase: 'prd' }))

  try {
    const state = loadState(sessionId)
    assert.ok(state !== null, 'state loaded successfully')
    assert.equal(state!.registered, true, 'registered is preserved')
    assert.equal(state!.phase, 'prd', 'phase is preserved')
    assert.deepEqual(state!.openItemIds, [], 'openItemIds defaults to []')
  } finally {
    try {
      rmSync(stateFile)
    } catch {
      /* ignore */
    }
  }
})
