import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  existsSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runCheck, pollTargets } from './check.ts'
import { saveState as saveDashboardState } from '../dashboard/state.ts'
import { upsertRegistryNode, registryFilePath } from '../dashboard/registry.ts'
import { getRequestedExitCode } from '../runtime-exit-code.ts'
import { renovateLockPath } from '../renovate-pr-monitor/lock.ts'

// Helpers duplicated per file, the repo's convention (see stop-gate.test.ts's own boardRow).

const makeTempDir = (): string => mkdtempSync(join(tmpdir(), 'check-test-'))

/**
 * Write a stub ai-workflow-app binary. 'answers' calls emit answersJson (only for
 * answersOnlyForSession when given, '[]' otherwise); every other call emits '{}'. Records every
 * argv line to calls.log so a test can assert which commands fired.
 */
const writeAnswersStub = (
  dir: string,
  answersJson: string,
  answersOnlyForSession?: string,
  delaySecs?: number
): string => {
  const path = join(dir, 'ai-workflow-app')
  const log = join(dir, 'calls.log')
  writeFileSync(
    path,
    [
      '#!/usr/bin/env bash',
      `echo "$@" >> ${JSON.stringify(log)}`,
      ...(delaySecs === undefined ? [] : [`sleep ${delaySecs}`]),
      `if echo "$@" | grep -q 'answers'; then`,
      answersOnlyForSession === undefined
        ? `  echo ${JSON.stringify(answersJson)}`
        : `  if echo "$@" | grep -q -- ${JSON.stringify(`--session ${answersOnlyForSession}`)}; then echo ${JSON.stringify(answersJson)}; else echo '[]'; fi`,
      `else`,
      `  echo '{}'`,
      `fi`,
      'exit 0',
    ].join('\n') + '\n'
  )
  chmodSync(path, 0o755)
  return path
}

const readCalls = (dir: string): string[] => {
  const log = join(dir, 'calls.log')
  if (!existsSync(log)) {
    return []
  }
  return readFileSync(log, 'utf-8').split('\n').filter(Boolean)
}

const captureOutput = (): {
  getStdout: () => string
  getStderr: () => string
  restore: () => void
} => {
  const outChunks: string[] = []
  const errChunks: string[] = []
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    outChunks.push(String(chunk))
    return true
  }
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    errChunks.push(String(chunk))
    return true
  }
  return {
    getStdout: () => outChunks.join(''),
    getStderr: () => errChunks.join(''),
    restore: () => {
      process.stdout.write = origOut
      process.stderr.write = origErr
    },
  }
}

// Runs one check and returns what it printed.
const check = (): { stdout: string; stderr: string } => {
  const out = captureOutput()
  try {
    runCheck()
  } finally {
    out.restore()
  }
  return { stdout: out.getStdout(), stderr: out.getStderr() }
}

let tmpDir: string
let homeDir: string
let origBin: string | undefined
let origSessionId: string | undefined
let origHome: string | undefined
let origExitCode: typeof process.exitCode

beforeEach(() => {
  tmpDir = makeTempDir()
  origBin = process.env.AI_WORKFLOW_APP_BIN
  origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  origExitCode = process.exitCode
  // A nonexistent binary makes resolveDashboardBin() return null, so a test never reaches the real
  // ai-workflow-app.
  process.env.AI_WORKFLOW_APP_BIN = join(tmpDir, 'nonexistent-binary')
  const uniqueId = tmpDir.replace(/[^a-zA-Z0-9]/g, '-').slice(-32)
  process.env.CLAUDE_CODE_SESSION_ID = `test-check-session-${uniqueId}`
  homeDir = mkdtempSync(join(tmpdir(), 'check-test-home-'))
  origHome = process.env.HOME
  process.env.HOME = homeDir
})

afterEach(() => {
  process.exitCode = origExitCode
  if (origBin === undefined) {
    delete process.env.AI_WORKFLOW_APP_BIN
  } else {
    process.env.AI_WORKFLOW_APP_BIN = origBin
  }
  if (origSessionId === undefined) {
    delete process.env.CLAUDE_CODE_SESSION_ID
  } else {
    process.env.CLAUDE_CODE_SESSION_ID = origSessionId
  }
  if (origHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = origHome
  }
  rmSync(tmpDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
})

const registerNode = (id: string): void =>
  saveDashboardState(id, { registered: true, phase: 'implementation', openItemIds: [] })

test('check: prints each released item on the anchor and exits 0', () => {
  const rawId = process.env.CLAUDE_CODE_SESSION_ID!
  registerNode(rawId)
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([
      { id: 'item-q-1', type: 'question', response: 'first answer' },
      { id: 'item-q-2', type: 'approval', decision: 'approved' },
    ])
  )

  const { stdout } = check()

  assert.deepEqual(stdout.split('\n').filter(Boolean), [
    '[dashboard] item item-q-1 (question): first answer',
    `    → act on it, then consume it: \`dashboard item consume --item item-q-1 --session ${rawId}\``,
    '[dashboard] item item-q-2 (approval): approved',
    `    → act on it, then consume it: \`dashboard item consume --item item-q-2 --session ${rawId}\``,
  ])
  assert.equal(process.exitCode ?? 0, 0)
})

test('check: an approval prints decision then note', () => {
  registerNode(process.env.CLAUDE_CODE_SESSION_ID!)
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([
      { id: 'item-appr-1', type: 'approval', decision: 'rejected', response: 'not ready yet' },
    ])
  )

  const { stdout } = check()

  assert.equal(
    stdout,
    '[dashboard] item item-appr-1 (approval): rejected — not ready yet\n' +
      `    → act on it, then consume it: \`dashboard item consume --item item-appr-1 --session ${process.env.CLAUDE_CODE_SESSION_ID}\`\n`
  )
})

test('check: an item released on another node names its consume command on that node', () => {
  const rawId = process.env.CLAUDE_CODE_SESSION_ID!
  const epic = `${rawId}_epic`
  const story = `${rawId}:story`
  upsertRegistryNode(rawId, { internalId: epic, externalId: epic, key: null, parentId: null })
  upsertRegistryNode(rawId, { internalId: story, externalId: story, key: 'STORY', parentId: epic })
  registerNode(epic)
  registerNode(story)
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([{ id: 'item-9', type: 'question', decision: 'approved' }]),
    epic
  )

  const { stdout } = check()

  assert.equal(
    stdout,
    '[dashboard] item item-9 (question): approved\n' +
      `    → act on it, then consume it: \`dashboard item consume --item item-9 --session ${epic}\`\n`
  )
})

test('check: a reference line follows the item, after the other-node consume hint', () => {
  const rawId = process.env.CLAUDE_CODE_SESSION_ID!
  const epic = `${rawId}_epic`
  const story = `${rawId}:story`
  upsertRegistryNode(rawId, { internalId: epic, externalId: epic, key: null, parentId: null })
  upsertRegistryNode(rawId, { internalId: story, externalId: story, key: 'STORY', parentId: epic })
  registerNode(epic)
  registerNode(story)
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([
      {
        id: 'item-9',
        type: 'comment',
        response: 'why this order?',
        references: [
          {
            kind: 'related',
            direction: 'outgoing',
            item: {
              id: 'appr-1',
              type: 'approval',
              state: 'open',
              prompt: 'Ship it?',
              response: null,
            },
          },
        ],
      },
    ]),
    epic
  )

  const { stdout } = check()

  assert.deepEqual(stdout.split('\n').filter(Boolean), [
    '[dashboard] item item-9 (comment): why this order?',
    '    ↳ related to item appr-1 (approval): Ship it?',
    '    → reply on the board, not only in the terminal, unless it asks nothing and gives you nothing to act on: ' +
      `\`dashboard item add --type info --answers item-9 --session ${epic} --prompt "$(cat "<tmpfile>")"\`` +
      ' (a question instead only when the comment raises a decision that earns one),' +
      ` then consume it: \`dashboard item consume --item item-9 --session ${epic}\``,
  ])
})

test('check: a released item on a non-anchor sibling leaf is reported', () => {
  const rawId = process.env.CLAUDE_CODE_SESSION_ID!
  const leafA = `${rawId}:leaf-a`
  const leafB = `${rawId}:leaf-b`
  upsertRegistryNode(rawId, {
    internalId: leafA,
    externalId: `${rawId}:A`,
    key: 'A',
    parentId: null,
  })
  upsertRegistryNode(rawId, {
    internalId: leafB,
    externalId: `${rawId}:B`,
    key: 'B',
    parentId: null,
  })
  registerNode(leafA)
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([
      { id: 'item-b-1', type: 'question', response: 'released on the sibling leaf' },
    ]),
    leafB
  )

  const { stdout } = check()

  assert.match(stdout, /item item-b-1/)
  assert.match(stdout, /released on the sibling leaf/)
})

test('check: a released comment is reported on a session with zero open items', () => {
  registerNode(process.env.CLAUDE_CODE_SESSION_ID!)
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([{ id: 'comment-1', type: 'comment', response: 'hello from the user' }])
  )

  const { stdout } = check()

  assert.equal(
    stdout,
    '[dashboard] item comment-1 (comment): hello from the user\n    → reply on the board, not only in the terminal, unless it asks nothing and gives you nothing to act on: ' +
      `\`dashboard item add --type info --answers comment-1 --session ${process.env.CLAUDE_CODE_SESSION_ID} --prompt "$(cat "<tmpfile>")"\`` +
      ' (a question instead only when the comment raises a decision that earns one),' +
      ` then consume it: \`dashboard item consume --item comment-1 --session ${process.env.CLAUDE_CODE_SESSION_ID}\`\n`
  )
})

test('check: a released comment names its board reply command', () => {
  registerNode(process.env.CLAUDE_CODE_SESSION_ID!)
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([
      { id: 'comment-1', type: 'comment', response: 'hello from the user' },
      { id: 'item-q-1', type: 'question', response: 'an answer' },
    ])
  )

  const { stdout } = check()

  assert.deepEqual(stdout.split('\n').filter(Boolean), [
    '[dashboard] item comment-1 (comment): hello from the user',
    '    → reply on the board, not only in the terminal, unless it asks nothing and gives you nothing to act on: ' +
      `\`dashboard item add --type info --answers comment-1 --session ${process.env.CLAUDE_CODE_SESSION_ID} --prompt "$(cat "<tmpfile>")"\`` +
      ' (a question instead only when the comment raises a decision that earns one),' +
      ` then consume it: \`dashboard item consume --item comment-1 --session ${process.env.CLAUDE_CODE_SESSION_ID}\``,
    '[dashboard] item item-q-1 (question): an answer',
    `    → act on it, then consume it: \`dashboard item consume --item item-q-1 --session ${process.env.CLAUDE_CODE_SESSION_ID}\``,
  ])
})

test('check: a comment on the root of a multi-leaf session targets the root in both commands', () => {
  const rawId = process.env.CLAUDE_CODE_SESSION_ID!
  const root = `${rawId}_root`
  const leafA = `${rawId}:leaf-a`
  const leafB = `${rawId}:leaf-b`
  upsertRegistryNode(rawId, { internalId: root, externalId: root, key: null, parentId: null })
  upsertRegistryNode(rawId, { internalId: leafA, externalId: leafA, key: 'A', parentId: root })
  upsertRegistryNode(rawId, { internalId: leafB, externalId: leafB, key: 'B', parentId: root })
  registerNode(root)
  registerNode(leafA)
  registerNode(leafB)
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([{ id: 'comment-9', type: 'comment', response: 'about the whole epic' }]),
    root
  )

  const { stdout } = check()

  assert.equal(
    stdout,
    '[dashboard] item comment-9 (comment): about the whole epic\n    → reply on the board, not only in the terminal, unless it asks nothing and gives you nothing to act on: ' +
      `\`dashboard item add --type info --answers comment-9 --session ${root} --prompt "$(cat "<tmpfile>")"\`` +
      ' (a question instead only when the comment raises a decision that earns one),' +
      ` then consume it: \`dashboard item consume --item comment-9 --session ${root}\`\n`
  )
})

test('check: a session that never entered the board makes no board call and prints nothing', () => {
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([{ id: 'item-1', type: 'question', response: 'would wake' }])
  )

  const { stdout } = check()

  assert.equal(stdout, '')
  assert.deepEqual(readCalls(tmpDir), [])
})

test('check: re-reports a released item on every run until it is consumed', () => {
  registerNode(process.env.CLAUDE_CODE_SESSION_ID!)
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([{ id: 'item-1', type: 'question', response: 'yes' }])
  )

  const first = check().stdout
  const second = check().stdout

  assert.equal(
    first,
    '[dashboard] item item-1 (question): yes\n' +
      `    → act on it, then consume it: \`dashboard item consume --item item-1 --session ${process.env.CLAUDE_CODE_SESSION_ID}\`\n`
  )
  assert.equal(second, first)
})

// ---------------------------------------------------------------------------
// Dead-monitor wakes (FLOW-224): the Renovate monitor only; pr-monitor has no process to die
// ---------------------------------------------------------------------------

const writeDeadLock = (pid: number, heartbeatAt: string): void => {
  const path = renovateLockPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ pid, startedAt: heartbeatAt, heartbeatAt }))
}

const deadMonitorLine = (pid: number, heartbeatAt: string): string =>
  `[renovate-pr-monitor] dead-monitor — the monitor loop (pid ${pid}) exited without emitting an ` +
  `event; last heartbeat ${heartbeatAt}. No further event can arrive. Restart it: ` +
  `renovate-pr-monitor`

test('check: reports a dead Renovate monitor once', () => {
  registerNode(process.env.CLAUDE_CODE_SESSION_ID!)
  const heartbeatAt = new Date(Date.now() - 15 * 60_000).toISOString()
  writeDeadLock(999_999_999, heartbeatAt)

  const first = check().stdout
  const second = check().stdout

  assert.equal(first, `${deadMonitorLine(999_999_999, heartbeatAt)}\n`)
  assert.equal(second, '', 'a given death is reported only once')
})

test('check: reports a dead monitor and a released answer in the same run', () => {
  registerNode(process.env.CLAUDE_CODE_SESSION_ID!)
  const heartbeatAt = new Date(Date.now() - 15 * 60_000).toISOString()
  writeDeadLock(999_999_999, heartbeatAt)
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([{ id: 'item-1', type: 'comment', response: 'reviewer says LGTM' }])
  )

  const { stdout, stderr } = check()

  assert.equal(
    stdout,
    '[dashboard] item item-1 (comment): reviewer says LGTM\n    → reply on the board, not only in the terminal, unless it asks nothing and gives you nothing to act on: ' +
      `\`dashboard item add --type info --answers item-1 --session ${process.env.CLAUDE_CODE_SESSION_ID} --prompt "$(cat "<tmpfile>")"\`` +
      ' (a question instead only when the comment raises a decision that earns one),' +
      ` then consume it: \`dashboard item consume --item item-1 --session ${process.env.CLAUDE_CODE_SESSION_ID}\`\n` +
      `${deadMonitorLine(999_999_999, heartbeatAt)}\n`
  )
  assert.equal(stderr, '')
  assert.equal(process.exitCode ?? 0, 0)
})

test('check: a multi-line answer indents its continuation lines so no line opens with a tag', () => {
  registerNode(process.env.CLAUDE_CODE_SESSION_ID!)
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([{ id: 'q1', type: 'question', response: 'see below\n[team] keep it' }])
  )

  const { stdout, stderr } = check()

  assert.equal(
    stdout,
    '[dashboard] item q1 (question): see below\n  [team] keep it\n' +
      `    → act on it, then consume it: \`dashboard item consume --item q1 --session ${process.env.CLAUDE_CODE_SESSION_ID}\`\n`
  )
  assert.equal(stderr, '')
})

test('check: a failing answers call exits 3 and still reports a dead monitor', () => {
  registerNode(process.env.CLAUDE_CODE_SESSION_ID!)
  const heartbeatAt = new Date(Date.now() - 15 * 60_000).toISOString()
  writeDeadLock(999_999_999, heartbeatAt)
  const stub = join(tmpDir, 'ai-workflow-app')
  writeFileSync(stub, '#!/usr/bin/env bash\necho "board down" >&2\nexit 7\n')
  chmodSync(stub, 0o755)
  process.env.AI_WORKFLOW_APP_BIN = stub

  const { stdout, stderr } = check()

  assert.equal(getRequestedExitCode(), undefined)
  assert.equal(process.exitCode, 3)
  assert.equal(stdout, `${deadMonitorLine(999_999_999, heartbeatAt)}\n`)
  assert.equal(
    stderr,
    `dashboard: ai-workflow-app answers --session ${process.env.CLAUDE_CODE_SESSION_ID} failed: board down\n`
  )
})

test('check: unparseable answers output exits 3', () => {
  registerNode(process.env.CLAUDE_CODE_SESSION_ID!)
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(tmpDir, 'not json')

  const { stdout } = check()

  assert.equal(stdout, '')
  assert.equal(process.exitCode, 3)
})

test('check: an unreadable registry checks the anchor only and says what to repair', () => {
  const id = process.env.CLAUDE_CODE_SESSION_ID!
  registerNode(id)
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([{ id: 'item-1', type: 'question', response: 'still heard' }])
  )
  rmSync(registryFilePath(id), { recursive: true, force: true })
  mkdirSync(dirname(registryFilePath(id)), { recursive: true })
  writeFileSync(registryFilePath(id), '{"nodes": {"a": {}}}')

  const { stdout, stderr } = check()

  assert.match(stderr, /parses, but its nodes field is not an array of nodes/)
  assert.match(stderr, /other nodes cannot be enumerated until it is repaired/)
  assert.doesNotMatch(stderr, /until it is readable/)
  assert.match(stdout, /\[dashboard\] item item-1 \(question\): still heard/)
  assert.equal(process.exitCode, 3)
})

test('check: no session id exits 2 with a message on stderr', () => {
  delete process.env.CLAUDE_CODE_SESSION_ID

  const { stdout, stderr } = check()

  assert.equal(process.exitCode, 2)
  assert.match(stderr, /mailbox check: no session id/)
  assert.equal(stdout, '')
})

test('pollTargets: an interior node with a live child is polled alongside the child', () => {
  const rawId = process.env.CLAUDE_CODE_SESSION_ID!
  const epic = `${rawId}_epic`
  const story = `${rawId}:story`
  upsertRegistryNode(rawId, { internalId: epic, externalId: epic, key: null, parentId: null })
  upsertRegistryNode(rawId, { internalId: story, externalId: story, key: 'STORY', parentId: epic })

  assert.deepEqual(pollTargets(rawId, story).sort(), [epic, story].sort())
})

// The real binary, as the wake mod runs it: --session given, no CLAUDE_CODE_SESSION_ID.
const binMailbox = fileURLToPath(new URL('../../../../bin/mailbox', import.meta.url))

const runBinCheck = (
  extraEnv: NodeJS.ProcessEnv = {}
): { status: number | null; stdout: string; stderr: string } => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    NODE_NO_WARNINGS: '1',
    ...extraEnv,
  }
  if (extraEnv.CLAUDE_CODE_SESSION_ID === undefined) {
    delete env.CLAUDE_CODE_SESSION_ID
  }
  const result = spawnSync(binMailbox, ['check', '--session', 'sess-bin'], {
    env,
    encoding: 'utf8',
  })

  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const seedSingleNode = (): void => {
  upsertRegistryNode('sess-bin', {
    internalId: 'node-1',
    externalId: 'sess-bin_root',
    key: null,
    parentId: null,
  })
  // State is partitioned by the session id in the environment, which is what the subprocess derives
  // from --session; seed under that id, then put this test's own back.
  const own = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = 'sess-bin'
  try {
    registerNode('node-1')
  } finally {
    process.env.CLAUDE_CODE_SESSION_ID = own
  }
}

test('bin/mailbox check: --session alone resolves the node, prints the plain line, exits 0', () => {
  seedSingleNode()
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([{ id: 'item-1', type: 'question', response: 'ship it' }])
  )

  const result = runBinCheck()

  assert.deepEqual(result, {
    status: 0,
    stdout:
      '[dashboard] item item-1 (question): ship it\n' +
      '    → act on it, then consume it: `dashboard item consume --item item-1 --session node-1`\n',
    stderr: '',
  })
})

test('bin/mailbox check: --session overrides an inherited session id', () => {
  seedSingleNode()
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([{ id: 'item-1', type: 'question', response: 'ship it' }])
  )

  const result = runBinCheck({ CLAUDE_CODE_SESSION_ID: 'some-outer-session' })

  assert.deepEqual(result, {
    status: 0,
    stdout:
      '[dashboard] item item-1 (question): ship it\n' +
      '    → act on it, then consume it: `dashboard item consume --item item-1 --session node-1`\n',
    stderr: '',
  })
})

test('bin/mailbox check: nothing released exits 0 with empty output; a failing board exits 3', () => {
  seedSingleNode()
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(tmpDir, '[]')
  const quiet = runBinCheck()

  const stub = join(tmpDir, 'failing-app')
  writeFileSync(stub, '#!/usr/bin/env bash\necho "board down" >&2\nexit 7\n')
  chmodSync(stub, 0o755)
  process.env.AI_WORKFLOW_APP_BIN = stub
  const failing = runBinCheck()

  assert.deepEqual(quiet, { status: 0, stdout: '', stderr: '' })
  assert.deepEqual(failing, {
    status: 3,
    stdout: '',
    stderr: 'dashboard: ai-workflow-app answers --session node-1 failed: board down\n',
  })
})

// --- FLOW-402: PR changes through the real binaries ---

const binPrMonitor = fileURLToPath(new URL('../../../../bin/pr-monitor', import.meta.url))
const fakeGhDir = fileURLToPath(new URL('../pr-monitor/test/fake-gh', import.meta.url))
const ciFailing = JSON.stringify([{ name: 'ci', state: 'FAILURE' }])

// The mod's child has --session and no CLAUDE_CODE_SESSION_ID; `pr-monitor` is run the way the
// agent's Bash runs it, with the session id and no board. Both see a `gh` that reports one failing
// check.
const watchSessionPr = (prNumber: string): void => {
  const result = spawnSync(binPrMonitor, ['--pr', prNumber, '--repo', 'a/b'], {
    env: {
      ...process.env,
      HOME: homeDir,
      NODE_NO_WARNINGS: '1',
      CLAUDE_CODE_SESSION_ID: 'sess-bin',
    },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
}

const runCheckWithFakeGh = (): { status: number | null; stdout: string; stderr: string } =>
  runBinCheck({
    PATH: `${fakeGhDir}:${process.env.PATH ?? ''}`,
    CHECKS_JSON: ciFailing,
  })

const prEntryLine = '[pr-monitor] changes detected on a/b#7\n'
// The fake gh reports a ready PR against a draft first baseline, so the first poll also reports the
// flip.
const prEntryBody =
  '\n  [READY_FOR_REVIEW] PR moved out of draft (ready for review) — not confirmed merge-ready\n' +
  '  [CI_FAILURE] Check "ci" failed (was: pending)\n'

test('bin/mailbox check: a watched PR with a failing check prints one [pr-monitor] entry, exits 0, and stays quiet on the next check', () => {
  watchSessionPr('7')

  const first = runCheckWithFakeGh()
  const second = runCheckWithFakeGh()

  assert.deepEqual(first, { status: 0, stdout: prEntryLine + prEntryBody, stderr: '' })
  assert.deepEqual(second, { status: 0, stdout: '', stderr: '' })
})

test('bin/mailbox check: a board answer prints before a PR change in one check', () => {
  seedSingleNode()
  watchSessionPr('7')
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([{ id: 'item-1', type: 'question', response: 'ship it' }])
  )

  const result = runCheckWithFakeGh()

  assert.deepEqual(result, {
    status: 0,
    stdout:
      '[dashboard] item item-1 (question): ship it\n' +
      '    → act on it, then consume it: `dashboard item consume --item item-1 --session node-1`\n' +
      prEntryLine +
      prEntryBody,
    stderr: '',
  })
})

test('bin/mailbox check: exits inside its budget, process start to exit, with a slow board and a hung gh', async () => {
  seedSingleNode()
  watchSessionPr('7')
  const heartbeatAt = new Date(Date.now() - 15 * 60_000).toISOString()
  const own = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = 'sess-bin'
  try {
    writeDeadLock(999_999_999, heartbeatAt)
  } finally {
    process.env.CLAUDE_CODE_SESSION_ID = own
  }
  process.env.AI_WORKFLOW_APP_BIN = writeAnswersStub(
    tmpDir,
    JSON.stringify([{ id: 'item-1', type: 'question', response: 'ship it' }]),
    undefined,
    1
  )
  const budgetMs = 25_000
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    NODE_NO_WARNINGS: '1',
    PATH: `${fakeGhDir}:${process.env.PATH ?? ''}`,
    GH_SLEEP_SECS: '60',
    MAILBOX_CHECK_BUDGET_MS: String(budgetMs),
  }
  delete env.CLAUDE_CODE_SESSION_ID
  const startedAt = Date.now()
  const child = spawn(binMailbox, ['check', '--session', 'sess-bin'], { env, detached: true })
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  const exit = new Promise<number | null>((resolve) => child.on('close', resolve))

  try {
    const status = await exit
    const elapsedMs = Date.now() - startedAt

    assert.equal(status, 0)
    assert.equal(
      stdout,
      '[dashboard] item item-1 (question): ship it\n' +
        '    → act on it, then consume it: `dashboard item consume --item item-1 --session node-1`\n' +
        `${deadMonitorLine(999_999_999, heartbeatAt)}\n`
    )
    assert.ok(elapsedMs < budgetMs, `the check ran ${elapsedMs}ms, past its ${budgetMs}ms budget`)
    assert.ok(elapsedMs > 12_000, `the check ran ${elapsedMs}ms: it never waited on the hung gh`)
  } finally {
    try {
      process.kill(-(child.pid as number), 'SIGKILL')
    } catch {
      // the group is already gone
    }
  }
})
