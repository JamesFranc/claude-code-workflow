// Coverage argument, not enumeration: runSessionKey has 4 outcomes (zero+no-require, zero+require,
// one-match, two-plus) × 3 observable channels (stdout, stderr, exit code) = 12 cells. Every cell is
// asserted by at least one test below, so any mutation that changes observable behavior must flip
// one of those assertions — the set is closed by this count, not by how many mutations we thought to
// try. (Anchoring/escaping/prefix-matching correctness is a separate concern, covered by the
// dedicated tests further down — this grid is only about the 4-outcome/3-channel contract itself.)
//
//                stdout                  stderr                    exit code
//  zero,          '' (assertNoMatch)      '' (assertNoMatch)        not error (assertNoMatch)
//  no --require
//  zero,          '' (inline)             names the false           error (inline)
//  --require                              precondition (inline)
//  one match      the resolved key        '' (inline)                not error (inline)
//                 (multiple tests)
//  two or more    '' (inline)             names every match by      error (inline)
//                                         key/external/internal
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSessionKey } from './key.ts'
import { upsertRegistryNode } from './registry.ts'
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'

let rawId: string
let homeDir: string
let origHome: string | undefined
let origSessionId: string | undefined

/** Suppress and capture stdout written during fn(), then restore it. Same idiom as
 * `captureStdout` in `tools/cli/src/workflow-state/run.test.ts` — no type assertion. */
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

/** Same, for stderr — idiom from `captureStderr` in `tools/cli/src/dashboard/enter.test.ts`. */
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

const exitCodeIsError = (): boolean => {
  const code = getRequestedExitCode()
  return code !== undefined && code !== 0
}

/** Assert a zero-match call is genuinely silent — no stdout, no stderr, no error exit. Empty stdout
 * alone doesn't distinguish "matched nothing, exit 0" from "errored out having printed nothing to
 * stdout" (both look identical to a stdout-only assertion), so every zero-match test needs all three. */
const assertNoMatch = (ticket: string, message: string): void => {
  let stdout = ''
  const stderr = captureStderr(() => {
    stdout = captureStdout(() => runSessionKey(ticket))
  })
  assert.equal(stdout, '', `${message} (stdout)`)
  assert.equal(stderr, '', `${message} (stderr)`)
  assert.equal(exitCodeIsError(), false, `${message} (exit code)`)
}

/** Record a node the way `enter` would, with only the fields this verb reads. */
const record = (key: string | null, internalId: string): void =>
  upsertRegistryNode(rawId, {
    internalId,
    externalId: key === null ? `${rawId}_abcd1234` : `${rawId}_abcd1234:${key}`,
    key,
    parentId: key === null ? null : 'root-id',
  })

// loadRegistry resolves through the durable store, which is homedir()-relative — override HOME so
// these tests never touch the real ~/.claude/workflow-state. The session id is derived from the temp
// dir so concurrent test files cannot collide on one registry.
beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'key-test-home-'))
  rawId = `key-test-${homeDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)}`
  origHome = process.env.HOME
  process.env.HOME = homeDir
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  setRequestedExitCode(0)
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  if (origSessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = origSessionId
  rmSync(homeDir, { recursive: true, force: true })
})

// No CLAUDE_CODE_SESSION_ID and no --session: resolveRawSessionId throws inside runSessionKey —
// proving the try/catch around it reuses the thrown message and sets exit 1 instead of letting
// the throw escape uncaught.
test('runSessionKey: no session id — refuses cleanly instead of throwing', () => {
  delete process.env.CLAUDE_CODE_SESSION_ID

  let stdout = ''
  let stderr = ''
  assert.doesNotThrow(() => {
    stderr = captureStderr(() => {
      stdout = captureStdout(() => runSessionKey('FLOW-500'))
    })
  })

  assert.ok(
    stderr.includes('No session id: pass --session or set CLAUDE_CODE_SESSION_ID'),
    'stderr carries resolveRawSessionId’s own message'
  )
  // A zero-match, no --require call also prints nothing (assertNoMatch above) — an empty stdout
  // here is what tells a refusal apart from that success case, not just truthiness.
  assert.equal(stdout, '', 'a refusal must not print the same nothing a zero-match success would')
  assert.equal(exitCodeIsError(), true, 'a caller must see this as a failure, not a success')
})

test('runSessionKey: prints the plain ticket key when that is the node in the registry', () => {
  record(null, 'root-id')
  record('FLOW-500', 'ticket-id')

  let stdout = ''
  const stderr = captureStderr(() => {
    stdout = captureStdout(() => runSessionKey('FLOW-500'))
  })
  assert.equal(stdout, 'FLOW-500\n')
  assert.equal(stderr, '', 'a successful match writes nothing to stderr')
  assert.equal(exitCodeIsError(), false, 'a successful match never requests an error exit')
})

test('runSessionKey: prints the resumed key after a restart recovery forgot the original', () => {
  record(null, 'root-id')
  record('FLOW-500-resumed', 'resumed-id')

  assert.equal(
    captureStdout(() => runSessionKey('FLOW-500')),
    'FLOW-500-resumed\n',
    'the resumed node is the live one — this is the FLOW-207 case'
  )
})

// Same key, different nodes — the dead-ROOT-recovery pair (see Design). Deliberately chosen over a
// differing-key pair: it is the case a key-only error message cannot describe, so it pins the
// message's content as well as the refusal. All three assertions matter — a stdout-only assertion
// would stay GREEN when the refusal is deleted, which is the trap that killed the previous break #1.
test('runSessionKey: two live nodes for one ticket is an ambiguity the verb refuses', () => {
  record(null, 'root-id')
  upsertRegistryNode(rawId, {
    internalId: 'old-node',
    externalId: `${rawId}_aaaa1111:FLOW-500`,
    key: 'FLOW-500',
    parentId: null,
  })
  upsertRegistryNode(rawId, {
    internalId: 'new-node',
    externalId: `${rawId}_bbbb2222:FLOW-500`,
    key: 'FLOW-500',
    parentId: null,
  })

  let stdout = ''
  const stderr = captureStderr(() => {
    stdout = captureStdout(() => runSessionKey('FLOW-500'))
  })

  assert.equal(stdout, '', 'nothing on stdout — a caller must not read a guess as an answer')
  assert.equal(exitCodeIsError(), true, 'ambiguity is an error, not a silent pick')
  assert.match(stderr, /old-node/, 'stderr names the first node by internal id')
  assert.match(stderr, /new-node/, 'stderr names the second node by internal id')
  assert.match(
    stderr,
    /aaaa1111:FLOW-500[\s\S]*bbbb2222:FLOW-500/,
    'both external ids appear — a key-only message would print "FLOW-500, FLOW-500" and propose a --key that cannot distinguish them'
  )
})

test("runSessionKey: a -resumed-N key is recognised as this ticket's node", () => {
  record(null, 'root-id')
  record('FLOW-500-resumed-2', 'resumed-2-id')

  assert.equal(
    captureStdout(() => runSessionKey('FLOW-500')),
    'FLOW-500-resumed-2\n',
    'the -resumed-N shape stays pinned now that nothing orders it'
  )
})

test('runSessionKey: prints nothing when the ticket has no keyed node', () => {
  record(null, 'root-id')

  assertNoMatch(
    'FLOW-500',
    'the ticket IS the root, or has not been entered — the caller falls back to the ticket id'
  )
})

// The anchor's own test. Test 6 below does NOT cover it: `FLOW-5000` fails on the literal `-resumed`
// substring, anchor or no anchor, so dropping the trailing `$` leaves it green. This key shares the
// whole `-resumed` prefix and continues past what `(?:-\d+)?$` accepts, which is the only shape that
// distinguishes the anchored pattern from the unanchored one.
test('runSessionKey: a key extending past the -resumed suffix is not this ticket', () => {
  record(null, 'root-id')
  record('FLOW-500-resumed-review', 'other-id')

  assertNoMatch(
    'FLOW-500',
    'FLOW-500-resumed-review is some other node, not FLOW-500 at a recovery generation'
  )
})

// The leading anchor's own test, mirroring the trailing-anchor test above. `FLOW-500` alone never
// falsifies this: as a *substring* match (no leading `^`) it would still fail to find `-resumed`
// anywhere in `FLOW-500`. This key has the exact `-resumed` suffix, just preceded by extra
// characters — the only shape a leading-anchor removal lets through that the anchored form rejects.
test('runSessionKey: a key with extra characters before the ticket id is not this ticket', () => {
  record(null, 'root-id')
  record('XFLOW-500-resumed', 'other-id')

  assertNoMatch('FLOW-500', 'XFLOW-500-resumed belongs to some other ticket, not FLOW-500')
})

// escapeForPattern's own test. None of the FLOW-500-shaped tests above ever exercise a regex
// metacharacter, so a deleted escapeForPattern call is invisible to them: `.` in an unescaped
// pattern matches any character, which would wrongly treat a completely different node as this
// ticket's resumed node.
test('runSessionKey: a ticket id containing a regex metacharacter matches literally', () => {
  record(null, 'root-id')
  record('FLOWX500-resumed', 'other-id')

  assertNoMatch(
    'FLOW.500',
    'unescaped, the "." in FLOW.500 would match the "X" in FLOWX500-resumed as any character'
  )
})

test('runSessionKey: --require turns a legitimate zero into a hard failure', () => {
  record(null, 'root-id')

  let stdout = ''
  const stderr = captureStderr(() => {
    stdout = captureStdout(() => runSessionKey('FLOW-500', true))
  })

  assert.equal(stdout, '', 'still nothing on stdout')
  assert.equal(exitCodeIsError(), true, '--require makes the missing node an error')
  assert.match(stderr, /precondition is false/, 'stderr says what the caller got wrong')
})

test('runSessionKey: --require is silent when the node is there', () => {
  record(null, 'root-id')
  record('FLOW-500-resumed', 'resumed-id')

  assert.equal(
    captureStdout(() => runSessionKey('FLOW-500', true)),
    'FLOW-500-resumed\n'
  )
  assert.equal(exitCodeIsError(), false, '--require only fires on zero matches')
})

test('runSessionKey: a different ticket whose id is a prefix is never matched', () => {
  record(null, 'root-id')
  record('FLOW-5000', 'other-ticket-id')

  assertNoMatch(
    'FLOW-500',
    'FLOW-500 must not match FLOW-5000 — the pattern is anchored at both ends'
  )
})

test('runSessionKey: a branch-keyed PR node under the ticket is never mistaken for it', () => {
  record(null, 'root-id')
  record('FLOW-500-resumed', 'resumed-id')
  record('flow-500-repo-b', 'branch-id')

  assert.equal(
    captureStdout(() => runSessionKey('FLOW-500')),
    'FLOW-500-resumed\n'
  )
})
