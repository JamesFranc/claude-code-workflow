import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  proofLedgerPath,
  appendProofCapture,
  captureId,
  writeProofOutput,
  writeMutationDiff,
} from './ledger.ts'
import { runRecord, runCheck, runShow, NO_REPO_ROOT_CHECK } from './run.ts'
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'
import { appendLine } from '../workflow-store/store.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

let ticket: string
let homeDir: string
let origHome: string | undefined

const resetExitCode = (): void => setRequestedExitCode(0)

// runRecord/runCheck resolve through the durable store, which is homedir()-relative — override
// HOME so these tests never touch the real ~/.claude/workflow-state (mirrors
// gate-ledger/ledger.test.ts's isolation scheme).
beforeEach(() => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'proof-ledger-run-test-'))
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  ticket = `FLOW-TEST-${uniqueId}`
  homeDir = mkdtempSync(join(tmpdir(), 'proof-ledger-run-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
  resetExitCode()
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  try {
    rmSync(homeDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

interface CliResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

/** Run the real CLI as a separate process sharing this test's HOME; captures stdout/stderr/exit code. */
const runCli = (args: string[], opts: { cwd?: string } = {}): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', mainTsPath, ...args], {
      env: { ...process.env, HOME: homeDir },
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
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

/**
 * A throwaway, freshly-committed (clean) git repo — for `runCli`'s `cwd` when a test's `record` call
 * has nothing to do with `--repo-root`'s dirty-tree gate. Without this, these calls default
 * --repo-root to this checkout's own cwd, which is not guaranteed clean during active development.
 * Returns the repo's own HEAD sha alongside its path: a non-red `record` now refuses any --sha other
 * than the commit actually checked out (door 28), so a caller exercising something else must
 * still pass this sha, not a placeholder unrelated to the repo it built.
 */
const makeCleanScratchRepo = (): { repoRoot: string; headSha: string } => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'proof-ledger-run-cli-clean-repo-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'trunk')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(repoRoot, 'placeholder.txt'), 'placeholder\n')
  git('add', 'placeholder.txt')
  git('commit', '-q', '-m', 'baseline')
  return { repoRoot, headSha: git('rev-parse', 'HEAD') }
}

// A repo whose origin/main is one commit behind HEAD, with the changed file placed so its package
// dir is either a sub-package (holding its own package.json) or the root.
const makeScopeFixtureRepo = (
  changedPath: string,
  manifestDirs: readonly string[]
): { repoRoot: string; headSha: string } => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'proof-ledger-scope-repo-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  for (const dir of manifestDirs) {
    mkdirSync(join(repoRoot, dir), { recursive: true })
    writeFileSync(join(repoRoot, dir, 'package.json'), '{}\n')
  }
  writeFileSync(join(repoRoot, 'placeholder.txt'), 'placeholder\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'baseline')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  mkdirSync(dirname(join(repoRoot, changedPath)), { recursive: true })
  writeFileSync(join(repoRoot, changedPath), 'changed\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'change')
  return { repoRoot, headSha: git('rev-parse', 'HEAD') }
}

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

test('record --capture red without --mutation-file exits 6 and writes nothing to the ledger', () => {
  const output = captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'red', 'aaa0001', 'pnpm test', 1, 'it failed')
  )
  assert.equal(getRequestedExitCode(), 6, 'a red capture with no mutation diff must refuse')
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /--mutation-file/)
  assert.equal(
    existsSync(proofLedgerPath(ticket)),
    false,
    'the refused record must not create the ledger file at all'
  )
})

test('record --capture red WITH --mutation-file writes both sidecars and carries the exact mutationSha256', () => {
  const mutationDiff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n'
  const expectedMutationSha256 = createHash('sha256').update(mutationDiff).digest('hex')

  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0002',
      'pnpm test',
      1,
      'it failed',
      mutationDiff
    )
  )
  assert.equal(getRequestedExitCode(), 0)
  const parsed = JSON.parse(output) as {
    outputPath: string
    mutationPath: string
    mutationSha256: string
  }
  assert.equal(
    parsed.mutationSha256,
    expectedMutationSha256,
    'mutationSha256 must equal the sha256 of the diff content, computed independently'
  )
  assert.equal(readFileSync(parsed.outputPath, 'utf-8'), 'it failed', 'the command output sidecar')
  assert.equal(
    readFileSync(parsed.mutationPath, 'utf-8'),
    mutationDiff,
    'the mutation diff sidecar'
  )
})

test('record --capture sweep WITH --mutation-file exits 6 and writes nothing to the ledger', () => {
  const mutationDiff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n'
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'sweep',
      'aaa0002b',
      'grep -rn x .',
      1,
      'no hits',
      mutationDiff
    )
  )
  assert.equal(
    getRequestedExitCode(),
    6,
    '--mutation-file is a red-only concept; a non-red capture must not silently accept it'
  )
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /--mutation-file/)
  assert.match(parsed.error, /red/)
  assert.equal(
    existsSync(proofLedgerPath(ticket)),
    false,
    'the refused record must not create the ledger file at all'
  )
})

test('check exits 3 and names the missing kind when only sweep was recorded and sweep,evidence is required', () => {
  captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'sweep', 'aaa0003', 'grep -rn x .', 0, 'hit: x')
  )
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, 'aaa0003', 'task-1', ['sweep', 'evidence']))
  assert.equal(getRequestedExitCode(), 3)
  const parsed = JSON.parse(output) as { missing: string[]; failing: string[] }
  assert.deepEqual(parsed.missing, ['evidence'])
  assert.deepEqual(parsed.failing, [])
})

test('check reports a red capture with exitStatus 0 as failing — a mutation that never turned red proves nothing (legacy ledger-bypass path: record now refuses this at the source, D1)', () => {
  const mutationDiff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n'
  appendExitZeroRedCapture('task-1', 'aaa0004', mutationDiff)
  captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'green', 'aaa0004', 'pnpm test', 0, 'it passed')
  )
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, 'aaa0004', 'task-1', ['red']))
  assert.equal(getRequestedExitCode(), 3, 'a red capture that never went red must block the check')
  const parsed = JSON.parse(output) as { failing: string[]; missing: string[] }
  assert.deepEqual(parsed.failing, ['red'])
  assert.deepEqual(parsed.missing, [])
})

test('check reports a red capture with non-zero exitStatus as ok, not failing', () => {
  const mutationDiff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n'
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0005',
      'pnpm test',
      1,
      'it failed',
      mutationDiff
    )
  )
  captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'green', 'aaa0005', 'pnpm test', 0, 'it passed')
  )
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, 'aaa0005', 'task-1', ['red', 'green']))
  assert.equal(getRequestedExitCode(), 0, 'a red capture that DID go red is ok, not failing')
  const parsed = JSON.parse(output) as { failing: string[]; missing: string[] }
  assert.deepEqual(parsed.failing, [])
  assert.deepEqual(parsed.missing, [])
})

test('check auto-requires red and green once a red is recorded for this task+sha, even when --require never names them', () => {
  captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'sweep', 'aaa0006', 'grep -rn x .', 0, 'hit: x')
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'evidence',
      'aaa0006',
      'pnpm typecheck',
      0,
      'clean'
    )
  )
  const mutationDiff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n'
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0006',
      'pnpm test',
      1,
      'it failed',
      mutationDiff
    )
  )
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, 'aaa0006', 'task-1', ['sweep', 'evidence']))
  assert.equal(
    getRequestedExitCode(),
    3,
    'a recorded red for this task+sha must not be checkable-around by an unnamed --require'
  )
  const parsed = JSON.parse(output) as { required: string[]; missing: string[]; failing: string[] }
  assert.deepEqual(
    [...parsed.required].sort(),
    ['evidence', 'green', 'red', 'sweep'],
    'red and green join the required set even though --require named neither'
  )
  assert.deepEqual(parsed.missing, ['green'])
  assert.deepEqual(parsed.failing, [])
})

test('check auto-requires red at a NEW sha once this task has EVER had a red anywhere — the carried-forward case, round 3 F1', () => {
  const mutationDiff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n'
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0006a',
      'pnpm test',
      1,
      'it failed',
      mutationDiff
    )
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'green',
      'aaa0006a',
      'pnpm test',
      0,
      'it passed'
    )
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'sweep',
      'aaa0006b',
      'grep -rn x .',
      0,
      'hit: x'
    )
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'evidence',
      'aaa0006b',
      'pnpm typecheck',
      0,
      'clean'
    )
  )
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, 'aaa0006b', 'task-1', ['sweep', 'evidence']))
  assert.equal(
    getRequestedExitCode(),
    3,
    'a task that has ever had a red anywhere must require red at every future sha, not just the sha it was recorded at'
  )
  const parsed = JSON.parse(output) as { required: string[]; missing: string[]; failing: string[] }
  assert.deepEqual(
    [...parsed.required].sort(),
    ['evidence', 'red', 'sweep'],
    'red joins required at aaa0006b even though the only red for this task was recorded at aaa0006a; green does not join — no red is present at aaa0006b to prove a fix against'
  )
  assert.deepEqual(
    parsed.missing,
    ['red'],
    'the carried-forward red is reported missing at this sha — silence surfaces, it does not vanish'
  )
  assert.deepEqual(parsed.failing, [])
})

test('record --capture red with a --mutation-file that is not a diff exits 6 and writes nothing to the ledger', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0007',
      'pnpm test',
      1,
      'it failed',
      'grep output, not a diff'
    )
  )
  assert.equal(getRequestedExitCode(), 6, 'non-diff mutation content must be refused')
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /unified diff/)
  assert.equal(
    existsSync(proofLedgerPath(ticket)),
    false,
    'the refused record must not create the ledger file at all'
  )
})

test('record --capture red with blank --mutation-file content exits 6', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0008',
      'pnpm test',
      1,
      'it failed',
      '   \n  \n'
    )
  )
  assert.equal(getRequestedExitCode(), 6, 'blank mutation content must be refused')
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /unified diff/)
})

// A diff-shaped HEADER is not proof of a mutation — each of these carries a real "--- "/"+++ " or
// "diff --git" header (so the old header-only predicate accepted every one of them) but no genuine
// hunk, no genuine changed-content line, or both. Each gets its own case and its own RED, not one
// shared test for the class.

test('record --capture red with a mode-only diff (no hunk, no changed line) exits 6', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0011',
      'pnpm test',
      1,
      'it failed',
      'diff --git a/x.ts b/x.ts\nold mode 100644\nnew mode 100755\n'
    )
  )
  assert.equal(
    getRequestedExitCode(),
    6,
    'a mode-only diff has a header but no hunk — must be refused'
  )
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /unified diff/)
})

test('record --capture red with a rename-only diff (no hunk, no changed line) exits 6', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0012',
      'pnpm test',
      1,
      'it failed',
      'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n'
    )
  )
  assert.equal(
    getRequestedExitCode(),
    6,
    'a rename-only diff has a header but no hunk — must be refused'
  )
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /unified diff/)
})

test('record --capture red with a "diff --git" header alone, zero hunks, exits 6', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0013',
      'pnpm test',
      1,
      'it failed',
      'diff --git a/x.ts b/x.ts\n'
    )
  )
  assert.equal(
    getRequestedExitCode(),
    6,
    'a bare "diff --git" line proves no mutation — must be refused'
  )
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /unified diff/)
})

test('record --capture red with a banner log mimicking "--- "/"+++ " markers exits 6', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0014',
      'pnpm test',
      1,
      'it failed',
      '--- BEGIN RUN ---\nsome test output here\n+++ DONE +++\n'
    )
  )
  assert.equal(
    getRequestedExitCode(),
    6,
    'a banner log has diff-shaped markers but no hunk — must be refused'
  )
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /unified diff/)
})

test('record --capture red with "--- "/"+++ " headers but no hunk (reversed order) exits 6', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0015',
      'pnpm test',
      1,
      'it failed',
      '+++ b/foo.ts\n--- a/foo.ts\n'
    )
  )
  assert.equal(
    getRequestedExitCode(),
    6,
    'headers with no hunk prove no mutation regardless of order — must be refused'
  )
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /unified diff/)
})

test('record --capture red with a markdown fence quoting the diff format but no real hunk exits 6', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0016',
      'pnpm test',
      1,
      'it failed',
      '```diff\n--- a/foo.ts\n+++ b/foo.ts\n```\n'
    )
  )
  assert.equal(
    getRequestedExitCode(),
    6,
    'a fenced illustration of the diff format is not a real hunk — must be refused'
  )
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /unified diff/)
})

// Captured via a real `git diff` against an actual file mutation in a scratch repo (not hand-typed):
// one line changed from "old" to "new", `git diff` run against the working tree.
const REAL_GIT_DIFF_REPLACE =
  'diff --git a/foo.ts b/foo.ts\nindex caec8c8..3252ae0 100644\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,3 @@\n alpha\n-old\n+new\n context\n'

// Captured the same way — a deletion-only mutation whose deleted line is itself a SQL comment
// beginning "-- ", the exact shape a leading-character check would misread as a header line instead of
// counting as real change content.
const REAL_GIT_DIFF_DELETE_SQL_COMMENT =
  'diff --git a/sql.sql b/sql.sql\nindex 6d20e0a..33791bf 100644\n--- a/sql.sql\n+++ b/sql.sql\n@@ -1,3 +1,2 @@\n SELECT 1;\n--- sql comment line\n SELECT 2;\n'

test('record --capture red with a genuine unified diff (header, hunk, and changed lines) is accepted', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0017',
      'pnpm test',
      1,
      'it failed',
      REAL_GIT_DIFF_REPLACE
    )
  )
  assert.notEqual(getRequestedExitCode(), 6, 'a genuine diff with a real hunk must be accepted')
  const parsed = JSON.parse(output) as { id: string }
  assert.equal(typeof parsed.id, 'string')
  assert.notEqual(parsed.id, '')
})

test('record --capture red with a genuine deletion-only diff whose deleted line begins "-- " is accepted, round 3 F2', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0018',
      'pnpm test',
      1,
      'it failed',
      REAL_GIT_DIFF_DELETE_SQL_COMMENT
    )
  )
  assert.notEqual(
    getRequestedExitCode(),
    6,
    'a deletion-only diff must be accepted even when the deleted content itself begins "-- " — SQL, Lua, Haskell, Elm, and Ada comment syntax'
  )
  const parsed = JSON.parse(output) as { id: string }
  assert.equal(typeof parsed.id, 'string')
  assert.notEqual(parsed.id, '')
})

/**
 * Appends a `red` capture straight through ledger.ts's own writers, bypassing runRecord's
 * mutation-content guard entirely — this is how a real pre-guard capture (a red whose mutation
 * sidecar held grep output rather than a diff) actually got into a ledger: written before that
 * guard existed, and the ledger being append-only means it is still there.
 */
const appendUnvalidatedRedCapture = (task: string, sha: string, mutationContent: string): void => {
  const command = 'pnpm test'
  const output = writeProofOutput(ticket, 'red', task, sha, 'it failed')
  const mutation = writeMutationDiff(ticket, task, sha, mutationContent)
  appendProofCapture(ticket, {
    kind: 'proof-capture',
    at: new Date().toISOString(),
    id: captureId(task, 'red', sha, command, output.outputSha256),
    task,
    capture: 'red',
    sha,
    command,
    exitStatus: 1,
    outputPath: output.outputPath,
    outputSha256: output.outputSha256,
    outputBytes: output.outputBytes,
    tail: output.tail,
    mutationPath: mutation.outputPath,
    mutationSha256: mutation.outputSha256,
    mutationBytes: mutation.outputBytes,
  })
}

/**
 * Appends a `red` capture with exitStatus 0 straight through ledger.ts's own writers, bypassing
 * runRecord's exit-status guard entirely — this is how a pre-guard capture like this actually got
 * into a ledger: a mutation whose sidecar is a genuine diff but that never turned the test red,
 * recorded before the guard existed.
 */
const appendExitZeroRedCapture = (task: string, sha: string, mutationContent: string): void => {
  const command = 'pnpm test'
  const output = writeProofOutput(ticket, 'red', task, sha, 'it passed')
  const mutation = writeMutationDiff(ticket, task, sha, mutationContent)
  appendProofCapture(ticket, {
    kind: 'proof-capture',
    at: new Date().toISOString(),
    id: captureId(task, 'red', sha, command, output.outputSha256),
    task,
    capture: 'red',
    sha,
    command,
    exitStatus: 0,
    outputPath: output.outputPath,
    outputSha256: output.outputSha256,
    outputBytes: output.outputBytes,
    tail: output.tail,
    mutationPath: mutation.outputPath,
    mutationSha256: mutation.outputSha256,
    mutationBytes: mutation.outputBytes,
  })
}

/**
 * Appends a `red` capture whose mutation sidecar is a zero-section diff (both header sides resolve to
 * no path) straight through ledger.ts's own writers, bypassing runRecord's record-time
 * noResolvableSectionReason guard entirely — this is how such a line could reach the ledger by any
 * route other than the current record path (a pre-guard record, a hand-edited line), which is exactly
 * the case captureInvalidReason's read-time re-validation exists to catch.
 */
const appendZeroSectionRedCapture = (task: string, sha: string, mutationContent: string): void => {
  const command = 'pnpm test'
  const output = writeProofOutput(ticket, 'red', task, sha, 'it failed')
  const mutation = writeMutationDiff(ticket, task, sha, mutationContent)
  appendProofCapture(ticket, {
    kind: 'proof-capture',
    at: new Date().toISOString(),
    id: captureId(task, 'red', sha, command, output.outputSha256),
    task,
    capture: 'red',
    sha,
    command,
    exitStatus: 1,
    outputPath: output.outputPath,
    outputSha256: output.outputSha256,
    outputBytes: output.outputBytes,
    tail: output.tail,
    mutationPath: mutation.outputPath,
    mutationSha256: mutation.outputSha256,
    mutationBytes: mutation.outputBytes,
  })
}

/**
 * Appends a `red` capture whose mutation sidecar is a truncated/corrupt diff (a hunk header claiming
 * more lines than its body contains) straight through ledger.ts's own writers, bypassing runRecord's
 * record-time truncatedMutationReason guard entirely — the read-time twin captureInvalidReason exists
 * to catch for exactly this class of ledger line, same reasoning as appendZeroSectionRedCapture.
 */
const appendCorruptRedCapture = (task: string, sha: string, mutationContent: string): void => {
  const command = 'pnpm test'
  const output = writeProofOutput(ticket, 'red', task, sha, 'it failed')
  const mutation = writeMutationDiff(ticket, task, sha, mutationContent)
  appendProofCapture(ticket, {
    kind: 'proof-capture',
    at: new Date().toISOString(),
    id: captureId(task, 'red', sha, command, output.outputSha256),
    task,
    capture: 'red',
    sha,
    command,
    exitStatus: 1,
    outputPath: output.outputPath,
    outputSha256: output.outputSha256,
    outputBytes: output.outputBytes,
    tail: output.tail,
    mutationPath: mutation.outputPath,
    mutationSha256: mutation.outputSha256,
    mutationBytes: mutation.outputBytes,
  })
}

/**
 * Appends a `sweep` capture with an arbitrary exit status straight through ledger.ts's own writers,
 * bypassing runRecord's exit-status guard entirely — this is how a pre-guard capture like an exit-2
 * "the tool itself failed to run" sweep would have entered a ledger: the record-
 * time guard is narrowed to only exempt sweep at exit 0 or 1, so a real `record` call can no longer produce this
 * shape, but check must still recognise it as invalid if it is ever read back from an existing ledger.
 */
const appendSweepCaptureWithExitStatus = (task: string, sha: string, exitStatus: number): void => {
  const command = 'grep -rn x tools/cli/src/no-such-dir/'
  const output = writeProofOutput(
    ticket,
    'sweep',
    task,
    sha,
    'grep: tools/cli/src/no-such-dir/: No such file or directory'
  )
  appendProofCapture(ticket, {
    kind: 'proof-capture',
    at: new Date().toISOString(),
    id: captureId(task, 'sweep', sha, command, output.outputSha256),
    task,
    capture: 'sweep',
    sha,
    command,
    exitStatus,
    outputPath: output.outputPath,
    outputSha256: output.outputSha256,
    outputBytes: output.outputBytes,
    tail: output.tail,
  })
}

test('check reports a red capture as failing, not ok, when its mutation sidecar is not a diff — even though its exitStatus is correctly non-zero', () => {
  appendUnvalidatedRedCapture('task-1', 'aaa0009', 'grep output, not a diff')
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, 'aaa0009', 'task-1', ['red']))
  assert.equal(
    getRequestedExitCode(),
    3,
    'a red whose mutation sidecar is not a diff must fail check even with the right exit status'
  )
  const parsed = JSON.parse(output) as { failing: string[]; missing: string[] }
  assert.deepEqual(parsed.failing, ['red'])
  assert.deepEqual(parsed.missing, [])
})

test('check auto-requires red (but not green) when the only red for this task+sha has a non-diff mutation sidecar — the invalid red must surface as failing, not vanish', () => {
  captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'sweep', 'aaa0010', 'grep -rn x .', 0, 'hit: x')
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'evidence',
      'aaa0010',
      'pnpm typecheck',
      0,
      'clean'
    )
  )
  appendUnvalidatedRedCapture('task-1', 'aaa0010', 'grep output, not a diff')
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, 'aaa0010', 'task-1', ['sweep', 'evidence']))
  assert.equal(
    getRequestedExitCode(),
    3,
    'an invalid red must surface as a failing check, not silently pass'
  )
  const parsed = JSON.parse(output) as { required: string[]; missing: string[]; failing: string[] }
  assert.deepEqual([...parsed.required].sort(), ['evidence', 'red', 'sweep'])
  assert.deepEqual(parsed.missing, [])
  assert.deepEqual(parsed.failing, ['red'])
})

// The following exercise the CLI's parsing layer directly, as a real subprocess — handler-level
// tests above cover run.ts's own logic, but a change to a flag or entrypoint is only proven by
// invoking the real binary (see review-standards.md).

test('CLI: proof-ledger record --help states the exact brief runRecord actually enforces, word for word — round 11 (a substring match let two drifts through undetected)', async () => {
  const result = await runCli(['proof-ledger', 'record', '--help'])
  assert.equal(result.exitCode, 0)
  const briefLine = result.stdout
    .split('\n')
    .find((line) => line.startsWith('Record a proof capture for a task at a sha'))
  assert.equal(
    briefLine,
    'Record a proof capture for a task at a sha — exits 6 if --sha does not resolve to a commit in --repo-root (checked for every capture kind, including --sha-is-label — the label exempts a capture from the tree-content checks below, never from --sha existing at all), if --capture red is missing --mutation-file, has a --mutation-file that is not a recognisable unified diff (a "--- "/"+++ " header pair or a "diff --git" line, an "@@ ... @@" hunk header, and at least one real +/- changed-content line), has --exit 0, or if the output is empty or whitespace-only without --note. A non-zero --exit is accepted under a real task key only for red, or for sweep with --exit 1 (grep/rg\'s own no-match convention — --exit 2 or higher means grep/rg itself failed to run, and is refused here same as any other kind; `git grep` also uses exit 1 for no-match but conflates it with some of its own errors, a bad path among them, so this exemption is not sound for a `git grep` sweep — verify the target path some other way). Every other non-zero --exit is only accepted under a task prefixed "fixture-" — record a deliberately-invalid capture (a counter-example, a corrupt-ledger reproduction) there, never under a real task key, or it poisons that key\'s coverage check forever. Those are examples rather than the set; the shape throughout is that a capture which cannot be tied to what it claims is refused, or records exactly which part went untied. A sweep also requires `--scope` unless `--sha-is-label`, which refuses it — the package dir(s) of the changed files — and is refused when a scope dir is not one of those or a found path (in grep/rg\'s line or listing format) lies outside them.'
  )
})

test('CLI: proof-ledger record --help states that --exit is observed, not verified — door 13 follow-up', async () => {
  const result = await runCli(['proof-ledger', 'record', '--help'])
  assert.equal(result.exitCode, 0)
  const exitFlagLine = result.stdout.split('\n').find((line) => line.trim().startsWith('--exit'))
  assert.equal(
    exitFlagLine,
    "      --exit            The command's observed exit status — record trusts this as typed and never runs --command itself to check it, so a mismatched value here still produces a capture that reads valid"
  )
})

test('CLI: proof-ledger check --help states the exact brief runCheck actually enforces, word for word', async () => {
  const result = await runCli(['proof-ledger', 'check', '--help'])
  assert.equal(result.exitCode, 0)
  const briefLine = result.stdout
    .split('\n')
    .find((line) => line.startsWith('Coverage check over the required capture kinds'))
  assert.equal(
    briefLine,
    "Coverage check over the required capture kinds for a task at a sha — exits 3 if any required kind is missing or failing, or 4 if the ledger has a line it could not parse. --require is mandatory: name the kinds this task actually needs (sweep,evidence for a swept task; red,green for a guard/regression test; evidence alone for a sentinel task like repo-gates) — there is no default, since a fine-grained sub-proof task and its parent gate check need different kinds and the task name alone does not say which. Without --expect-command this checks presence per kind (one valid capture satisfies a kind), not count; name --expect-command to check that each expected capture under a kind exists individually. The required set can grow beyond --require and --expect-command from the ledger's own capture history for this task; there is no flag to disable that growth"
  )
})

test('record through the real CLI process round-trips the exact --command through show', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'proof-ledger-run-cli-test-'))
  const outputFile = join(tmpDir, 'output.txt')
  writeFileSync(outputFile, 'clean')
  const { repoRoot, headSha: sha } = makeCleanScratchRepo()
  const recordResult = await runCli(
    [
      'proof-ledger',
      'record',
      '--ticket',
      ticket,
      '--task',
      'task-1',
      '--capture',
      'evidence',
      '--sha',
      sha,
      '--command',
      'pnpm typecheck',
      '--exit',
      '0',
      '--output-file',
      outputFile,
    ],
    { cwd: repoRoot }
  )
  assert.equal(recordResult.exitCode, 0)
  assert.doesNotMatch(
    recordResult.stderr,
    /\n\s*at /,
    'no uncaught-exception stack trace on stderr'
  )
  const showResult = await runCli(['proof-ledger', 'show', '--ticket', ticket, '--sha', sha])
  assert.equal(showResult.exitCode, 0)
  assert.doesNotMatch(showResult.stderr, /\n\s*at /, 'no uncaught-exception stack trace on stderr')
  const parsed = JSON.parse(showResult.stdout) as {
    captures: { command: string; capture: string }[]
  }
  assert.equal(parsed.captures.length, 1)
  assert.equal(parsed.captures[0]!.command, 'pnpm typecheck')
  assert.equal(parsed.captures[0]!.capture, 'evidence')
})

test('record --capture red through the real CLI process with no --mutation-file exits 6 with JSON on stdout, not a stack trace', async () => {
  const { repoRoot, headSha: sha } = makeCleanScratchRepo()
  const result = await runCli(
    [
      'proof-ledger',
      'record',
      '--ticket',
      ticket,
      '--task',
      'task-1',
      '--capture',
      'red',
      '--sha',
      sha,
      '--command',
      'pnpm test',
      '--exit',
      '1',
      '--output',
      'it failed',
    ],
    { cwd: repoRoot }
  )
  assert.equal(result.exitCode, 6)
  assert.doesNotMatch(result.stderr, /\n\s*at /, 'no uncaught-exception stack trace on stderr')
  const parsed = JSON.parse(result.stdout) as { error: string }
  assert.match(parsed.error, /--mutation-file/)
})

test('check through the real CLI process exits 3 and names the missing kind', async () => {
  const { repoRoot, headSha: sha } = makeScopeFixtureRepo('src/thing.ts', [])
  const recordResult = await runCli(
    [
      'proof-ledger',
      'record',
      '--ticket',
      ticket,
      '--task',
      'task-1',
      '--capture',
      'sweep',
      '--sha',
      sha,
      '--command',
      'grep -rn x .',
      '--exit',
      '0',
      '--output',
      'hit: x',
      '--scope',
      '.',
    ],
    { cwd: repoRoot }
  )
  assert.equal(recordResult.exitCode, 0)
  assert.doesNotMatch(
    recordResult.stderr,
    /\n\s*at /,
    'no uncaught-exception stack trace on stderr'
  )
  const checkResult = await runCli([
    'proof-ledger',
    'check',
    '--ticket',
    ticket,
    '--sha',
    sha,
    '--task',
    'task-1',
    '--require',
    'sweep,evidence',
  ])
  assert.equal(checkResult.exitCode, 3)
  assert.doesNotMatch(checkResult.stderr, /\n\s*at /, 'no uncaught-exception stack trace on stderr')
  const parsed = JSON.parse(checkResult.stdout) as { missing: string[] }
  assert.deepEqual(parsed.missing, ['evidence'])
})

test('check through the real CLI process rejects an omitted --require at the parsing layer, not with an inferred default', async () => {
  const result = await runCli([
    'proof-ledger',
    'check',
    '--ticket',
    ticket,
    '--sha',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '--task',
    'task-1',
  ])
  assert.equal(result.exitCode, 252, "Stricli's own parse-failure code")
  assert.equal(
    result.stdout,
    '',
    'a parse-layer rejection never reaches func, so no JSON is printed'
  )
  assert.match(result.stderr, /Expected input for flag --require/)
})

test('check through the real CLI process rejects a bad --require value by naming --require, not --capture', async () => {
  const result = await runCli([
    'proof-ledger',
    'check',
    '--ticket',
    ticket,
    '--sha',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '--task',
    'task-1',
    '--require',
    'bogus',
  ])
  assert.equal(result.exitCode, 252, "Stricli's own parse-failure code")
  assert.match(result.stderr, /--require must be one of sweep, red, green, evidence, got: bogus/)
  assert.doesNotMatch(result.stderr, /--capture must be/, 'must not misname the flag as --capture')
})

// The property under test in the B1, D1, and B2 cases below: no path may reduce `required`, or an
// already-required kind's pass/fail result, except the caller's own explicit --require. The B1 case
// closes a corrupted-ledger path, the D1 case closes a validate-only-the-latest-red path, and the B2
// case closes a hash-collision-via-empty-output path.

test('check exits 4 and reports corrupted when the ledger has a skipped line, even though missing and failing would otherwise both be empty — B1', () => {
  captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'sweep', 'aaa0022', 'grep -rn x .', 0, 'hit: x')
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'evidence',
      'aaa0022',
      'pnpm typecheck',
      0,
      'clean'
    )
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0022',
      'pnpm test',
      1,
      'it failed',
      REAL_GIT_DIFF_REPLACE
    )
  )
  captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'green', 'aaa0022', 'pnpm test', 0, 'it passed')
  )
  resetExitCode()

  const cleanOutput = captureStdout(() =>
    runCheck(ticket, 'aaa0022', 'task-1', ['sweep', 'evidence'])
  )
  assert.equal(getRequestedExitCode(), 0, 'sanity: the uncorrupted ledger passes clean')
  const cleanParsed = JSON.parse(cleanOutput) as { missing: string[]; failing: string[] }
  assert.deepEqual(cleanParsed.missing, [])
  assert.deepEqual(cleanParsed.failing, [])

  appendLine(proofLedgerPath(ticket), '{"kind":"proof-capture","task":"task-1"')
  resetExitCode()
  const corruptOutput = captureStdout(() =>
    runCheck(ticket, 'aaa0022', 'task-1', ['sweep', 'evidence'])
  )
  assert.equal(
    getRequestedExitCode(),
    4,
    'a skipped line must block the check even when the readable content alone would pass'
  )
  const corruptParsed = JSON.parse(corruptOutput) as {
    missing: string[]
    failing: string[]
    skippedLines: number
    corrupted: boolean
  }
  assert.equal(corruptParsed.skippedLines, 1)
  assert.equal(corruptParsed.corrupted, true)
  assert.deepEqual(
    corruptParsed.missing,
    [],
    'missing is still empty — corrupted is a separate, additional block'
  )
  assert.deepEqual(
    corruptParsed.failing,
    [],
    'failing is still empty — corrupted is a separate, additional block'
  )
})

// Copied byte-for-byte from a real production ledger (~/.claude/workflow-state/tickets/FLOW-287/
// proof-ledger.jsonl, the line recorded by the now-removed `require` command for task
// proof-ledger-require-audit) rather than composed from this file's own idea of the format, so a
// fixture that merely agrees with parseRequirementEvent by construction cannot pass for a real one.
const REAL_PROOF_REQUIREMENT_LINE =
  '{"kind":"proof-requirement","at":"2026-08-30T14:59:05.965Z","id":"e30ec3304a2d","task":"proof-ledger-require-audit","required":["sweep","red","green","evidence"],"expectCommands":[]}'

test('check reads a ledger holding a legacy proof-requirement line without erroring or counting it as skipped — the require command that wrote such lines is gone, but ledgers already holding them must still parse', () => {
  appendLine(proofLedgerPath(ticket), REAL_PROOF_REQUIREMENT_LINE)
  captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'sweep', 'aaa0022', 'grep -rn x .', 0, 'hit: x')
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'evidence',
      'aaa0022',
      'pnpm typecheck',
      0,
      'clean'
    )
  )
  resetExitCode()

  const output = captureStdout(() => runCheck(ticket, 'aaa0022', 'task-1', ['sweep', 'evidence']))
  assert.equal(
    getRequestedExitCode(),
    0,
    'a legacy proof-requirement line must not be counted as an unparseable line'
  )
  const parsed = JSON.parse(output) as {
    missing: string[]
    failing: string[]
    skippedLines: number
  }
  assert.equal(parsed.skippedLines, 0)
  assert.deepEqual(parsed.missing, [])
  assert.deepEqual(parsed.failing, [])
})

test('show reads a ledger holding a legacy proof-requirement line without erroring, without counting it as skipped, and without it leaking into the captures array', () => {
  appendLine(proofLedgerPath(ticket), REAL_PROOF_REQUIREMENT_LINE)
  captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'sweep', 'aaa0022', 'grep -rn x .', 0, 'hit: x')
  )
  resetExitCode()

  const output = captureStdout(() => runShow(ticket))
  const parsed = JSON.parse(output) as {
    captures: { kind?: string; task: string }[]
    skippedLines: number
  }
  assert.equal(parsed.skippedLines, 0, 'the proof-requirement line must not be counted as skipped')
  assert.equal(parsed.captures.length, 1, 'the one real capture is still returned')
  assert.equal(
    parsed.captures.some((c) => c.task === 'proof-ledger-require-audit'),
    false,
    'the requirement event must not surface as a capture under its own task'
  )
})

test('check reports red as failing when an EARLIER red at this task+sha is invalid, even though the LATEST red at that sha is valid — D1', () => {
  appendUnvalidatedRedCapture('task-1', 'aaa0021', 'grep output, not a diff')
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0021',
      'pnpm test',
      1,
      'it failed on the second run',
      REAL_GIT_DIFF_REPLACE
    )
  )
  // A valid red at this sha auto-requires green too — recorded here so the assertions below isolate
  // D1's actual claim (the earlier invalid red fails the row) from that unrelated auto-requirement.
  captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'green', 'aaa0021', 'pnpm test', 0, 'it passed')
  )
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, 'aaa0021', 'task-1', ['red']))
  assert.equal(
    getRequestedExitCode(),
    3,
    'an invalid red must fail the check even when a later red at the same sha is valid'
  )
  const parsed = JSON.parse(output) as { failing: string[]; missing: string[] }
  assert.deepEqual(parsed.failing, ['red'])
  assert.deepEqual(parsed.missing, [])
})

test('record with zero-byte output and no --note is refused, exit 6 — B2', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'sweep',
      'aaa0023',
      'grep -rn nonexistent-pattern .',
      0,
      ''
    )
  )
  assert.equal(getRequestedExitCode(), 6, 'a zero-byte capture with no note must refuse')
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /--note/)
  assert.equal(
    existsSync(proofLedgerPath(ticket)),
    false,
    'the refused record must not create the ledger file at all'
  )
})

test('record with zero-byte output and a --note is accepted — B2', () => {
  const note =
    'swept src/**/*.ts for TODO markers introduced this task; would have failed on any match'
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'sweep',
      'aaa0024',
      'grep -rn nonexistent-pattern .',
      0,
      '',
      undefined,
      note
    )
  )
  assert.notEqual(getRequestedExitCode(), 6, 'a zero-byte capture WITH a note must be accepted')
  const parsed = JSON.parse(output) as { outputBytes: number; outputSha256: string }
  assert.equal(parsed.outputBytes, 0)
  const emptySha256 = createHash('sha256').update('').digest('hex')
  assert.equal(parsed.outputSha256, emptySha256)
})

test('record with whitespace-only output and no --note is refused, exit 6 — a whitespace-only result is exactly as uninformative as a truly empty one, F3', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'sweep',
      'aaa0025',
      'grep -rn nonexistent-pattern .',
      0,
      '\n  \n\t'
    )
  )
  assert.equal(getRequestedExitCode(), 6, 'a whitespace-only capture with no note must refuse')
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /--note/)
  assert.equal(
    existsSync(proofLedgerPath(ticket)),
    false,
    'the refused record must not create the ledger file at all'
  )
})

test('record --capture red with --exit 0 is refused, exit 6 — a mutation that never turned the test red is not a red baseline, D1', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0025',
      'pnpm test',
      0,
      'it passed',
      REAL_GIT_DIFF_REPLACE
    )
  )
  assert.equal(
    getRequestedExitCode(),
    6,
    'a red capture with exitStatus 0 must refuse even with a genuine diff mutation file'
  )
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /--exit/)
  assert.equal(
    existsSync(proofLedgerPath(ticket)),
    false,
    'the refused record must not create the ledger file at all'
  )
})

test("check reports red as failing when an exit-0 red sits alongside a later, valid red at the same task+sha — the team lead's exact reproduction, D1", () => {
  appendExitZeroRedCapture('task-1', 'aaa0026', REAL_GIT_DIFF_REPLACE)
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0026',
      'pnpm test',
      1,
      'it failed on the second attempt',
      REAL_GIT_DIFF_DELETE_SQL_COMMENT
    )
  )
  // The valid red at this sha auto-requires green too — recorded here so the assertions below
  // isolate D1's actual claim from that unrelated auto-requirement, exactly as the earlier D1 test.
  captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'green', 'aaa0026', 'pnpm test', 0, 'it passed')
  )
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, 'aaa0026', 'task-1', ['red']))
  assert.equal(
    getRequestedExitCode(),
    3,
    'an exit-0 red must fail the check even when a later red at the same sha genuinely went red'
  )
  const parsed = JSON.parse(output) as { failing: string[]; missing: string[] }
  assert.deepEqual(parsed.failing, ['red'])
  assert.deepEqual(parsed.missing, [])
})

test('check reports sweep as failing when an EARLIER sweep at this task+sha has a tampered output sidecar, even though the LATEST sweep is untouched — F1', () => {
  // Sweep's own exit status doesn't gate validity (a zero-match sweep's non-zero exit is the desired
  // outcome), so the earlier-capture invalidity this test needs comes from sidecar tampering instead.
  const first = JSON.parse(
    captureStdout(() =>
      runRecord(
        NO_REPO_ROOT_CHECK,
        ticket,
        'task-1',
        'sweep',
        'aaa0027',
        'grep -rn x .',
        1,
        'no matches'
      )
    )
  ) as { outputPath: string }
  writeFileSync(first.outputPath, 'tampered content, does not match the recorded digest')
  captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'sweep', 'aaa0027', 'grep -rn x .', 0, 'hit: x')
  )
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, 'aaa0027', 'task-1', ['sweep']))
  assert.equal(
    getRequestedExitCode(),
    3,
    'an earlier tampered sweep must fail the row even though the latest sweep is untouched'
  )
  const parsed = JSON.parse(output) as { failing: string[]; missing: string[] }
  assert.deepEqual(parsed.failing, ['sweep'])
  assert.deepEqual(parsed.missing, [])
})

test("check reports evidence as failing when an EARLIER evidence at this task+sha failed, even though the LATEST evidence is ok — the team lead's repo-gates reproduction, F1", () => {
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'fixture-repo-gates',
      'evidence',
      'aaa0028',
      'pnpm test',
      1,
      'test failed'
    )
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'fixture-repo-gates',
      'evidence',
      'aaa0028',
      'pnpm typecheck',
      0,
      'clean'
    )
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'fixture-repo-gates',
      'evidence',
      'aaa0028',
      'pnpm lint',
      0,
      'clean'
    )
  )
  resetExitCode()
  const output = captureStdout(() =>
    runCheck(ticket, 'aaa0028', 'fixture-repo-gates', ['evidence'])
  )
  assert.equal(
    getRequestedExitCode(),
    3,
    'a red test suite recorded honestly must not report green just because later gates passed'
  )
  const parsed = JSON.parse(output) as { failing: string[]; missing: string[] }
  assert.deepEqual(parsed.failing, ['evidence'])
  assert.deepEqual(parsed.missing, [])
})

test('check reports green as failing when an EARLIER green at this task+sha failed, even though the LATEST green is ok — F1', () => {
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'fixture-task-1',
      'red',
      'aaa0029',
      'pnpm test',
      1,
      'it failed',
      REAL_GIT_DIFF_REPLACE
    )
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'fixture-task-1',
      'green',
      'aaa0029',
      'pnpm test',
      1,
      'still failing'
    )
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'fixture-task-1',
      'green',
      'aaa0029',
      'pnpm test',
      0,
      'it passed'
    )
  )
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, 'aaa0029', 'fixture-task-1', []))
  assert.equal(getRequestedExitCode(), 3)
  const parsed = JSON.parse(output) as { failing: string[]; missing: string[] }
  assert.deepEqual(parsed.failing, ['green'])
  assert.deepEqual(parsed.missing, [])
})

test('check reports a row as failing when its output sidecar is deleted from disk after recording — F4', () => {
  const recordOutput = captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'sweep', 'aaa0030', 'grep -rn x .', 0, 'hit: x')
  )
  const recorded = JSON.parse(recordOutput) as { outputPath: string }
  rmSync(recorded.outputPath)
  resetExitCode()
  const checkOutput = captureStdout(() => runCheck(ticket, 'aaa0030', 'task-1', ['sweep']))
  assert.equal(
    getRequestedExitCode(),
    3,
    'a deleted output sidecar must fail the row, not silently read as ok'
  )
  const parsed = JSON.parse(checkOutput) as {
    failing: string[]
    rows: { capture: string; reason?: string }[]
  }
  assert.deepEqual(parsed.failing, ['sweep'])
  assert.match(parsed.rows[0]!.reason ?? '', /missing on disk/)
})

test('check reports a row as failing when its output sidecar content no longer matches its recorded digest — F4', () => {
  const recordOutput = captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'sweep', 'aaa0031', 'grep -rn x .', 0, 'hit: x')
  )
  const recorded = JSON.parse(recordOutput) as { outputPath: string }
  writeFileSync(recorded.outputPath, 'tampered content, does not match the recorded digest')
  resetExitCode()
  const checkOutput = captureStdout(() => runCheck(ticket, 'aaa0031', 'task-1', ['sweep']))
  assert.equal(
    getRequestedExitCode(),
    3,
    'a swapped output sidecar must fail the row even though a file still exists at the path'
  )
  const parsed = JSON.parse(checkOutput) as {
    failing: string[]
    rows: { capture: string; reason?: string }[]
  }
  assert.deepEqual(parsed.failing, ['sweep'])
  assert.match(parsed.rows[0]!.reason ?? '', /digest/)
})

// --- An unreadable proof sidecar is not a deleted one (FLOW-226) ---
//
// `check` re-reads each sidecar and re-hashes it, and it used to gate that read on existsSync. Both
// of the two ways a sidecar can be present-but-unreadable were reported as something they were not:
// a directory at the path passed existsSync and then threw EISDIR out of the whole command, and a
// sidecar under a non-traversable parent failed existsSync and was reported as deleted. The second
// is the dangerous one — "your proof is gone, re-run the work" about a proof sitting on disk intact.
test('check tells an unreadable output sidecar apart from a deleted one, rather than reporting both as missing', () => {
  const recordOutput = captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'sweep', 'aaa0041', 'grep -rn x .', 0, 'hit: x')
  )
  const recorded = JSON.parse(recordOutput) as { outputPath: string }

  const reasonNow = (): string => {
    resetExitCode()
    const out = captureStdout(() => runCheck(ticket, 'aaa0041', 'task-1', ['sweep']))
    assert.equal(getRequestedExitCode(), 3, 'either way the row must fail, never pass')
    return (JSON.parse(out) as { rows: { reason?: string }[] }).rows[0]?.reason ?? ''
  }

  // Genuinely deleted keeps the existing wording.
  const stashed = `${recorded.outputPath}.stashed`
  renameSync(recorded.outputPath, stashed)
  const deletedReason = reasonNow()
  assert.match(deletedReason, /missing on disk/)

  // A DIRECTORY at the sidecar path: readFileSync fails EISDIR for every uid including root, so
  // this half of the test is not vacuous under a root runner.
  mkdirSync(recorded.outputPath, { recursive: true })
  assert.throws(
    () => readFileSync(recorded.outputPath, 'utf-8'),
    /EISDIR/,
    'precondition: the planted sidecar path must actually be unreadable'
  )
  const unreadableReason = reasonNow()
  rmSync(recorded.outputPath, { recursive: true, force: true })
  renameSync(stashed, recorded.outputPath)

  assert.notEqual(
    unreadableReason,
    deletedReason,
    'an unreadable sidecar and a deleted one must not give the same reason — they prescribe different actions'
  )
  assert.match(unreadableReason, /could not be read \(EISDIR\)/)
})

// The exact historical misreport, and the only route that produces it: existsSync returns FALSE for
// a file whose parent denies traversal, so this sidecar was called "missing on disk" while sitting
// on disk unmodified. Root traverses a 0o000 directory regardless, so under a root runner the
// fixture cannot deny access and the test would pass while proving nothing.
const rootCannotBeDeniedAccess = process.getuid?.() === 0

test(
  'a sidecar under an unreadable parent directory is not reported as deleted',
  {
    skip: rootCannotBeDeniedAccess
      ? 'requires a non-root uid — root traverses a 0o000 directory, so the fixture cannot deny access'
      : false,
  },
  () => {
    const recordOutput = captureStdout(() =>
      runRecord(
        NO_REPO_ROOT_CHECK,
        ticket,
        'task-1',
        'sweep',
        'aaa0042',
        'grep -rn x .',
        0,
        'hit: x'
      )
    )
    const recorded = JSON.parse(recordOutput) as { outputPath: string }
    const parent = dirname(recorded.outputPath)

    chmodSync(parent, 0o000)
    let reason: string
    try {
      assert.equal(
        existsSync(recorded.outputPath),
        false,
        'precondition: existsSync must be fooled here, or this test proves nothing'
      )
      resetExitCode()
      const out = captureStdout(() => runCheck(ticket, 'aaa0042', 'task-1', ['sweep']))
      assert.equal(getRequestedExitCode(), 3)
      reason = (JSON.parse(out) as { rows: { reason?: string }[] }).rows[0]?.reason ?? ''
    } finally {
      chmodSync(parent, 0o700)
    }

    assert.equal(
      reason.includes('missing on disk'),
      false,
      'the sidecar is on disk and unmodified — calling it missing sends the reader to re-run work whose evidence is intact'
    )
    assert.match(reason, /could not be read \(EACCES\)/)
    assert.equal(
      readFileSync(recorded.outputPath, 'utf-8').length > 0,
      true,
      'and the evidence really was still there the whole time'
    )
  }
)

test('check reports red as failing when its mutation sidecar is swapped for different content that is itself a valid diff — F4', () => {
  const recordOutput = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0032',
      'pnpm test',
      1,
      'it failed',
      REAL_GIT_DIFF_REPLACE
    )
  )
  const recorded = JSON.parse(recordOutput) as { mutationPath: string }
  writeFileSync(recorded.mutationPath, REAL_GIT_DIFF_DELETE_SQL_COMMENT)
  resetExitCode()
  const checkOutput = captureStdout(() => runCheck(ticket, 'aaa0032', 'task-1', ['red']))
  assert.equal(
    getRequestedExitCode(),
    3,
    'a swapped mutation sidecar must fail the row even though the swapped-in content is itself a valid diff'
  )
  const parsed = JSON.parse(checkOutput) as {
    failing: string[]
    rows: { capture: string; reason?: string }[]
  }
  assert.deepEqual(parsed.failing, ['red'])
  assert.match(parsed.rows[0]!.reason ?? '', /digest/)
})

test('check reports red as failing, not a silent pass, when its sidecar is tampered at a sha that also has a green — F1 x F4', () => {
  const recordOutput = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0033',
      'pnpm test',
      1,
      'it failed',
      REAL_GIT_DIFF_REPLACE
    )
  )
  const recorded = JSON.parse(recordOutput) as { mutationPath: string }
  captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'green', 'aaa0033', 'pnpm test', 0, 'it passed')
  )
  writeFileSync(recorded.mutationPath, REAL_GIT_DIFF_DELETE_SQL_COMMENT)
  resetExitCode()
  const checkOutput = captureStdout(() => runCheck(ticket, 'aaa0033', 'task-1', []))
  assert.equal(
    getRequestedExitCode(),
    3,
    'a tampered red sidecar must fail the check even though a green is recorded at the same sha'
  )
  const parsed = JSON.parse(checkOutput) as {
    failing: string[]
    missing: string[]
    rows: { capture: string; state: string; reason?: string }[]
  }
  assert.deepEqual(parsed.failing, ['red'], 'the red row must be failing, not silently absent')
  assert.deepEqual(
    parsed.missing,
    [],
    'the tampered red must not silently narrow green out of required — it must not appear at all, not as a missing row either'
  )
  const redRow = parsed.rows.find((r) => r.capture === 'red')
  assert.equal(redRow?.state, 'failing')
})

test('without --expect-command, check reports byte-identical ok whether 1 of 3 or 3 of 3 expected evidence commands were recorded — the sixth door, round 6 F1', () => {
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'repo-gates',
      'evidence',
      'aaa0034',
      'pnpm test',
      0,
      '854 pass'
    )
  )
  resetExitCode()
  const scratchOutput = captureStdout(() => runCheck(ticket, 'aaa0034', 'repo-gates', ['evidence']))
  const scratchExit = getRequestedExitCode()

  resetExitCode()
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'repo-gates',
      'evidence',
      'aaa0034',
      'pnpm typecheck',
      0,
      'clean'
    )
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'repo-gates',
      'evidence',
      'aaa0034',
      'pnpm lint',
      0,
      'clean'
    )
  )
  resetExitCode()
  const realOutput = captureStdout(() => runCheck(ticket, 'aaa0034', 'repo-gates', ['evidence']))
  const realExit = getRequestedExitCode()

  assert.equal(scratchExit, 0, 'one of three gates recorded still reports exit 0')
  assert.equal(realExit, 0, 'three of three gates recorded also reports exit 0')
  assert.equal(
    scratchOutput,
    realOutput,
    'without --expect-command, one gate and three gates produce byte-identical JSON — the check cannot distinguish them'
  )
})

test('with --expect-command, check reports the two absent gates as missing by name when only 1 of 3 expected commands was recorded — round 6 F1 fix', () => {
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'repo-gates',
      'evidence',
      'aaa0035',
      'pnpm test',
      0,
      '854 pass'
    )
  )
  resetExitCode()
  const output = captureStdout(() =>
    runCheck(
      ticket,
      'aaa0035',
      'repo-gates',
      ['evidence'],
      [
        { kind: 'evidence', command: 'pnpm test' },
        { kind: 'evidence', command: 'pnpm typecheck' },
        { kind: 'evidence', command: 'pnpm lint' },
      ]
    )
  )
  assert.equal(getRequestedExitCode(), 3, 'two of three expected commands are absent')
  const parsed = JSON.parse(output) as {
    missing: string[]
    failing: string[]
    rows: { capture: string; command?: string; state: string }[]
  }
  assert.deepEqual(
    [...parsed.missing].sort(),
    ['evidence:pnpm lint', 'evidence:pnpm typecheck'],
    'each absent expected command is named individually, not collapsed into one kind-level row'
  )
  assert.deepEqual(parsed.failing, [])
  const okRow = parsed.rows.find((r) => r.command === 'pnpm test')
  assert.equal(okRow?.state, 'ok', 'the one recorded, valid command still reports ok')
})

test('with --expect-command, check reports exit 0 and every row ok once all 3 of 3 expected commands are recorded — round 6 F1 fix', () => {
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'repo-gates',
      'evidence',
      'aaa0036',
      'pnpm test',
      0,
      '854 pass'
    )
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'repo-gates',
      'evidence',
      'aaa0036',
      'pnpm typecheck',
      0,
      'clean'
    )
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'repo-gates',
      'evidence',
      'aaa0036',
      'pnpm lint',
      0,
      'clean'
    )
  )
  resetExitCode()
  const output = captureStdout(() =>
    runCheck(
      ticket,
      'aaa0036',
      'repo-gates',
      ['evidence'],
      [
        { kind: 'evidence', command: 'pnpm test' },
        { kind: 'evidence', command: 'pnpm typecheck' },
        { kind: 'evidence', command: 'pnpm lint' },
      ]
    )
  )
  assert.equal(getRequestedExitCode(), 0, 'all three expected commands are recorded and valid')
  const parsed = JSON.parse(output) as { missing: string[]; failing: string[] }
  assert.deepEqual(parsed.missing, [])
  assert.deepEqual(parsed.failing, [])
})

test('with --expect-command, check reports missing per test name when 1 of 3 guard tests recorded red at this sha — the per-plan-task-key sibling, round 6 F1', () => {
  const mutationDiff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n'
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-guards',
      'red',
      'aaa0037',
      'node --test test/guard-a.test.ts',
      1,
      'it failed',
      mutationDiff
    )
  )
  resetExitCode()
  const output = captureStdout(() =>
    runCheck(
      ticket,
      'aaa0037',
      'task-guards',
      [],
      [
        { kind: 'red', command: 'node --test test/guard-a.test.ts' },
        { kind: 'red', command: 'node --test test/guard-b.test.ts' },
        { kind: 'red', command: 'node --test test/guard-c.test.ts' },
      ]
    )
  )
  assert.equal(getRequestedExitCode(), 3, 'guard b and guard c never recorded a red at this sha')
  const parsed = JSON.parse(output) as { missing: string[] }
  assert.deepEqual(
    [...parsed.missing].sort(),
    ['green', 'red:node --test test/guard-b.test.ts', 'red:node --test test/guard-c.test.ts'],
    "the two guard tests with no recorded red are named individually, not hidden behind the one that did report; green is also missing because guard-a's valid red auto-requires it"
  )
})

test('a kind named only via --expect-command joins required even when --require never names it', () => {
  resetExitCode()
  const output = captureStdout(() =>
    runCheck(ticket, 'aaa0038', 'repo-gates', [], [{ kind: 'evidence', command: 'pnpm test' }])
  )
  assert.equal(getRequestedExitCode(), 3)
  const parsed = JSON.parse(output) as { required: string[]; missing: string[] }
  assert.deepEqual(parsed.required, ['evidence'])
  assert.deepEqual(parsed.missing, ['evidence:pnpm test'])
})

test('with --expect-command, check still fails the kind on an invalid capture whose command was never named — the seventh door, round 7', () => {
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'fixture-repo-gates',
      'evidence',
      'aaa0039',
      'pnpm test',
      0,
      '854 pass'
    )
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'fixture-repo-gates',
      'evidence',
      'aaa0039',
      'pnpm lint',
      1,
      'lint failed'
    )
  )
  resetExitCode()
  const output = captureStdout(() =>
    runCheck(
      ticket,
      'aaa0039',
      'fixture-repo-gates',
      [],
      [{ kind: 'evidence', command: 'pnpm test' }]
    )
  )
  assert.equal(
    getRequestedExitCode(),
    3,
    'pnpm lint is invalid and was recorded under the same kind, even though nobody named it — naming pnpm test must not un-check its sibling'
  )
  const parsed = JSON.parse(output) as {
    failing: string[]
    rows: { capture: string; command?: string; state: string; reason?: string }[]
  }
  assert.deepEqual(
    parsed.failing,
    ['evidence:pnpm lint'],
    'the unnamed, invalid capture fails the kind under its own actual command, not silently absorbed by the named, valid one'
  )
  const namedRow = parsed.rows.find((r) => r.command === 'pnpm test')
  assert.equal(namedRow?.state, 'ok', 'the named, valid command still reports ok on its own row')
  const unnamedRow = parsed.rows.find((r) => r.command === 'pnpm lint')
  assert.equal(unnamedRow?.state, 'failing')
  assert.equal(unnamedRow?.reason, 'exit status is non-zero')
})

test('check fails every capture in a digest group when captures at the same (task, sha) share an output sidecar but assert conflicting exit statuses — the twentieth door', () => {
  const sharedOutput = 'identical output text, wrong for at least one of the two captures below'
  const mutationDiff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n'
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'door20-conflict',
      'red',
      'aaa0040',
      'node --test foo.test.ts',
      1,
      sharedOutput,
      mutationDiff
    )
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'door20-conflict',
      'green',
      'aaa0040',
      'node --test foo.test.ts',
      0,
      sharedOutput
    )
  )
  resetExitCode()
  // 'green' is named explicitly rather than left to the red/green auto-rule: a digest-conflict-invalid
  // red is not a valid red at this sha, so the auto-rule (hasValidRedAtSha) would not add 'green' to
  // `required` on its own — see the dedicated hasValidRedAtSha coverage test below for that half.
  // Naming it here keeps this test's original job: both rows, once required, come back failing under
  // the same shared-digest reason.
  const output = captureStdout(() => runCheck(ticket, 'aaa0040', 'door20-conflict', ['green']))
  assert.equal(
    getRequestedExitCode(),
    3,
    'both red and green are invalid once their shared digest asserts conflicting exit statuses'
  )
  const parsed = JSON.parse(output) as {
    failing: string[]
    rows: { capture: string; state: string; reason?: string }[]
  }
  assert.deepEqual([...parsed.failing].sort(), ['green', 'red'])
  const redRow = parsed.rows.find((r) => r.capture === 'red')
  const greenRow = parsed.rows.find((r) => r.capture === 'green')
  assert.equal(redRow?.state, 'failing')
  assert.equal(greenRow?.state, 'failing')
  assert.match(redRow?.reason ?? '', /conflicting exit statuses/)
  assert.match(greenRow?.reason ?? '', /conflicting exit statuses/)
})

test('check leaves captures alone when they share a task and sha but their output digests differ, even with different exit statuses — the twentieth door, negative control', () => {
  const mutationDiff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n'
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'door20-no-conflict',
      'red',
      'aaa0041',
      'node --test foo.test.ts',
      1,
      'the red output, distinct from the green output below',
      mutationDiff
    )
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'door20-no-conflict',
      'green',
      'aaa0041',
      'node --test foo.test.ts',
      0,
      'the green output, distinct from the red output above'
    )
  )
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, 'aaa0041', 'door20-no-conflict', []))
  assert.equal(
    getRequestedExitCode(),
    0,
    'distinct outputs asserting distinct exit statuses is the normal, valid case'
  )
  const parsed = JSON.parse(output) as { failing: string[] }
  assert.deepEqual(parsed.failing, [])
})

test('check does not demand green against a red that is only invalid because it shares a conflicting-exit-status digest with another red — the twentieth door, hasValidRedAtSha coverage', () => {
  const sharedOutput =
    'identical output text shared by two reds that disagree on their own exit status'
  const mutationDiff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n'
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'door21-red-red-conflict',
      'red',
      'aaa0042',
      'node --test foo.test.ts',
      1,
      sharedOutput,
      mutationDiff
    )
  )
  captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'door21-red-red-conflict',
      'red',
      'aaa0042',
      'node --test foo.test.ts',
      2,
      sharedOutput,
      mutationDiff
    )
  )
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, 'aaa0042', 'door21-red-red-conflict', []))
  assert.equal(getRequestedExitCode(), 3, 'the only red at this sha is digest-conflict invalid')
  const parsed = JSON.parse(output) as {
    required: string[]
    missing: string[]
    failing: string[]
    rows: { capture: string; state: string; reason?: string }[]
  }
  assert.ok(
    !parsed.required.includes('green'),
    'no valid red exists at this sha, so green must not join the required set — demanding it would ' +
      'ask for proof against a baseline the check itself just declared invalid'
  )
  assert.ok(!parsed.missing.includes('green'))
  const redRow = parsed.rows.find((r) => r.capture === 'red')
  assert.equal(redRow?.state, 'failing')
  assert.match(redRow?.reason ?? '', /conflicting exit statuses/)
})

test('check through the real CLI process accepts repeatable --expect-command, trims the command half, and reports every named row ok — round 7', async () => {
  const { repoRoot: cleanRepo, headSha: sha } = makeCleanScratchRepo()
  const recordTest = await runCli(
    [
      'proof-ledger',
      'record',
      '--ticket',
      ticket,
      '--task',
      'repo-gates',
      '--capture',
      'evidence',
      '--sha',
      sha,
      '--command',
      'pnpm test',
      '--exit',
      '0',
      '--output',
      '854 pass',
    ],
    { cwd: cleanRepo }
  )
  assert.equal(recordTest.exitCode, 0)
  const recordTypecheck = await runCli(
    [
      'proof-ledger',
      'record',
      '--ticket',
      ticket,
      '--task',
      'repo-gates',
      '--capture',
      'evidence',
      '--sha',
      sha,
      '--command',
      'pnpm typecheck',
      '--exit',
      '0',
      '--output',
      'clean',
    ],
    { cwd: cleanRepo }
  )
  assert.equal(recordTypecheck.exitCode, 0)

  const checkResult = await runCli([
    'proof-ledger',
    'check',
    '--ticket',
    ticket,
    '--sha',
    sha,
    '--task',
    'repo-gates',
    '--require',
    'evidence',
    '--expect-command',
    'evidence: pnpm test',
    '--expect-command',
    'evidence:pnpm typecheck',
  ])
  assert.doesNotMatch(checkResult.stderr, /\n\s*at /, 'no uncaught-exception stack trace on stderr')
  assert.equal(
    checkResult.exitCode,
    0,
    'the space after the colon in "evidence: pnpm test" must still match the capture recorded as "pnpm test" — the parser trims the command half exactly as --command itself is trimmed'
  )
  const parsed = JSON.parse(checkResult.stdout) as { missing: string[]; failing: string[] }
  assert.deepEqual(parsed.missing, [])
  assert.deepEqual(parsed.failing, [])
})

test('record refuses a non-zero --exit for a non-red kind under a real task key — the reserved-key convention, round 7', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'review-rules-argv-check',
      'evidence',
      'aaa0042',
      'bash -n vs argv-stub check on unquoted placeholder',
      1,
      'a deliberate counter-example demonstrating the old check’s blind spot'
    )
  )
  assert.equal(
    getRequestedExitCode(),
    6,
    'a deliberately-invalid capture under a real task key would poison that key’s coverage forever — record must refuse it'
  )
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /fixture-/)
  assert.equal(
    existsSync(proofLedgerPath(ticket)),
    false,
    'the refused record must not create the ledger file at all'
  )
})

test('record accepts a non-zero --exit for a non-red kind under a fixture-prefixed task key — round 7', () => {
  resetExitCode()
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'fixture-review-rules-argv-check',
      'evidence',
      'aaa0042',
      'bash -n vs argv-stub check on unquoted placeholder',
      1,
      'a deliberate counter-example demonstrating the old check’s blind spot'
    )
  )
  assert.notEqual(
    getRequestedExitCode(),
    6,
    'a fixture-prefixed task key is exactly what the reserved-key convention exists to allow'
  )
  const parsed = JSON.parse(output) as { id: string }
  assert.equal(typeof parsed.id, 'string')
  assert.equal(
    existsSync(proofLedgerPath(ticket)),
    true,
    'the accepted record must land in the ledger'
  )
})

test('record still refuses a non-zero --exit for red without --mutation-file even under a fixture-prefixed task — round 7', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'fixture-something',
      'red',
      'aaa0042',
      'pnpm test',
      1,
      'it failed'
    )
  )
  assert.equal(
    getRequestedExitCode(),
    6,
    'the reserved-key carve-out is for non-red kinds only — red keeps its own, stricter --mutation-file requirement regardless of task prefix'
  )
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /--mutation-file/)
})

test('record accepts a non-zero --exit for sweep under a real task key — the zero-match sweep escape, round 8 (record half)', () => {
  const command = 'grep -rn "zzz_no_such_symbol_zzz" tools/cli/src/'
  const sweepOutput = 'no matches'
  const output = captureStdout(() =>
    runRecord(NO_REPO_ROOT_CHECK, ticket, 'task-1', 'sweep', 'aaa0043', command, 1, sweepOutput)
  )
  assert.equal(
    getRequestedExitCode(),
    0,
    "a zero-match sweep is the canonical defect-class-now-absent result — grep's own exit 1 for no matches must not be refused under a real task key"
  )
  const parsed = JSON.parse(output) as { id: string }
  const outputSha256 = createHash('sha256').update(sweepOutput).digest('hex')
  assert.equal(parsed.id, captureId('task-1', 'sweep', 'aaa0043', command, outputSha256))
})

test('check reports a zero-match sweep as ok, not failing — the zero-match sweep escape, round 8 (check half)', () => {
  runRecord(
    NO_REPO_ROOT_CHECK,
    ticket,
    'task-1',
    'sweep',
    'aaa0043',
    'grep -rn "zzz_no_such_symbol_zzz" tools/cli/src/',
    1,
    'no matches'
  )
  const output = captureStdout(() => runCheck(ticket, 'aaa0043', 'task-1', ['sweep']))
  assert.equal(
    getRequestedExitCode(),
    0,
    "an all-ok check must not carry check's own exit-3 failure code"
  )
  const parsed = JSON.parse(output) as {
    rows: { capture: string; state: string }[]
    missing: string[]
    failing: string[]
  }
  assert.deepEqual(parsed.missing, [])
  assert.deepEqual(parsed.failing, [])
  assert.equal(parsed.rows.length, 1, 'exactly one row for the single required sweep kind')
  assert.equal(parsed.rows[0]?.state, 'ok')
})

test('record refuses a non-zero --exit for sweep under a real task key when exit is 2 or higher — the tool-failed-to-run case, round 9 F3', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'sweep',
      'aaa0044',
      'grep -rn x tools/cli/src/no-such-dir/',
      2,
      'grep: tools/cli/src/no-such-dir/: No such file or directory'
    )
  )
  assert.equal(
    getRequestedExitCode(),
    6,
    'exit 2 or higher means grep itself failed to run — the same "point vs bug" ambiguity the reserved-key guard exists to prevent, not the zero-match convention'
  )
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /sweep with --exit 1/)
})

test('check reports a sweep with exit status 2 as failing, not ok — round 9 F3 (legacy ledger-bypass path: record now refuses this at the source)', () => {
  appendSweepCaptureWithExitStatus('task-1', 'aaa0045', 2)
  const output = captureStdout(() => runCheck(ticket, 'aaa0045', 'task-1', ['sweep']))
  const parsed = JSON.parse(output) as {
    rows: { capture: string; state: string }[]
    failing: string[]
  }
  assert.deepEqual(parsed.failing, ['sweep'])
  assert.equal(parsed.rows.length, 1)
  assert.equal(parsed.rows[0]?.state, 'failing')
})

test('check explains a failing sweep capture with the git-grep caveat, not a bare grep/rg guarantee — round 10 F3 (legacy ledger-bypass path: record now refuses this at the source)', () => {
  appendSweepCaptureWithExitStatus('task-1', 'aaa0046', 2)
  const output = captureStdout(() => runCheck(ticket, 'aaa0046', 'task-1', ['sweep']))
  const parsed = JSON.parse(output) as {
    rows: { capture: string; state: string; reason?: string }[]
    failing: string[]
  }
  assert.equal(getRequestedExitCode(), 3, 'a failing required kind exits 3, same as a missing one')
  assert.deepEqual(parsed.failing, ['sweep'])
  assert.equal(parsed.rows.length, 1, 'exactly one row for the single required sweep kind')
  assert.equal(
    parsed.rows[0]?.reason,
    'sweep exit status is neither 0 (match found) nor 1 (no-match convention for grep/rg — not sound for `git grep`, which also uses 1 for some of its own errors) — 2 or higher means the tool itself failed to run, not that the defect class is absent'
  )
})

test('record refuses rather than silently shortens an oversized --command, as its own documented exit 6, not the generic exit 9 — round 11, senior follow-up', () => {
  const hugeCommand = `grep -rn x ${'a'.repeat(4_300)}`
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'sweep',
      'aaa0047',
      hugeCommand,
      1,
      'small output'
    )
  )
  assert.equal(
    getRequestedExitCode(),
    6,
    'a specified, reachable, tested refusal belongs under exit 6 with the rest of --record\'s input refusals, not the generic "unexpected error" exit 9 — a caller must be able to tell "you gave record input it refuses" apart from "the tool broke"'
  )
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /--command this large cannot fit the ledger line budget/)

  assert.equal(
    existsSync(proofLedgerPath(ticket)),
    false,
    'a refused record must not append any line to the ledger'
  )
})

test('record surfaces a shortened --note on stdout at record time, and the stored note is actually shorter — round 11', () => {
  const hugeNote = `START-MARKER${'n'.repeat(5_000)}`
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'sweep',
      'aaa0048',
      'grep -rn x .',
      1,
      'small output',
      undefined,
      hugeNote
    )
  )
  assert.equal(getRequestedExitCode(), 0, 'a shortened note is a surfaced warning, not a refusal')
  const parsed = JSON.parse(output) as { warning?: string }
  assert.match(
    parsed.warning ?? '',
    /--note was shortened to fit the ledger line's 4096-byte budget/
  )

  const ledgerRaw = readFileSync(proofLedgerPath(ticket), 'utf-8')
  const stored = JSON.parse(ledgerRaw.trim()) as { note?: string; tail: string }
  assert.ok(
    (stored.note?.length ?? 0) < hugeNote.length,
    'the stored note must actually be shorter than what was passed'
  )
  assert.equal(
    stored.tail,
    'small output',
    'tail must survive untouched when note alone was over budget'
  )
})

test('record does not warn when --note comfortably fits the line budget — round 11, a control against a warning that fires unconditionally', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'sweep',
      'aaa0049',
      'grep -rn x .',
      1,
      'small output',
      undefined,
      'a short note'
    )
  )
  assert.equal(getRequestedExitCode(), 0)
  const parsed = JSON.parse(output) as { warning?: string }
  assert.equal(
    parsed.warning,
    undefined,
    'a note well within budget must not be reported as shortened'
  )
})

// record --repo-root — the sha/tree-mismatch gap, and the reverse-apply check for a
// red capture's mutation evidence. A
// non-red --sha alone cannot certify that the working tree still matches its committed tree, and a
// red capture's --mutation-file alone cannot certify that it describes the tree --sha actually
// names — a --mutation-file generated against an earlier state and carried forward onto a later,
// re-stamped --sha is the same caller-typed gap under a different capture kind. The mutation
// fixture below is dashCPayloadIndex's real mutation (the one door22-dash-c-bundled-flags's
// mis-stamped captures were actually taken against), sidecar content copied verbatim, applied to a
// throwaway repo rather than to this checkout.
const dashCPayloadIndexBaseline =
  '// argument word (`--rcfile /path -c …`) is not modelled and stops the scan at that argument, the same\n' +
  '// false-negative shape as an unrecognized flag.\n' +
  'const dashCPayloadIndex = (words: readonly ShellWord[], start: number): number | undefined => {\n' +
  '  for (let i = start; i < words.length; i++) {\n' +
  '    const text = words[i]!.text\n' +
  '    if (DASH_C_FLAG.test(text)) return i + 1 < words.length ? i + 1 : undefined\n' +
  '    if (!/^-[a-zA-Z-]+$/.test(text)) return undefined\n' +
  '  }\n' +
  '  return undefined\n' +
  '}\n'

const dashCPayloadIndexMutated =
  '// argument word (`--rcfile /path -c …`) is not modelled and stops the scan at that argument, the same\n' +
  '// false-negative shape as an unrecognized flag.\n' +
  'const dashCPayloadIndex = (words: readonly ShellWord[], start: number): number | undefined => {\n' +
  '  const text = words[start]?.text\n' +
  "  if (text === '-c') return start + 1 < words.length ? start + 1 : undefined\n" +
  '  return undefined\n' +
  '}\n'

// reproducibility.ts no longer exists (deleted when proof-ledger's require and audit commands were
// cut) — this path and the diff headers below that name it are frozen fixture content from when
// the mutation was real, not a claim that the file is still there.
const dashCPayloadIndexRelPath = 'tools/cli/src/proof-ledger/reproducibility.ts'

// baseline -> mutated, generated by a real `git diff` against exactly those two literals (not
// hand-typed) so its hunk header's line counts are guaranteed to match its body.
const dashCPayloadIndexMutationDiff =
  'diff --git a/tools/cli/src/proof-ledger/reproducibility.ts b/tools/cli/src/proof-ledger/reproducibility.ts\n' +
  'index 58fa752..49346b1 100644\n' +
  '--- a/tools/cli/src/proof-ledger/reproducibility.ts\n' +
  '+++ b/tools/cli/src/proof-ledger/reproducibility.ts\n' +
  '@@ -1,10 +1,7 @@\n' +
  ' // argument word (`--rcfile /path -c …`) is not modelled and stops the scan at that argument, the same\n' +
  ' // false-negative shape as an unrecognized flag.\n' +
  ' const dashCPayloadIndex = (words: readonly ShellWord[], start: number): number | undefined => {\n' +
  '-  for (let i = start; i < words.length; i++) {\n' +
  '-    const text = words[i]!.text\n' +
  '-    if (DASH_C_FLAG.test(text)) return i + 1 < words.length ? i + 1 : undefined\n' +
  '-    if (!/^-[a-zA-Z-]+$/.test(text)) return undefined\n' +
  '-  }\n' +
  '+  const text = words[start]?.text\n' +
  "+  if (text === '-c') return start + 1 < words.length ? start + 1 : undefined\n" +
  '   return undefined\n' +
  ' }\n'

// Derived from, but not identical to, door22-dash-c-bundled-flags's real mutation sidecar — that
// capture is well-formed (header 11/8, body 11/8) and is a door-28 mis-stamp, not
// one of door 30's four corrupt captures. Hand-transcribing it into this TS string literal dropped its
// one whitespace-only context line (a line whose only content is a single space, trivial to drop when
// typing a diff by hand and nothing checks the copy against the original), leaving this literal's own
// body short of what its header claims (11/8), accounting for only 10/7. That divergence is what makes
// it useful here: a genuine corrupt diff, kept as-is, to exercise the corruption refusal below
// distinctly from the mismatch refusal above.
const dashCPayloadIndexTruncatedMutationDiff =
  'diff --git a/tools/cli/src/proof-ledger/reproducibility.ts b/tools/cli/src/proof-ledger/reproducibility.ts\n' +
  'index 0f0c0fc..7e55749 100644\n' +
  '--- a/tools/cli/src/proof-ledger/reproducibility.ts\n' +
  '+++ b/tools/cli/src/proof-ledger/reproducibility.ts\n' +
  '@@ -452,11 +452,8 @@ const DASH_C_FLAG = /^-[a-z]*c$/\n' +
  ' // argument word (`--rcfile /path -c …`) is not modelled and stops the scan at that argument, the same\n' +
  ' // false-negative shape as an unrecognized flag.\n' +
  ' const dashCPayloadIndex = (words: readonly ShellWord[], start: number): number | undefined => {\n' +
  '-  for (let i = start; i < words.length; i++) {\n' +
  '-    const text = words[i]!.text\n' +
  '-    if (DASH_C_FLAG.test(text)) return i + 1 < words.length ? i + 1 : undefined\n' +
  '-    if (!/^-[a-zA-Z-]+$/.test(text)) return undefined\n' +
  '-  }\n' +
  '+  const text = words[start]?.text\n' +
  "+  if (text === '-c') return start + 1 < words.length ? start + 1 : undefined\n" +
  '   return undefined\n' +
  ' }\n'

// The `runAudit` reshape's real mutation sidecar, unrelated to dashCPayloadIndex — a frozen diff
// payload, not a test of the long-since-removed `runAudit` function it happens to quote. Used to
// exercise the "neither direction reverse-applies" refusal against preReshapeResultsLiteral below,
// another frozen literal of that same historical body, neither side of which this diff's hunk still
// matches.
const reshapedMutationDiff =
  'diff --git a/tools/cli/src/proof-ledger/run.ts b/tools/cli/src/proof-ledger/run.ts\n' +
  'index 6918a2c..e8d0fcd 100644\n' +
  '--- a/tools/cli/src/proof-ledger/run.ts\n' +
  '+++ b/tools/cli/src/proof-ledger/run.ts\n' +
  '@@ -501,8 +501,9 @@ export const runAudit = (ticket: string, sha: string): void =>\n' +
  ' \n' +
  '     const results = tasks.map((task) => {\n' +
  '       const declared = ledger.requirements.filter((r) => r.task === task)\n' +
  '-      const required = [...new Set(declared.flatMap((r) => r.required))]\n' +
  '-      const expectCommands = dedupeExpectCommands(declared.flatMap((r) => r.expectCommands))\n' +
  '+      const latest = declared[declared.length - 1]!\n' +
  '+      const required = latest.required\n' +
  '+      const expectCommands = dedupeExpectCommands(latest.expectCommands)\n' +
  '       return checkTask(ledger, task, sha, required, expectCommands)\n' +
  '     })\n' +
  ' \n'

// A frozen literal of `runAudit`'s per-task results.map body as it read before the reshape above,
// retained only as diff payload for the mutation-mismatch test below — `runAudit` itself no
// longer exists.
const preReshapeResultsLiteral =
  '\n' +
  '    const results = tasks.map((task) => {\n' +
  '      const declared = ledger.requirements.filter((r) => r.task === task)\n' +
  '      const required = [...new Set(declared.flatMap((r) => r.required))]\n' +
  '      const expectCommands = dedupeExpectCommands(declared.flatMap((r) => r.expectCommands))\n' +
  '      const checkResult = checkTask(ledger, task, sha, required, expectCommands)\n' +
  '      const outOfOrder = orderingViolations(ledger, task, declared)\n' +
  '      const unreproducible = unreproducibleCaptures(ledger, task, repoRoot, baseRef)\n' +
  '      return { ...checkResult, outOfOrder, unreproducible }\n' +
  '    })\n' +
  '\n'

// dashCPayloadIndexMutationDiff's own hunk body, reused verbatim, with each header path written
// `./`-prefixed instead of `a/`/`b/`-prefixed — the same real file, a header form join() normalizes
// away but a string-equality comparison against git status's output would not.
const dashCPayloadIndexDotSlashMutationDiff =
  '--- ./tools/cli/src/proof-ledger/reproducibility.ts\n' +
  '+++ ./tools/cli/src/proof-ledger/reproducibility.ts\n' +
  '@@ -1,10 +1,7 @@\n' +
  ' // argument word (`--rcfile /path -c …`) is not modelled and stops the scan at that argument, the same\n' +
  ' // false-negative shape as an unrecognized flag.\n' +
  ' const dashCPayloadIndex = (words: readonly ShellWord[], start: number): number | undefined => {\n' +
  '-  for (let i = start; i < words.length; i++) {\n' +
  '-    const text = words[i]!.text\n' +
  '-    if (DASH_C_FLAG.test(text)) return i + 1 < words.length ? i + 1 : undefined\n' +
  '-    if (!/^-[a-zA-Z-]+$/.test(text)) return undefined\n' +
  '-  }\n' +
  '+  const text = words[start]?.text\n' +
  "+  if (text === '-c') return start + 1 < words.length ? start + 1 : undefined\n" +
  '   return undefined\n' +
  ' }\n'

// A diff with no `diff --git` line and both header sides /dev/null — a shape isMutationDiff accepts
// (it never inspects header content, only that a header pair and a real +/- hunk exist) but
// splitDiffByFile resolves to zero sections for, since headerPathsFromSection maps both /dev/null
// sides to undefined.
const bothSidesDevNullMutationDiff =
  '--- /dev/null\n' + '+++ /dev/null\n' + '@@ -1 +1 @@\n' + '-old line\n' + '+new line\n'

// A diff whose header lines carry no path at all — a real +/- hunk, but "--- " and "+++ " with
// nothing after them, not even "/dev/null". Both hasDiffHeader (isMutationDiff) and this zero-section
// shape are identical to bothSidesDevNullMutationDiff's, but the string "/dev/null" appears nowhere
// in it — the message must name the observed condition, not one specific cause.
const bareHeaderNoPathMutationDiff = '--- \n+++ \n@@ -1 +1 @@\n-old line\n+new line\n'

// A diff naming a file no fixture ever creates or tracks — resolveUnderRepoRoot cannot resolve it,
// so redMutationMismatch must skip it as unverifiable rather than refuse.
const unresolvablePathMutationDiff =
  '--- a/nonexistent/unrelated-file.ts\n' +
  '+++ b/nonexistent/unrelated-file.ts\n' +
  '@@ -1 +1 @@\n' +
  '-old line\n' +
  '+new line\n'

// The repo-real-path-on-MINUS shape: the repo-real path is on the MINUS side, an external scratch
// path (not /dev/null) is on the PLUS side — the opposite of resolveUnderRepoRoot's old single-side
// preference. Header lines copy the real sidecar shape byte-for-byte — no `a/`/`b/`
// prefix, a tab-and-timestamp suffix on each side, `diff --git`/`index` omitted — but the hunk body
// below is dashCPayloadIndexMutationDiff's, reused for convenience, not a copy of the real sidecar's
// (larger) hunk. Its MINUS-side path, like dashCPayloadIndexRelPath above, names
// reproducibility.ts, deleted when proof-ledger's require and audit commands were cut — frozen
// fixture content, not a claim the file exists.
const dashCPayloadIndexMinusSideRepoMutationDiff =
  '--- tools/cli/src/proof-ledger/reproducibility.ts\t2026-08-30 16:14:29\n' +
  '+++ /tmp/flow287-mutations/dash-c-scratch.ts\t2026-08-30 16:14:29\n' +
  '@@ -1,10 +1,7 @@\n' +
  ' // argument word (`--rcfile /path -c …`) is not modelled and stops the scan at that argument, the same\n' +
  ' // false-negative shape as an unrecognized flag.\n' +
  ' const dashCPayloadIndex = (words: readonly ShellWord[], start: number): number | undefined => {\n' +
  '-  for (let i = start; i < words.length; i++) {\n' +
  '-    const text = words[i]!.text\n' +
  '-    if (DASH_C_FLAG.test(text)) return i + 1 < words.length ? i + 1 : undefined\n' +
  '-    if (!/^-[a-zA-Z-]+$/.test(text)) return undefined\n' +
  '-  }\n' +
  '+  const text = words[start]?.text\n' +
  "+  if (text === '-c') return start + 1 < words.length ? start + 1 : undefined\n" +
  '   return undefined\n' +
  ' }\n'

/**
 * A throwaway repo, committed clean at dashCPayloadIndex's real baseline; returns { repoRoot, cleanSha }.
 * origin/main is set to an empty commit one behind cleanSha, so the sweep-scope tests among this
 * fixture's callers see dashCPayloadIndexRelPath as a changed file with a licensed scope of '.' —
 * every other caller (red-capture tests) never reads origin/main and is unaffected by the extra ref.
 */
const dashCPayloadIndexFixtureRepo = (): { repoRoot: string; cleanSha: string } => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'proof-ledger-record-dirty-test-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'trunk')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('commit', '-q', '--allow-empty', '-m', 'empty root')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  const filePath = join(repoRoot, dashCPayloadIndexRelPath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, dashCPayloadIndexBaseline)
  git('add', dashCPayloadIndexRelPath)
  git('commit', '-q', '-m', 'baseline')
  return { repoRoot, cleanSha: git('rev-parse', 'HEAD') }
}

/**
 * A throwaway repo tracking two files, `a.txt` and `b.txt`, each committed clean at a one-line
 * baseline; returns { repoRoot, cleanSha }. Exists for the multi-section --mutation-file tests
 * below, which need at least two files to put a non-final section under test (B2).
 */
const twoFileFixtureRepo = (): { repoRoot: string; cleanSha: string } => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'proof-ledger-record-two-file-test-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'trunk')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(repoRoot, 'a.txt'), 'line-a\n')
  writeFileSync(join(repoRoot, 'b.txt'), 'line-b\n')
  git('add', 'a.txt', 'b.txt')
  git('commit', '-q', '-m', 'baseline')
  return { repoRoot, cleanSha: git('rev-parse', 'HEAD') }
}

// Two `diff --git` sections, a.txt then b.txt, each a real one-line mutation against
// twoFileFixtureRepo's baseline. a.txt is the non-final section — the one the pre-fix
// line-split-then-array-join reconstruction corrupted by dropping the newline that separated it
// from b.txt's header (B2).
const twoFileMutationDiff =
  'diff --git a/a.txt b/a.txt\n' +
  '--- a/a.txt\n' +
  '+++ b/a.txt\n' +
  '@@ -1 +1 @@\n' +
  '-line-a\n' +
  '+line-a-mutated\n' +
  'diff --git a/b.txt b/b.txt\n' +
  '--- a/b.txt\n' +
  '+++ b/b.txt\n' +
  '@@ -1 +1 @@\n' +
  '-line-b\n' +
  '+line-b-mutated\n'

// The same two-section shape, but a.txt's own header names a path this repo never tracked —
// unresolvable, the way `unresolvablePathMutationDiff` is above — while b.txt, the final section,
// is real. Exercises B3 in a multi-section diff: the unresolved non-final section
// must be named correctly in `unverifiedMutationPaths` and must not stop the real, final section from
// being read. It is not B2 coverage — the ghost section's own text is never reverse-applied, so B2's
// newline-loss bug (which corrupts a non-final section's own trailing newline) has nothing to corrupt
// that this test would observe; B2's regression coverage is the "both matching" test below, where
// both sections are actually reverse-applied.
const ghostThenRealMutationDiff =
  'diff --git a/ghost.txt b/ghost.txt\n' +
  '--- a/ghost.txt\n' +
  '+++ b/ghost.txt\n' +
  '@@ -1 +1 @@\n' +
  '-ghost-line\n' +
  '+ghost-line-mutated\n' +
  'diff --git a/b.txt b/b.txt\n' +
  '--- a/b.txt\n' +
  '+++ b/b.txt\n' +
  '@@ -1 +1 @@\n' +
  '-line-b\n' +
  '+line-b-mutated\n'

// The same two-section shape as twoFileMutationDiff — identical hunk bodies — but with every
// `diff --git`/`---`/`+++` line's `a/`/`b/` label swapped, matching a real anomaly found by the
// class-2 sweep (`review-ledger`, this round): real captures hold a hand-composed
// live-to-known-good diff with `diff --git b/<path> a/<path>` — the reverse of what a real `git diff`
// ever writes (below, "record verifies a red capture whose --mutation-file spans two files, every
// diff --git line with a/b reversed — class-2 sweep finding"). Those real captures are all
// single-file, so the old `DIFF_GIT_HEADER` (requiring literal `a/`-then-`b/`) silently fell through
// to the single-section fallback and still resolved by accident. This fixture is multi-file, where
// that same fallthrough would have collapsed both sections into one and read only a.txt's pair.
const reversedDiffGitHeaderMutationDiff =
  'diff --git b/a.txt a/a.txt\n' +
  '--- b/a.txt\n' +
  '+++ a/a.txt\n' +
  '@@ -1 +1 @@\n' +
  '-line-a\n' +
  '+line-a-mutated\n' +
  'diff --git b/b.txt a/b.txt\n' +
  '--- b/b.txt\n' +
  '+++ a/b.txt\n' +
  '@@ -1 +1 @@\n' +
  '-line-b\n' +
  '+line-b-mutated\n'

// 200 single-line sections, each naming a path nothing under any fixture repo ever tracks — every
// section resolves to an unverified entry (B3's fails-open behavior), so the persisted
// unverifiedMutationPaths array alone runs well past MAX_LINE_BYTES (4096) even with --command and
// --output tiny and no --note at all.
const manyGhostSectionsMutationDiff = Array.from({ length: 200 }, (_, i) => {
  const path = `ghost/nonexistent-path-${String(i).padStart(4, '0')}.txt`
  return (
    `diff --git a/${path} b/${path}\n` +
    `--- a/${path}\n` +
    `+++ b/${path}\n` +
    '@@ -1 +1 @@\n' +
    '-ghost-line\n' +
    '+ghost-line-mutated\n'
  )
}).join('')

// Names only a.txt — the fixture for the B5 dirty-tree-outside-mutation test below,
// where b.txt is left dirty without ever being named by --mutation-file.
const aOnlyMutationDiff =
  'diff --git a/a.txt b/a.txt\n' +
  '--- a/a.txt\n' +
  '+++ b/a.txt\n' +
  '@@ -1 +1 @@\n' +
  '-line-a\n' +
  '+line-a-mutated\n'

test('record refuses a non-red capture at --repo-root whose working tree is dirty — the sha/tree-mismatch gap', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'green',
        cleanSha,
        'pnpm test',
        0,
        'it passed'
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'a green capture taken while the working tree is dirty must refuse'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /uncommitted/)
    assert.match(parsed.error, new RegExp(cleanSha))
    assert.equal(
      existsSync(proofLedgerPath(ticket)),
      false,
      'the refused record must not create the ledger file at all'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record accepts a non-red capture at --repo-root whose working tree is clean', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'green',
        cleanSha,
        'pnpm test',
        0,
        'it passed'
      )
    )
    assert.equal(getRequestedExitCode(), 0, 'a clean working tree must not be refused')
    const parsed = JSON.parse(output) as { id: string }
    assert.equal(typeof parsed.id, 'string')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record refuses a non-red capture whose --sha names a commit other than the one actually checked out, even though the working tree is clean — the non-red half of the sha/tree-mismatch gap', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  try {
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)
    git('commit', '-a', '-q', '-m', 'the fix')
    const fixSha = git('rev-parse', 'HEAD')
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'green',
        cleanSha,
        'pnpm test',
        0,
        'it passed'
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'a clean tree checked out at a different commit than --sha must still be refused'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, new RegExp(fixSha))
    assert.match(parsed.error, new RegExp(cleanSha))
    assert.equal(
      existsSync(proofLedgerPath(ticket)),
      false,
      'the refused record must not create the ledger file at all'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test("record accepts a non-red capture at --repo-root whose working tree is dirty, when --sha-is-label says --command never reads the tree — the sha/tree-mismatch gap's opt-out, dirty-tree half", () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'evidence',
        cleanSha,
        'ps -p 12345',
        0,
        'no such process',
        undefined,
        undefined,
        true
      )
    )
    assert.equal(
      getRequestedExitCode(),
      0,
      '--sha-is-label must skip the dirty-tree refusal for a capture that never reads the tree'
    )
    const parsed = JSON.parse(output) as { id: string }
    assert.equal(typeof parsed.id, 'string')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test("record accepts a non-red capture whose --sha names a commit other than the one checked out, when --sha-is-label says --command never reads the tree — the sha/tree-mismatch gap's opt-out, checked-out-commit half", () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  try {
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)
    git('commit', '-a', '-q', '-m', 'the fix')
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'evidence',
        cleanSha,
        'ps -p 12345',
        0,
        'no such process',
        undefined,
        undefined,
        true
      )
    )
    assert.equal(
      getRequestedExitCode(),
      0,
      '--sha-is-label must skip the checked-out-commit refusal for a capture that never reads the tree'
    )
    const parsed = JSON.parse(output) as { id: string }
    assert.equal(typeof parsed.id, 'string')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test("record accepts a non-red capture without --sha-is-label when --sha is exactly the commit checked out — the over-broad-guard regression for Team Cleanup step 7's $(git rev-parse HEAD) call", () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'evidence',
        cleanSha,
        'ai-workflow-app session list',
        0,
        'lifecycle: ended'
      )
    )
    assert.equal(
      getRequestedExitCode(),
      0,
      'the checked-out-commit guard must not refuse a capture whose --sha genuinely matches the commit checked out — the case a widened guard would break first'
    )
    const parsed = JSON.parse(output) as { id: string }
    assert.equal(typeof parsed.id, 'string')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record persists --sha-is-label on the capture line itself, not only as a one-time influence on the refusal check at record time', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    const recordOutput = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'evidence',
        cleanSha,
        'ai-workflow-app session list',
        0,
        'lifecycle: ended',
        undefined,
        undefined,
        true
      )
    )
    const { id } = JSON.parse(recordOutput) as { id: string }

    const showOutput = captureStdout(() => runShow(ticket, undefined, undefined, undefined, id))
    const { captures } = JSON.parse(showOutput) as {
      captures: { id: string; shaIsLabel?: boolean }[]
    }
    assert.equal(captures.length, 1)
    assert.equal(
      captures[0]!.shaIsLabel,
      true,
      'a later read of the ledger must be able to enumerate this as a non-tree-reading capture, not just whoever watched record run at capture time'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record does not persist shaIsLabel on a capture that never declared it', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    const recordOutput = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'green',
        cleanSha,
        'pnpm test',
        0,
        'it passed'
      )
    )
    const { id } = JSON.parse(recordOutput) as { id: string }

    const showOutput = captureStdout(() => runShow(ticket, undefined, undefined, undefined, id))
    const { captures } = JSON.parse(showOutput) as {
      captures: { id: string; shaIsLabel?: boolean }[]
    }
    assert.equal(captures.length, 1)
    assert.equal(
      captures[0]!.shaIsLabel,
      undefined,
      'a tree-certifying capture must not carry the label declaration at all'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record refuses --sha-is-label on a red capture — it contradicts unverifiedMutationPaths, the tree-tied proof a red carries', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        undefined,
        undefined,
        true
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'a red capture must not be allowed to declare --sha-is-label'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /--sha-is-label cannot be declared on a red capture/)
    assert.equal(
      existsSync(proofLedgerPath(ticket)),
      false,
      'the refused record must not create the ledger file at all'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record refuses --sha-is-label on a green capture — green is by definition a run made against the tree', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'green',
        cleanSha,
        'pnpm test',
        0,
        'it passed',
        undefined,
        undefined,
        true
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'a green capture must not be allowed to declare --sha-is-label'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /--sha-is-label cannot be declared on a green capture/)
    assert.equal(
      existsSync(proofLedgerPath(ticket)),
      false,
      'the refused record must not create the ledger file at all'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record still accepts --sha-is-label on a sweep capture — the regression row for the red/green refusal above', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'sweep',
        cleanSha,
        'grep -rn "kill -0" .',
        1,
        'no match',
        undefined,
        undefined,
        true
      )
    )
    assert.equal(
      getRequestedExitCode(),
      0,
      'sweep must not be caught by the red/green-only refusal above'
    )
    const parsed = JSON.parse(output) as { id: string }
    assert.equal(typeof parsed.id, 'string')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('a --sha-is-label sweep with no --scope records in check mode — a label sweep reads no tree and carries no scope', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'sweep',
        cleanSha,
        'grep -rn "kill -0" .',
        1,
        'no match',
        undefined,
        undefined,
        true
      )
    )
    assert.equal(getRequestedExitCode(), 0)
    const showOutput = captureStdout(() => runShow(ticket, cleanSha))
    const parsed = JSON.parse(showOutput) as { captures: { scope?: string[] }[] }
    assert.equal(parsed.captures[0]?.scope, undefined, 'a label sweep must not carry a scope field')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record refuses --scope with --sha-is-label on a sweep capture — a label sweep reads live state, not the tree at --sha', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'sweep',
        cleanSha,
        'grep -rn "kill -0" .',
        1,
        'no match',
        undefined,
        undefined,
        true,
        ['.']
      )
    )
    assert.equal(getRequestedExitCode(), 6)
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /refused with --sha-is-label/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record still accepts --sha-is-label on an evidence capture — the regression row for the red/green refusal above', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'evidence',
        cleanSha,
        'ai-workflow-app session list',
        0,
        'lifecycle: ended',
        undefined,
        undefined,
        true
      )
    )
    assert.equal(
      getRequestedExitCode(),
      0,
      'evidence must not be caught by the red/green-only refusal above'
    )
    const parsed = JSON.parse(output) as { id: string }
    assert.equal(typeof parsed.id, 'string')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record refuses --sha-is-label on a fabricated, non-resolving --sha — the label exempts a capture from the tree-content checks, never from --sha naming a real commit', () => {
  const { repoRoot } = dashCPayloadIndexFixtureRepo()
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'sweep',
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        'grep -rn "kill -0" .',
        1,
        'no match',
        undefined,
        undefined,
        true
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'a --sha-is-label capture must still refuse a --sha that does not resolve to a commit'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /does not resolve to a commit/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record refuses a non-resolving --sha with a message naming both the sha and the repo root as possible causes, not just the sha', () => {
  const { repoRoot } = dashCPayloadIndexFixtureRepo()
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'evidence',
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        'ai-workflow-app session list',
        0,
        'lifecycle: ended',
        undefined,
        undefined,
        true
      )
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(
      parsed.error,
      /either the sha names nothing there, or .+ is not a git repository/,
      'the refusal must name both possible causes rather than blaming the sha alone'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record refuses a green capture at a dirty tree without offering --sha-is-label, since green always refuses that flag', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'green',
        cleanSha,
        'pnpm test',
        0,
        'it passed'
      )
    )
    assert.equal(getRequestedExitCode(), 6, 'a green at a dirty tree must still refuse')
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /uncommitted/)
    assert.doesNotMatch(
      parsed.error,
      /itself, or pass --sha-is-label/,
      'the message must not offer --sha-is-label as an unqualified third option — a green will ' +
        'always be refused for declaring it'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record still suggests --sha-is-label to a sweep capture refused at a dirty tree — the regression row for the green-vs-sweep --sha-is-label distinction', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'sweep',
        cleanSha,
        'grep -rn "kill -0" .',
        1,
        'no match',
        undefined,
        undefined,
        false,
        ['.']
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'a sweep at a dirty tree without the flag must still refuse'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /uncommitted/)
    assert.match(
      parsed.error,
      /for a sweep or evidence capture, pass --sha-is-label/,
      'sweep can actually use the flag, so the message must still offer it, scoped to the kinds ' +
        'that can'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test("record still suggests --sha-is-label to a sweep capture refused at the checked-out-commit path — the checked-out-commit path's own regression row for the green-vs-sweep --sha-is-label distinction", () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  try {
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)
    git('commit', '-a', '-q', '-m', 'the fix')
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'sweep',
        cleanSha,
        'grep -rn "kill -0" .',
        1,
        'no match',
        undefined,
        undefined,
        false,
        ['.']
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'a sweep at a clean tree checked out at a different commit than --sha must still be refused'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(
      parsed.error,
      /checked out, not --sha/,
      'this row must exercise the checked-out-commit guard, not the dirty-tree one'
    )
    assert.match(
      parsed.error,
      /for a sweep or evidence capture, pass --sha-is-label/,
      'sweep can actually use the flag at the checked-out-commit path too, so this message must ' +
        'independently carry the qualified phrasing — unqualifying it alone must not go unnoticed'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record accepts a red capture whose --mutation-file reverse-applies to exactly what --sha names', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        dashCPayloadIndexMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      0,
      'reversing the mutation recovers exactly what cleanSha committed'
    )
    const parsed = JSON.parse(output) as { id: string }
    assert.equal(typeof parsed.id, 'string')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record refuses a red capture whose --sha names a tree neither side of --mutation-file reverse-applies to — the neither-side-reverse-applies shape', () => {
  const { repoRoot } = dashCPayloadIndexFixtureRepo()
  try {
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
    writeFileSync(
      join(repoRoot, dashCPayloadIndexRelPath),
      dashCPayloadIndexBaseline + '// a later, unrelated edit\n'
    )
    git('commit', '-a', '-q', '-m', 'later, unrelated edit')
    const laterSha = git('rev-parse', 'HEAD')
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)

    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        laterSha,
        'pnpm test',
        1,
        'it failed',
        dashCPayloadIndexMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      "laterSha's committed tree holds neither side of the reversed mutation"
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /does not match --sha/)
    assert.match(parsed.error, new RegExp(laterSha))
    assert.equal(
      existsSync(proofLedgerPath(ticket)),
      false,
      'the refused record must not create the ledger file at all'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record refuses a red capture whose --mutation-file is corrupt, distinctly from a mismatch — door 30', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        dashCPayloadIndexTruncatedMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'a hunk header claiming more lines than its body contains must refuse before ever attempting to apply'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /corrupt/)
    assert.doesNotMatch(
      parsed.error,
      /does not match --sha/,
      'corruption must not be reported as a mismatch — a caller misdiagnosing this as a re-stamp would go looking for a mismatch that is not there'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record refuses a red capture whose --mutation-file is corrupt even under NO_REPO_ROOT_CHECK — door 30 needs no tree at all', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0001',
      'pnpm test',
      1,
      'it failed',
      dashCPayloadIndexTruncatedMutationDiff
    )
  )
  assert.equal(
    getRequestedExitCode(),
    6,
    'a hand-composed diff must be refused whether or not a --repo-root check is in play — this check needs no tree'
  )
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /corrupt/)
})

test('record refuses a red capture whose --mutation-file reverse-applies in neither direction — the neither-side-reverse-applies incident itself', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'proof-ledger-record-dirty-test-'))
  try {
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
    git('init', '-q', '-b', 'trunk')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    const relPath = 'tools/cli/src/proof-ledger/run.ts'
    const filePath = join(repoRoot, relPath)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, preReshapeResultsLiteral)
    git('add', relPath)
    git('commit', '-q', '-m', 'current shape')
    const sha = git('rev-parse', 'HEAD')

    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        sha,
        'pnpm test',
        1,
        'it failed',
        reshapedMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'a diff describing a reshaped-away state applies in neither direction'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /in either direction/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record accepts a red capture whose --mutation-file names a file unresolvable under --repo-root — fails open, not closed', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        unresolvablePathMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      0,
      'a file this repo never tracked cannot be verified, so it must not block the capture'
    )
    const parsed = JSON.parse(output) as { id: string; unverifiedMutationPaths?: string[] }
    assert.equal(typeof parsed.id, 'string')
    assert.deepEqual(
      parsed.unverifiedMutationPaths,
      ['nonexistent/unrelated-file.ts'],
      'B3: an unresolvable section must be reported, not silently dropped'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record never lets a --mutation-file header of `../<sibling>/file` reach a real file outside repoRoot', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  const siblingDir = mkdtempSync(join(tmpdir(), 'proof-ledger-outside-repo-'))
  const siblingFile = join(siblingDir, 'secret.txt')
  writeFileSync(siblingFile, 'original-outside-content\n')
  const escapingHeaderPath = `../${basename(siblingDir)}/secret.txt`
  const escapingMutationDiff =
    `--- ${escapingHeaderPath}\n` +
    `+++ ${escapingHeaderPath}\n` +
    '@@ -1 +1 @@\n' +
    '-original-outside-content\n' +
    '+mutated-outside-content\n'
  try {
    captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        escapingMutationDiff
      )
    )
    assert.equal(
      readFileSync(siblingFile, 'utf-8'),
      'original-outside-content\n',
      'a header this far outside repoRoot must never be handed to git apply against the real file it ' +
        'happens to name — no matter how the capture itself is ultimately scored'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(siblingDir, { recursive: true, force: true })
  }
})

test('record does not misread a `./`-prefixed header naming the exact mutated file as dirty content OUTSIDE the mutation', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        dashCPayloadIndexDotSlashMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      0,
      'a header naming the exact file the mutation touches, just with a `./` prefix, must not read as ' +
        'dirty content outside the mutation — resolveUnderRepoRoot must return the same repo-relative ' +
        "form git status reports, not the caller's raw header path verbatim"
    )
    const parsed = JSON.parse(output) as { id: string }
    assert.equal(typeof parsed.id, 'string')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record refuses a red --mutation-file whose header sides are both /dev/null — a diff naming no real file, certifying nothing', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        bothSidesDevNullMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'a mutation diff with no resolvable file section must be refused, not accepted with an empty ' +
        'unverifiedMutationPaths that reads as fully checked'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /no header side/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record refuses a zero-section red --mutation-file even under NO_REPO_ROOT_CHECK, where dirtyPathsOutsideMutation/redMutationMismatch never run at all', () => {
  const output = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      '0'.repeat(40),
      'pnpm test',
      1,
      'it failed',
      bothSidesDevNullMutationDiff
    )
  )
  assert.equal(
    getRequestedExitCode(),
    6,
    'the zero-section guard must run for every red capture, not only the ones a --repo-root tree ' +
      'check happens to be gated behind — a caller passing NO_REPO_ROOT_CHECK must not bypass it'
  )
  const parsed = JSON.parse(output) as { error: string }
  assert.match(parsed.error, /no header side/)
})

test('record refuses a zero-section red --mutation-file with its own message even against a working tree dirty elsewhere, not the misleading "outside --mutation-file\'s own files" message', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        bothSidesDevNullMutationDiff
      )
    )
    assert.equal(getRequestedExitCode(), 6)
    const parsed = JSON.parse(output) as { error: string }
    assert.match(
      parsed.error,
      /no header side/,
      'the zero-section guard must fire before dirtyPathsOutsideMutation gets a chance to blame the ' +
        'unrelated dirty file for being "outside" a mutation that in fact names no files at all'
    )
    assert.doesNotMatch(parsed.error, /outside --mutation-file/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test("record names the observed condition, not one specific cause, when a --mutation-file's header lines carry no path at all", () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        bareHeaderNoPathMutationDiff
      )
    )
    assert.equal(getRequestedExitCode(), 6)
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /no header side/)
    assert.doesNotMatch(
      parsed.error,
      /\/dev\/null/,
      'a bare header with no path at all contains the string "/dev/null" nowhere — the message must ' +
        'not send an operator searching the mutation file for a string that is not in it'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('check reads a zero-section red mutation sidecar as failing, not ok — the read-time twin of the record-time noResolvableSectionReason guard', () => {
  appendZeroSectionRedCapture('task-1', 'aaa0027', bothSidesDevNullMutationDiff)
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, 'aaa0027', 'task-1', ['red']))
  assert.equal(
    getRequestedExitCode(),
    3,
    'a ledger line whose mutation names no file at all must not read ok just because it reached the ' +
      'store by a route other than the current record path'
  )
  const parsed = JSON.parse(output) as { failing: string[]; missing: string[] }
  assert.deepEqual(parsed.failing, ['red'])
  assert.deepEqual(parsed.missing, [])
})

test('check reads a truncated/corrupt red mutation sidecar as failing, not ok — the read-time twin of the record-time truncatedMutationReason guard', () => {
  appendCorruptRedCapture('task-1', 'aaa0028', dashCPayloadIndexTruncatedMutationDiff)
  resetExitCode()
  const output = captureStdout(() => runCheck(ticket, 'aaa0028', 'task-1', ['red']))
  assert.equal(
    getRequestedExitCode(),
    3,
    'a ledger line whose mutation hunk header disagrees with its own body must not read ok just ' +
      'because it reached the store by a route other than the current record path'
  )
  const parsed = JSON.parse(output) as { failing: string[]; missing: string[] }
  assert.deepEqual(parsed.failing, ['red'])
  assert.deepEqual(parsed.missing, [])
})

test("show reads back an unresolvable section on a persisted red capture — D1: the marker must survive to a later read, not just this record call's own stdout", () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    const recordOutput = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        unresolvablePathMutationDiff
      )
    )
    const { id } = JSON.parse(recordOutput) as { id: string }

    const showOutput = captureStdout(() => runShow(ticket, undefined, undefined, undefined, id))
    const { captures } = JSON.parse(showOutput) as {
      captures: { id: string; unverifiedMutationPaths?: string[] }[]
    }
    assert.equal(captures.length, 1)
    assert.deepEqual(
      captures[0]!.unverifiedMutationPaths,
      ['nonexistent/unrelated-file.ts'],
      'a later read of the ledger must still be able to see this red was only partially verified — ' +
        "not just whoever watched record's own stdout at capture time"
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('show reads back an EMPTY unverifiedMutationPaths, present not absent, on a red capture where every section verified — D1', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)
    const recordOutput = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        dashCPayloadIndexMutationDiff
      )
    )
    const { id } = JSON.parse(recordOutput) as { id: string }

    const showOutput = captureStdout(() => runShow(ticket, undefined, undefined, undefined, id))
    const { captures } = JSON.parse(showOutput) as {
      captures: { id: string; unverifiedMutationPaths?: string[] }[]
    }
    assert.equal(captures.length, 1)
    assert.equal(
      'unverifiedMutationPaths' in captures[0]!,
      true,
      'a fully-verified red must persist an explicit empty list, not omit the field — an absent ' +
        'field must stay reserved for a row the check never ran against, not double as "fully clean"'
    )
    assert.deepEqual(captures[0]!.unverifiedMutationPaths, [])
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('show reads back NO unverifiedMutationPaths field at all on a red recorded under NO_REPO_ROOT_CHECK, where the check never ran — D1', () => {
  const recordOutput = captureStdout(() =>
    runRecord(
      NO_REPO_ROOT_CHECK,
      ticket,
      'task-1',
      'red',
      'aaa0001',
      'pnpm test',
      1,
      'it failed',
      dashCPayloadIndexMutationDiff
    )
  )
  const { id } = JSON.parse(recordOutput) as { id: string }

  const showOutput = captureStdout(() => runShow(ticket, undefined, undefined, undefined, id))
  const { captures } = JSON.parse(showOutput) as {
    captures: { id: string; unverifiedMutationPaths?: string[] }[]
  }
  assert.equal(captures.length, 1)
  assert.equal(
    'unverifiedMutationPaths' in captures[0]!,
    false,
    'NO_REPO_ROOT_CHECK never runs redMutationMismatch, so persisting [] here would misreport a ' +
      'check that never happened as one that ran clean'
  )
})

test('record verifies a red capture whose repo-real path is on the MINUS header side and an external scratch path is on the PLUS side — the repo-real-path-on-MINUS shape', () => {
  const { repoRoot } = dashCPayloadIndexFixtureRepo()
  try {
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
    writeFileSync(
      join(repoRoot, dashCPayloadIndexRelPath),
      dashCPayloadIndexBaseline + '// a later, unrelated edit\n'
    )
    git('commit', '-a', '-q', '-m', 'later, unrelated edit')
    const laterSha = git('rev-parse', 'HEAD')
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)

    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        laterSha,
        'pnpm test',
        1,
        'it failed',
        dashCPayloadIndexMinusSideRepoMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'the repo-real path on the minus side must still be resolved and verified, not skipped ' +
        'just because the plus side is unresolvable'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /does not match --sha/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record verifies a red capture whose --mutation-file spans two files, both matching — B2', () => {
  const { repoRoot, cleanSha } = twoFileFixtureRepo()
  try {
    writeFileSync(join(repoRoot, 'a.txt'), 'line-a-mutated\n')
    writeFileSync(join(repoRoot, 'b.txt'), 'line-b-mutated\n')

    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        twoFileMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      0,
      "a.txt's non-final section must reverse-apply intact, not corrupted by a lost newline"
    )
    const parsed = JSON.parse(output) as { id: string; unverifiedMutationPaths?: string[] }
    assert.equal(typeof parsed.id, 'string')
    assert.equal(parsed.unverifiedMutationPaths, undefined)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record verifies a red capture whose --mutation-file spans two files, every diff --git line with a/b reversed — class-2 sweep finding', () => {
  const { repoRoot, cleanSha } = twoFileFixtureRepo()
  try {
    writeFileSync(join(repoRoot, 'a.txt'), 'line-a-mutated\n')
    writeFileSync(join(repoRoot, 'b.txt'), 'line-b-mutated\n')

    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        reversedDiffGitHeaderMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      0,
      'a reversed a/b label on the diff --git line must not stop DIFF_GIT_HEADER from finding both ' +
        'file boundaries, or the second section is never read at all'
    )
    const parsed = JSON.parse(output) as { id: string; unverifiedMutationPaths?: string[] }
    assert.equal(typeof parsed.id, 'string')
    assert.equal(parsed.unverifiedMutationPaths, undefined)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record verifies a red capture whose --mutation-file spans two files, the non-final one a ghost path — B3', () => {
  const { repoRoot, cleanSha } = twoFileFixtureRepo()
  try {
    writeFileSync(join(repoRoot, 'b.txt'), 'line-b-mutated\n')

    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        ghostThenRealMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      0,
      'an unresolvable non-final section must not corrupt the real, final section that follows it'
    )
    const parsed = JSON.parse(output) as { id: string; unverifiedMutationPaths?: string[] }
    assert.equal(typeof parsed.id, 'string')
    assert.deepEqual(parsed.unverifiedMutationPaths, ['ghost.txt'])
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test("record refuses a red capture whose working tree is dirty outside --mutation-file's own files — B5", () => {
  const { repoRoot, cleanSha } = twoFileFixtureRepo()
  try {
    writeFileSync(join(repoRoot, 'a.txt'), 'line-a-mutated\n')
    writeFileSync(join(repoRoot, 'b.txt'), 'line-b-unrelated-edit\n')

    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        aOnlyMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      "a red capture's dirty-tree exemption covers only --mutation-file's own files, not the rest " +
        'of the tree'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /outside/)
    assert.match(parsed.error, /b\.txt/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

const deletedGuardRelPath = 'tools/cli/src/proof-ledger/deleted-guard.ts'

const deletedGuardBaseline = 'export const guardedInvariant = (x: number): boolean => x > 0\n'

/** A throwaway repo, committed clean with deletedGuardRelPath present; returns { repoRoot, cleanSha }. */
const deletedGuardFixtureRepo = (): { repoRoot: string; cleanSha: string } => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'proof-ledger-record-deleted-guard-test-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'trunk')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  const filePath = join(repoRoot, deletedGuardRelPath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, deletedGuardBaseline)
  git('add', deletedGuardRelPath)
  git('commit', '-q', '-m', 'baseline')
  return { repoRoot, cleanSha: git('rev-parse', 'HEAD') }
}

// baseline -> mutated (file removed), generated by a real `git rm` + `git diff --cached` against
// exactly deletedGuardBaseline — not hand-typed.
const deletedGuardMutationDiff =
  'diff --git a/tools/cli/src/proof-ledger/deleted-guard.ts b/tools/cli/src/proof-ledger/deleted-guard.ts\n' +
  'deleted file mode 100644\n' +
  'index 30de447..0000000\n' +
  '--- a/tools/cli/src/proof-ledger/deleted-guard.ts\n' +
  '+++ /dev/null\n' +
  '@@ -1 +0,0 @@\n' +
  '-export const guardedInvariant = (x: number): boolean => x > 0\n'

const createdGuardRelPath = 'tools/cli/src/proof-ledger/created-guard.ts'

const createdGuardMutated = 'export const anotherGuard = (x: number): boolean => x >= 0\n'

/**
 * A throwaway repo, committed clean WITHOUT createdGuardRelPath; returns { repoRoot, cleanSha }. A
 * sibling file is committed inside createdGuardRelPath's own directory so that directory is already
 * tracked — otherwise `git status --porcelain` collapses a brand-new file inside a wholly untracked
 * directory into one line for the directory itself, not the file, and the dirty-tree check below
 * would name the wrong path.
 */
const createdGuardFixtureRepo = (): { repoRoot: string; cleanSha: string } => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'proof-ledger-record-created-guard-test-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'trunk')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  const siblingPath = join(repoRoot, 'tools/cli/src/proof-ledger/sibling.ts')
  mkdirSync(dirname(siblingPath), { recursive: true })
  writeFileSync(siblingPath, 'export const sibling = true\n')
  git('add', 'tools/cli/src/proof-ledger/sibling.ts')
  git('commit', '-q', '-m', 'baseline')
  return { repoRoot, cleanSha: git('rev-parse', 'HEAD') }
}

// baseline (file absent) -> mutated (file created), generated by a real `git add` + `git diff
// --cached` against nothing — not hand-typed.
const createdGuardMutationDiff =
  'diff --git a/tools/cli/src/proof-ledger/created-guard.ts b/tools/cli/src/proof-ledger/created-guard.ts\n' +
  'new file mode 100644\n' +
  'index 0000000..b6c4acd\n' +
  '--- /dev/null\n' +
  '+++ b/tools/cli/src/proof-ledger/created-guard.ts\n' +
  '@@ -0,0 +1 @@\n' +
  '+export const anotherGuard = (x: number): boolean => x >= 0\n'

test('record accepts a delete-shaped red capture whose --mutation-file removes a file --sha still holds — C2', () => {
  const { repoRoot, cleanSha } = deletedGuardFixtureRepo()
  try {
    rmSync(join(repoRoot, deletedGuardRelPath))
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        deletedGuardMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      0,
      'reversing the delete recovers exactly what cleanSha committed, even though the file is ' +
        'currently absent from disk'
    )
    const parsed = JSON.parse(output) as { id: string }
    assert.equal(typeof parsed.id, 'string')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record accepts a create-shaped red capture whose --mutation-file adds a file --sha never held — C2', () => {
  const { repoRoot, cleanSha } = createdGuardFixtureRepo()
  try {
    const filePath = join(repoRoot, createdGuardRelPath)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, createdGuardMutated)
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        createdGuardMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      0,
      'reversing the create removes the file, matching cleanSha correctly never having held it'
    )
    const parsed = JSON.parse(output) as { id: string }
    assert.equal(typeof parsed.id, 'string')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record accepts a delete-shaped red capture whose --mutation-file removes a file staged for deletion with git rm, not just deleted from disk', () => {
  const { repoRoot, cleanSha } = deletedGuardFixtureRepo()
  try {
    execFileSync('git', ['rm', '-q', deletedGuardRelPath], { cwd: repoRoot, stdio: 'pipe' })
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        deletedGuardMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      0,
      'a deletion staged with git rm is gone from the index, not just the working tree, so git ' +
        'ls-files alone cannot find it — resolution must fall through a second time to git ls-tree ' +
        '-r HEAD, which still holds the tree the file existed in'
    )
    const parsed = JSON.parse(output) as { id: string }
    assert.equal(typeof parsed.id, 'string')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

const normalGuardRelPath = 'tools/cli/src/proof-ledger/normal-guard.ts'

// A header shortened to a suffix of normalGuardRelPath (dropping the leading "tools/cli/") so
// resolution cannot take the direct-join fast path against repoRoot and must go through the
// tracked-file suffix-match lookup — the branch a union-shaped regression of the git-ls-tree fallback
// would break for every ordinary, non-deleted file.
const normalGuardShortHeader = 'src/proof-ledger/normal-guard.ts'

const normalGuardReversed = "export const normalGuard = 'reversed'\n"

const normalGuardMutated = "export const normalGuard = 'mutated'\n"

/** A throwaway repo, committed clean with normalGuardRelPath present holding normalGuardReversed. */
const normalGuardFixtureRepo = (): { repoRoot: string; cleanSha: string } => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'proof-ledger-record-normal-guard-test-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'trunk')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  const filePath = join(repoRoot, normalGuardRelPath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, normalGuardReversed)
  git('add', normalGuardRelPath)
  git('commit', '-q', '-m', 'baseline')
  return { repoRoot, cleanSha: git('rev-parse', 'HEAD') }
}

// reversed -> mutated, generated by a real edit + `git diff` against normalGuardRelPath, then its
// header lines alone hand-shortened to normalGuardShortHeader — the hunk body is untouched.
const normalGuardMutationDiff =
  `diff --git a/${normalGuardShortHeader} b/${normalGuardShortHeader}\n` +
  'index f9bd7b5..901d2c1 100644\n' +
  `--- a/${normalGuardShortHeader}\n` +
  `+++ b/${normalGuardShortHeader}\n` +
  '@@ -1 +1 @@\n' +
  "-export const normalGuard = 'reversed'\n" +
  "+export const normalGuard = 'mutated'\n"

test('record accepts an edit-shaped red capture whose --mutation-file header is a shortened suffix of a normal, non-deleted tracked file', () => {
  const { repoRoot, cleanSha } = normalGuardFixtureRepo()
  try {
    writeFileSync(join(repoRoot, normalGuardRelPath), normalGuardMutated)
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        normalGuardMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      0,
      'the git-ls-tree fallback is only reached once git ls-files finds nothing; unioning the two ' +
        'lookups instead would make every ordinary tracked file match twice under the suffix filter, ' +
        'defeating the length === 1 uniqueness check this header relies on to resolve at all'
    )
    const parsed = JSON.parse(output) as { id: string }
    assert.equal(typeof parsed.id, 'string')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

const refFrameGuardRelPath = 'tools/cli/src/proof-ledger/ref-frame-guard.ts'

const refFrameGuardBaseline = "export const refFrameGuard = 'baseline'\n"

/**
 * A throwaway repo whose two commits disagree on refFrameGuardRelPath's presence, and whose current
 * HEAD is the second commit, not the returned --sha: `noFileSha` (the first commit) never holds
 * refFrameGuardRelPath at all; the second commit (real HEAD) adds it. A staged `git rm` afterward
 * removes it from both disk and the index, leaving it resolvable only from a tree — but HEAD's tree
 * and noFileSha's tree disagree about whether it is there at all.
 */
const refFrameGuardFixtureRepo = (): { repoRoot: string; noFileSha: string } => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'proof-ledger-record-ref-frame-guard-test-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'trunk')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  const siblingPath = join(repoRoot, 'tools/cli/src/proof-ledger/sibling.ts')
  mkdirSync(dirname(siblingPath), { recursive: true })
  writeFileSync(siblingPath, 'export const sibling = true\n')
  git('add', 'tools/cli/src/proof-ledger/sibling.ts')
  git('commit', '-q', '-m', 'fix: baseline without ref-frame-guard.ts')
  const noFileSha = git('rev-parse', 'HEAD')
  const filePath = join(repoRoot, refFrameGuardRelPath)
  writeFileSync(filePath, refFrameGuardBaseline)
  git('add', refFrameGuardRelPath)
  git('commit', '-q', '-m', 'fix: HEAD adds ref-frame-guard.ts, noFileSha never had it')
  git('rm', '-q', refFrameGuardRelPath)
  return { repoRoot, noFileSha }
}

// baseline -> deleted, generated by a real `git rm` + `git diff --cached` against exactly
// refFrameGuardBaseline — not hand-typed.
const refFrameGuardMutationDiff =
  'diff --git a/tools/cli/src/proof-ledger/ref-frame-guard.ts b/tools/cli/src/proof-ledger/ref-frame-guard.ts\n' +
  'deleted file mode 100644\n' +
  'index 78cce28..0000000\n' +
  '--- a/tools/cli/src/proof-ledger/ref-frame-guard.ts\n' +
  '+++ /dev/null\n' +
  '@@ -1 +0,0 @@\n' +
  "-export const refFrameGuard = 'baseline'\n"

test("record does not certify a delete-shaped red capture against HEAD when --sha is a different commit that never held the file — resolveUnderRepoRoot must resolve in --sha's own frame, not HEAD's", () => {
  const { repoRoot, noFileSha } = refFrameGuardFixtureRepo()
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        noFileSha,
        'pnpm test',
        1,
        'it failed',
        refFrameGuardMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      0,
      'noFileSha never held ref-frame-guard.ts at all, so this section has nothing at --sha to ' +
        "compare against — a HEAD-keyed fallback wrongly resolves the header from HEAD's tree " +
        '(which does hold the file) and forces it through the strict --sha comparison, which then ' +
        "refuses a capture this --sha simply cannot speak to; resolving in --sha's own frame instead " +
        'leaves the section unverified rather than refusing it'
    )
    const parsed = JSON.parse(output) as { id: string; unverifiedMutationPaths: string[] }
    assert.equal(typeof parsed.id, 'string')
    assert.deepEqual(parsed.unverifiedMutationPaths, [refFrameGuardRelPath])
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

const unresolvableSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

test('record refuses a red capture whose --sha does not resolve to a commit at all, for a create-shaped mutation — E1', () => {
  const { repoRoot } = createdGuardFixtureRepo()
  try {
    const filePath = join(repoRoot, createdGuardRelPath)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, createdGuardMutated)
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        unresolvableSha,
        'pnpm test',
        1,
        'it failed',
        createdGuardMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'an unresolvable --sha must never read as "the path was legitimately absent at --sha" for a ' +
        'create-shaped mutation — exit 128 from git show means the same thing whether --sha itself ' +
        'is bogus or the path is genuinely absent, and only the second is evidence of a match'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /does not resolve to a commit/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test("record refuses a red capture whose --sha names a real blob, not a commit, even when a refs/replace ref installed directly via git update-ref forges it into resolving as one — shaResolvesToCommit's own --no-replace-objects lever", () => {
  const { repoRoot, cleanSha } = createdGuardFixtureRepo()
  try {
    const blobSha = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repoRoot,
      stdio: 'pipe',
      input: 'not a commit, a plain blob\n',
    })
      .toString()
      .trim()
    execFileSync('git', ['update-ref', `refs/replace/${blobSha}`, cleanSha], {
      cwd: repoRoot,
      stdio: 'pipe',
    })
    const filePath = join(repoRoot, createdGuardRelPath)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, createdGuardMutated)
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        blobSha,
        'pnpm test',
        1,
        'it failed',
        createdGuardMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'blobSha is a real blob object, not a commit; without --no-replace-objects the forged replace ' +
        "ref makes ls-tree read cleanSha's real tree in its place — which genuinely lacks " +
        "createdGuardRelPath, matching the create-shaped mutation's reversed-absent state and letting " +
        'the forged --sha slip through as a verified match instead of being refused here'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /does not resolve to a commit/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test("record refuses a red capture whose --sha genuinely lacks a path that a refs/replace-redirected commit holds instead — treeEntryKind's ls-tree lever alone", () => {
  const { repoRoot, cleanSha } = createdGuardFixtureRepo()
  try {
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
    const replacementFilePath = join(repoRoot, deletedGuardRelPath)
    mkdirSync(dirname(replacementFilePath), { recursive: true })
    writeFileSync(replacementFilePath, deletedGuardBaseline)
    git('add', deletedGuardRelPath)
    git('commit', '-q', '-m', 'fix: replacement commit holding deletedGuardRelPath')
    const replacementSha = git('rev-parse', 'HEAD')
    git('replace', cleanSha, replacementSha)
    rmSync(replacementFilePath)

    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        deletedGuardMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'cleanSha genuinely never held deletedGuardRelPath; without --no-replace-objects, ls-tree would ' +
        "read it through the replace ref from the replacement commit as present — this fixture's kind " +
        "stays 'absent' with the lever in place regardless of the show call's own lever, so it isolates " +
        "ls-tree alone (the show call is never reached on this fixture's 'absent' branch)"
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /has no .+ to compare against/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

const showLeverGuardRelPath = 'tools/cli/src/proof-ledger/show-lever-guard.ts'

const showLeverGuardReal = "export const showLeverGuard = 'real'\n"

/** A throwaway repo, committed clean with showLeverGuardRelPath present holding showLeverGuardReal. */
const showLeverGuardFixtureRepo = (): { repoRoot: string; cleanSha: string } => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'proof-ledger-record-show-lever-guard-test-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'trunk')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  const filePath = join(repoRoot, showLeverGuardRelPath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, showLeverGuardReal)
  git('add', showLeverGuardRelPath)
  git('commit', '-q', '-m', 'baseline')
  return { repoRoot, cleanSha: git('rev-parse', 'HEAD') }
}

// reversed -> mutated, generated by a real edit + `git diff` against a throwaway commit holding
// exactly showLeverGuardReversed — not hand-typed.
const showLeverGuardReversed = "export const showLeverGuard = 'reversed'\n"

const showLeverGuardMutated = "export const showLeverGuard = 'mutated'\n"

const showLeverGuardMutationDiff =
  'diff --git a/tools/cli/src/proof-ledger/show-lever-guard.ts b/tools/cli/src/proof-ledger/show-lever-guard.ts\n' +
  'index 2c07c86..4dc23e0 100644\n' +
  '--- a/tools/cli/src/proof-ledger/show-lever-guard.ts\n' +
  '+++ b/tools/cli/src/proof-ledger/show-lever-guard.ts\n' +
  '@@ -1 +1 @@\n' +
  "-export const showLeverGuard = 'reversed'\n" +
  "+export const showLeverGuard = 'mutated'\n"

test("record refuses a red capture whose --mutation-file reverses to content only a refs/replace-redirected commit holds, when --sha's own real content differs — the show call's own lever alone", () => {
  const { repoRoot, cleanSha } = showLeverGuardFixtureRepo()
  try {
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
    const filePath = join(repoRoot, showLeverGuardRelPath)
    writeFileSync(filePath, showLeverGuardReversed)
    git('add', showLeverGuardRelPath)
    git('commit', '-q', '-m', 'fix: replacement commit holding the reversed-mutation content')
    const replacementSha = git('rev-parse', 'HEAD')
    git('replace', cleanSha, replacementSha)
    writeFileSync(filePath, showLeverGuardMutated)

    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        showLeverGuardMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      "cleanSha's real content is showLeverGuardReal, not the reversed-mutation content the " +
        'replacement commit holds; ls-tree already reports blob correctly either way (the path exists ' +
        "at both commits), so this reaches the show call regardless of ls-tree's own lever — without " +
        "--no-replace-objects on show, it reads the replacement's content through the replace ref, " +
        'which happens to equal the reversed mutation exactly, and the mismatch this red capture exists ' +
        'to catch never fires'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /does not match --sha/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record refuses a red capture whose --sha does not resolve to a commit at all, for an edit-shaped mutation — E1, positive control (already refused before the fix)', () => {
  const { repoRoot } = dashCPayloadIndexFixtureRepo()
  try {
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        unresolvableSha,
        'pnpm test',
        1,
        'it failed',
        dashCPayloadIndexMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'an edit-shaped mutation already refused an unresolvable --sha before E1 — this pins that ' +
        'unchanged outcome under the new, correctly-attributed refusal'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /does not resolve to a commit/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record refuses an oversized unverifiedMutationPaths as its own cause, not misattributed to --command — Ruling 1', () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        manyGhostSectionsMutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'the same reachable, documented exit 6 as every other record refusal, not the generic exit 9'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(
      parsed.error,
      /mutation-verification result \(200 unresolved path\(s\)/,
      'the refusal must name unverifiedMutationPaths as the cause, not --command — --command here ' +
        'is 9 bytes long and cannot plausibly be blamed'
    )
    assert.doesNotMatch(
      parsed.error,
      /--command this large/,
      "the --command-oversized message is for a different cause and must not appear here — it is what Ruling 1's fix replaces for this cause"
    )

    assert.equal(
      existsSync(proofLedgerPath(ticket)),
      false,
      'a refused record must not append any line to the ledger'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

const oversizedBlobRelPath = 'tools/cli/src/proof-ledger/oversized-guard.ts'

const oversizedBlobMutated = 'export const oversizedMutated = true\n'

/**
 * A throwaway repo whose HEAD commits `blobContent` at oversizedBlobRelPath, while the current
 * working tree instead holds oversizedBlobMutated at that same path — decoupled the same way
 * createdGuardFixtureRepo's working tree is decoupled from cleanSha, so redMutationMismatch's `git
 * show <sha>:<path>` call reads exactly what HEAD committed regardless of what the working tree (or
 * the create-shaped mutation-file below) describes. Returns { repoRoot, cleanSha, mutationDiff } —
 * mutationDiff is generated by a real `git add` + `git diff --cached` against nothing, exactly like
 * createdGuardMutationDiff, so its header and index line always match oversizedBlobMutated's own real
 * blob rather than a hand-typed guess.
 */
const oversizedBlobFixtureRepo = (
  blobContent: string
): { repoRoot: string; cleanSha: string; mutationDiff: string } => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'proof-ledger-record-oversized-guard-test-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: repoRoot,
      stdio: 'pipe',
      maxBuffer: 256 * 1024 * 1024,
    }).toString()
  git('init', '-q', '-b', 'trunk')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  const siblingPath = join(repoRoot, 'tools/cli/src/proof-ledger/sibling.ts')
  mkdirSync(dirname(siblingPath), { recursive: true })
  writeFileSync(siblingPath, 'export const sibling = true\n')
  git('add', 'tools/cli/src/proof-ledger/sibling.ts')
  git('commit', '-q', '-m', 'baseline')

  const filePath = join(repoRoot, oversizedBlobRelPath)
  writeFileSync(filePath, oversizedBlobMutated)
  git('add', oversizedBlobRelPath)
  const mutationDiff = git('diff', '--cached')
  git('reset')

  writeFileSync(filePath, blobContent)
  git('add', oversizedBlobRelPath)
  git('commit', '-q', '-m', 'oversized blob')
  const cleanSha = git('rev-parse', 'HEAD').trim()

  writeFileSync(filePath, oversizedBlobMutated)

  return { repoRoot, cleanSha, mutationDiff }
}

test('record refuses a red capture whose --sha holds an oversized blob at the create-shaped mutation-file\'s own path, rather than misreading the overflow as "path absent"', () => {
  const { repoRoot, cleanSha, mutationDiff } = oversizedBlobFixtureRepo('x'.repeat(9 * 1024 * 1024))
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        mutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'an oversized blob at --sha must never read as "the path was legitimately absent at --sha" ' +
        'for a create-shaped mutation — `git ls-tree` already confirms the path is present as a blob ' +
        'without reading its content, so the ENOBUFS thrown when `git show` then tries to read that ' +
        'content must refuse, not fall through to "absent"'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /lists it as a blob/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test("record refuses a red capture whose --sha holds a small, differing blob at the create-shaped mutation-file's own path, for the pre-existing mismatch reason — positive control", () => {
  const { repoRoot, cleanSha, mutationDiff } = oversizedBlobFixtureRepo(
    'export const oversizedGuard = 1\n'
  )
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        mutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      'a small blob at --sha still refuses this create-shaped mutation, but for the pre-existing ' +
        '"does not match --sha\'s tree" mismatch — proving the new ENOBUFS guard is what fires on ' +
        'the oversized case above, not a change to this ordinary comparison'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /does not match --sha .*'s tree/)
    assert.doesNotMatch(
      parsed.error,
      /lists it as a blob/,
      'a small blob never throws ENOBUFS from git show, so the new guard must not fire here'
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

/**
 * Builds on oversizedBlobFixtureRepo: commits `blobContent` at oversizedBlobRelPath exactly as that
 * fixture does, then deletes the resulting blob's own loose-object file out of `.git/objects` — `git
 * ls-tree cleanSha -- oversizedBlobRelPath` still reports the path present as a blob (it reads only
 * the tree object), but `git show cleanSha:oversizedBlobRelPath` then throws "bad object" trying to
 * read content that no longer exists on disk. This is the corrupt/missing-blob shape: identical
 * exit-128 shape to a legitimately absent path, but no longer decoded from that exception — `git
 * ls-tree` already established the path is present, so the throw must refuse rather than fall
 * through to "absent".
 */
const removedBlobObjectFixtureRepo = (
  blobContent: string
): { repoRoot: string; cleanSha: string; mutationDiff: string } => {
  const fixture = oversizedBlobFixtureRepo(blobContent)
  const blobSha = execFileSync(
    'git',
    ['rev-parse', `${fixture.cleanSha}:${oversizedBlobRelPath}`],
    { cwd: fixture.repoRoot, stdio: 'pipe' }
  )
    .toString()
    .trim()
  rmSync(join(fixture.repoRoot, '.git', 'objects', blobSha.slice(0, 2), blobSha.slice(2)))
  return fixture
}

test("record refuses a red capture whose --sha lists the create-shaped mutation-file's path as a blob but the blob object itself is missing", () => {
  const { repoRoot, cleanSha, mutationDiff } = removedBlobObjectFixtureRepo(
    'export const removedBlobGuard = 1\n'
  )
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        mutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      '`git ls-tree` confirms the path is present as a blob at --sha without reading its content, so ' +
        'the "bad object" exit 128 that `git show` then throws trying to read the missing blob must ' +
        'refuse, not be misread as "path legitimately absent" the way a bare status-128 check would ' +
        '(the exact gap found in the status !== 128 discriminator this replaced)'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /lists it as a blob/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

const directoryEntryRelPath = 'tools/cli/src/proof-ledger/directory-guard.ts'

const directoryEntryMutated = 'export const directoryMutated = true\n'

/**
 * A throwaway repo whose --sha argument (cleanSha, NOT the checked-out HEAD) commits a real
 * directory (containing one tracked child file) at directoryEntryRelPath, rather than a blob — `git
 * ls-tree cleanSha -- directoryEntryRelPath` reports it present with type `tree`, not `blob`. HEAD
 * moves on to a later commit that replaces the directory with a regular file holding
 * directoryEntryMutated at that same path, so the checked-out working tree is completely clean
 * (matches HEAD exactly) and never trips the earlier, unrelated dirty-tree refusal (B5) — the only
 * dirtiness this fixture exercises is --sha (cleanSha) disagreeing with
 * HEAD, which is the whole point: a red capture's mutation-file always describes a regular file
 * (the create-shaped diff is generated before the directory ever exists in git, so its header and
 * content are ordinary create-a-file shape), but the --sha it is checked against holds something
 * else there.
 */
const directoryEntryFixtureRepo = (): {
  repoRoot: string
  cleanSha: string
  mutationDiff: string
} => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'proof-ledger-record-directory-entry-test-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: repoRoot,
      stdio: 'pipe',
      maxBuffer: 256 * 1024 * 1024,
    }).toString()
  git('init', '-q', '-b', 'trunk')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  const siblingPath = join(repoRoot, 'tools/cli/src/proof-ledger/sibling.ts')
  mkdirSync(dirname(siblingPath), { recursive: true })
  writeFileSync(siblingPath, 'export const sibling = true\n')
  git('add', 'tools/cli/src/proof-ledger/sibling.ts')
  git('commit', '-q', '-m', 'baseline')

  const filePath = join(repoRoot, directoryEntryRelPath)
  writeFileSync(filePath, directoryEntryMutated)
  git('add', directoryEntryRelPath)
  const mutationDiff = git('diff', '--cached')
  git('reset')
  rmSync(filePath)

  mkdirSync(filePath, { recursive: true })
  writeFileSync(join(filePath, 'child.ts'), 'export const child = true\n')
  git('add', `${directoryEntryRelPath}/child.ts`)
  git('commit', '-q', '-m', 'directory shape')
  const cleanSha = git('rev-parse', 'HEAD').trim()

  rmSync(filePath, { recursive: true, force: true })
  writeFileSync(filePath, directoryEntryMutated)
  git('add', directoryEntryRelPath)
  git('commit', '-q', '-m', 'replace directory with file')

  return { repoRoot, cleanSha, mutationDiff }
}

test("record refuses a red capture whose --sha holds the create-shaped mutation-file's path as a directory, not a file", () => {
  const { repoRoot, cleanSha, mutationDiff } = directoryEntryFixtureRepo()
  try {
    const output = captureStdout(() =>
      runRecord(
        { kind: 'check', repoRoot },
        ticket,
        'task-1',
        'red',
        cleanSha,
        'pnpm test',
        1,
        'it failed',
        mutationDiff
      )
    )
    assert.equal(
      getRequestedExitCode(),
      6,
      "a red capture's mutation evidence describes a regular file, but --sha's tree holds a " +
        'directory at that same path — treeEntryKind must refuse this as a non-blob entry rather ' +
        'than falling through to git show, which would throw its own unrelated "is a directory" error'
    )
    const parsed = JSON.parse(output) as { error: string }
    assert.match(parsed.error, /something other than a file/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record through the real CLI process refuses a green capture when cwd (the default --repo-root) is a dirty working tree', async () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)
    const result = await runCli(
      [
        'proof-ledger',
        'record',
        '--ticket',
        ticket,
        '--task',
        'task-1',
        '--capture',
        'green',
        '--sha',
        cleanSha,
        '--command',
        'pnpm test',
        '--exit',
        '0',
        '--output',
        'it passed',
      ],
      { cwd: repoRoot }
    )
    assert.equal(
      result.exitCode,
      6,
      'the CLI must default --repo-root to its own cwd, not skip the check'
    )
    const parsed = JSON.parse(result.stdout) as { error: string }
    assert.match(parsed.error, /uncommitted/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record through the real CLI process accepts a green capture at a dirty cwd when --sha-is-label is passed', async () => {
  const { repoRoot, cleanSha } = dashCPayloadIndexFixtureRepo()
  try {
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)
    const result = await runCli(
      [
        'proof-ledger',
        'record',
        '--ticket',
        ticket,
        '--task',
        'task-1',
        '--capture',
        'evidence',
        '--sha',
        cleanSha,
        '--command',
        'ps -p 12345',
        '--exit',
        '0',
        '--output',
        'no such process',
        '--sha-is-label',
      ],
      { cwd: repoRoot }
    )
    assert.equal(
      result.exitCode,
      0,
      '--sha-is-label must reach runRecord through the CLI flag parser, not just the direct API'
    )
    const parsed = JSON.parse(result.stdout) as { id: string }
    assert.equal(typeof parsed.id, 'string')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('record through the real CLI process refuses a red capture whose --mutation-file does not reverse-apply to --sha', async () => {
  const { repoRoot } = dashCPayloadIndexFixtureRepo()
  // Outside repoRoot, like every other fixture's --mutation-file in this suite — a sidecar file
  // written inside the tree would itself read as dirty and outside the mutation's own files (B5),
  // tripping that refusal before this test's own reverse-apply mismatch ever runs.
  const mutationDir = mkdtempSync(join(tmpdir(), 'proof-ledger-mutation-file-'))
  const mutationFile = join(mutationDir, 'mutation.diff')
  try {
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
    writeFileSync(
      join(repoRoot, dashCPayloadIndexRelPath),
      dashCPayloadIndexBaseline + '// a later, unrelated edit\n'
    )
    git('commit', '-a', '-q', '-m', 'later, unrelated edit')
    const laterSha = git('rev-parse', 'HEAD')
    writeFileSync(join(repoRoot, dashCPayloadIndexRelPath), dashCPayloadIndexMutated)
    writeFileSync(mutationFile, dashCPayloadIndexMutationDiff)

    const result = await runCli(
      [
        'proof-ledger',
        'record',
        '--ticket',
        ticket,
        '--task',
        'task-1',
        '--capture',
        'red',
        '--sha',
        laterSha,
        '--command',
        'pnpm test',
        '--exit',
        '1',
        '--output',
        'it failed',
        '--mutation-file',
        mutationFile,
      ],
      { cwd: repoRoot }
    )
    assert.equal(
      result.exitCode,
      6,
      'the CLI must run the reverse-apply check by default, not skip it'
    )
    const parsed = JSON.parse(result.stdout) as { error: string }
    assert.match(parsed.error, /does not match --sha/)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(mutationDir, { recursive: true, force: true })
  }
})

test('CLI: proof-ledger record --help lists --repo-root', async () => {
  const result = await runCli(['proof-ledger', 'record', '--help'])
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /--repo-root/)
})

test('record --capture sweep with no --scope, --repo-root checked, exits 6 requiring --scope', async () => {
  const { repoRoot, headSha: sha } = makeCleanScratchRepo()
  const result = await runCli([
    'proof-ledger',
    'record',
    '--ticket',
    ticket,
    '--task',
    'task-1',
    '--capture',
    'sweep',
    '--sha',
    sha,
    '--command',
    'grep -rn x .',
    '--exit',
    '1',
    '--output',
    'no match',
    '--repo-root',
    repoRoot,
  ])
  assert.equal(result.exitCode, 6)
  const parsed = JSON.parse(result.stdout) as { error: string }
  assert.match(parsed.error, /requires --scope/)
})

test("record --capture sweep with --scope naming the changed file's sub-package opens, and show carries the scope", async () => {
  const { repoRoot, headSha: sha } = makeScopeFixtureRepo('packages/foo/src/a.ts', [
    'packages/foo',
    'packages/bar',
  ])
  const result = await runCli([
    'proof-ledger',
    'record',
    '--ticket',
    ticket,
    '--task',
    'task-1',
    '--capture',
    'sweep',
    '--sha',
    sha,
    '--command',
    'grep -rn changed packages',
    '--exit',
    '0',
    '--output',
    'packages/foo/src/a.ts:1:changed',
    '--repo-root',
    repoRoot,
    '--scope',
    'packages/foo',
  ])
  assert.equal(result.exitCode, 0)
  const showResult = await runCli(['proof-ledger', 'show', '--ticket', ticket, '--sha', sha])
  const parsed = JSON.parse(showResult.stdout) as { captures: { scope?: string[] }[] }
  assert.deepEqual(parsed.captures[0]?.scope, ['packages/foo'])
})

test('record --capture sweep with --scope . in a monorepo is refused, naming the licensed scope', async () => {
  const { repoRoot, headSha: sha } = makeScopeFixtureRepo('packages/foo/src/a.ts', [
    'packages/foo',
    'packages/bar',
  ])
  const result = await runCli([
    'proof-ledger',
    'record',
    '--ticket',
    ticket,
    '--task',
    'task-1',
    '--capture',
    'sweep',
    '--sha',
    sha,
    '--command',
    'grep -rn changed .',
    '--exit',
    '0',
    '--output',
    'packages/foo/src/a.ts:1:changed',
    '--repo-root',
    repoRoot,
    '--scope',
    '.',
  ])
  assert.equal(result.exitCode, 6)
  const parsed = JSON.parse(result.stdout) as { error: string }
  assert.match(parsed.error, /licensed scope is packages\/foo/)
})

test('record --capture sweep with --scope . is licensed when the changed file has no closer manifest, and normalizes ./ and padded-dot forms', async () => {
  const { repoRoot, headSha: sha } = makeScopeFixtureRepo('docs/x.md', ['packages/foo'])
  for (const scopeArg of ['.', './', ' . ']) {
    const result = await runCli([
      'proof-ledger',
      'record',
      '--ticket',
      ticket,
      '--task',
      'task-1',
      '--capture',
      'sweep',
      '--sha',
      sha,
      '--command',
      'grep -rn changed docs',
      '--exit',
      '0',
      '--output',
      'docs/x.md:1:changed',
      '--repo-root',
      repoRoot,
      '--scope',
      scopeArg,
    ])
    assert.equal(result.exitCode, 0, `--scope ${JSON.stringify(scopeArg)} must be licensed`)
  }
})

test('record --capture sweep refuses a found path outside --scope, accepts an untracked constructed positive, and strips an absolute-path prefix before checking', async () => {
  const { repoRoot } = makeScopeFixtureRepo('packages/foo/src/a.ts', [
    'packages/foo',
    'packages/bar',
  ])
  // packages/bar/src/b.ts must be a real tracked file for foundPaths to recognize it as a hit
  // outside --scope — an untracked path is exactly the "constructed positive" case this test
  // separately checks stays unflagged.
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  mkdirSync(join(repoRoot, 'packages/bar/src'), { recursive: true })
  writeFileSync(join(repoRoot, 'packages/bar/src/b.ts'), 'unrelated\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'unrelated tracked file')
  const sha = git('rev-parse', 'HEAD')
  const outsideResult = await runCli([
    'proof-ledger',
    'record',
    '--ticket',
    ticket,
    '--task',
    'task-1',
    '--capture',
    'sweep',
    '--sha',
    sha,
    '--command',
    'grep -rn changed packages',
    '--exit',
    '0',
    '--output',
    'packages/foo/src/a.ts:1:changed\npackages/bar/src/b.ts:3:hit',
    '--repo-root',
    repoRoot,
    '--scope',
    'packages/foo',
  ])
  assert.equal(outsideResult.exitCode, 6)
  const outsideParsed = JSON.parse(outsideResult.stdout) as { error: string }
  assert.match(outsideParsed.error, /found packages\/bar\/src\/b\.ts outside/)

  const untrackedResult = await runCli([
    'proof-ledger',
    'record',
    '--ticket',
    ticket,
    '--task',
    'task-1',
    '--capture',
    'sweep',
    '--sha',
    sha,
    '--command',
    'grep -rn changed packages',
    '--exit',
    '0',
    '--output',
    'packages/foo/src/a.ts:1:changed\n/tmp/positive.txt:1:hit',
    '--repo-root',
    repoRoot,
    '--scope',
    'packages/foo',
  ])
  assert.equal(untrackedResult.exitCode, 0, 'an untracked constructed positive is not a found hit')

  const absoluteResult = await runCli([
    'proof-ledger',
    'record',
    '--ticket',
    ticket,
    '--task',
    'task-1',
    '--capture',
    'sweep',
    '--sha',
    sha,
    '--command',
    'grep -rn changed packages',
    '--exit',
    '0',
    '--output',
    `packages/foo/src/a.ts:1:changed\n${repoRoot}/packages/bar/src/b.ts:1:hit`,
    '--repo-root',
    repoRoot,
    '--scope',
    'packages/foo',
  ])
  assert.equal(
    absoluteResult.exitCode,
    6,
    'an absolute path under repoRoot must still be checked, prefix stripped'
  )
  const absoluteParsed = JSON.parse(absoluteResult.stdout) as { error: string }
  assert.match(absoluteParsed.error, /found packages\/bar\/src\/b\.ts outside/)
})

test('record --capture sweep recognizes a colon-less listing line (grep/rg -l) as a found path', async () => {
  const { repoRoot } = makeScopeFixtureRepo('packages/foo/src/a.ts', [
    'packages/foo',
    'packages/bar',
  ])
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  mkdirSync(join(repoRoot, 'packages/bar/src'), { recursive: true })
  writeFileSync(join(repoRoot, 'packages/bar/src/b.ts'), 'unrelated\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'unrelated tracked file')
  const sha = git('rev-parse', 'HEAD')
  const listingResult = await runCli([
    'proof-ledger',
    'record',
    '--ticket',
    ticket,
    '--task',
    'task-1',
    '--capture',
    'sweep',
    '--sha',
    sha,
    '--command',
    'grep -rl changed packages',
    '--exit',
    '0',
    '--output',
    'packages/foo/src/a.ts\npackages/bar/src/b.ts',
    '--repo-root',
    repoRoot,
    '--scope',
    'packages/foo',
  ])
  assert.equal(listingResult.exitCode, 6, 'a bare-path-per-line listing hit must still be checked')
  const listingParsed = JSON.parse(listingResult.stdout) as { error: string }
  assert.match(listingParsed.error, /found packages\/bar\/src\/b\.ts outside/)
})

test('record --capture sweep matches a found path under a differently-spelled root — a symlinked root in either the line or --repo-root', async () => {
  const { repoRoot } = makeScopeFixtureRepo('packages/foo/src/a.ts', [
    'packages/foo',
    'packages/bar',
  ])
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  mkdirSync(join(repoRoot, 'packages/bar/src'), { recursive: true })
  writeFileSync(join(repoRoot, 'packages/bar/src/b.ts'), 'unrelated\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'unrelated tracked file')
  const sha = git('rev-parse', 'HEAD')
  const symlinkRoot = join(mkdtempSync(join(tmpdir(), 'proof-ledger-scope-symlink-')), 'root')
  symlinkSync(repoRoot, symlinkRoot)
  const record = async (repoRootArg: string, outputLine: string): Promise<number | null> =>
    (
      await runCli([
        'proof-ledger',
        'record',
        '--ticket',
        ticket,
        '--task',
        'task-1',
        '--capture',
        'sweep',
        '--sha',
        sha,
        '--command',
        'grep -rn changed packages',
        '--exit',
        '0',
        '--output',
        `packages/foo/src/a.ts:1:changed\n${outputLine}:1:hit`,
        '--repo-root',
        repoRootArg,
        '--scope',
        'packages/foo',
      ])
    ).exitCode

  assert.equal(
    await record(`${repoRoot}/`, `${repoRoot}/packages/bar/src/b.ts`),
    6,
    'a trailing slash on --repo-root must not stop the match'
  )
  assert.equal(
    await record(repoRoot, `${symlinkRoot}/packages/bar/src/b.ts`),
    6,
    'a line spelled under a symlink to --repo-root must still be recognized when --repo-root is physical'
  )
  assert.equal(
    await record(symlinkRoot, `${repoRoot}/packages/bar/src/b.ts`),
    6,
    'a line spelled under the physical root must still be recognized when --repo-root is a symlink to it'
  )
})

test('record --capture sweep matches a found path that is itself a tracked symlink resolving outside --repo-root', async () => {
  const { repoRoot } = makeScopeFixtureRepo('packages/foo/src/a.ts', [
    'packages/foo',
    'packages/bar',
  ])
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  const outsideDir = mkdtempSync(join(tmpdir(), 'proof-ledger-scope-outside-target-'))
  const outsideTarget = join(outsideDir, 'real.ts')
  writeFileSync(outsideTarget, 'unrelated\n')
  mkdirSync(join(repoRoot, 'packages/bar/src'), { recursive: true })
  symlinkSync(outsideTarget, join(repoRoot, 'packages/bar/src/link.ts'))
  git('add', '-A')
  git('commit', '-q', '-m', 'tracked symlink to a target outside the repo')
  const sha = git('rev-parse', 'HEAD')
  const result = await runCli([
    'proof-ledger',
    'record',
    '--ticket',
    ticket,
    '--task',
    'task-1',
    '--capture',
    'sweep',
    '--sha',
    sha,
    '--command',
    'grep -rn changed packages',
    '--exit',
    '0',
    '--output',
    `packages/foo/src/a.ts:1:changed\n${repoRoot}/packages/bar/src/link.ts:1:hit`,
    '--repo-root',
    repoRoot,
    '--scope',
    'packages/foo',
  ])
  assert.equal(
    result.exitCode,
    6,
    'the tracked symlink resolves outside --repo-root, so the literal spelling — not the realpath — is what must match'
  )
})

test("record --capture sweep licenses a non-ASCII changed path's own package dir instead of collapsing to the repo root — git diff --name-only quoting", async () => {
  const { repoRoot, headSha: sha } = makeScopeFixtureRepo('packages/日本/src/a.ts', [
    'packages/日本',
  ])
  const narrowResult = await runCli([
    'proof-ledger',
    'record',
    '--ticket',
    ticket,
    '--task',
    'task-1',
    '--capture',
    'sweep',
    '--sha',
    sha,
    '--command',
    'grep -rn changed packages',
    '--exit',
    '0',
    '--output',
    'packages/日本/src/a.ts:1:changed',
    '--repo-root',
    repoRoot,
    '--scope',
    'packages/日本',
  ])
  assert.equal(
    narrowResult.exitCode,
    0,
    "a non-ASCII changed path's own package dir must still be the licensed scope"
  )

  const rootResult = await runCli([
    'proof-ledger',
    'record',
    '--ticket',
    ticket,
    '--task',
    'task-1',
    '--capture',
    'sweep',
    '--sha',
    sha,
    '--command',
    'grep -rn changed packages',
    '--exit',
    '0',
    '--output',
    'packages/日本/src/a.ts:1:changed',
    '--repo-root',
    repoRoot,
    '--scope',
    '.',
  ])
  assert.equal(
    rootResult.exitCode,
    6,
    'the repo root must not be licensed via a collapsed quoted path'
  )
  const rootParsed = JSON.parse(rootResult.stdout) as { error: string }
  assert.match(rootParsed.error, /licensed scope is packages\/日本/)
})

test('record --capture sweep still refuses an out-of-scope hit at a non-ASCII tracked path — git ls-tree --name-only quoting', async () => {
  const { repoRoot } = makeScopeFixtureRepo('packages/foo/src/a.ts', [
    'packages/foo',
    'packages/bar',
  ])
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  mkdirSync(join(repoRoot, 'packages/bar/src'), { recursive: true })
  writeFileSync(join(repoRoot, 'packages/bar/src/日本.ts'), 'unrelated\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'unrelated tracked file with a non-ASCII name')
  const sha = git('rev-parse', 'HEAD')
  const outsideResult = await runCli([
    'proof-ledger',
    'record',
    '--ticket',
    ticket,
    '--task',
    'task-1',
    '--capture',
    'sweep',
    '--sha',
    sha,
    '--command',
    'grep -rn changed packages',
    '--exit',
    '0',
    '--output',
    'packages/foo/src/a.ts:1:changed\npackages/bar/src/日本.ts:3:hit',
    '--repo-root',
    repoRoot,
    '--scope',
    'packages/foo',
  ])
  assert.equal(
    outsideResult.exitCode,
    6,
    'a genuine out-of-scope hit at a non-ASCII tracked path must not be dropped'
  )
  const outsideParsed = JSON.parse(outsideResult.stdout) as { error: string }
  assert.match(outsideParsed.error, /found packages\/bar\/src\/日本\.ts outside/)
})

test('record --capture sweep with origin/main unresolvable is refused, naming that requirement', async () => {
  const { repoRoot, headSha: sha } = makeCleanScratchRepo()
  const result = await runCli([
    'proof-ledger',
    'record',
    '--ticket',
    ticket,
    '--task',
    'task-1',
    '--capture',
    'sweep',
    '--sha',
    sha,
    '--command',
    'grep -rn x .',
    '--exit',
    '1',
    '--output',
    'no match',
    '--repo-root',
    repoRoot,
    '--scope',
    '.',
  ])
  assert.equal(result.exitCode, 6)
  const parsed = JSON.parse(result.stdout) as { error: string }
  assert.match(parsed.error, /origin\/main must resolve/)
})

test('record refuses --scope on a non-sweep capture kind', async () => {
  const { repoRoot, headSha: sha } = makeCleanScratchRepo()
  const result = await runCli([
    'proof-ledger',
    'record',
    '--ticket',
    ticket,
    '--task',
    'task-1',
    '--capture',
    'evidence',
    '--sha',
    sha,
    '--command',
    'pnpm test',
    '--exit',
    '0',
    '--output',
    'clean',
    '--repo-root',
    repoRoot,
    '--scope',
    '.',
  ])
  assert.equal(result.exitCode, 6)
  const parsed = JSON.parse(result.stdout) as { error: string }
  assert.match(parsed.error, /only valid on --capture sweep/)
})

test('a raw capture line whose scope is a string, not an array, does not fold and counts in skippedLines', () => {
  appendLine(
    proofLedgerPath(ticket),
    JSON.stringify({
      kind: 'proof-capture',
      at: new Date().toISOString(),
      id: 'aaa0050bad1',
      task: 'task-1',
      capture: 'sweep',
      sha: 'aaa0050',
      command: 'grep -rn x .',
      exitStatus: 1,
      outputPath: '/tmp/nonexistent-output',
      outputSha256: 'deadbeef',
      outputBytes: 0,
      tail: '',
      scope: 'packages/foo',
    })
  )
  const output = captureStdout(() => runShow(ticket))
  const parsed = JSON.parse(output) as { captures: unknown[]; skippedLines: number }
  assert.equal(parsed.captures.length, 0)
  assert.equal(
    parsed.skippedLines,
    1,
    'a scope field that is a string, not an array, must not fold'
  )
})

// --- An unreadable proof ledger is not an empty one (FLOW-226) ---
//
// This is the case the whole ticket turns on. `check` reports `missing` so a caller can decide
// whether a proof still needs producing, and before this fix an unreadable ledger produced
// `missing:["evidence"]` at exit 3 — byte-identical to the answer for a ticket that genuinely has
// no captures. "I could not read your proof" and "you have no proof" were the same sentence.
//
// The fixture is a DIRECTORY at the ledger path: readFileSync fails with EISDIR for every uid
// including root, so this does not go vacuous under a root test runner.
const plantUnreadableProofLedger = (t: string): string => {
  const path = proofLedgerPath(t)
  mkdirSync(dirname(path), { recursive: true })
  mkdirSync(path, { recursive: true })
  assert.throws(
    () => readFileSync(path, 'utf-8'),
    /EISDIR/,
    'precondition: the planted path must actually be unreadable'
  )
  return path
}

test('proof-ledger check on an unreadable ledger does not report the captures as missing', async () => {
  const sha = 'e'.repeat(40)
  const absent = await runCli([
    'proof-ledger',
    'check',
    '--ticket',
    ticket,
    '--sha',
    sha,
    '--task',
    'some-task',
    '--require',
    'evidence',
  ])
  assert.equal(absent.exitCode, 3, 'a ticket with no captures keeps its existing answer')
  assert.deepEqual((JSON.parse(absent.stdout) as { missing: string[] }).missing, ['evidence'])

  const path = plantUnreadableProofLedger(ticket)
  const unreadable = await runCli([
    'proof-ledger',
    'check',
    '--ticket',
    ticket,
    '--sha',
    sha,
    '--task',
    'some-task',
    '--require',
    'evidence',
  ])
  assert.equal(unreadable.exitCode, 26, 'not 3, and not the generic 9 for an unexpected throw')
  assert.notEqual(
    unreadable.exitCode,
    absent.exitCode,
    'an unreadable ledger must not answer the way an empty one does'
  )
  const parsed = JSON.parse(unreadable.stdout) as { error?: string; code?: string }
  assert.equal(parsed.code, 'EISDIR')
  assert.equal(parsed.error?.includes(path), true, 'the reason must name the file that failed')
  assert.equal(
    unreadable.stdout.includes('"missing"'),
    false,
    'must not report anything as missing from a ledger it could not read'
  )
})
