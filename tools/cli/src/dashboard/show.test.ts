import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Helpers (mirrors item.test.ts)
// ---------------------------------------------------------------------------

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), 'show-test-'))

/**
 * Write a stub binary that records its argv, emits the given stdout/stderr, and exits with
 * exitCode. Payloads go through a QUOTED heredoc rather than `echo "<interpolated>"`: a
 * double-quoted bash word substitutes backticks as commands and leaves `\n` as two literal
 * characters, so a fixture quoting a real ai-workflow-app message — several of which contain
 * backticks — reaches the code under test as a different string than the test declares, while
 * still matching a loose assertion and passing.
 */
const writeStub = (dir: string, exitCode: number, stdout = '', stderr = ''): string => {
  const path = join(dir, 'ai-workflow-app')
  writeFileSync(
    path,
    `#!/usr/bin/env bash\n` +
      `echo "$@" >> ${JSON.stringify(join(dir, 'calls.log'))}\n` +
      heredoc(stderr, '>&2 ') +
      heredoc(stdout, '') +
      `exit ${exitCode}\n`
  )
  chmodSync(path, 0o755)
  return path
}

// Emit `text` byte for byte: a single-quoted delimiter turns off parameter, command and arithmetic
// expansion for the whole body. The delimiter is deliberately not a word any fixture would contain.
const heredoc = (text: string, redirect: string): string =>
  text
    ? `cat ${redirect}<<'AI_WORKFLOW_APP_STUB_PAYLOAD'\n${text}\nAI_WORKFLOW_APP_STUB_PAYLOAD\n`
    : ''

const readCalls = (dir: string): string[] => {
  const log = join(dir, 'calls.log')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf-8').split('\n').filter(Boolean)
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { runItemShow } from './show.ts'
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
let homeDir: string
let origHome: string | undefined

// No CLAUDE_CODE_SESSION_ID is set here, deliberately: runItemShow resolves no session, and a
// fixture that supplied one would hide a regression in which it started to. HOME is still
// overridden because the spawn pins cwd to homedir().
beforeEach(() => {
  tmpDir = makeTempDir()
  origBin = process.env.AI_WORKFLOW_APP_BIN
  // A test that forgets to wire its own stub must resolve to "dashboard unavailable" (an existing,
  // handled no-op), never fall through resolveDashboardBin's PATH lookup to the REAL installed
  // ai-workflow-app and drive it against the real board database. Wired tests overwrite this.
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'no-such-ai-workflow-app')
  homeDir = mkdtempSync(join(tmpdir(), 'show-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
  resetExitCode()
})

afterEach(() => {
  if (origBin === undefined) delete process.env.AI_WORKFLOW_APP_BIN
  else process.env.AI_WORKFLOW_APP_BIN = origBin
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
// Tests: runItemShow
// ---------------------------------------------------------------------------

// The criterion from the architecture doc, §Stories: the rendered output contains no `response` on
// ANY path. Table-driven over every lifecycle state and both item types rather than over the one
// case the feature was motivated by — a some-paths version of this test would give back exactly the
// guarantee that a retired backend-side option was traded for.
const LIFECYCLE_STATES = ['open', 'released', 'consumed', 'withdrawn'] as const
const SECRET_RESPONSE = 'ANSWER-SHOULD-NOT-APPEAR'
const SECRET_DECISION = 'DECISION-SHOULD-NOT-APPEAR'

test('runItemShow never prints the response or the decision in any lifecycle state', () => {
  for (const state of LIFECYCLE_STATES) {
    for (const type of ['question', 'approval']) {
      const payload = JSON.stringify({
        item: {
          id: 'item-1',
          sessionId: 'session-1',
          type,
          state,
          prompt: 'the original question text',
          response: SECRET_RESPONSE,
          decision: SECRET_DECISION,
          releasedAt: '2026-09-07T15:17:57.616Z',
          readAt: '2026-09-07T23:07:29.513Z',
          consumedAt: '2026-09-07T23:07:34.524Z',
          createdAt: '2026-09-06T23:14:27.530Z',
          updatedAt: '2026-09-07T23:07:34.524Z',
          deletedAt: null,
        },
      })
      process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, payload)
      resetExitCode()
      let out = ''
      const err = captureStderr(() => {
        out = captureStdout(() => runItemShow('item-1'))
      })
      assert.ok(
        out.includes('the original question text'),
        `prompt missing for ${type}/${state}: ${out}`
      )
      // All three channels, not stdout alone: "the rendered output contains no response" is the
      // whole point of this command, and a leak onto stderr — or an error path that prints the row
      // while refusing — satisfies a stdout-only reading of the criterion and stays green.
      for (const [channel, text] of [
        ['stdout', out],
        ['stderr', err],
      ] as const) {
        assert.ok(
          !text.includes(SECRET_RESPONSE),
          `response leaked on ${channel} for ${type}/${state}: ${text}`
        )
        assert.ok(
          !text.includes(SECRET_DECISION),
          `decision leaked on ${channel} for ${type}/${state}: ${text}`
        )
      }
      assert.equal(
        exitCodeIsError(),
        false,
        `a successful read for ${type}/${state}, not a refusal`
      )
    }
  }
})

test('runItemShow calls item show with the id and passes no session flag', () => {
  const payload = JSON.stringify({
    item: { id: 'item-2', sessionId: 's', type: 'question', state: 'consumed', prompt: 'q text' },
  })
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, payload)
  const out = captureStdout(() => runItemShow('item-2'))
  assert.equal(out, '[dashboard] item item-2 question/consumed\nq text\n')
  const calls = readCalls(tmpDir)
  assert.deepEqual(calls, ['item show --item item-2'])
})

test('runItemShow renders a placeholder when the row has no prompt', () => {
  const payload = JSON.stringify({
    item: { id: 'item-3', sessionId: 's', type: 'approval', state: 'open' },
  })
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, payload)
  const out = captureStdout(() => runItemShow('item-3'))
  assert.equal(out, '[dashboard] item item-3 approval/open\nno prompt recorded\n')
})

// Fixture verbatim from ai-workflow-app's own `reportMissingItem`
// (packages/cli/src/cli/commands/item/missing.ts), which is what `item show` calls when findItem
// returns null: `Error: Item not found: <id>` on stderr, exit 1. Confirmed against the installed
// binary, not read off the plan.
test('runItemShow reports a missing item and requests a non-zero exit', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 1, '', 'Error: Item not found: item-404')
  let out = ''
  const err = captureStderr(() => {
    out = captureStdout(() => runItemShow('item-404'))
  })
  assert.equal(out, '')
  assert.match(err, /Error: Item not found: item-404/)
  assert.ok(!err.includes('predates the read-by-id verb'))
  assert.ok(exitCodeIsError())
})

// Fixture verbatim from the installed ai-workflow-app: an unregistered verb exits 251 and writes
// ``No command registered for `show` `` followed by a USAGE block. The backticks are load-bearing —
// they are what an earlier `echo "<interpolated>"` stub silently ran as a command, leaving the
// fixture a different string than this line reads.
test('runItemShow adds a version hint when the backend has no show route', () => {
  const stderr = 'No command registered for `show`\n\nUSAGE\n  ai-workflow-app item add ...'
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 251, '', stderr)
  let out = ''
  const err = captureStderr(() => {
    out = captureStdout(() => runItemShow('item-5'))
  })
  assert.equal(out, '')
  assert.match(err, /No command registered for `show`/)
  assert.match(err, /predates the read-by-id verb/)
  assert.ok(exitCodeIsError())
})

test('runItemShow reports an unparseable payload instead of printing nothing', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, 'not json at all')
  let out = ''
  const err = captureStderr(() => {
    out = captureStdout(() => runItemShow('item-6'))
  })
  assert.equal(out, '')
  assert.match(err, /could not parse item show output/)
  assert.ok(exitCodeIsError())
})

test('runItemShow is a silent no-op when the dashboard is unavailable', () => {
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'no-such-ai-workflow-app')
  let out = ''
  const err = captureStderr(() => {
    out = captureStdout(() => runItemShow('item-7'))
  })
  assert.equal(out, '')
  assert.equal(err, '')
  assert.ok(!exitCodeIsError())
})

// The other half of the acceptance criterion. "Writes nothing" is a claim about local state as well
// as about the board, and the two fail independently: the backend verb being a select says nothing
// about whether this wrapper saves a state file on the way past. Snapshots the whole overridden
// HOME rather than one known path, so a write to any sink — session state, the registry, a gate
// record, a file this test does not know the name of — is caught by the same assertion.
test('runItemShow writes nothing to local state', () => {
  const payload = JSON.stringify({
    item: { id: 'item-8', sessionId: 's', type: 'question', state: 'released', prompt: 'q text' },
  })
  process.env.AI_WORKFLOW_APP_BIN = writeStub(tmpDir, 0, payload)

  const before = snapshotHome()
  const out = captureStdout(() => runItemShow('item-8'))

  // A non-empty positive observation first: an invariance assertion over a call that silently did
  // nothing is byte-identical to one over a call that worked, and this pins which one happened.
  assert.match(out, /q text/, 'the read actually ran — otherwise the snapshot proves nothing')
  assert.deepEqual(snapshotHome(), before, 'no file under HOME created, removed or modified')
})

// Every file under the overridden HOME, as `<relative path>\t<contents>`, sorted — so the
// comparison catches a new file, a deleted one, and an edit to an existing one alike.
const snapshotHome = (): string[] =>
  readdirSync(homeDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const full = join(entry.parentPath, entry.name)
      return `${full.slice(homeDir.length)}\t${readFileSync(full, 'utf-8')}`
    })
    .sort()
