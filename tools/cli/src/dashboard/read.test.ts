import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Helpers (mirrors item.test.ts)
// ---------------------------------------------------------------------------

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), 'read-test-'))

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

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { runReadAnswers, runReadComments } from './read.ts'
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'
import { upsertRegistryNode } from './registry.ts'

/** Registers `sessionId` as its own unkeyed root node — the shape resolveSessionTarget needs to
 * resolve without throwing (mirrors item.test.ts's registerRootNode). */
const registerRootNode = (sessionId: string): void =>
  upsertRegistryNode(sessionId, {
    internalId: sessionId,
    externalId: sessionId,
    key: null,
    parentId: null,
  })

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
let homeDir: string
let origHome: string | undefined

// resolveSessionId (called by runReadAnswers/runReadComments) reads the active-pointer sink,
// which resolves through the durable store (homedir()-relative) — override HOME so these tests
// never touch the real ~/.claude/workflow-state.
beforeEach(() => {
  tmpDir = makeTempDir()
  origBin = process.env.AI_WORKFLOW_APP_BIN
  // A test that forgets to wire its own stub must resolve to "dashboard unavailable" (an existing,
  // handled no-op), never fall through resolveDashboardBin's PATH lookup to the REAL installed
  // ai-workflow-app and drive it against the real board database. Wired tests overwrite this.
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'no-such-ai-workflow-app')
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  process.env.CLAUDE_CODE_SESSION_ID = `test-read-session-${uniqueId}`
  homeDir = mkdtempSync(join(tmpdir(), 'read-test-home-'))
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
// Tests: runReadAnswers
// ---------------------------------------------------------------------------

// Bin reachable, no CLAUDE_CODE_SESSION_ID: resolveSessionId throws inside the shared readReleased
// helper (answers/comments both route through it) — proving the try/catch
// around it reuses the thrown message and sets exit 1 instead of letting the throw escape uncaught.
test('runReadAnswers: no session id — refuses cleanly instead of throwing', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '[]')
  delete process.env.CLAUDE_CODE_SESSION_ID

  let stderrOut = ''
  let stdoutOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => {
      stdoutOut = captureStdout(() => runReadAnswers())
    })
  })

  assert.ok(
    stderrOut.includes('No session id: pass --session or set CLAUDE_CODE_SESSION_ID'),
    'stderr carries resolveSessionId’s own message'
  )
  // A genuinely empty result also prints on stdout ("No released answers…") — an empty string here
  // is what tells a refusal apart from that success case, not just truthiness.
  assert.equal(stdoutOut, '', 'a refusal must not print the same notice an empty result would')
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
  assert.equal(readCalls(tmpDir).length, 0, 'the backend is never invoked once resolution fails')
})

test('runReadAnswers: calls answers --session <id> and prints the formatted line', () => {
  const answersJson = JSON.stringify([
    { id: 'item-appr-1', type: 'approval', decision: 'rejected', response: 'not ready yet' },
  ])
  const stubBin = writeStub(tmpDir, 0, answersJson)
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)

  const stdoutOut = captureStdout(() => runReadAnswers())

  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'exactly one call')
  assert.ok(calls[0]!.includes('answers'), 'calls answers')
  assert.ok(calls[0]!.includes('--session'), 'includes --session')
  assert.ok(calls[0]!.includes(sessionId), 'includes session id')
  assert.equal(
    stdoutOut,
    '[dashboard] item item-appr-1 (approval): rejected — not ready yet\n' +
      `  → act on it, then consume it: \`dashboard item consume --item item-appr-1 --session ${sessionId}\`\n`
  )
})

test('runReadComments: a released comment names its reply and consume commands', () => {
  const stubBin = writeStub(
    tmpDir,
    0,
    JSON.stringify([{ id: 'comment-1', type: 'comment', response: 'looks off' }])
  )
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)

  const stdoutOut = captureStdout(() => runReadComments())

  assert.equal(
    stdoutOut,
    '[dashboard] item comment-1 (comment): looks off\n' +
      '  → reply on the board, not only in the terminal, unless it asks nothing and gives you nothing to act on: ' +
      `\`dashboard item add --type info --answers comment-1 --session ${sessionId} --prompt "$(cat "<tmpfile>")"\`` +
      ' (a question instead only when the comment raises a decision that earns one),' +
      ` then consume it: \`dashboard item consume --item comment-1 --session ${sessionId}\`\n`
  )
})

// FLOW-236 defect table row 1: two live leaves and no --key must refuse rather than printing
// "No released answers for this session." while answers actually sit unread on a leaf — silently
// wrong output, indistinguishable from "the user hasn't answered yet".
test('runReadAnswers: sibling leaves with no --key refuses loudly instead of printing the empty notice', () => {
  const stubBin = writeStub(tmpDir, 0, '[]')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  upsertRegistryNode(sessionId, {
    internalId: 'node-k1',
    externalId: `${sessionId}:K1`,
    key: 'K1',
    parentId: null,
  })
  upsertRegistryNode(sessionId, {
    internalId: 'node-k2',
    externalId: `${sessionId}:K2`,
    key: 'K2',
    parentId: null,
  })

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runReadAnswers())
  })

  assert.ok(stderrOut.includes('K1'), 'stderr names the K1 leaf')
  assert.ok(stderrOut.includes('K2'), 'stderr names the K2 leaf')
  assert.equal(
    stdoutOut.includes('No released answers for this session.'),
    false,
    'a refusal must not print the same notice an empty result would'
  )
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
  assert.equal(readCalls(tmpDir).length, 0, 'the backend is never invoked once resolution fails')
})

// FLOW-236 defect table row 6 (answers): --key must route to the named sibling, not the other
// leaf and not a root.
test('runReadAnswers: --key targets the named sibling node', () => {
  const stubBin = writeStub(tmpDir, 0, '[]')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  upsertRegistryNode(sessionId, {
    internalId: 'node-k1',
    externalId: `${sessionId}:K1`,
    key: 'K1',
    parentId: null,
  })
  upsertRegistryNode(sessionId, {
    internalId: 'node-k2',
    externalId: `${sessionId}:K2`,
    key: 'K2',
    parentId: null,
  })

  // K2, not K1: node-k1 is registered first, so a resolver that silently fell back to "the first
  // registered node" instead of actually reading --key would produce this same argv by accident —
  // targeting the second-registered node is what a --key regression can't fake.
  captureStdout(() => runReadAnswers(undefined, 'K2'))

  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'exactly one call')
  assert.ok(calls[0]!.includes('--session node-k2'), 'targets the K2 node internal id')
})

// FLOW-236 defect table row 7: a sole leaf that is NOT the raw session id itself (an epic → story
// chain) must still resolve exactly as it did before this change — only sibling ambiguity refuses.
test('runReadAnswers: sole leaf under a parent node still resolves (epic → story chain unaffected)', () => {
  const stubBin = writeStub(tmpDir, 0, '[]')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  upsertRegistryNode(sessionId, {
    internalId: 'epic',
    externalId: sessionId,
    key: null,
    parentId: null,
  })
  upsertRegistryNode(sessionId, {
    internalId: 'story',
    externalId: `${sessionId}:FLOW-173`,
    key: 'FLOW-173',
    parentId: 'epic',
  })

  const stdoutOut = captureStdout(() => runReadAnswers())

  const calls = readCalls(tmpDir)
  assert.ok(calls[0]!.includes('--session story'), 'targets the sole leaf (story)')
  assert.ok(
    stdoutOut.includes('No released answers for this session.'),
    'an unaffected sole leaf still resolves and prints the normal empty notice'
  )
})

test('runReadAnswers: empty array prints "No released answers for this session."', () => {
  const stubBin = writeStub(tmpDir, 0, '[]')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  registerRootNode(process.env.CLAUDE_CODE_SESSION_ID!)

  const stdoutOut = captureStdout(() => runReadAnswers())

  assert.ok(
    stdoutOut.includes('No released answers for this session.'),
    'stdout has the empty notice'
  )
})

test('runReadAnswers unavailable: no throw, no stdout', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')

  const stdoutOut = captureStdout(() => {
    assert.doesNotThrow(() => runReadAnswers())
  })

  assert.equal(stdoutOut, '', 'no stdout when unavailable')
})

test('runReadAnswers: non-array payload → stderr + non-zero exit, no "No released…" notice', () => {
  const stubBin = writeStub(tmpDir, 0, '{"error":"x"}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  registerRootNode(process.env.CLAUDE_CODE_SESSION_ID!)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runReadAnswers())
  })

  assert.ok(
    stderrOut.includes('could not parse answers output'),
    'stderr reports the parse failure'
  )
  assert.equal(exitCodeIsError(), true, 'non-zero exit code requested')
  assert.equal(
    stdoutOut.includes('No released answers for this session.'),
    false,
    'must not print the empty notice on a parse failure'
  )
})

test('runReadAnswers: malformed JSON → stderr + non-zero exit, no "No released…" notice', () => {
  const stubBin = writeStub(tmpDir, 0, '[{"id":"i1"')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  registerRootNode(process.env.CLAUDE_CODE_SESSION_ID!)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runReadAnswers())
  })

  assert.ok(
    stderrOut.includes('could not parse answers output'),
    'stderr reports the parse failure'
  )
  assert.equal(exitCodeIsError(), true, 'non-zero exit code requested')
  assert.equal(
    stdoutOut.includes('No released answers for this session.'),
    false,
    'must not print the empty notice on a parse failure'
  )
})

// ---------------------------------------------------------------------------
// Tests: runReadComments
// ---------------------------------------------------------------------------

// FLOW-236 defect table row 2: same shape as runReadAnswers row 1, for `dashboard comments`.
test('runReadComments: sibling leaves with no --key refuses loudly instead of printing the empty notice', () => {
  const stubBin = writeStub(tmpDir, 0, '[]')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  upsertRegistryNode(sessionId, {
    internalId: 'node-k1',
    externalId: `${sessionId}:K1`,
    key: 'K1',
    parentId: null,
  })
  upsertRegistryNode(sessionId, {
    internalId: 'node-k2',
    externalId: `${sessionId}:K2`,
    key: 'K2',
    parentId: null,
  })

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runReadComments())
  })

  assert.ok(stderrOut.includes('K1'), 'stderr names the K1 leaf')
  assert.ok(stderrOut.includes('K2'), 'stderr names the K2 leaf')
  assert.equal(
    stdoutOut.includes('No released comments for this session.'),
    false,
    'a refusal must not print the same notice an empty result would'
  )
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
  assert.equal(readCalls(tmpDir).length, 0, 'the backend is never invoked once resolution fails')
})

test('runReadComments: calls comments --session <id>', () => {
  const stubBin = writeStub(tmpDir, 0, '[]')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)

  captureStdout(() => runReadComments())

  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'exactly one call')
  assert.ok(calls[0]!.includes('comments'), 'calls comments')
  assert.ok(calls[0]!.includes('--session'), 'includes --session')
  assert.ok(calls[0]!.includes(sessionId), 'includes session id')
})
