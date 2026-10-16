import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockPath } from '../pr-monitor/lock.ts'
import { renovateLockPath } from '../renovate-pr-monitor/lock.ts'
import { loadSelfReadyAt, loadWatched } from '../pr-monitor/state.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

const runCli = (
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  timeout = 30_000
): { stdout: string; stderr: string; status: number | null } => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'pr-monitor-flag-test', ...extraEnv },
      timeout,
    }
  )
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

test('CLI: pr-monitor registers --ack-comment (kebab), not --ackComment', () => {
  const { stdout } = runCli(['pr-monitor', '--help'])
  assert.match(stdout, /--ack-comment/)
  assert.doesNotMatch(stdout, /--ackComment/)
})

test('CLI: --ack-comment records the id and does not start a monitor', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'flow261-ack-comment-cli-'))
  try {
    const { stdout, stderr, status } = runCli(
      [
        'pr-monitor',
        '--ack-comment',
        'PRRC_test123',
        '--pr',
        '999999',
        '--repo',
        'nonexistent/repo',
      ],
      { HOME: homeDir }
    )
    assert.doesNotMatch(stderr, /No flag registered/)
    assert.equal(status, 0)
    assert.match(stdout, /Recorded PRRC_test123 as self-posted on nonexistent\/repo#999999/)
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

const readSelfReady = (homeDir: string, pr: string, repo: string): boolean => {
  const origHome = process.env.HOME
  const origSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.HOME = homeDir
  process.env.CLAUDE_CODE_SESSION_ID = 'pr-monitor-flag-test'
  try {
    return loadSelfReadyAt(pr, repo) !== undefined
  } finally {
    for (const [key, original] of [
      ['HOME', origHome],
      ['CLAUDE_CODE_SESSION_ID', origSession],
    ] as const) {
      if (original === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = original
      }
    }
  }
}

test('CLI: --ack-ready records the flip and does not start a monitor', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'flow281-ack-ready-cli-'))
  try {
    const { stdout, stderr, status } = runCli(
      ['pr-monitor', '--ack-ready', '--pr', '999999', '--repo', 'nonexistent/repo'],
      { HOME: homeDir, NODE_NO_WARNINGS: '1' }
    )
    assert.equal(stderr, '')
    assert.equal(status, 0)
    assert.equal(stdout, 'Recorded a self-initiated ready-for-review on nonexistent/repo#999999\n')
    assert.equal(readSelfReady(homeDir, '999999', 'nonexistent/repo'), true)
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('CLI: --ack-ready combined with --stop or --ack-comment is rejected and records nothing', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'flow281-ack-ready-conflict-'))
  try {
    for (const other of [['--stop'], ['--ack-comment', 'PRRC_test789']]) {
      const { stdout, stderr, status } = runCli(
        ['pr-monitor', '--ack-ready', ...other, '--pr', '999999', '--repo', 'nonexistent/repo'],
        { HOME: homeDir, NODE_NO_WARNINGS: '1' }
      )
      assert.equal(status, 1)
      assert.equal(stderr, '--ack-ready cannot be combined with --stop or --ack-comment\n')
      assert.equal(stdout, '')
      assert.equal(readSelfReady(homeDir, '999999', 'nonexistent/repo'), false)
    }
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('CLI: --ack-comment combined with --stop is rejected, not silently resolved either way', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'flow261-ack-stop-conflict-'))
  try {
    const { stdout, stderr, status } = runCli(
      [
        'pr-monitor',
        '--ack-comment',
        'PRRC_test456',
        '--stop',
        '--pr',
        '999999',
        '--repo',
        'nonexistent/repo',
      ],
      { HOME: homeDir, NODE_NO_WARNINGS: '1' }
    )
    assert.equal(status, 1)
    assert.equal(
      stderr,
      '--ack-comment and --stop cannot be combined — record the comment, or stop the monitor, not both\n'
    )
    assert.equal(stdout, '')
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

// Runs fn with HOME and the session id the CLI children see, so the in-process store readers and
// lockPath resolve the same files.
const withChildStore = <T>(homeDir: string, fn: () => T): T => {
  const origHome = process.env.HOME
  const origSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.HOME = homeDir
  process.env.CLAUDE_CODE_SESSION_ID = 'pr-monitor-flag-test'
  try {
    return fn()
  } finally {
    for (const [key, original] of [
      ['HOME', origHome],
      ['CLAUDE_CODE_SESSION_ID', origSession],
    ] as const) {
      if (original === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = original
      }
    }
  }
}

const watchingLine = (pr: string): string =>
  `Watching a/b#${pr}: the session check polls it every 3 minutes while the session is idle ` +
  `and wakes the session on a change. Stop with: pr-monitor --stop --pr ${pr} --repo a/b\n`

// A sleeper that is NOT this process's child (sh backgrounds it and exits), so the CLI's wait for
// the pid to exit is not held up by a zombie this process has not reaped.
const spawnOrphanSleeper = (): number => {
  const out = spawnSync('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' })
  const pid = Number(out.stdout.trim())
  assert.ok(Number.isInteger(pid) && pid > 0, 'precondition: orphan sleeper spawned with a pid')
  return pid
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const writeLiveLock = (path: string, pid: number): void => {
  const now = new Date().toISOString()
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify({ pid, startedAt: now, heartbeatAt: now }))
}

test('CLI: pr-monitor registers the PR and returns; --stop unregisters it', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'flow402-register-cli-'))
  const env = { HOME: homeDir, NODE_NO_WARNINGS: '1' }
  try {
    const registered = runCli(['pr-monitor', '--pr', '7', '--repo', 'a/b'], env)
    assert.deepEqual(registered, { stdout: watchingLine('7'), stderr: '', status: 0 })
    assert.deepEqual(
      withChildStore(homeDir, () => loadWatched().map((w) => w.prNumber)),
      ['7']
    )

    const stopped = runCli(['pr-monitor', '--stop', '--pr', '7', '--repo', 'a/b'], env)
    assert.deepEqual(stopped, { stdout: 'Stopped watching a/b#7\n', stderr: '', status: 0 })
    assert.deepEqual(
      withChildStore(homeDir, () => loadWatched()),
      []
    )

    const again = runCli(['pr-monitor', '--stop', '--pr', '7', '--repo', 'a/b'], env)
    assert.deepEqual(again, { stdout: 'a/b#7 was not watched\n', stderr: '', status: 0 })
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('CLI: registering removes a stale lock left by an older version', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'flow402-stale-lock-cli-'))
  try {
    const path = withChildStore(homeDir, () => lockPath('7', 'a/b'))
    mkdirSync(join(path, '..'), { recursive: true })
    const old = new Date(Date.now() - 3_600_000).toISOString()
    writeFileSync(path, JSON.stringify({ pid: 2147483646, startedAt: old, heartbeatAt: old }))
    const result = runCli(['pr-monitor', '--pr', '7', '--repo', 'a/b'], {
      HOME: homeDir,
      NODE_NO_WARNINGS: '1',
    })
    assert.deepEqual(result, { stdout: watchingLine('7'), stderr: '', status: 0 })
    assert.equal(existsSync(path), false)
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('CLI: registering stops every live monitor left by an older version in the session, not only the PR registered', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'flow402-two-legacy-cli-'))
  const pids = [spawnOrphanSleeper(), spawnOrphanSleeper(), spawnOrphanSleeper()]
  try {
    const [pathSeven, pathEight, renovatePath] = withChildStore(homeDir, () => [
      lockPath('7', 'a/b'),
      lockPath('8', 'a/b'),
      renovateLockPath(),
    ])
    writeLiveLock(pathSeven as string, pids[0] as number)
    writeLiveLock(pathEight as string, pids[1] as number)
    writeLiveLock(renovatePath as string, pids[2] as number)

    const result = runCli(['pr-monitor', '--pr', '9', '--repo', 'a/b'], {
      HOME: homeDir,
      NODE_NO_WARNINGS: '1',
    })

    assert.deepEqual(result, {
      stdout:
        watchingLine('9') +
        `Background monitor left by an older version: a#b#7.lock: stopped pid ${pids[0]}\n` +
        `Background monitor left by an older version: a#b#8.lock: stopped pid ${pids[1]}\n`,
      stderr: '',
      status: 0,
    })
    assert.equal(existsSync(pathSeven as string), false)
    assert.equal(existsSync(pathEight as string), false)
    assert.equal(isAlive(pids[0] as number), false)
    assert.equal(isAlive(pids[1] as number), false)
    assert.equal(existsSync(renovatePath as string), true)
    assert.equal(isAlive(pids[2] as number), true)
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already stopped
      }
    }
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('CLI: every mode exits 2 with the session-id message and no stack trace when there is no session id', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'flow402-no-session-cli-'))
  try {
    for (const mode of [[], ['--stop'], ['--ack-ready'], ['--ack-comment', 'PRRC_x']]) {
      const result = runCli(['pr-monitor', ...mode, '--pr', '7', '--repo', 'a/b'], {
        HOME: homeDir,
        NODE_NO_WARNINGS: '1',
        CLAUDE_CODE_SESSION_ID: undefined,
      })
      assert.deepEqual(result, {
        stdout: '',
        stderr:
          'pr-monitor: no session id: run this from a Claude Code session (CLAUDE_CODE_SESSION_ID is unset)\n',
        status: 2,
      })
    }
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})
