import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  appendGateRun,
  gateLedgerPath,
  readGateLedger,
  runsFor,
  writeGateOutput,
} from './ledger.ts'
import { runRecord, runShow, runCheck, runDeclare } from './run.ts'
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'
import {
  appendLine,
  StoreUnreadableError,
  storePath,
  ticketScope,
} from '../workflow-store/store.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))
// tools/cli/src/gate-ledger -> repo root, four levels up from this file.
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

const DEFAULT_GATES = [
  { name: 'typecheck', command: 'pnpm typecheck', owner: 'implementer' },
  { name: 'lint', command: 'pnpm lint', owner: 'implementer' },
  { name: 'test:workspace', command: 'pnpm -r test', owner: 'implementer' },
  { name: 'test:hooks', command: 'pnpm test:hooks', owner: 'implementer' },
]

let tmpDir: string
let ticket: string
let homeDir: string
let origHome: string | undefined

const resetExitCode = (): void => setRequestedExitCode(0)

// readGateLedger/appendGateRun resolve through the durable store, which is homedir()-relative —
// override HOME so these tests never touch the real ~/.claude/workflow-state.
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gate-ledger-test-'))
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  ticket = `FLOW-TEST-${uniqueId}`
  homeDir = mkdtempSync(join(tmpdir(), 'gate-ledger-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
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

// record/check default to the ticket's declared manifest in the store, so a test that wants a
// specific gate set writes it to a fresh temp file and passes it via --manifest/manifestPath —
// keeping every test independent of whatever a prior test may have declared for its own ticket.
const writeManifestFixture = (gates: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-ledger-test-manifest-'))
  const path = join(dir, 'declared-gates.json')
  writeFileSync(path, JSON.stringify({ gates }))
  return path
}

interface CliResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

/** Run the real CLI as a separate process sharing this test's HOME; captures stdout/stderr/exit code. */
const runCli = (args: string[], cwd?: string): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', mainTsPath, ...args], {
      env: { ...process.env, HOME: homeDir },
      cwd,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }))
  })

test('record on a gate the manifest does not declare exits 5 and appends nothing', () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const output = captureStdout(() =>
    runRecord(
      ticket,
      'bogus-gate',
      'aaa0001',
      0,
      'implementer',
      'ok',
      undefined,
      undefined,
      manifestPath
    )
  )
  assert.equal(getRequestedExitCode(), 5, 'an undeclared gate name refuses with exit 5')
  const parsed = JSON.parse(output) as { error: string; declared: string[] }
  assert.ok(parsed.error.length > 0)
  assert.deepEqual(
    parsed.declared,
    DEFAULT_GATES.map((g) => g.name)
  )
  const ledger = readGateLedger(ticket)
  assert.equal(ledger.runs.length, 0, 'nothing was appended for the refused gate')
})

test('record for the composite "pnpm test" exits 5 while its declared conjuncts each succeed', () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  captureStdout(() =>
    runRecord(
      ticket,
      'pnpm test',
      'aaa0002',
      0,
      'implementer',
      'ok',
      undefined,
      undefined,
      manifestPath
    )
  )
  assert.equal(
    getRequestedExitCode(),
    5,
    '"pnpm test" is not a name the declared manifest declares'
  )

  resetExitCode()
  captureStdout(() =>
    runRecord(
      ticket,
      'test:workspace',
      'aaa0002',
      0,
      'implementer',
      'ok',
      undefined,
      undefined,
      manifestPath
    )
  )
  assert.equal(getRequestedExitCode(), 0, 'the first declared conjunct succeeds')

  resetExitCode()
  captureStdout(() =>
    runRecord(
      ticket,
      'test:hooks',
      'aaa0002',
      0,
      'implementer',
      'ok',
      undefined,
      undefined,
      manifestPath
    )
  )
  assert.equal(getRequestedExitCode(), 0, 'the second declared conjunct succeeds')
})

test('first record for a (gate, sha) by the owning role needs no --condition and exits 0', () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const output = captureStdout(() =>
    runRecord(
      ticket,
      'typecheck',
      'aaa0003',
      0,
      'implementer',
      'clean',
      undefined,
      undefined,
      manifestPath
    )
  )
  assert.equal(getRequestedExitCode(), 0)
  const parsed = JSON.parse(output) as { rerun: boolean }
  assert.equal(parsed.rerun, false)
})

test('second record for the same (gate, sha) with no --condition exits 6 and appends nothing', () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  captureStdout(() =>
    runRecord(
      ticket,
      'typecheck',
      'aaa0004',
      0,
      'implementer',
      'clean',
      undefined,
      undefined,
      manifestPath
    )
  )
  resetExitCode()
  captureStdout(() =>
    runRecord(
      ticket,
      'typecheck',
      'aaa0004',
      0,
      'implementer',
      'clean again',
      undefined,
      undefined,
      manifestPath
    )
  )
  assert.equal(getRequestedExitCode(), 6, 'a bare re-run refuses without a licence')
  const runs = runsFor(readGateLedger(ticket), 'typecheck', 'aaa0004')
  assert.equal(runs.length, 1, 'the refused re-run appended nothing')
})

test('a licensed re-run exits 0, and show returns both runs in append order', () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  captureStdout(() =>
    runRecord(
      ticket,
      'lint',
      'aaa0005',
      0,
      'implementer',
      'first run',
      undefined,
      undefined,
      manifestPath
    )
  )
  resetExitCode()
  captureStdout(() =>
    runRecord(
      ticket,
      'lint',
      'aaa0005',
      1,
      'implementer',
      'second run',
      'contradicted',
      'the diff changed since the first run',
      manifestPath
    )
  )
  assert.equal(getRequestedExitCode(), 0, 'a re-run with --condition and --reason is licensed')

  const showOutput = captureStdout(() => runShow(ticket, 'aaa0005', 'lint'))
  const { runs } = JSON.parse(showOutput) as {
    runs: { exitStatus: number; condition?: string; reason?: string }[]
  }
  assert.equal(runs.length, 2, 'both runs are visible, not just the latest')
  assert.equal(runs[0]!.exitStatus, 0)
  assert.equal(runs[1]!.exitStatus, 1)
  assert.equal(runs[1]!.condition, 'contradicted')
  assert.equal(runs[1]!.reason, 'the diff changed since the first run')
})

test("a non-owning role's first record at a fresh sha with no --condition exits 6", () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  captureStdout(() =>
    runRecord(
      ticket,
      'typecheck',
      'aaa0006',
      0,
      'senior',
      'clean',
      undefined,
      undefined,
      manifestPath
    )
  )
  assert.equal(getRequestedExitCode(), 6, 'senior does not own typecheck')
  const runs = runsFor(readGateLedger(ticket), 'typecheck', 'aaa0006')
  assert.equal(runs.length, 0, 'the refused recording appended nothing')
})

test('check with every declared gate recorded green at the sha exits 0', () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const sha = 'aaa0007'
  for (const gate of DEFAULT_GATES) {
    resetExitCode()
    captureStdout(() =>
      runRecord(ticket, gate.name, sha, 0, 'implementer', 'ok', undefined, undefined, manifestPath)
    )
  }
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, sha, manifestPath))
  assert.equal(getRequestedExitCode(), 0)
  const parsed = JSON.parse(output) as { missing: string[]; failing: string[] }
  assert.deepEqual(parsed.missing, [])
  assert.deepEqual(parsed.failing, [])
})

test('check with one declared gate never recorded exits 3 and names it in missing', () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const sha = 'aaa0008'
  for (const gate of ['typecheck', 'lint', 'test:workspace']) {
    resetExitCode()
    captureStdout(() =>
      runRecord(ticket, gate, sha, 0, 'implementer', 'ok', undefined, undefined, manifestPath)
    )
  }
  // test:hooks is deliberately never recorded at this sha.
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, sha, manifestPath))
  assert.equal(getRequestedExitCode(), 3, 'an unrun declared gate blocks the check')
  const parsed = JSON.parse(output) as { missing: string[]; failing: string[] }
  assert.deepEqual(parsed.missing, ['test:hooks'])
  assert.deepEqual(parsed.failing, [])
})

test('check with a recorded gate whose exitStatus is 1 exits 3 and names it in failing', () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const sha = 'aaa0009'
  for (const gate of ['typecheck', 'test:workspace', 'test:hooks']) {
    resetExitCode()
    captureStdout(() =>
      runRecord(ticket, gate, sha, 0, 'implementer', 'ok', undefined, undefined, manifestPath)
    )
  }
  resetExitCode()
  captureStdout(() =>
    runRecord(
      ticket,
      'lint',
      sha,
      1,
      'implementer',
      'lint found problems',
      undefined,
      undefined,
      manifestPath
    )
  )
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, sha, manifestPath))
  assert.equal(getRequestedExitCode(), 3, 'a failing recorded gate blocks the check')
  const parsed = JSON.parse(output) as { missing: string[]; failing: string[] }
  assert.deepEqual(parsed.failing, ['lint'])
  assert.deepEqual(parsed.missing, [])
})

test('a licensed re-run with a non-zero exit becomes the recorded state — check reports it failing and exits 3', () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const sha = 'aaa0025'
  for (const gate of DEFAULT_GATES) {
    resetExitCode()
    captureStdout(() =>
      runRecord(ticket, gate.name, sha, 0, 'implementer', 'ok', undefined, undefined, manifestPath)
    )
  }
  resetExitCode()
  captureStdout(() =>
    runRecord(
      ticket,
      'typecheck',
      sha,
      2,
      'implementer',
      'a later run against this sha genuinely failed',
      'superseded',
      'a later commit on the same sha range changed the type surface',
      manifestPath
    )
  )
  assert.equal(getRequestedExitCode(), 0, 'a licensed re-run with --condition/--reason is accepted')

  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, sha, manifestPath))
  assert.equal(
    getRequestedExitCode(),
    3,
    'the LATEST record decides state, not the first — a later non-zero run must block the check even though an earlier run at this (gate, sha) was green'
  )
  const parsed = JSON.parse(output) as { missing: string[]; failing: string[] }
  assert.deepEqual(parsed.failing, ['typecheck'])
  assert.deepEqual(parsed.missing, [])
})

test('a record at sha A does not satisfy check at sha B', () => {
  const manifestPath = writeManifestFixture([
    { name: 'solo', command: 'echo ok', owner: 'implementer' },
  ])
  captureStdout(() =>
    runRecord(
      ticket,
      'solo',
      'aaaaaaaa',
      0,
      'implementer',
      'ok',
      undefined,
      undefined,
      manifestPath
    )
  )
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, 'bbbbbbbb', manifestPath))
  assert.equal(getRequestedExitCode(), 3, "a record at a different sha doesn't carry over")
  const parsed = JSON.parse(output) as { missing: string[] }
  assert.deepEqual(parsed.missing, ['solo'])
})

test('check with nothing declared for the ticket exits 8, not 0', () => {
  // No --manifest override here on purpose: this exercises runCheck's real
  // `manifestPathArg ?? manifestPath(ticket)` fallback, which only fires with no override — a
  // fresh ticket in this test's own fresh, empty HOME has never called `declare`.
  const output = captureStdout(() => runCheck(ticket, 'aaa0010'))
  assert.equal(getRequestedExitCode(), 8, 'nothing declared must not report green')
  const parsed = JSON.parse(output) as { error: string }
  assert.equal(parsed.error, 'no gates declared for this ticket')
})

test('record with nothing declared for the ticket exits 8, not 0', () => {
  // No --manifest override here on purpose: this exercises runRecord's real
  // `manifestPathArg ?? manifestPath(ticket)` fallback, which only fires with no override — a
  // fresh ticket in this test's own fresh, empty HOME has never called `declare`. runCheck's
  // identical guard already has coverage above; this is runRecord's.
  const output = captureStdout(() =>
    runRecord(ticket, 'typecheck', 'aaa0011', 0, 'implementer', 'ok')
  )
  assert.equal(getRequestedExitCode(), 8, 'nothing declared must not report green')
  const parsed = JSON.parse(output) as { error: string }
  assert.equal(parsed.error, 'no gates declared for this ticket')
  const ledger = readGateLedger(ticket)
  assert.equal(ledger.runs.length, 0, 'nothing was appended when nothing is declared')
})

test('check with a --manifest override that does not exist exits 8, naming the override path — not the ticket, which has a good declared manifest', () => {
  const fileDir = mkdtempSync(join(tmpdir(), 'gate-ledger-test-declare-'))
  const filePath = join(fileDir, 'input.json')
  writeFileSync(filePath, JSON.stringify({ gates: DEFAULT_GATES }))
  captureStdout(() => runDeclare(ticket, filePath))
  resetExitCode()

  const missingOverride = join(fileDir, 'does-not-exist.json')
  const output = captureStdout(() => runCheck(ticket, 'aaa0032', missingOverride))
  assert.equal(
    getRequestedExitCode(),
    8,
    'a mistyped --manifest must still refuse, not silently fall back to the ticket manifest'
  )
  const parsed = JSON.parse(output) as { error: string }
  assert.equal(
    parsed.error,
    `--manifest ${missingOverride} does not exist`,
    'the message must name the override path, not claim the ticket has no gates declared — it does'
  )
})

test('record with a --manifest override that does not exist exits 8, naming the override path — not the ticket, which has a good declared manifest', () => {
  const fileDir = mkdtempSync(join(tmpdir(), 'gate-ledger-test-declare-'))
  const filePath = join(fileDir, 'input.json')
  writeFileSync(filePath, JSON.stringify({ gates: DEFAULT_GATES }))
  captureStdout(() => runDeclare(ticket, filePath))
  resetExitCode()

  const missingOverride = join(fileDir, 'does-not-exist.json')
  const output = captureStdout(() =>
    runRecord(
      ticket,
      'typecheck',
      'aaa0033',
      0,
      'implementer',
      'ok',
      undefined,
      undefined,
      missingOverride
    )
  )
  assert.equal(
    getRequestedExitCode(),
    8,
    'a mistyped --manifest must still refuse, not silently fall back to the ticket manifest'
  )
  const parsed = JSON.parse(output) as { error: string }
  assert.equal(
    parsed.error,
    `--manifest ${missingOverride} does not exist`,
    'the message must name the override path, not claim the ticket has no gates declared — it does'
  )
  const ledger = readGateLedger(ticket)
  assert.equal(
    ledger.runs.length,
    0,
    'nothing was appended when the override manifest could not be resolved'
  )
})

test('declare writes a valid manifest into the ticket store, and check then resolves it with no --manifest override', () => {
  const fileDir = mkdtempSync(join(tmpdir(), 'gate-ledger-test-declare-'))
  const filePath = join(fileDir, 'input.json')
  writeFileSync(filePath, JSON.stringify({ gates: DEFAULT_GATES }))

  const declareOutput = captureStdout(() => runDeclare(ticket, filePath))
  assert.equal(getRequestedExitCode(), 0)
  const declared = JSON.parse(declareOutput) as { manifest: string; gates: string[] }
  assert.deepEqual(
    declared.gates,
    DEFAULT_GATES.map((g) => g.name)
  )
  // The ticket's own subject: the manifest lands in the ticket-scoped workflow store, never in
  // the repo the gates run against. Pinned independently of manifestPath's own implementation.
  assert.equal(
    declared.manifest,
    join(homeDir, '.claude', 'workflow-state', 'tickets', ticket, 'declared-gates.json')
  )
  assert.ok(
    !declared.manifest.startsWith(repoRoot),
    `manifest must not live under the repo (${repoRoot}), got ${declared.manifest}`
  )

  resetExitCode()
  const checkOutput = captureStdout(() => runCheck(ticket, 'aaa0030'))
  assert.equal(
    getRequestedExitCode(),
    3,
    'no gates recorded yet at this sha, but the manifest resolved'
  )
  const parsed = JSON.parse(checkOutput) as { missing: string[] }
  assert.deepEqual(
    parsed.missing,
    DEFAULT_GATES.map((g) => g.name)
  )
})

test('declare with a --file that fails to parse exits 8 and writes nothing into the store', () => {
  const fileDir = mkdtempSync(join(tmpdir(), 'gate-ledger-test-declare-'))
  const filePath = join(fileDir, 'input.json')
  writeFileSync(filePath, '{not valid json')

  captureStdout(() => runDeclare(ticket, filePath))
  assert.equal(getRequestedExitCode(), 8)

  resetExitCode()
  const checkOutput = captureStdout(() => runCheck(ticket, 'aaa0031'))
  assert.equal(
    getRequestedExitCode(),
    8,
    'the failed declare must not have written a usable manifest'
  )
  const parsed = JSON.parse(checkOutput) as { error: string }
  assert.equal(parsed.error, 'no gates declared for this ticket')
})

test('declare rejects a gate whose owner is senior, and writes nothing into the store', () => {
  const fileDir = mkdtempSync(join(tmpdir(), 'gate-ledger-test-declare-'))
  const filePath = join(fileDir, 'input.json')
  writeFileSync(
    filePath,
    JSON.stringify({ gates: [{ name: 'review', command: 'echo hi', owner: 'senior' }] })
  )

  const declareOutput = captureStdout(() => runDeclare(ticket, filePath))
  assert.equal(getRequestedExitCode(), 8)
  const parsed = JSON.parse(declareOutput) as { error: string; detail?: string }
  assert.equal(
    parsed.detail,
    `${filePath}: gates[0].owner must be implementer or team-lead (never senior — see the comment on DeclaredGateOwner above)`,
    "senior must be rejected by parseManifest's own owner check, citing the type that actually documents it"
  )

  resetExitCode()
  const checkOutput = captureStdout(() =>
    runCheck(ticket, 'aaa0031a00000000000000000000000000000000')
  )
  assert.equal(
    getRequestedExitCode(),
    8,
    'the rejected declare must not have written a usable manifest'
  )
  const checkParsed = JSON.parse(checkOutput) as { error: string }
  assert.equal(checkParsed.error, 'no gates declared for this ticket')
})

test('declare through the real CLI process writes a manifest that record and check then resolve with no --manifest', async () => {
  const fileDir = mkdtempSync(join(tmpdir(), 'gate-ledger-test-declare-'))
  const filePath = join(fileDir, 'input.json')
  writeFileSync(filePath, JSON.stringify({ gates: DEFAULT_GATES }))

  const declareResult = await runCli([
    'gate-ledger',
    'declare',
    '--ticket',
    ticket,
    '--file',
    filePath,
  ])
  assert.equal(declareResult.exitCode, 0)

  const sha = 'aaa0032000000000000000000000000000000000'
  const recordResult = await runCli([
    'gate-ledger',
    'record',
    '--ticket',
    ticket,
    '--gate',
    'typecheck',
    '--sha',
    sha,
    '--exit',
    '0',
    '--role',
    'implementer',
    '--output',
    'ok',
  ])
  assert.equal(
    recordResult.exitCode,
    0,
    'record resolved the declared manifest with no --manifest override'
  )

  const checkResult = await runCli(['gate-ledger', 'check', '--ticket', ticket, '--sha', sha])
  assert.equal(
    checkResult.exitCode,
    3,
    'three of the four declared gates still have no record at this sha'
  )
  const parsed = JSON.parse(checkResult.stdout) as { missing: string[] }
  assert.deepEqual(
    parsed.missing,
    DEFAULT_GATES.filter((g) => g.name !== 'typecheck').map((g) => g.name)
  )
})

test("output larger than TAIL_BYTES lands whole in the sidecar; the event's tail is the last 2000 bytes and truncated is true; outputSha256 matches the sidecar", () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const bigOutput = `${'x'.repeat(5000)}END-OF-OUTPUT`
  const recordOutput = captureStdout(() =>
    runRecord(
      ticket,
      'typecheck',
      'aaa0011',
      0,
      'implementer',
      bigOutput,
      undefined,
      undefined,
      manifestPath
    )
  )
  const { outputPath, outputSha256 } = JSON.parse(recordOutput) as {
    outputPath: string
    outputSha256: string
  }
  const sidecarContent = readFileSync(outputPath, 'utf-8')
  assert.equal(sidecarContent, bigOutput, 'the sidecar holds the FULL output, not just the tail')
  assert.equal(createHash('sha256').update(sidecarContent).digest('hex'), outputSha256)

  const showOutput = captureStdout(() => runShow(ticket, 'aaa0011', 'typecheck'))
  const { runs } = JSON.parse(showOutput) as { runs: { tail: string; truncated?: boolean }[] }
  assert.equal(runs[0]!.tail, bigOutput.slice(-2000))
  assert.equal(runs[0]!.truncated, true)
})

test('a corrupt line in the ledger is counted in skippedLines and does not throw', () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  captureStdout(() =>
    runRecord(
      ticket,
      'typecheck',
      'aaa0012',
      0,
      'implementer',
      'ok',
      undefined,
      undefined,
      manifestPath
    )
  )
  appendLine(gateLedgerPath(ticket), 'not-json-at-all{{{')

  const ledger = readGateLedger(ticket)
  assert.equal(ledger.skippedLines, 1, 'the corrupt line is counted')
  assert.equal(ledger.runs.length, 1, 'the one valid run still folds in')
})

test('writeGateOutput returns the exact gate-output path, derived independently from the store helpers', () => {
  const output = 'a known gate output body'
  const sha256 = createHash('sha256').update(output).digest('hex')
  const expectedPath = storePath(ticketScope(ticket), `gate-output/typecheck-aaa0026-${sha256}.out`)
  const result = writeGateOutput(ticket, 'typecheck', 'aaa0026', output)
  assert.equal(result.outputPath, expectedPath)
})

// The following exercise the CLI's parsing layer directly, as a real subprocess — handler-level
// tests above cover run.ts's own logic, but a change to a flag or entrypoint is only proven by
// invoking the real binary (see review-standards.md).

test('check through the real CLI process, with --manifest, exits 3 and names every gate missing', async () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const result = await runCli([
    'gate-ledger',
    'check',
    '--ticket',
    ticket,
    '--sha',
    'aaa0013000000000000000000000000000000000',
    '--manifest',
    manifestPath,
  ])
  assert.equal(result.exitCode, 3)
  const parsed = JSON.parse(result.stdout) as { missing: string[] }
  assert.deepEqual(
    parsed.missing,
    DEFAULT_GATES.map((g) => g.name)
  )
})

test('record through the real CLI process with neither --output-file nor --output exits 9 with JSON on stdout, not a stack trace', async () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const result = await runCli([
    'gate-ledger',
    'record',
    '--ticket',
    ticket,
    '--gate',
    'typecheck',
    '--sha',
    'aaa0014000000000000000000000000000000000',
    '--exit',
    '0',
    '--role',
    'implementer',
    '--manifest',
    manifestPath,
  ])
  assert.equal(result.exitCode, 9)
  assert.doesNotMatch(result.stderr, /\n\s*at /, 'no uncaught-exception stack trace on stderr')
  const parsed = JSON.parse(result.stdout) as { error: string }
  assert.match(parsed.error, /exactly one of --output-file or --output is required/)
  const ledger = readGateLedger(ticket)
  assert.equal(runsFor(ledger, 'typecheck', 'aaa0014000000000000000000000000000000000').length, 0)
})

test('record through the real CLI process with both --output-file and --output exits 9 with JSON on stdout, not a stack trace', async () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const outputFilePath = join(tmpDir, 'gate-output-both.txt')
  writeFileSync(outputFilePath, 'file output')
  const result = await runCli([
    'gate-ledger',
    'record',
    '--ticket',
    ticket,
    '--gate',
    'typecheck',
    '--sha',
    'aaa0014b00000000000000000000000000000000',
    '--exit',
    '0',
    '--role',
    'implementer',
    '--output-file',
    outputFilePath,
    '--output',
    'inline output',
    '--manifest',
    manifestPath,
  ])
  assert.equal(result.exitCode, 9)
  assert.doesNotMatch(result.stderr, /\n\s*at /, 'no uncaught-exception stack trace on stderr')
  const parsed = JSON.parse(result.stdout) as { error: string }
  assert.match(parsed.error, /--output-file and --output are mutually exclusive/)
  const ledger = readGateLedger(ticket)
  assert.equal(runsFor(ledger, 'typecheck', 'aaa0014b00000000000000000000000000000000').length, 0)
})

test('record through the real CLI process with an unreadable --output-file exits 9 with JSON on stdout, not a stack trace', async () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const result = await runCli([
    'gate-ledger',
    'record',
    '--ticket',
    ticket,
    '--gate',
    'typecheck',
    '--sha',
    'aaa0014c00000000000000000000000000000000',
    '--exit',
    '0',
    '--role',
    'implementer',
    '--output-file',
    join(tmpDir, 'definitely-not-here.txt'),
    '--manifest',
    manifestPath,
  ])
  assert.equal(result.exitCode, 9)
  assert.doesNotMatch(result.stderr, /\n\s*at /, 'no uncaught-exception stack trace on stderr')
  const parsed = JSON.parse(result.stdout) as { error: string }
  assert.match(parsed.error, /ENOENT/)
  const ledger = readGateLedger(ticket)
  assert.equal(runsFor(ledger, 'typecheck', 'aaa0014c00000000000000000000000000000000').length, 0)
})

test('record through the real CLI process rejects an unknown --role at the parsing layer', async () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const result = await runCli([
    'gate-ledger',
    'record',
    '--ticket',
    ticket,
    '--gate',
    'typecheck',
    '--sha',
    'aaa0015',
    '--exit',
    '0',
    '--role',
    'not-a-real-role',
    '--output',
    'ok',
    '--manifest',
    manifestPath,
  ])
  assert.equal(result.exitCode, 252, "Stricli's own parse-failure code")
  assert.equal(
    result.stdout,
    '',
    'a parse-layer rejection never reaches func, so no JSON is printed'
  )
  assert.match(result.stderr, /--role must be implementer, team-lead, or senior/)
})

test('record through the real CLI process rejects a non-numeric --exit at the parsing layer', async () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const result = await runCli([
    'gate-ledger',
    'record',
    '--ticket',
    ticket,
    '--gate',
    'typecheck',
    '--sha',
    'aaa0016',
    '--exit',
    'not-a-number',
    '--role',
    'implementer',
    '--output',
    'ok',
    '--manifest',
    manifestPath,
  ])
  assert.equal(result.exitCode, 252, "Stricli's own parse-failure code")
  assert.equal(
    result.stdout,
    '',
    'a parse-layer rejection never reaches func, so no JSON is printed'
  )
  assert.match(result.stderr, /--exit must be a non-negative integer/)
})

test('record through the real CLI process rejects an unknown --condition at the parsing layer', async () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const result = await runCli([
    'gate-ledger',
    'record',
    '--ticket',
    ticket,
    '--gate',
    'typecheck',
    '--sha',
    'aaa0020',
    '--exit',
    '0',
    '--role',
    'implementer',
    '--output',
    'ok',
    '--condition',
    'not-a-real-condition',
    '--manifest',
    manifestPath,
  ])
  assert.equal(result.exitCode, 252, "Stricli's own parse-failure code")
  assert.equal(
    result.stdout,
    '',
    'a parse-layer rejection never reaches func, so no JSON is printed'
  )
  assert.match(result.stderr, /--condition must be inconsistent, contradicted, or superseded/)
})

test('record through the real CLI process rejects a blank --reason at the parsing layer', async () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const result = await runCli([
    'gate-ledger',
    'record',
    '--ticket',
    ticket,
    '--gate',
    'typecheck',
    '--sha',
    'aaa0021b00000000000000000000000000000000',
    '--exit',
    '0',
    '--role',
    'implementer',
    '--output',
    'ok',
    '--reason',
    '   ',
    '--manifest',
    manifestPath,
  ])
  assert.equal(result.exitCode, 252, "Stricli's own parse-failure code")
  assert.equal(
    result.stdout,
    '',
    'a parse-layer rejection never reaches func, so no JSON is printed'
  )
  assert.match(result.stderr, /--reason must not be blank/)
})

test('record through the real CLI process round-trips --output-file, reading the file rather than the flag text', async () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const outputFilePath = join(tmpDir, 'gate-output.txt')
  writeFileSync(outputFilePath, 'the real gate output, read from disk')
  const result = await runCli([
    'gate-ledger',
    'record',
    '--ticket',
    ticket,
    '--gate',
    'typecheck',
    '--sha',
    'aaa0017000000000000000000000000000000000',
    '--exit',
    '0',
    '--role',
    'implementer',
    '--output-file',
    outputFilePath,
    '--manifest',
    manifestPath,
  ])
  assert.equal(result.exitCode, 0)
  const { outputPath } = JSON.parse(result.stdout) as { outputPath: string }
  assert.equal(readFileSync(outputPath, 'utf-8'), 'the real gate output, read from disk')
})

test('a gate recorded at the full sha is not found by check run against its abbreviation — the abbreviation is rejected at the parsing layer', async () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const fullSha = 'aaa0018000000000000000000000000000000000'
  captureStdout(() =>
    runRecord(
      ticket,
      'typecheck',
      fullSha,
      0,
      'implementer',
      'clean',
      undefined,
      undefined,
      manifestPath
    )
  )
  resetExitCode()
  const result = await runCli([
    'gate-ledger',
    'check',
    '--ticket',
    ticket,
    '--sha',
    'aaa0018',
    '--manifest',
    manifestPath,
  ])
  assert.equal(result.exitCode, 252, "Stricli's own parse-failure code")
  assert.equal(
    result.stdout,
    '',
    'a parse-layer rejection never reaches func, so no JSON is printed'
  )
  assert.match(result.stderr, /--sha must be a full 40-character lowercase hex sha/)
})

test('a gate recorded at an abbreviated sha is not found by runsFor at a differently-spelled full sha', () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  captureStdout(() =>
    runRecord(
      ticket,
      'lint',
      'aaa0019',
      0,
      'implementer',
      'clean',
      undefined,
      undefined,
      manifestPath
    )
  )
  const differentSpelling = 'aaa0019000000000000000000000000000000000'
  const runs = runsFor(readGateLedger(ticket), 'lint', differentSpelling)
  assert.equal(
    runs.length,
    0,
    'runsFor compares by exact equality now, so an abbreviation and a differently-spelled full sha are distinct records'
  )
  const exact = runsFor(readGateLedger(ticket), 'lint', 'aaa0019')
  assert.equal(exact.length, 1, 'the exact sha string still matches itself')
})

test('check through the real CLI process rejects an abbreviated --sha even when a full-sha record exists', async () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const fullSha = 'aaa0020000000000000000000000000000000000'
  const recorded = await runCli([
    'gate-ledger',
    'record',
    '--ticket',
    ticket,
    '--gate',
    'typecheck',
    '--sha',
    fullSha,
    '--exit',
    '0',
    '--role',
    'implementer',
    '--output',
    'ok',
    '--manifest',
    manifestPath,
  ])
  assert.equal(recorded.exitCode, 0, 'test setup: the full-sha record must actually be written')
  const result = await runCli([
    'gate-ledger',
    'check',
    '--ticket',
    ticket,
    '--sha',
    'aaa0020',
    '--manifest',
    manifestPath,
  ])
  assert.equal(result.exitCode, 252, "Stricli's own parse-failure code")
  assert.equal(
    result.stdout,
    '',
    'a parse-layer rejection never reaches func, so no JSON is printed — not even a "missing" verdict'
  )
  assert.match(result.stderr, /--sha must be a full 40-character lowercase hex sha/)
})

test('two licensed re-runs of the same gate at the same sha, through separate real CLI processes, each keep their own output recoverable', async () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const sha = 'aaa0021000000000000000000000000000000000'
  const first = await runCli([
    'gate-ledger',
    'record',
    '--ticket',
    ticket,
    '--gate',
    'typecheck',
    '--sha',
    sha,
    '--exit',
    '1',
    '--role',
    'implementer',
    '--output',
    'FIRST-RUN-OUTPUT',
    '--manifest',
    manifestPath,
  ])
  assert.equal(first.exitCode, 0)
  const second = await runCli([
    'gate-ledger',
    'record',
    '--ticket',
    ticket,
    '--gate',
    'typecheck',
    '--sha',
    sha,
    '--exit',
    '0',
    '--role',
    'implementer',
    '--output',
    'SECOND-RUN-OUTPUT',
    '--condition',
    'contradicted',
    '--reason',
    'fixed and re-ran',
    '--manifest',
    manifestPath,
  ])
  assert.equal(second.exitCode, 0)

  const firstParsed = JSON.parse(first.stdout) as { outputPath: string; outputSha256: string }
  const secondParsed = JSON.parse(second.stdout) as { outputPath: string; outputSha256: string }
  assert.notEqual(
    firstParsed.outputPath,
    secondParsed.outputPath,
    'two different outputs must not share one sidecar file'
  )

  const firstContent = readFileSync(firstParsed.outputPath, 'utf-8')
  const secondContent = readFileSync(secondParsed.outputPath, 'utf-8')
  assert.equal(
    firstContent,
    'FIRST-RUN-OUTPUT',
    "the first run's own output survives the second run"
  )
  assert.equal(secondContent, 'SECOND-RUN-OUTPUT')
  assert.equal(createHash('sha256').update(firstContent).digest('hex'), firstParsed.outputSha256)
  assert.equal(createHash('sha256').update(secondContent).digest('hex'), secondParsed.outputSha256)
})

test('check through the real CLI process exits 8, not 0, when the manifest declares zero gates', async () => {
  const manifestPath = writeManifestFixture([])
  const result = await runCli([
    'gate-ledger',
    'check',
    '--ticket',
    ticket,
    '--sha',
    'aaa0022000000000000000000000000000000000',
    '--manifest',
    manifestPath,
  ])
  assert.equal(result.exitCode, 8, 'an empty gates array must not report every sha green')
  const parsed = JSON.parse(result.stdout) as { error: string; detail?: string }
  assert.ok(parsed.error.length > 0)
  assert.equal(
    'detail' in parsed,
    false,
    'an empty (but validly parsed) gates array has no caught-exception message to carry'
  )
})

test('check through the real CLI process exits 8 with JSON on stdout, not a stack trace, when the manifest is malformed JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-ledger-test-manifest-'))
  const manifestPath = join(dir, 'declared-gates.json')
  const malformedContent = '{not valid json'
  writeFileSync(manifestPath, malformedContent)
  // The exact message parseManifest's JSON.parse throws, under the `<path>: ` prefix parseManifest
  // gives every throw it makes -- pinned independently of run.ts's own code, so the assertion below
  // checks the real caught message reached the payload, not just that SOME non-empty string did.
  let thrownMessage = ''
  try {
    JSON.parse(malformedContent)
  } catch (err) {
    thrownMessage = err instanceof Error ? err.message : String(err)
  }
  assert.ok(thrownMessage.length > 0, 'test setup: JSON.parse must actually throw on this input')
  const expectedDetail = `${manifestPath}: ${thrownMessage}`
  const result = await runCli([
    'gate-ledger',
    'check',
    '--ticket',
    ticket,
    '--sha',
    'aaa0023000000000000000000000000000000000',
    '--manifest',
    manifestPath,
  ])
  assert.equal(result.exitCode, 8, 'a malformed manifest must not crash the process')
  assert.doesNotMatch(
    result.stderr,
    /\n\s*at /,
    'no uncaught-exception stack trace on stderr (the Node experimental-types banner is expected)'
  )
  const parsed = JSON.parse(result.stdout) as { error: string; detail?: string }
  assert.ok(parsed.error.length > 0)
  assert.equal(
    parsed.detail,
    expectedDetail,
    "detail must carry parseManifest's own caught message under the path prefix, not a fixed " +
      'generic string and not a reason naming no file'
  )
})

test('record through the real CLI process exits 8 with JSON on stdout, not a stack trace, when the manifest is malformed JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-ledger-test-manifest-'))
  const manifestPath = join(dir, 'declared-gates.json')
  const malformedContent = '{not valid json'
  writeFileSync(manifestPath, malformedContent)
  let thrownMessage = ''
  try {
    JSON.parse(malformedContent)
  } catch (err) {
    thrownMessage = err instanceof Error ? err.message : String(err)
  }
  assert.ok(thrownMessage.length > 0, 'test setup: JSON.parse must actually throw on this input')
  const expectedDetail = `${manifestPath}: ${thrownMessage}`
  const result = await runCli([
    'gate-ledger',
    'record',
    '--ticket',
    ticket,
    '--gate',
    'typecheck',
    '--sha',
    'aaa0024000000000000000000000000000000000',
    '--exit',
    '0',
    '--role',
    'implementer',
    '--output',
    'ok',
    '--manifest',
    manifestPath,
  ])
  assert.equal(result.exitCode, 8, 'a malformed manifest must not crash record either')
  assert.doesNotMatch(
    result.stderr,
    /\n\s*at /,
    'no uncaught-exception stack trace on stderr (the Node experimental-types banner is expected)'
  )
  const parsed = JSON.parse(result.stdout) as { error: string; detail?: string }
  assert.ok(parsed.error.length > 0)
  assert.equal(
    parsed.detail,
    expectedDetail,
    "detail must carry parseManifest's own caught message under the path prefix, not a fixed " +
      'generic string and not a reason naming no file'
  )
})

test('record through the real CLI process exits 9 with JSON on stdout, not a stack trace, on an unexpected I/O failure writing gate output', async () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  // gate-output must be created as a DIRECTORY under the ticket's store dir (writeGateOutput ->
  // atomicWrite -> ensureDurableDir). Pre-creating it as a plain FILE makes that mkdirSync throw
  // ENOTDIR -- a genuine unexpected I/O failure, not one of runRecord's documented exit paths.
  const ticketDir = dirname(gateLedgerPath(ticket))
  mkdirSync(ticketDir, { recursive: true })
  writeFileSync(join(ticketDir, 'gate-output'), 'not a directory')
  const result = await runCli([
    'gate-ledger',
    'record',
    '--ticket',
    ticket,
    '--gate',
    'typecheck',
    '--sha',
    'aaa0025000000000000000000000000000000000',
    '--exit',
    '0',
    '--role',
    'implementer',
    '--output',
    'ok',
    '--manifest',
    manifestPath,
  ])
  assert.equal(result.exitCode, 9, 'an unexpected I/O failure must not crash the process')
  assert.doesNotMatch(
    result.stderr,
    /\n\s*at /,
    'no uncaught-exception stack trace on stderr (the Node experimental-types banner is expected)'
  )
  const parsed = JSON.parse(result.stdout) as { error: string }
  assert.ok(parsed.error.length > 0)
})

test('appendGateRun shrinks an oversized reason (and tail) so the ledger line stays within the 4096-byte budget, flagging lineTruncated and keeping the END of tail', () => {
  const hugeReason = 'r'.repeat(10_000)
  // A single unique marker at the very end, not a repeating pattern -- a periodic body (e.g.
  // digits 0-9 repeating) would make a front slice and an end slice byte-identical whenever the
  // slice length is a multiple of the period, silently passing a front-slice bug. The marker only
  // survives an end slice.
  const hugeTail = `${'t'.repeat(9_999)}!`
  appendGateRun(ticket, {
    kind: 'gate-run',
    at: new Date().toISOString(),
    gate: 'typecheck',
    sha: 'aaa0024',
    exitStatus: 6,
    role: 'implementer',
    outputPath: '/tmp/does-not-matter.out',
    outputSha256: 'a'.repeat(64),
    outputBytes: 10_000,
    tail: hugeTail,
    condition: 'contradicted',
    reason: hugeReason,
  })

  const raw = readFileSync(gateLedgerPath(ticket), 'utf-8')
  const line = raw.trim().split('\n').pop()!
  assert.ok(
    Buffer.byteLength(line, 'utf-8') <= 4096,
    `line must fit the 4096-byte budget, was ${Buffer.byteLength(line, 'utf-8')} bytes`
  )

  const ledger = readGateLedger(ticket)
  const event = ledger.runs[ledger.runs.length - 1]!
  assert.equal(event.lineTruncated, true, 'an event shrunk to fit must flag lineTruncated')
  assert.equal(event.truncated, undefined, 'a line-fit shrink is not writeGateOutput truncation')
  assert.ok(
    event.reason!.length < hugeReason.length || event.tail.length < hugeTail.length,
    'at least one free-text field must actually have shrunk'
  )
  assert.notEqual(event.tail.length, hugeTail.length, 'tail must actually have been shrunk')
  assert.ok(
    hugeTail.endsWith(event.tail),
    'a shrunk tail must keep the END of the original tail (where a failure message lives, marked here by the trailing "!"), not the front'
  )
})

// --- An unreadable gate ledger is not an empty one (FLOW-226) ---
//
// A DIRECTORY at the ledger path: readFileSync fails with EISDIR for every uid including root, so
// this is not vacuous under a root test runner the way a chmod 000 file would be.
const plantUnreadableGateLedger = (t: string): string => {
  const path = gateLedgerPath(t)
  mkdirSync(dirname(path), { recursive: true })
  mkdirSync(path, { recursive: true })
  assert.throws(
    () => readFileSync(path, 'utf-8'),
    /EISDIR/,
    'precondition: the planted path must actually be unreadable'
  )
  return path
}

// --- An unreadable declared-gates manifest is not an absent one (FLOW-226) ---
//
// The manifest had its own existsSync presence check, separate from the read that follows it, so a
// manifest present but unreadable answered "no gates declared for this ticket" at exit 8 — the same
// answer a ticket nobody has declared gates for gives.
const manifestStorePath = (t: string): string => storePath(ticketScope(t), 'declared-gates.json')

const plantUnreadableManifest = (t: string): string => {
  const path = manifestStorePath(t)
  mkdirSync(dirname(path), { recursive: true })
  mkdirSync(path, { recursive: true })
  assert.throws(
    () => readFileSync(path, 'utf-8'),
    /EISDIR/,
    'precondition: the planted manifest path must actually be unreadable'
  )
  return path
}

test('gate-ledger check separates an unreadable manifest (26) from a ticket with none declared (8)', async () => {
  const absent = await runCli(['gate-ledger', 'check', '--ticket', ticket, '--sha', 'a'.repeat(40)])
  assert.equal(absent.exitCode, 8, 'a ticket with no manifest keeps its existing answer')
  assert.equal(
    JSON.parse(absent.stdout).error,
    'no gates declared for this ticket',
    'and keeps its existing message'
  )

  const path = plantUnreadableManifest(ticket)
  const unreadable = await runCli([
    'gate-ledger',
    'check',
    '--ticket',
    ticket,
    '--sha',
    'a'.repeat(40),
  ])
  assert.notEqual(
    unreadable.exitCode,
    absent.exitCode,
    'the two states must not report the same thing — they prescribe opposite responses'
  )
  assert.equal(unreadable.exitCode, 26)
  // gate-ledger reports through its own runGuarded, so the report is JSON on stdout.
  const reported = JSON.parse(unreadable.stdout) as { error: string; code: string }
  assert.equal(reported.code, 'EISDIR')
  assert.equal(reported.error.includes(path), true, 'the report must name the manifest')
})

// The destructive half, and the reason 8 and 26 have to be different codes rather than merely
// different messages. Exit 8 tells an operator to declare the gates; on a manifest that exists and
// cannot be read, declaring used to overwrite a real gate set the tool had never read, exit 0,
// reported as success.
//
// This needs a route where the WRITE would otherwise succeed, which the EISDIR fixture above is
// not — a directory at the path fails the write anyway, so it would pass without proving the
// refusal. A symlink to a target inside an unreadable directory is that route: existsSync is
// false, the read fails EACCES, and the ticket directory itself stays writable. Root traverses a
// 0o000 directory regardless, so under a root runner this cannot be set up at all.
const rootCannotBeDeniedAccess = process.getuid?.() === 0

test(
  'gate-ledger declare refuses to overwrite a manifest it could not read',
  {
    skip: rootCannotBeDeniedAccess
      ? 'requires a non-root uid — root reads through a 0o000 directory, so the target cannot be made unreadable'
      : false,
  },
  async () => {
    const vault = mkdtempSync(join(tmpdir(), 'gate-manifest-vault-'))
    const realManifest = join(vault, 'real.json')
    writeFileSync(
      realManifest,
      JSON.stringify({
        gates: [{ name: 'ALREADY-DECLARED', command: 'pnpm test', owner: 'implementer' }],
      })
    )
    const linkPath = manifestStorePath(ticket)
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(realManifest, linkPath)
    chmodSync(vault, 0o000)

    let isSymlink: boolean
    let declaredGateName: unknown
    try {
      const replacement = writeManifestFixture([
        { name: 'REPLACEMENT', command: 'echo new', owner: 'implementer' },
      ])
      const result = await runCli([
        'gate-ledger',
        'declare',
        '--ticket',
        ticket,
        '--file',
        replacement,
      ])
      assert.equal(
        result.exitCode,
        26,
        'declaring over an unreadable manifest must refuse, not succeed'
      )
      const reported = JSON.parse(result.stdout) as {
        error: string
        code: string
        gates?: string[]
      }
      assert.equal(reported.code, 'EACCES')
      assert.equal(reported.gates, undefined, 'must not report a successful declaration')
    } finally {
      chmodSync(vault, 0o700)
      // Read back through the link, not at `realManifest`, before vault is removed. atomicWrite
      // renames a temp file over its destination, and a rename onto a symlink replaces the symlink
      // itself rather than writing through it — so the target's bytes survive whether or not the
      // guard fires, and asserting on them proves nothing. What changes is what the manifest path
      // resolves to: still a symlink to the declared gates if the refusal held, a regular file
      // containing REPLACEMENT if it did not.
      isSymlink = lstatSync(linkPath).isSymbolicLink()
      declaredGateName = JSON.parse(readFileSync(linkPath, 'utf-8')).gates[0].name
      rmSync(vault, { recursive: true, force: true })
    }

    assert.equal(
      isSymlink,
      true,
      'a rename that landed would have replaced the link with a regular file'
    )
    assert.equal(
      declaredGateName,
      'ALREADY-DECLARED',
      'reading the manifest must still yield the gate set that was already declared'
    )
  }
)

test('readGateLedger throws rather than reporting an unreadable ledger as zero recorded runs', () => {
  const path = plantUnreadableGateLedger(ticket)
  assert.throws(
    () => readGateLedger(ticket),
    (error: unknown) =>
      error instanceof StoreUnreadableError &&
      error.code === 'EISDIR' &&
      error.message.includes(path),
    'an unreadable gate ledger must raise, not fold into the no-runs path'
  )
})

// The pre-existing runGuarded already caught everything as JSON + exit 9, so this was never silent
// the way review-ledger's was. What it could not do is tell this apart from any other unexpected
// throw — and "no runs recorded" is exactly the answer a caller must not accept from a ledger that
// could not be read.
test('gate-ledger show separates an unreadable ledger (26) from an absent one (0 runs)', async () => {
  const absent = await runCli(['gate-ledger', 'show', '--ticket', ticket])
  assert.equal(absent.exitCode, 0, 'an absent gate ledger keeps its existing empty answer')
  assert.deepEqual((JSON.parse(absent.stdout) as { runs: unknown[] }).runs, [])

  const path = plantUnreadableGateLedger(ticket)
  const unreadable = await runCli(['gate-ledger', 'show', '--ticket', ticket])
  assert.equal(unreadable.exitCode, 26, 'not 0, and not the generic 9 for an unexpected throw')
  const parsed = JSON.parse(unreadable.stdout) as { error?: string; code?: string }
  assert.equal(parsed.code, 'EISDIR')
  assert.equal(parsed.error?.includes(path), true, 'the reason must name the file that failed')
  assert.equal(
    unreadable.stdout.includes('"runs"'),
    false,
    'must not emit a runs list it could not read'
  )
})

test('a readable gate ledger reads exactly as before: same runs, same order', () => {
  appendGateRun(ticket, {
    kind: 'gate-run',
    at: '2026-01-01T00:00:00.000Z',
    gate: 'typecheck',
    sha: 'a'.repeat(40),
    exitStatus: 0,
    role: 'implementer',
    outputPath: '/tmp/x.out',
    outputSha256: 'b'.repeat(64),
    outputBytes: 3,
    tail: 'ok\n',
  })

  const ledger = readGateLedger(ticket)
  assert.equal(ledger.runs.length, 1)
  assert.equal(ledger.runs[0]!.gate, 'typecheck')
  assert.equal(ledger.runs[0]!.exitStatus, 0)
  assert.equal(ledger.skippedLines, 0)
})

// Three commits: `same` is an empty commit on top of `base`, so it is a new sha naming the identical
// tree (what a squash or a rebase onto an unmoved main produces); `changed` alters a file.
const makeTreeFixtureRepo = (): {
  repoRoot: string
  base: string
  baseTree: string
  same: string
  changed: string
} => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'gate-ledger-tree-repo-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(repoRoot, 'file.txt'), 'one\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  const baseTree = git('rev-parse', 'HEAD^{tree}')
  git('commit', '-q', '--allow-empty', '-m', 'same tree')
  const same = git('rev-parse', 'HEAD')
  writeFileSync(join(repoRoot, 'file.txt'), 'two\n')
  git('commit', '-q', '-am', 'changed')
  return { repoRoot, base, baseTree, same, changed: git('rev-parse', 'HEAD') }
}

const recordAllGreen = (manifestPath: string, sha: string, repoRoot: string): void => {
  for (const gate of DEFAULT_GATES) {
    resetExitCode()
    captureStdout(() =>
      runRecord(
        ticket,
        gate.name,
        sha,
        0,
        'implementer',
        'ok',
        undefined,
        undefined,
        manifestPath,
        repoRoot
      )
    )
  }
  resetExitCode()
}

test('check at a new sha naming an identical tree reuses the green runs and names the sha they came from', () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const { repoRoot, base, baseTree, same } = makeTreeFixtureRepo()
  recordAllGreen(manifestPath, base, repoRoot)
  const output = captureStdout(() => runCheck(ticket, same, manifestPath, repoRoot))
  assert.equal(getRequestedExitCode(), 0)
  const parsed = JSON.parse(output) as {
    tree: string | null
    missing: string[]
    gates: { reusedFrom?: string }[]
  }
  assert.equal(parsed.tree, baseTree)
  assert.deepEqual(parsed.missing, [])
  assert.deepEqual(
    parsed.gates.map((g) => g.reusedFrom),
    DEFAULT_GATES.map(() => base)
  )
})

test('record at a new sha naming a tree that already has a run needs a licence and appends nothing', () => {
  const manifestPath = writeManifestFixture([DEFAULT_GATES[0]])
  const { repoRoot, base, baseTree, same } = makeTreeFixtureRepo()
  const first = JSON.parse(
    captureStdout(() =>
      runRecord(
        ticket,
        'typecheck',
        base,
        0,
        'implementer',
        'ok',
        undefined,
        undefined,
        manifestPath,
        repoRoot
      )
    )
  ) as { tree: string | null }
  assert.equal(first.tree, baseTree)
  resetExitCode()
  const refused = JSON.parse(
    captureStdout(() =>
      runRecord(
        ticket,
        'typecheck',
        same,
        0,
        'implementer',
        'ok',
        undefined,
        undefined,
        manifestPath,
        repoRoot
      )
    )
  ) as { error: string; priorRuns: number }
  assert.equal(getRequestedExitCode(), 6)
  assert.equal(refused.priorRuns, 1)
  assert.equal(readGateLedger(ticket).runs.length, 1)
})

const recordRun = (
  manifestPath: string,
  sha: string,
  exitStatus: number,
  repoRoot: string
): void => {
  resetExitCode()
  captureStdout(() =>
    runRecord(
      ticket,
      'typecheck',
      sha,
      exitStatus,
      'implementer',
      'ok',
      undefined,
      undefined,
      manifestPath,
      repoRoot
    )
  )
}

const checkTypecheckAt = (
  manifestPath: string,
  sha: string,
  repoRoot: string
): { failing: string[]; missing: string[] } => {
  resetExitCode()
  return JSON.parse(captureStdout(() => runCheck(ticket, sha, manifestPath, repoRoot))) as {
    failing: string[]
    missing: string[]
  }
}

test('check keeps a sha failing when an unlicensed green is recorded at a same-tree sha', () => {
  const manifestPath = writeManifestFixture([DEFAULT_GATES[0]])
  const { repoRoot, base, same } = makeTreeFixtureRepo()
  const noRepo = mkdtempSync(join(tmpdir(), 'gate-ledger-no-repo-'))

  recordRun(manifestPath, base, 1, noRepo)
  recordRun(manifestPath, same, 0, repoRoot)
  assert.equal(getRequestedExitCode(), 0)
  assert.deepEqual(checkTypecheckAt(manifestPath, base, repoRoot).failing, ['typecheck'])
  assert.equal(getRequestedExitCode(), 3)
})

test('record from a non-repo dir needs a licence when the gate has a run at another sha', () => {
  const manifestPath = writeManifestFixture([DEFAULT_GATES[0]])
  const { repoRoot, base, same } = makeTreeFixtureRepo()
  const noRepo = mkdtempSync(join(tmpdir(), 'gate-ledger-no-repo-'))

  recordRun(manifestPath, base, 1, repoRoot)
  resetExitCode()
  const refused = JSON.parse(
    captureStdout(() =>
      runRecord(
        ticket,
        'typecheck',
        same,
        0,
        'implementer',
        'ok',
        undefined,
        undefined,
        manifestPath,
        noRepo
      )
    )
  ) as { tree: string | null; priorRuns: number }
  assert.equal(getRequestedExitCode(), 6)
  assert.equal(refused.tree, null)
  assert.equal(refused.priorRuns, 1)
  assert.equal(readGateLedger(ticket).runs.length, 1)

  const row = JSON.parse(captureStdout(() => runCheck(ticket, same, manifestPath, repoRoot))) as {
    gates: { state: string; reusedFrom?: string }[]
  }
  assert.equal(row.gates[0]!.state, 'failing')
  assert.equal(row.gates[0]!.reusedFrom, base)
})

test('check at a sha whose tree differs does not reuse runs recorded at another sha', () => {
  const manifestPath = writeManifestFixture(DEFAULT_GATES)
  const { repoRoot, base, changed } = makeTreeFixtureRepo()
  recordAllGreen(manifestPath, base, repoRoot)
  const output = captureStdout(() => runCheck(ticket, changed, manifestPath, repoRoot))
  assert.equal(getRequestedExitCode(), 3)
  const parsed = JSON.parse(output) as { missing: string[] }
  assert.deepEqual(
    parsed.missing,
    DEFAULT_GATES.map((g) => g.name)
  )
})

test('check reports a green run whose output sidecar was altered after recording as invalid and exits 3', () => {
  const manifestPath = writeManifestFixture([DEFAULT_GATES[0]])
  const sha = 'aaa0308'
  const noRepo = mkdtempSync(join(tmpdir(), 'gate-ledger-no-repo-'))
  const recorded = JSON.parse(
    captureStdout(() =>
      runRecord(
        ticket,
        'typecheck',
        sha,
        0,
        'implementer',
        'ok',
        undefined,
        undefined,
        manifestPath,
        noRepo
      )
    )
  ) as { outputPath: string }
  writeFileSync(recorded.outputPath, 'swapped')
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, sha, manifestPath, noRepo))
  assert.equal(getRequestedExitCode(), 3)
  const parsed = JSON.parse(output) as {
    tree: string | null
    invalid: string[]
    gates: { state: string; invalidReason?: string }[]
  }
  assert.deepEqual(parsed.invalid, ['typecheck'])
  assert.equal(parsed.tree, null)
  assert.equal(parsed.gates[0]!.state, 'invalid')
  assert.equal(
    parsed.gates[0]!.invalidReason,
    'output sidecar content no longer matches its recorded digest'
  )
})

test("check carries a licensed re-run's condition and reason on the gate row", () => {
  const manifestPath = writeManifestFixture([DEFAULT_GATES[0]])
  const sha = 'aaa0309'
  captureStdout(() =>
    runRecord(
      ticket,
      'typecheck',
      sha,
      1,
      'implementer',
      'flaky',
      undefined,
      undefined,
      manifestPath
    )
  )
  resetExitCode()
  captureStdout(() =>
    runRecord(
      ticket,
      'typecheck',
      sha,
      0,
      'implementer',
      'ok',
      'contradicted',
      'timing flake',
      manifestPath
    )
  )
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, sha, manifestPath))
  assert.equal(getRequestedExitCode(), 0)
  const parsed = JSON.parse(output) as { gates: { condition?: string; reason?: string }[] }
  assert.equal(parsed.gates[0]!.condition, 'contradicted')
  assert.equal(parsed.gates[0]!.reason, 'timing flake')
})
