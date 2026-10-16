import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readLedger, findingId, ledgerFileExists, appendEvent } from './ledger.ts'
import {
  runOpenFinding,
  runSetFindingStatus,
  runAssignFinding,
  runRecordInstruction,
  runDisposeInstruction,
  runDisposeInstructionBatch,
  runShow,
  runShowRound,
  runNextRound,
  runRecordSeniorSpawned,
  runRecordSeniorShutdown,
  runRecordReviewStart,
  runRecordReviewComplete,
  runCloseRound,
  runRoundAdvance,
  isCheckTarget,
} from './run.ts'
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'
import {
  appendLine,
  load,
  StoreUnreadableError,
  storePath,
  ticketScope,
} from '../workflow-store/store.ts'
import { writeManifest } from '../gate-ledger/manifest.ts'

// A test whose failure only chmod can produce skips under root — root ignores mode bits, so the
// fixture never reaches that failure there.
const rootCannotBeDeniedAccess = process.getuid?.() === 0

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))
const LEDGER_FILE = 'review-ledger.jsonl'

let tmpDir: string
let ticket: string
let homeDir: string
let origHome: string | undefined
let createdRepos: string[]

const resetExitCode = (): void => setRequestedExitCode(0)

// readLedger/appendEvent resolve through the durable store, which is homedir()-relative —
// override HOME so these tests never touch the real ~/.claude/workflow-state.
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'review-ledger-test-'))
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  ticket = `FLOW-TEST-${uniqueId}`
  homeDir = mkdtempSync(join(tmpdir(), 'review-ledger-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
  createdRepos = []
  resetExitCode()
})

afterEach(() => {
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
  for (const repo of createdRepos) {
    try {
      rmSync(repo, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

/** Suppress and capture stdout written during fn(), then restore it. */
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

/**
 * Opens a throwaway finding against the ledger's CURRENT round, satisfying
 * `checkRoundReviewed`'s mark requirement for a fixture that would otherwise close or advance an
 * unmarked round. Findings are looked up by id elsewhere in this file, so this one's distinct
 * file/symbol/summary never collides with a test's own finding assertions. The summary carries the
 * round number so a second call in a later round mints a fresh finding id rather than re-raising the
 * first call's finding, which would leave that finding's raisedInRound frozen on the earlier round.
 */
const markRoundReviewed = (): void => {
  const round = readLedger(ticket).round
  captureStdout(() =>
    runOpenFinding(ticket, 'src/review-mark.ts', 'reviewMark', `a review mark for round ${round}`)
  )
  resetExitCode()
}

interface CliResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

/**
 * Run the real CLI as a separate process sharing this test's HOME; captures both streams and the exit code.
 * `cwd` defaults to this process's own — pass one explicitly to prove a code path never shells out
 * to git at all (a non-repo cwd that would fail any git call it actually made).
 */
const runCli = (args: string[], cwd?: string, nodeFlags: string[] = []): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...nodeFlags, '--experimental-transform-types', mainTsPath, ...args],
      {
        env: { ...process.env, HOME: homeDir },
        ...(cwd !== undefined ? { cwd } : {}),
      }
    )
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }))
  })

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

// Like runCli, but the child touches readyPath the instant it starts and then busy-waits for
// barrierPath to appear before doing any real work — so a caller can hold several children at the
// starting line and release them together, forcing their writes to actually overlap instead of
// merely running "concurrently" in a way OS scheduling can still serialize.
const runCliBarriered = (
  args: string[],
  readyPath: string,
  barrierPath: string
): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const script = [
      `touch ${shellQuote(readyPath)}`,
      `while [ ! -f ${shellQuote(barrierPath)} ]; do sleep 0.001; done`,
      `exec ${shellQuote(process.execPath)} --experimental-transform-types ${shellQuote(mainTsPath)} ${args.map(shellQuote).join(' ')}`,
    ].join(' && ')
    const child = spawn('bash', ['-c', script], { env: { ...process.env, HOME: homeDir } })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }))
  })

/** Poll until predicate() is true. Used to wait for both barrier children to signal ready. */
const waitUntil = async (predicate: () => boolean): Promise<void> => {
  while (!predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

const rawLedgerContent = (t: string): string => load(ticketScope(t), LEDGER_FILE) ?? ''
const rawLedgerPath = (t: string): string => storePath(ticketScope(t), LEDGER_FILE)
const roundClaimPath = (t: string, round: number): string =>
  storePath(ticketScope(t), `round-${round}.advance-claim`)

// The stance-contradiction tests below need a real git repo — checkDeclaredStance shells out to
// computeStance, which cannot be satisfied by a synthetic sha the way the rest of this file's fixtures
// are. Mirrors stance.test.ts's own makeRepo/commitFile/headSha helpers.
const gitRun = (repo: string, args: string[]): void => {
  const result = spawnSync('git', args, { cwd: repo, stdio: 'pipe' })
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString() ?? ''}`)
}

const makeRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), 'ledger-test-repo-'))
  createdRepos.push(repo)
  gitRun(repo, ['init', '--initial-branch=main'])
  gitRun(repo, ['config', 'user.email', 'test@example.com'])
  gitRun(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'seed.txt'), 'seed\n')
  gitRun(repo, ['add', '-A'])
  gitRun(repo, ['commit', '-m', 'seed'])
  // clause (c) reads origin/main; a local ref under refs/remotes makes it resolvable with no remote.
  gitRun(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  return repo
}

const headSha = (repo: string): string =>
  spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.toString().trim()

const commitFile = (repo: string, path: string, content: string, message: string): string => {
  const full = join(repo, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  gitRun(repo, ['add', '-A'])
  gitRun(repo, ['commit', '-m', message])
  return headSha(repo)
}

// The licence every stance test below passes to reach the check it is actually about. Those tests
// produce a known 'cleanup' computation by re-pinning the anchor sha, whose self-range is empty so
// no clause can fire — which is also, exactly, a close at a sha an earlier round already recorded,
// and is refused at exit 21 before checkDeclaredStance ever runs. Licensing it is the honest fix
// rather than rebuilding the fixture: the empty-range self-check is these tests' mechanism for
// pinning a computed stance, and the licensed re-review is a real case, so passing it here exercises
// the licence path four more times instead of routing around it.
const stanceFixtureShaReuse = 'stance fixture: re-pins the anchor sha to force an empty self-range'

// A real synchronous delay — long enough to cross a millisecond boundary deterministically, so a
// timestamp-tainted id (the RED-baseline mutation this guards against) cannot pass by landing in
// the same millisecond as the first call.
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

test('a finding-open event then readLedger returns it open, stamped with the round it was actually raised in', () => {
  // Opened in round 1, before any bump — its own baseline data point.
  const roundOneOutput = captureStdout(() =>
    runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'off-by-one in doThing')
  )
  const { id: roundOneId } = JSON.parse(roundOneOutput) as { id: string }

  captureStdout(() => runNextRound(ticket, 'sha-closing-round-1', 'adversarial'))
  markRoundReviewed()
  captureStdout(() =>
    runNextRound(ticket, 'sha-closing-round-2', 'adversarial', 'fixture sha, not a real commit')
  )

  // Opened after two bumps, in round 3 — a value distinct from both 1 and the module's `let round
  // = 1` initializer, so a hardcoded round:1 in runOpenFinding or in the fold cannot pass this by
  // coincidence the way comparing two variables that both default to 1 can.
  const roundThreeOutput = captureStdout(() =>
    runOpenFinding(ticket, 'src/bar.ts', 'doOther', 'a second defect summary')
  )
  const { id: roundThreeId } = JSON.parse(roundThreeOutput) as { id: string }

  const ledger = readLedger(ticket)
  assert.equal(ledger.round, 3, 'two next-round calls advanced the ledger to round 3')

  const findingOne = ledger.findings.find((f) => f.id === roundOneId)
  const findingThree = ledger.findings.find((f) => f.id === roundThreeId)
  assert.ok(findingOne, 'the round-1 finding is present')
  assert.ok(findingThree, 'the round-3 finding is present')
  assert.equal(findingOne!.status, 'open', 'status is open')
  assert.equal(
    findingOne!.raisedInRound,
    1,
    'the first finding is stamped with the round it was actually opened in (1)'
  )
  assert.equal(
    findingThree!.raisedInRound,
    3,
    'the second finding is stamped with the round it was actually opened in (3), not carried over from the first'
  )
})

test('two finding-open calls with identical (file, symbol, summary) produce one finding, not two', () => {
  captureStdout(() => runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'off-by-one in doThing'))
  sleepSync(5)
  captureStdout(() => runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'off-by-one in doThing'))

  const ledger = readLedger(ticket)
  const matches = ledger.findings.filter((f) => f.file === 'src/foo.ts' && f.symbol === 'doThing')
  assert.equal(matches.length, 1, 'the second identical open is idempotent, not a duplicate row')
})

test('a finding opened with no --origin round-trips as origin senior, the default', () => {
  const openOutput = captureStdout(() =>
    runOpenFinding(ticket, 'src/default-origin.ts', 'doDefault', 'no origin supplied')
  )
  const { id } = JSON.parse(openOutput) as { id: string }

  const ledger = readLedger(ticket)
  const finding = ledger.findings.find((f) => f.id === id)
  assert.equal(finding?.origin, 'senior', 'omitting --origin defaults the finding to senior')
})

test('a finding opened with --origin coderabbit round-trips carrying that value, not the default', () => {
  const openOutput = captureStdout(() =>
    runOpenFinding(
      ticket,
      'src/bot-origin.ts',
      'doBotFlagged',
      'flagged by an external tool',
      undefined,
      'coderabbit'
    )
  )
  const { id } = JSON.parse(openOutput) as { id: string }

  const ledger = readLedger(ticket)
  const finding = ledger.findings.find((f) => f.id === id)
  assert.equal(finding?.origin, 'coderabbit', 'an explicit --origin survives the round trip')
})

test('a finding opened with --origin team-lead round-trips carrying that value, through the real CLI process', async () => {
  const repo = makeRepo()
  commitFile(repo, 'src/team-lead-origin.ts', 'content\n', 'add src/team-lead-origin.ts')
  const openResult = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'src/team-lead-origin.ts',
    '--symbol',
    'doTeamLeadFlagged',
    '--summary',
    'raised by the team lead directly, not through the senior review flow',
    '--origin',
    'team-lead',
    '--repo-root',
    repo,
  ])
  assert.equal(openResult.exitCode, 0, 'the real CLI process accepts --origin team-lead')
  const { id } = JSON.parse(openResult.stdout) as { id: string }

  const ledger = readLedger(ticket)
  const finding = ledger.findings.find((f) => f.id === id)
  assert.equal(
    finding?.origin,
    'team-lead',
    'an explicit --origin team-lead survives the round trip'
  )
})

test('--origin rejects a value that is still not one of the recognized origins, through the real CLI process', async () => {
  const openResult = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'src/bad-origin.ts',
    '--symbol',
    'doBadOrigin',
    '--summary',
    'an origin value this CLI has never recognized',
    '--origin',
    'implementer',
  ])
  assert.notEqual(
    openResult.exitCode,
    0,
    'an unrecognized --origin value is still rejected at the real argument-parsing layer, not silently accepted'
  )
})

test('a finding-open event with an invalid origin value is rejected as corrupt, not coerced to senior', () => {
  const id = findingId(ticket, 'src/mistyped-origin.ts', 'doThing', 'has a mistyped origin')
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({
      kind: 'finding-open',
      at: new Date().toISOString(),
      id,
      round: 1,
      file: 'src/mistyped-origin.ts',
      symbol: 'doThing',
      summary: 'has a mistyped origin',
      origin: 'banana',
    })
  )

  const ledger = readLedger(ticket)
  assert.equal(
    ledger.skippedLines,
    1,
    'a present-but-invalid origin is rejected like any other malformed event'
  )
  assert.equal(
    ledger.findings.find((f) => f.id === id),
    undefined,
    'the rejected line does not partially fold in — no finding is recorded for it'
  )
})

test('findingId separates fields so a value spanning a boundary cannot forge a collision', () => {
  const idA = findingId(ticket, 'a:b', 'c', 'summary')
  const idB = findingId(ticket, 'a', 'b:c', 'summary')
  assert.notEqual(idA, idB, 'different (file, symbol) splits hash differently')
})

test('findingId with no --check hashes to the same id it did before check joined the hash input — pinned literal, not a re-derivation', () => {
  const id = findingId(
    'FIXED-TICKET-1',
    'src/pinned-fixture.ts',
    'PinnedSymbol',
    'a pinned summary for backward-compat proof'
  )
  assert.equal(
    id,
    '543c962a1f14',
    'every pre-existing (undefined-check) record must keep hashing to its original id'
  )
})

test('findingId with a --check value differs from the no-check id for the same (file, symbol, summary), and two different --check values differ from each other', () => {
  const noCheck = findingId(ticket, 'docs/plans/x-proofs.md', 'CaptureIndex', 'summary')
  const checkA = findingId(
    ticket,
    'docs/plans/x-proofs.md',
    'CaptureIndex',
    'summary',
    '0123456789ab'
  )
  const checkB = findingId(
    ticket,
    'docs/plans/x-proofs.md',
    'CaptureIndex',
    'summary',
    'fedcba987654'
  )
  assert.notEqual(checkA, noCheck, 'a --check value must change the id from the no-check id')
  assert.notEqual(
    checkB,
    noCheck,
    'a different --check value must also change the id from the no-check id'
  )
  assert.notEqual(
    checkA,
    checkB,
    'two findings that differ only in --check must not collide on one id'
  )
})

test('a finding set to withdrawn reads back status withdrawn with its withdrawnReason', () => {
  const openOutput = captureStdout(() =>
    runOpenFinding(ticket, 'src/bar.ts', 'doOther', 'looks broken')
  )
  const { id } = JSON.parse(openOutput) as { id: string }

  captureStdout(() => runSetFindingStatus(ticket, id, 'withdrawn', 'not actually a defect'))

  const ledger = readLedger(ticket)
  const finding = ledger.findings.find((f) => f.id === id)
  assert.equal(finding!.status, 'withdrawn', 'status reads back withdrawn')
  assert.equal(finding!.withdrawnReason, 'not actually a defect', 'reason round-trips')
})

test('a finding set to fixed with --reason and no --fix-commit reads back its fixReason', () => {
  // The case this test pins: a finding fixed somewhere a commit sha can't name — a PR evidence
  // comment, a config change made outside this repo — where --reason is the only durable record.
  const openOutput = captureStdout(() =>
    runOpenFinding(ticket, 'src/fixedbyreason.ts', 'doFixed', 'a finding fixed without a commit')
  )
  const { id } = JSON.parse(openOutput) as { id: string }

  captureStdout(() =>
    runSetFindingStatus(ticket, id, 'fixed', 'fixed via the PR evidence comment, no code change')
  )

  const ledger = readLedger(ticket)
  const finding = ledger.findings.find((f) => f.id === id)
  assert.equal(finding!.status, 'fixed', 'status reads back fixed')
  assert.equal(
    finding!.fixReason,
    'fixed via the PR evidence comment, no code change',
    'the fix reason round-trips instead of being silently dropped'
  )
})

test('runOpenFinding on a withdrawn id sets exit code 4 and prints the reason', () => {
  const openOutput = captureStdout(() =>
    runOpenFinding(ticket, 'src/baz.ts', 'doThird', 'a defect summary')
  )
  const { id } = JSON.parse(openOutput) as { id: string }
  captureStdout(() => runSetFindingStatus(ticket, id, 'withdrawn', 'reviewed, not a bug'))
  resetExitCode()

  const reopenOutput = captureStdout(() =>
    runOpenFinding(ticket, 'src/baz.ts', 'doThird', 'a defect summary')
  )

  assert.equal(getRequestedExitCode(), 4, 'exit code 4 requested for a withdrawn re-raise')
  const parsed = JSON.parse(reopenOutput) as { reason: string }
  assert.equal(parsed.reason, 'reviewed, not a bug', 'the withdrawal reason is printed')
})

test('runOpenFinding on a withdrawn id with no reason on record (legacy data) omits the reason key rather than defaulting it to an empty string', () => {
  const openOutput = captureStdout(() =>
    runOpenFinding(ticket, 'src/legacywithdrawn2.ts', 'doLegacyOpen', 'a defect summary')
  )
  const { id } = JSON.parse(openOutput) as { id: string }
  // Same simulated-legacy-data technique as the resurrectedFromWithdrawn legacy test: the
  // current write path (runSetFindingStatus) refuses a reasonless withdrawal at exit 6, so this
  // state can only exist as data written before that validation existed.
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({
      kind: 'finding-status',
      at: new Date().toISOString(),
      id,
      round: 1,
      status: 'withdrawn',
    })
  )
  const precondition = readLedger(ticket).findings.find((f) => f.id === id)
  assert.equal(precondition!.status, 'withdrawn', 'precondition: the legacy withdrawal folds in')
  assert.equal(
    precondition!.withdrawnReason,
    undefined,
    'precondition: the legacy event carries no reason at all'
  )
  resetExitCode()

  const reopenOutput = captureStdout(() =>
    runOpenFinding(ticket, 'src/legacywithdrawn2.ts', 'doLegacyOpen', 'a defect summary')
  )

  assert.equal(getRequestedExitCode(), 4, 'exit code 4 requested for a withdrawn re-raise')
  const parsed = JSON.parse(reopenOutput) as { reason?: string }
  assert.equal(
    'reason' in parsed,
    false,
    "FLOW-245 finding b0f871598d7d: the CLI output must omit the key entirely, matching runSetFindingStatus's " +
      "resurrectedFromWithdrawn treatment, rather than defaulting it to ''"
  )
})

test('finding status withdrawn with no --reason sets exit code 6 and does not withdraw', () => {
  const openOutput = captureStdout(() =>
    runOpenFinding(ticket, 'src/quux.ts', 'doFourth', 'a fourth defect summary')
  )
  const { id } = JSON.parse(openOutput) as { id: string }

  captureStdout(() => runSetFindingStatus(ticket, id, 'withdrawn'))

  assert.equal(getRequestedExitCode(), 6, 'exit code 6 requested for a reasonless withdrawal')
  const ledger = readLedger(ticket)
  const finding = ledger.findings.find((f) => f.id === id)
  assert.equal(finding!.status, 'open', 'status is unchanged — the withdrawal was refused')
})

test('instruction dispose not-acted with no --reason sets exit code 6 and stays pending', () => {
  const recordOutput = captureStdout(() =>
    runRecordInstruction(ticket, 'an instruction to dispose without a reason')
  )
  const { id } = JSON.parse(recordOutput) as { id: string }

  captureStdout(() => runDisposeInstruction(ticket, id, 'not-acted'))

  assert.equal(getRequestedExitCode(), 6, 'exit code 6 requested for a reasonless disposition')
  const ledger = readLedger(ticket)
  const instruction = ledger.instructions.find((i) => i.id === id)
  assert.equal(
    instruction!.disposition,
    'pending',
    'disposition is unchanged — the call was refused'
  )
})

test('an instruction with no disposition event reads back disposition pending', () => {
  const output = captureStdout(() => runRecordInstruction(ticket, 'run the gates before reporting'))
  const { id } = JSON.parse(output) as { id: string }

  const ledger = readLedger(ticket)
  const instruction = ledger.instructions.find((i) => i.id === id)
  assert.equal(instruction!.disposition, 'pending', 'undisposed instruction defaults to pending')
})

test('an instruction disposed not-acted in round 1 still reads not-acted after next-round', () => {
  const recordOutput = captureStdout(() => runRecordInstruction(ticket, 'do the extra thing'))
  const { id } = JSON.parse(recordOutput) as { id: string }
  captureStdout(() => runDisposeInstruction(ticket, id, 'not-acted', 'out of scope for this task'))
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, 'sha-closing-round-1', 'adversarial'))

  const ledger = readLedger(ticket)
  const instruction = ledger.instructions.find((i) => i.id === id)
  assert.equal(ledger.round, 2, 'next-round advanced the round')
  assert.equal(instruction!.disposition, 'not-acted', 'disposition survives the round bump')
})

test('a corrupt line is counted in skippedLines and does not abort the fold', () => {
  captureStdout(() => runRecordInstruction(ticket, 'a valid instruction before the corruption'))
  appendLine(rawLedgerPath(ticket), 'not valid json{{{')
  captureStdout(() => runRecordInstruction(ticket, 'a valid instruction after the corruption'))

  const ledger = readLedger(ticket)
  assert.equal(ledger.skippedLines, 1, 'the corrupt line is counted')
  assert.equal(ledger.instructions.length, 2, 'both valid instructions survive the fold')
})

test('an event whose summary exceeds 4096 bytes is written truncated, and the written line respects the bound', () => {
  const hugeSummary = 'x'.repeat(5000)
  const output = captureStdout(() => runOpenFinding(ticket, 'src/huge.ts', 'doHuge', hugeSummary))
  const { id } = JSON.parse(output) as { id: string }

  const ledger = readLedger(ticket)
  const finding = ledger.findings.find((f) => f.id === id)
  assert.ok(finding, 'finding is present')
  assert.ok(finding!.summary.length < hugeSummary.length, 'summary was shortened')

  const lines = rawLedgerContent(ticket)
    .split('\n')
    .filter((l) => l.trim().length > 0)
  const lastLine = lines[lines.length - 1]
  assert.ok(
    Buffer.byteLength(lastLine, 'utf-8') <= 4096,
    'the written line respects the byte bound'
  )
  assert.equal(
    (JSON.parse(lastLine) as { truncated?: boolean }).truncated,
    true,
    'the event is flagged truncated'
  )
})

test('a pre-FLOW-337 finding-open line carrying outOfDiff still folds and shows it, even though nothing writes the field any more', () => {
  const id = findingId(
    ticket,
    'src/legacy-out-of-diff.ts',
    'doLegacy',
    'a pre-existing ledger line'
  )
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({
      kind: 'finding-open',
      at: new Date().toISOString(),
      id,
      round: 1,
      file: 'src/legacy-out-of-diff.ts',
      symbol: 'doLegacy',
      summary: 'a pre-existing ledger line',
      outOfDiff: 'written before FLOW-337, when --out-of-diff still existed',
    })
  )

  const ledger = readLedger(ticket)
  const finding = ledger.findings.find((f) => f.id === id)
  assert.equal(
    finding?.outOfDiff,
    'written before FLOW-337, when --out-of-diff still existed',
    'readLedger still folds a legacy outOfDiff field'
  )

  const showOutput = captureStdout(() => runShow(ticket))
  const shown = (JSON.parse(showOutput) as { findings: { id: string; outOfDiff?: string }[] })
    .findings
  const shownFinding = shown.find((f) => f.id === id)
  assert.equal(
    shownFinding?.outOfDiff,
    'written before FLOW-337, when --out-of-diff still existed',
    'show still renders the legacy field'
  )
})

test('show reports an instruction truncated when its huge dispatched text had to be shrunk to fit', () => {
  const hugeText = 'w'.repeat(5000)
  const output = captureStdout(() => runRecordInstruction(ticket, hugeText))
  const { id } = JSON.parse(output) as { id: string }

  const showOutput = captureStdout(() => runShow(ticket))
  const shown = (JSON.parse(showOutput) as { instructions: { id: string; truncated?: boolean }[] })
    .instructions
  const shownInstruction = shown.find((i) => i.id === id)
  assert.equal(shownInstruction?.truncated, true, 'show reports the instruction as truncated')
})

test('interleaved appends from two concurrent writers, held at a barrier so they actually overlap, both survive the fold', async () => {
  const textA = 'writer A instruction'
  const textB = 'writer B instruction'
  const readyA = join(tmpDir, 'ready-a')
  const readyB = join(tmpDir, 'ready-b')
  const barrier = join(tmpDir, 'barrier')

  const resultsPromise = Promise.all([
    runCliBarriered(
      ['review-ledger', 'instruction', 'record', '--ticket', ticket, '--text', textA],
      readyA,
      barrier
    ),
    runCliBarriered(
      ['review-ledger', 'instruction', 'record', '--ticket', ticket, '--text', textB],
      readyB,
      barrier
    ),
  ])

  // Neither child does its real work until both have signaled ready and this barrier file exists —
  // release them together so the two appendFileSync calls are forced to actually contend, rather
  // than "running concurrently" in a way OS scheduling jitter could still fully serialize.
  await waitUntil(() => existsSync(readyA) && existsSync(readyB))
  writeFileSync(barrier, '')

  const [resultA, resultB] = await resultsPromise
  assert.equal(resultA.exitCode, 0, 'writer A process exits 0')
  assert.equal(resultB.exitCode, 0, 'writer B process exits 0')

  const ledger = readLedger(ticket)
  const texts = ledger.instructions.map((i) => i.text)
  assert.ok(texts.includes(textA), 'writer A survives the race')
  assert.ok(texts.includes(textB), 'writer B survives the race')
})

test('readLedger on a ticket with no file returns round 1 and empty arrays, not a throw', () => {
  const freshTicket = `${ticket}-fresh`
  assert.doesNotThrow(() => readLedger(freshTicket))

  const ledger = readLedger(freshTicket)
  assert.equal(ledger.round, 1, 'default round is 1')
  assert.deepEqual(ledger.findings, [], 'no findings')
  assert.deepEqual(ledger.instructions, [], 'no instructions')
})

test('re-raising a finding already fixed reopens it and sets exit code 7, instead of the raise being silently discarded', () => {
  const openOutput = captureStdout(() =>
    runOpenFinding(ticket, 'src/reopen.ts', 'doReopen', 'a finding that will be marked fixed')
  )
  const { id } = JSON.parse(openOutput) as { id: string }
  const repo = makeRepo()
  const sha = headSha(repo)
  captureStdout(() => runSetFindingStatus(ticket, id, 'fixed', undefined, sha, repo))
  const precondition = readLedger(ticket).findings.find((f) => f.id === id)
  assert.equal(
    precondition!.fixCommit,
    sha,
    'precondition: fixCommit is actually populated by the fixed step, before the reopen clears it'
  )
  resetExitCode()

  const reopenOutput = captureStdout(() =>
    runOpenFinding(ticket, 'src/reopen.ts', 'doReopen', 'a finding that will be marked fixed')
  )

  assert.equal(getRequestedExitCode(), 7, 'exit code 7 requested for a re-raise of a fixed finding')
  const parsed = JSON.parse(reopenOutput) as { id: string; reopened?: boolean }
  assert.equal(parsed.reopened, true, 'the output flags this as a reopen')

  const ledger = readLedger(ticket)
  const finding = ledger.findings.find((f) => f.id === id)
  assert.equal(finding!.status, 'open', 'the finding is genuinely reopened, not stuck at fixed')
  assert.equal(finding!.fixCommit, undefined, 'the stale fixCommit from the old fix is dropped')
})

test('re-recording an instruction already disposed re-arms it to pending and sets exit code 7', () => {
  const recordOutput = captureStdout(() =>
    runRecordInstruction(ticket, 'an instruction that will be disposed not-acted')
  )
  const { id } = JSON.parse(recordOutput) as { id: string }
  captureStdout(() => runDisposeInstruction(ticket, id, 'not-acted', 'deferred to a later round'))
  resetExitCode()

  const reRecordOutput = captureStdout(() =>
    runRecordInstruction(ticket, 'an instruction that will be disposed not-acted')
  )

  assert.equal(
    getRequestedExitCode(),
    7,
    'exit code 7 requested for a re-record of a disposed instruction'
  )
  const parsed = JSON.parse(reRecordOutput) as { id: string; reopened?: boolean }
  assert.equal(parsed.reopened, true, 'the output flags this as a reopen')

  const ledger = readLedger(ticket)
  const instruction = ledger.instructions.find((i) => i.id === id)
  assert.equal(
    instruction!.disposition,
    'pending',
    're-recording resets the disposition to pending rather than keeping the stale one'
  )
})

test('a finding withdrawn and later marked fixed no longer carries the old withdrawnReason, but the fold still shows the withdrawal happened', () => {
  const openOutput = captureStdout(() =>
    runOpenFinding(
      ticket,
      'src/stalereason.ts',
      'doStale',
      'a finding that will be withdrawn then fixed'
    )
  )
  const { id } = JSON.parse(openOutput) as { id: string }
  captureStdout(() => runSetFindingStatus(ticket, id, 'withdrawn', 'thought it was not a bug'))
  // A withdrawn finding refuses re-open through runOpenFinding (exit 4), so drive the ledger back
  // to fixed the way a senior actually would: directly through finding status, same as any other
  // status transition.
  const staleReasonRepo = makeRepo()
  const fixedOutput = captureStdout(() =>
    runSetFindingStatus(ticket, id, 'fixed', undefined, headSha(staleReasonRepo), staleReasonRepo)
  )

  const ledger = readLedger(ticket)
  const finding = ledger.findings.find((f) => f.id === id)
  assert.equal(finding!.status, 'fixed', 'status reads back fixed')
  assert.equal(
    finding!.withdrawnReason,
    undefined,
    'the stale withdrawal reason does not survive the transition to fixed'
  )
  assert.equal(
    finding!.resurrectedFromWithdrawn,
    'thought it was not a bug',
    'the fold retains the prior withdrawal reason under its own field — FLOW-245 finding a5855c998fb6: this used to ' +
      'be silently indistinguishable from a finding that was never withdrawn at all'
  )
  const { resurrectedFromWithdrawn } = JSON.parse(fixedOutput) as {
    resurrectedFromWithdrawn?: string
  }
  assert.equal(
    resurrectedFromWithdrawn,
    'thought it was not a bug',
    'the CLI call that performs the resurrection surfaces it immediately, not only on a later show'
  )
})

test('a finding withdrawn, fixed, then withdrawn again does not carry a stale resurrectedFromWithdrawn', () => {
  const openOutput = captureStdout(() =>
    runOpenFinding(
      ticket,
      'src/stalereason2.ts',
      'doStale2',
      'a finding withdrawn, fixed, then withdrawn again'
    )
  )
  const { id } = JSON.parse(openOutput) as { id: string }
  captureStdout(() => runSetFindingStatus(ticket, id, 'withdrawn', 'first withdrawal'))
  const stale2Repo = makeRepo()
  captureStdout(() =>
    runSetFindingStatus(ticket, id, 'fixed', undefined, headSha(stale2Repo), stale2Repo)
  )
  const precondition = readLedger(ticket).findings.find((f) => f.id === id)
  assert.equal(
    precondition!.resurrectedFromWithdrawn,
    'first withdrawal',
    'precondition: resurrectedFromWithdrawn is actually populated by the fixed step, before the ' +
      'second withdrawal clears it'
  )
  captureStdout(() => runSetFindingStatus(ticket, id, 'withdrawn', 'actually not a bug after all'))

  const finding = readLedger(ticket).findings.find((f) => f.id === id)
  assert.equal(finding!.status, 'withdrawn', 'status reads back withdrawn')
  assert.equal(finding!.withdrawnReason, 'actually not a bug after all', 'the fresh reason wins')
  assert.equal(
    finding!.resurrectedFromWithdrawn,
    undefined,
    'resurrectedFromWithdrawn describes one specific past transition, not a standing flag that ' +
      'survives a later, unrelated status change'
  )
})

test('a finding fixed via a normal, never-withdrawn history reads no resurrectedFromWithdrawn', () => {
  const openOutput = captureStdout(() =>
    runOpenFinding(ticket, 'src/normalfix.ts', 'doNormal', 'a finding fixed the ordinary way')
  )
  const { id } = JSON.parse(openOutput) as { id: string }
  const normalFixRepo = makeRepo()
  const fixedOutput = captureStdout(() =>
    runSetFindingStatus(ticket, id, 'fixed', undefined, headSha(normalFixRepo), normalFixRepo)
  )

  const finding = readLedger(ticket).findings.find((f) => f.id === id)
  assert.equal(finding!.status, 'fixed', 'status reads back fixed')
  assert.equal(
    finding!.resurrectedFromWithdrawn,
    undefined,
    'a finding that was never withdrawn must not be reported as resurrected'
  )
  const parsedFixedOutput = JSON.parse(fixedOutput) as { resurrectedFromWithdrawn?: string }
  assert.equal(
    parsedFixedOutput.resurrectedFromWithdrawn,
    undefined,
    'the ordinary fixed-disposal CLI output carries no resurrection field at all'
  )
})

test('a finding withdrawn with no reason on record (legacy data), then fixed, omits resurrectedFromWithdrawn rather than defaulting it to an empty string', () => {
  const openOutput = captureStdout(() =>
    runOpenFinding(
      ticket,
      'src/legacywithdrawn.ts',
      'doLegacy',
      'a finding withdrawn before --reason was required'
    )
  )
  const { id } = JSON.parse(openOutput) as { id: string }
  // The current write path (runSetFindingStatus) refuses a reasonless withdrawal at exit 6, so a
  // withdrawnReason-less withdrawal can only exist as legacy data written before that validation
  // existed — simulated here the same way the invalid-origin test above simulates a pre-validation
  // event, by appending the raw line directly rather than going through the CLI.
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({
      kind: 'finding-status',
      at: new Date().toISOString(),
      id,
      round: 1,
      status: 'withdrawn',
    })
  )
  const precondition = readLedger(ticket).findings.find((f) => f.id === id)
  assert.equal(precondition!.status, 'withdrawn', 'precondition: the legacy withdrawal folds in')
  assert.equal(
    precondition!.withdrawnReason,
    undefined,
    'precondition: the legacy event carries no reason at all'
  )

  const legacyWithdrawnRepo = makeRepo()
  const fixedOutput = captureStdout(() =>
    runSetFindingStatus(
      ticket,
      id,
      'fixed',
      undefined,
      headSha(legacyWithdrawnRepo),
      legacyWithdrawnRepo
    )
  )

  const finding = readLedger(ticket).findings.find((f) => f.id === id)
  assert.equal(finding!.status, 'fixed', 'status reads back fixed')
  assert.equal(
    finding!.resurrectedFromWithdrawn,
    undefined,
    'the fold has nothing to carry forward when the withdrawal itself carried no reason'
  )
  const parsedFixedOutput = JSON.parse(fixedOutput) as { resurrectedFromWithdrawn?: string }
  assert.equal(
    'resurrectedFromWithdrawn' in parsedFixedOutput,
    false,
    'FLOW-245 finding 096ae8be1095: the CLI output must omit the key entirely, matching the fold, rather than ' +
      "defaulting it to '' and disagreeing with a fold that has no such key at all"
  )
})

test('a finding fixed and later withdrawn no longer carries the old fixCommit', () => {
  const openOutput = captureStdout(() =>
    runOpenFinding(
      ticket,
      'src/stalefixcommit.ts',
      'doStaleFixCommit',
      'a finding that will be fixed then withdrawn'
    )
  )
  const { id } = JSON.parse(openOutput) as { id: string }
  const staleFixCommitRepo = makeRepo()
  const staleFixCommitSha = headSha(staleFixCommitRepo)
  captureStdout(() =>
    runSetFindingStatus(ticket, id, 'fixed', undefined, staleFixCommitSha, staleFixCommitRepo)
  )
  const precondition = readLedger(ticket).findings.find((f) => f.id === id)
  assert.equal(
    precondition!.fixCommit,
    staleFixCommitSha,
    'precondition: fixCommit is actually populated by the fixed step, before the withdrawal clears it'
  )
  captureStdout(() => runSetFindingStatus(ticket, id, 'withdrawn', 'turns out not a bug'))

  const ledger = readLedger(ticket)
  const finding = ledger.findings.find((f) => f.id === id)
  assert.equal(finding!.status, 'withdrawn', 'status reads back withdrawn')
  assert.equal(
    finding!.fixCommit,
    undefined,
    'the stale fixCommit from the old fix episode does not survive the transition to withdrawn'
  )
})

test('a finding fixed by reason and later withdrawn no longer carries the old fixReason', () => {
  const openOutput = captureStdout(() =>
    runOpenFinding(
      ticket,
      'src/stalefixreason.ts',
      'doStaleFixReason',
      'a finding fixed by reason, then withdrawn'
    )
  )
  const { id } = JSON.parse(openOutput) as { id: string }
  captureStdout(() => runSetFindingStatus(ticket, id, 'fixed', 'fixed via the PR thread'))
  const fixedLedger = readLedger(ticket)
  assert.equal(
    fixedLedger.findings.find((f) => f.id === id)!.fixReason,
    'fixed via the PR thread',
    'precondition: fixReason is actually populated by the fixed step, before it is cleared'
  )
  captureStdout(() => runSetFindingStatus(ticket, id, 'withdrawn', 'turns out not a bug'))

  const ledger = readLedger(ticket)
  const finding = ledger.findings.find((f) => f.id === id)
  assert.equal(finding!.status, 'withdrawn', 'status reads back withdrawn')
  assert.equal(
    finding!.fixReason,
    undefined,
    'the stale fixReason from the old fix episode does not survive the transition to withdrawn'
  )
})

test('a finding fixed by reason and later re-raised no longer carries the old fixReason', () => {
  const openOutput = captureStdout(() =>
    runOpenFinding(
      ticket,
      'src/reraisedfixreason.ts',
      'doReraised',
      'a finding fixed by reason, then re-raised'
    )
  )
  const { id } = JSON.parse(openOutput) as { id: string }
  captureStdout(() => runSetFindingStatus(ticket, id, 'fixed', 'fixed via the PR thread'))
  const fixedLedger = readLedger(ticket)
  assert.equal(
    fixedLedger.findings.find((f) => f.id === id)!.fixReason,
    'fixed via the PR thread',
    'precondition: fixReason is actually populated by the fixed step, before the re-raise clears it'
  )
  resetExitCode()
  captureStdout(() =>
    runOpenFinding(
      ticket,
      'src/reraisedfixreason.ts',
      'doReraised',
      'a finding fixed by reason, then re-raised'
    )
  )

  assert.equal(getRequestedExitCode(), 7, 'exit code 7 requested for a fixed re-raise')
  const ledger = readLedger(ticket)
  const finding = ledger.findings.find((f) => f.id === id)
  assert.equal(finding!.status, 'open', 'status reads back open')
  assert.equal(
    finding!.fixReason,
    undefined,
    'the stale fixReason from the discharged episode does not survive the re-raise'
  )
})

test('an instruction disposed not-acted then re-disposed acted no longer carries the old reason, but the fold still shows the not-acted disposition happened', () => {
  const recordOutput = captureStdout(() =>
    runRecordInstruction(ticket, 'an instruction disposed twice with different dispositions')
  )
  const { id } = JSON.parse(recordOutput) as { id: string }
  captureStdout(() => runDisposeInstruction(ticket, id, 'not-acted', 'blocked on X'))
  const actedOutput = captureStdout(() => runDisposeInstruction(ticket, id, 'acted'))

  const ledger = readLedger(ticket)
  const instruction = ledger.instructions.find((i) => i.id === id)
  assert.equal(instruction!.disposition, 'acted', 'disposition reads back acted')
  assert.equal(
    instruction!.reason,
    undefined,
    'the stale reason from the earlier not-acted disposition does not survive onto acted'
  )
  assert.equal(
    instruction!.supersededReason,
    'blocked on X',
    'FLOW-245 finding dce44c5c5d84: this used to be silently indistinguishable from an instruction that was never ' +
      'disposed not-acted at all'
  )
  const { supersededReason } = JSON.parse(actedOutput) as { supersededReason?: string }
  assert.equal(
    supersededReason,
    'blocked on X',
    'FLOW-245 finding eca17153e127: the CLI call that drops the reason surfaces its supersession immediately, not ' +
      'only on a later show — the same call-time treatment runSetFindingStatus already gives ' +
      'resurrectedFromWithdrawn'
  )
})

test('an instruction disposed not-acted, re-disposed acted, then disposed not-applicable does not carry a stale supersededReason', () => {
  const recordOutput = captureStdout(() =>
    runRecordInstruction(ticket, 'an instruction disposed three times')
  )
  const { id } = JSON.parse(recordOutput) as { id: string }
  captureStdout(() => runDisposeInstruction(ticket, id, 'not-acted', 'first reason'))
  captureStdout(() => runDisposeInstruction(ticket, id, 'acted'))
  const precondition = readLedger(ticket).instructions.find((i) => i.id === id)
  assert.equal(
    precondition!.supersededReason,
    'first reason',
    'precondition: supersededReason is actually populated by the acted step, before the ' +
      'not-applicable disposition (with its own reason) clears it'
  )
  captureStdout(() => runDisposeInstruction(ticket, id, 'not-applicable', 'second reason'))

  const instruction = readLedger(ticket).instructions.find((i) => i.id === id)
  assert.equal(instruction!.disposition, 'not-applicable', 'disposition reads back not-applicable')
  assert.equal(instruction!.reason, 'second reason', 'the fresh reason wins')
  assert.equal(
    instruction!.supersededReason,
    undefined,
    'supersededReason describes one specific past transition, not a standing flag that survives ' +
      'a later disposition that supplies its own reason'
  )
})

test('an instruction disposed via a normal, reason-then-reason history reads no supersededReason', () => {
  const recordOutput = captureStdout(() =>
    runRecordInstruction(ticket, 'an instruction disposed once, normally')
  )
  const { id } = JSON.parse(recordOutput) as { id: string }
  const disposeOutput = captureStdout(() =>
    runDisposeInstruction(ticket, id, 'not-applicable', 'never applied here')
  )

  const instruction = readLedger(ticket).instructions.find((i) => i.id === id)
  assert.equal(
    instruction!.supersededReason,
    undefined,
    'an instruction disposed only once must not be reported as superseding anything'
  )
  const parsedDisposeOutput = JSON.parse(disposeOutput) as { supersededReason?: string }
  assert.equal(
    'supersededReason' in parsedDisposeOutput,
    false,
    'the ordinary disposition CLI output carries no supersession field at all'
  )
})

test('re-recording an instruction with a supersededReason re-arms it without carrying the stale supersededReason forward', () => {
  const recordOutput = captureStdout(() =>
    runRecordInstruction(ticket, 'an instruction disposed, re-disposed, then re-recorded')
  )
  const { id } = JSON.parse(recordOutput) as { id: string }
  captureStdout(() => runDisposeInstruction(ticket, id, 'not-acted', 'blocked on Y'))
  captureStdout(() => runDisposeInstruction(ticket, id, 'acted'))
  const precondition = readLedger(ticket).instructions.find((i) => i.id === id)
  assert.equal(
    precondition!.supersededReason,
    'blocked on Y',
    'precondition: supersededReason is actually populated by the acted step, before the ' +
      're-record re-arms it to a clean pending state'
  )
  resetExitCode()
  captureStdout(() =>
    runRecordInstruction(ticket, 'an instruction disposed, re-disposed, then re-recorded')
  )

  const instruction = readLedger(ticket).instructions.find((i) => i.id === id)
  assert.equal(instruction!.disposition, 'pending', 'disposition reads back pending')
  assert.equal(
    instruction!.supersededReason,
    undefined,
    'a re-recorded instruction re-arms to a clean pending state, not one still carrying a prior ' +
      "episode's supersededReason"
  )
})

test('runSetFindingStatus on an unknown id sets exit code 5 and writes no event', () => {
  captureStdout(() => runSetFindingStatus(ticket, 'no-such-finding-id', 'fixed'))
  assert.equal(getRequestedExitCode(), 5, 'exit code 5 requested for an unknown finding id')
  assert.equal(rawLedgerContent(ticket), '', 'no event was appended for the unknown id')
})

test('runDisposeInstruction on an unknown id sets exit code 5 and writes no event', () => {
  captureStdout(() => runDisposeInstruction(ticket, 'no-such-instruction-id', 'acted'))
  assert.equal(getRequestedExitCode(), 5, 'exit code 5 requested for an unknown instruction id')
  assert.equal(rawLedgerContent(ticket), '', 'no event was appended for the unknown id')
})

test('runAssignFinding sets an owner readable from readLedger, and exits 5 on an unknown id', () => {
  const openOutput = captureStdout(() =>
    runOpenFinding(ticket, 'src/owned.ts', 'doOwned', 'a finding that will be assigned')
  )
  const { id } = JSON.parse(openOutput) as { id: string }

  captureStdout(() => runAssignFinding(ticket, id, 'impl-ledger'))
  const ledger = readLedger(ticket)
  const finding = ledger.findings.find((f) => f.id === id)
  assert.equal(finding!.owner, 'impl-ledger', 'the owner set at dispatch is readable from show')

  resetExitCode()
  captureStdout(() => runAssignFinding(ticket, 'no-such-finding-id', 'impl-review'))
  assert.equal(getRequestedExitCode(), 5, 'exit code 5 requested for an unknown finding id')
})

test('runNextRound --reviewed-sha stamps each round being closed with its own sha, keyed by the round it closed', () => {
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, 'sha-that-closed-round-1', 'adversarial'))
  markRoundReviewed()
  captureStdout(() =>
    runNextRound(ticket, 'sha-that-closed-round-2', 'adversarial', 'fixture sha, not a real commit')
  )

  const ledger = readLedger(ticket)
  assert.equal(ledger.round, 3, 'two next-round calls advanced to round 3')
  assert.equal(
    ledger.reviewedShas['1'],
    'sha-that-closed-round-1',
    'round 1 is keyed to the sha that closed it, not the round that followed'
  )
  assert.equal(
    ledger.reviewedShas['2'],
    'sha-that-closed-round-2',
    'round 2 is keyed to its own closing sha, independent of round 1'
  )
})

test('runNextRound --stance is recorded per round, and resolvedAnchor tracks only the latest adversarial round', () => {
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, 'sha-round-1-adversarial', 'adversarial'))
  markRoundReviewed()
  captureStdout(() =>
    runNextRound(ticket, 'sha-round-2-cleanup', 'cleanup', 'fixture sha, not a real commit')
  )

  let ledger = readLedger(ticket)
  assert.equal(ledger.reviewedStances['1'], 'adversarial', 'round 1 recorded as adversarial')
  assert.equal(ledger.reviewedStances['2'], 'cleanup', 'round 2 recorded as cleanup')
  assert.deepEqual(
    ledger.resolvedAnchor,
    { round: 1, reviewedSha: 'sha-round-1-adversarial' },
    'a cleanup round does not move the anchor — it stays on the last adversarial round'
  )

  markRoundReviewed()
  captureStdout(() =>
    runNextRound(ticket, 'sha-round-3-adversarial', 'adversarial', 'fixture sha, not a real commit')
  )

  ledger = readLedger(ticket)
  assert.deepEqual(
    ledger.resolvedAnchor,
    { round: 3, reviewedSha: 'sha-round-3-adversarial' },
    'a later adversarial round moves the anchor forward'
  )
})

test('a round-reviewed event with no stance field (pre-migration data) backfills to adversarial rather than being dropped as corrupt', () => {
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({
      kind: 'round-reviewed',
      at: new Date().toISOString(),
      round: 1,
      reviewedSha: 'sha-from-before-stance-existed',
    })
  )

  const ledger = readLedger(ticket)
  assert.equal(ledger.skippedLines, 0, 'the legacy line is not counted as corrupt')
  assert.equal(
    ledger.reviewedShas['1'],
    'sha-from-before-stance-existed',
    'the reviewedSha it carries is preserved'
  )
  assert.equal(
    ledger.reviewedStances['1'],
    'adversarial',
    'a missing stance backfills to adversarial, not a silently dropped or undefined value'
  )
  assert.deepEqual(
    ledger.resolvedAnchor,
    { round: 1, reviewedSha: 'sha-from-before-stance-existed' },
    'the backfilled round counts as the anchor, same as an explicitly-stamped adversarial round'
  )
})

test('a round-reviewed event with an invalid stance value is rejected as corrupt, not coerced to adversarial', () => {
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({
      kind: 'round-reviewed',
      at: new Date().toISOString(),
      round: 1,
      reviewedSha: 'sha-with-a-mistyped-stance',
      stance: 'banana',
    })
  )

  const ledger = readLedger(ticket)
  assert.equal(
    ledger.skippedLines,
    1,
    'a present-but-invalid stance is rejected like any other malformed event'
  )
  assert.equal(
    ledger.reviewedShas['1'],
    undefined,
    'the rejected line does not partially fold in — its reviewedSha is not recorded'
  )
  assert.equal(
    ledger.resolvedAnchor,
    null,
    'a rejected line never becomes the anchor, unlike a silently-coerced adversarial would'
  )
})

test('a later re-recording of an already-closed round updates its reviewed sha but does not un-freeze its stance', () => {
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, 'sha-round-1-adversarial', 'adversarial'))

  // A correction to round 1, recorded directly rather than through a closing command: both of them
  // only ever close the CURRENT round, and refuse at exit 19 on one already closed, so neither can
  // re-emit round-reviewed for a round that has already closed — only a raw append can simulate
  // that, the same way the
  // pre-migration and invalid-stance cases above do.
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({
      kind: 'round-reviewed',
      at: new Date().toISOString(),
      round: 1,
      reviewedSha: 'sha-round-1-corrected',
      stance: 'cleanup',
    })
  )

  const ledger = readLedger(ticket)
  assert.equal(
    ledger.reviewedStances['1'],
    'adversarial',
    'the stance is frozen at its first record — a later re-record cannot un-review round 1 under a ' +
      'different stance'
  )
  assert.equal(
    ledger.reviewedShas['1'],
    'sha-round-1-corrected',
    'the sha is still correctable — reviewedShas stays last-write-wins'
  )
  assert.deepEqual(
    ledger.resolvedAnchor,
    { round: 1, reviewedSha: 'sha-round-1-corrected' },
    'resolvedAnchor pairs the frozen adversarial stance with the corrected sha, agreeing with both maps'
  )
})

test('next-round refuses a declared adversarial stance when the computation says cleanup', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, anchorSha, 'adversarial'))

  // Pinning the anchor sha itself is a self-check over an empty range: no clause can fire, so
  // computeStance reports 'cleanup' — see stance.test.ts's own "returns cleanup when no clause
  // fires". Declaring 'adversarial' against that contradicts it. The sha-reuse licence is what lets
  // the call reach the stance check at all; see stanceFixtureShaReuse.
  markRoundReviewed()
  const output = captureStdout(() =>
    runNextRound(
      ticket,
      anchorSha,
      'adversarial',
      undefined,
      repo,
      undefined,
      undefined,
      stanceFixtureShaReuse
    )
  )
  const result = JSON.parse(output) as { declaredStance: string; computedStance: string }
  assert.equal(getRequestedExitCode(), 6, 'an unlicensed contradiction refuses')
  assert.equal(result.declaredStance, 'adversarial')
  assert.equal(result.computedStance, 'cleanup')
  assert.equal(readLedger(ticket).round, 2, 'the round did not advance')
})

test('next-round with a scope-change records the override and the computed stance on the ledger', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, anchorSha, 'adversarial'))

  markRoundReviewed()
  captureStdout(() =>
    runNextRound(
      ticket,
      anchorSha,
      'adversarial',
      undefined,
      repo,
      undefined,
      undefined,
      stanceFixtureShaReuse,
      'added new auth module'
    )
  )

  const ledger = readLedger(ticket)
  assert.equal(ledger.round, 3, 'the licensed override still advances the round')
  assert.equal(
    ledger.reviewedStances['2'],
    'adversarial',
    'the declared stance is what is recorded'
  )
  assert.equal(ledger.computedStances['2'], 'cleanup')
  assert.equal(ledger.scopeChanges['2'], 'added new auth module')
})

test('next-round records the computed stance even when nothing was overridden', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, anchorSha, 'adversarial'))

  // Declaring 'cleanup' against a computed 'cleanup' (the anchor-sha self-check) contradicts nothing.
  markRoundReviewed()
  captureStdout(() =>
    runNextRound(
      ticket,
      anchorSha,
      'cleanup',
      undefined,
      repo,
      undefined,
      undefined,
      stanceFixtureShaReuse
    )
  )

  const ledger = readLedger(ticket)
  assert.equal(ledger.computedStances['2'], 'cleanup')
})

test('next-round appends nothing when it refuses', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, anchorSha, 'adversarial'))

  markRoundReviewed()
  captureStdout(() =>
    runNextRound(
      ticket,
      anchorSha,
      'adversarial',
      undefined,
      repo,
      undefined,
      undefined,
      stanceFixtureShaReuse
    )
  )

  assert.equal(getRequestedExitCode(), 6)
  assert.equal(readLedger(ticket).round, 2, 'the round did not advance')
  assert.equal(
    existsSync(roundClaimPath(ticket, 2)),
    false,
    'a refusal never claims the round it declined to close — a caller that goes on to license the ' +
      'same round with --reason must not find it already claimed'
  )
})

test('next-round does not check the stance on round 1', () => {
  // No repo, no real commit — round 1 must not reach checkDeclaredStance's git path at all.
  markRoundReviewed()
  const output = captureStdout(() =>
    runNextRound(ticket, 'sha-nobody-will-ever-resolve', 'adversarial')
  )
  const result = JSON.parse(output) as { round: number; computedStance?: string }
  assert.equal(getRequestedExitCode(), 0)
  assert.equal(result.round, 2, 'round 1 closed and advanced despite an unresolvable sha')
  assert.equal(
    result.computedStance,
    undefined,
    'the predicate did not run, so nothing is reported'
  )
  const ledger = readLedger(ticket)
  assert.equal(
    ledger.computedStances['1'],
    undefined,
    'a computed stance nobody computed must not read as one that was'
  )
})

test('next-round refuses at round 2 when the anchor is null', () => {
  // Round 1 stamped cleanup: resolvedAnchor stays null per its own freeze rule — no round has ever
  // closed adversarial. From round 2 on that null anchor is itself the contradiction to refuse on.
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, 'sha-closing-round-1', 'cleanup'))
  assert.equal(readLedger(ticket).resolvedAnchor, null)

  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, 'sha-closing-round-2', 'adversarial'))

  assert.equal(getRequestedExitCode(), 6)
  assert.equal(readLedger(ticket).round, 2, 'the round did not advance')
})

test('a licensed null-anchor escalation records stanceReason but no computedStance', () => {
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, 'sha-closing-round-1', 'cleanup'))
  assert.equal(readLedger(ticket).resolvedAnchor, null)

  markRoundReviewed()
  captureStdout(() =>
    runNextRound(
      ticket,
      'sha-closing-round-2',
      'adversarial',
      'round 1 was mis-stamped; escalating manually'
    )
  )

  assert.equal(getRequestedExitCode(), 0, 'the reason licenses the escalation and the round closes')
  const ledger = readLedger(ticket)
  assert.equal(ledger.round, 3)
  assert.equal(ledger.stanceReasons['2'], 'round 1 was mis-stamped; escalating manually')
  assert.equal(
    ledger.computedStances['2'],
    undefined,
    'the null-anchor escalation carries no computed value, unlike a licensed declared-vs-computed ' +
      'contradiction, which always does — that difference is what makes the two distinguishable on ' +
      'the ledger'
  )
})

test('next-round refuses a declared stance when a prior round record is missing, not silently accepted', () => {
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/anchor.ts', 'a\n', 'round 1 anchor commit')
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, round1Sha, 'adversarial'))

  // Round 2 closes with only a 'round' event and no 'round-reviewed' event at all — the same
  // missing-record shape stance.test.ts's own "refuses a missing previousRoundSha even when the
  // ledger parses cleanly" constructs, reached here through next-round instead of computeStance
  // directly.
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({ kind: 'round', at: new Date().toISOString(), round: 3 })
  )
  const round3Sha = commitFile(repo, 'src/round3.ts', 'c\n', 'round 3 commit')

  markRoundReviewed()
  const output = captureStdout(() => runNextRound(ticket, round3Sha, 'cleanup', undefined, repo))
  const result = JSON.parse(output) as { computedStance?: string }

  assert.equal(
    getRequestedExitCode(),
    6,
    'a missing round record is a stop-and-escalate, not a checker-could-not-run pass-through'
  )
  assert.equal(readLedger(ticket).round, 3, 'the round did not advance')
  assert.equal(result.computedStance, undefined)
})

test('a licensed missing-round-record escalation records stanceReason but no computedStance', () => {
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/anchor.ts', 'a\n', 'round 1 anchor commit')
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, round1Sha, 'adversarial'))
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({ kind: 'round', at: new Date().toISOString(), round: 3 })
  )
  const round3Sha = commitFile(repo, 'src/round3.ts', 'c\n', 'round 3 commit')

  markRoundReviewed()
  captureStdout(() =>
    runNextRound(
      ticket,
      round3Sha,
      'cleanup',
      "round 2's record is missing; escalating manually",
      repo
    )
  )

  assert.equal(getRequestedExitCode(), 0, 'the reason licenses the escalation and the round closes')
  const ledger = readLedger(ticket)
  assert.equal(ledger.round, 4)
  assert.equal(ledger.stanceReasons['3'], "round 2's record is missing; escalating manually")
  assert.equal(
    ledger.computedStances['3'],
    undefined,
    'the missing-round-record escalation carries no computed value, unlike a licensed ' +
      'declared-vs-computed contradiction, which always does'
  )
})

test("next-round refuses a declared stance when the anchor round's reviewed sha no longer resolves, not silently accepted", () => {
  const repo = makeRepo()
  // Round 1 closes adversarial with a well-formed but nonexistent reviewedSha — the shape a
  // rewritten branch history (a squash-rebase, origin/main moving on) leaves behind on the ledger.
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({
      kind: 'round-reviewed',
      at: new Date().toISOString(),
      round: 1,
      reviewedSha: '0000000000000000000000000000000000dead',
      stance: 'adversarial',
    })
  )
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({ kind: 'round', at: new Date().toISOString(), round: 2 })
  )
  const round2Sha = commitFile(repo, 'src/round2.ts', 'b\n', 'round 2 commit')

  markRoundReviewed()
  const output = captureStdout(() => runNextRound(ticket, round2Sha, 'cleanup', undefined, repo))
  const result = JSON.parse(output) as { computedStance?: string }

  assert.equal(
    getRequestedExitCode(),
    6,
    'a stale recorded anchor sha is a stop-and-escalate, not a checker-could-not-run pass-through'
  )
  assert.equal(readLedger(ticket).round, 2, 'the round did not advance')
  assert.equal(result.computedStance, undefined)
})

test('a licensed stale-recorded-sha escalation records stanceReason but no computedStance', () => {
  const repo = makeRepo()
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({
      kind: 'round-reviewed',
      at: new Date().toISOString(),
      round: 1,
      reviewedSha: '0000000000000000000000000000000000dead',
      stance: 'adversarial',
    })
  )
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({ kind: 'round', at: new Date().toISOString(), round: 2 })
  )
  const round2Sha = commitFile(repo, 'src/round2.ts', 'b\n', 'round 2 commit')

  markRoundReviewed()
  captureStdout(() =>
    runNextRound(
      ticket,
      round2Sha,
      'cleanup',
      'round 1 reviewed sha was rewritten off the branch; escalating manually',
      repo
    )
  )

  assert.equal(getRequestedExitCode(), 0, 'the reason licenses the escalation and the round closes')
  const ledger = readLedger(ticket)
  assert.equal(ledger.round, 3)
  assert.equal(
    ledger.stanceReasons['2'],
    'round 1 reviewed sha was rewritten off the branch; escalating manually'
  )
  assert.equal(
    ledger.computedStances['2'],
    undefined,
    'the stale-recorded-sha escalation carries no computed value, unlike a licensed ' +
      'declared-vs-computed contradiction, which always does'
  )
})

test('next-round refuses when the repo root cannot be resolved — the null-computed hole is closed', () => {
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, 'sha-closing-round-1', 'adversarial'))

  markRoundReviewed()
  const output = captureStdout(() =>
    runNextRound(ticket, 'sha-closing-round-2', 'adversarial', undefined, tmpDir)
  )

  const result = JSON.parse(output) as { error: string }
  assert.equal(
    getRequestedExitCode(),
    6,
    'an unresolvable repo root now refuses the close — the null-computed hole is closed'
  )
  assert.ok(
    result.error.includes('could not resolve repo root'),
    'the refusal names the repo root resolution failure'
  )
  assert.equal(readLedger(ticket).round, 2, 'the round did not advance')
})

test('next-round accepts an undetermined computation without a reason', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(
    repo,
    'tools/cli/src/target.ts',
    'v1\n',
    'anchor commit touching target'
  )
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, anchorSha, 'adversarial'))
  const pinnedSha = commitFile(
    repo,
    'tools/cli/src/target.ts',
    'v2\n',
    'modify target, undischarged'
  )

  markRoundReviewed()
  const output = captureStdout(() =>
    runNextRound(ticket, pinnedSha, 'adversarial', undefined, repo)
  )
  const result = JSON.parse(output) as { round: number }

  assert.equal(getRequestedExitCode(), 0, 'an undetermined computation contradicts nothing')
  assert.equal(result.round, 3)
  const ledger = readLedger(ticket)
  assert.equal(ledger.computedStances['2'], 'undetermined')
  assert.equal(ledger.stanceReasons['2'], undefined, 'nothing was overridden')
})

test('a stanceReason is not recorded on a round nothing contradicted', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, anchorSha, 'adversarial'))

  // Declared 'cleanup' matches the computed 'cleanup' (the anchor-sha self-check) — a reason is
  // supplied anyway, but there is nothing here for it to describe.
  markRoundReviewed()
  captureStdout(() =>
    runNextRound(ticket, anchorSha, 'cleanup', 'unnecessary reason nobody needed', repo)
  )

  assert.equal(
    readLedger(ticket).stanceReasons['2'],
    undefined,
    'a reason on an uncontradicted round is not recorded'
  )
})

test("readLedger freezes computedStance on the round's first record", () => {
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, 'sha-round-1-adversarial', 'adversarial'))

  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({
      kind: 'round-reviewed',
      at: new Date().toISOString(),
      round: 1,
      reviewedSha: 'sha-round-1-corrected',
      stance: 'adversarial',
      computedStance: 'cleanup',
    })
  )

  const ledger = readLedger(ticket)
  assert.equal(
    ledger.computedStances['1'],
    undefined,
    "the round's first record carried no computedStance (round 1 bypasses the real check), and a " +
      'later re-record cannot introduce one'
  )
})

test('parseEvent rejects a round-reviewed line with an unknown computedStance', () => {
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({
      kind: 'round-reviewed',
      at: new Date().toISOString(),
      round: 1,
      reviewedSha: 'sha-with-a-mistyped-computed-stance',
      stance: 'adversarial',
      computedStance: 'banana',
    })
  )

  const ledger = readLedger(ticket)
  assert.equal(
    ledger.skippedLines,
    1,
    'a present-but-invalid computedStance is rejected like any other malformed event'
  )
  assert.equal(ledger.reviewedShas['1'], undefined, 'the rejected line does not partially fold in')
})

test('readLedger folds a pre-existing round-reviewed line with no computedStance', () => {
  // The migration guarantee: every ledger written before this field existed — FLOW-287's 31 rounds
  // included — has round-reviewed lines with no computedStance key at all, the same way pre-stance
  // lines had no stance key (see the backfill test above this one).
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({
      kind: 'round-reviewed',
      at: new Date().toISOString(),
      round: 1,
      reviewedSha: 'sha-from-before-computed-stance-existed',
      stance: 'adversarial',
    })
  )

  const ledger = readLedger(ticket)
  assert.equal(ledger.skippedLines, 0, 'the legacy line is not counted as corrupt')
  assert.equal(
    ledger.reviewedShas['1'],
    'sha-from-before-computed-stance-existed',
    'the reviewedSha it carries still folds in'
  )
  assert.equal(ledger.reviewedStances['1'], 'adversarial', 'the stance it carries still folds in')
  assert.equal(
    ledger.computedStances['1'],
    undefined,
    'a computed stance nobody computed must not appear as if it had been'
  )
})

test('next-round without --reviewed-sha fails at the real CLI parsing layer rather than silently advancing', async () => {
  const missingResult = await runCli([
    'review-ledger',
    'next-round',
    '--ticket',
    ticket,
    '--stance',
    'adversarial',
  ])
  assert.notEqual(
    missingResult.exitCode,
    0,
    '--reviewed-sha is required — omitting it is rejected, not silently accepted'
  )

  const blankResult = await runCli([
    'review-ledger',
    'next-round',
    '--ticket',
    ticket,
    '--reviewed-sha',
    '',
    '--stance',
    'adversarial',
  ])
  assert.notEqual(
    blankResult.exitCode,
    0,
    'a blank --reviewed-sha is rejected the same as an absent one'
  )

  const ledger = readLedger(ticket)
  assert.equal(ledger.round, 1, 'neither rejected call advanced the round')
})

test('next-round without --stance fails at the real CLI parsing layer rather than silently advancing', async () => {
  const missingResult = await runCli([
    'review-ledger',
    'next-round',
    '--ticket',
    ticket,
    '--reviewed-sha',
    'abc1234',
  ])
  assert.notEqual(
    missingResult.exitCode,
    0,
    '--stance is required — omitting it is rejected, not silently accepted'
  )

  const invalidResult = await runCli([
    'review-ledger',
    'next-round',
    '--ticket',
    ticket,
    '--reviewed-sha',
    'abc1234',
    '--stance',
    'banana',
  ])
  assert.notEqual(
    invalidResult.exitCode,
    0,
    '--stance must be adversarial or cleanup — any other value is rejected'
  )

  const ledger = readLedger(ticket)
  assert.equal(ledger.round, 1, 'neither rejected call advanced the round')
})

test('CLI: next-round --repo-root reaches checkDeclaredStance through the real Stricli flag-wiring layer', async () => {
  const repo = makeRepo()
  const anchorSha = headSha(repo)

  markRoundReviewed()
  const closeResult = await runCli([
    'review-ledger',
    'next-round',
    '--ticket',
    ticket,
    '--reviewed-sha',
    anchorSha,
    '--stance',
    'adversarial',
    '--repo-root',
    repo,
  ])
  assert.equal(closeResult.exitCode, 0, 'round 1 closes cleanly with no prior round to contradict')

  // Pinning the anchor sha itself is a self-check over an empty range: no clause can fire, so
  // computeStance reports 'cleanup' (stance.test.ts's "returns cleanup when no clause fires").
  // Declaring 'adversarial' against that contradicts it — this only happens if --repo-root actually
  // reached checkDeclaredStance's computeStance call rather than falling back to process.cwd(), so a
  // flags['repo-root'] wiring break here reddens this test instead of silently going undetected.
  // --sha-reuse-reason is what gets the call past the sha-reuse refusal to the check under test; see
  // stanceFixtureShaReuse.
  markRoundReviewed()
  const contradictResult = await runCli([
    'review-ledger',
    'next-round',
    '--ticket',
    ticket,
    '--reviewed-sha',
    anchorSha,
    '--stance',
    'adversarial',
    '--repo-root',
    repo,
    '--sha-reuse-reason',
    stanceFixtureShaReuse,
  ])
  const report = JSON.parse(contradictResult.stdout) as {
    declaredStance: string
    computedStance: string
  }
  assert.equal(contradictResult.exitCode, 6, 'an unlicensed contradiction refuses')
  assert.equal(report.declaredStance, 'adversarial')
  assert.equal(report.computedStance, 'cleanup')
  assert.equal(readLedger(ticket).round, 2, 'the round did not advance past the refusal')
})

test('runShowRound prints the ticket and current round', () => {
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, 'sha-closing-round-1', 'adversarial'))
  const output = captureStdout(() => runShowRound(ticket))
  const parsed = JSON.parse(output) as { ticket: string; round: number }
  assert.equal(parsed.ticket, ticket, 'prints the ticket')
  assert.equal(parsed.round, 2, 'prints the round after the bump, not a stale 1')
})

test(
  'next-round releases its round claim on an append failure instead of wedging every future caller at exit 9',
  {
    skip: rootCannotBeDeniedAccess
      ? 'requires a non-root uid — root appends to a 0o400 file, so the fixture cannot fail the append'
      : false,
  },
  () => {
    captureStdout(() => runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'off-by-one in doThing'))
    const path = rawLedgerPath(ticket)
    chmodSync(path, 0o400)
    try {
      assert.throws(
        () => runNextRound(ticket, 'abc1234', 'adversarial'),
        'the append failure must propagate as a thrown error, not be swallowed'
      )
    } finally {
      chmodSync(path, 0o600)
    }

    // The failed append never advanced the round, so round 1's claim is the one that must have been
    // released. Checked directly against the claim file rather than only through a second
    // runNextRound call, so this fails on the claim itself staying held even if some other path
    // happened to make round 2 reachable. Not re-claimed via claimRoundAdvance here: doing so would
    // itself re-establish the claim the retry below needs to be free.
    assert.equal(
      existsSync(roundClaimPath(ticket, 1)),
      false,
      'a claim left over from the failed append must be released, not held forever'
    )

    resetExitCode()
    captureStdout(() => runNextRound(ticket, 'abc1234', 'adversarial'))
    assert.equal(
      getRequestedExitCode(),
      0,
      'a retry after the transient failure clears must succeed, not stay wedged at exit 9'
    )
    assert.equal(readLedger(ticket).round, 2, 'the retry actually closed round 1 and advanced')
  }
)

test('next-round: under 2-way concurrent contention on the same round, exactly one caller advances it and the other is refused, not both silently sharing the round', async () => {
  const raceChild = join(import.meta.dirname, 'test', 'next-round.race-child.ts')
  const barrierDir = mkdtempSync(join(tmpdir(), 'review-ledger-race-barrier-'))
  const goPath = join(barrierDir, 'go')
  const readyA = join(barrierDir, 'ready.a')
  const readyB = join(barrierDir, 'ready.b')

  // Read once, before either child exists, so both children are handed the exact same round to
  // race for rather than each reading it independently after GO. Fresh ticket, no ledger on disk
  // yet, so this is round 1 by construction — not a race with anything.
  const round = readLedger(ticket).round
  markRoundReviewed()

  const runChild = (reviewedSha: string, readyPath: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--experimental-transform-types',
          raceChild,
          ticket,
          String(round),
          reviewedSha,
          readyPath,
          goPath,
        ],
        { env: { ...process.env, HOME: homeDir } }
      )
      let out = ''
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString()
      })
      child.on('error', reject)
      child.on('close', () => resolve(out.trim()))
    })

  try {
    const children = Promise.all([runChild('a1b2c3d', readyA), runChild('d4e5f6a', readyB)])

    // Neither child claims a round until both have signaled ready (from inside node, after their
    // own startup) and this barrier file exists — release them together so the two claim attempts
    // for `round` are forced to actually overlap, rather than "running concurrently" in a way
    // node-startup jitter could still fully serialize.
    await waitUntil(() => existsSync(readyA) && existsSync(readyB))
    writeFileSync(goPath, '')

    const [exitA, exitB] = await children
    const exitCodes = [exitA, exitB].sort()
    assert.deepEqual(
      exitCodes,
      ['0', '9'],
      `exactly one caller must win (exit 0) and the other must be refused (exit 9) — a shared round would show both exiting 0. Got: A=${exitA} B=${exitB}`
    )

    const ledger = readLedger(ticket)
    assert.equal(
      ledger.round,
      2,
      'the round advances by exactly one step even though two callers raced on it'
    )

    const lines = rawLedgerContent(ticket)
      .split('\n')
      .filter((l) => l.trim().length > 0)
    const roundReviewedLines = lines.filter(
      (l) => (JSON.parse(l) as { kind: string }).kind === 'round-reviewed'
    )
    assert.equal(
      roundReviewedLines.length,
      1,
      'only the winner appends a round-reviewed event for round 1 — the loser must not also append one'
    )
    const roundLines = lines.filter((l) => (JSON.parse(l) as { kind: string }).kind === 'round')
    assert.equal(
      roundLines.length,
      1,
      'only the winner appends a round event advancing past round 1 — the loser must not append a second one'
    )
  } finally {
    rmSync(barrierDir, { recursive: true, force: true })
  }
})

test('next-round race-child: a malformed or missing round argument throws immediately instead of racing on it', () => {
  const raceChild = join(import.meta.dirname, 'test', 'next-round.race-child.ts')
  const barrierDir = mkdtempSync(join(tmpdir(), 'review-ledger-race-child-guard-'))
  const readyPath = join(barrierDir, 'ready')
  const goPath = join(barrierDir, 'go')

  // Written before any child spawns: if a regression narrows or removes the guard, the child falls
  // straight through the barrier and exits immediately, so a broken guard is caught by the exit-code
  // assertion below rather than only by the timeout backstop.
  writeFileSync(goPath, '')

  const runWithArgs = (args: string[]) =>
    spawnSync(process.execPath, ['--experimental-transform-types', raceChild, ...args], {
      env: { ...process.env, HOME: homeDir },
      encoding: 'utf8',
      timeout: 5000,
    })

  const assertRejected = (result: ReturnType<typeof runWithArgs>, label: string) => {
    assert.notEqual(
      result.signal,
      'SIGTERM',
      `${label}: the child must exit rather than stall, for any reason`
    )
    assert.notEqual(result.status, 0, `${label} must not exit success`)
    assert.match(
      result.stderr,
      /next-round\.race-child: expected a positive integer round, got/,
      `${label}: the guard must report what it rejected, not silently coerce to NaN and proceed`
    )
  }

  try {
    for (const badRound of ['not-a-number', '0']) {
      assertRejected(
        runWithArgs([ticket, badRound, 'a1b2c3d', readyPath, goPath]),
        `round ${JSON.stringify(badRound)}`
      )
    }
    assertRejected(runWithArgs([ticket]), 'a missing round argument')
  } finally {
    rmSync(barrierDir, { recursive: true, force: true })
  }
})

test('runShow with no status filter returns every finding regardless of status', () => {
  const openA = captureStdout(() => runOpenFinding(ticket, 'src/all-a.ts', 'doAllA', 'stays open'))
  const { id: idA } = JSON.parse(openA) as { id: string }
  const openB = captureStdout(() =>
    runOpenFinding(ticket, 'src/all-b.ts', 'doAllB', 'gets withdrawn')
  )
  const { id: idB } = JSON.parse(openB) as { id: string }
  captureStdout(() => runSetFindingStatus(ticket, idB, 'withdrawn', 'not a real defect'))

  const output = captureStdout(() => runShow(ticket))
  const parsed = JSON.parse(output) as { findings: { id: string; status: string }[] }
  const ids = parsed.findings.map((f) => f.id)
  assert.ok(ids.includes(idA), 'the open finding is present with no filter')
  assert.ok(ids.includes(idB), 'the withdrawn finding is also present with no filter')
})

test('runShowRound on a ticket with no ledger on disk sets exit code 8 rather than fabricating round 1', () => {
  const neverCreated = `${ticket}-never-created`
  const output = captureStdout(() => runShowRound(neverCreated))
  assert.equal(getRequestedExitCode(), 8, 'exit code 8 requested for a ticket with no ledger file')
  const parsed = JSON.parse(output) as { error?: string; round?: number }
  assert.equal(parsed.round, undefined, 'no round is printed — a typo is not a silent round 1')
  assert.ok(parsed.error, 'an error is printed instead')
})

test('runShow on a ticket with no ledger on disk sets exit code 8 rather than reading as a clean, zero-finding ledger', () => {
  const neverCreated = `${ticket}-never-created`
  const output = captureStdout(() => runShow(neverCreated, 'open'))
  assert.equal(getRequestedExitCode(), 8, 'exit code 8 requested for a ticket with no ledger file')
  const parsed = JSON.parse(output) as { error?: string; findings?: unknown[] }
  assert.equal(
    parsed.findings,
    undefined,
    'no findings array is printed — not indistinguishable from an actually-clean ticket'
  )
  assert.ok(parsed.error, 'an error is printed instead')
})

test('an undisposed instruction still reads pending after two round bumps', () => {
  const recordOutput = captureStdout(() =>
    runRecordInstruction(ticket, 'an instruction nobody has disposed')
  )
  const { id } = JSON.parse(recordOutput) as { id: string }

  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, 'sha-closing-round-1', 'adversarial'))
  markRoundReviewed()
  captureStdout(() =>
    runNextRound(ticket, 'sha-closing-round-2', 'adversarial', 'fixture sha, not a real commit')
  )

  const ledger = readLedger(ticket)
  assert.equal(ledger.round, 3, 'two next-round calls advanced to round 3')
  const instruction = ledger.instructions.find((i) => i.id === id)
  assert.equal(
    instruction!.disposition,
    'pending',
    'an undisposed instruction stays visibly undischarged across round bumps, not silently dropped'
  )
})

test('serialize refuses (throws) instead of hanging when the oversized field is not one it shrinks', () => {
  // symbol is a durable identifier, deliberately excluded from shrinkFreeText's field list — a
  // 5000-char symbol alone exceeds MAX_LINE_BYTES (4096) regardless of how far summary shrinks, so
  // this must throw promptly rather than loop.
  const hugeSymbol = 'x'.repeat(5000)
  assert.throws(
    () =>
      captureStdout(() => runOpenFinding(ticket, 'src/toolong.ts', hugeSymbol, 'short summary')),
    /cannot fit/,
    'refuses rather than hanging when the oversized field cannot be shrunk'
  )
})

test('CLI parity: the real argument-parsing layer routes every command and rejects invalid flag values, not just the run.ts functions directly', async () => {
  const repo = makeRepo()
  commitFile(repo, 'src/cli-parity.ts', 'content\n', 'add src/cli-parity.ts')
  const openResult = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'src/cli-parity.ts',
    '--symbol',
    'doCliParity',
    '--summary',
    'exercised through the real CLI process, not runOpenFinding directly',
    '--repo-root',
    repo,
  ])
  assert.equal(openResult.exitCode, 0, 'finding open routes correctly and succeeds')
  const { id } = JSON.parse(openResult.stdout) as { id: string }
  assert.ok(id, 'the real CLI process printed a finding id')

  const assignResult = await runCli([
    'review-ledger',
    'finding',
    'assign',
    '--ticket',
    ticket,
    '--id',
    id,
    '--owner',
    'impl-ledger',
  ])
  assert.equal(assignResult.exitCode, 0, 'finding assign routes correctly and succeeds')

  const badStatusResult = await runCli([
    'review-ledger',
    'finding',
    'status',
    '--ticket',
    ticket,
    '--id',
    id,
    '--status',
    'banana',
  ])
  assert.notEqual(
    badStatusResult.exitCode,
    0,
    '--status validator rejects a value outside fixed/withdrawn at the real parsing layer'
  )

  const blankOwnerResult = await runCli([
    'review-ledger',
    'finding',
    'assign',
    '--ticket',
    ticket,
    '--id',
    id,
    '--owner',
    '',
  ])
  assert.notEqual(
    blankOwnerResult.exitCode,
    0,
    'parseNonBlankString rejects a blank --owner at the real parsing layer, not just at runtime'
  )

  const recordResult = await runCli([
    'review-ledger',
    'instruction',
    'record',
    '--ticket',
    ticket,
    '--text',
    'exercised through the real CLI process',
  ])
  assert.equal(recordResult.exitCode, 0, 'instruction record routes correctly and succeeds')
  const { id: instructionId } = JSON.parse(recordResult.stdout) as { id: string }

  const badDispositionResult = await runCli([
    'review-ledger',
    'instruction',
    'dispose',
    '--ticket',
    ticket,
    '--id',
    instructionId,
    '--disposition',
    'sideways',
  ])
  assert.notEqual(
    badDispositionResult.exitCode,
    0,
    '--disposition validator rejects a value outside the fixed set at the real parsing layer'
  )

  const roundResult = await runCli(['review-ledger', 'round', '--ticket', ticket])
  assert.equal(roundResult.exitCode, 0, 'round routes correctly and succeeds')
  const roundParsed = JSON.parse(roundResult.stdout) as { ticket: string; round: number }
  assert.equal(roundParsed.ticket, ticket)

  const showResult = await runCli(['review-ledger', 'show', '--ticket', ticket])
  assert.equal(showResult.exitCode, 0, 'show routes correctly and succeeds')
  const showParsed = JSON.parse(showResult.stdout) as { findings: { id: string }[] }
  assert.ok(
    showParsed.findings.some((f) => f.id === id),
    'the finding opened through this same CLI process is visible in show'
  )
})

test('a blank --reason is rejected at the real CLI parsing layer for both finding status and instruction dispose', async () => {
  const repo = makeRepo()
  commitFile(repo, 'src/blank-reason.ts', 'content\n', 'add src/blank-reason.ts')
  const openResult = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'src/blank-reason.ts',
    '--symbol',
    'doBlankReason',
    '--summary',
    'exercised through the real CLI process for the blank --reason class fix',
    '--repo-root',
    repo,
  ])
  const { id } = JSON.parse(openResult.stdout) as { id: string }

  const blankWithdrawResult = await runCli([
    'review-ledger',
    'finding',
    'status',
    '--ticket',
    ticket,
    '--id',
    id,
    '--status',
    'withdrawn',
    '--reason',
    '',
  ])
  assert.notEqual(
    blankWithdrawResult.exitCode,
    0,
    'parseNonBlankString rejects a blank --reason on finding status at the real parsing layer'
  )
  const ledgerAfterFindingAttempt = readLedger(ticket)
  const findingAfterAttempt = ledgerAfterFindingAttempt.findings.find((f) => f.id === id)
  assert.equal(
    findingAfterAttempt!.status,
    'open',
    'the rejected call never reached runSetFindingStatus — status is unchanged, not withdrawn with an empty reason'
  )

  const recordResult = await runCli([
    'review-ledger',
    'instruction',
    'record',
    '--ticket',
    ticket,
    '--text',
    'an instruction for the blank --reason class fix',
  ])
  const { id: instructionId } = JSON.parse(recordResult.stdout) as { id: string }

  const blankNotActedResult = await runCli([
    'review-ledger',
    'instruction',
    'dispose',
    '--ticket',
    ticket,
    '--id',
    instructionId,
    '--disposition',
    'not-acted',
    '--reason',
    '',
  ])
  assert.notEqual(
    blankNotActedResult.exitCode,
    0,
    'parseNonBlankString rejects a blank --reason on instruction dispose at the real parsing layer'
  )
  const ledgerAfterInstructionAttempt = readLedger(ticket)
  const instructionAfterAttempt = ledgerAfterInstructionAttempt.instructions.find(
    (i) => i.id === instructionId
  )
  assert.equal(
    instructionAfterAttempt!.disposition,
    'pending',
    'the rejected call never reached runDisposeInstruction — disposition is unchanged, not not-acted with an empty reason'
  )

  // The un-guarded paths (status fixed, disposition acted) are the ones the finding actually named:
  // reason is optional there, and a blank string used to slip past parse: String and get recorded
  // verbatim as reason: ''. Prove the fix closes that path too, not just the already-runtime-guarded
  // withdrawn/not-acted paths above.
  const blankFixedResult = await runCli([
    'review-ledger',
    'finding',
    'status',
    '--ticket',
    ticket,
    '--id',
    id,
    '--status',
    'fixed',
    '--reason',
    '',
  ])
  assert.notEqual(
    blankFixedResult.exitCode,
    0,
    'a blank --reason is rejected on finding status fixed too, where reason is optional and was previously unguarded at runtime'
  )
  const ledgerAfterFixedAttempt = readLedger(ticket)
  const findingAfterFixedAttempt = ledgerAfterFixedAttempt.findings.find((f) => f.id === id)
  assert.equal(
    findingAfterFixedAttempt!.status,
    'open',
    'the rejected fixed call never reached runSetFindingStatus either'
  )

  const blankActedResult = await runCli([
    'review-ledger',
    'instruction',
    'dispose',
    '--ticket',
    ticket,
    '--id',
    instructionId,
    '--disposition',
    'acted',
    '--reason',
    '',
  ])
  assert.notEqual(
    blankActedResult.exitCode,
    0,
    'a blank --reason is rejected on instruction dispose acted too, where reason is optional and was previously unguarded at runtime'
  )
  const ledgerAfterActedAttempt = readLedger(ticket)
  const instructionAfterActedAttempt = ledgerAfterActedAttempt.instructions.find(
    (i) => i.id === instructionId
  )
  assert.equal(
    instructionAfterActedAttempt!.disposition,
    'pending',
    'the rejected acted call never reached runDisposeInstruction either'
  )
})

test('--fix-commit is validated as sha-shaped at the real CLI parsing layer, not just --reviewed-sha', async () => {
  const repo = makeRepo()
  commitFile(repo, 'src/fix-commit-shape.ts', 'content\n', 'add src/fix-commit-shape.ts')
  const openResult = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'src/fix-commit-shape.ts',
    '--symbol',
    'doFixCommitShape',
    '--summary',
    'exercised through the real CLI process for the --fix-commit shape-check sweep',
    '--repo-root',
    repo,
  ])
  const { id } = JSON.parse(openResult.stdout) as { id: string }

  const malformedResult = await runCli([
    'review-ledger',
    'finding',
    'status',
    '--ticket',
    ticket,
    '--id',
    id,
    '--status',
    'fixed',
    '--fix-commit',
    'not-a-sha',
  ])
  assert.notEqual(
    malformedResult.exitCode,
    0,
    'parseShaLike rejects a non-hex --fix-commit at the real parsing layer, proving commands/' +
      'review-ledger.ts actually wires this flag to it and not just parse.ts in isolation'
  )
  const ledgerAfterMalformed = readLedger(ticket)
  const findingAfterMalformed = ledgerAfterMalformed.findings.find((f) => f.id === id)
  assert.equal(
    findingAfterMalformed!.status,
    'open',
    'the rejected call never reached runSetFindingStatus — status is unchanged, not fixed with a malformed commit'
  )

  const realSha = headSha(repo)
  const validResult = await runCli([
    'review-ledger',
    'finding',
    'status',
    '--ticket',
    ticket,
    '--id',
    id,
    '--status',
    'fixed',
    '--fix-commit',
    realSha.slice(0, 7),
    '--repo-root',
    repo,
  ])
  assert.equal(
    validResult.exitCode,
    0,
    'a valid, sha-shaped --fix-commit that resolves to a real commit is accepted'
  )
  const ledgerAfterValid = readLedger(ticket)
  const findingAfterValid = ledgerAfterValid.findings.find((f) => f.id === id)
  assert.equal(findingAfterValid!.status, 'fixed', 'the valid call reached runSetFindingStatus')
  assert.equal(
    findingAfterValid!.fixCommit,
    realSha.slice(0, 7),
    'the valid sha is recorded verbatim'
  )
})

test('finding status --fix-commit that does not resolve to a commit is refused with exit 15, not silently accepted', async () => {
  const repo = makeRepo()
  commitFile(repo, 'src/fix-commit-existence.ts', 'content\n', 'add src/fix-commit-existence.ts')
  const openResult = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'src/fix-commit-existence.ts',
    '--symbol',
    'doFixCommitExistence',
    '--summary',
    'exercised through the real CLI process for the --fix-commit existence-check sweep',
    '--repo-root',
    repo,
  ])
  const { id } = JSON.parse(openResult.stdout) as { id: string }

  // A 40-hex value, not a short prefix: git accepts a well-formed 40-hex as syntactically valid
  // without consulting the object store, so only the ^{commit} peel this guard applies makes it
  // fail — a short prefix like 'deadbee' would pass this test even with the peel removed, since
  // `git rev-parse --verify --quiet deadbee` already exits nonzero on its own (no such object).
  const unresolvableSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
  const nonResolvingResult = await runCli([
    'review-ledger',
    'finding',
    'status',
    '--ticket',
    ticket,
    '--id',
    id,
    '--status',
    'fixed',
    '--fix-commit',
    unresolvableSha,
    '--repo-root',
    repo,
  ])
  assert.equal(
    nonResolvingResult.exitCode,
    15,
    'a sha-shaped --fix-commit that names no object in --repo-root is refused at exit 15'
  )
  const { error: nonResolvingError } = JSON.parse(nonResolvingResult.stdout) as { error: string }
  // resolveRepoRoot resolves through `git rev-parse --show-toplevel`, which canonicalizes symlinks
  // (e.g. macOS's /var -> /private/var) — the message names that canonical path, not the raw repo.
  const canonicalRepo = realpathSync(repo)
  assert.equal(
    nonResolvingError,
    `--fix-commit ${unresolvableSha} does not resolve to a commit in ${canonicalRepo}: either the ` +
      `sha names nothing there, or ${canonicalRepo} is not a git repository — pass --repo-root ` +
      'pointing at the repo the fix commit belongs to',
    'the refusal names the sha and the repo it failed to resolve in, not just a bare exit code'
  )
  const ledgerAfterRefusal = readLedger(ticket)
  const findingAfterRefusal = ledgerAfterRefusal.findings.find((f) => f.id === id)
  assert.equal(
    findingAfterRefusal!.status,
    'open',
    'the refused call never reached the append — status is unchanged, not fixed with a phantom commit'
  )
})

test('finding status --fix-commit is refused, not silently accepted, when --repo-root cannot be resolved to a git repository', async () => {
  const nonRepoDir = mkdtempSync(join(tmpdir(), 'ledger-test-non-repo-'))
  const repo = makeRepo()
  commitFile(
    repo,
    'src/fix-commit-null-repo-root.ts',
    'content\n',
    'add src/fix-commit-null-repo-root.ts'
  )
  const openResult = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'src/fix-commit-null-repo-root.ts',
    '--symbol',
    'doFixCommitNullRepoRoot',
    '--summary',
    'exercised through the real CLI process for the --fix-commit null-repo-root sweep',
    '--repo-root',
    repo,
  ])
  const { id } = JSON.parse(openResult.stdout) as { id: string }

  const unresolvableRepoResult = await runCli([
    'review-ledger',
    'finding',
    'status',
    '--ticket',
    ticket,
    '--id',
    id,
    '--status',
    'fixed',
    '--fix-commit',
    'deadbeefabc',
    '--repo-root',
    nonRepoDir,
  ])
  assert.equal(
    unresolvableRepoResult.exitCode,
    15,
    'a --repo-root that is not a git repository refuses --fix-commit rather than skipping the check'
  )
  const ledgerAfterRefusal = readLedger(ticket)
  const findingAfterRefusal = ledgerAfterRefusal.findings.find((f) => f.id === id)
  assert.equal(
    findingAfterRefusal!.status,
    'open',
    'the refused call never reached the append — status is unchanged, not fixed with an ' +
      'unverifiable commit'
  )
  assert.equal(
    findingAfterRefusal!.fixCommit,
    undefined,
    'no fixCommit was recorded on the unresolvable-repo-root path'
  )
})

test('finding status --fix-commit that matches more than one object is reported as ambiguous, not silently narrowed', async () => {
  const repo = makeRepo()
  // Two distinct blob contents whose git blob shas were found, by brute-force local sha1 search over
  // "blob <len>\0<content>", to share the 7-hex prefix below — the shortest fixCommit parseShaLike
  // admits. Real, not synthetic: `git hash-object -w` writes both into this repo's own object store,
  // so `--disambiguate` reports a genuine collision, not a stubbed one.
  writeFileSync(join(repo, 'collide-a.txt'), 'flow309-collision-fixture-4809\n')
  writeFileSync(join(repo, 'collide-b.txt'), 'flow309-collision-fixture-21065\n')
  gitRun(repo, ['hash-object', '-w', join(repo, 'collide-a.txt')])
  gitRun(repo, ['hash-object', '-w', join(repo, 'collide-b.txt')])
  const ambiguousPrefix = 'c83d131'
  commitFile(repo, 'src/fix-commit-ambiguous.ts', 'content\n', 'add src/fix-commit-ambiguous.ts')

  const openResult = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'src/fix-commit-ambiguous.ts',
    '--symbol',
    'doFixCommitAmbiguous',
    '--summary',
    'exercised through the real CLI process for the --fix-commit ambiguous-prefix sweep',
    '--repo-root',
    repo,
  ])
  const { id } = JSON.parse(openResult.stdout) as { id: string }

  const ambiguousResult = await runCli([
    'review-ledger',
    'finding',
    'status',
    '--ticket',
    ticket,
    '--id',
    id,
    '--status',
    'fixed',
    '--fix-commit',
    ambiguousPrefix,
    '--repo-root',
    repo,
  ])
  assert.equal(
    ambiguousResult.exitCode,
    15,
    'a --fix-commit prefix matching more than one object is refused at exit 15, not narrowed to one'
  )
  const { error: ambiguousError } = JSON.parse(ambiguousResult.stdout) as { error: string }
  const canonicalRepo = realpathSync(repo)
  const escapedRepo = canonicalRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.match(
    ambiguousError,
    new RegExp(
      `^--fix-commit ${ambiguousPrefix} is ambiguous in ${escapedRepo}: it matches 2 objects \\(`
    ),
    'the refusal names the count of objects the prefix matched, not just a bare exit code'
  )
  assert.match(
    ambiguousError,
    /pass enough of the sha to name exactly one$/,
    'the refusal tells the caller how to disambiguate, not just that it failed'
  )
  const ledgerAfterRefusal = readLedger(ticket)
  const findingAfterRefusal = ledgerAfterRefusal.findings.find((f) => f.id === id)
  assert.equal(
    findingAfterRefusal!.status,
    'open',
    'the refused call never reached the append — status is unchanged, not fixed with an ambiguous commit'
  )
})

test('finding open accepts --file when it names a path in the diff against origin/main', async () => {
  const repo = makeRepo()
  commitFile(repo, 'src/in-diff.ts', 'content\n', 'add src/in-diff.ts')

  const result = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'src/in-diff.ts',
    '--symbol',
    'doInDiff',
    '--summary',
    'a real finding against a path the branch actually changed',
    '--repo-root',
    repo,
  ])
  assert.equal(result.exitCode, 0, '--file inside the diff against origin/main is accepted')
  const { id } = JSON.parse(result.stdout) as { id: string }
  const finding = readLedger(ticket).findings.find((f) => f.id === id)
  assert.equal(finding?.status, 'open', 'the finding was actually opened, not refused')
})

test('finding open accepts a non-ASCII path genuinely in the diff — git diff --name-only quoting', async () => {
  const repo = makeRepo()
  commitFile(repo, 'src/ascii-control.ts', 'content\n', 'add src/ascii-control.ts')
  commitFile(repo, 'src/café.ts', 'content\n', 'add src/café.ts')

  const controlResult = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'src/ascii-control.ts',
    '--symbol',
    'doAsciiControl',
    '--summary',
    'a real finding against an ASCII path in the same diff, to isolate the quoting cause',
    '--repo-root',
    repo,
  ])
  assert.equal(
    controlResult.exitCode,
    0,
    'the ASCII control path in the same diff is accepted, isolating the failure to quoting'
  )

  const result = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'src/café.ts',
    '--symbol',
    'doCafe',
    '--summary',
    'a real finding against a non-ASCII path the branch actually changed',
    '--repo-root',
    repo,
  ])
  assert.equal(
    result.exitCode,
    0,
    'a non-ASCII --file genuinely in the diff must not be refused as out-of-diff'
  )
  const { id } = JSON.parse(result.stdout) as { id: string }
  const finding = readLedger(ticket).findings.find((f) => f.id === id)
  assert.equal(finding?.status, 'open', 'the finding was actually opened, not refused')
})

test('finding open refuses a target outside the diff, with no hatch to license it', async () => {
  const repo = makeRepo()
  commitFile(repo, 'src/unrelated.ts', 'content\n', 'add an unrelated diff file')

  const result = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    '.scratch/fixture.sh',
    '--symbol',
    'doScratchFixture',
    '--summary',
    'a finding against a fixture the diff never touched',
    '--repo-root',
    repo,
  ])
  assert.equal(
    result.exitCode,
    16,
    '--file outside the diff against origin/main is refused at exit 16'
  )
  const { error } = JSON.parse(result.stdout) as { error: string }
  assert.match(
    error,
    /is not in the diff/,
    'the refusal names why: the path is not in the diff against origin/main'
  )
  assert.match(error, /note add/, 'the refusal routes a record defect to note add, not a flag')
  const ledger = readLedger(ticket)
  assert.equal(
    ledger.findings.length,
    0,
    'the refused call never appended a finding-open event at all'
  )

  const withRemovedFlag = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    '.scratch/fixture.sh',
    '--symbol',
    'doScratchFixture',
    '--summary',
    'a finding against a fixture the diff never touched',
    '--repo-root',
    repo,
    '--out-of-diff',
    'x',
  ])
  assert.equal(
    withRemovedFlag.exitCode,
    252,
    '--out-of-diff no longer exists — Stricli rejects it as an unknown flag'
  )
})

test('finding open refuses a check file with no --check, before any git call', async () => {
  const nonRepoDir = mkdtempSync(join(tmpdir(), 'ledger-test-non-repo-'))

  const result = await runCli(
    [
      'review-ledger',
      'finding',
      'open',
      '--ticket',
      ticket,
      '--file',
      'docs/plans/2026-09-11-FLOW-337-proofs.md',
      '--symbol',
      'CaptureIndex',
      '--summary',
      'a wording complaint about the capture index, not a capture that fails to support a claim',
    ],
    nonRepoDir
  )
  assert.equal(result.exitCode, 16, 'a check file with no --check is refused at exit 16')
  const { error } = JSON.parse(result.stdout) as { error: string }
  assert.match(error, /check file/, 'the refusal names the target as a check file')
})

test('finding open opens a check file once --check names a capture id or a declared gate', async () => {
  const captureIdResult = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'docs/plans/2026-09-11-FLOW-337-proofs.md',
    '--symbol',
    'CaptureIndex',
    '--summary',
    'the cited capture id does not exist on the proof-ledger',
    '--check',
    '0123456789ab',
  ])
  assert.equal(captureIdResult.exitCode, 0, '--check naming a 12-hex capture id opens')
  const { id: captureIdFindingId } = JSON.parse(captureIdResult.stdout) as { id: string }
  const showOutput = captureStdout(() => runShow(ticket))
  const shown = (JSON.parse(showOutput) as { findings: { id: string; check?: string }[] }).findings
  assert.equal(
    shown.find((f) => f.id === captureIdFindingId)?.check,
    '0123456789ab',
    'the finding carries the cited capture id'
  )

  writeManifest(
    ticket,
    JSON.stringify({
      gates: [{ name: 'typecheck', command: 'pnpm typecheck', owner: 'implementer' }],
    })
  )
  const gateResult = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'docs/plans/2026-09-11-FLOW-337-3-impl.md',
    '--symbol',
    'T1',
    '--summary',
    'the declared gate does not actually cover what the plan claims',
    '--check',
    'typecheck',
  ])
  assert.equal(gateResult.exitCode, 0, '--check naming a declared gate opens')

  const badCheckResult = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'docs/plans/2026-09-11-FLOW-337-proofs.md',
    '--symbol',
    'CaptureIndex',
    '--summary',
    'neither a capture id nor a declared gate',
    '--check',
    'nope',
  ])
  assert.equal(badCheckResult.exitCode, 16, '--check naming neither is refused at exit 16')
  const { error: badCheckError } = JSON.parse(badCheckResult.stdout) as { error: string }
  assert.match(badCheckError, /neither/, 'the refusal says --check named neither shape')

  assert.equal(
    isCheckTarget('docs/plans/2026-09-11-FLOW-337-3-impl.md'),
    true,
    '*-3-impl.md is a check target'
  )
  assert.equal(isCheckTarget('proof-ledger:abc'), true, 'proof-ledger:<id> is a check target')
  assert.equal(isCheckTarget('gate-ledger:test'), true, 'gate-ledger:<gate> is a check target')
})

test('finding open on a virtual check target opens when --check matches the suffix in --file, and refuses naming both values when it does not', async () => {
  const matchResult = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'proof-ledger:0123456789ab',
    '--symbol',
    'CaptureIndex',
    '--summary',
    'the cited capture id does not exist on the proof-ledger',
    '--check',
    '0123456789ab',
  ])
  assert.equal(matchResult.exitCode, 0, "--check matching --file's own suffix opens")

  const mismatchResult = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'proof-ledger:0123456789ab',
    '--symbol',
    'CaptureIndex',
    '--summary',
    'a finding whose target and citation disagree',
    '--check',
    'fedcba987654',
  ])
  assert.equal(
    mismatchResult.exitCode,
    16,
    "--check naming a different capture than --file's own suffix is refused"
  )
  const { error: mismatchError } = JSON.parse(mismatchResult.stdout) as { error: string }
  assert.match(mismatchError, /0123456789ab/, 'the refusal names the suffix --file carries')
  assert.match(mismatchError, /fedcba987654/, 'the refusal names the value --check carries')
})

test('finding open on a virtual check target with an embedded newline still enforces the suffix-agreement guard', async () => {
  const result = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'proof-ledger:0123456789ab\nfedcba987654',
    '--symbol',
    'CaptureIndex',
    '--summary',
    'an embedded newline must not bypass the suffix-agreement guard',
    '--check',
    '111111111111',
  ])
  assert.equal(
    result.exitCode,
    16,
    'an embedded newline in --file does not let a mismatched --check bypass the guard'
  )
  const { error } = JSON.parse(result.stdout) as { error: string }
  assert.match(error, /111111111111/, 'the refusal names the value --check carries')
})

test('finding open refuses --check on a shipped file — it is only for a check file', async () => {
  const repo = makeRepo()
  commitFile(repo, 'src/in-diff-with-check.ts', 'content\n', 'add src/in-diff-with-check.ts')

  const result = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'src/in-diff-with-check.ts',
    '--symbol',
    'doInDiffWithCheck',
    '--summary',
    'a shipped-file finding that mistakenly names --check',
    '--repo-root',
    repo,
    '--check',
    '0123456789ab',
  ])
  assert.equal(result.exitCode, 16, '--check on a shipped file is refused at exit 16')
  const { error } = JSON.parse(result.stdout) as { error: string }
  assert.match(error, /only for a check file/, 'the refusal says --check does not apply here')
})

test('exit 12 still fires for a non-check file when origin/main is unresolvable, but a check file with --check opens regardless — classification precedes git', async () => {
  const repo = makeRepo()
  gitRun(repo, ['update-ref', '-d', 'refs/remotes/origin/main'])

  const shippedResult = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'src/no-origin-main.ts',
    '--symbol',
    'doNoOriginMain',
    '--summary',
    'a finding raised where origin/main cannot be resolved at all',
    '--repo-root',
    repo,
  ])
  assert.equal(
    shippedResult.exitCode,
    12,
    'an unresolvable origin/main is a git precondition failure, refused at exit 12'
  )

  const checkResult = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'docs/plans/2026-09-11-FLOW-337-proofs.md',
    '--symbol',
    'CaptureIndex',
    '--summary',
    'a check-file finding filed where origin/main happens to be unresolvable',
    '--repo-root',
    repo,
    '--check',
    '0123456789ab',
  ])
  assert.equal(
    checkResult.exitCode,
    0,
    'a check file with --check opens even where origin/main is unresolvable — classification runs before any git call'
  )
})

test('note add is visible in show and is filtered out once marked done', async () => {
  const addResult = await runCli([
    'review-ledger',
    'note',
    'add',
    '--ticket',
    ticket,
    '--target',
    'pr-body',
    '--text',
    'the PR body claims a gate that was never run',
  ])
  assert.equal(addResult.exitCode, 0, 'note add succeeds')
  const { id } = JSON.parse(addResult.stdout) as { id: string }

  const showAfterAdd = await runCli(['review-ledger', 'show', '--ticket', ticket])
  const shownAfterAdd = JSON.parse(showAfterAdd.stdout) as { notes: { id: string }[] }
  assert.ok(
    shownAfterAdd.notes.some((note) => note.id === id),
    'show lists the open note under notes'
  )

  const doneResult = await runCli(['review-ledger', 'note', 'done', '--ticket', ticket, '--id', id])
  assert.equal(doneResult.exitCode, 0, 'note done succeeds')
  const doneParsed = JSON.parse(doneResult.stdout) as { id: string; done: boolean }
  assert.equal(doneParsed.done, true, 'note done reports the note as done')

  const showAfterDone = await runCli(['review-ledger', 'show', '--ticket', ticket])
  const shownAfterDone = JSON.parse(showAfterDone.stdout) as { notes: { id: string }[] }
  assert.equal(
    shownAfterDone.notes.some((note) => note.id === id),
    false,
    'show omits a note once it is done'
  )
})

test('re-adding a done note re-arms it and it reappears in show', async () => {
  const addResult = await runCli([
    'review-ledger',
    'note',
    'add',
    '--ticket',
    ticket,
    '--target',
    'pr-body',
    '--text',
    'the PR body claims a gate that was never run',
  ])
  assert.equal(addResult.exitCode, 0, 'note add succeeds')
  const { id } = JSON.parse(addResult.stdout) as { id: string }

  const doneResult = await runCli(['review-ledger', 'note', 'done', '--ticket', ticket, '--id', id])
  assert.equal(doneResult.exitCode, 0, 'note done succeeds')

  const reAddResult = await runCli([
    'review-ledger',
    'note',
    'add',
    '--ticket',
    ticket,
    '--target',
    'pr-body',
    '--text',
    'the PR body claims a gate that was never run',
  ])
  assert.equal(reAddResult.exitCode, 7, 're-adding a done note re-arms it at exit 7')
  const reAddParsed = JSON.parse(reAddResult.stdout) as { id: string; reopened: boolean }
  assert.equal(reAddParsed.reopened, true, 're-add reports the note as reopened')

  const showAfterReAdd = await runCli(['review-ledger', 'show', '--ticket', ticket])
  const shownAfterReAdd = JSON.parse(showAfterReAdd.stdout) as { notes: { id: string }[] }
  assert.ok(
    shownAfterReAdd.notes.some((note) => note.id === id),
    're-adding a done note makes it reappear in show'
  )
})

test('note done on an id no note ever recorded is refused at exit 5', async () => {
  const doneNopeResult = await runCli([
    'review-ledger',
    'note',
    'done',
    '--ticket',
    ticket,
    '--id',
    'nope',
  ])
  assert.equal(doneNopeResult.exitCode, 5, 'note done on an id no note add ever recorded exits 5')

  const badTargetResult = await runCli([
    'review-ledger',
    'note',
    'add',
    '--ticket',
    ticket,
    '--target',
    'elsewhere',
    '--text',
    'a target outside the closed list',
  ])
  assert.equal(
    badTargetResult.exitCode,
    252,
    '--target outside the closed enum is rejected at the real parsing layer'
  )
})

test('a round carrying only a note, with no finding and no senior, still refuses next-round at exit 20 — a note never marks a round reviewed', async () => {
  const addResult = await runCli([
    'review-ledger',
    'note',
    'add',
    '--ticket',
    ticket,
    '--target',
    'commit-message',
    '--text',
    'the squash message overstates what T2 covers',
  ])
  assert.equal(addResult.exitCode, 0, 'note add succeeds')

  const closeResult = await runCli([
    'review-ledger',
    'next-round',
    '--ticket',
    ticket,
    '--reviewed-sha',
    'deadbee',
    '--stance',
    'adversarial',
  ])
  assert.equal(
    closeResult.exitCode,
    20,
    'a note is not a review mark — next-round still refuses the round as unreviewed'
  )
})

test('a raw note-add event with an invalid target is rejected as corrupt, not folded', () => {
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({
      kind: 'note-add',
      at: new Date().toISOString(),
      id: 'deadbeef0000',
      round: 1,
      target: 'banana',
      text: 'a note with an invalid target',
    })
  )
  const ledger = readLedger(ticket)
  assert.equal(
    ledger.skippedLines,
    1,
    'a present-but-invalid target is rejected like any other malformed event'
  )
  assert.equal(
    ledger.notes.find((note) => note.id === 'deadbeef0000'),
    undefined,
    'the rejected line does not partially fold in — no note is recorded for it'
  )
})

test('senior-spawned then senior-shutdown folds to an accounted round', () => {
  appendEvent(ticket, {
    kind: 'senior-spawned',
    at: '2026-09-06T10:00:00.000Z',
    round: 1,
    agentId: 'senior-round-1',
  })
  appendEvent(ticket, {
    kind: 'senior-shutdown',
    at: '2026-09-06T12:00:00.000Z',
    round: 1,
    agentId: 'senior-round-1',
  })

  const ledger = readLedger(ticket)
  assert.equal(ledger.skippedLines, 0, 'both senior events parsed rather than being skipped')
  assert.equal(ledger.seniors['1']?.length, 1, 'the round carries exactly one senior entry')
  assert.equal(
    ledger.seniors['1']?.[0]?.agentId,
    'senior-round-1',
    "the round carries the spawned senior's identity"
  )
  assert.equal(
    ledger.seniors['1']?.[0]?.shutdownAt,
    '2026-09-06T12:00:00.000Z',
    'the shutdown stamps the round with the time it was recorded, not merely a non-null flag'
  )
})

test('a second senior-spawned for a different agent adds a second entry, in spawn order', () => {
  appendEvent(ticket, {
    kind: 'senior-spawned',
    at: '2026-09-06T10:00:00.000Z',
    round: 1,
    agentId: 'senior-first',
  })
  appendEvent(ticket, {
    kind: 'senior-spawned',
    at: '2026-09-06T11:00:00.000Z',
    round: 1,
    agentId: 'senior-second',
  })

  const ledger = readLedger(ticket)
  assert.equal(ledger.skippedLines, 0, 'the second spawn event parsed rather than being skipped')
  const seniors = ledger.seniors['1']
  assert.equal(seniors?.length, 2, 'a replacement senior adds a second entry, not a moved one')
  assert.equal(seniors?.[0]?.agentId, 'senior-first', 'the first entry keeps its own identity')
  assert.equal(seniors?.[0]?.shutdownAt, null, 'the first senior is still unaccounted')
  assert.equal(seniors?.[1]?.agentId, 'senior-second', 'the second entry names the replacement')
  assert.equal(seniors?.[1]?.shutdownAt, null, 'the second senior is also unaccounted')
})

test('a repeat senior-spawned for the SAME agent does not add a second entry', () => {
  appendEvent(ticket, {
    kind: 'senior-spawned',
    at: '2026-09-06T10:00:00.000Z',
    round: 1,
    agentId: 'senior-first',
  })
  appendEvent(ticket, {
    kind: 'senior-spawned',
    at: '2026-09-06T11:00:00.000Z',
    round: 1,
    agentId: 'senior-first',
  })

  const ledger = readLedger(ticket)
  // The second channel this absence-of-change assertion needs: the repeat event really was written
  // and really was parsed. Without it, a fold that dropped senior-spawned entirely would pass.
  const spawnLines = rawLedgerContent(ticket)
    .split('\n')
    .filter((line) => line.includes('"kind":"senior-spawned"'))
  assert.equal(spawnLines.length, 2, 'both spawn events were actually written to the log')
  assert.equal(ledger.skippedLines, 0, 'the repeat spawn event parsed rather than being skipped')
  assert.equal(ledger.seniors['1']?.length, 1, 'the repeat spawn did not add a second entry')
  assert.equal(ledger.seniors['1']?.[0]?.agentId, 'senior-first')
  assert.equal(
    ledger.seniors['1']?.[0]?.shutdownAt,
    null,
    'the repeat spawn did not account for it'
  )
})

test('a ledger with no senior events folds to an empty seniors map', () => {
  captureStdout(() =>
    runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'a finding, and nothing else')
  )

  const ledger = readLedger(ticket)
  assert.equal(ledger.findings.length, 1, 'the fold ran over a ledger that really does hold events')
  assert.equal(
    Object.keys(ledger.seniors).length,
    0,
    'a ledger written before senior events existed reports no senior at all, not a leaked one'
  )
})

test('a round with exactly one senior-spawned/senior-shutdown pair — the only shape a ledger written before multi-senior support ever produced — folds as a one-element list', () => {
  appendEvent(ticket, {
    kind: 'senior-spawned',
    at: '2026-09-06T10:00:00.000Z',
    round: 1,
    agentId: 'senior-legacy',
  })
  appendEvent(ticket, {
    kind: 'senior-shutdown',
    at: '2026-09-06T12:00:00.000Z',
    round: 1,
    agentId: 'senior-legacy',
  })

  const seniors = readLedger(ticket).seniors['1']
  assert.equal(seniors?.length, 1, 'a single spawn/shutdown pair folds as a one-element list')
  assert.equal(seniors?.[0]?.agentId, 'senior-legacy')
  assert.notEqual(seniors?.[0]?.shutdownAt, null, 'and the one entry reads as accounted')
})

test("senior spawned refuses when --round does not match the ledger's current round", () => {
  // The two fields must be able to disagree for this to prove anything: advance the ledger first,
  // then record against the stale round the caller typed.
  captureStdout(() =>
    runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'a round-1 finding, so round 1 has a mark')
  )
  resetExitCode()
  captureStdout(() => runNextRound(ticket, 'abc1234', 'adversarial'))
  resetExitCode()

  const output = captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-stale-round'))

  assert.equal(
    getRequestedExitCode(),
    22,
    'a mistyped --round refuses rather than silently disarming exit 17'
  )
  const result = JSON.parse(output) as { round: number; ledgerRound: number }
  assert.equal(result.round, 1, 'the refusal names the round the caller passed')
  assert.equal(result.ledgerRound, 2, "and the ledger's actual current round")
  assert.equal(
    readLedger(ticket).seniors['1'],
    undefined,
    'the refused call appended nothing — round 1 stays without a senior record'
  )
})

test('senior spawned refuses a repeat spawn of the SAME agent for a round that already has it', () => {
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'senior-first'))
  resetExitCode()

  const output = captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'senior-first'))

  assert.equal(getRequestedExitCode(), 23, 'a duplicate spawn refuses rather than being appended')
  const result = JSON.parse(output) as { recordedAgentIds: string[]; givenAgentId: string }
  assert.deepEqual(
    result.recordedAgentIds,
    ['senior-first'],
    'the refusal names every senior already recorded for the round'
  )
  assert.equal(result.givenAgentId, 'senior-first', 'and the duplicate id the caller just tried')
  // seniors['1'][0].agentId alone cannot show the refused call appended nothing: a guard that
  // appended the second event and only then refused would read identically here, since both spawns
  // name the same agent. The raw log is the only channel that can tell the two apart.
  const spawnLines = rawLedgerContent(ticket)
    .split('\n')
    .filter((line) => line.includes('"kind":"senior-spawned"'))
  assert.equal(
    spawnLines.length,
    1,
    'the refused call appended nothing — only the first spawn landed'
  )
})

test('senior spawned accepts a DIFFERENT agent for a round that already has one on record', () => {
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'senior-first'))
  resetExitCode()

  const output = captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'senior-second'))

  assert.equal(getRequestedExitCode(), 0, 'a replacement senior is accepted, not refused')
  assert.deepEqual(JSON.parse(output), {
    ticket,
    round: 1,
    ledgerRound: 1,
    agentId: 'senior-second',
    recorded: 'spawned',
  })
  // The raw log, not the fold: the fold could in principle absorb a second spawn into the first
  // entry and still read as "two seniors" by some other path. Only the log proves a second, distinct
  // senior-spawned event actually landed.
  const spawnLines = rawLedgerContent(ticket)
    .split('\n')
    .filter((line) => line.includes('"kind":"senior-spawned"'))
  assert.equal(
    spawnLines.length,
    2,
    'both spawns reached the log — the replacement was not refused'
  )
  const seniors = readLedger(ticket).seniors['1']
  assert.equal(seniors?.length, 2, 'the round now carries both seniors')
  assert.equal(seniors?.[0]?.agentId, 'senior-first', 'the first entry is unchanged')
  assert.equal(seniors?.[1]?.agentId, 'senior-second', 'the second entry names the replacement')
})

test('senior spawned refuses a replacement for a round that is already closed, even though --round still matches', () => {
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-first'))
  resetExitCode()
  captureStdout(() => runRecordSeniorShutdown(ticket, 1, 'sen-first'))
  resetExitCode()
  // Every real close now advances past the round it closes, so a closed-but-uncounted round can no
  // longer be produced by calling next-round/round-close. This injects the raw event shape a ledger
  // closed before the round-model redesign's close-always-advances change was left in: a
  // round-reviewed event with no 'round' event advancing past it.
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: '2026-09-06T13:00:00.000Z',
    round: 1,
    reviewedSha: 'sha-closing-round-1',
    stance: 'adversarial',
  })
  // exit 22's round-match check alone would let this spawn through.
  assert.equal(
    readLedger(ticket).round,
    1,
    'the wedge leaves the round counter on the closed round'
  )

  const out = captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-after-close'))

  assert.equal(
    getRequestedExitCode(),
    24,
    'a closed round refuses further spawns even though --round still matches'
  )
  const result = JSON.parse(out) as { round: number; reviewedSha: string }
  assert.equal(result.round, 1, 'the refusal names the round the caller passed')
  assert.equal(
    result.reviewedSha,
    'sha-closing-round-1',
    'and the sha the round was closed against'
  )
  assert.equal(
    readLedger(ticket).seniors['1']?.length,
    1,
    'the refused call appended nothing — only the original senior is on record'
  )
})

/**
 * The shape a ledger closed before the round-model redesign's close-always-advances change was left
 * in: a round-reviewed event for round 1 with no 'round' event advancing past it. No close can
 * produce this any more, so it is injected rather than driven through the commands.
 */
const wedgeRoundOne = (): void => {
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: '2026-09-06T13:00:00.000Z',
    round: 1,
    reviewedSha: 'sha-closing-round-1',
    stance: 'adversarial',
  })
}

test('round advance refuses a round that carries a review but no close', () => {
  markRoundReviewed()

  const out = captureStdout(() => runRoundAdvance(ticket, 'trying to skip the close'))

  assert.equal(
    getRequestedExitCode(),
    25,
    'a reviewed-but-unclosed round has nothing to advance past — closure is the precondition, not review'
  )
  const result = JSON.parse(out) as { round: number }
  assert.equal(result.round, 1, 'the refusal names the round it looked at')
  const after = readLedger(ticket)
  assert.equal(after.round, 1, 'the counter did not move')
  assert.deepEqual(after.roundAdvanceReasons, {}, 'and the refused call recorded no reason')
})

test('round advance moves the counter past a wedged closed round and records why', () => {
  wedgeRoundOne()
  assert.equal(readLedger(ticket).round, 1, 'the wedge leaves the counter on the closed round')

  const out = captureStdout(() => runRoundAdvance(ticket, 'closed under the old round-close'))

  assert.equal(getRequestedExitCode(), 0, 'a closed round is the case this command exists for')
  const result = JSON.parse(out) as { round: number; advancedFrom: number; reason?: string }
  assert.equal(result.round, 2, 'the output names the round the ledger now sits on')
  assert.equal(
    result.reason,
    undefined,
    'and does not echo a reason serialize() may have shrunk on the way to disk'
  )
  assert.equal(result.advancedFrom, 1, 'and the wedged round it advanced past')
  const after = readLedger(ticket)
  assert.equal(after.round, 2, 'the counter actually moved')
  assert.equal(
    after.roundAdvanceReasons['1'],
    'closed under the old round-close',
    'the reason folds keyed by the round advanced FROM, not the one advanced TO'
  )
  assert.equal(
    after.roundAdvanceReasons['2'],
    undefined,
    'nothing is keyed to the round it reached'
  )
  assert.equal(
    after.reviewedShas['1'],
    'sha-closing-round-1',
    'and the close it advanced past is left exactly as it was'
  )
})

test('round advance refuses its own second call on the round it just advanced to', () => {
  wedgeRoundOne()
  captureStdout(() => runRoundAdvance(ticket, 'first unwedge'))
  resetExitCode()

  const out = captureStdout(() => runRoundAdvance(ticket, 'second unwedge'))

  assert.equal(
    getRequestedExitCode(),
    25,
    'the round the first call advanced to is unclosed, so re-running is self-limiting'
  )
  const result = JSON.parse(out) as { round: number }
  assert.equal(result.round, 2, 'the refusal names the round the first call left the ledger on')
  const after = readLedger(ticket)
  assert.equal(after.round, 2, 'the counter stayed where the first call left it')
  assert.equal(after.roundAdvanceReasons['1'], 'first unwedge', 'the first call is unchanged')
  assert.equal(
    after.roundAdvanceReasons['2'],
    undefined,
    'and the refused second call recorded nothing'
  )
})

test('a round event with no reason folds and adds no roundAdvanceReasons entry', () => {
  appendEvent(ticket, { kind: 'round', at: '2026-09-06T13:00:00.000Z', round: 3 })

  const ledger = readLedger(ticket)

  assert.equal(ledger.round, 3, 'a round event with no reason still moves the counter')
  assert.equal(ledger.skippedLines, 0, 'and is not rejected by the parser')
  assert.deepEqual(
    ledger.roundAdvanceReasons,
    {},
    'an ordinary close-shaped advance leaves no reason behind'
  )
})

// The reason the field is named `reason` and not `advanceReason`: shrinkFreeText's list names
// `reason`, so an oversized explanation is shrunk to fit instead of reaching serialize()'s "cannot
// fit" throw. A command whose only job is unwedging a stuck ledger must not be blockable by the
// length of its own prose, and that property lives entirely in the field's name.
test('an oversized reason is shrunk to fit rather than blocking the advance', () => {
  wedgeRoundOne()
  const oversized = 'x'.repeat(9000)

  captureStdout(() => runRoundAdvance(ticket, oversized))

  assert.equal(getRequestedExitCode(), 0, 'the advance landed despite a reason no line can hold')
  assert.equal(readLedger(ticket).round, 2, 'the counter moved, which is the whole point')
  const roundLine = rawLedgerContent(ticket)
    .split('\n')
    .find((l) => l.includes('"kind":"round",'))
  assert.notEqual(roundLine, undefined, 'the round event reached the log')
  // 4096 pinned here rather than imported: a test that reads the bound from the same constant the
  // writer uses would pass however that constant moved.
  assert.ok(
    Buffer.byteLength(roundLine as string, 'utf-8') <= 4096,
    `the line was shrunk under the ledger's line bound, got ${Buffer.byteLength(roundLine as string, 'utf-8')}`
  )
  // The marker is the whole difference between a disclosed shrink and silent loss. The fold cannot
  // carry it — roundAdvanceReasons holds bare strings — so the JSONL is the only place it survives,
  // and nothing else in the suite would notice if serialize stopped stamping it.
  assert.match(
    roundLine as string,
    /"truncated":true/,
    'the shrink is disclosed on the line itself, the only record that it happened'
  )
  const stored = readLedger(ticket).roundAdvanceReasons['1']
  assert.notEqual(stored, undefined, 'a shrunk reason still folds — it is cut, not dropped')
  assert.equal(
    stored,
    oversized.slice(0, (stored as string).length),
    'and what survives is a prefix of what was passed, since shrinking cuts from the end'
  )
})

// Through the CLI a second advance past the same round exits 25, so this branch is reachable only by
// appending both events directly. The freeze is what the concurrency argument in runRoundAdvance's
// header rests on: two racing advances collide harmlessly because the second cannot rewrite the
// first's explanation.
test('a second round event past the same round cannot rewrite why the first one advanced', () => {
  wedgeRoundOne()

  appendEvent(ticket, {
    kind: 'round',
    at: '2026-09-06T14:00:00.000Z',
    round: 2,
    reason: 'first advance, the one that actually unwedged it',
  })
  appendEvent(ticket, {
    kind: 'round',
    at: '2026-09-06T15:00:00.000Z',
    round: 2,
    reason: 'second advance, arriving later with a different story',
  })

  assert.equal(
    readLedger(ticket).roundAdvanceReasons['1'],
    'first advance, the one that actually unwedged it',
    'the first reason recorded for a round is frozen, the same rule stanceReasons follows'
  )
})

// The version-skew claim §6 of the round-model design leans on, made a measurement rather than an
// inference from the parser's shape: adding `reason` to this event kind cannot make a reader raise
// skippedLines on a line it does not fully recognise. The unknown-key line stands in for what an
// installed reader older than `reason` sees when it reads a line this branch writes — it takes the
// three fields it knows and drops the rest, which is the same code path either way.
test('a three field round line and one carrying an unknown key both fold without raising skippedLines', () => {
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({ kind: 'round', at: '2026-09-06T13:00:00.000Z', round: 2 })
  )
  appendLine(
    rawLedgerPath(ticket),
    JSON.stringify({
      kind: 'round',
      at: '2026-09-06T14:00:00.000Z',
      round: 3,
      aKeyThisParserDoesNotKnow: 'from a writer newer than this reader',
    })
  )

  const ledger = readLedger(ticket)

  assert.equal(ledger.skippedLines, 0, 'neither line was rejected')
  assert.equal(ledger.round, 3, 'both advanced the counter, the later one last')
  assert.deepEqual(ledger.roundAdvanceReasons, {}, 'and neither carried a reason to fold')
})

// The tests above call runRoundAdvance directly, which reaches neither the route map nor process
// exit: setRequestedExitCode is in-process state, and a command missing from reviewLedgerRoutes
// would leave every one of them green. This runs the real binary for both.
test('round advance is reachable through the real CLI and its refusal becomes the process exit code', async () => {
  wedgeRoundOne()

  const advanced = await runCli([
    'review-ledger',
    'round-advance',
    '--ticket',
    ticket,
    '--reason',
    'closed under the old round-close',
  ])

  assert.equal(advanced.exitCode, 0, 'the route is registered and the advance succeeded')
  const result = JSON.parse(advanced.stdout) as { round: number; advancedFrom: number }
  assert.equal(result.round, 2, 'the process reported the round it advanced to')
  assert.equal(result.advancedFrom, 1, 'and the wedged round it advanced past')

  const refused = await runCli([
    'review-ledger',
    'round-advance',
    '--ticket',
    ticket,
    '--reason',
    'a second call against an unclosed round',
  ])

  assert.equal(refused.exitCode, 25, 'exit 25 reaches the process, not just the in-process holder')
  assert.equal(
    readLedger(ticket).roundAdvanceReasons['1'],
    'closed under the old round-close',
    'the first call folded its reason and the refused second one added nothing'
  )
})

test("senior shutdown refuses an agent id matching none of the round's recorded spawns", () => {
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'agent-a'))

  const output = captureStdout(() => runRecordSeniorShutdown(ticket, 1, 'agent-b'))

  assert.equal(getRequestedExitCode(), 18, 'an unmatched agent id refuses at exit 18')
  const result = JSON.parse(output) as { recordedAgentIds: string[]; givenAgentId: string }
  assert.deepEqual(
    result.recordedAgentIds,
    ['agent-a'],
    'the refusal names the ids actually on record'
  )
  assert.equal(result.givenAgentId, 'agent-b', 'and the id that was offered against it')
  assert.equal(
    readLedger(ticket).seniors['1']?.[0]?.shutdownAt,
    null,
    'the refused call appended nothing — the round is still unaccounted'
  )
})

test('senior shutdown with no spawn on record is accepted', () => {
  const output = captureStdout(() =>
    runRecordSeniorShutdown(ticket, 1, 'agent-whose-spawn-was-lost')
  )

  assert.equal(getRequestedExitCode(), 0, 'an absent spawn record is not itself a refusal')
  assert.equal((JSON.parse(output) as { recorded: string }).recorded, 'shutdown')
  const seniors = readLedger(ticket).seniors['1']
  assert.equal(seniors?.length, 1, 'the shutdown created exactly one entry')
  assert.equal(
    seniors?.[0]?.agentId,
    'agent-whose-spawn-was-lost',
    'the shutdown supplies the agent id the missing spawn would have'
  )
  assert.match(
    String(seniors?.[0]?.shutdownAt),
    /^\d{4}-\d{2}-\d{2}T/,
    'shutdownAt carries a real ISO timestamp, so the round reads as accounted'
  )
})

test('senior shutdown refuses a round ahead of the ledger, which would otherwise close as reviewed', () => {
  // The defect this guard closes, end to end rather than at the exit code alone. Round 2 does not
  // exist yet, so no senior can have been spawned for it and its senior list is necessarily empty —
  // which means the shutdown takes exit 18's no-spawns-on-record carve-out and lands. The entry it
  // folds into carries a shutdownAt, so it satisfies checkRoundReviewed while never looking
  // outstanding, and round 2 then closes as reviewed with neither exit 20 nor exit 17 firing. The
  // assertions below are on that consequence, not only on the refusal: an exit-code-only test would
  // stay green if the guard fired for some unrelated reason.
  const out = captureStdout(() =>
    runRecordSeniorShutdown(ticket, 2, 'sen-for-a-round-that-is-not-open')
  )

  assert.equal(getRequestedExitCode(), 22, 'a shutdown ahead of the ledger is refused')
  const refusal = JSON.parse(out) as { error: string; round: number; ledgerRound: number }
  assert.equal(refusal.round, 2)
  assert.equal(refusal.ledgerRound, 1, 'and it names the round the ledger is actually on')
  assert.match(refusal.error, /ahead of the ledger's current round/)
  assert.equal(
    readLedger(ticket).seniors['2'],
    undefined,
    'no phantom senior entry was created for the round that does not exist'
  )

  // The consequence the guard exists to prevent: with no senior invented for round 2, round 2 has
  // no review mark, so a close of it is still refused at exit 20 rather than sailing through.
  resetExitCode()
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, 'sha-closing-round-1', 'adversarial'))
  resetExitCode()
  captureStdout(() => runCloseRound(ticket, 'sha-round-2', 'adversarial'))
  assert.equal(
    getRequestedExitCode(),
    20,
    'round 2 still refuses as unreviewed — the refused shutdown left no false review mark behind'
  )
})

test('senior shutdown against an already-closed earlier round is still accepted', () => {
  // Why the predicate is `round > ledger.round` and not `round !== ledger.round`. A teardown can be
  // reported late — after its own round has closed and the ledger has moved on — and that record is
  // real and must land. An equality check would refuse it and lose a genuine shutdown. This is the
  // test that makes the choice of operator observable: it passes under `>` and fails under `!==`.
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-round-1'))
  resetExitCode()
  captureStdout(() => runRecordSeniorShutdown(ticket, 1, 'sen-round-1'))
  resetExitCode()
  captureStdout(() => runNextRound(ticket, 'sha-closing-round-1', 'adversarial'))
  resetExitCode()
  assert.equal(readLedger(ticket).round, 2, 'the ledger has moved past round 1')

  const out = captureStdout(() =>
    runRecordSeniorShutdown(ticket, 1, 'sen-round-1', 'reported late')
  )

  assert.equal(getRequestedExitCode(), 0, 'a late teardown against the closed round is not refused')
  assert.equal((JSON.parse(out) as { recorded: string }).recorded, 'shutdown')
  assert.equal(
    readLedger(ticket).seniors['1']?.[0]?.shutdownReason,
    'reported late',
    'and the late record actually landed on the round it names'
  )
})

test("a replacement senior's own shutdown accounts for it without disturbing the first entry", () => {
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'senior-first'))
  resetExitCode()
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'senior-second'))
  resetExitCode()

  const output = captureStdout(() => runRecordSeniorShutdown(ticket, 1, 'senior-second'))

  assert.equal(getRequestedExitCode(), 0, "the replacement's own shutdown is accepted")
  assert.equal((JSON.parse(output) as { recorded: string }).recorded, 'shutdown')
  const seniors = readLedger(ticket).seniors['1']
  assert.equal(seniors?.length, 2, 'both seniors are still on record')
  assert.equal(seniors?.[0]?.agentId, 'senior-first')
  assert.equal(seniors?.[0]?.shutdownAt, null, "the first senior's own entry is untouched")
  assert.equal(seniors?.[1]?.agentId, 'senior-second')
  assert.notEqual(seniors?.[1]?.shutdownAt, null, 'the replacement now reads as accounted')
})

test('senior spawned then shutdown both exit 0 through the real CLI process', async () => {
  const spawned = await runCli([
    'review-ledger',
    'senior',
    'spawned',
    '--ticket',
    ticket,
    '--round',
    '1',
    '--agent-id',
    'senior-cli-agent',
  ])
  assert.equal(spawned.exitCode, 0, 'senior spawned exits 0 through the real parsing layer')
  assert.deepEqual(JSON.parse(spawned.stdout), {
    ticket,
    round: 1,
    ledgerRound: 1,
    agentId: 'senior-cli-agent',
    recorded: 'spawned',
  })

  const shutdown = await runCli([
    'review-ledger',
    'senior',
    'shutdown',
    '--ticket',
    ticket,
    '--round',
    '1',
    '--agent-id',
    'senior-cli-agent',
  ])
  assert.equal(shutdown.exitCode, 0, 'senior shutdown exits 0 through the real parsing layer')
  assert.deepEqual(JSON.parse(shutdown.stdout), {
    ticket,
    round: 1,
    agentId: 'senior-cli-agent',
    recorded: 'shutdown',
  })

  const senior = readLedger(ticket).seniors['1']?.[0]
  assert.equal(senior?.agentId, 'senior-cli-agent', 'the spawn landed on the ledger')
  assert.match(
    String(senior?.shutdownAt),
    /^\d{4}-\d{2}-\d{2}T/,
    'and the round is accounted for after the full CLI round trip'
  )
})

test("round-close refuses while the round's senior has no recorded shutdown", () => {
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-unaccounted'))
  resetExitCode()

  const out = captureStdout(() => runCloseRound(ticket, 'sha-closing-round-1', 'adversarial'))

  assert.equal(getRequestedExitCode(), 17, 'exit code 17 requested for an unaccounted senior')
  assert.deepEqual(JSON.parse(out), {
    error: 'round 1 has senior(s) with no recorded shutdown: sen-unaccounted',
    round: 1,
    agentIds: ['sen-unaccounted'],
    remedy:
      'shut down every outstanding senior named in agentIds and record each with `review-ledger senior shutdown`, or pass --senior-condition and --senior-reason once to close over all of them deliberately',
  })
  // The refusal has to leave the round genuinely unclosed. An exit code with a 'round-reviewed'
  // already on the log would be a refusal in name only.
  assert.equal(
    readLedger(ticket).reviewedShas['1'],
    undefined,
    'nothing was appended for the round it refused to close'
  )
})

test('round-close proceeds once the shutdown is recorded', () => {
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-accounted'))
  captureStdout(() => runRecordSeniorShutdown(ticket, 1, 'sen-accounted'))
  resetExitCode()

  const out = captureStdout(() => runCloseRound(ticket, 'sha-closing-round-1', 'adversarial'))

  assert.equal(getRequestedExitCode(), 0, 'an accounted senior does not refuse')
  assert.deepEqual(JSON.parse(out), { ticket, round: 2 })
  assert.equal(
    readLedger(ticket).reviewedShas['1'],
    'sha-closing-round-1',
    'the round is closed against the sha it was given'
  )
  assert.equal(
    readLedger(ticket).round,
    2,
    'round-close is a deprecated alias for next-round and advances identically'
  )
})

test('round-close names every outstanding senior when more than one is unaccounted', () => {
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-first-unaccounted'))
  resetExitCode()
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-second-unaccounted'))
  resetExitCode()

  const out = captureStdout(() => runCloseRound(ticket, 'sha-closing-round-1', 'adversarial'))

  assert.equal(getRequestedExitCode(), 17, 'exit code 17 requested for two unaccounted seniors')
  const report = JSON.parse(out) as { error: string; agentIds: string[] }
  assert.deepEqual(
    report.agentIds,
    ['sen-first-unaccounted', 'sen-second-unaccounted'],
    'both outstanding agent ids are named, not just one'
  )
  assert.match(report.error, /sen-first-unaccounted/, 'the error text names the first')
  assert.match(report.error, /sen-second-unaccounted/, 'and the error text names the second too')
  assert.equal(
    readLedger(ticket).reviewedShas['1'],
    undefined,
    'nothing was appended for the round it refused to close'
  )
})

test('one senior shutdown does not clear exit 17 while another senior on the round is outstanding', () => {
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-reported'))
  resetExitCode()
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-still-running'))
  resetExitCode()
  captureStdout(() => runRecordSeniorShutdown(ticket, 1, 'sen-reported'))
  resetExitCode()

  const out = captureStdout(() => runNextRound(ticket, 'sha-closing-round-1', 'adversarial'))

  assert.equal(
    getRequestedExitCode(),
    17,
    'the close still refuses: one senior remains outstanding'
  )
  const report = JSON.parse(out) as { agentIds: string[] }
  assert.deepEqual(
    report.agentIds,
    ['sen-still-running'],
    'only the senior with no recorded shutdown is named — the one already torn down is discharged'
  )
  assert.equal(readLedger(ticket).reviewedShas['1'], undefined, 'and the round was not closed')
})

test('a licensed close discharges every outstanding senior in the round, not just one', () => {
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-first-licensed'))
  resetExitCode()
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-second-licensed'))
  resetExitCode()

  const out = captureStdout(() =>
    runCloseRound(
      ticket,
      'sha-closing-round-1',
      'adversarial',
      undefined,
      undefined,
      'already-gone',
      'both agents unreachable at close time'
    )
  )

  assert.equal(getRequestedExitCode(), 0, 'a licensed close discharges both, not just one')
  assert.deepEqual(JSON.parse(out), { ticket, round: 2 })
  // The raw log, not the fold: one senior-shutdown event per outstanding senior is the actual claim
  // under test, and the fold alone cannot distinguish "one event landed, described one round" from
  // "two events landed, one per senior" — both fold to two accounted entries either way if the fold
  // itself defaulted a shutdown onto every entry in the round.
  const shutdownLines = rawLedgerContent(ticket)
    .split('\n')
    .filter((line) => line.includes('"kind":"senior-shutdown"'))
  assert.equal(
    shutdownLines.length,
    2,
    'one senior-shutdown event was appended per outstanding senior'
  )
  const seniors = readLedger(ticket).seniors['1']
  assert.equal(seniors?.length, 2)
  for (const senior of seniors ?? []) {
    assert.notEqual(senior.shutdownAt, null, `${senior.agentId} reads as accounted`)
    assert.equal(senior.shutdownCondition, 'already-gone', `${senior.agentId} carries the licence`)
    assert.equal(
      senior.shutdownReason,
      'both agents unreachable at close time',
      `${senior.agentId} carries the shared reason`
    )
  }
})

test('a ledger with no senior events closes a round that carries another review mark', () => {
  // The backward-compatibility case: every ledger written before FLOW-323 has no senior events at
  // all, and the senior check must read that as nothing to report rather than as an unaccounted
  // leak. The finding is load-bearing, not scaffolding — it is the mark checkRoundReviewed reads,
  // and without it this close refuses at 20 rather than proving anything about the senior check. It
  // is a finding rather than an instruction because a finding is the only non-senior mark left: an
  // instruction dispatched in the round means the lead typed, which is not evidence anyone reviewed,
  // and checkRoundReviewed stopped accepting it. The round-that-carries-no-mark half is the test
  // below, which is the case that says what a legacy ledger actually does.
  captureStdout(() => runOpenFinding(ticket, 'src/legacy.ts', 'doThing', 'the round-1 review mark'))
  resetExitCode()

  const out = captureStdout(() => runCloseRound(ticket, 'sha-closing-round-1', 'adversarial'))

  assert.equal(getRequestedExitCode(), 0, 'a ledger with no senior events still closes')
  assert.deepEqual(JSON.parse(out), { ticket, round: 2 })
  assert.equal(readLedger(ticket).reviewedShas['1'], 'sha-closing-round-1')
  assert.deepEqual(readLedger(ticket).seniors, {}, 'and no senior record was invented')
})

test('following the exit-20 remedy clears the refusal in one command, not two', () => {
  // The remedy is executable text, so the test executes it rather than matching its wording. What
  // makes this worth a test is that the wrong command also looks like it worked: `senior spawned`
  // returns exit 0 and satisfies checkRoundReviewed, and the failure only surfaces on the retry, as
  // a different exit code with a different remedy. So the assertion is on the retry, and the control
  // is the other command run against the identical setup.
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/round1.ts', 'a\n', 'round 1 commit')
  captureStdout(() =>
    runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'a round-1 finding, so round 1 has a mark')
  )
  resetExitCode()
  captureStdout(() => runNextRound(ticket, round1Sha, 'adversarial', undefined, repo))
  resetExitCode()
  const round2Sha = commitFile(repo, 'src/round2.ts', 'b\n', 'round 2 commit')
  captureStdout(() => runCloseRound(ticket, round2Sha, 'adversarial', undefined, repo))
  assert.equal(getRequestedExitCode(), 20, 'the refusal this remedy answers')
  resetExitCode()

  // The control: the command the remedy used to name gets the caller to a different refusal.
  captureStdout(() => runRecordSeniorSpawned(ticket, 2, 'sen-remedy'))
  resetExitCode()
  captureStdout(() => runCloseRound(ticket, round2Sha, 'adversarial', undefined, repo))
  assert.equal(
    getRequestedExitCode(),
    17,
    '`senior spawned` alone leaves the round owing a teardown'
  )
  resetExitCode()

  captureStdout(() => runRecordSeniorShutdown(ticket, 2, 'sen-remedy'))
  resetExitCode()
  captureStdout(() => runCloseRound(ticket, round2Sha, 'adversarial', undefined, repo))

  assert.equal(getRequestedExitCode(), 0, 'the command the remedy names is the one that closes')
  assert.equal(readLedger(ticket).reviewedShas['2'], round2Sha, 'and the round is actually stamped')
})

test('an instruction dispatched in the round is not a review mark, on a senior-less legacy ledger', () => {
  // The genuinely legacy-shaped case, and the one the test above cannot make: a round on a ledger
  // carrying no senior events anywhere, which is every ledger written before FLOW-323. It refuses,
  // and that is accepted behaviour — loud and recoverable rather than silent.
  //
  // The instruction in round 2 is the sharp half. checkRoundReviewed used to accept it as a third
  // disjunct and this close used to return 0. An instruction means the team lead typed: it is
  // produced by relaying a finding or a ruling, accumulates in the hundreds on an ordinary ticket,
  // and appears in rounds nobody reviewed — so accepting it made the predicate answer "did the lead
  // speak" under a name that promises a review, and returned clean for the exact state exit 20
  // exists to catch. Dispatching one here and still refusing is what pins its removal; a test built
  // on a bare unmarked round passes whether or not the disjunct is there.
  captureStdout(() => runOpenFinding(ticket, 'src/legacy.ts', 'doThing', 'the round-1 review mark'))
  resetExitCode()
  captureStdout(() => runNextRound(ticket, 'sha-closing-round-1', 'adversarial'))
  resetExitCode()
  captureStdout(() => runRecordInstruction(ticket, 'a round-2 instruction, and NOT a review mark'))
  resetExitCode()

  const out = captureStdout(() => runCloseRound(ticket, 'sha-round-2-after-fixes', 'adversarial'))

  assert.equal(getRequestedExitCode(), 20, 'the round is refused despite carrying an instruction')
  // Which check refused is the whole point. 20 and 17 are both reachable on a senior-less ledger,
  // and reading the exit code alone cannot tell "this round has no review" from "this round's
  // senior owes a teardown" — the second would mean the leniency the test above asserts had been
  // lost. The empty seniors map is the second observation that rules it out.
  assert.match(
    (JSON.parse(out) as { error: string }).error,
    /has no recorded review/,
    'refused for having no review mark, not for an unaccounted senior'
  )
  assert.deepEqual(
    readLedger(ticket).seniors,
    {},
    'and the senior check stayed lenient on a ledger with no senior events'
  )
  // The instruction really did land in round 2 — without this the refusal above is equally
  // consistent with the instruction never having been recorded, which would make the test pass while
  // demonstrating nothing about the disjunct.
  assert.equal(
    readLedger(ticket).instructions.filter((i) => i.dispatchedInRound === 2).length,
    1,
    'the instruction the predicate declines to count is on the ledger, in this round'
  )
  assert.equal(readLedger(ticket).reviewedShas['2'], undefined, 'round 2 was not stamped')
})

test('next-round refuses a round with no recorded review, the same as round-close', () => {
  // The bare case behind the "both doors" fix: a fresh round with no senior, no finding, and no
  // instruction. Before the fix this closed and advanced silently — only round-close carried the
  // check, and a lead who only ever runs next-round never reached it.
  const out = captureStdout(() => runNextRound(ticket, 'sha-closing-round-1', 'adversarial'))

  assert.equal(getRequestedExitCode(), 20, 'the round is refused for carrying no review mark')
  const report = JSON.parse(out) as { error: string; remedy: string }
  assert.equal(report.error, 'round 1 has no recorded review: no review mark on it')
  // The remedy used to describe only the round-close-after-next-round case: "a round `next-round`
  // has just created" and "the PREVIOUS round is already closed". Neither sentence is true here —
  // this refusal came from next-round itself, on a round nothing has closed or advanced past yet —
  // so the remedy must not assert either.
  assert.doesNotMatch(
    report.remedy,
    /just created|PREVIOUS round/,
    'the remedy does not describe a round-close-after-next-round scenario that did not happen here'
  )
  // This list is TRANSCRIBED from seniorShutdownCommand's non-optional flags in
  // commands/review-ledger.ts, not read from them — that command is not exported, so nothing here
  // couples to the declarations. It must be updated by hand when the required flags change, or a
  // new required flag makes every emitted remedy un-pasteable while this test stays green.
  for (const flag of ['--ticket', '--round', '--agent-id']) {
    assert.match(
      report.remedy,
      new RegExp(`senior shutdown[^\`]*${flag}`),
      `the remedy offers an invocation naming ${flag}, which seniorShutdownCommand declares non-optional — an invocation pasted from this remedy without it exits 252 on "Expected input for flag ${flag}"`
    )
  }
  // The behaviour this sentence describes is pinned by 'one senior shutdown does not clear exit 17
  // while another senior on the round is outstanding'. Asserting the guidance is present, not merely
  // that the old wording is gone, is what stops a rewrite from dropping it silently.
  assert.match(
    report.remedy,
    /per outstanding agent id/,
    'the remedy states that a shutdown is needed per outstanding agent id, which is the operator-visible consequence of exit 17 clearing only once the last senior is recorded'
  )
  assert.doesNotMatch(
    report.remedy,
    /in one command|the round still owes/,
    'the remedy does not describe the pre-multi-senior model, in which one shutdown cleared exit 17 unconditionally and a round owed a single teardown'
  )
  assert.equal(readLedger(ticket).round, 1, 'the round did not advance past the refusal')
  assert.equal(readLedger(ticket).reviewedShas['1'], undefined, 'nor was it stamped as closed')
})

test('next-round run twice at one sha is refused, naming the round that already carries it', () => {
  // The corruption the reuse guard exists for, in the shape that actually happens: a `next-round`
  // still in the scrollback, re-run after it has already closed the round it names. The second run
  // is well-formed — the round it now lands on has its own review mark — so nothing else refuses it,
  // and it would stamp round 2 with round 1's sha and advance to round 3.
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, 'sha-closing-round-1', 'adversarial'))
  assert.equal(getRequestedExitCode(), 0, 'the first run closes round 1')
  markRoundReviewed()

  const out = captureStdout(() => runNextRound(ticket, 'sha-closing-round-1', 'adversarial'))

  assert.equal(
    getRequestedExitCode(),
    21,
    'the re-run is refused on both doors, not just round-close'
  )
  const report = JSON.parse(out) as { error: string; priorRound: number }
  assert.equal(report.priorRound, 1, 'and it names the round that already carries the sha')
  assert.match(report.error, /already recorded as round 1's reviewed sha/)
  assert.equal(readLedger(ticket).round, 2, 'the round did not advance past the refusal')
  assert.equal(readLedger(ticket).reviewedShas['2'], undefined, 'and round 2 was not stamped')
})

test('rounds that each carry their own sha are untouched by the reuse guard', () => {
  // The guard has to be invisible to every close that is doing the ordinary thing, including on a
  // ledger written before it existed: rounds follow fixes, fixes are commits, so the shas differ.
  // Three rounds across both doors, no licence anywhere, nothing refused.
  const repo = makeRepo()
  const shas: string[] = []
  for (const round of [1, 2] as const) {
    const sha = commitFile(repo, `src/round${round}.ts`, `${round}\n`, `round ${round} commit`)
    shas.push(sha)
    captureStdout(() => runOpenFinding(ticket, 'src/foo.ts', 'doThing', `a round-${round} finding`))
    resetExitCode()
    captureStdout(() => runNextRound(ticket, sha, 'adversarial', undefined, repo))
    assert.equal(getRequestedExitCode(), 0, `round ${round} closes at its own sha`)
    resetExitCode()
  }
  const sha3 = commitFile(repo, 'src/round3.ts', '3\n', 'round 3 commit')
  shas.push(sha3)
  captureStdout(() => runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'a round-3 finding'))
  resetExitCode()

  captureStdout(() => runCloseRound(ticket, sha3, 'adversarial', undefined, repo))

  assert.equal(getRequestedExitCode(), 0, 'and the terminal round closes at its own sha')
  assert.deepEqual(readLedger(ticket).reviewedShas, {
    '1': shas[0],
    '2': shas[1],
    '3': shas[2],
  })
  assert.deepEqual(readLedger(ticket).shaReuseReasons, {}, 'no licence was needed anywhere')
})

test('the licence recovers the by-design false positive and is recorded, not merely honoured', () => {
  // A round whose findings were all ruled invalid produces no commits, so the round re-reviewing it
  // closes at the sha the earlier round already carries. That is legitimate and the guard refuses it
  // anyway — the refusal cannot tell it from the stray re-run above. So the licence has to actually
  // clear it, and clearing it has to leave a trace: an operator reading the ledger later needs to see
  // that round 2's repeated sha was a claim someone made, not a corruption nobody noticed.
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/round1.ts', 'a\n', 'round 1 commit')
  captureStdout(() => runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'a round-1 finding'))
  resetExitCode()
  captureStdout(() => runNextRound(ticket, round1Sha, 'adversarial', undefined, repo))
  resetExitCode()
  captureStdout(() => runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'a round-2 finding'))
  resetExitCode()
  // Re-pinning the same sha produces an empty self-range, so the computed stance is 'cleanup'.
  // Declare 'cleanup' to match — the stance check is not what this test is about.
  captureStdout(() => runCloseRound(ticket, round1Sha, 'cleanup', undefined, repo))
  assert.equal(getRequestedExitCode(), 21, 'the legitimate re-review is refused unlicensed')
  resetExitCode()

  const licence = 'round 1 findings were all ruled invalid, so no commit moved the sha'
  captureStdout(() =>
    runCloseRound(ticket, round1Sha, 'cleanup', undefined, repo, undefined, undefined, licence)
  )

  assert.equal(getRequestedExitCode(), 0, 'the same call with the licence closes')
  const ledger = readLedger(ticket)
  assert.equal(ledger.reviewedShas['2'], round1Sha, 'round 2 is stamped')
  assert.equal(ledger.shaReuseReasons['2'], licence, 'and the licence is on the record')
  // Round 1 closed at the same sha and needed no licence, because nothing preceded it to collide
  // with. Its absence is what makes presence on round 2 mean something.
  assert.equal(ledger.shaReuseReasons['1'], undefined, 'the unlicensed round carries no entry')
})

test('a licensed close records the licence on the ledger', () => {
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-licensed'))
  resetExitCode()

  const out = captureStdout(() =>
    runCloseRound(
      ticket,
      'sha-closing-round-1',
      'adversarial',
      undefined,
      undefined,
      'already-gone',
      'shutdown_request came back: no agent reachable'
    )
  )

  assert.equal(getRequestedExitCode(), 0, 'a licensed close is not refused')
  assert.deepEqual(JSON.parse(out), { ticket, round: 2 })
  // Closing over it is only half the contract. The licence has to survive as a fact on the log —
  // otherwise the exception lives in an argv the shell forgets, which is the silence this fix
  // exists to end.
  const senior = readLedger(ticket).seniors['1']?.[0]
  assert.equal(
    senior?.shutdownReason,
    'shutdown_request came back: no agent reachable',
    'the licence reason is recorded against the round senior'
  )
  assert.equal(senior?.agentId, 'sen-licensed', 'against the agent id the spawn recorded')
  assert.notEqual(senior?.shutdownAt, null, 'and the round reads as accounted afterwards')
})

test('a licensed close records WHICH licence, distinguishably, and not only its reason', () => {
  // The reason alone cannot carry this. serialize() shrinks free text toward its floor, and
  // SHRINK_FLOOR.reason is 0 — a licensed close on an oversized line can reach a reader with the
  // reason gone entirely, at which point the two conditions and an ordinary unlicensed shutdown are
  // the same record. The condition is a fixed-width enum that no shrink pass touches.
  //
  // Asserted against the OTHER member, not merely against undefined: a wiring that hard-codes one
  // condition satisfies any test that only ever passes that one.
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-unreachable'))
  resetExitCode()

  captureStdout(() =>
    runCloseRound(
      ticket,
      'sha-closing-round-1',
      'adversarial',
      undefined,
      undefined,
      'unreachable',
      'the shutdown_request was never acknowledged'
    )
  )

  assert.equal(getRequestedExitCode(), 0, 'a licensed close is not refused')
  const senior = readLedger(ticket).seniors['1']?.[0]
  assert.equal(senior?.shutdownCondition, 'unreachable', 'the condition passed is the one recorded')
  assert.notEqual(
    senior?.shutdownCondition,
    'already-gone',
    'and it is not the other member — the two are distinguishable on the record'
  )
})

test('a shutdown recorded by a real teardown carries no condition', () => {
  // The negative half, and the reason the field is optional rather than defaulted: a licence is a
  // deliberate exception, so a record that claims one where none was claimed is as wrong as a record
  // that drops one that was. Without this, a fold that stamped every shutdown with a condition would
  // pass the test above.
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-torn-down'))
  captureStdout(() => runRecordSeniorShutdown(ticket, 1, 'sen-torn-down'))
  resetExitCode()

  captureStdout(() => runCloseRound(ticket, 'sha-closing-round-1', 'adversarial'))

  assert.equal(getRequestedExitCode(), 0, 'an accounted senior closes without a licence')
  const senior = readLedger(ticket).seniors['1']?.[0]
  assert.equal(senior?.shutdownCondition, undefined, 'and no licence is recorded against it')
  assert.equal(senior?.shutdownReason, undefined, 'nor a licence reason')
})

test('next-round still closes and advances in one call', () => {
  resetExitCode()
  markRoundReviewed()

  const out = captureStdout(() => runNextRound(ticket, 'sha-closing-round-1', 'adversarial'))

  assert.equal(getRequestedExitCode(), 0)
  assert.deepEqual(JSON.parse(out), { ticket, round: 2 })
  assert.equal(
    readLedger(ticket).reviewedShas['1'],
    'sha-closing-round-1',
    'the round it closed is stamped with the reviewed sha'
  )
  assert.equal(readLedger(ticket).round, 2, 'and the counter advanced, exactly as before the split')
})

test('next-round refuses on an unaccounted senior', () => {
  // The guard is on both doors. A lead that never runs round-close must not be able to route around
  // the check by advancing the round instead.
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-both-doors'))
  resetExitCode()

  const out = captureStdout(() => runNextRound(ticket, 'sha-closing-round-1', 'adversarial'))

  assert.equal(getRequestedExitCode(), 17, 'next-round refuses an unaccounted senior too')
  assert.deepEqual(JSON.parse(out).agentIds, ['sen-both-doors'])
  assert.equal(readLedger(ticket).round, 1, 'and the round did not advance past the refusal')
  assert.equal(readLedger(ticket).reviewedShas['1'], undefined, 'nor was it stamped as closed')
})

test('round-close then next-round on the same round refuses the phantom round rather than stamping it', () => {
  // The mirror of the test below, with the deprecated alias making the first call: round-close now
  // advances exactly like next-round, so this ordering lands on the same fresh, unreviewed round the
  // other ordering does — the 19/20 split by which command ran first is gone.
  captureStdout(() =>
    runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'a round-1 finding, so round 1 is reviewed')
  )
  resetExitCode()
  captureStdout(() => runCloseRound(ticket, 'sha-closing-round-1', 'adversarial'))
  assert.equal(getRequestedExitCode(), 0, 'the first close succeeds')
  assert.equal(readLedger(ticket).round, 2, 'round-close advanced to round 2, same as next-round')
  resetExitCode()

  const out = captureStdout(() => runNextRound(ticket, 'sha-round-2-moved-on', 'adversarial'))

  assert.equal(
    getRequestedExitCode(),
    20,
    'the second call lands on the fresh round 2 and refuses as unreviewed, not as already-closed'
  )
  assert.equal(
    (JSON.parse(out) as { error: string }).error,
    'round 2 has no recorded review: no review mark on it'
  )
  assert.equal(readLedger(ticket).reviewedShas['2'], undefined, 'round 2 was not stamped')
})

test('round-close called twice in a row refuses the repeat as unreviewed, not as already closed', () => {
  // Both doors, symmetric with the senior guard: repeating the exact same call is worth pinning
  // whichever command makes it. The repeat lands on round 2, which round-close's own first call just
  // advanced to — freshly created and unreviewed, not the round-1 it actually closed.
  captureStdout(() =>
    runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'a round-1 finding, so round 1 is reviewed')
  )
  resetExitCode()
  captureStdout(() => runCloseRound(ticket, 'sha-closing-round-1', 'adversarial'))
  assert.equal(getRequestedExitCode(), 0, 'the first call closes round 1')
  resetExitCode()

  const secondCall = captureStdout(() =>
    runCloseRound(ticket, 'sha-closing-round-1', 'adversarial')
  )

  assert.equal(getRequestedExitCode(), 20, 'round-close refuses its own second call as unreviewed')
  assert.equal(
    (JSON.parse(secondCall) as { error: string }).error,
    'round 2 has no recorded review: no review mark on it'
  )
  assert.equal(readLedger(ticket).round, 2, 'the refused second call did not advance the round')
})

test('a ledger wedged before close-always-advances refuses a repeat close as already closed', () => {
  // The only ledger shape exit 19 still fires against: reviewed and stamped, but with no 'round'
  // event advancing past it — the shape a ledger closed before the round-model redesign's
  // close-always-advances change was left in. This constructs that shape directly, since no call
  // through the real CLI produces it any more.
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: '2026-09-06T13:00:00.000Z',
    round: 1,
    reviewedSha: 'sha-closing-round-1',
    stance: 'adversarial',
  })
  assert.equal(
    readLedger(ticket).round,
    1,
    'the wedge leaves the round counter on the closed round'
  )

  const out = captureStdout(() => runCloseRound(ticket, 'sha-closing-round-1', 'adversarial'))

  assert.equal(getRequestedExitCode(), 19, 'the wedged round refuses as already closed')
  const refusal = JSON.parse(out) as { error: string; round: number; reviewedSha: string }
  assert.equal(refusal.error, 'round 1 is already closed')
  assert.equal(refusal.round, 1)
  assert.equal(
    refusal.reviewedSha,
    'sha-closing-round-1',
    'and it names the sha the round was closed at, so the caller can see it really did close'
  )
  assert.equal(readLedger(ticket).round, 1, 'the refused call did not advance the wedged round')
})

test('the exit-19 remedy reaching stdout names round-advance', () => {
  // Every other assertion in this file pins `error`. Nothing pinned a `remedy`, and four false
  // claims reached user-facing refusal text before anyone read one. This pins the wiring — that the
  // string carrying the actionable command is the one this refusal actually prints. What no remedy
  // may CLAIM is enforced across the whole module by the allowlist test below, rather than here
  // against one of them.
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: '2026-09-06T13:00:00.000Z',
    round: 1,
    reviewedSha: 'sha-closing-round-1',
    stance: 'adversarial',
  })

  const out = captureStdout(() => runCloseRound(ticket, 'sha-closing-round-1', 'adversarial'))

  assert.equal(getRequestedExitCode(), 19)
  const { remedy } = JSON.parse(out) as { remedy: string }
  assert.match(
    remedy,
    /`review-ledger round-advance --ticket <TICKET-ID> --reason <[^>]+>`/,
    'the remedy must name the command that clears this wedge — exit 19 is unreachable except on a pre-change ledger, and round-advance is the only thing that unwedges one'
  )
})

test('next-round then round-close refuses the phantom round rather than stamping it', () => {
  // The OTHER ordering, and the one that was unrecoverable. next-round closes round 1 and advances
  // to 2; round-close then read round 2 — brand new, no senior, no findings — and stamped it closed
  // with round 1's sha while taking round 2's advance claim forever. Every legitimate close of
  // round 2 afterwards exited 19, and nothing removes a round-reviewed from an append-only log.
  //
  // The sha deliberately MOVES between the two calls. With the same sha the stance check catches
  // this at exit 6 by accident, and a test that leans on that accident passes without the guard.
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/round1.ts', 'a\n', 'round 1 commit')
  captureStdout(() =>
    runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'a round-1 finding, so round 1 is reviewed')
  )
  resetExitCode()
  captureStdout(() => runNextRound(ticket, round1Sha, 'adversarial', undefined, repo))
  assert.equal(readLedger(ticket).round, 2, 'next-round advanced to round 2')
  resetExitCode()

  const round2Sha = commitFile(repo, 'src/round2.ts', 'b\n', 'round 2 commit')
  const out = captureStdout(() => runCloseRound(ticket, round2Sha, 'adversarial', undefined, repo))

  assert.equal(getRequestedExitCode(), 20, 'the unreviewed round is refused, not stamped')
  assert.equal(
    (JSON.parse(out) as { error: string }).error,
    'round 2 has no recorded review: no review mark on it'
  )
  // The whole point: round 2 must still be closable once it is genuinely reviewed.
  assert.equal(readLedger(ticket).reviewedShas['2'], undefined, 'round 2 was not stamped')
  captureStdout(() =>
    runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'a round-2 finding — now it is reviewed')
  )
  resetExitCode()
  captureStdout(() => runCloseRound(ticket, round2Sha, 'adversarial', undefined, repo))
  assert.equal(getRequestedExitCode(), 0, 'and a genuinely reviewed round 2 still closes')
  assert.equal(readLedger(ticket).reviewedShas['2'], round2Sha)
})

test('every close advances the round counter, whichever door made it', () => {
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/round1.ts', 'a\n', 'round 1 commit')
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, round1Sha, 'adversarial', undefined, repo))
  resetExitCode()
  assert.equal(
    readLedger(ticket).round,
    2,
    'closing round 1 through next-round leaves the ledger reading round 2'
  )

  const round2Sha = commitFile(repo, 'src/round2.ts', 'b\n', 'round 2 commit')
  captureStdout(() =>
    runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'a round-2 finding, so round 2 is reviewed')
  )
  resetExitCode()
  captureStdout(() => runCloseRound(ticket, round2Sha, 'adversarial', undefined, repo))
  resetExitCode()
  assert.equal(
    readLedger(ticket).round,
    3,
    'closing round 2 through round-close leaves the ledger reading round 3, same as next-round would'
  )
})

test('round-close produces output identical to next-round for the same close', () => {
  // round-close is a literal alias, not a wrapper — this proves the observable contract matches by
  // running the identical scenario through each door on its own ticket and comparing.
  const ticketA = `${ticket}-next-round`
  const ticketB = `${ticket}-round-close`
  for (const t of [ticketA, ticketB]) {
    captureStdout(() =>
      runOpenFinding(t, 'src/foo.ts', 'doThing', 'a round-1 finding, so round 1 is reviewed')
    )
    resetExitCode()
  }

  const viaNextRound = captureStdout(() =>
    runNextRound(ticketA, 'sha-closing-round-1', 'adversarial')
  )
  assert.equal(getRequestedExitCode(), 0, 'next-round closes cleanly')
  resetExitCode()
  const viaRoundClose = captureStdout(() =>
    runCloseRound(ticketB, 'sha-closing-round-1', 'adversarial')
  )
  assert.equal(getRequestedExitCode(), 0, 'round-close closes cleanly too')

  const normalize = (raw: string, t: string): unknown => {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    assert.equal(parsed.ticket, t, 'each output names its own ticket')
    delete parsed.ticket
    return parsed
  }
  assert.deepEqual(
    normalize(viaRoundClose, ticketB),
    normalize(viaNextRound, ticketA),
    'round-close and next-round produce the identical output shape for the identical close'
  )
  assert.equal(
    readLedger(ticketA).round,
    readLedger(ticketB).round,
    'both doors advanced to the same round number'
  )
})

test('a finding raised in the round is a review mark on its own, with no senior and no instruction', () => {
  // The findings disjunct of checkRoundReviewed is the one every other test reaches past: each of
  // them records a senior or an instruction first, so deleting the findings line leaves the whole
  // suite green. A senior that raised findings and was torn down before anyone recorded its spawn
  // is the case this disjunct exists for, and only a close whose sole mark is a finding pins it.
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/round1.ts', 'a\n', 'round 1 commit')
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, round1Sha, 'adversarial', undefined, repo))
  resetExitCode()
  captureStdout(() => runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'a round-2 finding'))
  resetExitCode()

  const round2Sha = commitFile(repo, 'src/round2.ts', 'b\n', 'round 2 commit')
  captureStdout(() => runCloseRound(ticket, round2Sha, 'adversarial', undefined, repo))

  assert.equal(getRequestedExitCode(), 0, 'the finding alone satisfies the unreviewed-round guard')
  assert.equal(
    readLedger(ticket).reviewedShas['2'],
    round2Sha,
    'round 2 is stamped closed, not refused at exit 20'
  )
})

test('the already-closed refusal is reported before the stance check, not after', () => {
  // Pins the ORDERING. Post-redesign, a real close always advances past the round it closes, so a
  // caller's next call can no longer land on an already-closed round by simply calling twice — the
  // only ledger shape where the already-closed check and the stance check are both simultaneously
  // reachable is one wedged before the round-model redesign's close-always-advances change. This
  // wedges round 2 exactly that way, on a round whose stance would also be refused by
  // checkDeclaredStance, to prove the already-closed check answers first.
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  captureStdout(() =>
    runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'a round-1 finding, so round 1 is reviewed')
  )
  resetExitCode()
  captureStdout(() => runNextRound(ticket, anchorSha, 'adversarial'))
  captureStdout(() =>
    runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'a round-2 finding, so round 2 is reviewed')
  )
  resetExitCode()

  // The control: on round 2, not yet closed, this exact call reaches the stance check and is refused
  // by it. Pinning the anchor sha itself is a self-check over an empty range, so computeStance
  // reports 'cleanup' and the declared 'adversarial' contradicts it. Without this the assertion below
  // would pass on a call that never had an exit 6 to lose in the first place.
  captureStdout(() =>
    runCloseRound(
      ticket,
      anchorSha,
      'adversarial',
      undefined,
      repo,
      undefined,
      undefined,
      stanceFixtureShaReuse
    )
  )
  assert.equal(getRequestedExitCode(), 6, 'the stance check is reachable here and does refuse')
  resetExitCode()
  assert.equal(
    readLedger(ticket).reviewedShas['2'],
    undefined,
    'the refused control appended nothing'
  )

  // Wedge round 2 exactly as a pre-redesign ledger would have been left: reviewed and stamped, with
  // no 'round' event advancing past it.
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: '2026-09-06T14:00:00.000Z',
    round: 2,
    reviewedSha: anchorSha,
    stance: 'adversarial',
  })
  assert.equal(
    readLedger(ticket).round,
    2,
    'the wedge leaves the round counter on the closed round'
  )

  const out = captureStdout(() =>
    runCloseRound(
      ticket,
      anchorSha,
      'adversarial',
      undefined,
      repo,
      undefined,
      undefined,
      stanceFixtureShaReuse
    )
  )

  assert.equal(
    getRequestedExitCode(),
    19,
    'the same call now reports as already-closed, never as the stance disagreement the control proved is waiting'
  )
  assert.equal((JSON.parse(out) as { error: string }).error, 'round 2 is already closed')
})

test('a truncated licence reason is flagged as partial on the round senior', () => {
  // shrinkFreeText halves `reason` to fit MAX_LINE_BYTES and serialize() flags the event. Without
  // the flag carried onto RoundSenior, a halved licence reason reads back as a complete one — and
  // the licence reason is the audit artifact a licensed close exists to produce.
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-truncated'))
  resetExitCode()

  captureStdout(() =>
    runCloseRound(
      ticket,
      'sha-closing-round-1',
      'adversarial',
      undefined,
      undefined,
      'already-gone',
      'x'.repeat(8000)
    )
  )

  assert.equal(getRequestedExitCode(), 0, 'an oversized reason still closes the round')
  const senior = readLedger(ticket).seniors['1']?.[0]
  assert.equal(senior?.truncated, true, 'the round senior reports its reason as partial')
  assert.ok(
    (senior?.shutdownReason?.length ?? 0) < 8000,
    'and the reason really was shortened, so the flag is describing something that happened'
  )
  // The condition is what is left once the shrink pass has taken what it wants. This is the case
  // that decides whether recording it was worth doing: the reason on this record is partial, and
  // without the condition beside it a reader cannot tell which licence was claimed — or, once the
  // reason bottoms out at its zero floor, that one was claimed at all.
  assert.equal(
    senior?.shutdownCondition,
    'already-gone',
    'the condition survives the shrink that truncated the reason'
  )
})

test('--senior-condition rejects the removed no-senior-spawned value at the real parsing layer', async () => {
  // Round 1 needs a review mark or round-close refuses at exit 20 before ever reaching the flag —
  // which would make the positive control fail for a third unrelated reason.
  captureStdout(() =>
    runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'a round-1 finding, so round 1 is reviewed')
  )
  // --reviewed-sha is itself parsed (7-40 lowercase hex), so both invocations below use a real one.
  // With a non-hex placeholder the rejection is the SHA being refused and the senior-condition is
  // never reached — a negative that passes for the wrong reason. The positive control at the end is
  // what makes that difference observable rather than assumed.
  const rejected = await runCli([
    'review-ledger',
    'round-close',
    '--ticket',
    ticket,
    '--reviewed-sha',
    'abc1234',
    '--stance',
    'adversarial',
    '--senior-condition',
    'no-senior-spawned',
    '--senior-reason',
    'should never be accepted',
  ])

  assert.notEqual(
    rejected.exitCode,
    0,
    'the dropped union member is refused by the flag parser, not merely absent from the type'
  )
  const accepted = await runCli([
    'review-ledger',
    'round-close',
    '--ticket',
    ticket,
    '--reviewed-sha',
    'abc1234',
    '--stance',
    'adversarial',
    '--senior-condition',
    'already-gone',
    '--senior-reason',
    'positive control: a surviving member still parses',
  ])
  assert.equal(
    accepted.exitCode,
    0,
    'positive control — the rejection above is the value being refused, not the invocation being malformed'
  )
})

test('every branch-added flag reaches its handler on BOTH doors, not just the door it was tested on', async () => {
  // This branch adds --senior-condition, --senior-reason and --sha-reuse-reason to `next-round` and
  // to `round-close` alike: six cells. The tests above cover three of them — the two senior flags on
  // `round-close`, --sha-reuse-reason on `next-round` — and the other three were relying on the flag
  // objects being shared constants. They are shared, but the wiring is not: each command threads its
  // value into an eight-argument positional call, and a value handed to the wrong position typechecks
  // whenever its neighbour is also an optional string. The flag is then silently dropped, the command
  // exits 0, and only the persisted value shows it.
  //
  // So every assertion here is on what landed on the ledger. Exit 0 is deliberately not the
  // observation: a dropped flag produces exit 0 too on the `next-round` half.
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/round1.ts', 'a\n', 'round 1 commit')
  captureStdout(() => runRecordSeniorSpawned(ticket, 1, 'sen-both-doors'))
  resetExitCode()

  const licensedNextRound = await runCli([
    'review-ledger',
    'next-round',
    '--ticket',
    ticket,
    '--reviewed-sha',
    round1Sha,
    '--stance',
    'adversarial',
    '--repo-root',
    repo,
    '--senior-condition',
    'already-gone',
    '--senior-reason',
    'shutdown_request came back unreachable, on the next-round door',
  ])

  assert.equal(licensedNextRound.exitCode, 0, 'the licensed close is not refused at 17')
  const senior = readLedger(ticket).seniors['1']?.[0]
  assert.equal(senior?.shutdownCondition, 'already-gone', '--senior-condition reached the handler')
  assert.equal(
    senior?.shutdownReason,
    'shutdown_request came back unreachable, on the next-round door',
    '--senior-reason reached the handler as its own argument, not as its neighbour'
  )

  // The other uncovered cell. Round 2 closing at round 1's sha is refused at 21 unless the flag
  // threads, so this door reports a dropped flag through its exit code as well as its ledger — but
  // the assertion on the persisted reason is what distinguishes "the flag arrived" from "the flag
  // arrived as some other argument that happened to be truthy".
  captureStdout(() =>
    runOpenFinding(ticket, 'src/foo.ts', 'doThing', 'a round-2 finding, so round 2 is reviewed')
  )
  resetExitCode()
  const licence = 'round 1 findings were all ruled invalid, on the round-close door'

  // Re-pinning the same sha produces an empty self-range, so the computed stance is 'cleanup'.
  // Declare 'cleanup' to match — the stance check is not what this test is about.
  const licensedRoundClose = await runCli([
    'review-ledger',
    'round-close',
    '--ticket',
    ticket,
    '--reviewed-sha',
    round1Sha,
    '--stance',
    'cleanup',
    '--repo-root',
    repo,
    '--sha-reuse-reason',
    licence,
  ])

  assert.equal(licensedRoundClose.exitCode, 0, 'the licensed re-review is not refused at 21')
  assert.equal(
    readLedger(ticket).shaReuseReasons['2'],
    licence,
    '--sha-reuse-reason reached the handler on the door its own test did not cover'
  )
})

// Task 1: Bound the stance override and close the null-computed hole

test('runNextRound with round 1 and no stance predicate runs free — round 1 is exempt', () => {
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/round1.ts', 'a\n', 'round 1 commit')
  markRoundReviewed()
  const output = captureStdout(() =>
    runNextRound(ticket, round1Sha, 'adversarial', undefined, repo)
  )

  assert.equal(getRequestedExitCode(), 0, 'round 1 close is not refused')
  const parsed = JSON.parse(output) as { round: number }
  assert.equal(parsed.round, 2, 'advanced to round 2')
})

test('runNextRound with round 2, declared adversarial against computed cleanup, and no --scope-change refuses at exit 6', () => {
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/round1.ts', 'a\n', 'round 1 commit')
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, round1Sha, 'adversarial', undefined, repo))
  resetExitCode()

  // Round 2: pin the same sha (self-check over empty range = cleanup), declare adversarial
  // with no --scope-change — should refuse
  markRoundReviewed()
  const output = captureStdout(() =>
    runNextRound(
      ticket,
      round1Sha,
      'adversarial',
      undefined,
      repo,
      undefined,
      undefined,
      stanceFixtureShaReuse
    )
  )

  assert.equal(getRequestedExitCode(), 6, 'exit 6 for unlicensed adversarial-against-cleanup')
  const parsed = JSON.parse(output) as {
    error: string
    declaredStance: string
    computedStance: string
  }
  assert.equal(parsed.declaredStance, 'adversarial')
  assert.equal(parsed.computedStance, 'cleanup')
  assert.ok(
    parsed.error.includes('--scope-change'),
    'refusal names --scope-change as the required flag'
  )
})

test('runNextRound with round 2, declared adversarial against computed cleanup, and --scope-change passes', () => {
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/round1.ts', 'a\n', 'round 1 commit')
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, round1Sha, 'adversarial', undefined, repo))
  resetExitCode()

  // Round 2 with --scope-change: the override is licensed
  markRoundReviewed()
  const output = captureStdout(() =>
    runNextRound(
      ticket,
      round1Sha,
      'adversarial',
      undefined,
      repo,
      undefined,
      undefined,
      stanceFixtureShaReuse,
      'added new auth module'
    )
  )

  assert.equal(getRequestedExitCode(), 0, 'licensed adversarial-against-cleanup is not refused')
  const parsed = JSON.parse(output) as { round: number }
  assert.equal(parsed.round, 3, 'advanced to round 3')
})

test('runNextRound with round 2 and an unresolvable reviewed sha refuses at exit 6 via git-precondition', () => {
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/round1.ts', 'a\n', 'round 1 commit')
  markRoundReviewed()
  captureStdout(() => runNextRound(ticket, round1Sha, 'adversarial', undefined, repo))
  resetExitCode()

  // Round 2 with a well-formed but nonexistent sha — computeStance reaches its git-precondition
  // check and fails there, and the refusal on an unlisted failure code is what closes the
  // null-computed hole.
  const unresolvableSha = '0'.repeat(40)
  markRoundReviewed()
  const output = captureStdout(() =>
    runNextRound(ticket, unresolvableSha, 'cleanup', undefined, repo)
  )

  assert.equal(getRequestedExitCode(), 6, 'exit 6 for stance predicate failure')
  const parsed = JSON.parse(output) as { error: string }
  assert.ok(parsed.error.includes('stance predicate failed'), 'refusal names the predicate failure')
  assert.ok(parsed.error.includes('unresolvable'), 'the failure is the git-precondition kind')
})

// Task 2: Route prose-artifact mismatches to notes, not findings

test('finding open with --prose and a documentation path in the diff routes to a note, exit 0', async () => {
  const repo = makeRepo()
  commitFile(repo, 'README.md', '# readme\n', 'add README.md')

  const result = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'README.md',
    '--symbol',
    'readme',
    '--summary',
    'the readme overstates what the CLI prints',
    '--repo-root',
    repo,
    '--prose',
  ])
  assert.equal(
    result.exitCode,
    0,
    '--prose against a documentation path in the diff routes to a note'
  )
  const parsed = JSON.parse(result.stdout) as { id: string }
  assert.ok(parsed.id.length > 0, 'the output is the note id, as note add prints it')
  const ledger = readLedger(ticket)
  assert.equal(ledger.findings.length, 0, 'no finding was opened')
  const note = ledger.notes.find((n) => n.text.includes('README.md'))
  assert.ok(note !== undefined, 'a note naming the file was recorded')
  assert.equal(note.target, 'pr-body', 'the note target is pr-body')
  assert.ok(
    note.text.includes('the readme overstates what the CLI prints'),
    'the note text carries the summary'
  )
})

test('finding open without --prose and a documentation path in the diff opens a normal finding', async () => {
  const repo = makeRepo()
  commitFile(repo, 'README.md', '# readme\n', 'add README.md')

  const result = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'README.md',
    '--symbol',
    'readme',
    '--summary',
    'the readme makes a false claim about program behavior',
    '--repo-root',
    repo,
  ])
  assert.equal(result.exitCode, 0, 'a false-claim finding against documentation opens normally')
  const { id } = JSON.parse(result.stdout) as { id: string }
  const finding = readLedger(ticket).findings.find((f) => f.id === id)
  assert.equal(finding?.status, 'open', 'the finding was opened, not routed to a note')
  assert.equal(
    readLedger(ticket).notes.length,
    0,
    'no note was recorded for a finding without --prose'
  )
})

test('finding open with --prose and a skills/ path in the diff opens a normal finding — skills/ is code', async () => {
  const repo = makeRepo()
  commitFile(repo, 'skills/code-review/SKILL.md', '# skill\n', 'add skills/code-review/SKILL.md')

  const result = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'skills/code-review/SKILL.md',
    '--symbol',
    'skill',
    '--summary',
    'the skill instructs behavior the CLI does not implement',
    '--repo-root',
    repo,
    '--prose',
  ])
  assert.equal(result.exitCode, 0, 'a skills/ path is code, so --prose does not route it to a note')
  const { id } = JSON.parse(result.stdout) as { id: string }
  const finding = readLedger(ticket).findings.find((f) => f.id === id)
  assert.equal(finding?.status, 'open', 'the finding was opened — skills/ is not documentation')
  assert.equal(readLedger(ticket).notes.length, 0, 'no note was recorded for a skills/ path')
})

test('finding open with --prose and a code path in the diff opens a normal finding — not documentation', async () => {
  const repo = makeRepo()
  commitFile(repo, 'src/index.ts', 'export const x = 1\n', 'add src/index.ts')

  const result = await runCli([
    'review-ledger',
    'finding',
    'open',
    '--ticket',
    ticket,
    '--file',
    'src/index.ts',
    '--symbol',
    'x',
    '--summary',
    'the exported value contradicts the documented contract',
    '--repo-root',
    repo,
    '--prose',
  ])
  assert.equal(result.exitCode, 0, 'a code path is not documentation, so --prose does not route it')
  const { id } = JSON.parse(result.stdout) as { id: string }
  const finding = readLedger(ticket).findings.find((f) => f.id === id)
  assert.equal(finding?.status, 'open', 'the finding was opened — src/ is not documentation')
  assert.equal(readLedger(ticket).notes.length, 0, 'no note was recorded for a code path')
})

// Task 3: Batch instruction dispositions

test('runDisposeInstructionBatch disposes three valid ids in one call, exit 0', () => {
  const id1 = (
    JSON.parse(captureStdout(() => runRecordInstruction(ticket, 'batch item one'))) as {
      id: string
    }
  ).id
  const id2 = (
    JSON.parse(captureStdout(() => runRecordInstruction(ticket, 'batch item two'))) as {
      id: string
    }
  ).id
  const id3 = (
    JSON.parse(captureStdout(() => runRecordInstruction(ticket, 'batch item three'))) as {
      id: string
    }
  ).id

  const output = captureStdout(() =>
    runDisposeInstructionBatch(
      ticket,
      [id1, id2, id3],
      'not-applicable',
      'standing self-check items'
    )
  )

  assert.equal(getRequestedExitCode(), 0, 'batch dispose of valid ids is not refused')
  const parsed = JSON.parse(output) as { ids: string[]; disposition: string; count: number }
  assert.equal(parsed.count, 3, 'the output counts the disposed ids')
  assert.equal(parsed.disposition, 'not-applicable')
  const ledger = readLedger(ticket)
  for (const id of [id1, id2, id3]) {
    const instruction = ledger.instructions.find((i) => i.id === id)
    assert.equal(instruction!.disposition, 'not-applicable', `${id} is disposed`)
    assert.equal(instruction!.reason, 'standing self-check items', `${id} carries the reason`)
  }
})

test('runDisposeInstructionBatch with one invalid id exits 5 and disposes nothing', () => {
  const id1 = (
    JSON.parse(captureStdout(() => runRecordInstruction(ticket, 'batch valid one'))) as {
      id: string
    }
  ).id
  const id2 = (
    JSON.parse(captureStdout(() => runRecordInstruction(ticket, 'batch valid two'))) as {
      id: string
    }
  ).id

  const output = captureStdout(() =>
    runDisposeInstructionBatch(ticket, [id1, 'deadbeefdead', id2], 'acted')
  )

  assert.equal(getRequestedExitCode(), 5, 'exit 5 for a missing id')
  const parsed = JSON.parse(output) as { error: string }
  assert.ok(parsed.error.includes('deadbeefdead'), 'the error names the missing id')
  const ledger = readLedger(ticket)
  for (const id of [id1, id2]) {
    const instruction = ledger.instructions.find((i) => i.id === id)
    assert.equal(
      instruction!.disposition,
      'pending',
      `${id} stays pending — the batch is all-or-nothing`
    )
  }
})

test('runDisposeInstructionBatch with disposition not-acted and no reason exits 6', () => {
  const id1 = (
    JSON.parse(captureStdout(() => runRecordInstruction(ticket, 'batch reasonless one'))) as {
      id: string
    }
  ).id

  const output = captureStdout(() => runDisposeInstructionBatch(ticket, [id1], 'not-acted'))

  assert.equal(getRequestedExitCode(), 6, 'exit 6 for a reasonless non-acted disposition')
  const parsed = JSON.parse(output) as { error: string }
  assert.ok(parsed.error.includes('--reason'), 'the error names --reason')
  const ledger = readLedger(ticket)
  const instruction = ledger.instructions.find((i) => i.id === id1)
  assert.equal(
    instruction!.disposition,
    'pending',
    'disposition is unchanged — the call was refused'
  )
})

// --- An unreadable ledger is not an empty one (FLOW-226) ---
//
// The fixture is a DIRECTORY at the ledger's own path. readFileSync on it fails with EISDIR for
// every uid including root, so this stays a real test under a root runner — a chmod 000 file does
// not, since root reads it anyway and the test silently passes for the wrong reason.
const plantUnreadableLedger = (t: string): string => {
  const path = storePath(ticketScope(t), LEDGER_FILE)
  mkdirSync(dirname(path), { recursive: true })
  mkdirSync(path, { recursive: true })
  assert.throws(
    () => readFileSync(path, 'utf-8'),
    /EISDIR/,
    'precondition: the planted path must actually be unreadable'
  )
  return path
}

test('readLedger throws rather than reporting an unreadable ledger as an empty one', () => {
  const path = plantUnreadableLedger(ticket)
  assert.throws(
    () => readLedger(ticket),
    (error: unknown) =>
      error instanceof StoreUnreadableError &&
      error.code === 'EISDIR' &&
      error.message.includes(path),
    'an unreadable ledger must raise, not fold into the empty-ledger path'
  )
})

// runGuarded catches the StoreUnreadableError and reports it as JSON on stdout, the same contract
// gate-ledger and proof-ledger give; nothing reaches Stricli, so stderr carries no stack trace.
test('review-ledger show on an unreadable ledger exits 26 with JSON naming the file, not exit 0 with an empty ledger', async () => {
  const path = plantUnreadableLedger(ticket)
  const result = await runCli(['review-ledger', 'show', '--ticket', ticket], undefined, [
    '--no-warnings',
  ])
  assert.equal(result.exitCode, 26, 'must not exit 0 — an unreadable ledger is not a clean one')
  assert.deepEqual(JSON.parse(result.stdout), {
    error: `${path} exists but could not be read (EISDIR)`,
    code: 'EISDIR',
  })
  assert.equal(result.stderr, '', 'stderr carries nothing')
})

test(
  'an unexpected throw exits 29 with JSON on stdout, not a stack trace',
  {
    skip: rootCannotBeDeniedAccess
      ? 'requires a non-root uid — root writes through a 0o444 file'
      : false,
  },
  async () => {
    runRecordInstruction(ticket, 'seed the ledger')
    const path = storePath(ticketScope(ticket), LEDGER_FILE)
    chmodSync(path, 0o444)
    try {
      const result = await runCli(
        ['review-ledger', 'instruction', 'record', '--ticket', ticket, '--text', 'append refused'],
        undefined,
        ['--no-warnings']
      )
      assert.equal(result.exitCode, 29)
      assert.deepEqual(JSON.parse(result.stdout), {
        error: `EACCES: permission denied, open '${path}'`,
      })
      assert.equal(result.stderr, '', 'stderr carries nothing')
    } finally {
      chmodSync(path, 0o644)
    }
  }
)

// The case this whole fix exists for: before it, these two produced DIFFERENT answers with the
// dangerous one silent. An absent ledger was loud (exit 8) and an unreadable one exited 0 with a
// well-formed empty ledger, because existsSync returns true for the planted directory and the
// read failure then folded into the same empty result a cold start produces.
test('an unreadable ledger and an absent one are told apart, and the absent one keeps exit 8', async () => {
  const absent = await runCli(['review-ledger', 'show', '--ticket', ticket])
  assert.equal(absent.exitCode, 8, 'an absent ledger keeps its existing answer')

  plantUnreadableLedger(ticket)
  const unreadable = await runCli(['review-ledger', 'show', '--ticket', ticket])
  assert.notEqual(
    unreadable.exitCode,
    absent.exitCode,
    'the two states must not report the same thing'
  )
  assert.equal(unreadable.exitCode, 26)
})

test('a readable ledger reads exactly as before: same events, same round, same fold', async () => {
  runRecordInstruction(ticket, 'first instruction')
  runRecordInstruction(ticket, 'second instruction')

  const ledger = readLedger(ticket)
  assert.equal(ledger.round, 1)
  assert.equal(ledger.instructions.length, 2)
  assert.deepEqual(
    ledger.instructions.map((i) => i.text),
    ['first instruction', 'second instruction']
  )
  assert.equal(ledger.skippedLines, 0)

  const result = await runCli(['review-ledger', 'show', '--ticket', ticket])
  assert.equal(result.exitCode, 0, 'a readable ledger keeps exit 0')
  const parsed = JSON.parse(result.stdout) as { instructions: { text: string }[]; round: number }
  assert.equal(parsed.round, 1)
  assert.deepEqual(
    parsed.instructions.map((i) => i.text),
    ['first instruction', 'second instruction']
  )
})

// The route existsSync answered wrongly, and the reason ledgerFileExists no longer uses it: a
// ledger whose PARENT directory denies traversal. existsSync cannot stat through the parent and
// returns false, so `show`/`round` reported exit 8, "no ledger on disk", about a ledger that is on
// disk — a false statement to the user, not merely a stale comment.

test(
  'a ledger under an unreadable parent directory is not reported as absent',
  {
    skip: rootCannotBeDeniedAccess
      ? 'requires a non-root uid — root traverses a 0o000 directory, so the fixture cannot deny access'
      : false,
  },
  () => {
    const path = storePath(ticketScope(ticket), LEDGER_FILE)
    const parent = dirname(path)
    mkdirSync(parent, { recursive: true })
    writeFileSync(path, '{"kind":"round-opened","at":"2026-01-01T00:00:00.000Z","round":1}\n')
    chmodSync(parent, 0o000)
    try {
      assert.equal(
        existsSync(path),
        false,
        'precondition: existsSync must be fooled here, or this test proves nothing'
      )
      assert.throws(
        () => readFileSync(path, 'utf-8'),
        /EACCES/,
        'precondition: the file must be present but unreadable'
      )

      assert.equal(
        ledgerFileExists(ticket),
        true,
        'a present-but-unreadable ledger must not be reported as absent'
      )
      assert.throws(
        () => readLedger(ticket),
        (error: unknown) => error instanceof StoreUnreadableError && error.code === 'EACCES',
        'and reading it must raise rather than bootstrap an empty ledger'
      )
    } finally {
      chmodSync(parent, 0o700)
    }
  }
)

test('next-round refuses a round whose senior started its review and never completed it', () => {
  captureStdout(() => runRecordReviewStart(ticket, 1, 'aaaaaaa'))
  assert.equal(readLedger(ticket).reviews['1']?.state, 'in-progress')

  const out = captureStdout(() => runNextRound(ticket, 'aaaaaaa', 'adversarial'))
  assert.equal(getRequestedExitCode(), 27)
  assert.equal(
    (JSON.parse(out) as { error: string }).error,
    "round 1's review is not recorded complete"
  )
  resetExitCode()

  captureStdout(() => runRecordReviewComplete(ticket, 1, 'aaaaaaa', 'changes'))
  captureStdout(() => runNextRound(ticket, 'aaaaaaa', 'adversarial'))
  assert.equal(getRequestedExitCode(), 0)
  assert.equal(readLedger(ticket).round, 2)
})

test('a senior gone before recording review complete is closed over with the senior licence and the reason is recorded', () => {
  captureStdout(() => runRecordReviewStart(ticket, 1, 'aaaaaaa'))
  captureStdout(() =>
    runNextRound(
      ticket,
      'aaaaaaa',
      'adversarial',
      undefined,
      undefined,
      'already-gone',
      'crashed mid-review'
    )
  )
  assert.equal(getRequestedExitCode(), 0)
  assert.equal(readLedger(ticket).reviewIncompleteReasons['1'], 'crashed mid-review')
})

test('review start refuses a round whose review already completed because that round was never closed', () => {
  captureStdout(() => runRecordReviewStart(ticket, 1, 'aaaaaaa'))
  captureStdout(() => runRecordReviewComplete(ticket, 1, 'aaaaaaa', 'changes'))
  // The lead skipped next-round, so the next senior is spawned against the same round.
  captureStdout(() => runRecordReviewStart(ticket, 1, 'bbbbbbb'))
  assert.equal(getRequestedExitCode(), 28)
})
