import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { appendEvent, readLedger } from './ledger.ts'
import { classifyPath, computeStance, dischargedPairs } from './stance.ts'
import { runStance } from './run.ts'
import { getRequestedExitCode, setRequestedExitCode } from '../runtime-exit-code.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

let tmpDir: string
let ticket: string
let homeDir: string
let origHome: string | undefined
let createdRepos: string[]

// readLedger/appendEvent resolve through the durable store, which is homedir()-relative —
// override HOME so these tests never touch the real ~/.claude/workflow-state.
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'stance-test-'))
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  ticket = `FLOW-TEST-${uniqueId}`
  homeDir = mkdtempSync(join(tmpdir(), 'stance-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
  createdRepos = []
  setRequestedExitCode(0)
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

const gitRun = (repo: string, args: string[]): void => {
  const result = spawnSync('git', args, { cwd: repo, stdio: 'pipe' })
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString() ?? ''}`)
}

const makeRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), 'stance-test-repo-'))
  createdRepos.push(repo)
  const run = (...args: string[]): void => {
    const result = spawnSync('git', args, { cwd: repo, stdio: 'pipe' })
    if (result.status !== 0)
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString() ?? ''}`)
  }
  run('init', '--initial-branch=main')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'Test')
  writeFileSync(join(repo, 'seed.txt'), 'seed\n')
  run('add', '-A')
  run('commit', '-m', 'seed')
  // clause (c) reads origin/main; a local ref under refs/remotes makes it resolvable with no remote.
  run('update-ref', 'refs/remotes/origin/main', 'HEAD')
  return repo
}

const headSha = (repo: string): string =>
  spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.toString().trim()

const commitFiles = (repo: string, files: Record<string, string>, message: string): string => {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  gitRun(repo, ['add', '-A'])
  gitRun(repo, ['commit', '-m', message])
  return headSha(repo)
}

const commitFile = (repo: string, path: string, content: string, message: string): string =>
  commitFiles(repo, { [path]: content }, message)

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

interface CliResult {
  stdout: string
  exitCode: number | null
}

/** Run the real CLI as a separate process sharing this test's HOME; captures stdout and exit code. */
const runCli = (args: string[]): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', mainTsPath, ...args], {
      env: { ...process.env, HOME: homeDir },
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (exitCode) => resolve({ stdout, exitCode }))
  })

// Closes round 1 with `sha` under an adversarial stance and advances to round 2 — mirrors what
// `next-round --stance adversarial` does, without depending on the run layer.
const closeRoundOneAdversarial = (t: string, sha: string): void => {
  appendEvent(t, {
    kind: 'round-reviewed',
    at: new Date().toISOString(),
    round: 1,
    reviewedSha: sha,
    stance: 'adversarial',
  })
  appendEvent(t, { kind: 'round', at: new Date().toISOString(), round: 2 })
}

test('classifyPath reads a skills path as code, not documentation', () => {
  assert.equal(classifyPath('skills/code-review/references/checklist.md'), 'code')
})

test('classifyPath reads an extensionless bin script as code', () => {
  assert.equal(classifyPath('bin/review-ledger'), 'code')
})

test('classifyPath reads a file literally named test as code, not a test directory', () => {
  assert.equal(classifyPath('bin/test'), 'code')
})

test('classifyPath reads a file literally named tests as code, not a test directory', () => {
  assert.equal(classifyPath('scripts/tests'), 'code')
})

test('classifyPath still reads a genuine test directory as test', () => {
  assert.equal(classifyPath('tools/cli/test/fixture.ts'), 'test')
})

test('classifyPath reads underscore- and suffix-convention test files as test', () => {
  for (const path of [
    'pkg/foo_test.go',
    'app/test_foo.py',
    'app/foo_test.py',
    'lib/foo_spec.rb',
    'src/FooTests.cs',
  ])
    assert.equal(classifyPath(path), 'test', path)
  assert.equal(classifyPath('src/Contest.cs'), 'code')
})

test('clause a fires on a new non-test non-doc file', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)
  const pinnedSha = commitFile(repo, 'src/newFile.ts', 'export const x = 1\n', 'add new file')

  const outcome = computeStance(ticket, pinnedSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.clauses.a.verdict, 'fired')
  assert.deepEqual(outcome.report.clauses.a.paths, ['src/newFile.ts'])
})

test('clause a excludes a new file introduced by a discharged fix commit', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)
  const fixSha = commitFile(repo, 'src/fixed.ts', 'fix\n', 'fix a finding by adding a new file')
  appendEvent(ticket, {
    kind: 'finding-open',
    at: new Date().toISOString(),
    id: 'finding-a-discharge',
    round: 1,
    file: 'src/fixed.ts',
    symbol: 'y',
    summary: 'a finding this new file fixes',
  })
  appendEvent(ticket, {
    kind: 'finding-status',
    at: new Date().toISOString(),
    id: 'finding-a-discharge',
    round: 2,
    status: 'fixed',
    fixCommit: fixSha,
  })

  const outcome = computeStance(ticket, fixSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.clauses.a.verdict, 'did-not-fire')
  assert.deepEqual(outcome.report.clauses.a.paths, [])
})

test('clause a still fires on an unrelated new file added in the same discharged fix commit', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)
  const fixSha = commitFiles(
    repo,
    { 'src/fixed.ts': 'fix\n', 'src/unrelated.ts': 'export const z = 1\n' },
    'fix a finding, and add an unrelated new file in the same commit'
  )
  appendEvent(ticket, {
    kind: 'finding-open',
    at: new Date().toISOString(),
    id: 'finding-a-discharge-partial',
    round: 1,
    file: 'src/fixed.ts',
    symbol: 'y',
    summary: 'a finding this new file fixes',
  })
  appendEvent(ticket, {
    kind: 'finding-status',
    at: new Date().toISOString(),
    id: 'finding-a-discharge-partial',
    round: 2,
    status: 'fixed',
    fixCommit: fixSha,
  })

  const outcome = computeStance(ticket, fixSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.clauses.a.verdict, 'fired')
  assert.deepEqual(outcome.report.clauses.a.paths, ['src/unrelated.ts'])
})

// Shared by the two "(shared fixture)" tests below so a reviewer can read the two test bodies as
// one differential rather than re-deriving that they are related: B's setup is exactly A's plus
// one unrelated existing path modified in the same discharged fix commit, nothing else varies.
// fixSha must be the only commit in range beyond the anchor, or an extra commit's own
// always-undischarged pair would keep newScope non-empty regardless of dischargedPairs' matching
// rule.
const buildClauseBSharedFixture = (
  extraUnrelatedPath?: string
): { repo: string; fixSha: string } => {
  const repo = makeRepo()
  const anchorFiles: Record<string, string> = { 'tools/cli/src/anchor.ts': 'a\n' }
  if (extraUnrelatedPath !== undefined) anchorFiles[extraUnrelatedPath] = 'o1\n'
  const anchorSha = commitFiles(repo, anchorFiles, 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)

  const fixFiles: Record<string, string> = { 'tools/cli/src/fixed.ts': 'fix\n' }
  if (extraUnrelatedPath !== undefined) fixFiles[extraUnrelatedPath] = 'o2\n'
  const fixSha = commitFiles(
    repo,
    fixFiles,
    extraUnrelatedPath === undefined
      ? 'fix a finding'
      : 'fix a finding, and modify an unrelated existing file in the same commit'
  )
  appendEvent(ticket, {
    kind: 'finding-open',
    at: new Date().toISOString(),
    id: 'finding-b-shared',
    round: 1,
    file: 'tools/cli/src/fixed.ts',
    symbol: 'y',
    summary: 'a finding this commit fixes',
  })
  appendEvent(ticket, {
    kind: 'finding-status',
    at: new Date().toISOString(),
    id: 'finding-b-shared',
    round: 2,
    status: 'fixed',
    fixCommit: fixSha,
  })
  return { repo, fixSha }
}

test('clause b does not fire when every (commit, path) pair in range is discharged (shared fixture)', () => {
  const { repo, fixSha } = buildClauseBSharedFixture()

  const outcome = computeStance(ticket, fixSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.clauses.b.verdict, 'did-not-fire')
  assert.equal(
    outcome.report.clauses.b.note,
    "no new-scope (commit, path) pairs — every (commit, path) pair this round's range touches is one some finding on the ledger has ever named as its own (fixCommit, file) pair, with no round or acceptance check of its own"
  )
})

test('clause b remains undetermined on an unrelated existing file modified in the same discharged fix commit (shared fixture)', () => {
  const { repo, fixSha } = buildClauseBSharedFixture('tools/cli/src/other.ts')

  const outcome = computeStance(ticket, fixSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.clauses.b.verdict, 'undetermined')
  assert.deepEqual(outcome.report.clauses.b.pairs, [`${fixSha} tools/cli/src/other.ts`])
})

test('clause b is undetermined and lists the new scope pairs', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'tools/cli/src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)
  const pinnedSha = commitFile(repo, 'tools/cli/src/anchor.ts', 'a2\n', 'modify undischarged file')

  const outcome = computeStance(ticket, pinnedSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.clauses.b.verdict, 'undetermined')
  assert.deepEqual(outcome.report.clauses.b.pairs, [`${pinnedSha} tools/cli/src/anchor.ts`])
})

test('clause b does not fire when every new-scope pair is skipped by the pre-filter', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'docs/plan.md', 'v1\n', 'anchor commit touching a doc')
  closeRoundOneAdversarial(ticket, anchorSha)
  const pinnedSha = commitFile(repo, 'docs/plan.md', 'v2\n', 'modify the doc, undischarged')

  const outcome = computeStance(ticket, pinnedSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.clauses.b.verdict, 'did-not-fire')
  assert.equal(outcome.report.stance, 'cleanup')
})

test('clause b does not fire on a declarable-extension path outside the compilable package', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(
    repo,
    'eslint.config.js',
    'v1\n',
    'anchor commit touching root config'
  )
  closeRoundOneAdversarial(ticket, anchorSha)
  const pinnedSha = commitFile(repo, 'eslint.config.js', 'v2\n', 'modify root config, undischarged')

  const outcome = computeStance(ticket, pinnedSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.clauses.b.verdict, 'did-not-fire')
  assert.equal(
    outcome.report.clauses.b.note,
    "every new-scope pair was skipped by the specification's own pre-filter (a non-ts extension, a path outside the one compilable package, or absence at one side of the pair) before the declaration diff — see skills/code-review/references/checklist.md, Checking clause (b)"
  )
  assert.equal(outcome.report.stance, 'cleanup')
})

test('clause c fires on a path the anchor round never touched', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/reviewedFile.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)
  const pinnedSha = commitFiles(
    repo,
    { 'src/reviewedFile.ts': 'a2\n', 'src/newTerritory.ts': 'b\n' },
    'touch a reviewed path and add new territory'
  )

  const outcome = computeStance(ticket, pinnedSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.clauses.c.verdict, 'fired')
  assert.deepEqual(outcome.report.clauses.c.paths, ['src/newTerritory.ts'])
})

test("clause c fires on a path origin/main gained independently after the anchor round, that the branch also touches — the reviewed set must be merge-base-relative (three-dot), not a straight two-dot tree diff against origin/main's current tip", () => {
  const repo = makeRepo()
  const seedSha = headSha(repo)
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)

  // origin/main advances independently of this branch — a sibling commit off the pre-anchor seed,
  // not a descendant of anchorSha — the way a squash-merged unrelated ticket lands on main.
  gitRun(repo, ['checkout', seedSha])
  const mainAdvanceSha = commitFile(
    repo,
    'shared/tool.ts',
    'main-side\n',
    'unrelated ticket lands on main'
  )
  gitRun(repo, ['update-ref', 'refs/remotes/origin/main', mainAdvanceSha])
  gitRun(repo, ['checkout', 'main'])

  const pinnedSha = commitFile(
    repo,
    'shared/tool.ts',
    'branch-side\n',
    'this branch independently touches the same path'
  )

  const outcome = computeStance(ticket, pinnedSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.clauses.c.verdict, 'fired')
  assert.deepEqual(outcome.report.clauses.c.paths, ['shared/tool.ts'])
})

test('clause c does not fire on a path named by a finding raised at or before the anchor', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/other.ts', 'x\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)
  appendEvent(ticket, {
    kind: 'finding-open',
    at: new Date().toISOString(),
    id: 'finding-mentioned',
    round: 1,
    file: 'src/mentioned.ts',
    symbol: 'someSymbol',
    summary: 'a finding naming a path the anchor diff never touched',
  })
  const pinnedSha = commitFile(repo, 'src/mentioned.ts', 'y\n', 'touch the mentioned path')

  const outcome = computeStance(ticket, pinnedSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.clauses.c.verdict, 'did-not-fire')
  assert.deepEqual(outcome.report.clauses.c.paths, [])
})

test('computeStance refuses instead of throwing when origin/main does not resolve', () => {
  const repo = makeRepo()
  gitRun(repo, ['update-ref', '-d', 'refs/remotes/origin/main'])
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)
  const pinnedSha = commitFile(repo, 'src/two.ts', 'b\n', 'round 2 commit')

  const outcome = computeStance(ticket, pinnedSha, repo)
  assert.equal(outcome.ok, false)
  if (outcome.ok) throw new Error('expected refusal')
  assert.equal(outcome.code, 'git-precondition')
  assert.match(outcome.error, /origin\/main/)
})

test('computeStance returns cleanup when no clause fires', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)

  const outcome = computeStance(ticket, anchorSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.stance, 'cleanup')
})

test('computeStance returns undetermined rather than cleanup when clause b is undetermined', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(
    repo,
    'tools/cli/src/target.ts',
    'v1\n',
    'anchor commit touching target'
  )
  closeRoundOneAdversarial(ticket, anchorSha)
  const pinnedSha = commitFile(
    repo,
    'tools/cli/src/target.ts',
    'v2\n',
    'modify target, undischarged'
  )

  const outcome = computeStance(ticket, pinnedSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.clauses.b.verdict, 'undetermined')
  assert.equal(outcome.report.stance, 'undetermined')
})

test('computeStance refuses a null anchor', () => {
  appendEvent(ticket, {
    kind: 'finding-open',
    at: new Date().toISOString(),
    id: 'finding-no-round-reviewed',
    round: 1,
    file: 'a',
    symbol: 'b',
    summary: 'c',
  })

  const outcome = computeStance(ticket, 'deadbeef', tmpDir)
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.code, 'null-anchor')
})

test('dischargedPairs refuses when a fixCommit prefix matches more than one commit', () => {
  appendEvent(ticket, {
    kind: 'finding-open',
    at: new Date().toISOString(),
    id: 'finding-ambiguous',
    round: 1,
    file: 'src/two.ts',
    symbol: 'x',
    summary: 'a finding whose fix commit prefix matches two commits',
  })
  appendEvent(ticket, {
    kind: 'finding-status',
    at: new Date().toISOString(),
    id: 'finding-ambiguous',
    round: 2,
    status: 'fixed',
    fixCommit: 'abcdef1',
  })
  const ledger = readLedger(ticket)

  const result = dischargedPairs(ledger, [
    'abcdef1000000000000000000000000000000000 src/two.ts',
    'abcdef1111111111111111111111111111111111 src/two.ts',
  ])
  assert.equal(result.ambiguous.length, 1)
  assert.match(result.ambiguous[0], /finding-ambiguous/)
  assert.equal(result.pairs.size, 0)
})

test('dischargedPairs excludes only the finding-named path, not every path its fix commit touches', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)
  const fixSha = commitFiles(
    repo,
    { 'src/finding-file.ts': 'fix\n', 'src/unrelated.ts': 'export const y = 1\n' },
    'fix a finding, and touch an unrelated file in the same commit'
  )
  appendEvent(ticket, {
    kind: 'finding-open',
    at: new Date().toISOString(),
    id: 'finding-whole-commit-exclusion',
    round: 1,
    file: 'src/finding-file.ts',
    symbol: 'y',
    summary: 'a finding fixed by a commit that also touches an unrelated file',
  })
  appendEvent(ticket, {
    kind: 'finding-status',
    at: new Date().toISOString(),
    id: 'finding-whole-commit-exclusion',
    round: 2,
    status: 'fixed',
    fixCommit: fixSha,
  })
  const ledger = readLedger(ticket)

  const result = dischargedPairs(ledger, [
    `${fixSha} src/finding-file.ts`,
    `${fixSha} src/unrelated.ts`,
  ])
  assert.equal(result.ambiguous.length, 0)
  assert.deepEqual([...result.pairs], [`${fixSha} src/finding-file.ts`])
})

test('clause b stays undetermined over an unrelated exported-surface path a fix commit also touches', () => {
  const repo = makeRepo()
  const anchorSha = commitFiles(
    repo,
    {
      'tools/cli/src/finding-file.ts': 'export const x = 1\n',
      'tools/cli/src/unrelated.ts': 'export const y = 1\n',
    },
    'anchor commit'
  )
  closeRoundOneAdversarial(ticket, anchorSha)
  const fixSha = commitFiles(
    repo,
    {
      'tools/cli/src/finding-file.ts': 'export const x = 2\n',
      'tools/cli/src/unrelated.ts': 'export const y = 2\n',
    },
    'fix a finding, and touch an unrelated exported file in the same commit'
  )
  appendEvent(ticket, {
    kind: 'finding-open',
    at: new Date().toISOString(),
    id: 'finding-clause-b-exclusion',
    round: 1,
    file: 'tools/cli/src/finding-file.ts',
    symbol: 'x',
    summary: 'a finding fixed by a commit that also touches an unrelated exported file',
  })
  appendEvent(ticket, {
    kind: 'finding-status',
    at: new Date().toISOString(),
    id: 'finding-clause-b-exclusion',
    round: 2,
    status: 'fixed',
    fixCommit: fixSha,
  })

  const outcome = computeStance(ticket, fixSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.clauses.b.verdict, 'undetermined')
  assert.deepEqual(outcome.report.clauses.b.pairs, [`${fixSha} tools/cli/src/unrelated.ts`])
})

test('dischargedPairs excludes a commit once any finding-status event ever named it, not only the current fold value', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)
  const firstFixSha = commitFile(repo, 'src/target.ts', 'fix1\n', 'first attempt at a fix')
  appendEvent(ticket, {
    kind: 'finding-open',
    at: new Date().toISOString(),
    id: 'finding-reopened',
    round: 1,
    file: 'src/target.ts',
    symbol: 'y',
    summary: 'a finding fixed, reopened, and fixed again under a different commit',
  })
  appendEvent(ticket, {
    kind: 'finding-status',
    at: new Date().toISOString(),
    id: 'finding-reopened',
    round: 2,
    status: 'fixed',
    fixCommit: firstFixSha,
  })
  // Re-raise reopens the finding and drops its current fixCommit — see ledger.ts's finding-open
  // fold — but must not drop it from allFixCommits.
  appendEvent(ticket, {
    kind: 'finding-open',
    at: new Date().toISOString(),
    id: 'finding-reopened',
    round: 3,
    file: 'src/target.ts',
    symbol: 'y',
    summary: 'a finding fixed, reopened, and fixed again under a different commit',
  })
  const secondFixSha = commitFile(repo, 'src/target.ts', 'fix2\n', 'second attempt at a fix')
  appendEvent(ticket, {
    kind: 'finding-status',
    at: new Date().toISOString(),
    id: 'finding-reopened',
    round: 3,
    status: 'fixed',
    fixCommit: secondFixSha,
  })
  const ledger = readLedger(ticket)
  assert.equal(
    ledger.findings.find((f) => f.id === 'finding-reopened')!.fixCommit,
    secondFixSha,
    'precondition: the current folded fixCommit is only the second one'
  )

  const result = dischargedPairs(ledger, [
    `${firstFixSha} src/target.ts`,
    `${secondFixSha} src/target.ts`,
  ])
  assert.equal(result.ambiguous.length, 0)
  assert.deepEqual(
    [...result.pairs].sort(),
    [`${firstFixSha} src/target.ts`, `${secondFixSha} src/target.ts`].sort()
  )
})

test('a blank fixCommit does not silently discharge the commit it names', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)
  const fixSha = commitFile(repo, 'src/fixed.ts', 'fix\n', 'fix a finding, corrupted fixCommit')
  appendEvent(ticket, {
    kind: 'finding-open',
    at: new Date().toISOString(),
    id: 'finding-blank-fixcommit',
    round: 1,
    file: 'src/fixed.ts',
    symbol: 'y',
    summary: 'a finding whose fixCommit is corrupted to the empty string',
  })
  appendEvent(ticket, {
    kind: 'finding-status',
    at: new Date().toISOString(),
    id: 'finding-blank-fixcommit',
    round: 2,
    status: 'fixed',
    fixCommit: '',
  })

  const outcome = computeStance(ticket, fixSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.clauses.a.verdict, 'fired')
  assert.deepEqual(outcome.report.clauses.a.paths, ['src/fixed.ts'])
})

test('the construction gap guard skips with a note when the anchor is off the first-parent chain', () => {
  const repo = makeRepo()
  gitRun(repo, ['checkout', '-b', 'side'])
  const anchorSha = commitFile(repo, 'src/side.ts', 'side\n', 'side branch commit')
  gitRun(repo, ['checkout', 'main'])
  commitFile(repo, 'src/main.ts', 'main\n', 'main branch commit')
  gitRun(repo, ['merge', '-s', 'ours', '--no-edit', 'side'])
  const pinnedSha = headSha(repo)

  closeRoundOneAdversarial(ticket, anchorSha)
  const outcome = computeStance(ticket, pinnedSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.ok(outcome.report.notes !== undefined, 'a note is present')
  assert.match(outcome.report.notes![0], /CONSTRUCTION GAP SKIPPED/)
})

test('delta scope reports tier-1 on a documentation-only round', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)
  const pinnedSha = commitFile(repo, 'docs/notes.md', 'notes\n', 'documentation-only change')

  const outcome = computeStance(ticket, pinnedSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.deltaScope.tier, 'tier-1')
  assert.deepEqual(outcome.report.deltaScope.codePaths, [])
  assert.deepEqual(outcome.report.deltaScope.paths, ['docs/notes.md'])
})

test('delta scope quotes each code path as its own argument', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)
  const pinnedSha = commitFiles(
    repo,
    { 'src/one.ts': '1\n', 'src/two.ts': '2\n' },
    'two code changes'
  )

  const outcome = computeStance(ticket, pinnedSha, repo)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.deltaScope.tier, 'tier-2-candidate')
  assert.equal(
    outcome.report.deltaScope.command,
    `git diff -U0 ${anchorSha}..${pinnedSha} -- 'src/one.ts' 'src/two.ts'`
  )
})

test('computeStance refuses with stale-recorded-sha when previousRoundSha does not resolve', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)
  // Round 2 closes with a well-formed but nonexistent reviewedSha — the way a licensed --reason
  // override on either closing command can record one (computeStance's own unresolvable-sha check only ever
  // covers the sha it is CURRENTLY evaluating, not a value an earlier round already has on record).
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: new Date().toISOString(),
    round: 2,
    reviewedSha: '0000000000000000000000000000000000dead',
    stance: 'cleanup',
  })
  appendEvent(ticket, { kind: 'round', at: new Date().toISOString(), round: 3 })
  const pinnedSha = commitFile(repo, 'src/three.ts', 'c\n', 'round 3 commit')

  const outcome = computeStance(ticket, pinnedSha, repo)
  assert.equal(outcome.ok, false)
  if (outcome.ok) throw new Error('expected refusal')
  assert.equal(outcome.code, 'stale-recorded-sha')
  assert.match(outcome.error, /0000000000000000000000000000000000dead/)
  assert.match(outcome.error, /stop-and-escalate/, 'names the stop-and-escalate remedy')
  assert.match(outcome.error, /--reason/, 'names --reason as the licensed escape')
  assert.doesNotMatch(
    outcome.error,
    /next-round --reviewed-sha/,
    'must not name a re-record action next-round cannot perform'
  )
})

test('computeStance names the ambiguous cause, not "no longer resolves", when previousRoundSha is a colliding short prefix', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)
  // Same real collision fixture as the pinnedSha-ambiguous test above.
  writeFileSync(join(repo, 'collide-a.txt'), 'flow309-collision-fixture-4809\n')
  writeFileSync(join(repo, 'collide-b.txt'), 'flow309-collision-fixture-21065\n')
  gitRun(repo, ['hash-object', '-w', join(repo, 'collide-a.txt')])
  gitRun(repo, ['hash-object', '-w', join(repo, 'collide-b.txt')])
  const ambiguousPrefix = 'c83d131'
  // Round 2 closed with a short recorded reviewedSha — a licensed --reason override on either
  // closing command can record any parseShaLike-shaped (7-40 hex) value, same as the
  // does-not-resolve test above.
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: new Date().toISOString(),
    round: 2,
    reviewedSha: ambiguousPrefix,
    stance: 'cleanup',
  })
  appendEvent(ticket, { kind: 'round', at: new Date().toISOString(), round: 3 })
  const pinnedSha = commitFile(repo, 'src/three.ts', 'c\n', 'round 3 commit')

  const outcome = computeStance(ticket, pinnedSha, repo)
  assert.equal(outcome.ok, false)
  if (outcome.ok) throw new Error('expected refusal')
  assert.equal(outcome.code, 'stale-recorded-sha')
  assert.match(outcome.error, new RegExp(`${ambiguousPrefix} is ambiguous`))
  assert.match(outcome.error, /matches 2 objects/)
  assert.doesNotMatch(
    outcome.error,
    /no longer resolves to an object/,
    'an ambiguous recorded sha must not be reported as though it matched nothing'
  )
})

test('computeStance refuses rather than reporting tier: none when a round-reviewed line was dropped from the fold', () => {
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/anchor.ts', 'a\n', 'round 1 anchor commit')
  closeRoundOneAdversarial(ticket, round1Sha)
  const round2Sha = commitFile(repo, 'src/round2.ts', 'b\n', 'round 2 commit')
  // A blank reviewedSha fails parseEvent's isNonBlankString check, so this line is dropped and
  // counted in skippedLines — the following round event still survives, advancing the ledger to
  // round 3 with no record of round 2 ever having closed.
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: new Date().toISOString(),
    round: 2,
    reviewedSha: '',
    stance: 'adversarial',
  })
  appendEvent(ticket, { kind: 'round', at: new Date().toISOString(), round: 3 })

  const ledger = readLedger(ticket)
  assert.equal(ledger.skippedLines, 1)
  assert.equal(ledger.round, 3)
  assert.equal(ledger.reviewedShas['2'], undefined)

  const outcome = computeStance(ticket, round2Sha, repo)
  assert.equal(outcome.ok, false)
  if (outcome.ok) throw new Error('expected refusal')
  assert.equal(outcome.code, 'missing-round-record')
  assert.match(outcome.error, /ambiguous/)
})

test('computeStance refuses a missing previousRoundSha even when the ledger parses cleanly', () => {
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/anchor.ts', 'a\n', 'round 1 anchor commit')
  closeRoundOneAdversarial(ticket, round1Sha)
  const round2Sha = commitFile(repo, 'src/round2.ts', 'b\n', 'round 2 commit')
  // Round 2 closes with only a 'round' event and no 'round-reviewed' event at all — every line here
  // parses cleanly (skippedLines stays 0), so this is the missing-record case the checklist calls a
  // stop-and-escalate that a corrupted-line guard alone could never catch.
  appendEvent(ticket, { kind: 'round', at: new Date().toISOString(), round: 3 })

  const ledger = readLedger(ticket)
  assert.equal(ledger.skippedLines, 0)
  assert.equal(ledger.round, 3)
  assert.equal(ledger.reviewedShas['2'], undefined)

  const outcome = computeStance(ticket, round2Sha, repo)
  assert.equal(outcome.ok, false)
  if (outcome.ok) throw new Error('expected refusal')
  assert.equal(outcome.code, 'missing-round-record')
  assert.match(outcome.error, /missing round 2's 'round-reviewed' record/)
  assert.doesNotMatch(
    outcome.error,
    /ambiguous/,
    'a clean ledger must not be reported as ambiguous — that word is reserved for skippedLines > 0'
  )
})

test('runStance exits 10 and still prints the full report when the stance is undetermined', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(
    repo,
    'tools/cli/src/target.ts',
    'v1\n',
    'anchor commit touching target'
  )
  closeRoundOneAdversarial(ticket, anchorSha)
  const pinnedSha = commitFile(
    repo,
    'tools/cli/src/target.ts',
    'v2\n',
    'modify target, undischarged'
  )

  const output = captureStdout(() => runStance(ticket, pinnedSha, repo))
  assert.equal(getRequestedExitCode(), 10)
  const report = JSON.parse(output) as { stance: string }
  assert.equal(report.stance, 'undetermined')
})

test('runStance exits 8 when the ticket has no ledger', () => {
  const repo = makeRepo()

  const output = captureStdout(() => runStance(ticket, 'deadbeef', repo))
  assert.equal(getRequestedExitCode(), 8)
  const report = JSON.parse(output) as { error: string }
  assert.match(report.error, /no ledger on disk/)
})

test('runStance exits 11 on a null anchor', () => {
  const repo = makeRepo()
  appendEvent(ticket, {
    kind: 'finding-open',
    at: new Date().toISOString(),
    id: 'finding-no-round-reviewed',
    round: 1,
    file: 'a',
    symbol: 'b',
    summary: 'c',
  })

  const output = captureStdout(() => runStance(ticket, 'deadbeef', repo))
  assert.equal(getRequestedExitCode(), 11)
  const report = JSON.parse(output) as { error: string }
  assert.match(report.error, /no round has closed with an adversarial stance/)
})

test('runStance exits 12 when the repo root cannot be resolved', () => {
  const output = captureStdout(() => runStance(ticket, 'deadbeef', tmpDir))
  assert.equal(getRequestedExitCode(), 12)
  const report = JSON.parse(output) as { error: string }
  assert.match(report.error, /cannot resolve a git repo root/)
})

test('the stance verb is registered on the review-ledger route map', async () => {
  const result = await runCli([
    'review-ledger',
    'stance',
    '--ticket',
    ticket,
    '--sha',
    'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    '--repo-root',
    process.cwd(),
  ])
  const report = JSON.parse(result.stdout) as { error: string }
  assert.equal(
    result.exitCode,
    8,
    'the stance route reaches runStance, which exits 8 for a ticket with no ledger'
  )
  assert.match(report.error, /no ledger on disk/)
})

test('CLI: review-ledger stance --help states the exact brief runStance actually enforces, word for word — round 8 (an untested brief drifted from code twice)', async () => {
  const result = await runCli(['review-ledger', 'stance', '--help'])
  assert.equal(result.exitCode, 0)
  const briefLine = result.stdout
    .split('\n')
    .find((line) => line.startsWith('Compute the review stance for a pinned sha'))
  assert.equal(
    briefLine,
    "Compute the review stance for a pinned sha — exits 8 if the ticket has no ledger on disk, 10 if undetermined, 11 on a null anchor, 12 on a failed git precondition, 13 if the previous round's reviewed sha is null at report round 2 or later, 14 if a sha the ledger itself recorded no longer resolves, is ambiguous, or is no longer an ancestor of the pinned sha"
  )
})

test('computeStance refuses with stale-recorded-sha when the pinned sha precedes the anchor (backwards range)', () => {
  const repo = makeRepo()
  const earlySha = commitFile(repo, 'src/a.ts', 'a\n', 'early commit')
  const laterSha = commitFile(repo, 'src/b.ts', 'b\n', 'later commit')
  closeRoundOneAdversarial(ticket, laterSha)

  const outcome = computeStance(ticket, earlySha, repo)
  assert.equal(outcome.ok, false)
  if (outcome.ok) throw new Error('expected refusal')
  assert.equal(outcome.code, 'stale-recorded-sha')
  assert.match(outcome.error, /backwards/)
  assert.match(outcome.error, /stop-and-escalate/, 'names the stop-and-escalate remedy')
  assert.match(outcome.error, /--reason/, 'names --reason as the licensed escape')
  assert.doesNotMatch(
    outcome.error,
    /next-round --reviewed-sha/,
    'must not name a re-record action next-round cannot perform'
  )
})

test('computeStance refuses with stale-recorded-sha when the anchor and pinned sha have diverged', () => {
  const repo = makeRepo()
  gitRun(repo, ['checkout', '-b', 'branch-a'])
  const shaA = commitFile(repo, 'src/a.ts', 'a\n', 'branch a commit')
  gitRun(repo, ['checkout', 'main'])
  gitRun(repo, ['checkout', '-b', 'branch-b'])
  const shaB = commitFile(repo, 'src/b.ts', 'b\n', 'branch b commit')
  closeRoundOneAdversarial(ticket, shaA)

  const outcome = computeStance(ticket, shaB, repo)
  assert.equal(outcome.ok, false)
  if (outcome.ok) throw new Error('expected refusal')
  assert.equal(outcome.code, 'stale-recorded-sha')
  assert.match(outcome.error, /diverged/)
  assert.match(outcome.error, /stop-and-escalate/, 'names the stop-and-escalate remedy')
  assert.doesNotMatch(
    outcome.error,
    /next-round --reviewed-sha/,
    'must not name a re-record action next-round cannot perform'
  )
})

test('computeStance refuses with stale-recorded-sha when previousRoundSha has diverged from the pinned sha, even though the anchor has not', () => {
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/a.ts', 'a\n', 'round 1 commit, on main')
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: new Date().toISOString(),
    round: 1,
    reviewedSha: round1Sha,
    stance: 'adversarial',
  })
  appendEvent(ticket, { kind: 'round', at: new Date().toISOString(), round: 2 })

  gitRun(repo, ['checkout', '-b', 'branch-x'])
  const round2Sha = commitFile(repo, 'src/b.ts', 'b\n', 'round 2 commit, on a diverged branch')
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: new Date().toISOString(),
    round: 2,
    reviewedSha: round2Sha,
    stance: 'cleanup',
  })
  appendEvent(ticket, { kind: 'round', at: new Date().toISOString(), round: 3 })

  gitRun(repo, ['checkout', 'main'])
  const pinnedSha = commitFile(
    repo,
    'src/c.ts',
    'c\n',
    'round 3 commit, continues main from round 1'
  )

  const outcome = computeStance(ticket, pinnedSha, repo)
  assert.equal(outcome.ok, false)
  if (outcome.ok) throw new Error('expected refusal')
  assert.equal(outcome.code, 'stale-recorded-sha')
  assert.match(
    outcome.error,
    /diverged/,
    'the anchor (round1Sha) IS an ancestor of pinnedSha, so only the previousRoundSha guard can be refusing this'
  )
})

test('computeStance refuses with stale-recorded-sha when previousRoundSha is backwards because the branch was force-reset past a closed round', () => {
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/a.ts', 'a\n', 'round 1 commit')
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: new Date().toISOString(),
    round: 1,
    reviewedSha: round1Sha,
    stance: 'adversarial',
  })
  appendEvent(ticket, { kind: 'round', at: new Date().toISOString(), round: 2 })

  const round2Sha = commitFile(repo, 'src/b.ts', 'b\n', 'round 2 commit')
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: new Date().toISOString(),
    round: 2,
    reviewedSha: round2Sha,
    stance: 'cleanup',
  })
  appendEvent(ticket, { kind: 'round', at: new Date().toISOString(), round: 3 })

  // Force-reset the branch backward, past round 2's already-closed review — round2Sha is discarded
  // from the branch's history entirely, not merely superseded by new commits (which is the
  // "diverged" case above). round2Sha is now a descendant of the branch tip, not an ancestor of it.
  //
  // This must run and assert before any gc/reflog-expire touches the repo. round2Sha is only
  // unreachable, not deleted, immediately after `reset --hard` — the discarded commit is still a
  // real object, reachable via the reflog, so isAncestor's `merge-base --is-ancestor` still resolves
  // it and takes the "backwards" branch this test targets. Once gc reclaims it, `recordedSha^{commit}`
  // stops resolving at all and the code takes the earlier, already-covered "no longer resolves"
  // branch instead — a different code path that would pass even if the "backwards" dispatch fix
  // this test exists to pin were never made. So this test must not call `git gc` or
  // `git reflog expire` anywhere, before or after the reset.
  gitRun(repo, ['reset', '--hard', round1Sha])

  const outcome = computeStance(ticket, round1Sha, repo)
  assert.equal(outcome.ok, false)
  if (outcome.ok) throw new Error('expected refusal')
  assert.equal(outcome.code, 'stale-recorded-sha')
  assert.match(
    outcome.error,
    /backwards/,
    'the anchor (round1Sha) IS an ancestor of pinnedSha (they are equal here), so only the previousRoundSha guard can be refusing this'
  )
  assert.match(outcome.error, /stop-and-escalate/, 'names the stop-and-escalate remedy')
  assert.match(outcome.error, /--reason/, 'names --reason as the licensed escape')
  assert.doesNotMatch(
    outcome.error,
    /next-round --reviewed-sha/,
    'must not name a re-record action next-round cannot perform'
  )
})

test('runStance exits 14 when the pinned sha precedes the anchor (backwards range)', () => {
  const repo = makeRepo()
  const earlySha = commitFile(repo, 'src/a.ts', 'a\n', 'early commit')
  const laterSha = commitFile(repo, 'src/b.ts', 'b\n', 'later commit')
  closeRoundOneAdversarial(ticket, laterSha)

  const output = captureStdout(() => runStance(ticket, earlySha, repo))
  assert.equal(getRequestedExitCode(), 14)
  const report = JSON.parse(output) as { error: string; stance?: string }
  assert.match(report.error, /backwards/)
  assert.notEqual(report.stance, 'cleanup')
})

test('runStance exits 14 when the anchor and pinned sha have diverged', () => {
  const repo = makeRepo()
  gitRun(repo, ['checkout', '-b', 'branch-a'])
  const shaA = commitFile(repo, 'src/a.ts', 'a\n', 'branch a commit')
  gitRun(repo, ['checkout', 'main'])
  gitRun(repo, ['checkout', '-b', 'branch-b'])
  const shaB = commitFile(repo, 'src/b.ts', 'b\n', 'branch b commit')
  closeRoundOneAdversarial(ticket, shaA)

  const output = captureStdout(() => runStance(ticket, shaB, repo))
  assert.equal(getRequestedExitCode(), 14)
  const report = JSON.parse(output) as { error: string; stance?: string }
  assert.match(report.error, /diverged/)
  assert.notEqual(report.stance, 'cleanup')
})

// checkForwardRange's backwards branch is reachable from two call sites: the ledger's own recorded
// sha (checkRecordedSha, above — refuses stale-recorded-sha) and a caller-supplied --anchor override
// (computeStance's anchorOverride branch — stays the plain, non-refusing git-precondition, since this
// value was never something the ledger vouched for). Only the override path still exercises
// checkForwardRange's non-refusing return directly; without this test, collapsing the override call
// site onto checkRecordedSha (as the reverted fix once did) would break it with nothing red.
test('computeStance keeps the plain, non-refusing git-precondition when an --anchor override is backwards', () => {
  const repo = makeRepo()
  const earlySha = commitFile(repo, 'src/a.ts', 'a\n', 'early commit')
  const laterSha = commitFile(repo, 'src/b.ts', 'b\n', 'later commit')
  closeRoundOneAdversarial(ticket, earlySha)

  const outcome = computeStance(ticket, earlySha, repo, laterSha)
  assert.equal(outcome.ok, false)
  if (outcome.ok) throw new Error('expected refusal')
  assert.equal(outcome.code, 'git-precondition')
  assert.match(outcome.error, /backwards/)
})

test('runStance uses --anchor to override a null resolved anchor', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(
    repo,
    'tools/cli/src/target.ts',
    'v1\n',
    'anchor commit touching target'
  )
  const pinnedSha = commitFile(
    repo,
    'tools/cli/src/target.ts',
    'v2\n',
    'modify target, undischarged'
  )
  appendEvent(ticket, {
    kind: 'finding-open',
    at: new Date().toISOString(),
    id: 'finding-no-round-reviewed',
    round: 1,
    file: 'a',
    symbol: 'b',
    summary: 'c',
  })

  captureStdout(() => runStance(ticket, pinnedSha, repo))
  assert.equal(
    getRequestedExitCode(),
    11,
    'no adversarial round has closed, so the ledger anchor is null'
  )

  setRequestedExitCode(0)
  const withOverride = captureStdout(() => runStance(ticket, pinnedSha, repo, anchorSha))
  assert.equal(
    getRequestedExitCode(),
    10,
    'the override lets the range compute, landing on undetermined via the undischarged modify'
  )
  const report = JSON.parse(withOverride) as { anchorSha: string; stance: string }
  assert.equal(report.anchorSha, anchorSha)
})

test("the stance verb's --anchor flag reaches computeStance", async () => {
  const repo = makeRepo()
  const anchorSha = commitFile(
    repo,
    'tools/cli/src/target.ts',
    'v1\n',
    'anchor commit touching target'
  )
  const pinnedSha = commitFile(
    repo,
    'tools/cli/src/target.ts',
    'v2\n',
    'modify target, undischarged'
  )
  appendEvent(ticket, {
    kind: 'finding-open',
    at: new Date().toISOString(),
    id: 'finding-no-round-reviewed',
    round: 1,
    file: 'a',
    symbol: 'b',
    summary: 'c',
  })

  const result = await runCli([
    'review-ledger',
    'stance',
    '--ticket',
    ticket,
    '--sha',
    pinnedSha,
    '--anchor',
    anchorSha,
    '--repo-root',
    repo,
  ])
  assert.equal(
    result.exitCode,
    10,
    'the override reaches computeStance through the CLI and the range resolves to undetermined'
  )
  const report = JSON.parse(result.stdout) as { anchorSha: string }
  assert.equal(report.anchorSha, anchorSha)
})

test('the anchor flag overrides the ledger resolved anchor and is reported back', () => {
  const repo = makeRepo()
  const ledgerAnchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, ledgerAnchorSha)
  const pinnedSha = commitFile(
    repo,
    'src/newFile.ts',
    'export const x = 1\n',
    'introduce a new file after the ledger anchor'
  )

  const output = captureStdout(() => runStance(ticket, pinnedSha, repo, pinnedSha))
  const report = JSON.parse(output) as { anchorSha: string; stance: string }
  assert.equal(
    report.anchorSha,
    pinnedSha,
    'the override, not the ledger resolved anchor, is reported back'
  )
  assert.equal(
    report.stance,
    'cleanup',
    'anchoring at the pinned sha empties the range, so clause a has nothing to fire on'
  )
})

test("computeStance resolves an --anchor override's own round from reviewedShas, not the ledger's live round", () => {
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/anchor.ts', 'a\n', 'round 1 anchor commit')
  closeRoundOneAdversarial(ticket, round1Sha)
  const round2Sha = commitFile(repo, 'src/anchor.ts', 'b\n', 'round 2 anchor commit')
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: new Date().toISOString(),
    round: 2,
    reviewedSha: round2Sha,
    stance: 'adversarial',
  })
  appendEvent(ticket, { kind: 'round', at: new Date().toISOString(), round: 3 })

  const outcome = computeStance(ticket, round2Sha, repo, round1Sha)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(
    outcome.report.anchorRound,
    1,
    "must resolve the override's own round (1), not the ledger's live resolvedAnchor.round (2)"
  )
})

test("computeStance's round and previousRoundSha replay the overridden round, not the ledger's live round", () => {
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/anchor.ts', 'a\n', 'round 1 anchor commit')
  closeRoundOneAdversarial(ticket, round1Sha)
  const round2Sha = commitFile(repo, 'src/anchor.ts', 'b\n', 'round 2 anchor commit')
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: new Date().toISOString(),
    round: 2,
    reviewedSha: round2Sha,
    stance: 'adversarial',
  })
  appendEvent(ticket, { kind: 'round', at: new Date().toISOString(), round: 3 })

  const outcome = computeStance(ticket, round2Sha, repo, round1Sha)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(
    outcome.report.round,
    2,
    "must report round 2 (the round pinnedSha=round2Sha closed), not the ledger's live round (3)"
  )
  assert.equal(
    outcome.report.previousRoundSha,
    round1Sha,
    "must derive round 2's own predecessor (round1Sha), not the live round's predecessor " +
      '(reviewedShas["2"] = round2Sha, which would self-loop deltaScope against pinnedSha itself)'
  )
})

test('computeStance defaults anchorRound to 0 and notes it when the --anchor override is not a recorded round', () => {
  const repo = makeRepo()
  const ledgerAnchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'ledger anchor commit')
  closeRoundOneAdversarial(ticket, ledgerAnchorSha)
  const overrideSha = commitFile(repo, 'src/other.ts', 'x\n', 'commit never recorded as a round')
  const pinnedSha = commitFile(repo, 'src/other.ts', 'y\n', 'undischarged modify')

  const outcome = computeStance(ticket, pinnedSha, repo, overrideSha)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(outcome.report.anchorRound, 0)
  assert.ok(
    outcome.report.notes?.some((note) => note.includes(overrideSha)),
    'the JSON must say explicitly that this anchor round is unknown'
  )
})

test("computeStance's --anchor replay matches a reviewedShas entry stored at a different sha spelling than the query", () => {
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/anchor.ts', 'a\n', 'round 1 anchor commit')
  closeRoundOneAdversarial(ticket, round1Sha)
  const round2Sha = commitFile(repo, 'src/anchor.ts', 'b\n', 'round 2 anchor commit')
  // Stored abbreviated, as an earlier --reviewed-sha could have been passed abbreviated —
  // parseShaLike admits 7-40 hex characters on that flag.
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: new Date().toISOString(),
    round: 2,
    reviewedSha: round2Sha.slice(0, 10),
    stance: 'adversarial',
  })
  appendEvent(ticket, { kind: 'round', at: new Date().toISOString(), round: 3 })

  // Queried at full spelling — must still match the abbreviated stored value.
  const outcome = computeStance(ticket, round2Sha, repo, round1Sha)
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(
    outcome.report.round,
    2,
    'must resolve round 2 by a spelling-independent match, not fall back to the ledger live round (3)'
  )
  assert.equal(outcome.report.previousRoundSha, round1Sha)
  assert.equal(outcome.report.deltaScope.tier, 'tier-2-candidate')
  assert.notDeepEqual(
    outcome.report.deltaScope.paths,
    [],
    'a real diff against round1Sha, not a self-range no-op against round2Sha itself'
  )
})

test("computeStance resolves an --anchor override's own round even when the anchor is queried at a different sha spelling than it is stored", () => {
  const repo = makeRepo()
  const round1Sha = commitFile(repo, 'src/anchor.ts', 'a\n', 'round 1 anchor commit')
  closeRoundOneAdversarial(ticket, round1Sha)
  const round2Sha = commitFile(repo, 'src/anchor.ts', 'b\n', 'round 2 anchor commit')
  appendEvent(ticket, {
    kind: 'round-reviewed',
    at: new Date().toISOString(),
    round: 2,
    reviewedSha: round2Sha,
    stance: 'adversarial',
  })
  appendEvent(ticket, { kind: 'round', at: new Date().toISOString(), round: 3 })

  // Query --anchor abbreviated; reviewedShas['2'] is stored at round2Sha's full spelling.
  const outcome = computeStance(ticket, round2Sha, repo, round2Sha.slice(0, 10))
  if (!outcome.ok) throw new Error(`expected success: ${outcome.error}`)
  assert.equal(
    outcome.report.anchorRound,
    2,
    "must resolve the override's own round by a spelling-independent match, not default to 0"
  )
})

test('computeStance refuses an unresolvable sha instead of misreporting it as diverged history', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)
  const bogusSha = 'a'.repeat(40)

  const outcome = computeStance(ticket, bogusSha, repo)
  assert.equal(outcome.ok, false)
  if (outcome.ok) throw new Error('unreachable')
  assert.equal(outcome.code, 'git-precondition')
  assert.match(outcome.error, /unresolvable/)
})

test('computeStance names the ambiguous cause, not "does not resolve", when pinnedSha is a colliding short prefix', () => {
  const repo = makeRepo()
  const anchorSha = commitFile(repo, 'src/anchor.ts', 'a\n', 'anchor commit')
  closeRoundOneAdversarial(ticket, anchorSha)
  // Two distinct blob contents whose git blob shas were found, by brute-force local sha1 search over
  // "blob <len>\0<content>", to share the 7-hex prefix below — the same real collision fixture
  // ledger.test.ts's --fix-commit ambiguous-prefix test uses, reused here because it is content-derived
  // (the blob sha does not depend on which repo holds it).
  writeFileSync(join(repo, 'collide-a.txt'), 'flow309-collision-fixture-4809\n')
  writeFileSync(join(repo, 'collide-b.txt'), 'flow309-collision-fixture-21065\n')
  gitRun(repo, ['hash-object', '-w', join(repo, 'collide-a.txt')])
  gitRun(repo, ['hash-object', '-w', join(repo, 'collide-b.txt')])
  const ambiguousPrefix = 'c83d131'

  const outcome = computeStance(ticket, ambiguousPrefix, repo)
  assert.equal(outcome.ok, false)
  if (outcome.ok) throw new Error('unreachable')
  assert.equal(outcome.code, 'git-precondition')
  assert.match(outcome.error, new RegExp(`${ambiguousPrefix} is ambiguous: matches 2 objects`))
  assert.doesNotMatch(
    outcome.error,
    /does not resolve to an object/,
    'an ambiguous prefix must not be reported as though it matched nothing'
  )
})
