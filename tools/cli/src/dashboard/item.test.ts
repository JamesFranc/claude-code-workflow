import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Helpers (shared pattern from dashboard.test.ts)
// ---------------------------------------------------------------------------

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), 'item-test-'))

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

/** The raw calls.log content, unsplit — a batched prompt embeds real newlines, so a call spans
 * several of readCalls' lines; content checks on a batched call need the whole file as one string. */
const readRawCalls = (dir: string): string => {
  const log = join(dir, 'calls.log')
  return existsSync(log) ? readFileSync(log, 'utf-8') : ''
}

/** Stub that answers `session list` and every other verb with different stdout. */
const writeBranchingStub = (dir: string, sessionListOut: string, otherOut: string): string => {
  const path = join(dir, 'ai-workflow-app')
  writeFileSync(
    path,
    `#!/usr/bin/env bash\n` +
      `echo "$@" >> ${JSON.stringify(join(dir, 'calls.log'))}\n` +
      `if [ "$1" = "session" ] && [ "$2" = "list" ]; then\n` +
      `  echo ${JSON.stringify(sessionListOut)}\n` +
      `else\n` +
      `  echo ${JSON.stringify(otherOut)}\n` +
      `fi\nexit 0\n`
  )
  chmodSync(path, 0o755)
  return path
}

/**
 * Like writeBranchingStub, but every non-`session list` call returns a distinct itemId
 * (`item-1`, `item-2`, …) and, when `failAfter` is given, the call after that many succeeds
 * exits 1 — so a flush that posts one item per entry can be checked call by call.
 */
const writeCountingStub = (dir: string, sessionListOut: string, failAfter?: number): string => {
  const path = join(dir, 'ai-workflow-app')
  const counter = join(dir, 'counter')
  writeFileSync(
    path,
    `#!/usr/bin/env bash\n` +
      `echo "$@" >> ${JSON.stringify(join(dir, 'calls.log'))}\n` +
      `if [ "$1" = "session" ] && [ "$2" = "list" ]; then\n` +
      `  echo ${JSON.stringify(sessionListOut)}\n` +
      `  exit 0\n` +
      `fi\n` +
      `n=$(( $(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0) + 1 ))\n` +
      `echo "$n" > ${JSON.stringify(counter)}\n` +
      (failAfter === undefined
        ? ''
        : `if [ "$n" -gt ${String(failAfter)} ]; then echo "stub: board down" >&2; exit 1; fi\n`) +
      `echo "{\\"itemId\\":\\"item-$n\\"}"\nexit 0\n`
  )
  chmodSync(path, 0o755)
  return path
}

/**
 * One `session list` row for `boardNodeId`. `counts` omitted models a backend that predates REV-72
 * and reports no `openItemCounts` at all. `externalId` defaults
 * to `boardNodeId` (the root case: internal id === external id === raw session id); pass it
 * explicitly for a keyed child, whose external id is `<rawId>:<key>`, not its internal id.
 */
const boardRow = (
  boardNodeId: string,
  openItemCount: number,
  counts?: { question: number; approval: number; comment: number },
  externalId?: string
): string =>
  JSON.stringify([
    {
      session: {
        id: boardNodeId,
        systemId: 'claude-workflow',
        externalId: externalId ?? boardNodeId,
        title: 't',
        phase: 'pr',
        lifecycle: 'active',
        parentId: null,
      },
      openItemCount,
      ...(counts ? { openItemCounts: counts } : {}),
    },
  ])

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  runItemAdd,
  runItemAnswer,
  runItemApprove,
  runItemReject,
  runItemWithdraw,
  runItemConsume,
  runItemDropDeferred,
  runItemListDeferred,
  runItemFlushDeferred,
} from './item.ts'
import { loadState, stateFilePath, saveState, type DeferredQuestion } from './state.ts'
import { upsertRegistryNode } from './registry.ts'
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'

/** Registers `sessionId` as its own unkeyed root node — the shape most tests below need to make
 * `resolveSessionTarget` resolve without throwing. Keyed-sibling tests still register their own
 * `node-k1`/`node-k2` nodes directly; this only covers the plain-root repeat. */
const registerRootNode = (sessionId: string): void =>
  upsertRegistryNode(sessionId, {
    internalId: sessionId,
    externalId: sessionId,
    key: null,
    parentId: null,
  })

/** Minimal valid --recommend/--stalls/--why-mine declaration, for tests exercising behavior
 * downstream of the question gate rather than the gate or the composed prompt's content. */
const questionDecl = { recommend: 'Ship it', stalls: 'none', whyMine: 'scope' as const }

// The exact first stderr line reproducesDeclarationGrammar's refusal emits for --recommend/--stalls
// — pinned once here so every test exercising it fails loudly if the four-trigger enumeration
// (delimiter, Unicode-equivalent delimiter, edge "·", bold label) drifts, rather than passing on a
// substring that survives a wrong or incomplete enumeration.
const RECOMMEND_GRAMMAR_WRONG_LINE =
  'dashboard: --recommend reproduces the declaration line’s own grammar (a " · " delimiter, a ' +
  'Unicode-equivalent form of it, a leading or trailing "·", or a "**Label:**" marker) — it would ' +
  'extend or corrupt the composed line.'
const STALLS_GRAMMAR_WRONG_LINE =
  'dashboard: --stalls reproduces the declaration line’s own grammar (a " · " delimiter, a ' +
  'Unicode-equivalent form of it, a leading or trailing "·", or a "**Label:**" marker) — it would ' +
  'extend or corrupt the composed line.'

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

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

const resetExitCode = (): void => setRequestedExitCode(0)
const exitCodeIsError = (): boolean => {
  const code = getRequestedExitCode()
  return code !== undefined && code !== 0
}

// A caller on a genuinely successful path must not ALSO have requested an error exit — output and
// exit code are two separate channels, and a bug that gets one right can still get the other wrong.
// Use this instead of the bare captureStdout for a call the test asserts printed a real success
// payload, so the exit-code check travels with every such call site instead of needing its own
// separate assertion line.
const captureStdoutAssertingSuccess = (fn: () => void): string => {
  const out = captureStdout(fn)
  assert.equal(
    exitCodeIsError(),
    false,
    'a successful call must not also request an error exit code'
  )
  return out
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

let tmpDir: string
let origBin: string | undefined
let origSessionId: string | undefined
let homeDir: string
let origHome: string | undefined

// stateFilePath resolves through the durable store, which is homedir()-relative — override HOME
// so these tests never touch the real ~/.claude/workflow-state.
beforeEach(() => {
  tmpDir = makeTempDir()
  origBin = process.env.AI_WORKFLOW_APP_BIN
  // A test that forgets to wire its own stub must resolve to "dashboard unavailable" (an existing,
  // handled no-op), never fall through resolveDashboardBin's PATH lookup to the REAL installed
  // ai-workflow-app and drive it against the real board database. Wired tests overwrite this.
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'no-such-ai-workflow-app')
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  process.env.CLAUDE_CODE_SESSION_ID = `test-item-session-${uniqueId}`
  homeDir = mkdtempSync(join(tmpdir(), 'item-test-home-'))
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
// Tests: runItemAdd
// ---------------------------------------------------------------------------

const captureAll = (
  fn: () => void
): { stdout: string; stderr: string; exit: number | undefined } => {
  resetExitCode()
  let stdout = ''
  const stderr = captureStderr(() => {
    stdout = captureStdout(fn)
  })
  return { stdout, stderr, exit: getRequestedExitCode() }
}

const NO_BOARD_ASK =
  'No board is available. Ask the user this in the terminal and wait for the reply.\n'

test('runItemAdd with no board prints the composed question, exits 3, writes no state', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  const stateFile = stateFilePath(process.env.CLAUDE_CODE_SESSION_ID!)

  const out = captureAll(() => runItemAdd('question', 'What should we build?', questionDecl))

  assert.deepEqual(out, {
    stdout:
      'What should we build?\n\n> **Recommend:** Ship it · **Stalls:** none · **Yours because:** scope\n\n' +
      NO_BOARD_ASK,
    stderr: '',
    exit: 3,
  })
  assert.equal(existsSync(stateFile), false, 'nothing posted, so no openItemIds entry')
})

test('runItemAdd --defer with no board exits 3 and queues nothing', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, { registered: true, phase: 'impl', openItemIds: [] })

  const out = captureAll(() =>
    runItemAdd('question', 'Should the retry live in the client or the caller?', {
      ...questionDecl,
      defer: true,
    })
  )

  assert.deepEqual(out, {
    stdout:
      'Should the retry live in the client or the caller?\n\n> **Recommend:** Ship it · **Stalls:** none · **Yours because:** scope\n\n' +
      NO_BOARD_ASK,
    stderr: '',
    exit: 3,
  })
  assert.deepEqual(loadState(sessionId)?.deferredQuestions ?? [], [], 'nothing queued')
})

test('runItemAdd with no board still refuses a bad flag with exit 1', () => {
  const blankStalls = captureAll(() =>
    runItemAdd('question', 'Q?', { ...questionDecl, stalls: '  ' })
  )
  assert.deepEqual(blankStalls, {
    stdout: '',
    stderr:
      'dashboard: every --type question must declare --recommend, --stalls and --why-mine — missing --stalls.\n' +
      'A question that does not say what you would do, or what is waiting on the answer, costs the user a round trip to ask you. Choosing a --why-mine value is itself the claim that this question cleared all three escalation rungs — there is no value meaning "I skipped them".\n' +
      'Add the missing flag(s) and post again (skills/board/references/escalation-contract.md).\n',
    exit: 1,
  })

  const deferStalls = captureAll(() =>
    runItemAdd('question', 'Q?', { ...questionDecl, stalls: 'the merge', defer: true })
  )
  assert.deepEqual(deferStalls, {
    stdout: '',
    stderr:
      'dashboard: --defer requires --stalls none — got --stalls "the merge".\n' +
      'A deferral-gate question asks whether work you found should be done later. If something is stalled on the answer, the work is not deferrable and this is an ordinary blocking question.\n' +
      'Pass --stalls none, or drop --defer and state what stalls (skills/board/references/escalation-contract.md).\n',
    exit: 1,
  })
})

test('runItemAdd approval with no board exits 3 with the raw prompt', () => {
  const out = captureAll(() => runItemAdd('approval', 'Ready to merge?'))

  assert.deepEqual(out, { stdout: 'Ready to merge?\n\n' + NO_BOARD_ASK, stderr: '', exit: 3 })
})

test('runItemAdd info with no board exits 3 and says nothing waits', () => {
  const out = captureAll(() => runItemAdd('info', 'Build finished.'))

  assert.deepEqual(out, {
    stdout:
      'Build finished.\n\nNo board is available. Tell the user this in the terminal; nothing waits on it.\n',
    stderr: '',
    exit: 3,
  })
})

test('runItemAdd unavailable + no session: no throw', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  delete process.env.CLAUDE_CODE_SESSION_ID

  let out: ReturnType<typeof captureAll> | undefined
  assert.doesNotThrow(() => {
    out = captureAll(() => runItemAdd('question', 'What should we build?', questionDecl))
  })
  assert.deepEqual(out, {
    stdout:
      'What should we build?\n\n> **Recommend:** Ship it · **Stalls:** none · **Yours because:** scope\n\n' +
      NO_BOARD_ASK,
    stderr: '',
    exit: 3,
  })
})

// The no-board tests above never reach resolveSessionTarget at all — they exit
// at the earlier resolveDashboardBin() === null check (item.ts, ahead of the resolveSessionTarget
// call). This test wires a reachable bin that answers `session list` with an empty board, so
// runItemAdd clears that earlier check and resolveSessionTarget itself throws (no registered node,
// zero leaves, board reachable but empty — session-id.ts's "run `dashboard session enter` first"
// arm) — proving the try/catch around that call reuses the thrown message and sets exit 1 instead
// of letting the throw escape as an uncaught exception.
test('runItemAdd: reachable board, no registered session — refuses cleanly instead of throwing', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '[]')

  let stderrOut = ''
  let stdoutOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => {
      stdoutOut = captureStdout(() => runItemAdd('question', 'What should we build?', questionDecl))
    })
  })

  assert.ok(
    stderrOut.includes('run `dashboard session enter` first'),
    'stderr carries resolveSessionTarget’s own message'
  )
  assert.equal(stdoutOut, '', 'a refusal must not leak a success payload onto stdout')
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
})

test('runItemAdd: records itemId in openItemIds and prints it', () => {
  const stubBin = writeStub(tmpDir, 0, '{"itemId":"item-abc-1"}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  // runItemAdd is a mutation verb (resolveSessionTarget) — it needs a live registered session to
  // resolve against, unlike the old lenient raw-id fallback.
  registerRootNode(sessionId)

  const stdoutOut = captureStdout(() =>
    runItemAdd('question', 'What should we build?', questionDecl)
  )

  const calls = readCalls(tmpDir)
  // Not calls.length: the composed question prompt embeds its own blank line between the lede and
  // the declaration blockquote, so readCalls's newline split sees more entries than actual
  // invocations. Only the first line of a real call starts with "item add".
  assert.equal(calls.filter((c) => c.startsWith('item add')).length, 1, 'exactly one item add call')
  assert.ok(calls[0]!.includes('item add'), 'calls item add')
  assert.ok(calls[0]!.includes('--session'), 'includes --session')
  assert.ok(calls[0]!.includes(sessionId), 'includes session id')
  assert.ok(calls[0]!.includes('--type question'), 'includes --type question')
  assert.ok(calls[0]!.includes('--prompt'), 'includes --prompt')

  const state = loadState(sessionId)
  assert.ok(state !== null, 'state written')
  assert.deepEqual(state!.openItemIds, ['item-abc-1'], 'itemId recorded in openItemIds')

  const out = JSON.parse(stdoutOut.trim()) as { itemId: string }
  assert.equal(out.itemId, 'item-abc-1', 'itemId printed to stdout')
})

test('runItemAdd: approval type passes --type approval', () => {
  const stubBin = writeStub(tmpDir, 0, '{"itemId":"item-appr-1"}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)

  captureStdout(() => runItemAdd('approval', 'Please approve the doc'))

  const calls = readCalls(tmpDir)
  const addCall = calls.find((c) => c.includes('item add'))
  assert.ok(addCall !== undefined, 'item add was called')
  assert.ok(addCall!.includes('--type approval'), 'includes --type approval')
  const state = loadState(sessionId)
  assert.deepEqual(state!.openItemIds, ['item-appr-1'], 'itemId recorded')
})

test('runItemAdd: does not duplicate itemId if already in openItemIds', () => {
  const stubBin = writeStub(tmpDir, 0, '{"itemId":"item-dup"}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  // Pre-seed the state with the same itemId
  saveState(sessionId, {
    registered: true,
    phase: 'prd',
    openItemIds: ['item-dup'],
  })

  captureStdout(() => runItemAdd('question', 'Duplicate?', questionDecl))

  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add was called'
  )
  const state = loadState(sessionId)
  assert.deepEqual(state!.openItemIds, ['item-dup'], 'no duplicate in openItemIds')
})

// runItemAdd's save rebuilt DashboardSessionState field-by-field instead of spreading the
// existing state, silently dropping parentId — a hand-rolled constructor drops any field it
// doesn't name. parentId is the tree-structure pointer that keys a node to its epic root, so
// dropping it here orphans this node from the epic the very first time an item is added on a
// child session.
test('runItemAdd: preserves parentId so it is not orphaned onto this node', () => {
  const stubBin = writeStub(tmpDir, 0, '{"itemId":"item-epic-1"}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  const parentId = `${sessionId}-parent`
  registerRootNode(sessionId)
  // Simulate `enter` having already recorded this node's parent (the epic root).
  saveState(sessionId, {
    registered: true,
    phase: 'prd',
    openItemIds: [],
    parentId,
  })

  captureStdout(() => runItemAdd('question', 'What should we build?', questionDecl))

  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add was called'
  )
  const state = loadState(sessionId)
  assert.equal(state?.parentId, parentId, 'parentId survives the item-add save')
})

test('runItemAdd: failing stub → loud error, no state write', () => {
  const stubBin = writeStub(tmpDir, 1, '', 'item add failed')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)

  const stderrOut = captureStderr(() =>
    captureStdout(() => runItemAdd('question', 'Will this fail?', questionDecl))
  )

  assert.ok(stderrOut.length > 0, 'stderr written on failure')
  assert.ok(stderrOut.includes('failed'), 'stderr mentions failure')
  assert.equal(exitCodeIsError(), true, 'error exit code set')
  const state = loadState(sessionId)
  assert.equal(state, null, 'no state written on failure')
})

// The board call succeeded (exit 0) but the response carries no itemId — unlike the failing-stub
// case above, the post itself may have landed. A caller reading exit 0 here would end its turn
// believing the item posted; a caller reading a plain failure would be invited to retry blind and
// risk a duplicate. Neither openItemIds nor stdout gets an entry that was never confirmed.
test('runItemAdd: stub returns no itemId → loud unconfirmed-post error, nothing recorded', () => {
  const stubBin = writeStub(tmpDir, 0, '{"ok":true}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemAdd('question', 'What should we build?', questionDecl))
  })

  assert.equal(stdoutOut, '', 'no success payload printed')
  assert.ok(
    stderrOut.includes('did not return a usable itemId'),
    'stderr names the unconfirmed post'
  )
  assert.ok(stderrOut.includes('duplicate'), 'stderr warns a blind retry risks a duplicate')
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
  assert.equal(
    loadState(sessionId),
    null,
    'nothing was recorded as an open item — no state written'
  )
})

test('runItemAdd: stub returns a non-string itemId → loud unconfirmed-post error, nothing recorded', () => {
  const stubBin = writeStub(tmpDir, 0, '{"itemId":42}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemAdd('question', 'What should we build?', questionDecl))
  })

  assert.equal(stdoutOut, '', 'no success payload printed')
  assert.ok(
    stderrOut.includes('did not return a usable itemId'),
    'stderr names the unconfirmed post'
  )
  assert.equal(
    exitCodeIsError(),
    true,
    'a non-string itemId must be treated as a failure, not a success'
  )
  assert.equal(
    loadState(sessionId),
    null,
    'nothing was recorded as an open item — no state written'
  )
})

// The same class as enter.ts's stateFileIsCorrupt guard (FLOW-250, state.ts): loadState collapses
// "no file" and "file present but unparseable" to the same null, so the old `state ?? {...}`
// fallback would overwrite a hand-repairable corrupt file with a fresh empty one. Checked before
// the board post, not beside the save — the stub records no `item add` call at all.
test('runItemAdd: refuses to post over a present-but-unparseable state file, preserving it instead of overwriting it with a fresh one', () => {
  const stubBin = writeStub(tmpDir, 0, '{"itemId":"item-abc-1"}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  writeFileSync(stateFilePath(sessionId), '{not json')

  const stderrOut = captureStderr(() =>
    captureStdout(() => runItemAdd('question', 'What should we build?', questionDecl))
  )

  assert.ok(
    stderrOut.includes('failed to parse') && stderrOut.includes('refusing to post this item'),
    'stderr explains the refusal'
  )
  assert.equal(exitCodeIsError(), true, 'exit code set to error')
  assert.equal(
    readFileSync(stateFilePath(sessionId), 'utf8'),
    '{not json',
    'the damaged file is preserved untouched, not replaced with a fresh empty state'
  )
  assert.equal(
    readCalls(tmpDir).filter((c) => c.startsWith('item add')).length,
    0,
    'no item add call was made — refused before the board post'
  )
})

test('runItemAdd: sibling leaves with no --key refuses loudly (no CLI call, no throw)', () => {
  const stubBin = writeStub(tmpDir, 0, '{"itemId":"item-x"}')
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

  let stderrOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => runItemAdd('question', 'Which one?', questionDecl))
  })

  assert.ok(stderrOut.includes('K1'), 'stderr carries resolveSessionTarget’s own message')
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
  assert.equal(readCalls(tmpDir).length, 0, 'no CLI call made before the refusal')
})

test('runItemAdd: --key targets the named sibling node (correct --session argv)', () => {
  const stubBin = writeStub(tmpDir, 0, '{"itemId":"item-y"}')
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

  captureStdout(() => runItemAdd('question', 'Which one?', { ...questionDecl, key: 'K1' }))

  const calls = readCalls(tmpDir)
  // Not calls.length — see the same note on the "records itemId" test above.
  assert.equal(calls.filter((c) => c.startsWith('item add')).length, 1, 'exactly one item add call')
  assert.ok(calls[0]!.includes('--session node-k1'), 'targets the K1 node internal id')
})

// ---------------------------------------------------------------------------
// FLOW-211: the approval guard. Blocks `--type approval` when the board reports an open QUESTION
// on this node; never on another open approval (the HOLD path posts exactly that shape). Fails
// open on every uncertain read.
//
// Outcome x channel coverage — every row below is asserted on every channel listed for it, "yes"/
// "no" on the session-list column included (every such cell has an explicit `readCalls(...).some
// (c => c.includes('session list'))` assertion, not an inference from a neighboring assertion). "n/a"
// means the channel genuinely cannot distinguish this outcome — reserved for cases where a single
// value cannot describe it at all (the two-row-match test's `exit` cell: it calls runItemAdd twice
// in one test, once erroring and once clean, and `exitCodeIsError()` reads one global tracker, so a
// single value there would just be whichever call ran last). A cell that CAN be pinned to a single
// value is pinned, even in a test that also has an n/a cell elsewhere in the same row — "no" is a
// real, asserted value, not a synonym for "can't tell." No row below is "n/a" merely because an
// earlier draft of this table didn't check it.
//
//   outcome (test)                                | stdout        | stderr        | exit  | ledger      | item add | session list
//   -----------------------------------------------|---------------|---------------|-------|-------------|----------|---------------
//   refused: question open (root)                  | empty         | refusal+count | error | null        | no       | yes
//   refused: question open (keyed sibling)          | empty         | refusal       | error | null        | no       | yes
//   refused: --type question + --approval-kind      | empty         | mismatch      | error | null        | no       | no (asserted via zero total CLI-binary calls)
//   posted: only another approval open              | itemId        | empty         | clean | itemId      | yes      | yes
//   posted: a stale local ledger entry doesn't block| itemId        | empty         | clean | stale+itemId| yes      | yes
//   posted: --approval-kind hold override            | itemId        | empty         | clean | itemId      | yes      | no (short-circuits before the read)
//   posted: --approval-kind credential override      | itemId        | empty         | clean | itemId      | yes      | no (short-circuits before the read)
//   posted: --approval-kind checkpoint override      | itemId        | empty         | clean | itemId      | yes      | no (short-circuits before the read)
//   posted: openItemCounts absent (fail open)        | itemId        | empty         | clean | itemId      | yes      | yes
//   posted: openItemCounts partial (fail open)       | itemId        | empty         | clean | itemId      | yes      | yes
//   posted: openItemCounts negative (fail open)      | itemId        | empty         | clean | itemId      | yes      | yes
//   posted: openItemCounts non-integer (fail open)   | itemId        | empty         | clean | itemId      | yes      | yes
//   posted: board unreachable (fail open)            | itemId        | quiet warning | clean | itemId      | yes      | yes (fails)
//   posted: session list unparseable (fail open)     | itemId        | empty         | clean | itemId      | yes      | yes
//   posted: node absent from board (fail open)       | itemId        | empty         | clean | itemId      | yes      | yes
//   posted: no CLAUDE_CODE_SESSION_ID (fail open)    | itemId        | empty         | clean | itemId      | yes      | no (no raw id to scope a read to)
//   posted: two-row board matches by node id         | empty/itemId  | refusal/empty | n/a   | null/itemId | mixed    | yes
//   question: never guarded                          | itemId        | empty         | clean | itemId      | yes      | no
// ---------------------------------------------------------------------------

// The RED case — an approval must not go up while the user still owes an ANSWER. Note the counts
// triple: question 3 is what refuses. See the sibling test below at the same total with approval 3,
// which must post — that pair is what pins type-awareness (a guard counting the total cannot pass
// both). The count is 3, not 1: a mutation that hardcodes the stderr's `${openQuestions}` interpolation
// to the literal 1 would still pass a `question: 1` fixture — 3 is what forces the real value through.
test('runItemAdd approval: refused when the board reports an open question', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 3, { question: 3, approval: 0, comment: 0 }),
    '{"itemId":"item-should-not-post"}'
  )
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemAdd('approval', 'CI green — flip to ready-for-review?'))
  })

  assert.ok(stderrOut.includes('refusing to post an approval'), 'refusal explained on stderr')
  assert.ok(
    stderrOut.includes('3 open question(s)'),
    'the actual count reaches stderr, not just a generic refusal or a hardcoded 1'
  )
  assert.ok(
    stderrOut.includes('Only three kinds of approval are exempt'),
    'states the count of exempt approval kinds'
  )
  assert.ok(stderrOut.includes('--approval-kind hold'), 'names the hold override')
  assert.ok(stderrOut.includes('--approval-kind credential'), 'names the credential override')
  assert.ok(stderrOut.includes('--approval-kind checkpoint'), 'names the checkpoint override')
  assert.ok(
    stderrOut.includes('There is no fourth exempt category'),
    'states there is no fourth exempt category'
  )
  assert.ok(
    stderrOut.includes('if this is none of the three, it is an advancement approval'),
    'states the fall-through: anything not one of the three is an advancement approval'
  )
  assert.ok(
    stderrOut.includes('skills/board/references/dashboard-protocol.md'),
    'refusal cites the protocol path, which no lint covers'
  )
  assert.equal(stdoutOut, '', 'nothing printed on stdout — no itemId to report')
  assert.equal(exitCodeIsError(), true, 'error exit code set')
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session list')),
    'the guard actually read the board rather than refusing some other way'
  )
  assert.equal(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    false,
    'item add was never called'
  )
  assert.equal(loadState(sessionId), null, 'nothing recorded in the local ledger')
})

// Type-awareness, and the anti-vacuity control for the test above: SAME non-zero total (3), only the
// breakdown differs. The HOLD path posts exactly this shape — an approval while another approval is
// open — so a guard that regressed to counting the total would break HOLD and fail here.
test('runItemAdd approval: posts when only another approval is open, at the same total', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 3, { question: 0, approval: 3, comment: 0 }),
    '{"itemId":"item-ok"}'
  )
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemAdd('approval', 'Ready?'))
  })

  assert.equal(stderrOut, '', 'no refusal')
  assert.equal(stdoutOut, '{"itemId":"item-ok"}\n', 'itemId printed to stdout')
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session list')),
    'the guard actually read the board rather than assuming it was clean'
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add was called'
  )
  assert.deepEqual(loadState(sessionId)!.openItemIds, ['item-ok'], 'itemId recorded')
  assert.equal(exitCodeIsError(), false, 'posting is not an error')
})

// FLOW-196: the local openItemIds ledger drifts from the board in both directions. Every guard
// test above starts with an empty local ledger, which only pins the "ledger is missing an item the
// board still has open" direction (an empty ledger can't wrongly block). This pins the other
// direction: a STALE local entry the board has already resolved must not make the guard block a
// legitimate post — a guard that consulted the local ledger instead of (or in addition to) the
// board would wrongly refuse here, even though the board itself reports zero open questions.
test('runItemAdd approval: a stale local ledger entry does not block — only the board counts', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-ok"}'
  )
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'pr',
    openItemIds: ['stale-item-the-board-already-resolved'],
  })

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemAdd('approval', 'Ready?'))
  })

  assert.equal(stderrOut, '', 'no refusal — the board, not the stale local ledger, is what counts')
  assert.equal(stdoutOut, '{"itemId":"item-ok"}\n', 'itemId printed to stdout')
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session list')),
    'the guard actually read the board rather than trusting the local ledger'
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add was called'
  )
  assert.deepEqual(
    loadState(sessionId)!.openItemIds,
    ['stale-item-the-board-already-resolved', 'item-ok'],
    'the stale entry is left alone (this guard never touches the ledger for reading) and the new itemId is appended'
  )
  assert.equal(exitCodeIsError(), false, 'posting is not an error')
})

// A question is never blocked — the guard must not touch the batching of independent questions,
// and must not add a board round-trip to the question path at all.
test('runItemAdd question: never guarded, makes no session list call', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 3, { question: 3, approval: 0, comment: 0 }),
    '{"itemId":"item-q"}'
  )
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemAdd('question', 'A third question?', questionDecl))
  })

  assert.equal(stderrOut, '', 'no refusal — questions are never guarded')
  assert.equal(stdoutOut, '{"itemId":"item-q"}\n', 'itemId printed to stdout')
  const calls = readCalls(tmpDir)
  assert.equal(
    calls.some((c) => c.includes('session list')),
    false,
    'no board read on the question path'
  )
  assert.ok(
    calls.some((c) => c.includes('item add')),
    'item add was called'
  )
  assert.deepEqual(loadState(sessionId)!.openItemIds, ['item-q'], 'question posted')
  assert.equal(exitCodeIsError(), false, 'posting a question is not an error')
})

// --approval-kind only means something on an approval; silently ignoring it on a question would
// let a caller believe it declared a HOLD/credential kind for an item type that has no such thing.
test('runItemAdd: rejects --approval-kind combined with --type question', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"item-should-not-post"}')
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemAdd('question', 'A question?', { approvalKind: 'hold' }))
  })

  assert.ok(
    stderrOut.includes('--approval-kind only applies to --type approval'),
    'the production message reached stderr, not merely something mentioning the flag name'
  )
  assert.equal(stdoutOut, '', 'nothing printed on stdout — no itemId to report')
  assert.equal(exitCodeIsError(), true, 'error exit code set')
  assert.equal(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    false,
    'item add was never called'
  )
  assert.equal(loadState(sessionId), null, 'nothing recorded in the local ledger')
})

// This is argument validation, not a board operation — the mismatch check must not sit behind
// dashboardAvailable(), or a nonexistent binary makes it exit 0 silently, routing a flag error
// through the same no-op path as "board not installed". Uses the beforeEach default
// (AI_WORKFLOW_APP_BIN pinned to a nonexistent path) deliberately, unset here.
test('runItemAdd: rejects --approval-kind + --type question even with the board unavailable', () => {
  const stderrOut = captureStderr(() =>
    captureStdout(() => runItemAdd('question', 'A question?', { approvalKind: 'hold' }))
  )

  assert.ok(
    stderrOut.includes('--approval-kind only applies to --type approval'),
    'the production message reached stderr, not merely something mentioning the flag name'
  )
  assert.equal(exitCodeIsError(), true, 'error exit code set even though the board is unavailable')
  assert.equal(readCalls(tmpDir).length, 0, 'the nonexistent binary was never even invoked')
})

// The escape hatch for HOLD / credential / checkpoint asks
// (skills/board/references/dashboard-protocol.md §3.1) — an enum, not free
// text: it supplies a missing fact ("this is a HOLD"), not a self-judged permission. Exactly three
// values are recognized; all three are exercised so none collapses into "any truthy override works".
test('runItemAdd approval: --approval-kind hold overrides the guard', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 2, { question: 2, approval: 0, comment: 0 }),
    '{"itemId":"item-hold"}'
  )
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() =>
      runItemAdd('approval', 'HOLD — do not merge', { approvalKind: 'hold' })
    )
  })

  assert.equal(stderrOut, '', 'no refusal')
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add proceeded'
  )
  assert.equal(
    readCalls(tmpDir).some((c) => c.includes('session list')),
    false,
    'the override short-circuits before the board is ever read'
  )
  assert.equal(exitCodeIsError(), false, 'override is not an error')
  assert.equal(stdoutOut, '{"itemId":"item-hold"}\n', 'itemId printed to stdout')
  assert.deepEqual(
    loadState(sessionId)!.openItemIds,
    ['item-hold'],
    'itemId recorded in the ledger'
  )
})

test('runItemAdd approval: --approval-kind credential overrides the guard', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 2, { question: 2, approval: 0, comment: 0 }),
    '{"itemId":"item-credential"}'
  )
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() =>
      runItemAdd('approval', 'Need the deploy token', { approvalKind: 'credential' })
    )
  })

  assert.equal(stderrOut, '', 'no refusal')
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add proceeded'
  )
  assert.equal(
    readCalls(tmpDir).some((c) => c.includes('session list')),
    false,
    'the override short-circuits before the board is ever read'
  )
  assert.equal(exitCodeIsError(), false, 'override is not an error')
  assert.equal(stdoutOut, '{"itemId":"item-credential"}\n', 'itemId printed to stdout')
  assert.deepEqual(
    loadState(sessionId)!.openItemIds,
    ['item-credential'],
    'itemId recorded in the ledger'
  )
})

test('runItemAdd approval: --approval-kind checkpoint overrides the guard', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 2, { question: 2, approval: 0, comment: 0 }),
    '{"itemId":"item-checkpoint"}'
  )
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() =>
      runItemAdd('approval', 'Paused — CI has been failing to schedule for an hour', {
        approvalKind: 'checkpoint',
      })
    )
  })

  assert.equal(stderrOut, '', 'no refusal')
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add proceeded'
  )
  assert.equal(
    readCalls(tmpDir).some((c) => c.includes('session list')),
    false,
    'the override short-circuits before the board is ever read'
  )
  assert.equal(exitCodeIsError(), false, 'override is not an error')
  assert.equal(stdoutOut, '{"itemId":"item-checkpoint"}\n', 'itemId printed to stdout')
  assert.deepEqual(
    loadState(sessionId)!.openItemIds,
    ['item-checkpoint'],
    'itemId recorded in the ledger'
  )
})

// A keyed sibling node (all guard tests above use the default root, key: null) — proves the guard's
// board-node match resolves correctly off the --key-targeted internal id, not just the trivial
// root-equals-raw-session-id case, and does so correctly among siblings.
test('runItemAdd approval: refused for a keyed sibling node with an open question', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow('node-k1', 1, { question: 1, approval: 0, comment: 0 }, `${sessionId}:K1`),
    '{"itemId":"item-should-not-post"}'
  )
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
    stdoutOut = captureStdout(() => runItemAdd('approval', 'Ready?', { key: 'K1' }))
  })

  assert.ok(stderrOut.includes('refusing to post an approval'), 'refused for the K1 node')
  assert.equal(stdoutOut, '', 'nothing printed on stdout — no itemId to report')
  assert.equal(exitCodeIsError(), true, 'error exit code set')
  assert.equal(loadState('node-k1'), null, 'nothing recorded in the K1 ledger')
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session list')),
    'the guard actually read the board rather than refusing some other way'
  )
  assert.equal(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    false,
    'item add was never called'
  )
})

// Absent `openItemCounts` (a pre-REV-72 backend) is UNKNOWN, never "no questions open": fails open.
test('runItemAdd approval: absent openItemCounts fails OPEN and still posts', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 3),
    '{"itemId":"item-failopen-absent"}'
  )
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemAdd('approval', 'Ready?'))
  })

  assert.equal(stderrOut, '', 'no refusal and no board-read warning — this read succeeded')
  assert.equal(stdoutOut, '{"itemId":"item-failopen-absent"}\n', 'itemId printed to stdout')
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session list')),
    'the guard actually read the board — this is fail-open on the parsed result, not a skipped read'
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add was actually called'
  )
  assert.deepEqual(loadState(sessionId)!.openItemIds, ['item-failopen-absent'], 'posted anyway')
  assert.equal(exitCodeIsError(), false, 'no error exit')
})

// Partial/malformed `openItemCounts` is also unknown, not a partial count.
test('runItemAdd approval: partial openItemCounts fails OPEN and still posts', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  const rows = JSON.stringify([
    {
      session: {
        id: sessionId,
        systemId: 'claude-workflow',
        externalId: sessionId,
        title: 't',
        phase: 'pr',
        lifecycle: 'active',
        parentId: null,
      },
      openItemCount: 1,
      openItemCounts: { question: 1 },
    },
  ])
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    rows,
    '{"itemId":"item-failopen-partial"}'
  )
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemAdd('approval', 'Ready?'))
  })

  assert.equal(stderrOut, '', 'no refusal and no board-read warning — this read succeeded')
  assert.equal(stdoutOut, '{"itemId":"item-failopen-partial"}\n', 'itemId printed to stdout')
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session list')),
    'the guard actually read the board — this is fail-open on the parsed result, not a skipped read'
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add was actually called'
  )
  assert.deepEqual(loadState(sessionId)!.openItemIds, ['item-failopen-partial'], 'posted anyway')
  assert.equal(exitCodeIsError(), false, 'no error exit')
})

// A negative count is malformed the same way a missing key is — isCount requires a non-negative
// integer, not merely Number.isFinite — this pins the tightening on the path that actually consumes
// it (the guard), not just on the parser in isolation (status.test.ts covers that half).
test('runItemAdd approval: negative openItemCounts value fails OPEN and still posts', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 1, { question: -1, approval: 0, comment: 0 }),
    '{"itemId":"item-failopen-negative"}'
  )
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemAdd('approval', 'Ready?'))
  })

  assert.equal(stderrOut, '', 'no refusal — a negative count is unknown, not a legitimate count')
  assert.equal(stdoutOut, '{"itemId":"item-failopen-negative"}\n', 'itemId printed to stdout')
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session list')),
    'the guard actually read the board — this is fail-open on the parsed result, not a skipped read'
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add was actually called'
  )
  assert.deepEqual(loadState(sessionId)!.openItemIds, ['item-failopen-negative'], 'posted anyway')
  assert.equal(exitCodeIsError(), false, 'no error exit')
})

// A non-integer is malformed the same way a negative one is — isCount requires
// Number.isInteger too, not just n >= 0 — pinned here on the path that actually consumes it (the
// guard), mirroring the negative-count test above; status.test.ts covers the parser in isolation.
test('runItemAdd approval: non-integer openItemCounts value fails OPEN and still posts', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 1, { question: 1.5, approval: 0, comment: 0 }),
    '{"itemId":"item-failopen-fractional"}'
  )
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemAdd('approval', 'Ready?'))
  })

  assert.equal(stderrOut, '', 'no refusal — a non-integer count is unknown, not a legitimate count')
  assert.equal(stdoutOut, '{"itemId":"item-failopen-fractional"}\n', 'itemId printed to stdout')
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session list')),
    'the guard actually read the board — this is fail-open on the parsed result, not a skipped read'
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add was actually called'
  )
  assert.deepEqual(loadState(sessionId)!.openItemIds, ['item-failopen-fractional'], 'posted anyway')
  assert.equal(exitCodeIsError(), false, 'no error exit')
})

// Fail-open, all three uncertain outcomes. A guard that blocked here would strand the workflow at
// the moment the user most needs to hear from it.
test('runItemAdd approval: unreachable board fails OPEN and still posts', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  const path = join(tmpDir, 'ai-workflow-app')
  writeFileSync(
    path,
    `#!/usr/bin/env bash\n` +
      `echo "$@" >> ${JSON.stringify(join(tmpDir, 'calls.log'))}\n` +
      `if [ "$1" = "session" ] && [ "$2" = "list" ]; then echo "board down" >&2; exit 1; fi\n` +
      `echo '{"itemId":"item-failopen"}'\nexit 0\n`
  )
  chmodSync(path, 0o755)
  process.env.AI_WORKFLOW_APP_BIN = path
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemAdd('approval', 'Ready?'))
  })

  assert.ok(
    stderrOut.includes('board down'),
    'the quiet board read still warns on stderr — it just does not poison the exit code'
  )
  assert.equal(stdoutOut, '{"itemId":"item-failopen"}\n', 'itemId printed to stdout')
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session list')),
    'the guard actually attempted the board read that then failed'
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add was actually called'
  )
  assert.deepEqual(loadState(sessionId)!.openItemIds, ['item-failopen'], 'posted anyway')
  assert.equal(
    exitCodeIsError(),
    false,
    'a failed guard read must NOT report failure for an item that was actually posted'
  )
})

test('runItemAdd approval: unparseable session list fails OPEN and still posts', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    'not json at all',
    '{"itemId":"item-unparseable"}'
  )
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemAdd('approval', 'Ready?'))
  })

  assert.equal(
    stderrOut,
    '',
    'no refusal — the invalid JSON is silently treated as unknown, not surfaced as a warning'
  )
  assert.equal(stdoutOut, '{"itemId":"item-unparseable"}\n', 'itemId printed to stdout')
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session list')),
    'the guard actually read the board — the unparseable payload is fail-open, not a skipped read'
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add was actually called'
  )
  assert.deepEqual(loadState(sessionId)!.openItemIds, ['item-unparseable'], 'posted anyway')
  assert.equal(exitCodeIsError(), false, 'no error exit')
})

test('runItemAdd approval: node absent from the board fails OPEN and still posts', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(tmpDir, '[]', '{"itemId":"item-absent"}')
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemAdd('approval', 'Ready?'))
  })

  assert.equal(stderrOut, '', 'no refusal — an absent node is silently unknown, not a warning')
  assert.equal(stdoutOut, '{"itemId":"item-absent"}\n', 'itemId printed to stdout')
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session list')),
    'the guard actually read the board — the absent node is fail-open, not a skipped read'
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add was actually called'
  )
  assert.deepEqual(loadState(sessionId)!.openItemIds, ['item-absent'], 'posted anyway')
  assert.equal(exitCodeIsError(), false, 'no error exit')
})

// A missing CLAUDE_CODE_SESSION_ID is a fail-open case too: boardOpenItemCount's own
// tryResolveRawSessionId() call has nothing to scope a board read to, and returns null before ever
// invoking findBoardNodeFor — no session list call is made at all. Exercised via an explicit
// --session (resolveSessionTarget accepts one even with no ambient session id).
test('runItemAdd approval: missing CLAUDE_CODE_SESSION_ID fails OPEN, no board read attempted', () => {
  delete process.env.CLAUDE_CODE_SESSION_ID
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"item-no-env"}')

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() =>
      runItemAdd('approval', 'Ready?', { session: 'explicit-node-no-env' })
    )
  })

  assert.equal(stderrOut, '', 'no refusal — an unresolvable session id is unknown, not a warning')
  assert.equal(stdoutOut, '{"itemId":"item-no-env"}\n', 'itemId printed to stdout')
  assert.equal(
    readCalls(tmpDir).some((c) => c.includes('session list')),
    false,
    'the guard never attempts a board read without a raw session id to scope it to'
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add was actually called'
  )
  assert.deepEqual(
    loadState('explicit-node-no-env')!.openItemIds,
    ['item-no-env'],
    'itemId recorded in the ledger under the explicit session id'
  )
  assert.equal(exitCodeIsError(), false, 'no error exit')
})

// Every guard test above uses a single-row board payload, which cannot distinguish "matched the
// right node" from "matched whatever row came back" — a guard that just checked "does any row on
// the board report an open question" would pass every test above by accident. A two-row board with
// opposite counts is what actually pins the match to the targeted node's id.
test('runItemAdd approval: a two-row board matches by node id, not by any row', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  const twoRowBoard = boardRow(
    'node-k1',
    1,
    { question: 1, approval: 0, comment: 0 },
    `${sessionId}:K1`
  )
  const twoRows = JSON.stringify([
    ...JSON.parse(twoRowBoard),
    ...JSON.parse(
      boardRow('node-k2', 0, { question: 0, approval: 0, comment: 0 }, `${sessionId}:K2`)
    ),
  ])
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(tmpDir, twoRows, '{"itemId":"item-k2"}')
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

  let k1StdoutOut = ''
  const k1StderrOut = captureStderr(() => {
    k1StdoutOut = captureStdout(() => runItemAdd('approval', 'Ready?', { key: 'K1' }))
  })
  assert.ok(
    k1StderrOut.includes('refusing to post an approval'),
    'K1 refused for its OWN open question, even though K2 is on the same board payload'
  )
  assert.equal(k1StdoutOut, '', 'K1: nothing printed on stdout — no itemId to report')
  assert.equal(loadState('node-k1'), null, 'K1: nothing recorded in the K1 ledger')

  let k2StdoutOut = ''
  const k2StderrOut = captureStderr(() => {
    k2StdoutOut = captureStdout(() => runItemAdd('approval', 'Ready?', { key: 'K2' }))
  })
  assert.equal(
    k2StderrOut,
    '',
    'K2 posts — its own row reports no open question, regardless of K1s'
  )
  assert.equal(k2StdoutOut, '{"itemId":"item-k2"}\n', 'K2: itemId printed to stdout')
  assert.deepEqual(
    loadState('node-k2')!.openItemIds,
    ['item-k2'],
    'K2: itemId recorded in the K2 ledger'
  )
  assert.equal(
    readCalls(tmpDir).filter((c) => c.includes('item add')).length,
    1,
    'only the K2 call reached item add'
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('session list')),
    'the guard actually read the board — the header claims this column is always asserted'
  )
})

// ---------------------------------------------------------------------------
// Tests: the question gate (FLOW-249) — composeQuestionPrompt via runItemAdd
// ---------------------------------------------------------------------------

/** Registers a root node and wires a stub that would post successfully if ever invoked — so a
 * refusal test can assert the stub was never reached, not merely that stdout was empty. */
const setUpQuestionStub = (): { sessionId: string } => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"should-not-post"}')
  registerRootNode(sessionId)
  return { sessionId }
}

/** Runs `fn`, asserting the shape every refusal in this section must have: nothing on stdout, an
 * error exit code, the stub never invoked, and the local ledger untouched. Returns stderr for the
 * caller's own message assertions. */
const assertRefused = (sessionId: string, fn: () => void): string => {
  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(fn)
  })
  assert.equal(stdoutOut, '', 'nothing printed on stdout — no itemId to report')
  assert.equal(exitCodeIsError(), true, 'error exit code set')
  assert.equal(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    false,
    'item add was never called'
  )
  assert.equal(loadState(sessionId), null, 'nothing recorded in the local ledger')
  return stderrOut
}

/** Reads the raw calls.log content, unsplit — a composed multi-line prompt embeds its own
 * newlines, so the line-per-call convention `readCalls` uses would break apart a single call. Used
 * only by the composition tests below, which need the byte-exact --prompt argument the stub
 * received. */
const readRawLog = (dir: string): string => {
  const log = join(dir, 'calls.log')
  return existsSync(log) ? readFileSync(log, 'utf-8') : ''
}

/** Extracts the exact --prompt value from a single logged `item add` call, given the fixed argv
 * prefix before it, and strips the trailing newline `echo` appends to the whole line. */
const extractPromptArg = (rawLog: string, prefix: string): string => {
  assert.ok(rawLog.startsWith(prefix), `call starts with the expected argv prefix: ${prefix}`)
  return rawLog.slice(prefix.length).replace(/\n$/, '')
}

// The refusal's constant prefix ("every --type question must declare --recommend, --stalls and
// --why-mine") names all three flags regardless of which are actually missing, so the assertion
// pins the computed tail after "— missing", not just the flag name's presence anywhere on stderr —
// a mutation that hardcodes the `missing` enumeration would still satisfy a bare `.includes('--recommend')`.
test('question gate: missing --recommend is refused, stderr names it', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', { stalls: 'none', whyMine: 'scope' })
  )
  assert.ok(
    stderrOut.includes('missing --recommend.'),
    'stderr computes exactly --recommend as missing'
  )
  assert.ok(
    !stderrOut.includes('missing --recommend, '),
    'does not also enumerate --stalls or --why-mine'
  )
})

test('question gate: missing --stalls is refused, stderr names it', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', { recommend: 'Ship it', whyMine: 'scope' })
  )
  assert.ok(stderrOut.includes('missing --stalls.'), 'stderr computes exactly --stalls as missing')
  assert.ok(!stderrOut.includes('missing --recommend'), 'does not also enumerate --recommend')
})

test('question gate: missing --why-mine is refused, stderr names it', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', { recommend: 'Ship it', stalls: 'none' })
  )
  assert.ok(
    stderrOut.includes('missing --why-mine.'),
    'stderr computes exactly --why-mine as missing'
  )
  assert.ok(!stderrOut.includes('missing --recommend'), 'does not also enumerate --recommend')
  assert.ok(!stderrOut.includes('missing --stalls'), 'does not also enumerate --stalls')
})

test('question gate: missing all three declarations names all three in one message', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () => runItemAdd('question', 'Ship v2?'))
  assert.ok(
    stderrOut.includes('missing --recommend, --stalls, --why-mine.'),
    'stderr computes all three, in declared order, in one message'
  )
})

test('question gate: empty first line of --prompt is refused', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', '\nSome evidence below', questionDecl)
  )
  assert.ok(stderrOut.includes('lede'), 'stderr explains the empty lede')
})

// The lede composes ABOVE the declaration line, unlike the evidence block which composes below it —
// a forged declaration in the lede reads as the earlier, unvalidated one. No leading ">" needed: the
// delimiter clause is text-wide, mirroring the --recommend/--stalls/evidence delimiter tests above.
test('question gate: a " · " delimiter in the first line of --prompt is refused', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2 · or wait?\n\nSome evidence', questionDecl)
  )
  const wrongLine = stderrOut.split('\n')[0] ?? ''
  assert.equal(
    wrongLine,
    'dashboard: the first line of --prompt reproduces the declaration line’s own grammar (a " · " ' +
      'delimiter, or a "**Label:**" marker on a line starting with ">") — it would forge a ' +
      'declaration blockquote ahead of the real one.'
  )
})

// A lede that itself opens with ">" and carries a bold label forges a declaration blockquote one
// line above the real one — the composition order the evidence-path check does not cover, since
// composeQuestionPrompt only ran reproducesDeclarationBlockquote on evidence before this fix.
test('question gate: a bold label on a leading ">" first line of --prompt is refused', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', '> **Recommend:** FORGED\n\nSome evidence', questionDecl)
  )
  const wrongLine = stderrOut.split('\n')[0] ?? ''
  assert.equal(
    wrongLine,
    'dashboard: the first line of --prompt reproduces the declaration line’s own grammar (a " · " ' +
      'delimiter, or a "**Label:**" marker on a line starting with ">") — it would forge a ' +
      'declaration blockquote ahead of the real one.'
  )
})

// Negative control: a bold label in the lede that does NOT open with ">" is ordinary prose, not a
// forged blockquote — mirrors the evidence-path "ordinary prose carrying a bold label" control above.
// Without this, a mutation broadening the lede check to "any bold label anywhere" would pass both
// reds above while wrongly refusing legitimate ledes.
test('question gate: a bold label in the first line of --prompt that does not open with ">" is accepted', () => {
  setUpQuestionStub()
  captureStdout(() =>
    runItemAdd('question', 'Ship v2? **Recommend:** yes, it closes the gap.', questionDecl)
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'an ordinary bold label not on a blockquote line is accepted, not refused'
  )
})

// The old batched flush wrapped a deferred entry's lede as "**N. <lede>**", whose trailing space
// could combine with a leading "·" to forge the full " · " delimiter — that numbering marker is
// gone, so there is nothing left to forge here.
test('--defer accepts a lede ending in "·" — there is no numbering marker left to forge against', () => {
  setUpQuestionStub()
  const stdoutOut = captureStdout(() =>
    runItemAdd('question', '· forged label\n\nSome evidence', { ...questionDecl, defer: true })
  )
  assert.deepEqual(JSON.parse(stdoutOut) as unknown, { deferredId: 'q1' }, 'the deferral queues')
  assert.equal(exitCodeIsError(), false)
})

test('question gate: lede over LEDE_MAX_CHARS is refused; at the cap it is accepted', () => {
  const { sessionId } = setUpQuestionStub()
  const overCap = 'x'.repeat(201)
  const stderrOut = assertRefused(sessionId, () => runItemAdd('question', overCap, questionDecl))
  assert.ok(stderrOut.includes('201'), 'stderr states the actual length')

  const atCap = 'x'.repeat(200)
  captureStdout(() => runItemAdd('question', atCap, questionDecl))
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'at exactly the cap, the question is accepted'
  )
})

// Same code-point-vs-UTF-16 site as --recommend below, pinned independently here: 101 emoji is 101
// code points but 202 UTF-16 code units, so this stays under the 200-character lede cap.
test('question gate: lede of 101 surrogate-pair emoji is accepted under the 200-character cap', () => {
  setUpQuestionStub()
  const emojiLede = '🚀'.repeat(101)
  captureStdout(() => runItemAdd('question', emojiLede, questionDecl))
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    '101 emoji (202 UTF-16 code units, 101 code points) is accepted, not refused'
  )
})

test('question gate: --recommend over RECOMMEND_MAX_CHARS is refused; at the cap it is accepted', () => {
  const { sessionId } = setUpQuestionStub()
  const overCap = 'x'.repeat(201)
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', { ...questionDecl, recommend: overCap })
  )
  assert.ok(stderrOut.includes('201'), 'stderr states the actual length')

  const atCap = 'x'.repeat(200)
  captureStdout(() => runItemAdd('question', 'Ship v2?', { ...questionDecl, recommend: atCap }))
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'at exactly the cap, the question is accepted'
  )
})

// 101 emoji is 101 code points but 202 UTF-16 code units (each emoji is a surrogate pair) — the cap
// is measured in code points, so this stays under the 200-character cap and is accepted.
test('question gate: --recommend of 101 surrogate-pair emoji is accepted under the 200-character cap', () => {
  setUpQuestionStub()
  const emojiRecommend = '🚀'.repeat(101)
  captureStdout(() =>
    runItemAdd('question', 'Ship v2?', { ...questionDecl, recommend: emojiRecommend })
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    '101 emoji (202 UTF-16 code units, 101 code points) is accepted, not refused'
  )
})

test('question gate: --stalls over STALLS_MAX_CHARS is refused; at the cap it is accepted', () => {
  const { sessionId } = setUpQuestionStub()
  const overCap = 'x'.repeat(201)
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', { ...questionDecl, stalls: overCap })
  )
  assert.ok(stderrOut.includes('201'), 'stderr states the actual length')

  const atCap = 'x'.repeat(200)
  captureStdout(() => runItemAdd('question', 'Ship v2?', { ...questionDecl, stalls: atCap }))
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'at exactly the cap, the question is accepted'
  )
})

// Same code-point-vs-UTF-16 site as --recommend above, pinned independently here.
test('question gate: --stalls of 101 surrogate-pair emoji is accepted under the 200-character cap', () => {
  setUpQuestionStub()
  const emojiStalls = '🚀'.repeat(101)
  captureStdout(() => runItemAdd('question', 'Ship v2?', { ...questionDecl, stalls: emojiStalls }))
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    '101 emoji (202 UTF-16 code units, 101 code points) is accepted, not refused'
  )
})

test('question gate: composed prompt over COMPOSED_PROMPT_MAX_CHARS is refused with the actual length; at the cap it is accepted', () => {
  const { sessionId } = setUpQuestionStub()
  const lede = 'Ship v2?'
  const recommend = 'Yes, ship it'
  const stalls = 'none'
  const whyMine = 'scope' as const
  const declaration = `> **Recommend:** ${recommend} · **Stalls:** ${stalls} · **Yours because:** ${whyMine}`
  const base = lede.length + 2 + declaration.length + 2
  const capEvidence = 'e'.repeat(1500 - base)
  const overCapEvidence = 'e'.repeat(1501 - base)

  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', `${lede}\n\n${overCapEvidence}`, { recommend, stalls, whyMine })
  )
  assert.ok(stderrOut.includes('1501'), 'stderr states the actual composed length')

  captureStdout(() =>
    runItemAdd('question', `${lede}\n\n${capEvidence}`, { recommend, stalls, whyMine })
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'at exactly the cap, the question is accepted'
  )
})

// Same code-point-vs-UTF-16 site as --recommend above, pinned independently at the composed-prompt
// site: the evidence is exactly 1500 code points (accepted) but its UTF-16 length is far over 1500,
// so a reversion to `.length` would wrongly refuse this.
test('question gate composition: composed prompt evidence at the code-point cap but well over 1500 UTF-16 units is accepted', () => {
  setUpQuestionStub()
  const lede = 'Ship v2?'
  const recommend = 'Yes, ship it'
  const stalls = 'none'
  const whyMine = 'scope' as const
  const declaration = `> **Recommend:** ${recommend} · **Stalls:** ${stalls} · **Yours because:** ${whyMine}`
  const base = lede.length + 2 + declaration.length + 2
  const emojiEvidence = '🚀'.repeat(1500 - base)

  captureStdout(() =>
    runItemAdd('question', `${lede}\n\n${emojiEvidence}`, { recommend, stalls, whyMine })
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'composed prompt is exactly 1500 code points but well over 1500 UTF-16 units, and is accepted'
  )
})

test('question gate: --defer requires --stalls none', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Defer this?', {
      recommend: 'Do it later',
      stalls: 'the merge',
      whyMine: 'scope',
      defer: true,
    })
  )
  assert.ok(stderrOut.includes('--stalls none'), 'stderr names the required value')
})

test('question gate: --defer on --type approval is refused', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('approval', 'Ready?', { defer: true })
  )
  assert.ok(
    stderrOut.includes('--defer only applies to --type question'),
    'stderr names the mismatch'
  )
})

// The rationale sentence below the refusal line also names all three flags unconditionally ("--
// recommend, --stalls and --why-mine declare why a QUESTION is the user's..."), so a bare
// `.includes('--recommend')` on the whole stderr is satisfied even by a mutant that hardcodes
// `questionOnly`. Asserting the enumerated first line exactly pins both the enumeration and the
// plural "apply" branch — the file already uses this pattern correctly for other refusal lines.
test('question gate: --recommend/--stalls/--why-mine on --type approval are refused, not silently dropped', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () => runItemAdd('approval', 'Ready?', questionDecl))
  const wrongLine = stderrOut.split('\n')[0] ?? ''
  assert.equal(
    wrongLine,
    'dashboard: --recommend, --stalls, --why-mine only apply to --type question — this item is --type approval.'
  )
})

test('question gate: a single question-only flag on --type approval is refused, its own line naming only that one', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('approval', 'Ready?', { recommend: 'Ship it' })
  )
  const wrongLine = stderrOut.split('\n')[0] ?? ''
  assert.equal(
    wrongLine,
    'dashboard: --recommend only applies to --type question — this item is --type approval.'
  )
})

test('question gate: empty-string --recommend is refused the same as a missing one', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', { recommend: '', stalls: 'none', whyMine: 'scope' })
  )
  assert.ok(
    stderrOut.includes('missing --recommend.'),
    'stderr computes exactly --recommend as missing'
  )
  assert.ok(
    !stderrOut.includes('missing --recommend, '),
    'does not also enumerate --stalls or --why-mine'
  )
})

test('question gate: empty-string --stalls is refused the same as a missing one', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', { recommend: 'Ship it', stalls: '', whyMine: 'scope' })
  )
  assert.ok(stderrOut.includes('missing --stalls.'), 'stderr computes exactly --stalls as missing')
  assert.ok(!stderrOut.includes('missing --recommend'), 'does not also enumerate --recommend')
})

test('question gate: whitespace-only --recommend is refused the same as an empty one', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', { recommend: '   ', stalls: 'none', whyMine: 'scope' })
  )
  assert.ok(
    stderrOut.includes('missing --recommend.'),
    'stderr computes exactly --recommend as missing'
  )
  assert.ok(
    !stderrOut.includes('missing --recommend, '),
    'does not also enumerate --stalls or --why-mine'
  )
})

test('question gate: whitespace-only --stalls is refused the same as an empty one', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', { recommend: 'Ship it', stalls: '   ', whyMine: 'scope' })
  )
  assert.ok(stderrOut.includes('missing --stalls.'), 'stderr computes exactly --stalls as missing')
  assert.ok(!stderrOut.includes('missing --recommend'), 'does not also enumerate --recommend')
})

// --recommend and --stalls are free text interpolated into the declaration blockquote — an
// embedded newline in either splits the blockquote the function's own comment calls a stable
// machine-readable contract.
test('question gate: a newline embedded in --recommend is refused, stderr names --recommend', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', {
      recommend: 'Ship it\nfor real',
      stalls: 'none',
      whyMine: 'scope',
    })
  )
  assert.ok(stderrOut.includes('--recommend'), 'stderr names --recommend')
})

test('question gate: a newline embedded in --stalls is refused, stderr names --stalls', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', {
      recommend: 'Ship it',
      stalls: 'the\nmerge',
      whyMine: 'scope',
    })
  )
  assert.ok(stderrOut.includes('--stalls'), 'stderr names --stalls')
})

// CommonMark line endings are \n, \r, and \r\n — a bare \r renders byte-identical to \n once the
// composed prompt reaches the markdown renderer, so all three are refused alike.
test('question gate: --recommend carrying \\r\\n is refused the same as a bare \\n', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', {
      recommend: 'Ship it\r\nfor real',
      stalls: 'none',
      whyMine: 'scope',
    })
  )
  assert.ok(stderrOut.includes('--recommend'), 'stderr names --recommend')
})

test('question gate: a lone \\r (no \\n) in --recommend is refused the same as an embedded \\n', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', {
      recommend: 'Ship it\rfor real',
      stalls: 'none',
      whyMine: 'scope',
    })
  )
  assert.ok(stderrOut.includes('--recommend'), 'stderr names --recommend')
})

// The declaration line composes recommend/stalls/whyMine as three bold-labeled fields joined by
// " · " — a value carrying that same delimiter extends the real line with a field the CLI never
// validated. No bold label in the value, so the bold-label clause cannot absorb this: only the
// delimiter clause can be catching it.
test('question gate: a " · " delimiter embedded in --recommend is refused, stderr names --recommend', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', {
      recommend: 'Ship it · move fast',
      stalls: 'none',
      whyMine: 'scope',
    })
  )
  const wrongLine = stderrOut.split('\n')[0] ?? ''
  assert.equal(wrongLine, RECOMMEND_GRAMMAR_WRONG_LINE)
})

// The boundary case the full-delimiter check above misses: a value ending in a bare "·" never
// contains the 3-character " · " sequence itself, but combines with the literal " · " the composer
// inlines right after --recommend to forge a second occurrence, splitting the **Stalls:** field —
// verified pre-fix: --recommend 'A ·' composed into
// "> **Recommend:** A · · **Stalls:** none · ...", which splits on " · " into
// ['> **Recommend:** A', '· **Stalls:** none', ...].
test('question gate: --recommend ending in a bare "·" is refused, not just the full " · " delimiter', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', {
      recommend: 'A ·',
      stalls: 'none',
      whyMine: 'scope',
    })
  )
  const wrongLine = stderrOut.split('\n')[0] ?? ''
  assert.equal(wrongLine, RECOMMEND_GRAMMAR_WRONG_LINE)
})

// Symmetric case for --stalls: a value STARTING in a bare "·" combines with the literal " · " the
// composer inlines right before --stalls to forge a second occurrence, this time splitting the
// **Recommend:** field instead.
test('question gate: --stalls starting with a bare "·" is refused, not just the full " · " delimiter', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', {
      recommend: 'Ship it',
      stalls: '· the merge',
      whyMine: 'scope',
    })
  )
  const wrongLine = stderrOut.split('\n')[0] ?? ''
  assert.equal(wrongLine, STALLS_GRAMMAR_WRONG_LINE)
})

// The bare-edge check above compares against the literal "·" byte, so it needs the same NFKC
// equivalence the full-delimiter check gets: U+0387 GREEK ANO TELEIA decomposes to U+00B7 and reads
// identically to it, but forms no 3-character " · " sequence when it sits alone at the value's edge
// (no trailing space follows it), so the full-delimiter check above does not catch it — only
// edgeDot's own normalization does.
test('question gate: --recommend ending in a bare U+0387 (canonically equivalent to "·") is refused', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', {
      recommend: 'Ship it ·',
      stalls: 'none',
      whyMine: 'scope',
    })
  )
  const wrongLine = stderrOut.split('\n')[0] ?? ''
  assert.equal(wrongLine, RECOMMEND_GRAMMAR_WRONG_LINE)
})

// The equivalence bypass, arm 1 (NFC): U+0387 GREEK ANO TELEIA has a canonical decomposition to
// U+00B7, the delimiter's own character — visually indistinguishable from it in any renderer. Raw,
// the value contains none of the checks' literal " · "/"·" bytes; composed and re-parsed it reads
// exactly like the bare-"·" case above: "> **Recommend:** Ship it · move fast · **Stalls:** none ·
// ...", splitting on " · " into an extra field. Isolates the NFC half of the normalization clause —
// this value needs no compatibility (NFKC-only) mapping to surface as the delimiter.
test('question gate: --recommend carrying U+0387 (canonically equivalent to the delimiter) is refused', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', {
      recommend: 'Ship it \u0387 move fast',
      stalls: 'none',
      whyMine: 'scope',
    })
  )
  const wrongLine = stderrOut.split('\n')[0] ?? ''
  assert.equal(wrongLine, RECOMMEND_GRAMMAR_WRONG_LINE)
})

// The equivalence bypass, arm 2 (NFKC): U+00A0 (no-break space) wrapping the real delimiter
// character (rendered here as NBSP-middot-NBSP) reads identically to a plain " · " in any renderer, but NFC
// alone leaves U+00A0 untouched; only NFKC's compatibility mappings fold it to a plain space. A
// mutation that reverted the normalization call to NFC (rather than dropping it) would pass the
// U+0387 test above and fail only this one — proving the two arms independently, not as one
// combined revert.
test('question gate: --recommend carrying a no-break-space-wrapped delimiter is refused', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', {
      recommend: 'Ship it\u00A0·\u00A0move fast',
      stalls: 'none',
      whyMine: 'scope',
    })
  )
  const wrongLine = stderrOut.split('\n')[0] ?? ''
  assert.equal(wrongLine, RECOMMEND_GRAMMAR_WRONG_LINE)
})

// Negative control for both arms above: U+30FB KATAKANA MIDDLE DOT decomposes under neither NFC nor
// NFKC and is not the declaration's delimiter character, so it must keep posting normally. Without
// this, a mutation broadening the check to "any dot-like character" would pass every refusal test
// above while wrongly refusing legitimate CJK text.
test('question gate: --recommend carrying U+30FB (katakana middle dot, not delimiter-equivalent) is accepted', () => {
  setUpQuestionStub()
  captureStdout(() =>
    runItemAdd('question', 'Ship v2?', { ...questionDecl, recommend: 'Ship it \u30FB move fast' })
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'katakana middle dot is accepted, not refused'
  )
})

// The normalization scope claim, proven directly: U+00A0 alone in prose (no middle dot anywhere)
// folds to a plain space under NFKC, same as the delimiter check applies to arm 2 above, but this
// value is not delimiter-forging and must be accepted. The check comparing a normalized copy is not
// enough by itself — a mutation that normalized the composed value in place (instead of only the
// comparison copy) would still pass every refusal test, since those never reach compose, and would
// still pass the U+30FB acceptance test above, since U+30FB survives NFKC unchanged either way. Only
// asserting the byte-exact posted prompt still carries the original U+00A0 catches that mutation.
test('question gate: --recommend carrying a bare no-break space (not delimiter-forging) posts with the original codepoint intact', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"item-1"}')
  registerRootNode(sessionId)

  captureStdout(() =>
    runItemAdd('question', 'Ship v2?', {
      recommend: 'Ship\u00A0it now',
      stalls: 'none',
      whyMine: 'scope',
    })
  )

  const prefix = `item add --session ${sessionId} --type question --prompt `
  const promptArg = extractPromptArg(readRawLog(tmpDir), prefix)
  assert.equal(
    promptArg,
    'Ship v2?\n\n> **Recommend:** Ship\u00A0it now · **Stalls:** none · **Yours because:** scope',
    "the posted prompt keeps the asker's own U+00A0, not NFKC's folded U+0020"
  )
})

test('question gate: a "**Label:**" marker embedded in --recommend is refused even without the delimiter', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', {
      recommend: 'See **Note:** ship it',
      stalls: 'none',
      whyMine: 'scope',
    })
  )
  const wrongLine = stderrOut.split('\n')[0] ?? ''
  assert.equal(wrongLine, RECOMMEND_GRAMMAR_WRONG_LINE)
})

// Bold-label equivalence bypass, field path: U+FF1A FULLWIDTH COLON folds to ASCII ':' under NFKC
// (compatibility decomposition), so a value like "See **Note：** ship it" reads as a forged bold
// label in any renderer but contained none of BOLD_LABEL_PATTERN's literal ':' bytes before the
// bold-label clause was normalized too. Isolates the bold-label clause from the delimiter clause —
// no " · " anywhere in this value.
test('question gate: --recommend carrying a fullwidth-colon bold label (U+FF1A, equivalent to ":") is refused', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', {
      recommend: 'See **Note\uFF1A** ship it',
      stalls: 'none',
      whyMine: 'scope',
    })
  )
  const wrongLine = stderrOut.split('\n')[0] ?? ''
  assert.equal(wrongLine, RECOMMEND_GRAMMAR_WRONG_LINE)
})

// Negative control for the bold-label equivalence bypass: U+A789 MODIFIER LETTER COLON decomposes
// under neither NFC nor NFKC, so a label using it is not a forged bold label and must be accepted.
// Without this, a mutation broadening the bold-label check to "any colon-like character" would pass
// every refusal test above while wrongly refusing legitimate text.
test('question gate: --recommend carrying U+A789 (modifier letter colon, not ":"-equivalent) is accepted', () => {
  setUpQuestionStub()
  captureStdout(() =>
    runItemAdd('question', 'Ship v2?', { ...questionDecl, recommend: 'See **Note\uA789** ship it' })
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'modifier letter colon is accepted, not refused'
  )
})

// No bold label in the value — isolates the delimiter clause from the stalls value, mirroring the
// --recommend delimiter test above.
test('question gate: a " · " delimiter embedded in --stalls is refused, stderr names --stalls', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?', {
      recommend: 'Ship it',
      stalls: 'the merge · something else',
      whyMine: 'scope',
    })
  )
  assert.ok(stderrOut.includes('--stalls'), 'stderr names --stalls')
})

// A bold label on a line that OPENS the evidence as a blockquote (leading ">") forges a declaration
// — refused. No " · " in the value, so only the blockquote-scoped bold-label clause can be catching
// this.
test('question gate: a bold label on a blockquote line in the evidence is refused, not silently posted as a second declaration', () => {
  const { sessionId } = setUpQuestionStub()
  const forgedBlockquote = '> **Recommend:** FORGED'
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', `Ship v2?\n\n${forgedBlockquote}`, {
      recommend: 'do it',
      stalls: 'none',
      whyMine: 'scope',
    })
  )
  assert.ok(stderrOut.includes('declaration'), 'stderr explains the declaration-grammar collision')
})

// Bold-label equivalence bypass, evidence path: same U+FF1A as the --recommend test above, but
// driving a blockquote line in --prompt evidence. The bold-label clause in
// reproducesDeclarationBlockquote is a separate call site from reproducesDeclarationGrammar's — a
// mutation reverting only the evidence site's bold-label clause to raw text would pass the
// --recommend equivalence test above while missing this one.
test('question gate: a blockquote line in the evidence carrying a fullwidth-colon bold label is refused', () => {
  const { sessionId } = setUpQuestionStub()
  const forgedBlockquote = '> **Recommend\uFF1A** FORGED'
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', `Ship v2?\n\n${forgedBlockquote}`, {
      recommend: 'do it',
      stalls: 'none',
      whyMine: 'scope',
    })
  )
  assert.ok(stderrOut.includes('declaration'), 'stderr explains the declaration-grammar collision')
})

// Negative control for the evidence-path bold-label bypass: U+A789 stays accepted here too — the
// same character that must not trigger a false refusal in --recommend must not trigger one in a
// blockquote-opened evidence line either.
test('question gate: a blockquote line in the evidence carrying U+A789 (not ":"-equivalent) is accepted', () => {
  setUpQuestionStub()
  captureStdout(() =>
    runItemAdd('question', 'Ship v2?\n\n> **Recommend\uA789** not forged', questionDecl)
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'modifier letter colon in a blockquote line is accepted, not refused'
  )
})

// A " · " delimiter anywhere in the evidence is refused even with no bold label at all and no
// leading ">" — isolates the delimiter clause from the bold-label clause, mirroring the --recommend
// and --stalls delimiter tests above.
test('question gate: a " · " delimiter in the evidence is refused even without a bold label', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?\n\nPick one option · then proceed', {
      recommend: 'do it',
      stalls: 'none',
      whyMine: 'scope',
    })
  )
  assert.ok(stderrOut.includes('declaration'), 'stderr explains the declaration-grammar collision')
})

// The equivalence bypass, evidence path, arm 1 (NFC): same U+0387 as the --recommend test above, but
// driving --prompt evidence instead of a declaration field. reproducesDeclarationGrammar and
// reproducesDeclarationBlockquote are two separate call sites sharing normalizedForDelimiterCheck —
// a mutation reverting only the evidence site's includes() to raw text would pass the --recommend
// equivalence tests (that site stays normalized) while missing this one, so this path needs its own
// proof, not just the field-path one above.
test('question gate: a " · "-equivalent U+0387 in the evidence is refused even without a bold label', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?\n\nPick one option \u0387 then proceed', {
      recommend: 'do it',
      stalls: 'none',
      whyMine: 'scope',
    })
  )
  assert.ok(stderrOut.includes('declaration'), 'stderr explains the declaration-grammar collision')
})

// The equivalence bypass, evidence path, arm 2 (NFKC): same no-break-space-wrapped U+00B7 as the
// --recommend test above, driving --prompt evidence. If both this and the U+0387 evidence test above
// were satisfiable only once the evidence site was normalized at all, this one would prove nothing
// beyond that — isolating NFKC specifically requires the field-path pairing above to already show
// NFC-only leaves it green, which it does.
test('question gate: a no-break-space-wrapped delimiter in the evidence is refused even without a bold label', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('question', 'Ship v2?\n\nPick one option\u00A0·\u00A0then proceed', {
      recommend: 'do it',
      stalls: 'none',
      whyMine: 'scope',
    })
  )
  assert.ok(stderrOut.includes('declaration'), 'stderr explains the declaration-grammar collision')
})

// The forgery the evidence check exists to catch requires a leading ">" — ordinary prose carrying a
// bold label (exactly what dashboard-protocol.md §3 asks the evidence block to contain) is not a
// forged declaration and must be accepted, not refused.
test('question gate: a bold label in ordinary evidence prose (no leading ">") is accepted', () => {
  setUpQuestionStub()
  captureStdout(() =>
    runItemAdd('question', 'Ship v2?\n\n**Options:** A keeps the cap; B removes it.', questionDecl)
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'a bold label outside blockquote position is accepted, not refused'
  )
})

// The blank check trims --stalls, but the --defer-requires-stalls-none check compared the
// untrimmed value — refusing whitespace-padded "none" that should be accepted once normalized
// the same way the blank check normalizes it. --defer queues rather than posts (FLOW-250), so
// "accepted" here means the entry lands in the queue, not that the stub was called.
test('question gate: --defer --stalls " none " is accepted once --stalls is trimmed before the defer check', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"item-1"}')
  registerRootNode(sessionId)

  captureStdout(() =>
    runItemAdd('question', 'Defer this?', {
      recommend: 'Do it later',
      stalls: ' none ',
      whyMine: 'scope',
      defer: true,
    })
  )
  assert.equal(readCalls(tmpDir).length, 0, '--defer never calls the stub — it queues, not posts')
  const state = loadState(sessionId)
  assert.equal(
    state?.deferredQuestions?.length,
    1,
    '--stalls " none " is accepted after trimming, same as --stalls none — the entry is queued'
  )
})

test('--defer queues the question on node state instead of posting it', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"should-not-post"}')
  registerRootNode(sessionId)
  saveState(sessionId, { registered: true, phase: 'impl', openItemIds: [] })

  const stdoutOut = captureStdout(() =>
    runItemAdd('question', 'Should the retry live in the client or the caller?\n\nSome evidence.', {
      recommend: 'Fold it into the same PR',
      stalls: 'none',
      whyMine: 'scope',
      defer: true,
    })
  )

  assert.equal(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    false,
    '--defer never calls item add — it queues instead of posting'
  )
  const state = loadState(sessionId)
  assert.equal(state?.deferredQuestions?.length, 1, 'exactly one entry queued')
  const entry = state!.deferredQuestions![0]!
  assert.equal(entry.lede, 'Should the retry live in the client or the caller?')
  assert.equal(entry.recommend, 'Fold it into the same PR')
  assert.equal(entry.whyMine, 'scope')
  assert.equal(entry.deferredAtPhase, 'impl')
  assert.equal(stdoutOut.trim(), JSON.stringify({ deferredId: 'q1' }))
})

// The parentId-preservation class was swept for runItemAdd's own save (FLOW-136) but never
// enumerated across this branch's other new DashboardSessionState writers. queueDeferredQuestion
// spreads `...base` (state.ts's loaded state) rather than naming fields; this test is what pins
// that for this writer.
test('--defer preserves parentId on queueDeferredQuestion’s own save', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  const parentId = `${sessionId}-parent`
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"should-not-post"}')
  registerRootNode(sessionId)
  saveState(sessionId, { registered: true, phase: 'impl', openItemIds: [], parentId })

  captureStdout(() =>
    runItemAdd('question', 'Should the retry live in the client or the caller?', {
      ...questionDecl,
      defer: true,
      session: sessionId,
    })
  )

  assert.equal(
    loadState(sessionId)?.parentId,
    parentId,
    'parentId survives queueDeferredQuestion’s own save'
  )
})

// queueDeferredQuestion runs ahead of runItemAdd's own bin-resolve check (it queues instead of
// posting — see the comment on that early-return), so a stub that IS reachable is what's needed to
// reach queueDeferredQuestion's own resolveSessionTarget call. No node is registered, and the stub
// answers `session list` with an empty board, so resolveSessionTarget throws (session-id.ts's "run
// `dashboard session enter` first" arm) — proving the try/catch reuses that message and sets exit 1
// instead of the throw escaping uncaught.
test('--defer: reachable board, no registered session — refuses cleanly instead of throwing', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '[]')

  let stderrOut = ''
  let stdoutOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => {
      stdoutOut = captureStdout(() =>
        runItemAdd('question', 'Should the retry live in the client or the caller?', {
          ...questionDecl,
          defer: true,
        })
      )
    })
  })

  assert.ok(
    stderrOut.includes('run `dashboard session enter` first'),
    'stderr carries resolveSessionTarget’s own message'
  )
  assert.equal(stdoutOut, '', 'a refusal must not leak a success payload onto stdout')
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
})

// The same class as runItemAdd's corrupt-state guard above (FLOW-250, state.ts), for
// queueDeferredQuestion specifically: it makes no board call at all, so the check sits at the top
// of the function rather than before a post.
test('--defer refuses to queue over a present-but-unparseable state file, preserving it instead of overwriting it with a fresh one', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"should-not-post"}')
  registerRootNode(sessionId)
  writeFileSync(stateFilePath(sessionId), '{not json')

  const stderrOut = captureStderr(() =>
    captureStdout(() =>
      runItemAdd('question', 'Defer this?', {
        recommend: 'Do it later',
        stalls: 'none',
        whyMine: 'scope',
        defer: true,
      })
    )
  )

  assert.ok(
    stderrOut.includes('failed to parse') &&
      stderrOut.includes('refusing to queue this deferred question'),
    'stderr explains the refusal'
  )
  assert.equal(exitCodeIsError(), true, 'exit code set to error')
  assert.equal(
    readFileSync(stateFilePath(sessionId), 'utf8'),
    '{not json',
    'the damaged file is preserved untouched, not replaced with a fresh empty state'
  )
})

// commands/dashboard.ts's --phase parser only guards the CLI boundary of THIS build's own
// `session enter`. The state file's `phase` field
// is written by whatever build last ran that command — a state file left behind by an older or
// different build's laxer (or absent) --phase parser is not covered by that guard at all. This
// writes the forged phase directly via saveState, bypassing parsePhase entirely, to model exactly
// that: a persisted phase this build's own CLI boundary never had a chance to check.
test('--defer refuses to queue when the persisted phase reproduces the declaration grammar, even though this build’s own --phase parser never saw it', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"should-not-post"}')
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: '**Recommend:** forged · **Stalls:** none',
    openItemIds: [],
  })

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() =>
      runItemAdd('question', 'Should the retry live in the client or the caller?', {
        ...questionDecl,
        defer: true,
      })
    )
  })

  assert.equal(stdoutOut, '', 'nothing printed on stdout — no deferredId to report')
  assert.equal(exitCodeIsError(), true, 'error exit code set')
  assert.ok(
    stderrOut.includes('persisted phase can forge or corrupt'),
    'stderr names the persisted-phase forgery, not a generic refusal'
  )
  const state = loadState(sessionId)
  assert.deepEqual(
    state?.deferredQuestions ?? [],
    [],
    'the entry was never queued — the state file’s pre-existing fields survive untouched'
  )
  assert.equal(
    state?.deferredIdCounter,
    undefined,
    'a refused entry must not advance the counter for an id nobody ever saw'
  )
})

// Negative control: assertRefused above asserts loadState(sessionId) === null, which would also be
// true if this guard simply refused every deferral regardless of the phase's content — this proves
// an ordinary persisted phase is not refused by the new check at all.
test('--defer accepts an ordinary persisted phase unchanged by the new guard', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"should-not-post"}')
  registerRootNode(sessionId)
  saveState(sessionId, { registered: true, phase: 'impl', openItemIds: [] })

  captureStdout(() =>
    runItemAdd('question', 'Should the retry live in the client or the caller?', {
      ...questionDecl,
      defer: true,
    })
  )

  const state = loadState(sessionId)
  assert.equal(
    state?.deferredQuestions?.length,
    1,
    'the entry queued — the guard did not refuse it'
  )
  assert.equal(state!.deferredQuestions![0]!.deferredAtPhase, 'impl')
})

test('--defer refuses a question the posting path would refuse', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"should-not-post"}')
  registerRootNode(sessionId)

  let stdoutOutMissing = ''
  const stderrOutMissing = captureStderr(() => {
    stdoutOutMissing = captureStdout(() =>
      runItemAdd('question', 'Ship v2?', {
        recommend: 'Ship it',
        stalls: 'none',
        defer: true,
      })
    )
  })
  assert.equal(exitCodeIsError(), true, 'missing --why-mine exits with an error code')
  assert.ok(
    stderrOutMissing.startsWith(
      'dashboard: every --type question must declare --recommend, --stalls and --why-mine'
    ),
    'stderr carries the same refusal the posting path uses'
  )
  assert.equal(stdoutOutMissing, '', 'nothing succeeded on stdout')
  assert.equal(loadState(sessionId), null, 'nothing queued after the missing-flags refusal')

  resetExitCode()
  let stdoutOutStalls = ''
  const stderrOutStalls = captureStderr(() => {
    stdoutOutStalls = captureStdout(() =>
      runItemAdd('question', 'Ship v2?', {
        recommend: 'Ship it',
        stalls: 'something',
        whyMine: 'scope',
        defer: true,
      })
    )
  })
  assert.equal(exitCodeIsError(), true, '--stalls other than none exits with an error code')
  assert.ok(
    stderrOutStalls.includes('--defer requires --stalls none'),
    'stderr carries the --defer/--stalls-none refusal'
  )
  assert.equal(stdoutOutStalls, '', 'nothing succeeded on stdout')
  assert.equal(loadState(sessionId), null, 'nothing was ever queued on this node')
})

test('--defer refuses an entry that alone exceeds the composed cap', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"should-not-post"}')
  registerRootNode(sessionId)

  // Individually within cap (lede/--recommend/--stalls each ≤ 200), but the evidence block pushes
  // the composed single-question form well past COMPOSED_PROMPT_MAX_CHARS (1500).
  const evidence = 'x'.repeat(1600)
  const stderrOut = captureStderr(() =>
    captureStdout(() =>
      runItemAdd('question', `Ship v2?\n\n${evidence}`, {
        recommend: 'Ship it',
        stalls: 'none',
        whyMine: 'scope',
        defer: true,
      })
    )
  )
  assert.equal(exitCodeIsError(), true, 'over-cap entry exits with an error code')
  assert.ok(
    stderrOut.includes('composed for the flush, is over the') &&
      stderrOut.includes('character cap'),
    'stderr carries the flush-composed cap refusal — the defer-time check measures against ' +
      'composeDeferredEntry, not composeSingleQuestion, so it is a different message'
  )
  assert.equal(loadState(sessionId), null, 'the over-cap entry was never queued')
})

// n=1400: the immediate-post (composeSingleQuestion) shape composes to 1482 chars — under cap — but
// the flush (composeDeferredEntry) shape for the same entry, with a non-empty deferredAtPhase, adds
// the "Deferred at <phase>" line and composes to 1514 — over cap. This is the gap band (1387-1418
// for the evidence-only body) where the two shapes disagree: a guard that measured the single shape
// would queue this entry, and the flush would then refuse it forever.
test('--defer refuses an entry that fits the immediate-post shape but exceeds the flush shape — pins the guard to composeDeferredEntry, not composeSingleQuestion', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"should-not-post"}')
  registerRootNode(sessionId)
  saveState(sessionId, { registered: true, phase: 'implementation', openItemIds: [] })

  const evidence = 'x'.repeat(1400)
  const stderrOut = captureStderr(() =>
    captureStdout(() =>
      runItemAdd('question', `Ship v2?\n\n${evidence}`, {
        recommend: 'Ship it',
        stalls: 'none',
        whyMine: 'scope',
        defer: true,
      })
    )
  )
  assert.equal(exitCodeIsError(), true, 'an entry over the flush shape exits with an error code')
  assert.ok(
    stderrOut.includes('composed for the flush, is over the'),
    'the flush-shape refusal message — a guard measuring composeSingleQuestion would not refuse ' +
      'this entry at all, since its immediate-post shape is under cap'
  )
  assert.deepEqual(loadState(sessionId)?.deferredQuestions ?? [], [], 'the entry was never queued')
})

// The defer-time guard is `> COMPOSED_PROMPT_MAX_CHARS`. With deferredAtPhase 'implementation', n=1386
// composes the flush shape to exactly 1500 (the cap); n=1387 composes it to 1501. A guard mutated to
// `>=` would refuse the first too, so both sides of this exact boundary are asserted, not just gross
// over-cap behavior.
test('--defer: the flush shape is accepted at exactly the cap and refused one character over', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"should-not-post"}')
  registerRootNode(sessionId)
  saveState(sessionId, { registered: true, phase: 'implementation', openItemIds: [] })

  const atCap = captureStdout(() =>
    runItemAdd('question', `Ship v2?\n\n${'x'.repeat(1386)}`, {
      recommend: 'Ship it',
      stalls: 'none',
      whyMine: 'scope',
      defer: true,
    })
  )
  assert.equal(exitCodeIsError(), false, 'an entry composing to exactly the cap is accepted')
  assert.deepEqual(JSON.parse(atCap) as { deferredId?: string }, { deferredId: 'q1' })

  resetExitCode()
  const overCap = captureStderr(() =>
    captureStdout(() =>
      runItemAdd('question', `Ship v2?\n\n${'x'.repeat(1387)}`, {
        recommend: 'Ship it',
        stalls: 'none',
        whyMine: 'scope',
        defer: true,
      })
    )
  )
  assert.equal(exitCodeIsError(), true, 'one character over the cap is refused')
  assert.ok(overCap.includes('composed for the flush, is over the'))
  const queue = loadState(sessionId)?.deferredQuestions ?? []
  assert.deepEqual(
    queue.map((entry) => entry.id),
    ['q1'],
    'the over-cap entry was never queued'
  )

  // The refusal above must not have touched state at all — not just left the queue's own contents
  // alone, but never advanced the id counter either. A valid defer right after it gets the next
  // real id (q2), and q1 is still there: the refused attempt leaves no trace, not even a skipped id.
  resetExitCode()
  const nextValid = captureStdoutAssertingSuccess(() =>
    runItemAdd('question', 'A different, short question?', {
      recommend: 'Ship it',
      stalls: 'none',
      whyMine: 'scope',
      defer: true,
    })
  )
  assert.deepEqual(JSON.parse(nextValid) as { deferredId?: string }, { deferredId: 'q2' })
  const finalQueue = loadState(sessionId)?.deferredQuestions ?? []
  assert.deepEqual(
    finalQueue.map((entry) => entry.id),
    ['q1', 'q2'],
    'q1 survives the refused sibling attempt, and the next id issued is q2 — not recycled'
  )
})

// Negative control for the trim fix: normal single-line --recommend/--stalls, with no surrounding
// whitespace to strip, must still compose the exact declaration line the contract has always
// produced — so a future change to the trim logic (or the contract line itself) breaks loudly here.
test('question gate composition: normal single-line --recommend/--stalls compose the declaration byte-identically after the trim fix', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"item-1"}')
  registerRootNode(sessionId)

  captureStdout(() =>
    runItemAdd('question', 'Ship v2?', { recommend: 'Ship it', stalls: 'none', whyMine: 'scope' })
  )

  const prefix = `item add --session ${sessionId} --type question --prompt `
  const promptArg = extractPromptArg(readRawLog(tmpDir), prefix)
  assert.equal(
    promptArg,
    'Ship v2?\n\n> **Recommend:** Ship it · **Stalls:** none · **Yours because:** scope'
  )
})

test('question gate composition: lede, evidence, then declaration composes the exact stub prompt', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"item-1"}')
  registerRootNode(sessionId)

  captureStdout(() =>
    runItemAdd('question', 'Ship v2?\n\nHere is the evidence.', {
      recommend: 'Ship it',
      stalls: 'none',
      whyMine: 'scope',
    })
  )

  const prefix = `item add --session ${sessionId} --type question --prompt `
  const promptArg = extractPromptArg(readRawLog(tmpDir), prefix)
  assert.equal(
    promptArg,
    'Ship v2?\n\nHere is the evidence.\n\n' +
      '> **Recommend:** Ship it · **Stalls:** none · **Yours because:** scope'
  )
})

// Distinguishes itself from the byte-identical-looking test above by feeding a --prompt that DOES
// carry trailing blank lines after the lede (restLines is non-empty, all blank) — evidence.trim()
// still comes out '', so nothing here reds a mutation that broke `.filter((block) => block !== '')`
// in composeQuestionPrompt unless this fixture, specifically, has content to filter.
test('question gate composition: lede only, no evidence — no trailing blank block', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"item-1"}')
  registerRootNode(sessionId)

  captureStdout(() =>
    runItemAdd('question', 'Ship v2?\n\n\n', {
      recommend: 'Ship it',
      stalls: 'none',
      whyMine: 'scope',
    })
  )

  const prefix = `item add --session ${sessionId} --type question --prompt `
  const promptArg = extractPromptArg(readRawLog(tmpDir), prefix)
  assert.equal(
    promptArg,
    'Ship v2?\n\n> **Recommend:** Ship it · **Stalls:** none · **Yours because:** scope'
  )
  assert.ok(!promptArg.endsWith('\n\n'), 'no trailing blank block')
  assert.ok(promptArg.endsWith('scope'), 'ends with the blockquote')
})

test('question gate composition: markdown in the evidence survives verbatim', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"item-1"}')
  registerRootNode(sessionId)

  const evidence = 'See `runItemAdd()` — costs $5 per call:\n\n```ts\nconst x = 1\n```'
  captureStdout(() =>
    runItemAdd('question', `Ship v2?\n\n${evidence}`, {
      recommend: 'Ship it',
      stalls: 'none',
      whyMine: 'scope',
    })
  )

  const prefix = `item add --session ${sessionId} --type question --prompt `
  const promptArg = extractPromptArg(readRawLog(tmpDir), prefix)
  // The exact composed string, not just endsWith(evidence) — a raw, uncomposed prompt also ends
  // with its own evidence tail, so an endsWith check alone would pass even if composition never ran.
  assert.equal(
    promptArg,
    'Ship v2?\n\n' +
      evidence +
      '\n\n> **Recommend:** Ship it · **Stalls:** none · **Yours because:** scope'
  )
})

test('question gate composition: a CR-line-ending --prompt splits lede from evidence the same as LF', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"item-1"}')
  registerRootNode(sessionId)

  captureStdout(() =>
    runItemAdd('question', 'Ship v2?\r\rHere is the evidence.', {
      recommend: 'Ship it',
      stalls: 'none',
      whyMine: 'scope',
    })
  )

  const prefix = `item add --session ${sessionId} --type question --prompt `
  const promptArg = extractPromptArg(readRawLog(tmpDir), prefix)
  assert.equal(
    promptArg,
    'Ship v2?\n\nHere is the evidence.\n\n' +
      '> **Recommend:** Ship it · **Stalls:** none · **Yours because:** scope'
  )
})

test('question gate composition: CRLF evidence with an internal blank line does not double it', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"item-1"}')
  registerRootNode(sessionId)

  captureStdout(() =>
    runItemAdd('question', 'Ship v2?\r\nA\r\n\r\nB', {
      recommend: 'Ship it',
      stalls: 'none',
      whyMine: 'scope',
    })
  )

  const prefix = `item add --session ${sessionId} --type question --prompt `
  const promptArg = extractPromptArg(readRawLog(tmpDir), prefix)
  // A trailing-\r\n split that fell back to matching \r and \n as two separate breaks (rather than
  // \r\n as one) would insert an extra blank element here — trim() alone cannot catch it, since the
  // internal blank line survives trim() on both sides.
  assert.equal(
    promptArg,
    'Ship v2?\n\nA\n\nB\n\n> **Recommend:** Ship it · **Stalls:** none · **Yours because:** scope'
  )
})

test('question gate: --type approval is unaffected — no declaration line, raw prompt reaches the stub', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"item-1"}')
  registerRootNode(sessionId)

  captureStdout(() => runItemAdd('approval', 'Please approve the doc'))

  // Not calls.length === 1: an approval with no --approval-kind also triggers the FLOW-211 guard's
  // own `session list` read against this same stub, so two calls are expected here.
  const calls = readCalls(tmpDir)
  const addCall = calls.find((c) => c.includes('item add'))
  assert.ok(addCall !== undefined, 'item add was called')
  assert.ok(
    addCall!.includes('--prompt Please approve the doc'),
    'raw prompt reaches the stub unmodified'
  )
  assert.ok(!addCall!.includes('Recommend'), 'no declaration line inserted')
})

// ---------------------------------------------------------------------------
// Tests: runItemDropDeferred / runItemListDeferred (FLOW-250)
// ---------------------------------------------------------------------------

const deferOne = (sessionId: string, prompt: string): void => {
  registerRootNode(sessionId)
  underBoardStub(() =>
    captureStdout(() => runItemAdd('question', prompt, { ...questionDecl, defer: true }))
  )
}

// No bin-resolve early-return sits ahead of resolveSessionTarget in runItemDropDeferred, so a
// reachable-but-empty board is enough on its own to prove the try/catch: no node registered, no
// --id/--reason validation failure to short-circuit first, and resolveSessionTarget throws
// session-id.ts's "run `dashboard session enter` first" — the try/catch must reuse that message and
// set exit 1 rather than let it escape uncaught.
test('drop-deferred: reachable board, no registered session — refuses cleanly instead of throwing', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '[]')

  let stderrOut = ''
  let stdoutOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => {
      stdoutOut = captureStdout(() => runItemDropDeferred('q1', 'Answered already'))
    })
  })

  assert.ok(
    stderrOut.includes('run `dashboard session enter` first'),
    'stderr carries resolveSessionTarget’s own message'
  )
  assert.equal(stdoutOut, '', 'a refusal must not leak a success payload onto stdout')
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
})

test('drop-deferred removes the entry from the queue and prints the reason', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  deferOne(sessionId, 'Should the retry live in the client or the caller?')

  const stdoutOut = captureStdoutAssertingSuccess(() =>
    runItemDropDeferred('q1', 'Handled by the client-side retry helper', { session: sessionId })
  )

  assert.equal(
    stdoutOut.trim(),
    JSON.stringify({ dropped: 'q1', reason: 'Handled by the client-side retry helper' })
  )
  assert.deepEqual(loadState(sessionId)?.deferredQuestions ?? [], [], 'the entry is gone')
})

// Same enumeration gap as queueDeferredQuestion above — runItemDropDeferred spreads `...state`
// for its own save; this test is what pins that this writer preserves parentId too.
test('drop-deferred preserves parentId on its own save', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  const parentId = `${sessionId}-parent`
  registerRootNode(sessionId)
  saveState(sessionId, { registered: true, phase: 'design', openItemIds: [], parentId })
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')

  captureStdoutAssertingSuccess(() =>
    runItemDropDeferred('q1', 'Answered by the implementation itself', { session: sessionId })
  )

  assert.equal(
    loadState(sessionId)?.parentId,
    parentId,
    'parentId survives runItemDropDeferred’s own save'
  )
})

test('drop-deferred refuses an id that is not in the queue', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  deferOne(sessionId, 'Should the retry live in the client or the caller?')

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemDropDeferred('q99', 'nope', { session: sessionId }))
  })

  assert.equal(exitCodeIsError(), true, 'an unknown id exits with an error code')
  assert.ok(stderrOut.includes('q1'), 'stderr names the queued ids')
  assert.equal(stdoutOut, '', 'nothing succeeded on stdout')
  const queue = loadState(sessionId)?.deferredQuestions ?? []
  assert.deepEqual(
    queue.map((entry) => entry.id),
    ['q1'],
    'the existing entry was not touched'
  )
})

test('drop-deferred refuses an id that is not in the queue, and reports the empty queue as "(none)"', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)

  const stderrOut = captureStderr(() => {
    captureStdout(() => runItemDropDeferred('q1', 'nope', { session: sessionId }))
  })

  assert.equal(exitCodeIsError(), true, 'an unknown id exits with an error code')
  assert.ok(
    stderrOut.includes('queued ids: (none)'),
    'a genuinely empty queue is reported as "(none)", not an empty list'
  )
})

test('drop-deferred refuses when --id is missing but --reason is present', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  deferOne(sessionId, 'Should the retry live in the client or the caller?')

  const stderrOut = captureStderr(() => {
    captureStdout(() => runItemDropDeferred(undefined, 'nope', { session: sessionId }))
  })

  assert.equal(exitCodeIsError(), true)
  assert.ok(
    stderrOut.includes('missing --id') && !stderrOut.includes('missing --id, --reason'),
    'stderr names only --id — --reason was supplied'
  )
})

test('drop-deferred refuses when both --id and --reason are missing, joining both names', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  deferOne(sessionId, 'Should the retry live in the client or the caller?')

  const stderrOut = captureStderr(() => {
    captureStdout(() => runItemDropDeferred(undefined, undefined, { session: sessionId }))
  })

  assert.equal(exitCodeIsError(), true)
  assert.ok(stderrOut.includes('missing --id, --reason'), 'stderr joins both missing flag names')
})

test('drop-deferred refuses a second drop of the same entry', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  deferOne(sessionId, 'Should the retry live in the client or the caller?')
  captureStdoutAssertingSuccess(() =>
    runItemDropDeferred('q1', 'First reason', { session: sessionId })
  )
  resetExitCode()

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() =>
      runItemDropDeferred('q1', 'Second reason', { session: sessionId })
    )
  })

  assert.equal(
    exitCodeIsError(),
    true,
    'dropping an already-removed entry exits with an error code'
  )
  assert.ok(stderrOut.includes('no deferred question with id "q1"'), 'stderr names the missing id')
  assert.ok(stderrOut.includes('queued ids: (none)'), 'stderr shows the now-empty queue')
  assert.equal(stdoutOut, '', 'nothing succeeded on stdout')
})

// A blank --reason is '' !== undefined, so unlike a genuinely omitted --reason it reaches the
// flush composition and lists as an empty bullet — the same defence-in-depth gap
// validateQuestionParts already closes for --recommend/--stalls.
test('drop-deferred refuses a blank --reason', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  deferOne(sessionId, 'Should the retry live in the client or the caller?')

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemDropDeferred('q1', '   ', { session: sessionId }))
  })

  assert.equal(exitCodeIsError(), true, 'a blank --reason exits with an error code')
  assert.ok(stderrOut.includes('--reason is blank.'), 'stderr explains the refusal')
  assert.equal(stdoutOut, '', 'nothing succeeded on stdout')
  const queue = loadState(sessionId)?.deferredQuestions ?? []
  assert.deepEqual(
    queue.map((entry) => entry.id),
    ['q1'],
    'the entry was not dropped'
  )
})

// No bin-resolve early-return sits ahead of resolveSessionTarget in runItemListDeferred either — a
// reachable-but-empty board with no node registered is enough on its own to reach
// resolveSessionTarget's "run `dashboard session enter` first" throw and prove the try/catch reuses
// that message and sets exit 1 rather than letting it escape uncaught.
test('list-deferred: reachable board, no registered session — refuses cleanly instead of throwing', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '[]')

  let stderrOut = ''
  let stdoutOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => {
      stdoutOut = captureStdout(() => runItemListDeferred())
    })
  })

  assert.ok(
    stderrOut.includes('run `dashboard session enter` first'),
    'stderr carries resolveSessionTarget’s own message'
  )
  // A genuinely empty queue also prints on stdout (`[]`, per this verb's own contract above) — an
  // empty string here is what tells a refusal apart from that success case, not just truthiness.
  assert.equal(
    stdoutOut,
    '',
    'a refusal must not print the same `[]` a genuinely empty queue would'
  )
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
})

test('list-deferred prints the queue as JSON', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)

  const emptyOut = captureStdoutAssertingSuccess(() => runItemListDeferred({ session: sessionId }))
  assert.deepEqual(JSON.parse(emptyOut) as unknown[], [], 'an empty queue prints []')

  underBoardStub(() =>
    captureStdout(() => runItemAdd('question', 'First question?', { ...questionDecl, defer: true }))
  )
  underBoardStub(() =>
    captureStdout(() =>
      runItemAdd('question', 'Second question?', { ...questionDecl, defer: true })
    )
  )
  const populatedOut = captureStdoutAssertingSuccess(() =>
    runItemListDeferred({ session: sessionId })
  )
  const parsed = JSON.parse(populatedOut) as { id: string; lede: string }[]
  assert.equal(parsed.length, 2)
  assert.deepEqual(
    parsed.map((entry) => [entry.id, entry.lede]),
    [
      ['q1', 'First question?'],
      ['q2', 'Second question?'],
    ],
    'two seeded entries round-trip in queue order'
  )
})

test('list-deferred and drop-deferred --key target the named sibling node, not the other one', () => {
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
  underBoardStub(() =>
    captureStdout(() =>
      runItemAdd('question', 'K1’s own question?', { ...questionDecl, defer: true, key: 'K1' })
    )
  )
  const k2DeferOut = underBoardStub(() =>
    captureStdout(() =>
      runItemAdd('question', 'K2’s own question?', { ...questionDecl, defer: true, key: 'K2' })
    )
  )
  assert.deepEqual(
    JSON.parse(k2DeferOut) as { deferredId?: string },
    { deferredId: 'q1' },
    'K2’s own defer landed on K2’s own queue, not K1’s'
  )

  const k1List = JSON.parse(
    captureStdoutAssertingSuccess(() => runItemListDeferred({ key: 'K1' }))
  ) as {
    id: string
    lede: string
  }[]
  assert.equal(k1List.length, 1, '--key K1 sees only K1’s own queue')
  assert.equal(k1List[0]?.lede, 'K1’s own question?')

  const dropStdout = captureStdoutAssertingSuccess(() =>
    runItemDropDeferred('q1', 'Answered on K1', { key: 'K1' })
  )
  assert.equal(
    dropStdout.trim(),
    JSON.stringify({ dropped: 'q1', reason: 'Answered on K1' }),
    '--key K1 drops K1’s own entry'
  )

  assert.deepEqual(
    loadState('node-k1')?.deferredQuestions,
    [],
    'the drop landed on node-k1’s state'
  )
  assert.equal(
    loadState('node-k2')?.deferredQuestions?.length,
    1,
    'node-k2’s own queue still has its one entry — --key did not cross to the other sibling'
  )
})

// The same class as runItemAdd/queueDeferredQuestion/flush-deferred's corrupt-state guards above
// (stateFileIsCorrupt/refuseCorruptState, state.ts). Without this, a corrupt file's `loadState`
// null prints the identical `[]` an empty queue prints — team-cleanup and pr-lifecycle both drain by
// repeating list-deferred until it reports `[]`, so an unreadable file that looks empty is never
// surfaced.
test('list-deferred refuses to print a false "[]" when the state file is present but unparseable, rather than treating an unreadable queue as an empty one', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  writeFileSync(stateFilePath(sessionId), '{not json')

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemListDeferred({ session: sessionId }))
  })

  assert.ok(
    stderrOut.includes('failed to parse') &&
      stderrOut.includes('refusing to list the deferred queue'),
    'stderr explains the refusal'
  )
  assert.equal(exitCodeIsError(), true, 'exit code set to error')
  assert.equal(
    stdoutOut,
    '',
    'no [] reaches stdout — the refusal is not reported as an empty queue'
  )
  assert.equal(
    readFileSync(stateFilePath(sessionId), 'utf8'),
    '{not json',
    'the damaged file is preserved untouched'
  )
})

// Same class, for drop-deferred: without the guard, a corrupt file's `loadState` null falls into the
// not-found branch and reports the id as absent with "queued ids: (none)" — a false diagnosis naming
// an unreadable queue as an empty one.
test('drop-deferred refuses to report an id absent when the state file is present but unparseable, rather than treating an unreadable queue as an empty one', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  writeFileSync(stateFilePath(sessionId), '{not json')

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() =>
      runItemDropDeferred('q1', 'Answered elsewhere', { session: sessionId })
    )
  })

  assert.ok(
    stderrOut.includes('failed to parse') &&
      stderrOut.includes('refusing to drop this deferred question'),
    'stderr explains the refusal'
  )
  assert.ok(
    !stderrOut.includes('queued ids'),
    'the refusal does not misreport the unreadable queue as an empty one'
  )
  assert.equal(exitCodeIsError(), true, 'exit code set to error')
  assert.equal(stdoutOut, '', 'nothing succeeded on stdout')
  assert.equal(
    readFileSync(stateFilePath(sessionId), 'utf8'),
    '{not json',
    'the damaged file is preserved untouched'
  )
})

// ---------------------------------------------------------------------------
// Tests: runItemFlushDeferred (FLOW-250)
// ---------------------------------------------------------------------------

// Queueing a deferral needs a board to resolve (with none, `item add` hands the question back for
// the terminal instead), so the call runs under a stub bin and the caller's own bin is restored.
const underBoardStub = <T>(fn: () => T): T => {
  const callerBin = process.env.AI_WORKFLOW_APP_BIN
  const stubDir = mkdtempSync(join(tmpDir, 'defer-stub-'))
  process.env.AI_WORKFLOW_APP_BIN = writeStub(stubDir, 0, '{"itemId":"should-not-post"}')
  try {
    return fn()
  } finally {
    process.env.AI_WORKFLOW_APP_BIN = callerBin
  }
}

const deferQuestion = (sessionId: string, lede: string, body = ''): void => {
  const prompt = body === '' ? lede : `${lede}\n\n${body}`
  underBoardStub(() =>
    captureStdout(() =>
      runItemAdd('question', prompt, { ...questionDecl, defer: true, session: sessionId })
    )
  )
}

test('flush-deferred posts one item per queued question, in order, and clears the queue', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  deferQuestion(sessionId, 'Should retries be capped at 3 or configurable?')
  process.env.AI_WORKFLOW_APP_BIN = writeCountingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 })
  )

  const stdoutOut = captureStdoutAssertingSuccess(() =>
    runItemFlushDeferred({ session: sessionId })
  )

  assert.equal(stdoutOut.trim(), JSON.stringify({ itemIds: ['item-1', 'item-2'], flushed: 2 }))
  const rawCalls = readRawCalls(tmpDir)
  const itemAddCalls = rawCalls
    .split(/\nitem add --session/)
    .filter((_, i) => i > 0 || rawCalls.startsWith('item add --session'))
  assert.equal(itemAddCalls.length, 2, 'exactly two item add calls')
  assert.ok(
    itemAddCalls[0]?.includes('Should the retry live in the client or the caller?') &&
      !itemAddCalls[0]?.includes('Should retries be capped at 3 or configurable?'),
    'the first call carries only the first lede'
  )
  assert.deepEqual(loadState(sessionId)?.openItemIds, ['item-1', 'item-2'])
  assert.deepEqual(loadState(sessionId)?.deferredQuestions, [], 'the queue is now empty')
})

// Uses the beforeEach default (AI_WORKFLOW_APP_BIN pinned to a nonexistent path), unset here.
// Unlike runItemAdd's own bin===null no-op, this one sits inside shipped drain loops (team-cleanup,
// pr-lifecycle) that repeat list-deferred/flush-deferred until the queue reports empty — list-deferred
// is a local read, so a silent exit-0 here would report the same non-empty queue forever with nothing
// explaining why. This must be loud, and the queue must still survive it.
test('flush-deferred refuses loudly when the board binary is unavailable, leaving the queue intact', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemFlushDeferred({ session: sessionId }))
  })

  assert.equal(stdoutOut, '', 'no success payload printed')
  assert.ok(stderrOut.includes('not available'), 'stderr names the unavailable binary')
  assert.equal(exitCodeIsError(), true, 'a drain loop must see this as a failure, not a success')
  assert.equal(loadState(sessionId)?.deferredQuestions?.length, 1, 'the queue is untouched')
})

// The test above wires an unreachable bin, so it never clears runItemFlushDeferred's own
// resolveDashboardBin() === null early-return and never reaches resolveSessionTarget at all. This
// test wires a reachable stub instead, with no node registered, so that early-return clears and
// resolveSessionTarget's own "run `dashboard session enter` first" throw (session-id.ts) is what
// fires — proving the try/catch around that call reuses the thrown message and sets exit 1 instead
// of letting the throw escape uncaught.
test('flush-deferred: reachable board, no registered session — refuses cleanly instead of throwing', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '[]')

  let stderrOut = ''
  let stdoutOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => {
      stdoutOut = captureStdout(() => runItemFlushDeferred())
    })
  })

  assert.ok(
    stderrOut.includes('run `dashboard session enter` first'),
    'stderr carries resolveSessionTarget’s own message'
  )
  assert.equal(
    stdoutOut,
    '',
    'a refusal must not print the `{"itemIds":[],"flushed":0}` a genuinely empty queue would'
  )
  assert.equal(exitCodeIsError(), true, 'a drain loop must see this as a failure, not a success')
})

test('flush-deferred: a failing board call reports the error and leaves the queue queued', () => {
  const stubBin = writeStub(tmpDir, 1, '', 'item add failed')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')

  const stderrOut = captureStderr(() =>
    captureStdout(() => runItemFlushDeferred({ session: sessionId }))
  )

  assert.ok(stderrOut.includes('failed'), 'stderr mentions the failure')
  assert.equal(exitCodeIsError(), true, 'error exit code set')
  assert.equal(
    loadState(sessionId)?.deferredQuestions?.length,
    1,
    'nothing was consumed on failure'
  )
})

// itemId is matched against the session's EXISTING openItemIds before being pushed — reachable
// whenever the board reuses an id the local ledger already holds. Without the check, a re-flush
// racing an in-flight consume could double the id into the array.
test('flush-deferred does not duplicate an itemId already present in openItemIds', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'implementation',
    openItemIds: ['item-flush-1'],
  })
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-flush-1"}'
  )

  const stdoutOut = captureStdoutAssertingSuccess(() =>
    runItemFlushDeferred({ session: sessionId })
  )

  // A positive observation on a channel deleting the push can't fake: the pre-seeded
  // openItemIds and the deduped result are byte-identical, so the assertion below alone would
  // still pass against a gutted implementation that never pushed at all. stdout and the drained
  // queue are what proves the flush actually ran.
  assert.equal(stdoutOut.trim(), JSON.stringify({ itemIds: ['item-flush-1'], flushed: 1 }))
  assert.equal(loadState(sessionId)?.deferredQuestions?.length, 0, 'the queue drained')
  assert.deepEqual(
    loadState(sessionId)?.openItemIds,
    ['item-flush-1'],
    'the id already present is not duplicated'
  )
})

// The same class as runItemAdd/queueDeferredQuestion's corrupt-state guards above
// (stateFileIsCorrupt/refuseCorruptState, state.ts): flush's own `queue.length === 0` early return
// runs before any save, so a corrupt file here never reaches a `?? {...}` overwrite — the guard's
// job is different. Without it, `deferredQuestionsOf(loadState(sessionId))` collapses the corrupt
// file to an empty queue, and the empty-queue branch reports `{"itemIds":[],"flushed":0}` and exits 0 — a false
// success claiming the queue was checked and found empty, when it was never readable at all. The
// guard converts that false success into a loud refusal.
test('flush-deferred refuses to report a false "0 flushed" success when the state file is present but unparseable, rather than treating an unreadable queue as an empty one', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"should-not-post"}'
  )
  writeFileSync(stateFilePath(sessionId), '{not json')

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemFlushDeferred({ session: sessionId }))
  })

  assert.ok(
    stderrOut.includes('failed to parse') &&
      stderrOut.includes('refusing to flush the deferred queue'),
    'stderr explains the refusal'
  )
  assert.ok(
    stderrOut.includes('report a false success') && !stderrOut.includes('fresh empty state'),
    'the reason cites the false-success risk that is actually live on this path, not an ' +
      'unconditional overwrite claim that flush never reaches'
  )
  assert.equal(exitCodeIsError(), true, 'exit code set to error')
  assert.ok(
    !stdoutOut.includes('flushed'),
    'no flushed count reaches stdout — the refusal is not reported as a (false) success'
  )
  assert.equal(
    readFileSync(stateFilePath(sessionId), 'utf8'),
    '{not json',
    'the damaged file is preserved untouched, not replaced with a fresh empty state'
  )
  assert.equal(
    (readRawCalls(tmpDir).match(/item add/g) ?? []).length,
    0,
    'no item add call was made — refused before the board post'
  )
})

test('flush-deferred after every entry was dropped posts nothing', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  captureStdoutAssertingSuccess(() =>
    runItemDropDeferred('q1', 'Handled by the client-side retry helper', { session: sessionId })
  )
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"should-not-post"}'
  )

  const stdoutOut = captureStdoutAssertingSuccess(() =>
    runItemFlushDeferred({ session: sessionId })
  )

  assert.equal(stdoutOut.trim(), JSON.stringify({ itemIds: [], flushed: 0 }))
  assert.equal(
    (readRawCalls(tmpDir).match(/item add/g) ?? []).length,
    0,
    'no item add call on a fully-dropped queue'
  )
})

test('flush-deferred on an empty queue posts nothing', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"should-not-be-called"}')

  const stdoutOut = captureStdoutAssertingSuccess(() =>
    runItemFlushDeferred({ session: sessionId })
  )

  assert.equal(stdoutOut.trim(), JSON.stringify({ itemIds: [], flushed: 0 }))
  assert.equal(
    (readRawCalls(tmpDir).match(/item add/g) ?? []).length,
    0,
    'no item add call on an empty queue'
  )
})

test('flush-deferred posts every entry regardless of their combined length — the cap is per item', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  const longBody = 'x'.repeat(1200)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?', longBody)
  deferQuestion(sessionId, 'Should retries be capped at 3 or configurable?', longBody)
  deferQuestion(sessionId, 'Should the cap apply per session or per node?', longBody)
  process.env.AI_WORKFLOW_APP_BIN = writeCountingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 })
  )

  const stdoutOut = captureStdoutAssertingSuccess(() =>
    runItemFlushDeferred({ session: sessionId })
  )

  assert.equal(
    stdoutOut.trim(),
    JSON.stringify({ itemIds: ['item-1', 'item-2', 'item-3'], flushed: 3 })
  )
  assert.equal(
    (readRawCalls(tmpDir).match(/item add/g) ?? []).length,
    3,
    'three item add calls, each entry combined would be far over the cap'
  )
  assert.deepEqual(loadState(sessionId)?.deferredQuestions, [], 'the queue is now empty')
})

test('flush-deferred stops at the first failed post, leaves the unposted suffix queued, and reports the partial result', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  deferQuestion(sessionId, 'Should retries be capped at 3 or configurable?')
  deferQuestion(sessionId, 'Should the cap apply per session or per node?')
  process.env.AI_WORKFLOW_APP_BIN = writeCountingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    1
  )

  let stdoutOut = ''
  captureStderr(() => {
    stdoutOut = captureStdout(() => runItemFlushDeferred({ session: sessionId }))
  })

  assert.equal(exitCodeIsError(), true, 'a partial flush is a failure')
  assert.equal(stdoutOut.trim(), JSON.stringify({ itemIds: ['item-1'], flushed: 1, remaining: 2 }))
  const queue = loadState(sessionId)?.deferredQuestions ?? []
  assert.deepEqual(
    queue.map((entry) => entry.id),
    ['q2', 'q3'],
    'the unposted suffix stays queued'
  )
  assert.deepEqual(loadState(sessionId)?.openItemIds, ['item-1'])
})

test('flush-deferred refuses while an approval is open on the node', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 1, { question: 0, approval: 1, comment: 0 }),
    '{"itemId":"item-should-not-post"}'
  )

  const stderrOut = captureStderr(() =>
    captureStdout(() => runItemFlushDeferred({ session: sessionId }))
  )

  assert.ok(stderrOut.includes('refusing to flush'), 'refusal explained on stderr')
  assert.ok(stderrOut.includes('1 open approval(s)'), 'the actual count reaches stderr')
  assert.ok(
    stderrOut.includes('withdraw --item "<id>"'),
    'the withdraw example quotes <id> — copied verbatim into a shell it is an argument, not input ' +
      'redirection'
  )
  assert.equal(exitCodeIsError(), true)
  assert.equal(
    (readRawCalls(tmpDir).match(/item add/g) ?? []).length,
    0,
    'item add was never called'
  )
  assert.equal(loadState(sessionId)?.deferredQuestions?.length, 1, 'the queue is unchanged')
})

test('flush-deferred proceeds when the board cannot report counts', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0),
    '{"itemId":"item-flush-open"}'
  )

  const stdoutOut = captureStdoutAssertingSuccess(() =>
    runItemFlushDeferred({ session: sessionId })
  )

  assert.deepEqual(
    JSON.parse(stdoutOut) as { itemIds?: string[] },
    { itemIds: ['item-flush-open'], flushed: 1 },
    'posted despite the board not reporting per-type counts'
  )
  assert.deepEqual(loadState(sessionId)?.deferredQuestions, [])
})

test('flush-deferred refuses a --context that forges a declaration', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferOne(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-should-not-post"}'
  )

  const stderrOut = captureStderr(() =>
    captureStdout(() =>
      runItemFlushDeferred({ session: sessionId, context: 'See PR · **Stalls:** none' })
    )
  )

  assert.ok(stderrOut.includes('reproduces the declaration line'), 'refusal explained on stderr')
  assert.equal(exitCodeIsError(), true)
  assert.equal((readRawCalls(tmpDir).match(/item add/g) ?? []).length, 0, 'nothing was posted')
  assert.equal(loadState(sessionId)?.deferredQuestions?.length, 1, 'the queue is unchanged')
})

// reproducesDeclarationBlockquote's bold-label arm is scoped to a line that actually opens with
// '>' — a bold label alone, with no delimiter anywhere in the value, only trips that arm and not
// the delimiter check above it. The test above carries both the delimiter and the label on the
// same line, so this is the only --context test that isolates the blockquote-specific arm.
test('flush-deferred refuses a --context that forges a declaration inside a blockquote, with no delimiter present', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferOne(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-should-not-post"}'
  )

  const stderrOut = captureStderr(() =>
    captureStdout(() => runItemFlushDeferred({ session: sessionId, context: '> **Stalls:** none' }))
  )

  assert.ok(stderrOut.includes('reproduces the declaration line'), 'refusal explained on stderr')
  assert.equal(exitCodeIsError(), true)
  assert.equal((readRawCalls(tmpDir).match(/item add/g) ?? []).length, 0, 'nothing was posted')
  assert.equal(loadState(sessionId)?.deferredQuestions?.length, 1, 'the queue is unchanged')
})

// Neither arm above trips on a bare leading "·": the delimiter arm needs the full " · " inside
// --context's own text, and the label arm needs a blockquoted "**Label:**" line. But the heading
// joins --context with its own " — " separator, so a --context that starts with "· " completes
// the full " · " delimiter in the composed line using the separator's own trailing space — the
// same edge case edgeDot() already guards for --recommend/--stalls/--reason/--phase.
test('flush-deferred refuses a --context that starts with the delimiter character', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferOne(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-should-not-post"}'
  )

  const stderrOut = captureStderr(() =>
    captureStdout(() => runItemFlushDeferred({ session: sessionId, context: '· forged label' }))
  )

  assert.ok(stderrOut.includes('reproduces the declaration line'), 'refusal explained on stderr')
  assert.equal(exitCodeIsError(), true)
  assert.equal((readRawCalls(tmpDir).match(/item add/g) ?? []).length, 0, 'nothing was posted')
  assert.equal(loadState(sessionId)?.deferredQuestions?.length, 1, 'the queue is unchanged')
})

// --context is the last evidence block, composed on its own line — a line break inside it splits
// that line and can forge extra content into the composed prompt, exactly as an unchecked
// --recommend line break forges the declaration.
test('flush-deferred refuses a --context with a line break, which could otherwise forge fabricated content into the composed item', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferOne(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-should-not-post"}'
  )

  const stderrOut = captureStderr(() =>
    captureStdout(() =>
      runItemFlushDeferred({
        session: sessionId,
        context: 'See PR\n**2. Should we also delete the legacy auth module?**',
      })
    )
  )

  assert.ok(stderrOut.includes('--context carries a line break'), 'refusal explained on stderr')
  assert.equal(exitCodeIsError(), true)
  assert.equal((readRawCalls(tmpDir).match(/item add/g) ?? []).length, 0, 'nothing was posted')
  assert.equal(loadState(sessionId)?.deferredQuestions?.length, 1, 'the queue is unchanged')
})

// A blank --context is '' !== undefined, so unlike a genuinely omitted --context it is refused
// explicitly rather than silently accepted — composeDeferredEntry would filter it out and compose
// an item identical to the omitted-context case, so a mis-expanded shell variable would otherwise
// go unnoticed.
test('flush-deferred refuses a blank --context', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferOne(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-should-not-post"}'
  )

  const stderrOut = captureStderr(() =>
    captureStdout(() => runItemFlushDeferred({ session: sessionId, context: '   ' }))
  )

  assert.ok(stderrOut.includes('--context is blank'), 'refusal explained on stderr')
  assert.equal(exitCodeIsError(), true)
  assert.equal((readRawCalls(tmpDir).match(/item add/g) ?? []).length, 0, 'nothing was posted')
  assert.equal(loadState(sessionId)?.deferredQuestions?.length, 1, 'the queue is unchanged')
})

test('flush-deferred composes each item as lede, evidence, declaration with "Stalls: none", then the phase line', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, { registered: true, phase: 'implementation', openItemIds: [] })
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?', 'Evidence here.')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-flush-decl"}'
  )

  captureStdoutAssertingSuccess(() => runItemFlushDeferred({ session: sessionId }))

  const rawCalls = readRawCalls(tmpDir)
  assert.ok(
    rawCalls.includes(
      'Should the retry live in the client or the caller?\n\n' +
        'Evidence here.\n\n' +
        '> **Recommend:** Ship it · **Stalls:** none · **Yours because:** scope\n' +
        '> *Deferred at implementation.*'
    ),
    'the item composes lede, evidence, declaration, then the phase line, exactly'
  )
  assert.ok(!rawCalls.includes('**1.'), 'no numbering marker')
  assert.ok(!rawCalls.includes('Deferred questions'), 'no batch heading')
  assert.ok(!rawCalls.includes('Answered while building'), 'no dropped-entry block')
})

// deferredAtPhase is '' only when the entry was deferred before any state file existed for the node
// (base.phase defaults to '' in queueDeferredQuestion). The phase line is then omitted entirely,
// rather than rendering the dangling "> *Deferred at .*" a bare trailing period would produce.
test('flush-deferred omits the phase line entirely for an entry deferred before any state existed (empty deferredAtPhase)', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-flush-emptyphase"}'
  )

  captureStdoutAssertingSuccess(() => runItemFlushDeferred({ session: sessionId }))

  const rawCalls = readRawCalls(tmpDir)
  assert.ok(
    !rawCalls.includes('Deferred at .'),
    'no dangling "Deferred at ." line — an empty phase omits the line, it does not render blank'
  )
  assert.ok(
    rawCalls.includes(
      'Should the retry live in the client or the caller?\n\n' +
        '> **Recommend:** Ship it · **Stalls:** none · **Yours because:** scope'
    ),
    'the declaration line composes with no phase line following it'
  )
})

test('flush-deferred with --context composes it as evidence before the declaration line', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-flush-context"}'
  )

  captureStdoutAssertingSuccess(() =>
    runItemFlushDeferred({ session: sessionId, context: 'https://github.com/o/r/pull/1' })
  )

  const rawCalls = readRawCalls(tmpDir).trimEnd()
  assert.ok(
    rawCalls.includes(
      '\n\nhttps://github.com/o/r/pull/1\n\n' +
        '> **Recommend:** Ship it · **Stalls:** none · **Yours because:** scope'
    ),
    '--context lands as evidence, directly ahead of the declaration line'
  )
  assert.ok(
    !rawCalls.startsWith('https://github.com/o/r/pull/1'),
    '--context does not lead the item'
  )
  assert.ok(
    rawCalls.endsWith('· **Yours because:** scope'),
    'the declaration line closes the item, after --context'
  )
})

// Unlike runItemAdd's own unconfirmed-post stance, this call sits inside shipped drain loops
// (team-cleanup, pr-lifecycle) that repeat list-deferred/flush-deferred until the queue reports
// empty — a silent exit-0 here would report the same non-empty queue forever with nothing explaining
// why. The queue itself still must not be cleared: an unconfirmed post staying queued for a safe
// retry is unchanged.
test('flush-deferred refuses loudly when the board post is unconfirmed (no itemId back), leaving the queue intact', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  deferQuestion(sessionId, 'Should retries be capped at 3 or configurable?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{}'
  )

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemFlushDeferred({ session: sessionId }))
  })

  assert.equal(exitCodeIsError(), true, 'a drain loop must see this as a failure, not a success')
  assert.equal(stdoutOut.trim(), JSON.stringify({ itemIds: [], flushed: 0, remaining: 2 }))
  assert.ok(stderrOut.includes('q1'), 'stderr names the entry whose post was unconfirmed')
  const queue = loadState(sessionId)?.deferredQuestions ?? []
  assert.deepEqual(
    queue.map((entry) => entry.id),
    ['q1', 'q2'],
    'the queue is NOT cleared'
  )
})

test('flush-deferred treats a non-string itemId as unconfirmed, leaving the entry queued and openItemIds untouched', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":42}'
  )

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemFlushDeferred({ session: sessionId }))
  })

  assert.equal(exitCodeIsError(), true, 'a non-string itemId is treated as unconfirmed, not posted')
  assert.equal(stdoutOut.trim(), JSON.stringify({ itemIds: [], flushed: 0, remaining: 1 }))
  assert.ok(stderrOut.includes('q1'), 'stderr names the entry whose post was unconfirmed')
  const queue = loadState(sessionId)?.deferredQuestions ?? []
  assert.deepEqual(
    queue.map((entry) => entry.id),
    ['q1'],
    'the entry stays queued'
  )
  assert.deepEqual(loadState(sessionId)?.openItemIds, [], 'nothing was written to openItemIds')
})

test('flush-deferred treats a whitespace-only itemId as unconfirmed, leaving the entry queued and openItemIds untouched', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"  "}'
  )

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemFlushDeferred({ session: sessionId }))
  })

  assert.equal(
    exitCodeIsError(),
    true,
    'a whitespace-only itemId is treated as unconfirmed, not posted'
  )
  assert.equal(stdoutOut.trim(), JSON.stringify({ itemIds: [], flushed: 0, remaining: 1 }))
  assert.ok(stderrOut.includes('q1'), 'stderr names the entry whose post was unconfirmed')
  const queue = loadState(sessionId)?.deferredQuestions ?? []
  assert.deepEqual(
    queue.map((entry) => entry.id),
    ['q1'],
    'the entry stays queued'
  )
  assert.deepEqual(loadState(sessionId)?.openItemIds, [], 'nothing was written to openItemIds')
})

// The stub writes a second entry to the state file, on disk, before returning its own response —
// modeling a question deferred on this node while the flush's board call was in flight. The
// post-invoke reload must see it: reusing the pre-invoke snapshot would silently drop it.
test('flush-deferred re-loads state after the board call, so a question deferred while the call was in flight survives', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  const stateFile = stateFilePath(sessionId)
  const concurrentState = {
    registered: true,
    phase: '',
    openItemIds: [],
    deferredQuestions: [
      {
        id: 'q1',
        lede: 'Should the retry live in the client or the caller?',
        body: '',
        recommend: 'Ship it',
        whyMine: 'scope',
        deferredAtPhase: '',
      },
      {
        id: 'q2',
        lede: 'Deferred while the flush call was in flight',
        body: '',
        recommend: 'Ship it',
        whyMine: 'scope',
        deferredAtPhase: '',
      },
    ],
  }
  const stubPath = join(tmpDir, 'ai-workflow-app')
  writeFileSync(
    stubPath,
    `#!/usr/bin/env bash\n` +
      `echo "$@" >> ${JSON.stringify(join(tmpDir, 'calls.log'))}\n` +
      `if [ "$1" = "session" ] && [ "$2" = "list" ]; then\n` +
      `  echo ${JSON.stringify(boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }))}\n` +
      `else\n` +
      `  cat > ${JSON.stringify(stateFile)} << 'FLOW250_STATE_EOF'\n` +
      `${JSON.stringify(concurrentState, null, 2)}\n` +
      `FLOW250_STATE_EOF\n` +
      `  echo '{"itemId":"item-concurrent"}'\n` +
      `fi\nexit 0\n`
  )
  chmodSync(stubPath, 0o755)
  process.env.AI_WORKFLOW_APP_BIN = stubPath

  captureStdoutAssertingSuccess(() => runItemFlushDeferred({ session: sessionId }))

  const finalQueue = loadState(sessionId)?.deferredQuestions ?? []
  assert.deepEqual(
    finalQueue.map((entry) => entry.id),
    ['q2'],
    'q1 was posted and removed; q2, deferred while the board call was in flight, survives — a stale ' +
      'pre-invoke snapshot would have overwritten it out of existence'
  )
})

test('flush-deferred carries deferredIdCounter through the post-invoke fallback when the state file is gone, so the next id does not recycle q1', () => {
  // Regression for FLOW-250: the state file can vanish between the pre-invoke read and the
  // post-invoke reload (a concurrent clearState, or a user following refuseCorruptState's own
  // remediation and removing it by hand). The synthesized fallback state must include
  // deferredIdCounter — omitting it lets a deferral immediately after the flush recycle q1 —
  // the id this flush had just posted — instead of continuing at q2.
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  const stateFile = stateFilePath(sessionId)
  const stubPath = join(tmpDir, 'ai-workflow-app')
  writeFileSync(
    stubPath,
    `#!/usr/bin/env bash\n` +
      `echo "$@" >> ${JSON.stringify(join(tmpDir, 'calls.log'))}\n` +
      `if [ "$1" = "session" ] && [ "$2" = "list" ]; then\n` +
      `  echo ${JSON.stringify(boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }))}\n` +
      `else\n` +
      `  rm -f ${JSON.stringify(stateFile)}\n` +
      `  echo '{"itemId":"item-cleared"}'\n` +
      `fi\nexit 0\n`
  )
  chmodSync(stubPath, 0o755)
  process.env.AI_WORKFLOW_APP_BIN = stubPath

  captureStdoutAssertingSuccess(() => runItemFlushDeferred({ session: sessionId }))

  assert.equal(
    loadState(sessionId)?.deferredIdCounter,
    1,
    'the pre-invoke counter (1, from the single q1 deferral above) must survive the null-fallback ' +
      'save, not reset to undefined'
  )

  deferQuestion(sessionId, 'A second question deferred after the flush cleared the file')
  const nextId = loadState(sessionId)?.deferredQuestions?.at(-1)?.id
  assert.equal(
    nextId,
    'q2',
    'q1 was already posted and is gone from the queue; recycling it onto this new, unrelated ' +
      'question is exactly what deferredIdCounter exists to prevent'
  )
})

// The null-fallback state built for the post-invoke save must spread the pre-invoke `state`
// whole, not hand-roll it field-by-field — a hand-rolled constructor drops parentId the same way
// runItemAdd's pre-FLOW-136 constructor once did. This models the exact failing state: a child
// node with parentId set, one queued deferral, state file removed mid-invoke.
test('flush-deferred carries parentId through the post-invoke fallback, not just deferredIdCounter', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'impl',
    openItemIds: [],
    parentId: `${sessionId}:EPIC`,
  })
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  const stateFile = stateFilePath(sessionId)
  const stubPath = join(tmpDir, 'ai-workflow-app')
  writeFileSync(
    stubPath,
    `#!/usr/bin/env bash\n` +
      `echo "$@" >> ${JSON.stringify(join(tmpDir, 'calls.log'))}\n` +
      `if [ "$1" = "session" ] && [ "$2" = "list" ]; then\n` +
      `  echo ${JSON.stringify(boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }))}\n` +
      `else\n` +
      `  rm -f ${JSON.stringify(stateFile)}\n` +
      `  echo '{"itemId":"item-cleared"}'\n` +
      `fi\nexit 0\n`
  )
  chmodSync(stubPath, 0o755)
  process.env.AI_WORKFLOW_APP_BIN = stubPath

  captureStdoutAssertingSuccess(() => runItemFlushDeferred({ session: sessionId }))

  assert.equal(
    loadState(sessionId)?.parentId,
    `${sessionId}:EPIC`,
    'parentId must survive the null-fallback save — dropping it orphans this node from its epic'
  )
})

// The null-fallback snapshot must be the state SAVED by the previous iteration's recordPostedEntry,
// not the state loaded once before the loop started — the fallback tests above cover only a
// single-entry queue, where there is no previous iteration to get wrong. Here the state file stays
// gone for both posts in a two-entry flush: a stale pre-loop snapshot on the second iteration would
// rebuild deferredQuestions from the ORIGINAL queue, resurrecting q1, which the first iteration
// already removed.
test('flush-deferred threads the saved state through a multi-entry flush when the file stays gone, so an earlier post is not resurrected', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  deferQuestion(sessionId, 'Should retries be capped at 3 or configurable?')
  const stateFile = stateFilePath(sessionId)
  const stubPath = join(tmpDir, 'ai-workflow-app')
  const counter = join(tmpDir, 'counter')
  writeFileSync(
    stubPath,
    `#!/usr/bin/env bash\n` +
      `echo "$@" >> ${JSON.stringify(join(tmpDir, 'calls.log'))}\n` +
      `if [ "$1" = "session" ] && [ "$2" = "list" ]; then\n` +
      `  echo ${JSON.stringify(boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }))}\n` +
      `  exit 0\n` +
      `fi\n` +
      `n=$(( $(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0) + 1 ))\n` +
      `echo "$n" > ${JSON.stringify(counter)}\n` +
      `rm -f ${JSON.stringify(stateFile)}\n` +
      `echo "{\\"itemId\\":\\"item-$n\\"}"\nexit 0\n`
  )
  chmodSync(stubPath, 0o755)
  process.env.AI_WORKFLOW_APP_BIN = stubPath

  captureStdoutAssertingSuccess(() => runItemFlushDeferred({ session: sessionId }))

  const finalState = loadState(sessionId)
  assert.deepEqual(
    finalState?.deferredQuestions ?? [],
    [],
    'both entries were posted and removed — a stale pre-loop snapshot would resurrect q1 here'
  )
  assert.deepEqual(finalState?.openItemIds, ['item-1', 'item-2'], 'both itemIds are recorded')
})

// loadState collapses three distinct causes to null — absent, unparseable, and a
// present-but-shape-invalid deferredQuestions array (the corrupt case stateFileIsCorrupt exists to
// name) — so the post-invoke path must re-check stateFileIsCorrupt after the board call: a file
// that becomes corrupt DURING the post must not be silently overwritten by the unconditional
// saveState instead of refused, exactly the outcome refuseCorruptState's own comment says to avoid.
test('flush-deferred refuses (does not overwrite) when the state file turns corrupt during the post, and names the itemId that already landed', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  deferQuestion(sessionId, 'Should retries be capped at 3 or configurable?')
  const stateFile = stateFilePath(sessionId)
  const stubPath = join(tmpDir, 'ai-workflow-app')
  writeFileSync(
    stubPath,
    `#!/usr/bin/env bash\n` +
      `echo "$@" >> ${JSON.stringify(join(tmpDir, 'calls.log'))}\n` +
      `if [ "$1" = "session" ] && [ "$2" = "list" ]; then\n` +
      `  echo ${JSON.stringify(boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }))}\n` +
      `else\n` +
      // Simulates a concurrent writer corrupting the file (not removing it) while this board call
      // is in flight — a present, parses-fine file whose deferredQuestions is the wrong shape.
      `  echo '{"registered":true,"phase":"impl","openItemIds":[],"deferredQuestions":"oops"}' > ${JSON.stringify(stateFile)}\n` +
      `  echo '{"itemId":"item-during-corruption"}'\n` +
      `fi\nexit 0\n`
  )
  chmodSync(stubPath, 0o755)
  process.env.AI_WORKFLOW_APP_BIN = stubPath

  const stderrChunks: string[] = []
  const origStderr = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrChunks.push(String(chunk))
    return true
  }
  let stdoutOut: string
  try {
    setRequestedExitCode(0)
    stdoutOut = captureStdout(() => runItemFlushDeferred({ session: sessionId }))
  } finally {
    process.stderr.write = origStderr
  }
  const stderrOut = stderrChunks.join('')

  assert.ok(
    stderrOut.includes('item-during-corruption'),
    'names the itemId that already landed, since a caller reading only the exit code would otherwise ' +
      'have no way to learn the post actually succeeded'
  )
  assert.ok(stderrOut.includes('q1'), 'names the entry id the landed itemId belongs to')
  assert.equal(getRequestedExitCode(), 1, 'refuses rather than silently succeeding')
  assert.equal(
    readFileSync(stateFile, 'utf8'),
    '{"registered":true,"phase":"impl","openItemIds":[],"deferredQuestions":"oops"}\n',
    'the corrupt file on disk is left exactly as the concurrent writer left it, not overwritten'
  )
  assert.equal(
    stdoutOut.trim(),
    JSON.stringify({ itemIds: ['item-during-corruption'], flushed: 0, remaining: 2 }),
    'the landed-but-unrecorded item counts toward remaining, not flushed — it was never removed ' +
      'from any queue, since the file that would record its removal is unreadable, so an operator ' +
      'reconciling by this count must not be told it flushed'
  )
})

test('flush-deferred matches each posted entry by id against the fresh queue — an entry deferred concurrently after this flush read the queue survives and is not posted', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  deferQuestion(sessionId, 'Should retries be capped at 3 or configurable?')
  const stateFile = stateFilePath(sessionId)
  // Simulates a concurrent process deferring a third question, on disk, in the gap between this
  // flush reading the queue and its first board call returning.
  const withConcurrentAddition = {
    registered: true,
    phase: '',
    openItemIds: [],
    deferredQuestions: [
      {
        id: 'q1',
        lede: 'Should the retry live in the client or the caller?',
        body: '',
        recommend: 'Ship it',
        whyMine: 'scope',
        deferredAtPhase: '',
      },
      {
        id: 'q2',
        lede: 'Should retries be capped at 3 or configurable?',
        body: '',
        recommend: 'Ship it',
        whyMine: 'scope',
        deferredAtPhase: '',
      },
      {
        id: 'q3',
        lede: 'Deferred by a concurrent process after this flush read the queue',
        body: '',
        recommend: 'Ship it',
        whyMine: 'scope',
        deferredAtPhase: '',
      },
    ],
    deferredIdCounter: 3,
  }
  const counter = join(tmpDir, 'counter')
  const stubPath = join(tmpDir, 'ai-workflow-app')
  writeFileSync(
    stubPath,
    `#!/usr/bin/env bash\n` +
      `echo "$@" >> ${JSON.stringify(join(tmpDir, 'calls.log'))}\n` +
      `if [ "$1" = "session" ] && [ "$2" = "list" ]; then\n` +
      `  echo ${JSON.stringify(boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }))}\n` +
      `  exit 0\n` +
      `fi\n` +
      `n=$(( $(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0) + 1 ))\n` +
      `echo "$n" > ${JSON.stringify(counter)}\n` +
      `if [ "$n" -eq 1 ]; then\n` +
      `  cat > ${JSON.stringify(stateFile)} << 'FLOW333_STATE_EOF'\n` +
      `${JSON.stringify(withConcurrentAddition, null, 2)}\n` +
      `FLOW333_STATE_EOF\n` +
      `fi\n` +
      `echo "{\\"itemId\\":\\"item-$n\\"}"\nexit 0\n`
  )
  chmodSync(stubPath, 0o755)
  process.env.AI_WORKFLOW_APP_BIN = stubPath

  const stdoutOut = captureStdoutAssertingSuccess(() =>
    runItemFlushDeferred({ session: sessionId })
  )

  assert.deepEqual(JSON.parse(stdoutOut.trim()), { itemIds: ['item-1', 'item-2'], flushed: 2 })
  const finalQueue = loadState(sessionId)?.deferredQuestions ?? []
  assert.deepEqual(
    finalQueue.map((entry) => entry.id),
    ['q3'],
    'q1 and q2 are removed by id; q3, deferred concurrently after this flush read the queue, survives untouched'
  )
  assert.equal(
    (readRawCalls(tmpDir).match(/item add/g) ?? []).length,
    2,
    'only the two entries this flush actually read were posted — q3 was never one of them'
  )
  assert.deepEqual(loadState(sessionId)?.openItemIds, ['item-1', 'item-2'])
})

test('a new deferral after the queue drains to empty does not recycle a previously issued id', () => {
  // Regression for FLOW-250: nextDeferredId used to be one past the
  // queue's OWN highest suffix, so a queue drained to empty by a flush restarted numbering at
  // q1 — recycling an id a caller mid-invoke (e.g. runItemFlushDeferred's postedIds, held across
  // its board subprocess call) could still be holding onto from before the drain.
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-flush-1"}'
  )
  captureStdoutAssertingSuccess(() => runItemFlushDeferred({ session: sessionId }))
  assert.deepEqual(
    loadState(sessionId)?.deferredQuestions ?? [],
    [],
    'the queue drained to empty — the counter-less code would seed the next id from here'
  )

  const stdoutOut = captureStdout(() =>
    runItemAdd('question', 'Should we retry on 5xx only?', {
      ...questionDecl,
      defer: true,
      session: sessionId,
    })
  )

  assert.equal(
    (JSON.parse(stdoutOut.trim()) as { deferredId: string }).deferredId,
    'q2',
    'the drained queue’s own highest suffix (none) does not seed the next id — the persisted ' +
      'counter does, so the first id ever issued (q1) is never reissued to a different question'
  )
})

test('flush-deferred refuses when --context alone pushes a single otherwise-fitting entry past the cap, and names --context as the cause', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  const body = 'x'.repeat(1300)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?', body)
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-should-not-post"}'
  )

  const stderrOut = captureStderr(() =>
    captureStdout(() => runItemFlushDeferred({ session: sessionId, context: 'y'.repeat(200) }))
  )

  assert.ok(
    stderrOut.includes('--context pushes q1 past the'),
    'the entry-alone-fits refusal message, not the generic one'
  )
  assert.ok(
    stderrOut.includes('--context is what pushes it over'),
    'names the actual cause instead of blaming the entry'
  )
  assert.equal(exitCodeIsError(), true)
  assert.equal((readRawCalls(tmpDir).match(/item add/g) ?? []).length, 0, 'nothing was posted')
  assert.equal(loadState(sessionId)?.deferredQuestions?.length, 1, 'the queue is unchanged')
})

// The sibling test above passes a 200-char --context — exactly CONTEXT_MAX_CHARS, so `> 200` is
// false and that value flows past the length check into the prefix walk, which is what actually
// refuses it. It does not exercise the length cap itself. This one does: 201 characters, alone,
// against a short queued entry that would otherwise fit comfortably.
test('flush-deferred refuses a --context over CONTEXT_MAX_CHARS, independent of the prefix walk', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-should-not-post"}'
  )

  const stderrOut = captureStderr(() =>
    captureStdout(() => runItemFlushDeferred({ session: sessionId, context: 'y'.repeat(201) }))
  )

  assert.ok(
    stderrOut.includes('--context is 201 characters — the cap is 200.'),
    'the length-cap refusal, not the prefix-walk refusal'
  )
  assert.equal(exitCodeIsError(), true)
  assert.equal((readRawCalls(tmpDir).match(/item add/g) ?? []).length, 0, 'nothing was posted')
  assert.equal(loadState(sessionId)?.deferredQuestions?.length, 1, 'the queue is unchanged')
})

test('flush-deferred refuses when the first queued entry alone (no --context) already exceeds the cap, and blames the entry, not --context', () => {
  // queueDeferredQuestion's own defer-time guard refuses an entry whose no-context flush shape
  // already exceeds the cap, so this state can never arise through the CLI — it is seeded directly
  // to reach entryAloneFits' false branch, which the true branch above cannot.
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  const oversized: DeferredQuestion = {
    id: 'q1',
    lede: 'Should the retry live in the client or the caller?',
    body: 'x'.repeat(2000),
    recommend: questionDecl.recommend,
    whyMine: questionDecl.whyMine,
    deferredAtPhase: '',
  }
  saveState(sessionId, {
    registered: true,
    phase: '',
    openItemIds: [],
    deferredQuestions: [oversized],
    deferredIdCounter: 1,
  })
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-should-not-post"}'
  )

  const stderrOut = captureStderr(() =>
    captureStdout(() => runItemFlushDeferred({ session: sessionId }))
  )

  assert.ok(
    stderrOut.includes('q1 compose past the'),
    'the generic entry-too-large refusal, not the --context-blaming one'
  )
  assert.ok(
    stderrOut.includes('Shorten the question (move its evidence to a link)'),
    'gives the shorten-or-drop remedy, not the drop-context remedy'
  )
  assert.ok(
    stderrOut.includes('drop-deferred --id "<id>" --reason "<what answered it>"'),
    'the drop-deferred example quotes <id> — copied verbatim into a shell it is an argument, not ' +
      'input redirection'
  )
  assert.equal(exitCodeIsError(), true)
  assert.equal((readRawCalls(tmpDir).match(/item add/g) ?? []).length, 0, 'nothing was posted')
  assert.equal(loadState(sessionId)?.deferredQuestions?.length, 1, 'the queue is unchanged')
})

test('flush-deferred --key targets the named sibling node’s queue, not the other one', () => {
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
  underBoardStub(() =>
    captureStdout(() =>
      runItemAdd('question', 'K1’s own question?', { ...questionDecl, defer: true, key: 'K1' })
    )
  )
  underBoardStub(() =>
    captureStdout(() =>
      runItemAdd('question', 'K2’s own question?', { ...questionDecl, defer: true, key: 'K2' })
    )
  )
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow('node-k1', 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-flush-k1"}'
  )

  const stdoutOut = captureStdoutAssertingSuccess(() => runItemFlushDeferred({ key: 'K1' }))

  assert.equal(
    stdoutOut.trim(),
    JSON.stringify({ itemIds: ['item-flush-k1'], flushed: 1 }),
    '--key K1 flushes K1’s own queue'
  )
  assert.deepEqual(loadState('node-k1')?.deferredQuestions, [], 'K1’s queue is now empty')
  assert.equal(
    loadState('node-k2')?.deferredQuestions?.length,
    1,
    'K2’s queue is untouched — --key did not cross to the other sibling'
  )
})

// ---------------------------------------------------------------------------
// Tests: approvalIsAllowed blocked by the deferred-question queue (FLOW-250)
// ---------------------------------------------------------------------------

test('an advancement approval is refused while a question is deferred', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-should-not-post"}'
  )

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemAdd('approval', 'CI green — flip to ready-for-review?'))
  })

  assert.ok(stderrOut.includes('refusing to post an approval'), 'refusal explained on stderr')
  assert.ok(stderrOut.includes('q1'), 'stderr names the queued id')
  assert.ok(
    stderrOut.includes('drop-deferred --id "<id>" --reason "<what answered it>"'),
    'the drop-deferred example quotes <id> — copied verbatim into a shell it is an argument, not ' +
      'input redirection'
  )
  assert.ok(
    stderrOut.includes('`--context` is optional — flush with no `--context`'),
    'a workflow with no PR is told the context-free flush recovers it, not just the --context form'
  )
  assert.equal(stdoutOut, '', 'nothing succeeded on stdout')
  assert.equal(exitCodeIsError(), true)
  assert.equal(
    (readRawCalls(tmpDir).match(/item add/g) ?? []).length,
    0,
    'item add was never called'
  )
})

test('an approval posts once the only deferred question has been dropped', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  captureStdoutAssertingSuccess(() =>
    runItemDropDeferred('q1', 'Handled by the client-side retry helper', { session: sessionId })
  )
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-dropped-only"}'
  )

  const stdoutOut = captureStdout(() =>
    runItemAdd('approval', 'CI green — flip to ready-for-review?')
  )

  assert.equal(stdoutOut.trim(), '{"itemId":"item-dropped-only"}', 'the approval posted')
  assert.equal(exitCodeIsError(), false)
})

test('--approval-kind credential still posts with a question deferred', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  deferQuestion(sessionId, 'Should the retry live in the client or the caller?')
  process.env.AI_WORKFLOW_APP_BIN = writeBranchingStub(
    tmpDir,
    boardRow(sessionId, 0, { question: 0, approval: 0, comment: 0 }),
    '{"itemId":"item-credential-deferred"}'
  )

  const stdoutOut = captureStdout(() =>
    runItemAdd('approval', 'Need the deploy token', { approvalKind: 'credential' })
  )

  assert.equal(stdoutOut.trim(), '{"itemId":"item-credential-deferred"}', 'the approval posted')
  assert.equal(exitCodeIsError(), false)
})

// ---------------------------------------------------------------------------
// Tests: runItemAnswer
// ---------------------------------------------------------------------------

test('runItemAnswer: passes correct argv and drops id from openItemIds', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'prd',
    openItemIds: ['item-q-1', 'item-q-2'],
  })

  runItemAnswer('item-q-1', 'The answer is yes')

  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'one call')
  assert.ok(calls[0]!.includes('item answer'), 'calls item answer')
  assert.ok(calls[0]!.includes('--item item-q-1'), 'includes --item')
  assert.ok(calls[0]!.includes('--response'), 'includes --response')

  const state = loadState(sessionId)
  assert.deepEqual(state!.openItemIds, ['item-q-2'], 'answered item removed from openItemIds')
})

test('runItemAnswer unavailable: silent no-op, no throw', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  delete process.env.CLAUDE_CODE_SESSION_ID

  const stderrOut = captureStderr(() => {
    assert.doesNotThrow(() => runItemAnswer('item-x', 'some answer'))
  })

  assert.equal(stderrOut, '', 'no stderr')
  assert.equal(exitCodeIsError(), false, 'no error exit code')
})

// Bin reachable, no CLAUDE_CODE_SESSION_ID and no --session: resolveSessionId throws inside the
// shared resolveItem helper (answer/approve/reject all route through it) — proving the try/catch
// around it reuses the thrown message and sets exit 1 instead of letting the throw escape uncaught.
test('runItemAnswer: no session id — refuses cleanly instead of throwing', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{}')
  delete process.env.CLAUDE_CODE_SESSION_ID

  let stderrOut = ''
  let stdoutOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => {
      stdoutOut = captureStdout(() => runItemAnswer('item-x', 'some answer'))
    })
  })

  assert.ok(
    stderrOut.includes('No session id: pass --session or set CLAUDE_CODE_SESSION_ID'),
    'stderr carries resolveSessionId’s own message'
  )
  assert.equal(stdoutOut, '', 'a refusal must not leak a success payload onto stdout')
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
  assert.equal(readCalls(tmpDir).length, 0, 'the backend is never invoked once resolution fails')
})

// FLOW-236 defect table row 5: two live leaves and no --key must refuse rather than silently
// answering whichever node resolveSessionId's root fallback happens to pick.
test('runItemAnswer: sibling leaves with no --key refuses loudly, backend never invoked', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
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

  let stderrOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => runItemAnswer('item-q-1', 'The answer is yes'))
  })

  assert.ok(stderrOut.includes('K1'), 'stderr names the K1 leaf')
  assert.ok(stderrOut.includes('K2'), 'stderr names the K2 leaf')
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
  assert.equal(readCalls(tmpDir).length, 0, 'the backend is never invoked once resolution fails')
})

// ---------------------------------------------------------------------------
// Tests: runItemApprove
// ---------------------------------------------------------------------------

test('runItemApprove: without note, passes correct argv and drops id', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'prd',
    openItemIds: ['item-a-1'],
  })

  runItemApprove('item-a-1', undefined)

  const calls = readCalls(tmpDir)
  assert.ok(calls[0]!.includes('item approve'), 'calls item approve')
  assert.ok(calls[0]!.includes('--item item-a-1'), 'includes --item')
  assert.ok(!calls[0]!.includes('--note'), 'no --note without note arg')

  const state = loadState(sessionId)
  assert.deepEqual(state!.openItemIds, [], 'item removed from openItemIds')
})

test('runItemApprove: with note, includes --note', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'prd',
    openItemIds: ['item-a-2'],
  })

  runItemApprove('item-a-2', 'LGTM')

  const calls = readCalls(tmpDir)
  assert.ok(calls[0]!.includes('--note'), 'includes --note when provided')
  assert.ok(calls[0]!.includes('LGTM'), 'note value present')
})

// ---------------------------------------------------------------------------
// Tests: runItemReject
// ---------------------------------------------------------------------------

test('runItemReject: passes correct argv and drops id', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'prd',
    openItemIds: ['item-r-1'],
  })

  runItemReject('item-r-1', 'needs more info')

  const calls = readCalls(tmpDir)
  assert.ok(calls[0]!.includes('item reject'), 'calls item reject')
  assert.ok(calls[0]!.includes('--item item-r-1'), 'includes --item')
  assert.ok(calls[0]!.includes('--note'), 'includes --note')
  assert.ok(calls[0]!.includes('needs more info'), 'includes note value')

  const state = loadState(sessionId)
  assert.deepEqual(state!.openItemIds, [], 'item removed from openItemIds')
})

// ---------------------------------------------------------------------------
// Tests: runItemWithdraw
// ---------------------------------------------------------------------------

// Bin reachable, no CLAUDE_CODE_SESSION_ID and no --session: resolveSessionId throws before the
// --all branch invokes anything — proving the try/catch around it reuses the
// thrown message and sets exit 1 instead of letting the throw escape uncaught.
test('runItemWithdraw --all: no session id — refuses cleanly instead of throwing', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{}')
  delete process.env.CLAUDE_CODE_SESSION_ID

  let stderrOut = ''
  let stdoutOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => {
      stdoutOut = captureStdout(() => runItemWithdraw(undefined, true))
    })
  })

  assert.ok(
    stderrOut.includes('No session id: pass --session or set CLAUDE_CODE_SESSION_ID'),
    'stderr carries resolveSessionId’s own message'
  )
  assert.equal(stdoutOut, '', 'a refusal must not leak a success payload onto stdout')
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
  assert.equal(readCalls(tmpDir).length, 0, 'the backend is never invoked once resolution fails')
})

test('runItemWithdraw single item: passes correct argv and drops id', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'prd',
    openItemIds: ['item-w-1', 'item-w-2'],
  })

  runItemWithdraw('item-w-1', false)

  const calls = readCalls(tmpDir)
  assert.ok(calls[0]!.includes('item withdraw'), 'calls item withdraw')
  assert.ok(calls[0]!.includes('--item item-w-1'), 'includes --item')
  assert.ok(!calls[0]!.includes('--all'), 'no --all for single item')

  const state = loadState(sessionId)
  assert.deepEqual(state!.openItemIds, ['item-w-2'], 'only the withdrawn item removed')
})

// FLOW-236 defect table row 4: two live leaves and no --key must refuse rather than silently
// dropping the item from the ROOT's ledger while the backend's own withdraw is item-scoped and
// actually targets the right node — the exact silent-ledger-drift shape the ticket named.
test('runItemWithdraw single item: sibling leaves with no --key refuses loudly, backend never invoked', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
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

  let stderrOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => runItemWithdraw('item-w-1', false))
  })

  assert.ok(stderrOut.includes('K1'), 'stderr names the K1 leaf')
  assert.ok(stderrOut.includes('K2'), 'stderr names the K2 leaf')
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
  assert.equal(readCalls(tmpDir).length, 0, 'the backend is never invoked once resolution fails')
})

// FLOW-236 defect table row 6 (withdraw): --key must route to the named sibling's OWN ledger, not
// the other sibling's and not a root.
test('runItemWithdraw single item: --key targets the named sibling node', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
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
  saveState('node-k1', { registered: true, phase: 'prd', openItemIds: ['item-w-1'] })
  saveState('node-k2', { registered: true, phase: 'prd', openItemIds: ['item-w-1'] })

  // K2, not K1: node-k1 is registered first, so a resolver that silently fell back to "the first
  // registered node" instead of actually reading --key would clear the same ledger by accident —
  // targeting the second-registered node is what a --key regression can't fake.
  runItemWithdraw('item-w-1', false, undefined, 'K2')

  const calls = readCalls(tmpDir)
  assert.ok(calls[0]!.includes('--item item-w-1'), 'includes --item')
  assert.deepEqual(loadState('node-k2')!.openItemIds, [], 'K2 ledger cleared of the withdrawn item')
  assert.deepEqual(
    loadState('node-k1')!.openItemIds,
    ['item-w-1'],
    'K1 ledger untouched — the other sibling never saw this call'
  )
})

// FLOW-236 defect table row 7: a sole leaf that is NOT the raw session id itself (an epic → story
// chain) must still resolve exactly as it did before this change — only sibling ambiguity refuses.
test('runItemWithdraw single item: sole leaf under a parent node still resolves (epic → story chain unaffected)', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
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
  saveState('story', { registered: true, phase: 'prd', openItemIds: ['item-w-1'] })

  runItemWithdraw('item-w-1', false)

  const calls = readCalls(tmpDir)
  assert.ok(calls[0]!.includes('--item item-w-1'), 'includes --item')
  assert.deepEqual(loadState('story')!.openItemIds, [], 'the sole leaf (story) ledger cleared')
})

test('runItemWithdraw --all: passes correct argv and clears all openItemIds', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'prd',
    openItemIds: ['item-w-1', 'item-w-2'],
  })

  runItemWithdraw(undefined, true)

  const calls = readCalls(tmpDir)
  assert.ok(calls[0]!.includes('item withdraw'), 'calls item withdraw')
  assert.ok(calls[0]!.includes('--session'), 'includes --session')
  assert.ok(calls[0]!.includes('--all'), 'includes --all')

  const state = loadState(sessionId)
  assert.deepEqual(state!.openItemIds, [], 'all items cleared')
})

test('runItemWithdraw --all: failing invoke retains openItemIds for a later retry', () => {
  const stubBin = writeStub(tmpDir, 1, '', 'withdraw failed')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'prd',
    openItemIds: ['item-w-1', 'item-w-2'],
  })

  captureStderr(() => runItemWithdraw(undefined, true))

  const calls = readCalls(tmpDir)
  assert.ok(calls[0]!.includes('item withdraw'), 'the board-side withdraw actually ran')
  const state = loadState(sessionId)
  assert.deepEqual(
    state!.openItemIds,
    ['item-w-1', 'item-w-2'],
    'openItemIds are NOT cleared when the withdraw invoke fails, so a later end/leave can retry'
  )
})

// dropOpenItems/clearOpenItems (FLOW-250, state.ts) run AFTER the board side already succeeded — a
// present-but-unparseable state file here is a warning, not a refusal: the board is already ahead of
// the local ledger, and there is no overwrite risk to guard against, only a drift to report.
test('runItemWithdraw single item: warns rather than refuses when the state file is present but unparseable, leaving it untouched', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, { registered: true, phase: 'prd', openItemIds: ['item-w-1'] })
  writeFileSync(stateFilePath(sessionId), '{not json')

  const stderrOut = captureStderr(() => runItemWithdraw('item-w-1', false))

  assert.ok(
    stderrOut.includes('failed to parse') && stderrOut.includes('local open-item ledger'),
    'stderr warns that the local ledger was left unreconciled'
  )
  assert.equal(exitCodeIsError(), false, 'a warning does not set an error exit code')
  const calls = readCalls(tmpDir)
  assert.ok(calls[0]!.includes('item withdraw'), 'the board-side withdraw still ran')
  assert.equal(
    readFileSync(stateFilePath(sessionId), 'utf8'),
    '{not json',
    'the damaged file is left untouched, not overwritten with a fresh empty state'
  )
})

test('runItemWithdraw --all: warns rather than refuses when the state file is present but unparseable, leaving it untouched', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, { registered: true, phase: 'prd', openItemIds: ['item-w-1', 'item-w-2'] })
  writeFileSync(stateFilePath(sessionId), '{not json')

  const stderrOut = captureStderr(() => runItemWithdraw(undefined, true))

  assert.ok(
    stderrOut.includes('failed to parse') && stderrOut.includes('local open-item ledger'),
    'stderr warns that the local ledger was left unreconciled'
  )
  assert.equal(exitCodeIsError(), false, 'a warning does not set an error exit code')
  const calls = readCalls(tmpDir)
  assert.ok(calls[0]!.includes('--all'), 'the board-side withdraw --all still ran')
  assert.equal(
    readFileSync(stateFilePath(sessionId), 'utf8'),
    '{not json',
    'the damaged file is left untouched, not overwritten with a fresh empty state'
  )
})

// A shape-invalid deferredQuestions file parses as valid JSON — "failed to parse" is simply false
// for it. Pins that the warning re-derives the arm instead of repeating the JSON-arm wording
// unconditionally (FLOW-250).
test('runItemWithdraw single item: names the deferredQuestions field, not "failed to parse", for a shape-invalid state file', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, { registered: true, phase: 'prd', openItemIds: ['item-w-1'] })
  writeFileSync(
    stateFilePath(sessionId),
    JSON.stringify({
      registered: true,
      phase: 'prd',
      openItemIds: ['item-w-1'],
      deferredQuestions: 'oops',
    })
  )

  const stderrOut = captureStderr(() => runItemWithdraw('item-w-1', false))

  assert.ok(stderrOut.includes('deferredQuestions'), 'names the field that is the wrong shape')
  assert.equal(
    stderrOut.includes('failed to parse'),
    false,
    'the file parsed fine — this would be false'
  )
  assert.ok(
    stderrOut.includes('local open-item ledger'),
    'stderr warns that the local ledger was left unreconciled'
  )
  assert.equal(exitCodeIsError(), false, 'a warning does not set an error exit code')
})

// ---------------------------------------------------------------------------
// Tests: runItemConsume
// ---------------------------------------------------------------------------

// Bin reachable, no CLAUDE_CODE_SESSION_ID and no --session: resolveSessionId throws before the
// --all branch invokes anything — proving the try/catch around it reuses the
// thrown message and sets exit 1 instead of letting the throw escape uncaught.
test('runItemConsume --all: no session id — refuses cleanly instead of throwing', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{}')
  delete process.env.CLAUDE_CODE_SESSION_ID

  let stderrOut = ''
  let stdoutOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => {
      stdoutOut = captureStdout(() => runItemConsume(undefined, true))
    })
  })

  assert.ok(
    stderrOut.includes('No session id: pass --session or set CLAUDE_CODE_SESSION_ID'),
    'stderr carries resolveSessionId’s own message'
  )
  assert.equal(stdoutOut, '', 'a refusal must not leak a success payload onto stdout')
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
  assert.equal(readCalls(tmpDir).length, 0, 'the backend is never invoked once resolution fails')
})

test('runItemConsume single item: passes correct argv and drops id', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'prd',
    openItemIds: ['item-c-1', 'item-c-2'],
  })

  runItemConsume('item-c-1', false)

  const calls = readCalls(tmpDir)
  assert.ok(calls[0]!.includes('consume'), 'calls consume')
  assert.ok(calls[0]!.includes('--session'), 'includes --session')
  assert.ok(calls[0]!.includes('--item item-c-1'), 'includes --item')

  const state = loadState(sessionId)
  assert.deepEqual(state!.openItemIds, ['item-c-2'], 'consumed item removed')
})

// FLOW-236 defect table row 3: two live leaves and no --key must refuse rather than sending
// `--session <root>` and letting the backend reject it for the wrong reason ("Item does not
// belong to session <root>"). Assert on the recorded invocation, not on error surfacing — the
// backend must never be called at all.
test('runItemConsume single item: sibling leaves with no --key refuses loudly, backend never invoked', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
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

  let stderrOut = ''
  assert.doesNotThrow(() => {
    stderrOut = captureStderr(() => runItemConsume('item-c-1', false))
  })

  assert.ok(stderrOut.includes('K1'), 'stderr names the K1 leaf')
  assert.ok(stderrOut.includes('K2'), 'stderr names the K2 leaf')
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
  assert.equal(readCalls(tmpDir).length, 0, 'the backend is never invoked once resolution fails')
})

// FLOW-236 defect table row 6 (consume): --key must route to the named sibling, not the other
// leaf and not a root.
test('runItemConsume single item: --key targets the named sibling node', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
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
  saveState('node-k1', { registered: true, phase: 'prd', openItemIds: ['item-c-1'] })
  saveState('node-k2', { registered: true, phase: 'prd', openItemIds: ['item-c-1'] })

  // K2, not K1: node-k1 is registered first, so a resolver that silently fell back to "the first
  // registered node" instead of actually reading --key would clear the same ledger by accident —
  // targeting the second-registered node is what a --key regression can't fake.
  runItemConsume('item-c-1', false, undefined, 'K2')

  const calls = readCalls(tmpDir)
  assert.ok(calls[0]!.includes('--session node-k2'), 'targets the K2 node internal id')
  assert.deepEqual(loadState('node-k2')!.openItemIds, [], 'K2 ledger cleared of the consumed item')
  assert.deepEqual(
    loadState('node-k1')!.openItemIds,
    ['item-c-1'],
    'K1 ledger untouched — the other sibling never saw this call'
  )
})

// FLOW-236 defect table row 7: a sole leaf that is NOT the raw session id itself (an epic → story
// chain) must still resolve exactly as it did before this change — only sibling ambiguity refuses.
test('runItemConsume single item: sole leaf under a parent node still resolves (epic → story chain unaffected)', () => {
  const stubBin = writeStub(tmpDir, 0, '{}')
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
  saveState('story', { registered: true, phase: 'prd', openItemIds: ['item-c-1'] })

  runItemConsume('item-c-1', false)

  const calls = readCalls(tmpDir)
  assert.ok(calls[0]!.includes('--session story'), 'targets the sole leaf (story)')
  assert.deepEqual(loadState('story')!.openItemIds, [], 'the sole leaf (story) ledger cleared')
})

test('runItemConsume --all: drops only the ids the board reported consuming', () => {
  const stubBin = writeStub(tmpDir, 0, '{"consumed":1,"ids":["item-c-1"]}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'prd',
    openItemIds: ['item-c-1', 'item-c-2'],
  })

  runItemConsume(undefined, true)

  const calls = readCalls(tmpDir)
  assert.ok(calls[0]!.includes('consume'), 'calls consume')
  assert.ok(calls[0]!.includes('--all'), 'includes --all')

  const state = loadState(sessionId)
  assert.deepEqual(
    state!.openItemIds,
    ['item-c-2'],
    'unanswered item survives — the board only consumed the released one'
  )
})

test('runItemConsume --all: backend that reports no ids leaves the ledger untouched and warns', () => {
  const stubBin = writeStub(tmpDir, 0, '{"consumed":2}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'prd',
    openItemIds: ['item-c-1', 'item-c-2'],
  })

  const stderrOut = captureStderr(() => runItemConsume(undefined, true))

  assert.ok(stderrOut.includes('did not report which items it consumed'), 'warns on stderr')
  assert.ok(
    stderrOut.includes('consume --item "<id>"'),
    'the reconcile example quotes <id> — copied verbatim into a shell it is an argument, not input ' +
      'redirection'
  )
  const state = loadState(sessionId)
  assert.deepEqual(state!.openItemIds, ['item-c-1', 'item-c-2'], 'ledger left untouched')
  assert.equal(exitCodeIsError(), false, 'the board consume itself succeeded — not an error exit')
})

test('runItemConsume --all: empty ids list drops nothing and does not warn', () => {
  const stubBin = writeStub(tmpDir, 0, '{"consumed":0,"ids":[]}')
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'prd',
    openItemIds: ['item-c-1'],
  })

  const stderrOut = captureStderr(() => runItemConsume(undefined, true))

  assert.equal(stderrOut, '', 'no warning — the backend answered, it just consumed nothing')
  const state = loadState(sessionId)
  assert.deepEqual(state!.openItemIds, ['item-c-1'], 'nothing dropped')
})

test('runItemConsume: neither item nor --all surfaces the backend refusal instead of no-opping', () => {
  // FLOW-236: the backend already refuses a bare consume with exit 1. Returning before the call
  // hid that refusal; the wrapper must let it through. Still never passes --item ''.
  const stubBin = writeStub(
    tmpDir,
    1,
    '',
    'Error: specify --item <id> to consume one item, or --all to consume all'
  )
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'prd',
    openItemIds: ['item-c-1'],
  })

  const stderrOut = captureStderr(() => runItemConsume(undefined, false))

  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'the backend is invoked so its own refusal can surface')
  assert.equal(calls[0], `consume --session ${sessionId}`, 'no --item, no empty --item, no --all')
  assert.match(stderrOut, /specify --item/, "the backend's refusal reaches the caller")
  assert.equal(exitCodeIsError(), true, 'a refused consume is a non-zero exit')
  const state = loadState(sessionId)
  assert.deepEqual(state!.openItemIds, ['item-c-1'], 'openItemIds unchanged — nothing was consumed')
})

test('runItemWithdraw: neither item nor --all surfaces the backend refusal instead of no-opping', () => {
  const stubBin = writeStub(
    tmpDir,
    1,
    '',
    'Error: specify --item <id> to withdraw one item, or --session <sid> --all to withdraw all'
  )
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'prd',
    openItemIds: ['item-w-1'],
  })

  const stderrOut = captureStderr(() => runItemWithdraw(undefined, false))

  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'the backend is invoked so its own refusal can surface')
  // `item withdraw` refuses on `!flags.item && !flags.session` (the board app's own
  // `item withdraw`). Passing --session alone would instead trip its later "--session requires
  // --all" branch, a different, wronger message.
  assert.equal(
    calls[0],
    'item withdraw',
    'no flags at all — that is the branch with the right message'
  )
  assert.match(stderrOut, /specify --item/, "the backend's refusal reaches the caller")
  assert.equal(exitCodeIsError(), true, 'a refused withdraw is a non-zero exit')
  const state = loadState(sessionId)
  assert.deepEqual(state!.openItemIds, ['item-w-1'], 'openItemIds unchanged')
})

// The bare form targets no session at all, so sibling ambiguity must not block it — the fix moved
// this branch ahead of resolveSessionTargetOrRefuse specifically so this case reaches the backend
// instead of refusing on the two leaves it never needed to resolve.
test('runItemWithdraw: neither item nor --all reaches the backend even with two sibling leaves', () => {
  const stubBin = writeStub(
    tmpDir,
    1,
    '',
    'Error: specify --item <id> to withdraw one item, or --session <sid> --all to withdraw all'
  )
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

  const stderrOut = captureStderr(() => runItemWithdraw(undefined, false))

  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'the backend is invoked so its own refusal can surface')
  assert.equal(calls[0], 'item withdraw', 'no flags at all — sibling ambiguity never gets asked')
  assert.match(
    stderrOut,
    /specify --item/,
    "the backend's refusal reaches the caller, not a leaf-ambiguity refusal"
  )
  assert.equal(exitCodeIsError(), true, 'a refused withdraw is a non-zero exit')
})

// Same shape with zero leaves: the old resolver would fall through to a board round-trip here
// (session list), and refuse before ever reaching the backend. The bare form needs no session, so
// it must reach the backend directly instead.
test('runItemWithdraw: neither item nor --all reaches the backend even with zero leaves registered', () => {
  const stubBin = writeStub(
    tmpDir,
    1,
    '',
    'Error: specify --item <id> to withdraw one item, or --session <sid> --all to withdraw all'
  )
  process.env.AI_WORKFLOW_APP_BIN = stubBin

  const stderrOut = captureStderr(() => runItemWithdraw(undefined, false))

  const calls = readCalls(tmpDir)
  assert.equal(calls.length, 1, 'the backend is invoked so its own refusal can surface')
  assert.equal(calls[0], 'item withdraw', 'no flags at all — zero-leaf state never gets asked')
  assert.ok(
    !calls.some((c) => c.includes('session list')),
    'no board round-trip: the bare form never needed a resolved session'
  )
  assert.match(
    stderrOut,
    /specify --item/,
    "the backend's refusal reaches the caller, not a resolver refusal"
  )
  assert.equal(exitCodeIsError(), true, 'a refused withdraw is a non-zero exit')
})

test('runItemConsume --all: reports items the backend skipped as unread', () => {
  const stubBin = writeStub(
    tmpDir,
    0,
    '{"consumed":1,"ids":["item-c-1"],"skippedUnread":2,"skippedIds":["item-c-2","item-c-3"]}'
  )
  process.env.AI_WORKFLOW_APP_BIN = stubBin
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, {
    registered: true,
    phase: 'prd',
    openItemIds: ['item-c-1', 'item-c-2', 'item-c-3'],
  })

  const stderrOut = captureStderr(() => runItemConsume(undefined, true))

  assert.match(stderrOut, /2 item\(s\)/, 'the skip count reaches the agent')
  assert.match(stderrOut, /dashboard answers/, 'and names how to read them')
  const state = loadState(sessionId)
  assert.deepEqual(
    state!.openItemIds,
    ['item-c-2', 'item-c-3'],
    'only the consumed id is dropped — the skipped ones stay open so the Stop hook still blocks'
  )
  assert.equal(
    exitCodeIsError(),
    false,
    'a skip is a partial success — the read item really was consumed — not an error exit'
  )
})

// ---------------------------------------------------------------------------
// Tests: info notes (FLOW-389) — runItemAdd --type info
// ---------------------------------------------------------------------------

test('info note: posts --type info and prints the itemId with the approval reminder, but never touches openItemIds', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"note-1"}')
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, { registered: true, phase: 'implementation', openItemIds: ['q-1'] })

  const stdoutOut = captureStdout(() =>
    runItemAdd('info', 'The flaky test was a clock-skew bug\n\nFixed in the same PR.')
  )

  const addCalls = readCalls(tmpDir).filter((c) => c.startsWith('item add'))
  assert.equal(addCalls.length, 1, 'exactly one item add call')
  assert.ok(addCalls[0]!.includes('--type info'), 'posts --type info')
  assert.deepEqual(
    JSON.parse(stdoutOut),
    {
      itemId: 'note-1',
      note:
        'Nothing answers a note. If this asks the user to approve, merge, flip, proceed or validate ' +
        `anything, withdraw it (dashboard item withdraw --item note-1 --session ${sessionId}) and ` +
        'post it with --type approval.',
    },
    'prints the itemId and the reminder naming the withdraw command for this note'
  )
  assert.ok(stdoutOut.endsWith('}\n') && !stdoutOut.slice(0, -1).includes('\n'), 'one JSON line')
  assert.deepEqual(
    loadState(sessionId)!.openItemIds,
    ['q-1'],
    'the note id is not recorded and the open question is untouched'
  )
  assert.equal(getRequestedExitCode(), 0, 'exit code is exactly success')
})

test('an approval post prints only the itemId — the note reminder is for --type info alone', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"appr-1"}')
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)
  saveState(sessionId, { registered: true, phase: 'implementation', openItemIds: [] })

  const stdoutOut = captureStdout(() => runItemAdd('approval', 'Merge PR #1?'))

  assert.equal(stdoutOut, '{"itemId":"appr-1"}\n', 'prints exactly the itemId')
  assert.equal(getRequestedExitCode(), 0, 'exit code is exactly success')
})

test('info note: question and approval flags are refused, each named', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('info', 'A note', {
      approvalKind: 'hold',
      recommend: 'r',
      stalls: 'none',
      whyMine: 'fact',
      defer: true,
    })
  )
  assert.equal(
    stderrOut,
    'dashboard: --approval-kind, --recommend, --stalls, --why-mine, --defer only apply to --type question or approval — this item is --type info.\n' +
      'A note asks the user for nothing, so there is no decision, recommendation, wait or deferral for these flags to declare.\n' +
      'Drop --approval-kind, --recommend, --stalls, --why-mine, --defer, or post this as --type question if it needs an answer (skills/board/references/dashboard-protocol.md §8).\n'
  )
  assert.equal(getRequestedExitCode(), 1, 'exit code is exactly 1')
})

test('info note: a blank first line is refused', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () => runItemAdd('info', '\nburied lede'))
  assert.equal(
    stderrOut,
    'dashboard: the first line of --prompt is empty — a note has no lede.\n' +
      'The first line is what the user reads first. A note that opens with a blank line, a heading, or preamble buries what it is telling them.\n' +
      'Put what the user should know on the first line, in plain language (skills/board/references/dashboard-protocol.md §8).\n'
  )
  assert.equal(getRequestedExitCode(), 1, 'exit code is exactly 1')
})

test('info note: a lede over the cap is refused', () => {
  const { sessionId } = setUpQuestionStub()
  const stderrOut = assertRefused(sessionId, () => runItemAdd('info', 'x'.repeat(201)))
  assert.equal(
    stderrOut,
    'dashboard: the first line of --prompt is 201 characters — the lede cap is 200.\n' +
      'The lede is one line the user can take in at a glance; the detail belongs beneath it.\n' +
      'Shorten the first line and move the rest below it (skills/board/references/dashboard-protocol.md §8).\n'
  )
  assert.equal(getRequestedExitCode(), 1, 'exit code is exactly 1')
})

test('info note: a prompt over the cap is refused', () => {
  const { sessionId } = setUpQuestionStub()
  // 'Short lede\n\n' is 12 code points; 1489 more makes exactly the cap plus one.
  const stderrOut = assertRefused(sessionId, () =>
    runItemAdd('info', 'Short lede\n\n' + 'y'.repeat(1489))
  )
  assert.equal(
    stderrOut,
    'dashboard: --prompt is 1501 characters — the cap is 1500.\n' +
      'A note longer than one screen gets skimmed, and what it was posted to preserve is lost anyway.\n' +
      'Move the detail to a linked doc or a PR comment and link it from --prompt (skills/board/references/dashboard-protocol.md §8).\n'
  )
  assert.equal(getRequestedExitCode(), 1, 'exit code is exactly 1')
})

test('info note: an app that predates info refuses loudly and nothing is recorded', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(
    tmpDir,
    1,
    '',
    'Expected one of question|approval for --type, got info'
  )
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  registerRootNode(sessionId)

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemAdd('info', 'A note'))
  })

  assert.equal(stdoutOut, '', 'no itemId printed')
  assert.equal(
    stderrOut,
    `dashboard: ai-workflow-app item add --session ${sessionId} --type info --prompt A note failed: Expected one of question|approval for --type, got info\n`
  )
  assert.equal(getRequestedExitCode(), 1, 'exit code is exactly 1')
  assert.equal(loadState(sessionId), null, 'nothing recorded')
})

// ---------------------------------------------------------------------------
// FLOW-406: --answers/--replaces/--related pass through to the app, immediately or at flush
// ---------------------------------------------------------------------------

test('runItemAdd: references pass to the app as its own --answers/--replaces/--related flags', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"note-1"}')
  registerRootNode(sessionId)

  const stdoutOut = captureStdoutAssertingSuccess(() =>
    runItemAdd('info', 'The migration only adds a table.', {
      references: [
        { kind: 'answers', itemId: 'comment-1' },
        { kind: 'replaces', itemId: 'old-1' },
        { kind: 'related', itemId: 'approval-1' },
      ],
    })
  )

  const call = readCalls(tmpDir).find((c) => c.startsWith('item add'))
  assert.ok(
    call?.includes(
      '--type info --answers comment-1 --replaces old-1 --related approval-1 --prompt The migration'
    ),
    `each reference reaches the app as its own flag, got: ${String(call)}`
  )
  assert.equal(JSON.parse(stdoutOut).itemId, 'note-1')
})

test('--defer keeps references on the queued entry, and flush-deferred posts them', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"flushed-1"}')
  registerRootNode(sessionId)
  saveState(sessionId, { registered: true, phase: 'impl', openItemIds: [] })

  captureStdoutAssertingSuccess(() =>
    runItemAdd('question', 'File a ticket for the flaky test?', {
      ...questionDecl,
      defer: true,
      references: [{ kind: 'related', itemId: 'comment-7' }],
    })
  )
  assert.deepEqual(loadState(sessionId)?.deferredQuestions?.[0]?.references, [
    { kind: 'related', itemId: 'comment-7' },
  ])

  captureStdoutAssertingSuccess(() => runItemFlushDeferred())

  const call = readCalls(tmpDir).find((c) => c.startsWith('item add'))
  assert.ok(
    call?.includes('--type question --related comment-7 --prompt File a ticket'),
    `the flushed post carries the queued reference, got: ${String(call)}`
  )
})

test('flush-deferred names the failed entry, its references and a recovery that keeps the question', () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID!
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, '{"itemId":"unused"}')
  registerRootNode(sessionId)
  saveState(sessionId, { registered: true, phase: 'impl', openItemIds: [] })
  captureStdoutAssertingSuccess(() =>
    runItemAdd('question', 'File a ticket for the flaky test?', {
      ...questionDecl,
      defer: true,
      references: [{ kind: 'related', itemId: 'comment-7' }],
    })
  )
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 1, '', 'Referenced item not found: comment-7')

  let stdoutOut = ''
  const stderrOut = captureStderr(() => {
    stdoutOut = captureStdout(() => runItemFlushDeferred())
  })

  assert.equal(getRequestedExitCode(), 1)
  assert.equal(stdoutOut, JSON.stringify({ itemIds: [], flushed: 0, remaining: 1 }) + '\n')
  assert.equal(
    stderrOut,
    'dashboard: ai-workflow-app session list failed: Referenced item not found: comment-7\n' +
      `dashboard: ai-workflow-app item add --session ${sessionId} --type question --related comment-7 --prompt File a ticket for the flaky test?\n` +
      '\n' +
      '> **Recommend:** Ship it · **Stalls:** none · **Yours because:** scope\n' +
      '> *Deferred at impl.* failed: Referenced item not found: comment-7\n' +
      'dashboard: the post for q1 failed; it carries --related comment-7. It stays queued, and so does every entry after it.\n' +
      'If the failure is a refused reference, keep the question: read it with `dashboard item list-deferred`, run `dashboard item drop-deferred --id "q1" --reason "re-queued with corrected references"`, then re-queue it with `dashboard item add --defer` and the corrected --answers/--replaces/--related.\n'
  )
  assert.deepEqual(
    (loadState(sessionId)?.deferredQuestions ?? []).map((entry) => entry.id),
    ['q1'],
    'the entry stays queued'
  )
})
