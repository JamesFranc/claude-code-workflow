import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadState, saveState, stateFilePath } from '../dashboard/state.ts'
import { registryFilePath, upsertRegistryNode } from '../dashboard/registry.ts'
import { stderrBeyondNodeWarnings } from '../testing/subprocess-stderr.ts'

// ---------------------------------------------------------------------------
// No commands/*.ts test convention exists in this codebase (commands/ is thin Stricli glue over
// already-tested run* functions) — Stricli's buildCommand returns an opaque Command object, not
// a plain callable. So the CLI-boundary tests below spawn the REAL CLI (main.ts) as a subprocess,
// the same pattern hook.test.ts uses for hooks/mailbox-watch.sh, to prove the actual wiring
// rather than a re-implementation of it.
// ---------------------------------------------------------------------------

let tmpDir: string
let origSessionId: string | undefined
let origBin: string | undefined
let rawId: string
let homeDir: string
let origHome: string | undefined
// FLOW-196's cross-cwd regression test's own temp dirs. Module-scoped (not local to the test body)
// and cleaned up here in afterEach rather than with trailing rmSync calls at the end of the test —
// the RED-baseline run of that test is GUARANTEED to throw on assertion, and a trailing rmSync never
// runs once an earlier assertion has thrown. Reset to undefined each test so afterEach only cleans
// up what this particular test actually created.
let flow196CwdA: string | undefined
let flow196CwdB: string | undefined

/** Registers `id` as its own unkeyed root node — the shape most FLOW-211 CLI-boundary tests below
 * need so `resolveSessionTarget` resolves without throwing. */
const registerRootNode = (id: string): void =>
  upsertRegistryNode(id, {
    internalId: id,
    externalId: id,
    key: null,
    parentId: null,
  })

// State sinks resolve through the durable store, which is homedir()-relative AND
// session-partitioned by process.env.CLAUDE_CODE_SESSION_ID — override HOME so these tests never
// touch the real ~/.claude/workflow-state.
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dashboard-cmd-test-'))
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  origBin = process.env.AI_WORKFLOW_APP_BIN
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  rawId = `test-dashboard-cmd-${uniqueId}`
  process.env.CLAUDE_CODE_SESSION_ID = rawId
  homeDir = mkdtempSync(join(tmpdir(), 'dashboard-cmd-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
  flow196CwdA = undefined
  flow196CwdB = undefined
})

afterEach(() => {
  if (origSessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = origSessionId
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
  if (flow196CwdA !== undefined) {
    try {
      rmSync(flow196CwdA, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  if (flow196CwdB !== undefined) {
    try {
      rmSync(flow196CwdB, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ---------------------------------------------------------------------------
// FLOW-133: `dashboard session repair` / `dashboard session status` CLI wiring.
//
// A typecheck-clean Stricli flag definition (`optional: true` + `variadic: true` on `forget`) can
// break the argv contract — `--forget` becoming mandatory at the CLI — invisibly to
// repair.test.ts because it calls `runRepair(...)` directly and bypasses the Stricli flag layer
// entirely. These tests spawn the REAL CLI (main.ts) so a future flag-definition regression fails
// here instead of shipping unnoticed.
//
// runCli must ALWAYS pin AI_WORKFLOW_APP_BIN — the real ai-workflow-app binary is
// on PATH on a real dev machine (though never in CI), so an unpinned run silently calls the live
// production board on a laptop while calling nothing in CI. That is a test whose meaning depends
// on which machine runs it, which is not a gate. Every call defaults to a nonexistent path (the
// same "unavailable" pin status.test.ts uses); a test that specifically needs the board-available
// branch overrides it with its own stub binary, explicitly, in that one test only.
// ---------------------------------------------------------------------------

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))
const NONEXISTENT_BIN = join(tmpdir(), 'dashboard-flag-test-nonexistent-ai-workflow-app-bin')

const runCli = (
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd?: string
): { stdout: string; stderr: string; status: number | null } => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, ...args],
    {
      encoding: 'utf8',
      ...(cwd !== undefined ? { cwd } : {}),
      env: {
        ...process.env,
        CLAUDE_CODE_SESSION_ID: 'dashboard-flag-test-session',
        AI_WORKFLOW_APP_BIN: NONEXISTENT_BIN,
        ...env,
      },
    }
  )
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

/**
 * A refusal must reach the operator as a message, not as a crash report. Keyed on the STACK FRAME
 * shape (`    at <frame>`), which is what an uncaught throw out of a command func actually adds —
 * not on the wording of the wrapper line above it, which is Stricli's to change. `dashboard link
 * add`'s keyless refusal pins the same property from the other direction, by naming the frames it
 * must not print.
 *
 * The exit code cannot carry this: Stricli's uncaught-throw handler and every deliberate
 * `setRequestedExitCode(1)` refusal both exit 1, so a test asserting only `status === 1` stays green
 * across the whole difference.
 */
const assertCleanRefusal = (stderr: string): void => {
  assert.ok(
    !/^\s+at\s/m.test(stderr),
    `a usable refusal message, not a stack trace — got:\n${stderr}`
  )
}

// Monotonic per-process counter so two stubs written into the same tmpDir never share a filename.
let writeStubCounter = 0

/** Write a stub ai-workflow-app binary that echoes the given stdout payload for any invocation. */
const writeStub = (dir: string, stdout: string): string => {
  const path = join(dir, `ai-workflow-app-${writeStubCounter++}`)
  writeFileSync(path, `#!/usr/bin/env bash\necho ${JSON.stringify(stdout)}\nexit 0\n`)
  chmodSync(path, 0o755)
  return path
}

const readCalls = (dir: string): string[] => {
  const log = join(dir, 'calls.log')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf-8').split('\n').filter(Boolean)
}

/** The raw calls.log content, unsplit — a composed multi-line prompt embeds real newlines, so a
 * call spans several of readCalls' lines; content checks on it need the whole file as one string. */
const readRawCalls = (dir: string): string => {
  const log = join(dir, 'calls.log')
  return existsSync(log) ? readFileSync(log, 'utf-8') : ''
}

/** Write a stub that answers `session list` and every other verb with different stdout. */
const writeBranchingStub = (dir: string, sessionListOut: string, otherOut: string): string => {
  const path = join(dir, `ai-workflow-app-${writeStubCounter++}`)
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

// FLOW-173: --set-active/--clear-active are retired — the registry has no single "active" slot to
// point. --forget is now the only repair operation. These tests replace the pre-FLOW-173
// mutual-exclusion/reachability tests above (which exercised flags that no longer exist).

test('CLI: repair with no --forget at all reaches the nothing-to-do error through the CLI (forget defaults to [] via the Stricli variadic flag, not undefined/crash)', () => {
  const { stderr, status } = runCli(['dashboard', 'session', 'repair', '--dry-run'])

  assert.notEqual(status, 0, 'exits non-zero')
  assert.ok(
    stderr.includes('nothing to do — pass --forget'),
    'the CLI-level forget default of [] reaches runRepair guard, not a crash'
  )
})

test('CLI: repair rejects the removed --set-active flag (proves it is actually gone, not silently ignored)', () => {
  const { stderr, status } = runCli([
    'dashboard',
    'session',
    'repair',
    '--set-active',
    'node-x',
    '--dry-run',
  ])

  assert.notEqual(status, 0, 'exits non-zero — Stricli rejects the unknown flag')
  assert.ok(stderr.includes('--set-active'), 'stderr names the rejected flag')
})

test('CLI: repair rejects the removed --clear-active flag (proves it is actually gone, not silently ignored)', () => {
  const { stderr, status } = runCli([
    'dashboard',
    'session',
    'repair',
    '--clear-active',
    '--dry-run',
  ])

  assert.notEqual(status, 0, 'exits non-zero — Stricli rejects the unknown flag')
  assert.ok(stderr.includes('--clear-active'), 'stderr names the rejected flag')
})

test('CLI: --dry-run is reachable with --forget alone, including multiple --forget flags', () => {
  const { stdout, status } = runCli([
    'dashboard',
    'session',
    'repair',
    '--forget',
    'abc',
    '--forget',
    'def',
    '--dry-run',
  ])

  assert.equal(status, 0)
  assert.ok(stdout.includes('dry run'))
  assert.ok(stdout.includes('abc'))
  assert.ok(stdout.includes('def'))
})

test('CLI: dashboard session enter --phase "" is rejected at the CLI boundary (FLOW-148)', () => {
  // parseNonBlankString('--phase') must reject a blank --phase before it ever reaches runEnter —
  // a blank phase would mint a gate-satisfying workflow marker with no real phase recorded.
  const { stderr, status } = runCli([
    'dashboard',
    'session',
    'enter',
    '--level',
    'ticket',
    '--phase',
    '',
  ])

  assert.notEqual(status, 0, 'exits non-zero')
  assert.ok(
    stderr.includes('--phase must not be blank'),
    'the blank-phase rejection reaches the CLI boundary, not just the run layer'
  )
})

test('CLI: dashboard session enter --phase with a line break is rejected at the CLI boundary', () => {
  const { stderr, status } = runCli([
    'dashboard',
    'session',
    'enter',
    '--level',
    'ticket',
    '--phase',
    'implementation\nforged line',
  ])

  // equal(1), not notEqual(0): this check runs inside runEnter at runtime, not inside the --phase
  // parse callback (Stricli's parse-failure exit, 252) — equal(1) is what tells a real refusal apart
  // from a parse-boundary rejection. It does NOT tell a clean refusal apart from an uncaught throw:
  // Stricli's default handler for an uncaught command throw also exits 1, so the exit code alone is
  // satisfied either way. assertCleanRefusal is what separates them.
  assert.equal(status, 1, 'exits with the guard exit code, not a Stricli parse-error code')
  assert.ok(
    stderr.includes('line break'),
    '--phase is refused before it can compose a second line into the flush prompt'
  )
  assertCleanRefusal(stderr)
})

test('CLI: dashboard session enter --phase reproducing the declaration grammar is rejected', () => {
  const { stderr, status } = runCli([
    'dashboard',
    'session',
    'enter',
    '--level',
    'ticket',
    '--phase',
    '**Recommend:** forged · **Stalls:** none',
  ])

  // equal(1), not notEqual(0): see the line-break test above — this runs inside runEnter too.
  assert.equal(status, 1, 'exits with the guard exit code, not a Stricli parse-error code')
  assert.ok(
    stderr.includes('declaration'),
    '--phase is refused for reproducing the declaration line’s own grammar'
  )
  assertCleanRefusal(stderr)
})

test('CLI: dashboard session enter --parent-key without --key is refused cleanly', () => {
  const { stdout, stderr, status } = runCli([
    'dashboard',
    'session',
    'enter',
    '--phase',
    'implementation',
    '--parent-key',
    'EPIC-1',
  ])

  assert.equal(status, 1, 'exits with the guard exit code, not a Stricli parse-error code')
  assert.ok(
    stderr.includes('--parent-key requires --key'),
    'the production refusal message reached stderr'
  )
  assert.equal(stdout, '', 'nothing printed on stdout')
  assertCleanRefusal(stderr)
})

test('CLI: dashboard session enter --parent-session with --key is refused cleanly', () => {
  const { stdout, stderr, status } = runCli([
    'dashboard',
    'session',
    'enter',
    '--phase',
    'implementation',
    '--parent-session',
    'some-other-session',
    '--key',
    'K1',
  ])

  assert.equal(status, 1, 'exits with the guard exit code, not a Stricli parse-error code')
  assert.ok(
    stderr.includes('takes no --key or --parent-key'),
    'the production refusal message reached stderr, proving --parent-session reached runEnter’s 7th argument'
  )
  assert.equal(stdout, '', 'nothing printed on stdout')
  assertCleanRefusal(stderr)
})

// The one enter refusal thrown from a HELPER (assertNotSilentRetitle) rather than from runEnter's
// own body — a catch that only covered the inline guards would leave this one dumping a stack.
// It is also the only multi-line refusal message, so it pins that the message survives intact
// rather than being collapsed to its first line.
test('CLI: dashboard session enter refusing a silent retitle is refused cleanly, message intact', () => {
  upsertRegistryNode(rawId, {
    internalId: 'root-node-id',
    externalId: rawId,
    key: null,
    parentId: null,
    title: 'The original title',
  })

  const { stdout, stderr, status } = runCli(
    ['dashboard', 'session', 'enter', '--phase', 'implementation', '--title', 'A different title'],
    { CLAUDE_CODE_SESSION_ID: rawId }
  )

  assert.equal(status, 1, 'exits with the guard exit code, not a Stricli parse-error code')
  assert.ok(stderr.includes('refusing to rename'), 'the production refusal message reached stderr')
  assert.ok(
    stderr.includes('The original title') && stderr.includes('A different title'),
    'the multi-line body survives — both titles are shown, not just the first line'
  )
  assert.equal(stdout, '', 'nothing printed on stdout')
  assertCleanRefusal(stderr)
})

test('CLI: dashboard session enter --phase without forbidden grammar is accepted', () => {
  const { stderr, status } = runCli([
    'dashboard',
    'session',
    'enter',
    '--level',
    'ticket',
    '--phase',
    'implementation',
  ])

  assert.equal(status, 0, 'an ordinary phase name is not refused by the new guard')
  assert.ok(
    !stderr.includes('--phase carries a line break') &&
      !stderr.includes('--phase reproduces the declaration'),
    'no --phase refusal text reaches stderr on the accepted path'
  )
})

test('CLI: dashboard session enter --retitle is accepted at the CLI boundary', () => {
  const { stderr, status } = runCli([
    'dashboard',
    'session',
    'enter',
    '--level',
    'ticket',
    '--phase',
    'implementation',
    '--title',
    'Some title',
    '--retitle',
  ])

  assert.equal(status, 0, `expected --retitle to be a recognized flag, got stderr: ${stderr}`)
})

// FLOW-205: the shipped plugin cache still passes --level on every enter. The flag must parse and
// be ignored, not error — this is what stops a cache/CLI version skew from breaking every enter.
test('CLI: dashboard session enter accepts --level as a deprecated no-op, and also works without it', () => {
  const withLevel = runCli([
    'dashboard',
    'session',
    'enter',
    '--level',
    'ticket',
    '--phase',
    'implementation',
  ])
  assert.equal(
    withLevel.status,
    0,
    `expected --level to be accepted, got stderr: ${withLevel.stderr}`
  )

  const withoutLevel = runCli(['dashboard', 'session', 'enter', '--phase', 'implementation'])
  assert.equal(
    withoutLevel.status,
    0,
    `expected --level to be optional, got stderr: ${withoutLevel.stderr}`
  )
})

test('CLI: dashboard session --help lists status and repair alongside enter/leave/heartbeat/end', () => {
  // A plain `stdout.includes(verb)` cannot fail even if a route is deleted —
  // `'Send a heartbeat'.includes('end')` is true, so the `heartbeat` command's own brief text
  // satisfies the `end` assertion on its own. Match the COMMANDS table's own line shape instead:
  // leading whitespace, the verb, then the column gap before its brief.
  const { stdout, status } = runCli(['dashboard', 'session', '--help'])

  assert.equal(status, 0)
  for (const verb of ['enter', 'leave', 'heartbeat', 'end', 'status', 'repair']) {
    assert.ok(
      new RegExp(`^\\s+${verb}\\s{2,}`, 'm').test(stdout),
      `--help lists ${verb} as its own COMMANDS row`
    )
  }
})

test('CLI: dashboard item add --help cites the protocol path in the --approval-kind brief', () => {
  const { stdout, status } = runCli(['dashboard', 'item', 'add', '--help'])
  assert.equal(status, 0, '--help exits zero')
  assert.ok(
    stdout.includes('skills/board/references/dashboard-protocol.md'),
    'the --approval-kind brief cites the protocol path, which no lint covers'
  )
})

test('CLI: dashboard item add --help top brief names --defer and flush-deferred', () => {
  const { stdout, status } = runCli(['dashboard', 'item', 'add', '--help'])
  assert.equal(status, 0, '--help exits zero')
  assert.ok(
    stdout.includes('with --defer, queue a question on this node instead of posting'),
    'the top brief describes --defer, not only the always-posts behaviour'
  )
  assert.ok(
    stdout.includes('flush-deferred'),
    'the top brief names flush-deferred as where a deferred item is later posted'
  )
})

test('CLI: dashboard item add --help --defer brief names the keyless-resolution board exposure', () => {
  const { stdout, status } = runCli(['dashboard', 'item', 'add', '--help'])
  assert.equal(status, 0, '--help exits zero')
  assert.ok(
    stdout.includes("resolving this node's own session target may still call the board"),
    '--defer does not claim total board silence — keyless resolution can still call and refuse'
  )
})

test('CLI: dashboard item --help group brief names the deferred-queue verbs', () => {
  const { stdout } = runCli(['dashboard', 'item', '--help'])
  assert.ok(
    stdout.includes('defer/drop/list/flush deferred questions'),
    'the group brief names the deferred-queue verbs the route group holds, not only post/reconcile'
  )
  assert.ok(
    stdout.includes('read one back by id'),
    'the group brief names the read-back verb too — an agent scanning this brief for recovery ' +
      'finds nothing if only the write verbs are listed'
  )
})

test('CLI: dashboard item show --item reaches runItemShow through the real parser', () => {
  // show.test.ts calls runItemShow directly and so cannot see the route map or the flag
  // definition at all: `show: itemShowCommand` could be missing from itemRoutes and every one of
  // its tests would still pass. This spawns the real CLI so the registration itself is under test.
  const payload = JSON.stringify({
    item: {
      id: 'item-cli-1',
      sessionId: 's',
      type: 'question',
      state: 'consumed',
      prompt: 'the recovered prompt',
    },
  })
  const { stdout, stderr, status } = runCli(['dashboard', 'item', 'show', '--item', 'item-cli-1'], {
    AI_WORKFLOW_APP_BIN: writeStub(tmpDir, payload),
  })

  assert.equal(status, 0, `exits zero — got status ${status}, stderr:\n${stderr}`)
  assert.equal(
    stdout,
    '[dashboard] item item-cli-1 question/consumed\nthe recovered prompt\n',
    'the parser routed to runItemShow and its rendering reached stdout verbatim'
  )
  assert.equal(
    stderrBeyondNodeWarnings(stderr),
    '',
    `a clean success path writes nothing of its own to stderr — got:\n${stderr}`
  )
})

test('CLI: dashboard item show rejects --session, which is not a flag on this route', () => {
  // The no-session property is a claim about the CLI surface, not about runItemShow's signature —
  // a `session: sessionFlag` entry added to itemShowCommand's flags would compile, and would be
  // invisible to every direct-call test. Stricli refuses an unregistered flag at parse time with
  // exit 252, before any handler runs.
  const { stdout, stderr, status } = runCli([
    'dashboard',
    'item',
    'show',
    '--item',
    'item-cli-2',
    '--session',
    'some-session',
  ])

  // 252 and this wording are Stricli's, not ours — an unregistered flag is refused by the parser
  // before any handler runs. A Stricli bump can change the message and redden this test without
  // anything here being wrong; the flag name is the part this story owns.
  assert.equal(status, 252, `parse-time refusal, not a run — got status ${status}`)
  assert.ok(
    stderr.includes('No flag registered for --session'),
    `stderr names the unregistered flag — got:\n${stderr}`
  )
  assert.equal(stdout, '', 'nothing printed on stdout')
  assertCleanRefusal(stderr)
})

// FLOW-425: a teammate's heartbeat reaches its lead's node. The CLI finds the lead by walking up the
// process tree to a teammate process (dashboard/lead.ts), so these run the real CLI under a parent
// whose own command line carries the teammate flags.
const LEAD_SESSION = 'flow425-lead-session'

const runCliAsTeammate = (
  args: string[],
  env: NodeJS.ProcessEnv
): { stdout: string; stderr: string; status: number | null } => {
  const result = spawnSync(
    'bash',
    [
      '-c',
      '"$1" --experimental-transform-types "$2" "${@:3:$#-10}"; exit $?',
      'fake-claude',
      process.execPath,
      mainTsPath,
      ...args,
      '--agent-id',
      'impl@team-x',
      '--agent-name',
      'impl',
      '--team-name',
      'team-x',
      '--parent-session-id',
      LEAD_SESSION,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_SESSION_ID: 'flow425-teammate-session',
        NODE_NO_WARNINGS: '1',
        AI_WORKFLOW_APP_BIN: NONEXISTENT_BIN,
        ...env,
      },
    }
  )
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

test('CLI FLOW-425: a teammate with no node of its own beats its lead’s live leaf', () => {
  upsertRegistryNode(LEAD_SESSION, {
    internalId: 'lead-node-1',
    externalId: `${LEAD_SESSION}_aaaa1111`,
    key: null,
    parentId: null,
  })

  const { status, stdout, stderr } = runCliAsTeammate(['dashboard', 'session', 'heartbeat'], {
    AI_WORKFLOW_APP_BIN: writeBranchingStub(tmpDir, '', ''),
  })

  assert.equal(status, 0)
  assert.equal(stdout, '')
  assert.equal(stderr, '')
  assert.deepEqual(readCalls(tmpDir), ['session heartbeat --id lead-node-1'])
})

test('CLI FLOW-425: a teammate with its own node beats it and its lead’s leaf', () => {
  upsertRegistryNode('flow425-teammate-session', {
    internalId: 'own-node-1',
    externalId: 'flow425-teammate-session_bbbb2222',
    key: null,
    parentId: null,
  })
  upsertRegistryNode(LEAD_SESSION, {
    internalId: 'lead-node-1',
    externalId: `${LEAD_SESSION}_aaaa1111`,
    key: null,
    parentId: null,
  })

  const { status, stdout, stderr } = runCliAsTeammate(['dashboard', 'session', 'heartbeat'], {
    AI_WORKFLOW_APP_BIN: writeBranchingStub(tmpDir, '', ''),
  })

  assert.equal(status, 0)
  assert.equal(stdout, '')
  assert.equal(stderr, '')
  assert.deepEqual(readCalls(tmpDir), [
    'session heartbeat --id own-node-1',
    'session heartbeat --id lead-node-1',
  ])
})

test('CLI FLOW-425: an explicit --session naming the teammate’s own node still beats it', () => {
  upsertRegistryNode('flow425-teammate-session', {
    internalId: 'own-node-1',
    externalId: 'flow425-teammate-session_bbbb2222',
    key: null,
    parentId: null,
  })
  upsertRegistryNode(LEAD_SESSION, {
    internalId: 'lead-node-1',
    externalId: `${LEAD_SESSION}_aaaa1111`,
    key: null,
    parentId: null,
  })

  const { status, stdout, stderr } = runCliAsTeammate(
    ['dashboard', 'session', 'heartbeat', '--session', 'own-node-1'],
    { AI_WORKFLOW_APP_BIN: writeBranchingStub(tmpDir, '', '') }
  )

  assert.equal(status, 0)
  assert.equal(stdout, '')
  assert.equal(stderr, '')
  assert.deepEqual(readCalls(tmpDir), [
    'session heartbeat --id own-node-1',
    'session heartbeat --id lead-node-1',
  ])
})

test('CLI FLOW-425: an unreadable process table is reported and the caller’s own beat still goes', () => {
  registerRootNode(rawId)
  const fakeBin = join(tmpDir, 'fake-bin')
  mkdirSync(fakeBin)
  writeFileSync(join(fakeBin, 'ps'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(fakeBin, 'ps'), 0o755)

  const { status, stdout, stderr } = runCli(['dashboard', 'session', 'heartbeat'], {
    CLAUDE_CODE_SESSION_ID: rawId,
    AI_WORKFLOW_APP_BIN: writeBranchingStub(tmpDir, '', ''),
    NODE_NO_WARNINGS: '1',
    PATH: `${fakeBin}:${process.env.PATH}`,
  })

  assert.deepEqual(readCalls(tmpDir), [`session heartbeat --id ${rawId}`])
  assert.equal(status, 1)
  assert.equal(stdout, '')
  assert.equal(stderr, "could not read the process table to find this session's lead\n")
})

test('CLI FLOW-425: an unreadable lead registry is reported and the teammate’s own beat still goes', () => {
  upsertRegistryNode('flow425-teammate-session', {
    internalId: 'own-node-1',
    externalId: 'flow425-teammate-session_bbbb2222',
    key: null,
    parentId: null,
  })
  mkdirSync(registryFilePath(LEAD_SESSION), { recursive: true })

  const { status, stdout, stderr } = runCliAsTeammate(['dashboard', 'session', 'heartbeat'], {
    AI_WORKFLOW_APP_BIN: writeBranchingStub(tmpDir, '', ''),
  })

  assert.deepEqual(readCalls(tmpDir), ['session heartbeat --id own-node-1'])
  assert.equal(status, 1)
  assert.equal(stdout, '')
  assert.equal(
    stderr,
    `dashboard registry ${registryFilePath(LEAD_SESSION)} exists but could not be read (EISDIR)\n`
  )
})

test('CLI: dashboard session status --json — unavailable branch, deterministic (nonexistent bin)', () => {
  // The default runCli() pin (AI_WORKFLOW_APP_BIN -> a nonexistent path) already gives this
  // branch; passed explicitly here anyway so this test's intent does not depend on runCli's
  // default staying what it is today.
  const { stdout, status } = runCli(['dashboard', 'session', 'status', '--json'], {
    AI_WORKFLOW_APP_BIN: NONEXISTENT_BIN,
  })

  assert.equal(status, 0)
  const report = JSON.parse(stdout) as Record<string, unknown>
  assert.deepEqual(
    Object.keys(report).sort(),
    [
      'boardNodes',
      'corruptLocalNodes',
      'dashboardAvailable',
      'localActiveSessionId',
      'localLeafIds',
      'localNodes',
      'rawSessionId',
    ].sort(),
    'the json boolean flag actually reaches runStatus and controls its output shape'
  )
  assert.equal(report.dashboardAvailable, false, 'no binary on this pinned path — unavailable')
  assert.deepEqual(report.boardNodes, [], 'no board nodes when unavailable')
})

test('CLI: dashboard session status --json — available branch, deterministic (stub binary, no network)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-status-cli-test-'))
  try {
    const sessionListPayload = JSON.stringify([
      {
        session: {
          id: 'stub-node-1',
          systemId: 'claude-workflow',
          externalId: 'dashboard-flag-test-session',
          title: 'stub',
          phase: 'implementation',
          lifecycle: 'active',
          parentId: null,
        },
        status: 'ok',
        openItemCount: 0,
      },
    ])
    const stubBin = writeStub(dir, sessionListPayload)

    const { stdout, status } = runCli(['dashboard', 'session', 'status', '--json'], {
      AI_WORKFLOW_APP_BIN: stubBin,
    })

    assert.equal(status, 0)
    const report = JSON.parse(stdout) as {
      dashboardAvailable: boolean
      boardNodes: Array<{ id: string }>
    }
    assert.equal(report.dashboardAvailable, true, 'the stub binary is present and succeeds')
    assert.deepEqual(
      report.boardNodes.map((n) => n.id),
      ['stub-node-1'],
      'the board node from the stub payload is reported — never touches the network'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// FLOW-196: the per-node state file must be session-global, not per-cwd — a session that changes
// directory (add from one cwd, consume from another) must reconcile against the SAME ledger.
// `resolveDirKey` is pinned once per process (workflow-store/store.ts), so this cannot be
// exercised in-process; it requires two real subprocess invocations in two different working
// directories.
//
// Both runCli calls below pin CLAUDE_CODE_SESSION_ID to this test's own `rawId` explicitly — the
// harness's default env pin (`'dashboard-flag-test-session'`) is placed AFTER `...process.env` in
// the spread inside runCli, so it always wins unless overridden here. Without this override the
// subprocess would resolve against a different (empty) registry than the one `upsertRegistryNode`
// below writes to, and would fail for an unrelated reason (no active board session) rather than
// exercising the cwd-scoping bug this test exists to catch.
// ---------------------------------------------------------------------------

test('FLOW-196: item add in one cwd and consume --all in another reconcile the same ledger', () => {
  flow196CwdA = mkdtempSync(join(tmpdir(), 'dashboard-cwd-a-'))
  flow196CwdB = mkdtempSync(join(tmpdir(), 'dashboard-cwd-b-'))
  const addStub = writeStub(tmpDir, '{"itemId":"item-x-1"}')
  const consumeStub = writeStub(tmpDir, '{"consumed":1,"ids":["item-x-1"]}')
  registerRootNode(rawId)

  runCli(
    [
      'dashboard',
      'item',
      'add',
      '--type',
      'question',
      '--prompt',
      'q',
      '--recommend',
      'Ship it',
      '--stalls',
      'none',
      '--why-mine',
      'scope',
    ],
    { AI_WORKFLOW_APP_BIN: addStub, CLAUDE_CODE_SESSION_ID: rawId },
    flow196CwdA
  )
  assert.deepEqual(loadState(rawId)!.openItemIds, ['item-x-1'], 'recorded from cwdA')

  runCli(
    ['dashboard', 'item', 'consume', '--all'],
    { AI_WORKFLOW_APP_BIN: consumeStub, CLAUDE_CODE_SESSION_ID: rawId },
    flow196CwdB
  )

  assert.deepEqual(
    loadState(rawId)!.openItemIds,
    [],
    'consume from a DIFFERENT cwd cleared the ledger the add wrote'
  )
})

// ---------------------------------------------------------------------------
// FLOW-211: `--approval-kind` wiring through the real CLI boundary — a flag never exercised
// through the actual binary is a flag whose wiring is unverified.
// ---------------------------------------------------------------------------

const openQuestionBoardRow = (id: string): string =>
  JSON.stringify([
    {
      session: {
        id,
        systemId: 'claude-workflow',
        externalId: id,
        title: 't',
        phase: 'pr',
        lifecycle: 'active',
        parentId: null,
      },
      openItemCount: 1,
      openItemCounts: { question: 1, approval: 0, comment: 0 },
    },
  ])

test('CLI: item add --type approval --approval-kind hold posts despite an open question', () => {
  registerRootNode(rawId)
  const stubBin = writeBranchingStub(
    tmpDir,
    openQuestionBoardRow(rawId),
    '{"itemId":"item-allowed"}'
  )

  const { stdout, stderr, status } = runCli(
    ['dashboard', 'item', 'add', '--type', 'approval', '--prompt', 'p', '--approval-kind', 'hold'],
    { AI_WORKFLOW_APP_BIN: stubBin, CLAUDE_CODE_SESSION_ID: rawId }
  )

  assert.equal(status, 0, 'exits 0 with the override')
  assert.ok(stdout.includes('item-allowed'), 'the item was actually posted')
  // Not equal(''): the subprocess's stderr always carries Node's own ExperimentalWarning noise —
  // check for the absence of the refusal message specifically, not an empty channel.
  assert.ok(
    !stderr.includes('refusing to post an approval'),
    'no refusal on stderr — the override is not an error'
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add reached the stub'
  )
})

const infoPostStdout = (itemId: string, nodeId: string): string =>
  JSON.stringify({
    itemId,
    note:
      'Nothing answers a note. If this asks the user to approve, merge, flip, proceed or validate ' +
      `anything, withdraw it (dashboard item withdraw --item ${itemId} --session ${nodeId}) and ` +
      'post it with --type approval.',
  }) + '\n'

test('CLI: item add --type info posts the note and leaves openItemIds untouched', () => {
  registerRootNode(rawId)
  saveState(rawId, { registered: true, phase: 'implementation', openItemIds: ['q-1'] })
  const stubBin = writeBranchingStub(tmpDir, '[]', '{"itemId":"note-cli-1"}')

  const { stdout, stderr, status } = runCli(
    ['dashboard', 'item', 'add', '--type', 'info', '--prompt', 'A note\n\nWith detail.'],
    { AI_WORKFLOW_APP_BIN: stubBin, CLAUDE_CODE_SESSION_ID: rawId }
  )

  assert.equal(status, 0, 'exits exactly 0')
  assert.equal(stdout, infoPostStdout('note-cli-1', rawId), 'prints the itemId and the reminder')
  assert.equal(stderrBeyondNodeWarnings(stderr), '', 'nothing on stderr beyond Node warnings')
  assert.ok(
    readRawCalls(tmpDir).includes('--type info --prompt A note\n\nWith detail.'),
    'the stub received --type info with the prompt'
  )
  assert.deepEqual(loadState(rawId)!.openItemIds, ['q-1'], 'the note id is not recorded')
})

test('CLI: item add passes repeated --answers/--replaces/--related through to the app', () => {
  registerRootNode(rawId)
  const stubBin = writeBranchingStub(tmpDir, '[]', '{"itemId":"note-ref-1"}')

  const { stdout, status } = runCli(
    [
      'dashboard',
      'item',
      'add',
      '--type',
      'info',
      '--prompt',
      'Done',
      '--related',
      'r1',
      '--related',
      'r2',
      '--answers',
      'c1',
      '--replaces',
      'w1',
    ],
    { AI_WORKFLOW_APP_BIN: stubBin, CLAUDE_CODE_SESSION_ID: rawId }
  )

  assert.equal(status, 0, 'exits exactly 0')
  assert.equal(stdout, infoPostStdout('note-ref-1', rawId), 'prints the itemId and the reminder')
  assert.ok(
    readRawCalls(tmpDir).includes(
      '--type info --answers c1 --replaces w1 --related r1 --related r2 --prompt Done'
    ),
    'every reference, repeats included, reached the app'
  )
})

test('CLI: item add refuses a blank --related at the CLI boundary', () => {
  registerRootNode(rawId)
  const stubBin = writeBranchingStub(tmpDir, '[]', '{"itemId":"never"}')

  const { stderr, status } = runCli(
    ['dashboard', 'item', 'add', '--type', 'info', '--prompt', 'Done', '--related', ' '],
    { AI_WORKFLOW_APP_BIN: stubBin, CLAUDE_CODE_SESSION_ID: rawId }
  )

  assert.notEqual(status, 0, 'a blank reference id is refused')
  assert.match(stderr, /--related must not be blank/)
  assert.equal(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    false,
    'nothing was posted'
  )
})

// --approval-kind's other enum values need their own coverage through the real binary too — a
// mutation that dropped `&& s !== 'credential'` from the enum's parse function (dashboard.ts) would
// leave the suite green without this test.
test('CLI: item add --type approval --approval-kind credential posts despite an open question', () => {
  registerRootNode(rawId)
  const stubBin = writeBranchingStub(
    tmpDir,
    openQuestionBoardRow(rawId),
    '{"itemId":"item-credential-allowed"}'
  )

  const { stdout, stderr, status } = runCli(
    [
      'dashboard',
      'item',
      'add',
      '--type',
      'approval',
      '--prompt',
      'p',
      '--approval-kind',
      'credential',
    ],
    { AI_WORKFLOW_APP_BIN: stubBin, CLAUDE_CODE_SESSION_ID: rawId }
  )

  assert.equal(status, 0, 'exits 0 with the override')
  assert.ok(stdout.includes('item-credential-allowed'), 'the item was actually posted')
  // Not equal(''): the subprocess's stderr always carries Node's own ExperimentalWarning noise —
  // check for the absence of the refusal message specifically, not an empty channel.
  assert.ok(
    !stderr.includes('refusing to post an approval'),
    'no refusal on stderr — the override is not an error'
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add reached the stub'
  )
})

// The third enum value needs the same coverage: a mutation that dropped `&& s !== 'checkpoint'`
// from the enum's parse function (dashboard.ts), or that left `approvalIsAllowed`
// short-circuiting on hold and credential only, would leave the suite green without this test.
test('CLI: item add --type approval --approval-kind checkpoint posts despite an open question', () => {
  registerRootNode(rawId)
  const stubBin = writeBranchingStub(
    tmpDir,
    openQuestionBoardRow(rawId),
    '{"itemId":"item-checkpoint-allowed"}'
  )

  const { stdout, stderr, status } = runCli(
    [
      'dashboard',
      'item',
      'add',
      '--type',
      'approval',
      '--prompt',
      'p',
      '--approval-kind',
      'checkpoint',
    ],
    { AI_WORKFLOW_APP_BIN: stubBin, CLAUDE_CODE_SESSION_ID: rawId }
  )

  assert.equal(status, 0, 'exits 0 with the override')
  assert.ok(stdout.includes('item-checkpoint-allowed'), 'the item was actually posted')
  // Not equal(''): the subprocess's stderr always carries Node's own ExperimentalWarning noise —
  // check for the absence of the refusal message specifically, not an empty channel.
  assert.ok(
    !stderr.includes('refusing to post an approval'),
    'no refusal on stderr — the override is not an error'
  )
  assert.ok(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    'item add reached the stub'
  )
})

test('CLI: item add --type approval rejects an --approval-kind value outside the enum', () => {
  const { stderr, status } = runCli([
    'dashboard',
    'item',
    'add',
    '--type',
    'approval',
    '--prompt',
    'p',
    '--approval-kind',
    'bogus',
  ])

  // 252, not just notEqual(0): this IS the Stricli-level flag-parse rejection (unlike the guard's
  // own setRequestedExitCode(1) refusals above) — measured directly against the real CLI.
  assert.equal(status, 252, "exits with Stricli's flag-parse error code")
  assert.ok(stderr.includes('--approval-kind'), 'stderr names the rejected flag')
  assert.ok(
    stderr.includes('must be hold, credential or checkpoint'),
    'stderr states the enum itself, not just that some rejection happened — S-12: this is what ' +
      'distinguishes "enum rejected bogus" from "the flag does not exist at all"'
  )
})

// The handler-level rejection (item.test.ts) proves runItemAdd itself refuses the mismatch,
// but a tidy-up at the CLI boundary — e.g. `approvalKind: flags.type === 'approval' ?
// flags['approval-kind'] : undefined` in dashboard.ts's itemAddCommand — would silently restore the
// no-op by dropping the flag before it ever reaches runItemAdd. A real stub (not a nonexistent bin)
// pins that this reaches the board layer, not just "the process exited non-zero for some reason".
test('CLI: item add --type question --approval-kind hold is rejected at the CLI boundary', () => {
  // writeBranchingStub, not writeStub — only the former logs to calls.log, and the assertion below
  // that item add never reached it would be vacuous (always true, log always empty) against a stub
  // that never records anything at all.
  const stubBin = writeBranchingStub(tmpDir, '[]', '{"itemId":"item-should-not-post"}')
  // The mismatch check (runItemAdd's `type === 'question' && approvalKind !== undefined`) runs
  // before resolveSessionTarget in the normal path, so a registry node isn't needed for THIS test
  // to pass today. It's needed for the mutation that deletes the mismatch check: without a
  // registered node, the deleted-guard path would fall through to resolveSessionTarget and throw
  // for want of one — incidentally making this file's "item add never called" pass for the wrong
  // reason (an unrelated crash, not the guard). Registering one lets a guard-removed run reach
  // item add cleanly, so that assertion is a real kill.
  registerRootNode(rawId)

  const { stdout, stderr, status } = runCli(
    ['dashboard', 'item', 'add', '--type', 'question', '--prompt', 'p', '--approval-kind', 'hold'],
    { AI_WORKFLOW_APP_BIN: stubBin, CLAUDE_CODE_SESSION_ID: rawId }
  )

  // status 1, not notEqual(status, 0): this is item.ts's own setRequestedExitCode(1) refusal, not a
  // Stricli-level flag-parse rejection (which exits 252) — equal(1) is what tells the two apart.
  assert.equal(status, 1, 'exits with the guard exit code, not a Stricli parse-error code')
  // The literal production string, not a substring `--approval-kind` also present in Stricli's own
  // "No flag registered for --approval-kind" — that generic error would satisfy an `includes`
  // check on the flag name alone without the guard ever having run.
  assert.ok(
    stderr.includes('only applies to --type approval'),
    'the production refusal message reached stderr, not merely something mentioning the flag name'
  )
  assert.equal(stdout, '', 'no itemId printed')
  assert.equal(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    false,
    'item add never reached the stub'
  )
})

test('CLI: item add --type approval without --approval-kind refuses when a question is open', () => {
  registerRootNode(rawId)
  const stubBin = writeBranchingStub(
    tmpDir,
    openQuestionBoardRow(rawId),
    '{"itemId":"item-should-not-post"}'
  )

  const { stdout, stderr, status } = runCli(
    ['dashboard', 'item', 'add', '--type', 'approval', '--prompt', 'p'],
    { AI_WORKFLOW_APP_BIN: stubBin, CLAUDE_CODE_SESSION_ID: rawId }
  )

  // equal(1), not notEqual(0): this is the guard's own setRequestedExitCode(1) refusal, not a
  // Stricli parse-error exit (252) — equal(1) is what tells a real refusal apart from a crash.
  assert.equal(status, 1, 'exits with the guard exit code, not a Stricli parse-error code')
  assert.ok(stderr.includes('refusing to post an approval'), 'refusal reaches the CLI boundary')
  assert.equal(stdout, '', 'nothing printed on stdout — no itemId to report')
  assert.equal(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    false,
    'item add was never called'
  )
})

// ---------------------------------------------------------------------------
// FLOW-249: `--why-mine` wiring through the real CLI boundary.
// ---------------------------------------------------------------------------

test('CLI: item add --why-mine bogus is rejected at the parse boundary, naming the five values', () => {
  const { stdout, stderr, status } = runCli([
    'dashboard',
    'item',
    'add',
    '--type',
    'question',
    '--prompt',
    'p',
    '--recommend',
    'x',
    '--stalls',
    'none',
    '--why-mine',
    'bogus',
  ])

  // 252, not just notEqual(0): this IS the Stricli-level flag-parse rejection, the same signal the
  // --approval-kind enum test above pins.
  assert.equal(status, 252, "exits with Stricli's flag-parse error code")
  assert.ok(stderr.includes('--why-mine'), 'stderr names the rejected flag')
  assert.ok(
    stderr.includes('taste, scope, risk, teammate-unsettled or fact'),
    'stderr states all five values, not just that some rejection happened'
  )
  assert.equal(stdout, '', 'nothing printed on stdout — a rejected parse posts nothing')
})

// --recommend/--stalls share parseNonBlankString with --phase and --ticket (parse.ts) — a blank
// value is rejected at the CLI parse boundary itself, not left to reach composeQuestionPrompt's
// own missing-flag check in item.ts.
test('CLI: item add --recommend consisting only of whitespace is rejected at the parse boundary', () => {
  const { stdout, stderr, status } = runCli([
    'dashboard',
    'item',
    'add',
    '--type',
    'question',
    '--prompt',
    'p',
    '--recommend',
    '   ',
    '--stalls',
    'none',
    '--why-mine',
    'scope',
  ])

  assert.equal(status, 252, "exits with Stricli's flag-parse error code")
  assert.ok(stderr.includes('--recommend'), 'stderr names the rejected flag')
  assert.ok(stderr.includes('must not be blank'), 'stderr states why')
  assert.equal(stdout, '', 'nothing printed on stdout — a rejected parse posts nothing')
})

test('CLI: item add --stalls consisting only of whitespace is rejected at the parse boundary', () => {
  const { stdout, stderr, status } = runCli([
    'dashboard',
    'item',
    'add',
    '--type',
    'question',
    '--prompt',
    'p',
    '--recommend',
    'rec',
    '--stalls',
    '   ',
    '--why-mine',
    'scope',
  ])

  assert.equal(status, 252, "exits with Stricli's flag-parse error code")
  assert.ok(stderr.includes('--stalls'), 'stderr names the rejected flag')
  assert.ok(stderr.includes('must not be blank'), 'stderr states why')
  assert.equal(stdout, '', 'nothing printed on stdout — a rejected parse posts nothing')
})

// The parse function's accept-list is one chained condition (dashboard.ts), not five independent
// checks — dropping any one of the five `s !== '<value>' &&` clauses leaves the other four
// enforced and that value alone rejected. Each value gets its own real-binary pin below, the same
// way --approval-kind's hold and credential are each pinned separately above: a test for one value
// cannot go red for another value's clause being dropped.
//
// writeBranchingStub + readCalls, not writeStub: a stub written with writeStub echoes a fixed
// payload and never logs argv, so it cannot prove --recommend/--stalls/--why-mine actually reached
// the composed --prompt the real binary receives — a handler-wiring regression (e.g. swapping
// flags.recommend and flags.stalls, or dropping flags['why-mine'] in favor of a constant) would
// still exit 0 and print the stubbed itemId. Asserting the literal composed declaration line closes
// that gap.
for (const whyMine of ['taste', 'scope', 'risk', 'teammate-unsettled', 'fact'] as const) {
  test(`CLI: item add --why-mine ${whyMine} parses`, () => {
    registerRootNode(rawId)
    const stubBin = writeBranchingStub(tmpDir, '[]', `{"itemId":"item-${whyMine}"}`)

    const { stdout, stderr, status } = runCli(
      [
        'dashboard',
        'item',
        'add',
        '--type',
        'question',
        '--prompt',
        'p',
        '--recommend',
        'x',
        '--stalls',
        'none',
        '--why-mine',
        whyMine,
      ],
      { AI_WORKFLOW_APP_BIN: stubBin, CLAUDE_CODE_SESSION_ID: rawId }
    )

    assert.equal(status, 0, `exits 0 — ${whyMine} is a valid --why-mine value`)
    assert.ok(stdout.includes(`item-${whyMine}`), 'the item was actually posted')
    // Not equal(''): the subprocess's stderr always carries Node's own ExperimentalWarning noise —
    // check for the absence of a refusal specifically, not an empty channel.
    assert.ok(
      !stderr.includes('dashboard:'),
      'no refusal on stderr — a successful post is not an error'
    )
    assert.ok(
      readCalls(tmpDir).some(
        (c) => c === `> **Recommend:** x · **Stalls:** none · **Yours because:** ${whyMine}`
      ),
      'the composed --prompt argv literally carries --recommend, --stalls and this --why-mine value'
    )
  })
}

// Dedicated pin for --recommend and --stalls independently of --why-mine's loop above: distinct
// values in each field ('ship it' vs 'the merge') so a handler regression that swaps
// flags.recommend and flags.stalls produces a composed line that cannot match this assertion by
// coincidence.
test('CLI: item add composes --recommend and --stalls into the declaration line, not swapped', () => {
  registerRootNode(rawId)
  const stubBin = writeBranchingStub(tmpDir, '[]', '{"itemId":"item-rs"}')

  const { status } = runCli(
    [
      'dashboard',
      'item',
      'add',
      '--type',
      'question',
      '--prompt',
      'p',
      '--recommend',
      'ship it',
      '--stalls',
      'the merge',
      '--why-mine',
      'scope',
    ],
    { AI_WORKFLOW_APP_BIN: stubBin, CLAUDE_CODE_SESSION_ID: rawId }
  )

  assert.equal(status, 0, 'exits 0')
  assert.ok(
    readCalls(tmpDir).some(
      (c) => c === '> **Recommend:** ship it · **Stalls:** the merge · **Yours because:** scope'
    ),
    '--recommend and --stalls each land in their own field, not swapped'
  )
})

test('CLI: item add with no board resolving hands the question back with exit 3, with and without --defer', () => {
  const baseArgs = [
    'dashboard',
    'item',
    'add',
    '--type',
    'question',
    '--prompt',
    'Which approach?',
    '--recommend',
    'Use A',
    '--stalls',
    'none',
    '--why-mine',
    'taste',
  ]
  const expectedStdout =
    'Which approach?\n\n> **Recommend:** Use A · **Stalls:** none · **Yours because:** taste\n\n' +
    'No board is available. Ask the user this in the terminal and wait for the reply.\n'

  for (const extra of [[], ['--defer']]) {
    const { stdout, stderr, status } = runCli([...baseArgs, ...extra], {
      AI_WORKFLOW_APP_BIN: NONEXISTENT_BIN,
    })
    assert.equal(status, 3, `exit 3 with args ${extra.join(' ')}`)
    assert.equal(stdout, expectedStdout)
    assert.equal(stderrBeyondNodeWarnings(stderr), '')
  }
})

// ---------------------------------------------------------------------------
// FLOW-249: `--defer` wiring through the real CLI boundary. `runItemAdd`'s `type === 'approval' &&
// defer` guard refuses `--defer` on anything but --type question, so a `--type approval --defer`
// invocation is refused if and only if
// `defer` actually reached runItemAdd — a CLI-layer regression that drops the flag before it gets
// there (e.g. a tidy-up that forgets to pass it through) would let this same invocation post
// instead, exactly the class writeBranchingStub + readCalls exists to catch elsewhere in this file.
test('CLI: item add --type approval --defer is rejected at the CLI boundary', () => {
  const stubBin = writeBranchingStub(tmpDir, '[]', '{"itemId":"item-should-not-post"}')
  registerRootNode(rawId)

  const { stdout, stderr, status } = runCli(
    ['dashboard', 'item', 'add', '--type', 'approval', '--prompt', 'p', '--defer'],
    { AI_WORKFLOW_APP_BIN: stubBin, CLAUDE_CODE_SESSION_ID: rawId }
  )

  assert.equal(status, 1, 'exits with the guard exit code, not a Stricli parse-error code')
  assert.ok(
    stderr.includes('--defer only applies to --type question'),
    'the production refusal message reached stderr, not merely something mentioning the flag name'
  )
  assert.equal(stdout, '', 'no itemId printed')
  assert.equal(
    readCalls(tmpDir).some((c) => c.includes('item add')),
    false,
    'item add never reached the stub'
  )
})

// ---------------------------------------------------------------------------
// FLOW-250: `drop-deferred` wiring through the real CLI boundary. `runItemDropDeferred` refuses a
// missing --id/--reason itself (exit 1) rather than letting Stricli's own missing-flag path exit
// 252 — that only holds if both flags are declared `optional: true` at the Stricli layer. This
// spawns the real main.ts (the file-level unit test cannot see the Stricli flag layer at all), so a
// future edit that flips `reason` back to mandatory fails here instead of shipping unnoticed.
// ---------------------------------------------------------------------------

test('CLI: item drop-deferred exits 1 without --reason', () => {
  registerRootNode(rawId)

  const { stderr, status } = runCli(['dashboard', 'item', 'drop-deferred', '--id', 'q1'], {
    CLAUDE_CODE_SESSION_ID: rawId,
  })

  assert.equal(status, 1, "the production refusal exit code, not Stricli's own 252")
  assert.ok(
    stderr.includes('a drop with no reason is a question removed for no stated cause'),
    'the production refusal message reached stderr'
  )
  assert.ok(
    stderr.includes('missing --reason'),
    'stderr names --reason specifically, not just --id — a wiring swap that fed --id into the ' +
      'reason parameter would still print "missing --reason" here for the wrong cause, but would ' +
      'print "missing --id" instead if --id itself failed to reach the handler'
  )
})

// The positive path. drop-deferred's wiring is positional (itemDropDeferredCommand.func calls
// runItemDropDeferred(flags.id, flags.reason, …)) — a full swap of that call is already caught by
// the test above: with only --id supplied, a swap leaves `id` undefined and `reason` holding the id
// string, so the missing-flags message reads "missing --id" instead of the "missing --reason" that
// test asserts, and it fails. What the test above CANNOT see is a swap once both flags carry real
// values: nothing errors, the call just attaches the --reason string where --id belongs and vice
// versa. This defers a real question, drops it with both flags through the real CLI boundary, and
// confirms the SPECIFIC id was dropped for the SPECIFIC reason by reading both back through
// list-deferred — that silent-swap case would drop the wrong id (or fail to find one at all) and
// attach the wrong string as the reason.
test('CLI: item drop-deferred with --id and --reason drops the entry, readable back through list-deferred', () => {
  registerRootNode(rawId)
  const addResult = runCli(
    [
      'dashboard',
      'item',
      'add',
      '--type',
      'question',
      '--prompt',
      'Should the retry live in the client or the caller?',
      '--recommend',
      'Ship it',
      '--stalls',
      'none',
      '--why-mine',
      'scope',
      '--defer',
    ],
    { AI_WORKFLOW_APP_BIN: writeStub(tmpDir, '{}'), CLAUDE_CODE_SESSION_ID: rawId }
  )
  assert.equal(addResult.status, 0, 'the defer post succeeds')
  const deferredId = (JSON.parse(addResult.stdout) as { deferredId: string }).deferredId

  const dropResult = runCli(
    ['dashboard', 'item', 'drop-deferred', '--id', deferredId, '--reason', 'Fixed in this diff'],
    { CLAUDE_CODE_SESSION_ID: rawId }
  )

  assert.equal(dropResult.status, 0, 'the drop succeeds')
  assert.ok(!dropResult.stderr.includes('Error'), 'no error on stderr')
  assert.equal(
    (JSON.parse(dropResult.stdout) as { dropped: string }).dropped,
    deferredId,
    'stdout reports the id that was actually dropped, through the real CLI boundary'
  )

  const { stdout, status } = runCli(['dashboard', 'item', 'list-deferred'], {
    CLAUDE_CODE_SESSION_ID: rawId,
  })
  assert.equal(status, 0)
  assert.deepEqual(JSON.parse(stdout) as unknown[], [], 'the entry is gone — dropping is deleting')
})

// FLOW-250: list-deferred and flush-deferred, plus --context, had no
// coverage crossing the real Stricli parsing layer — only drop-deferred did (above). Either verb
// could be misregistered, or --context could fail to reach runItemFlushDeferred, with nothing
// failing: item.test.ts calls the run* functions directly and cannot see Stricli at all.

test('CLI: item list-deferred prints a queued entry through the real CLI boundary', () => {
  registerRootNode(rawId)
  const addResult = runCli(
    [
      'dashboard',
      'item',
      'add',
      '--type',
      'question',
      '--prompt',
      'Should the retry live in the client or the caller?',
      '--recommend',
      'Ship it',
      '--stalls',
      'none',
      '--why-mine',
      'scope',
      '--defer',
    ],
    { AI_WORKFLOW_APP_BIN: writeStub(tmpDir, '{}'), CLAUDE_CODE_SESSION_ID: rawId }
  )
  assert.equal(addResult.status, 0, 'the defer post succeeds')

  const { stdout, stderr, status } = runCli(['dashboard', 'item', 'list-deferred'], {
    CLAUDE_CODE_SESSION_ID: rawId,
  })

  assert.equal(status, 0)
  assert.ok(!stderr.includes('Error'), 'no error on stderr')
  const parsed = JSON.parse(stdout) as { id: string; lede: string }[]
  assert.equal(
    parsed.length,
    1,
    'the queued entry reached list-deferred through the real CLI boundary'
  )
  assert.equal(parsed[0]?.lede, 'Should the retry live in the client or the caller?')
})

test('CLI: item flush-deferred with --context reaches the composed prompt through the real CLI boundary', () => {
  registerRootNode(rawId)
  runCli(
    [
      'dashboard',
      'item',
      'add',
      '--type',
      'question',
      '--prompt',
      'Should the retry live in the client or the caller?',
      '--recommend',
      'Ship it',
      '--stalls',
      'none',
      '--why-mine',
      'scope',
      '--defer',
    ],
    { AI_WORKFLOW_APP_BIN: writeStub(tmpDir, '{}'), CLAUDE_CODE_SESSION_ID: rawId }
  )
  const stubBin = writeBranchingStub(
    tmpDir,
    JSON.stringify([
      {
        session: {
          id: rawId,
          systemId: 'claude-workflow',
          externalId: rawId,
          title: 't',
          phase: 'pr',
          lifecycle: 'active',
          parentId: null,
        },
        openItemCount: 0,
        openItemCounts: { question: 0, approval: 0, comment: 0 },
      },
    ]),
    '{"itemId":"item-flush-cli"}'
  )

  const { stdout, stderr, status } = runCli(
    ['dashboard', 'item', 'flush-deferred', '--context', 'https://github.com/example/pr/1'],
    { AI_WORKFLOW_APP_BIN: stubBin, CLAUDE_CODE_SESSION_ID: rawId }
  )

  assert.equal(status, 0)
  assert.ok(!stderr.includes('Error'), 'no error on stderr')
  assert.deepEqual(
    JSON.parse(stdout) as { itemIds?: string[]; flushed?: number },
    { itemIds: ['item-flush-cli'], flushed: 1 },
    '--context reached runItemFlushDeferred and the flush posted, through the real CLI boundary'
  )
  const rawCalls = readRawCalls(tmpDir)
  assert.ok(
    rawCalls.includes(
      '\n\nhttps://github.com/example/pr/1\n\n' +
        '> **Recommend:** Ship it · **Stalls:** none · **Yours because:** scope'
    ),
    'the flush posted a question item with --context composed as evidence ahead of the declaration ' +
      'line, through the stub'
  )
})

// ---------------------------------------------------------------------------
// FLOW-250: --key on all three deferred-queue verbs, and --session on list-deferred, never
// crossed the real Stricli flag layer — item.test.ts's own --key/--session tests call the run*
// functions directly and cannot see the flag definitions themselves. OBSERVED by mutation: deleting
// `key: flags.key` from all three commands' func() bodies (and `session: flags.session` from
// list-deferred's) left dashboard.test.ts fully green. Each test below registers a decoy sibling
// leaf alongside the targeted node specifically so a deleted flag falls through to keyless
// resolution and either targets the WRONG node or throws on leaf ambiguity — not, by coincidence,
// the same node the test meant to target.
// ---------------------------------------------------------------------------

test('CLI: item drop-deferred --key crosses the real Stricli flag layer to the named sibling node', () => {
  upsertRegistryNode(rawId, {
    internalId: 'node-k1',
    externalId: `${rawId}:K1`,
    key: 'K1',
    parentId: null,
  })
  upsertRegistryNode(rawId, {
    internalId: 'node-k2',
    externalId: `${rawId}:K2`,
    key: 'K2',
    parentId: null,
  })
  const deferOn = (key: string): string => {
    const result = runCli(
      [
        'dashboard',
        'item',
        'add',
        '--type',
        'question',
        '--prompt',
        `${key}’s own question?`,
        '--recommend',
        'Ship it',
        '--stalls',
        'none',
        '--why-mine',
        'scope',
        '--defer',
        '--key',
        key,
      ],
      { AI_WORKFLOW_APP_BIN: writeStub(tmpDir, '{}'), CLAUDE_CODE_SESSION_ID: rawId }
    )
    assert.equal(result.status, 0, `the ${key} defer post succeeds`)
    return (JSON.parse(result.stdout) as { deferredId: string }).deferredId
  }
  const k1Id = deferOn('K1')
  deferOn('K2')

  const dropResult = runCli(
    [
      'dashboard',
      'item',
      'drop-deferred',
      '--id',
      k1Id,
      '--reason',
      'Fixed in this diff',
      '--key',
      'K1',
    ],
    { CLAUDE_CODE_SESSION_ID: rawId }
  )
  assert.equal(dropResult.status, 0, 'the drop succeeds')

  assert.deepEqual(
    loadState('node-k1')?.deferredQuestions,
    [],
    '--key K1 reached drop-deferred through the real CLI boundary and removed K1’s own entry'
  )
  assert.equal(
    loadState('node-k2')?.deferredQuestions?.length,
    1,
    'K2’s entry is untouched — --key did not fall through to a different node'
  )
})

// item.test.ts's own direct run*() calls cannot see the flag layer, so --session on drop-deferred
// and flush-deferred needs its own crossing test here, the same way --key and list-deferred's
// --session already have above. Same decoy-sibling shape as list-deferred's --session test below:
// a deleted `session: flags.session` falls through to keyless resolution and targets the wrong
// node, not this one.
test('CLI: item drop-deferred --session crosses the real Stricli flag layer to the named node directly', () => {
  registerRootNode(rawId)
  upsertRegistryNode(rawId, {
    internalId: 'node-alt',
    externalId: `${rawId}:ALT`,
    key: 'ALT',
    parentId: null,
  })
  const addResult = runCli(
    [
      'dashboard',
      'item',
      'add',
      '--type',
      'question',
      '--prompt',
      'ALT’s own question?',
      '--recommend',
      'Ship it',
      '--stalls',
      'none',
      '--why-mine',
      'scope',
      '--defer',
      '--session',
      'node-alt',
    ],
    { AI_WORKFLOW_APP_BIN: writeStub(tmpDir, '{}'), CLAUDE_CODE_SESSION_ID: rawId }
  )
  assert.equal(addResult.status, 0, 'the defer post succeeds, targeting the internal id directly')
  const deferredId = (JSON.parse(addResult.stdout) as { deferredId: string }).deferredId

  const dropResult = runCli(
    [
      'dashboard',
      'item',
      'drop-deferred',
      '--id',
      deferredId,
      '--reason',
      'Fixed in this diff',
      '--session',
      'node-alt',
    ],
    { CLAUDE_CODE_SESSION_ID: rawId }
  )
  assert.equal(dropResult.status, 0, 'the drop succeeds, targeting the internal id directly')

  assert.deepEqual(
    loadState('node-alt')?.deferredQuestions,
    [],
    '--session reached drop-deferred through the real CLI boundary'
  )
})

test('CLI: item list-deferred --key crosses the real Stricli flag layer to the named sibling node', () => {
  upsertRegistryNode(rawId, {
    internalId: 'node-k1',
    externalId: `${rawId}:K1`,
    key: 'K1',
    parentId: null,
  })
  upsertRegistryNode(rawId, {
    internalId: 'node-k2',
    externalId: `${rawId}:K2`,
    key: 'K2',
    parentId: null,
  })
  const deferOn = (key: string, lede: string): void => {
    const result = runCli(
      [
        'dashboard',
        'item',
        'add',
        '--type',
        'question',
        '--prompt',
        lede,
        '--recommend',
        'Ship it',
        '--stalls',
        'none',
        '--why-mine',
        'scope',
        '--defer',
        '--key',
        key,
      ],
      { AI_WORKFLOW_APP_BIN: writeStub(tmpDir, '{}'), CLAUDE_CODE_SESSION_ID: rawId }
    )
    assert.equal(result.status, 0, `the ${key} defer post succeeds`)
  }
  deferOn('K1', 'K1’s own question?')
  deferOn('K2', 'K2’s own question?')

  const { stdout, status } = runCli(['dashboard', 'item', 'list-deferred', '--key', 'K1'], {
    CLAUDE_CODE_SESSION_ID: rawId,
  })
  assert.equal(status, 0)
  const parsed = JSON.parse(stdout) as { lede: string }[]
  assert.equal(parsed.length, 1, '--key K1 reached list-deferred through the real CLI boundary')
  assert.equal(parsed[0]?.lede, 'K1’s own question?', '--key K1 targets K1’s own queue, not K2’s')
})

test('CLI: item list-deferred --session crosses the real Stricli flag layer to the named node directly', () => {
  // registerRootNode gives rawId itself a second, DECOY leaf — without it, node-alt would be the
  // sole registry entry and a deleted --session wire would still resolve to it by keyless-leaf
  // coincidence, passing the test under the mutation this exists to catch.
  registerRootNode(rawId)
  upsertRegistryNode(rawId, {
    internalId: 'node-alt',
    externalId: `${rawId}:ALT`,
    key: 'ALT',
    parentId: null,
  })
  const addResult = runCli(
    [
      'dashboard',
      'item',
      'add',
      '--type',
      'question',
      '--prompt',
      'ALT’s own question?',
      '--recommend',
      'Ship it',
      '--stalls',
      'none',
      '--why-mine',
      'scope',
      '--defer',
      '--session',
      'node-alt',
    ],
    { AI_WORKFLOW_APP_BIN: writeStub(tmpDir, '{}'), CLAUDE_CODE_SESSION_ID: rawId }
  )
  assert.equal(addResult.status, 0, 'the defer post succeeds, targeting the internal id directly')

  const { stdout, status } = runCli(
    ['dashboard', 'item', 'list-deferred', '--session', 'node-alt'],
    {
      CLAUDE_CODE_SESSION_ID: rawId,
    }
  )
  assert.equal(status, 0)
  const parsed = JSON.parse(stdout) as { lede: string }[]
  assert.equal(parsed.length, 1, '--session reached list-deferred through the real CLI boundary')
  assert.equal(parsed[0]?.lede, 'ALT’s own question?')
})

test('CLI: item flush-deferred --key crosses the real Stricli flag layer to the named sibling node', () => {
  upsertRegistryNode(rawId, {
    internalId: 'node-k1',
    externalId: `${rawId}:K1`,
    key: 'K1',
    parentId: null,
  })
  upsertRegistryNode(rawId, {
    internalId: 'node-k2',
    externalId: `${rawId}:K2`,
    key: 'K2',
    parentId: null,
  })
  const deferOn = (key: string): void => {
    const result = runCli(
      [
        'dashboard',
        'item',
        'add',
        '--type',
        'question',
        '--prompt',
        `${key}’s own question?`,
        '--recommend',
        'Ship it',
        '--stalls',
        'none',
        '--why-mine',
        'scope',
        '--defer',
        '--key',
        key,
      ],
      { AI_WORKFLOW_APP_BIN: writeStub(tmpDir, '{}'), CLAUDE_CODE_SESSION_ID: rawId }
    )
    assert.equal(result.status, 0, `the ${key} defer post succeeds`)
  }
  deferOn('K1')
  deferOn('K2')

  const stubBin = writeBranchingStub(tmpDir, '[]', '{"itemId":"item-flush-k1"}')
  const { status } = runCli(['dashboard', 'item', 'flush-deferred', '--key', 'K1'], {
    AI_WORKFLOW_APP_BIN: stubBin,
    CLAUDE_CODE_SESSION_ID: rawId,
  })
  assert.equal(status, 0)

  const calls = readCalls(tmpDir)
  assert.ok(
    calls.some((c) => c.includes('item add') && c.includes('--session node-k1')),
    '--key K1 reached flush-deferred through the real CLI boundary and targeted the K1 node'
  )
  assert.equal(
    loadState('node-k2')?.deferredQuestions?.length,
    1,
    'K2’s queue is untouched — --key did not fall through to a different node'
  )
})

// Same crossing gap as drop-deferred's --session test above, for flush-deferred.
test('CLI: item flush-deferred --session crosses the real Stricli flag layer to the named node directly', () => {
  registerRootNode(rawId)
  upsertRegistryNode(rawId, {
    internalId: 'node-alt',
    externalId: `${rawId}:ALT`,
    key: 'ALT',
    parentId: null,
  })
  const addResult = runCli(
    [
      'dashboard',
      'item',
      'add',
      '--type',
      'question',
      '--prompt',
      'ALT’s own question?',
      '--recommend',
      'Ship it',
      '--stalls',
      'none',
      '--why-mine',
      'scope',
      '--defer',
      '--session',
      'node-alt',
    ],
    { AI_WORKFLOW_APP_BIN: writeStub(tmpDir, '{}'), CLAUDE_CODE_SESSION_ID: rawId }
  )
  assert.equal(addResult.status, 0, 'the defer post succeeds, targeting the internal id directly')

  const stubBin = writeBranchingStub(tmpDir, '[]', '{"itemId":"item-flush-alt"}')
  const { status } = runCli(['dashboard', 'item', 'flush-deferred', '--session', 'node-alt'], {
    AI_WORKFLOW_APP_BIN: stubBin,
    CLAUDE_CODE_SESSION_ID: rawId,
  })
  assert.equal(status, 0)

  const calls = readCalls(tmpDir)
  assert.ok(
    calls.some((c) => c.includes('item add') && c.includes('--session node-alt')),
    '--session reached flush-deferred through the real CLI boundary and targeted node-alt'
  )
})

// ---------------------------------------------------------------------------
// FLOW-209: `dashboard link add --root` wiring through the real CLI boundary. The
// handler-level tests in dashboard/dashboard.test.ts call runLinkAdd() directly, which bypasses
// the Stricli flag-parsing layer entirely — the class of bug this file's tests exist to catch (see
// the FLOW-133 note above). These two prove --root actually reaches the resolver through the real
// binary, and that the keyless refusal surfaces as a usable stderr message and exit code, not a
// raw stack trace dumped by Stricli's default error handler.
// ---------------------------------------------------------------------------

test('CLI: dashboard link add --root reaches the stub targeting the root, even with a PR-level child present', () => {
  // Root gets its own internal id, distinct from rawId and from the child's — an exact-argv
  // assertion against a substring of rawId could not tell "resolved via registryRoot" apart from a
  // coincidental fallback that happens to return the raw session id verbatim.
  upsertRegistryNode(rawId, {
    internalId: 'root-node-id',
    externalId: rawId,
    key: null,
    parentId: null,
  })
  upsertRegistryNode(rawId, {
    internalId: 'branch-child',
    externalId: `${rawId}:some-branch`,
    key: 'some-branch',
    parentId: 'root-node-id',
  })
  const stubBin = writeBranchingStub(tmpDir, '[]', '{"ok":true}')

  const { stdout, stderr, status } = runCli(
    [
      'dashboard',
      'link',
      'add',
      '--kind',
      'ticket',
      '--label',
      'FLOW-100',
      '--url',
      'https://jira.example.com/FLOW-100',
      '--root',
    ],
    { AI_WORKFLOW_APP_BIN: stubBin, CLAUDE_CODE_SESSION_ID: rawId }
  )

  assert.equal(status, 0, 'exits 0')
  assert.equal(stdout, '', 'link add prints nothing on success')
  assert.ok(!stderr.includes('Error'), 'no error on stderr')
  const calls = readCalls(tmpDir)
  assert.ok(
    calls.some((c) => c.includes('link add') && c.includes('--session root-node-id')),
    'reached the stub targeting the root by its own id'
  )
  assert.ok(
    calls.every((c) => !c.includes('branch-child')),
    'never names the branch child'
  )
})

test('CLI: dashboard link add keyless refuses with a clean message and exit code once the root has a child — not a stack trace', () => {
  upsertRegistryNode(rawId, {
    internalId: 'root-node-id',
    externalId: rawId,
    key: null,
    parentId: null,
  })
  upsertRegistryNode(rawId, {
    internalId: 'branch-child',
    externalId: `${rawId}:some-branch`,
    key: 'some-branch',
    parentId: 'root-node-id',
  })
  const stubBin = writeBranchingStub(tmpDir, '[]', '{"ok":true}')

  const { stdout, stderr, status } = runCli(
    [
      'dashboard',
      'link',
      'add',
      '--kind',
      'ticket',
      '--label',
      'FLOW-100',
      '--url',
      'https://jira.example.com/FLOW-100',
    ],
    { AI_WORKFLOW_APP_BIN: stubBin, CLAUDE_CODE_SESSION_ID: rawId }
  )

  // equal(1), not notEqual(0): this is runLinkAdd's own setRequestedExitCode(1) refusal, not a
  // Stricli parse-error exit (252) or an uncaught throw's implicit non-zero exit.
  assert.equal(status, 1, 'exits with the guard exit code, not a Stricli parse-error code')
  assert.ok(stderr.includes('--root'), 'the resolver message reached stderr')
  assert.ok(stderr.includes('some-branch'), 'names the actual child key')
  assert.ok(
    !stderr.includes('resolveLinkAddTarget') && !stderr.includes('at runLinkAdd'),
    'a usable message, not a stack trace with function/file frames'
  )
  assert.equal(stdout, '', 'nothing printed on stdout')
  assert.equal(
    readCalls(tmpDir).some((c) => c.includes('link add')),
    false,
    'link add never reached the stub'
  )
})

// ---------------------------------------------------------------------------
// FLOW-351: `dashboard link add --root --kind ticket` refuses through the real CLI boundary when
// the ticket already has its own keyed node under the root (a story under an epic). The handler-level
// test in dashboard/dashboard.test.ts calls runLinkAdd() directly, which bypasses the Stricli
// flag-parsing layer this file's tests exist to catch.
// ---------------------------------------------------------------------------

test('CLI: dashboard link add --root --kind ticket refuses when the ticket has its own node under the root', () => {
  upsertRegistryNode(rawId, {
    internalId: 'root-node-id',
    externalId: rawId,
    key: null,
    parentId: null,
  })
  upsertRegistryNode(rawId, {
    internalId: 'story-node',
    externalId: `${rawId}:FLOW-100`,
    key: 'FLOW-100',
    parentId: 'root-node-id',
  })
  const stubBin = writeBranchingStub(tmpDir, '[]', '{"ok":true}')

  const { stdout, stderr, status } = runCli(
    [
      'dashboard',
      'link',
      'add',
      '--kind',
      'ticket',
      '--label',
      'FLOW-100',
      '--url',
      'https://jira.example.com/FLOW-100',
      '--root',
    ],
    { AI_WORKFLOW_APP_BIN: stubBin, CLAUDE_CODE_SESSION_ID: rawId }
  )

  assert.equal(status, 1, 'exits with the guard exit code, not a Stricli parse-error code')
  assert.ok(stderr.includes('--key FLOW-100'), 'stderr names the key to use instead')
  assert.equal(stdout, '', 'nothing printed on stdout')
  assert.equal(readCalls(tmpDir).length, 0, 'the stub dashboard binary was never invoked')
})

// ---------------------------------------------------------------------------
// FLOW-236: `--key` on item answer/approve/reject/withdraw/consume/answers/comments never crossed
// the real Stricli flag layer — item.test.ts/read.test.ts's own --key tests call the run*
// functions directly and cannot see the flag definitions themselves, the same gap FLOW-250 found
// for the deferred-queue verbs above. OBSERVED by mutation: deleting `flags.key` from all 7
// commands' func() bodies in commands/dashboard.ts left this file fully green. Each case below
// registers a decoy sibling leaf alongside the targeted node specifically so a deleted flag falls
// through to keyless resolution (two live leaves, no --key) and refuses instead of touching either
// ledger, distinguishing it from a correct --key crossing.
// ---------------------------------------------------------------------------

test('CLI: item answer/approve/reject/withdraw/consume --key each cross the real Stricli flag layer to the named sibling node', () => {
  upsertRegistryNode(rawId, {
    internalId: 'node-k1',
    externalId: `${rawId}:K1`,
    key: 'K1',
    parentId: null,
  })
  upsertRegistryNode(rawId, {
    internalId: 'node-k2',
    externalId: `${rawId}:K2`,
    key: 'K2',
    parentId: null,
  })

  const addItem = (key: string, itemId: string): void => {
    const addStub = writeStub(tmpDir, JSON.stringify({ itemId }))
    const result = runCli(
      [
        'dashboard',
        'item',
        'add',
        '--type',
        'question',
        '--prompt',
        `${key}’s own question?`,
        '--recommend',
        'Ship it',
        '--stalls',
        'none',
        '--why-mine',
        'scope',
        '--key',
        key,
      ],
      { AI_WORKFLOW_APP_BIN: addStub, CLAUDE_CODE_SESSION_ID: rawId }
    )
    assert.equal(result.status, 0, `${key} add succeeds`)
  }

  const cases: { verb: string; args: (item: string) => string[] }[] = [
    {
      verb: 'answer',
      args: (item) => ['dashboard', 'item', 'answer', '--item', item, '--response', 'yes'],
    },
    { verb: 'approve', args: (item) => ['dashboard', 'item', 'approve', '--item', item] },
    {
      verb: 'reject',
      args: (item) => ['dashboard', 'item', 'reject', '--item', item, '--note', 'no'],
    },
    { verb: 'withdraw', args: (item) => ['dashboard', 'item', 'withdraw', '--item', item] },
    { verb: 'consume', args: (item) => ['dashboard', 'item', 'consume', '--item', item] },
  ]

  for (const { verb, args } of cases) {
    const itemK1 = `item-${verb}-k1`
    const itemK2 = `item-${verb}-k2`
    addItem('K1', itemK1)
    addItem('K2', itemK2)

    const verbStub = writeStub(tmpDir, 'ok')
    const result = runCli([...args(itemK1), '--key', 'K1'], {
      AI_WORKFLOW_APP_BIN: verbStub,
      CLAUDE_CODE_SESSION_ID: rawId,
    })
    assert.equal(result.status, 0, `${verb} --key K1 succeeds through the real CLI boundary`)
    assert.ok(
      !loadState('node-k1')!.openItemIds.includes(itemK1),
      `${verb} --key K1 reached K1's own ledger and dropped its item`
    )
    assert.ok(
      loadState('node-k2')!.openItemIds.includes(itemK2),
      `${verb} --key K1 did not touch K2's ledger`
    )
  }
})

test('CLI: answers/comments --key each cross the real Stricli flag layer to the named sibling node', () => {
  upsertRegistryNode(rawId, {
    internalId: 'node-k1',
    externalId: `${rawId}:K1`,
    key: 'K1',
    parentId: null,
  })
  upsertRegistryNode(rawId, {
    internalId: 'node-k2',
    externalId: `${rawId}:K2`,
    key: 'K2',
    parentId: null,
  })

  for (const verb of ['answers', 'comments']) {
    const stubBin = writeBranchingStub(tmpDir, '[]', '[]')
    const result = runCli(['dashboard', verb, '--key', 'K1'], {
      AI_WORKFLOW_APP_BIN: stubBin,
      CLAUDE_CODE_SESSION_ID: rawId,
    })
    assert.equal(result.status, 0, `${verb} --key K1 succeeds through the real CLI boundary`)
    assert.ok(
      readCalls(tmpDir).some((c) => c.includes(verb) && c.includes('node-k1')),
      `${verb} --key K1 reached the backend targeting K1's internal id`
    )
    assert.ok(
      readCalls(tmpDir).every((c) => !(c.includes(verb) && c.includes('node-k2'))),
      `${verb} --key K1 did not target K2`
    )
  }
})

test('CLI: leave --root proceeds when the only defect in the state file is deferredIdCounter — the guard refuses on what loadState could not read, not on every corrupt-file arm', () => {
  const stubBin = writeBranchingStub(tmpDir, '[]', '')
  registerRootNode(rawId)
  mkdirSync(dirname(stateFilePath(rawId)), { recursive: true })
  // Every load-bearing field is well-formed, so loadState returns this state intact and the
  // `?? []` read that motivated the guard cannot lie here. deferredIdCounter is the one
  // stateFileIsCorrupt arm loadState never consults: nextDeferredId mints
  // `Math.max(persisted, highestQueued) + 1`, so a negative counter reissues q1 as soon as a flush
  // drains the queue that was masking it. Worth refusing where deferred ids are minted; no reason
  // to refuse to end a session.
  writeFileSync(
    stateFilePath(rawId),
    '{"registered":true,"phase":"implementation","openItemIds":["item-1"],"deferredIdCounter":-5}'
  )

  const { stderr, status } = runCli(['dashboard', 'session', 'leave', '--root'], {
    AI_WORKFLOW_APP_BIN: stubBin,
    CLAUDE_CODE_SESSION_ID: rawId,
  })

  const calls = readCalls(tmpDir)
  assert.ok(
    calls.some((c) => c.includes('item withdraw') && c.includes(rawId)),
    `the open item is withdrawn, got calls: ${JSON.stringify(calls)} and stderr: ${stderrBeyondNodeWarnings(stderr)}`
  )
  assert.ok(
    calls.some((c) => c.includes('session end') && c.includes(`--id ${rawId}`)),
    `the session is ended, got calls: ${JSON.stringify(calls)}`
  )
  assert.equal(status, 0, `exits clean, stderr was: ${stderrBeyondNodeWarnings(stderr)}`)
})

test('CLI: dashboard session refresh-return links the root, reuses the recorded --cwd, and prints nothing', () => {
  const stubBin = writeBranchingStub(tmpDir, '[]', '')
  registerRootNode(rawId)
  const env = {
    AI_WORKFLOW_APP_BIN: stubBin,
    CLAUDE_CODE_SESSION_ID: rawId,
    ITERM_SESSION_ID: 'w1t2p3:CAFE-F00D',
  }

  const first = runCli(['dashboard', 'session', 'refresh-return', '--cwd', '/launch/here'], env)
  const second = runCli(['dashboard', 'session', 'refresh-return'], env)

  const url = `agent-session://iterm/CAFE-F00D?claude=${rawId}&cwd=%2Flaunch%2Fhere`
  const expected = `link add --session ${rawId} --kind return --label iTerm --url ${url}`
  assert.deepEqual(readCalls(tmpDir), [expected, expected])
  for (const run of [first, second]) {
    assert.equal(run.status, 0, stderrBeyondNodeWarnings(run.stderr))
    assert.equal(run.stdout, '')
    assert.equal(stderrBeyondNodeWarnings(run.stderr), '')
  }
})

test('CLI: dashboard session refresh-return --session targets that session’s root, not the env session’s', () => {
  const stubBin = writeBranchingStub(tmpDir, '[]', '')
  const target = `${rawId}-target`
  registerRootNode(target)

  const run = runCli(
    ['dashboard', 'session', 'refresh-return', '--session', target, '--cwd', '/d'],
    {
      AI_WORKFLOW_APP_BIN: stubBin,
      CLAUDE_CODE_SESSION_ID: `${rawId}-different`,
      ITERM_SESSION_ID: 'w1t2p3:CAFE-F00D',
    }
  )

  assert.equal(run.status, 0, stderrBeyondNodeWarnings(run.stderr))
  assert.deepEqual(readCalls(tmpDir), [
    `link add --session ${target} --kind return --label iTerm --url agent-session://iterm/CAFE-F00D?claude=${target}&cwd=%2Fd`,
  ])
})
