import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Shell-level tests for hooks/mailbox-watch.sh (FLOW-136 Task 7).
//
// The hook resolves PLUGIN_ROOT relative to its own on-disk location, so it is exercised
// here against a synthetic "plugin root" — a temp dir containing a copy of the real hook
// script plus a stub `bin/mailbox` whose stop-gate output (`allow`, `block\n<reason>`, or a
// nonzero exit) is controlled per test via env vars. This proves the hook's own shell logic
// (loop guards, the two-line gate parse, JSON emission, and the failure fallback) independent
// of the real CLI.
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const realHookPath = join(repoRoot, 'hooks', 'mailbox-watch.sh')

const STUB_MAILBOX = [
  '#!/usr/bin/env bash',
  'echo "$@" >> "$(dirname "$0")/calls.log"',
  'if [[ "$1" == "stop-gate" ]]; then',
  // Crash AFTER printing partial output — reproduces a gate that gets partway through emitting
  // block\n<reason> and then dies (a real crash mid-write, not a clean "nothing printed at all"
  // failure). This is the case a naive `|| printf allow` fails CLOSED on: its output gets
  // APPENDED to, not replaced by, the partial "block\n<reason>" already on stdout.
  '  if [[ "${STUB_FAIL_AFTER_PRINT:-}" == "1" ]]; then',
  '    printf "block\\nreason text"',
  '    exit 3',
  '  fi',
  '  if [[ "${STUB_FAIL:-}" == "1" ]]; then',
  '    exit 1',
  '  fi',
  '  printf "%s" "${STUB_GATE:-allow}"',
  '  exit 0',
  'fi',
  'exit 0',
  '',
].join('\n')

let pluginRoot: string
let hookPath: string

beforeEach(() => {
  pluginRoot = mkdtempSync(join(tmpdir(), 'mailbox-hook-test-'))
  mkdirSync(join(pluginRoot, 'hooks'), { recursive: true })
  mkdirSync(join(pluginRoot, 'bin'), { recursive: true })

  hookPath = join(pluginRoot, 'hooks', 'mailbox-watch.sh')
  writeFileSync(hookPath, readFileSync(realHookPath, 'utf-8'))
  chmodSync(hookPath, 0o755)

  const mailboxStubPath = join(pluginRoot, 'bin', 'mailbox')
  writeFileSync(mailboxStubPath, STUB_MAILBOX)
  chmodSync(mailboxStubPath, 0o755)
})

afterEach(() => {
  try {
    rmSync(pluginRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const runHook = (
  input: unknown,
  env: Record<string, string> = {}
): { stdout: string; status: number | null } => {
  const result = spawnSync('bash', [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
  return { stdout: result.stdout, status: result.status }
}

test('hook: stop_hook_active:true exits 0 silently (loop guard)', () => {
  const { stdout, status } = runHook({ session_id: 'sid-1', stop_hook_active: true })

  assert.equal(status, 0, 'exits 0')
  assert.equal(stdout, '', 'no output — the guard short-circuits before calling stop-gate')
})

test('hook: missing session_id exits 0 silently', () => {
  const { stdout, status } = runHook({ stop_hook_active: false })

  assert.equal(status, 0, 'exits 0')
  assert.equal(stdout, '', 'no output when there is no session id to gate on')
})

test('hook: a stubbed block\\n<reason> gate emits {"decision":"block","reason":"<reason>"}', () => {
  const reason = 'dashboard item 98dd719c is waiting on you'
  const { stdout, status } = runHook(
    { session_id: 'sid-2', stop_hook_active: false },
    { STUB_GATE: `block\n${reason}` }
  )

  assert.equal(status, 0, 'exits 0')
  const parsed = JSON.parse(stdout) as { decision?: string; reason?: string }
  assert.equal(parsed.decision, 'block', 'emits decision:block')
  assert.equal(
    parsed.reason,
    reason,
    'reason is exactly the second line the gate printed — the hook interpolates nothing of its own'
  )
})

test('hook: a stubbed allow gate exits 0 silently (no decision emitted)', () => {
  const { stdout, status } = runHook(
    { session_id: 'sid-3', stop_hook_active: false },
    { STUB_GATE: 'allow' }
  )

  assert.equal(status, 0, 'exits 0')
  assert.equal(stdout, '', 'no output when the gate allows')
})

test('hook: the gate binary failing falls back to allow — exit 0, never non-zero', () => {
  const { stdout, status } = runHook(
    { session_id: 'sid-4', stop_hook_active: false },
    { STUB_FAIL: '1' }
  )

  assert.equal(status, 0, 'exits 0 even though the gate binary itself failed')
  assert.equal(stdout, '', 'falls back to allow — no decision emitted, and never a non-zero exit')
})

// `GATE=$(cmd || printf 'allow')` runs
// printf INSIDE the same command substitution when cmd fails, so printf's output is APPENDED to
// whatever cmd already printed to stdout before crashing — not a clean replacement. A gate that
// gets partway through printing block\n<reason> and then dies would leave
// GATE == "block\nreason text\nallow", and DECISION (the first line) is still "block" — the hook
// fails CLOSED on a crashing gate, the worst direction (a crashing gate would block every idle).
// The fix checks the command's exit status separately and only THEN assigns GATE = 'allow',
// discarding the partial output entirely.
test('hook: a gate that prints partial output then crashes falls back to allow, not a stale block', () => {
  const { stdout, status } = runHook(
    { session_id: 'sid-6', stop_hook_active: false },
    { STUB_FAIL_AFTER_PRINT: '1' }
  )

  assert.equal(status, 0, 'exits 0 even though the gate crashed mid-write')
  assert.equal(
    stdout,
    '',
    "falls back to allow — no decision emitted, not a block built from the crashed gate's partial output"
  )
})

test('hook: calls stop-gate with --session and no --watch-command', () => {
  runHook({ session_id: 'sid-5', stop_hook_active: false }, { STUB_GATE: 'allow' })

  const calls = readFileSync(join(pluginRoot, 'bin', 'calls.log'), 'utf-8')
    .trim()
    .split('\n')
  assert.deepEqual(calls, ['stop-gate --session sid-5'])
})
