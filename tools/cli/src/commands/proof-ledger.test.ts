import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readProofLedger } from '../proof-ledger/ledger.ts'

// Round-24-addendum finding: deleting this file's pre-cut contents (the two `require`-only tests)
// along with `require` itself left proof-ledger with zero coverage of its own CLI entrypoint — the
// layer the require/audit cut actually changed. Every sibling in
// `commands/` (workspace-trust, dashboard, workflow-state, pr-monitor) keeps one for the same reason
// this file's predecessor did: calling `runRecord`/`runShow`/`runCheck` directly bypasses Stricli's
// own flag parsing, so a defect in flag wiring (this file's docblock names one such defect already
// caught this way) is invisible to a handler-level test.

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

let ticket: string
let homeDir: string
let origHome: string | undefined
let repoRoot: string
let headSha: string

beforeEach(() => {
  const uniqueId = `${Date.now()}-${Math.random()}`.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  ticket = `test-proof-ledger-cmd-${uniqueId}`
  homeDir = mkdtempSync(join(tmpdir(), 'proof-ledger-cmd-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir

  // record's CLI path always builds a --repo-root check (never NO_REPO_ROOT_CHECK, which is
  // test-only for the direct API) — a clean scratch repo gives a real HEAD sha a non-red capture
  // can be recorded against, the same shape run.test.ts's makeCleanScratchRepo builds.
  repoRoot = mkdtempSync(join(tmpdir(), 'proof-ledger-cmd-test-repo-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'trunk')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(repoRoot, 'placeholder.txt'), 'placeholder\n')
  git('add', 'placeholder.txt')
  git('commit', '-q', '-m', 'baseline')
  headSha = git('rev-parse', 'HEAD')
})

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  try {
    rmSync(homeDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  try {
    rmSync(repoRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const runCli = (args: string[]): { stdout: string; stderr: string; status: number | null } => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir },
    }
  )
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

test('CLI: proof-ledger record, show and check still route through the real binary after the require/audit cut', () => {
  const recordResult = runCli([
    'proof-ledger',
    'record',
    '--ticket',
    ticket,
    '--task',
    'a-task',
    '--capture',
    'evidence',
    '--sha',
    headSha,
    '--command',
    'echo hi',
    '--exit',
    '0',
    '--output',
    'hi',
    '--repo-root',
    repoRoot,
  ])
  assert.equal(recordResult.status, 0, `record routes and succeeds; stderr: ${recordResult.stderr}`)

  const ledger = readProofLedger(ticket)
  assert.equal(ledger.captures.length, 1, 'the capture was actually recorded, not just accepted')
  assert.equal(ledger.captures[0]?.capture, 'evidence')
  assert.equal(ledger.captures[0]?.sha, headSha)

  const showResult = runCli(['proof-ledger', 'show', '--ticket', ticket])
  assert.equal(showResult.status, 0, `show routes and succeeds; stderr: ${showResult.stderr}`)
  const shown = JSON.parse(showResult.stdout) as { captures: { task: string; capture: string }[] }
  assert.equal(shown.captures.length, 1)
  assert.equal(shown.captures[0]?.task, 'a-task')
  assert.equal(shown.captures[0]?.capture, 'evidence')

  const checkResult = runCli([
    'proof-ledger',
    'check',
    '--ticket',
    ticket,
    '--task',
    'a-task',
    '--sha',
    headSha,
    '--require',
    'evidence',
  ])
  assert.equal(
    checkResult.status,
    0,
    `check routes and reports the recorded evidence as coverage; stderr: ${checkResult.stderr}`
  )
})

// 251 is Stricli's own "no command registered" exit, not something proof-ledger assigns to
// require/audit specifically — asserted here as the shared positive control that pins its meaning:
// a name that was never registered at all (zzbogus) returns the identical exit and stderr shape, so
// a bare `assert.notEqual(status, 0)` on require/audit would also pass for a routed-but-rejecting
// 252 (a genuine subcommand present but unhappy with its arguments), which is the exact state these
// tests exist to rule out.
const UNREGISTERED_COMMAND_EXIT = 251

test('CLI: proof-ledger require no longer routes to anything — Stricli reports it unregistered, not merely unhappy', () => {
  const { status, stderr } = runCli([
    'proof-ledger',
    'require',
    '--ticket',
    ticket,
    '--task',
    'a-task',
  ])
  assert.equal(
    status,
    UNREGISTERED_COMMAND_EXIT,
    `require must report as unregistered, not routed-and-rejecting; stderr: ${stderr}`
  )
  assert.match(stderr, /No command registered for `require`/)
  assert.equal(readProofLedger(ticket).requirements.length, 0, 'nothing was recorded')
})

test('CLI: proof-ledger audit no longer routes to anything — Stricli reports it unregistered, not merely unhappy', () => {
  const { status, stderr } = runCli(['proof-ledger', 'audit', '--ticket', ticket])
  assert.equal(
    status,
    UNREGISTERED_COMMAND_EXIT,
    `audit must report as unregistered, not routed-and-rejecting; stderr: ${stderr}`
  )
  assert.match(stderr, /No command registered for `audit`/)
})

test('CLI: proof-ledger zzbogus — the positive control proving 251 means unregistered, not audit- or require-specific', () => {
  const { status, stderr } = runCli(['proof-ledger', 'zzbogus'])
  assert.equal(status, UNREGISTERED_COMMAND_EXIT)
  assert.match(stderr, /No command registered for `zzbogus`/)
})
