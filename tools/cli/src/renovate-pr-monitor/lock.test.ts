import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renovateLockPath } from './lock.ts'

const CLI_MAIN = join(import.meta.dirname, '..', 'main.ts')
const FAKE_BIN = join(import.meta.dirname, 'characterization', 'fake-bin')

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const LOCK_POLL_DEADLINE_MS = 30_000

const spawnCli = (
  env: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', CLI_MAIN, 'renovate-pr-monitor', ...args],
      { env }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })

// Computed under the same HOME/session a child process uses, so it names the exact lock file that
// process will claim — never actually run in this process.
const lockPathFor = (homeDir: string, sessionId: string): string => {
  const origHome = process.env.HOME
  const origSessionId = process.env.CLAUDE_CODE_SESSION_ID
  process.env.HOME = homeDir
  process.env.CLAUDE_CODE_SESSION_ID = sessionId
  const lockPath = renovateLockPath()
  if (origHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = origHome
  }
  if (origSessionId === undefined) {
    delete process.env.CLAUDE_CODE_SESSION_ID
  } else {
    process.env.CLAUDE_CODE_SESSION_ID = origSessionId
  }
  return lockPath
}

// Sets up a homeDir/session/fake-gh env, starts a real loop-mode holder against it, waits for the
// lock to actually be claimed, then hands the env and lock path to `fn` — one CLI process genuinely
// holding the lock, ready for a second real invocation to run against.
const withLiveLoop = async (
  fn: (ctx: {
    env: NodeJS.ProcessEnv
    lockPath: string
    holder: ReturnType<typeof spawn>
  }) => Promise<void>
): Promise<void> => {
  const homeDir = mkdtempSync(join(tmpdir(), 'renovate-lock-real-'))
  const sessionId = 'renovate-lock-real-test-session'
  try {
    const rulesPath = join(homeDir, 'rules.json')
    writeFileSync(rulesPath, JSON.stringify([{ match: 'search prs', stdout: [] }]))
    const env = {
      ...process.env,
      HOME: homeDir,
      CLAUDE_CODE_SESSION_ID: sessionId,
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      FAKE_GH_RULES: rulesPath,
      FAKE_GH_LOG: join(homeDir, 'gh.log'),
      RENOVATE_MONITOR_AUTHOR: 'app/renovate',
      RENOVATE_MONITOR_SCOPE: 'acme/*',
      RENOVATE_MONITOR_POLL_SECONDS: '300',
      RENOVATE_MONITOR_STATE_FILE: join(homeDir, 'state.json'),
    }

    const lockPath = lockPathFor(homeDir, sessionId)

    const holder = spawn(
      process.execPath,
      ['--experimental-transform-types', CLI_MAIN, 'renovate-pr-monitor'],
      { env }
    )
    let holderStdout = ''
    holder.stdout.on('data', (chunk) => {
      holderStdout += String(chunk)
    })
    try {
      const deadline = Date.now() + LOCK_POLL_DEADLINE_MS
      while (!existsSync(lockPath) && Date.now() < deadline) {
        await sleepMs(20)
      }
      assert.ok(existsSync(lockPath), 'precondition: the loop actually claimed the lock')
      assert.ok(holder.pid, 'precondition: the loop actually spawned with a pid')

      // Waits for the loop's last startup line so `fn` only ever runs against a process that has
      // fully started (past claimLock and signal-handler registration), not to sequence against any
      // particular heartbeat write — pr-monitor/lock.ts's writeLock is a temp-file-then-rename, so
      // the lock file below is never read mid-write, and heartbeatLockAt preserves the pid/startedAt
      // fields the tests below assert on regardless of how many heartbeats have landed.
      const bannerDeadline = Date.now() + LOCK_POLL_DEADLINE_MS
      while (!holderStdout.includes('[monitor] state=') && Date.now() < bannerDeadline) {
        await sleepMs(10)
      }
      assert.ok(
        holderStdout.includes('[monitor] state='),
        'precondition: the loop printed its startup banner'
      )

      await fn({ env, lockPath, holder })
    } finally {
      holder.kill('SIGKILL')
    }
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
}

// Runs the real CLI entrypoint (main.ts renovate-pr-monitor), in loop mode, against a fake `gh` that
// returns no PRs — exercising claimLock/the lock-refusal error message/exit code exactly as an
// operator's second concurrent invocation would, rather than calling claimLock directly and bypassing
// the command's own dispatch (review-standards Rule 14).
test('a second loop invocation is refused (exit 1) while the first genuinely holds the lock', async () => {
  await withLiveLoop(async ({ env, lockPath, holder }) => {
    const second = await spawnCli(env)

    assert.equal(second.code, 1, `second loop must exit 1, got stderr: ${second.stderr}`)
    const lockData = JSON.parse(readFileSync(lockPath, 'utf-8')) as {
      pid: number
      heartbeatAt: string
    }
    assert.equal(lockData.pid, holder.pid)
    const refusalLine = second.stderr.trimEnd().split('\n').at(-1)
    assert.equal(
      refusalLine,
      `[monitor] another renovate-pr-monitor loop is already running in this session (pid ${lockData.pid}, last heartbeat ${lockData.heartbeatAt}) — not starting a second`
    )
  })
})

test('--once proceeds beside a live loop, without trying to take its lock', async () => {
  await withLiveLoop(async ({ env, lockPath, holder }) => {
    const before = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number; startedAt: string }

    const once = await spawnCli(env, '--once')

    assert.equal(once.code, 0, `--once must exit 0 beside a live loop, got stderr: ${once.stderr}`)
    assert.doesNotMatch(once.stderr, /already running/)
    // pid and startedAt identify the holder and never change for its lifetime; heartbeatAt is
    // deliberately not compared here — the holder's own heartbeat interval can legitimately move
    // it, so asserting it would make this test race the holder's timer instead of --once.
    const after = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number; startedAt: string }
    assert.equal(after.pid, holder.pid, "--once must not replace the loop's lock holder")
    assert.equal(after.pid, before.pid, "--once must not replace the loop's lock holder")
    assert.equal(after.startedAt, before.startedAt, "--once must not touch the loop's lock file")
  })
})

test('a shutdown signal during the poll sleep releases the lock and exits 0', async () => {
  await withLiveLoop(async ({ lockPath, holder }) => {
    holder.kill('SIGTERM')

    const exit = await new Promise<number | null>((resolve) => holder.on('close', resolve))

    assert.equal(exit, 0, 'the loop must exit 0 on a shutdown signal')
    assert.equal(existsSync(lockPath), false, 'the lock file must be released on shutdown')
  })
})

// Unlike the shutdown-signal case above, an unhandled exception mid-tick (here: a `gh pr view`
// response that fails to parse as JSON) must leave the lock in place, its last heartbeat frozen, so
// scanMonitorDeaths can detect and report the death.
test('an unhandled crash mid-tick leaves the lock in place', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'renovate-lock-crash-'))
  const sessionId = 'renovate-lock-crash-test-session'
  try {
    const rulesPath = join(homeDir, 'rules.json')
    writeFileSync(
      rulesPath,
      JSON.stringify([
        {
          match: 'search prs',
          stdout: [
            {
              number: 42,
              title: 'chore(deps): bump foo',
              url: 'https://github.com/acme/repo/pull/42',
              repository: { nameWithOwner: 'acme/repo' },
            },
          ],
        },
        { match: '\\.isArchived', stdout: { isArchived: false } },
        { match: 'pr view 42', stdout: 'not valid json' },
      ])
    )
    const env = {
      ...process.env,
      HOME: homeDir,
      CLAUDE_CODE_SESSION_ID: sessionId,
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      FAKE_GH_RULES: rulesPath,
      FAKE_GH_LOG: join(homeDir, 'gh.log'),
      RENOVATE_MONITOR_AUTHOR: 'app/renovate',
      RENOVATE_MONITOR_SCOPE: 'acme/*',
      RENOVATE_MONITOR_POLL_SECONDS: '300',
      RENOVATE_MONITOR_STATE_FILE: join(homeDir, 'state.json'),
    }
    const lockPath = lockPathFor(homeDir, sessionId)

    const { code, stderr } = await spawnCli(env)

    assert.equal(code, 1, `a crash must exit 1, got stderr: ${stderr}`)
    assert.equal(existsSync(lockPath), true, 'the lock file must be left in place by a crash')
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('a shutdown signal mid-throttle-sleep aborts before the merge delay elapses, releasing the lock', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'renovate-throttle-abort-'))
  const sessionId = 'renovate-throttle-abort-test-session'
  try {
    const rulesPath = join(homeDir, 'rules.json')
    const ghLogPath = join(homeDir, 'gh.log')
    const stateFile = join(homeDir, 'state.json')
    const searchItem = (n: number) => ({
      number: n,
      title: `chore(deps): bump dep-${n}`,
      url: `https://github.com/acme/repo/pull/${n}`,
      repository: { nameWithOwner: 'acme/repo' },
    })
    const prDetails = (n: number) => ({
      number: n,
      title: `chore(deps): bump dep-${n}`,
      url: `https://github.com/acme/repo/pull/${n}`,
      headRefName: `renovate/dep-${n}-1.x`,
      headRefOid: 'deadbeef',
      mergeStateStatus: 'CLEAN',
      mergeable: 'MERGEABLE',
      baseRefName: 'main',
      statusCheckRollup: [],
      reviewDecision: '',
      body: '',
    })
    writeFileSync(
      rulesPath,
      JSON.stringify([
        { match: 'search prs', stdout: [searchItem(42), searchItem(43)] },
        { match: '\\.isArchived', stdout: { isArchived: false } },
        { match: 'pr view 42 .*number,title,url', stdout: prDetails(42) },
        { match: 'pr view 43 .*number,title,url', stdout: prDetails(43) },
        { match: '\\.headRefOid', stdout: 'deadbeef' },
        {
          match: 'squashMergeAllowed',
          stdout: {
            squashMergeAllowed: true,
            mergeCommitAllowed: false,
            rebaseMergeAllowed: false,
          },
        },
        { match: 'pr review --approve', stdout: '' },
        {
          match:
            'pr merge --squash --delete-branch --match-head-commit deadbeef --repo acme/repo 42',
          stdout: 'merged\n',
        },
      ])
    )
    const env = {
      ...process.env,
      HOME: homeDir,
      CLAUDE_CODE_SESSION_ID: sessionId,
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      FAKE_GH_RULES: rulesPath,
      FAKE_GH_LOG: ghLogPath,
      RENOVATE_MONITOR_AUTHOR: 'app/renovate',
      RENOVATE_MONITOR_SCOPE: 'acme/*',
      RENOVATE_MONITOR_POLL_SECONDS: '300',
      RENOVATE_MONITOR_STATE_FILE: stateFile,
      RENOVATE_MONITOR_MERGE_DELAY_SECONDS: '5',
    }
    const lockPath = lockPathFor(homeDir, sessionId)

    const holder = spawn(
      process.execPath,
      ['--experimental-transform-types', CLI_MAIN, 'renovate-pr-monitor'],
      { env }
    )
    let stdout = ''
    holder.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    try {
      const throttleDeadline = Date.now() + LOCK_POLL_DEADLINE_MS
      while (!stdout.includes('inter-merge delay') && Date.now() < throttleDeadline) {
        await sleepMs(20)
      }
      assert.ok(
        stdout.includes('inter-merge delay'),
        'precondition: mergeThrottle started sleeping before the second PR'
      )

      const signalledAt = Date.now()
      holder.kill('SIGTERM')

      const exit = await new Promise<number | null>((resolve) => holder.on('close', resolve))
      const elapsedMs = Date.now() - signalledAt

      assert.equal(exit, 0, `expected exit 0, got stdout: ${stdout}`)
      assert.ok(
        elapsedMs < 2000,
        `expected a prompt exit well under the 5s merge delay, took ${elapsedMs}ms`
      )
      assert.match(stdout, /\[monitor\] received shutdown signal; exiting/)
      assert.equal(existsSync(lockPath), false, 'the lock file must be released on shutdown')
      const ghLog = readFileSync(ghLogPath, 'utf-8')
      assert.equal(
        (ghLog.match(/"pr","merge"/g) ?? []).length,
        1,
        'only the first PR is merged before the abort'
      )
    } finally {
      holder.kill('SIGKILL')
    }
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})
