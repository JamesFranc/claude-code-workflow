import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { manifestPath } from '../gate-ledger/manifest.ts'
import { runOpenFindingScoped } from './run.ts'
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'
import { StoreUnreadableError } from '../workflow-store/store.ts'

let ticket: string
let homeDir: string
let origHome: string | undefined

const captureStdout = (fn: () => void): string => {
  const written: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string) => {
    written.push(chunk)
    return true
  }) as typeof process.stdout.write
  try {
    fn()
  } finally {
    process.stdout.write = original
  }
  return written.join('')
}

// manifestPath resolves through the durable store, which is homedir()-relative — override HOME so
// these tests never touch the real ~/.claude/workflow-state (mirrors proof-ledger/run.test.ts).
beforeEach(() => {
  const unique = mkdtempSync(join(tmpdir(), 'review-ledger-run-test-')).replace(
    /[^a-zA-Z0-9]/g,
    '-'
  )
  ticket = `FLOW-TEST-${unique.slice(-32)}`
  homeDir = mkdtempSync(join(tmpdir(), 'review-ledger-run-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
  setRequestedExitCode(0)
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  rmSync(homeDir, { recursive: true, force: true })
})

// A directory where the manifest file belongs rather than a chmod: root bypasses permission bits,
// so a mode-000 file stays readable under a root test runner and the fixture never reaches the
// branch under test. EISDIR comes back to every uid.
const plantUnreadableManifest = (): void => {
  mkdirSync(manifestPath(ticket), { recursive: true })
  assert.throws(
    () => readFileSync(manifestPath(ticket), 'utf-8'),
    /EISDIR/,
    'precondition: the fixture must actually be unreadable, or this test observes nothing'
  )
}

const openAgainstUnnamedCheck = (): void =>
  runOpenFindingScoped(
    ticket,
    'docs/plans/2026-01-01-FLOW-TEST-proofs.md',
    'someSymbol',
    'a summary',
    undefined,
    undefined,
    'typecheck'
  )

test('finding open: an unreadable gate manifest is diagnosed, not reported as "none declared" (FLOW-226 finding b5c6d65adf45)', () => {
  plantUnreadableManifest()

  assert.throws(
    openAgainstUnnamedCheck,
    // The class is the contract: review-ledger's runGuarded maps it to exit 26, which prescribes
    // repairing the file — the opposite of what "none declared" would send the reader to do.
    (error: unknown) =>
      error instanceof StoreUnreadableError &&
      /exists but could not be read \(EISDIR\)/.test(error.message),
    'a manifest this process never read cannot be described as declaring nothing'
  )
})

test('finding open: an absent gate manifest still refuses with "none declared" — the two stay distinct', () => {
  const out = captureStdout(openAgainstUnnamedCheck)

  assert.equal(getRequestedExitCode(), 16, 'an unrecognised --check is still a clean refusal')
  assert.match(
    JSON.parse(out).error,
    /none declared/,
    'absent is the one case that declares nothing'
  )
})

test("finding open: a manifest that does not yield a gate list refuses carrying parseManifest's own reason (FLOW-226 finding 544521332a93)", () => {
  // parseManifest throws from six places and only one is JSON.parse's. The gates-shape row and the
  // blank-name row both hold syntactically perfect JSON, so any sentence this code composed about
  // parsing would be false for them. The truncated-JSON row is the one arm where a syntax claim
  // WOULD have been true: it is here to give the distinct-messages assertion below a real syntax
  // message to hold against the shape and blank-name messages, and because it is the arm that names
  // the file only because parseManifest wraps its JSON.parse.
  const arms: [string, string, RegExp][] = [
    [
      'a gates field that is not an array',
      '{"gates": "not an array"}',
      /expected an object with a "gates" array/,
    ],
    [
      'a row whose name is blank',
      '{"gates": [{"name": "", "command": "pnpm typecheck", "owner": "implementer"}]}',
      /gates\[0\]\.name must be a non-blank string/,
    ],
    ['content that is not JSON at all', '{"gates": [', /Unexpected end of JSON input/],
  ]

  const seen = new Set<string>()
  mkdirSync(dirname(manifestPath(ticket)), { recursive: true })
  for (const [label, content, reason] of arms) {
    setRequestedExitCode(0)
    writeFileSync(manifestPath(ticket), content)

    const { error } = JSON.parse(captureStdout(openAgainstUnnamedCheck))

    assert.equal(
      getRequestedExitCode(),
      16,
      `${label}: the refusal is unchanged — exit 16, no throw`
    )
    assert.doesNotMatch(
      error,
      /none declared/,
      `${label}: a manifest that exists may declare gates`
    )
    assert.match(error, /does not declare a usable gate list/, `${label}: names the class`)
    assert.match(error, reason, `${label}: and carries the reason parseManifest actually threw`)
    assert.equal(
      error.split(manifestPath(ticket)).length - 1,
      1,
      `${label}: the file is named exactly once — every parseManifest throw prefixes the path, so ` +
        'a caller that adds it too prints it twice, and one that strips its own leaves the ' +
        'JSON.parse arm naming no file at all'
    )
    seen.add(error)
  }

  assert.equal(
    seen.size,
    arms.length,
    'each arm reports its own reason — a single fixture covering all three arms is what let a ' +
      'sentence about syntax ship against the five validation throws, which fire on content ' +
      'parsing perfectly'
  )
})

test('finding open: a declared gate name is accepted as a --check citation', () => {
  mkdirSync(dirname(manifestPath(ticket)), { recursive: true })
  writeFileSync(
    manifestPath(ticket),
    JSON.stringify({
      gates: [{ name: 'typecheck', command: 'pnpm typecheck', owner: 'implementer' }],
    })
  )

  openAgainstUnnamedCheck()

  assert.equal(getRequestedExitCode(), 0, 'the manifest read is what makes the citation resolvable')
})

test('finding open: a capture-id --check needs no manifest read, even an unreadable one (FLOW-226 finding 8196c9575f78)', () => {
  plantUnreadableManifest()

  assert.doesNotThrow(
    () =>
      runOpenFindingScoped(
        ticket,
        'docs/plans/2026-01-01-FLOW-TEST-proofs.md',
        'someSymbol',
        'a summary',
        undefined,
        undefined,
        'abcdef012345'
      ),
    'a 12-hex capture id is self-certifying and never needs the gate manifest'
  )
  assert.equal(getRequestedExitCode(), 0, 'the finding opens cleanly on a capture-id citation')
})
