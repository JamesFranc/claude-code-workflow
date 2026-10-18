// Real-subprocess coverage for the signal-abort path (review-standards Rule 14): a shutdown signal
// must match bash's trap semantics exactly — the currently in-flight gh call is allowed to finish,
// but nothing that would come after it (another gh call, an event, a state write) ever runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI_MAIN = join(import.meta.dirname, '..', 'main.ts')
const FAKE_BIN = join(import.meta.dirname, 'characterization', 'fake-bin')

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const POLL_DEADLINE_MS = 30_000

const PR_ITEM = {
  number: 42,
  title: 'chore(deps): bump foo',
  url: 'https://github.com/acme/repo/pull/42',
  repository: { nameWithOwner: 'acme/repo' },
}

const MERGEABLE_PR_DETAILS = {
  number: 42,
  title: 'chore(deps): bump foo',
  url: 'https://github.com/acme/repo/pull/42',
  headRefName: 'renovate/foo-1.x',
  headRefOid: 'deadbeef',
  mergeStateStatus: 'CLEAN',
  mergeable: 'MERGEABLE',
  baseRefName: 'main',
  statusCheckRollup: [],
  reviewDecision: '',
  body: '',
}

// Waits until `predicate(readFileSync(path))` is true, polling — used to know a specific gh call
// has been logged (and so is genuinely in flight, mid-`sleep`, inside fake-bin/gh) before this test
// delivers its signal.
const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + POLL_DEADLINE_MS
  while (!predicate() && Date.now() < deadline) {
    await sleepMs(20)
  }
  assert.ok(predicate(), 'precondition: the awaited condition was reached in time')
}

// Polls until `done()` holds or the child exits, bounded by POLL_DEADLINE_MS. It never asserts:
// whatever ends the wait — the condition, the child exiting for any reason, or the deadline —
// falls through to the caller's own assertions.
const waitUntilOrExit = async (child: ChildProcess, done: () => boolean): Promise<void> => {
  const deadline = Date.now() + POLL_DEADLINE_MS
  while (!done() && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await sleepMs(20)
  }
}

const readGhLogText = (ghLogPath: string): string =>
  existsSync(ghLogPath) ? readFileSync(ghLogPath, 'utf-8') : ''

// fake-bin/gh logs one JSON array of argv per line (e.g. ["pr","view","42",...]) — never the
// space-joined string the rule matcher works against.
const ghLogHasCall = (ghLogPath: string, ...argvPrefix: string[]): boolean =>
  readGhLogText(ghLogPath).includes(argvPrefix.map((a) => `"${a}"`).join(','))

test('a single-pid SIGTERM during `gh pr view` stops before approve/merge and exits 0', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'renovate-signal-test-'))
  try {
    const rulesPath = join(homeDir, 'rules.json')
    const ghLogPath = join(homeDir, 'gh.log')
    const stateFile = join(homeDir, 'state.json')
    writeFileSync(
      rulesPath,
      JSON.stringify([
        { match: 'search prs', stdout: [PR_ITEM] },
        { match: '\\.isArchived', stdout: { isArchived: false } },
        { match: 'pr view 42 .*number,title,url', stdout: MERGEABLE_PR_DETAILS, delaySeconds: 1 },
      ])
    )
    const env = {
      ...process.env,
      HOME: homeDir,
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      FAKE_GH_RULES: rulesPath,
      FAKE_GH_LOG: ghLogPath,
      RENOVATE_MONITOR_AUTHOR: 'app/renovate',
      RENOVATE_MONITOR_SCOPE: 'acme/*',
      RENOVATE_MONITOR_STATE_FILE: stateFile,
    }

    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', CLI_MAIN, 'renovate-pr-monitor', '--once'],
      { env }
    )
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })

    await waitFor(() => ghLogHasCall(ghLogPath, 'pr', 'view', '42'))
    child.kill('SIGTERM')

    const exit = await new Promise<number | null>((resolve) => child.on('close', resolve))

    assert.equal(exit, 0, `expected exit 0, got stdout: ${stdout}`)
    assert.match(stdout, /\[monitor\] received shutdown signal; exiting/)
    assert.equal(ghLogHasCall(ghLogPath, 'pr', 'review'), false, 'no approve call after the abort')
    assert.equal(ghLogHasCall(ghLogPath, 'pr', 'merge'), false, 'no merge call after the abort')
    assert.doesNotMatch(
      stdout,
      /\[tick\] acme\/repo#42 —/,
      'no classification line after the abort'
    )
    const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as { prs: Record<string, unknown> }
    assert.deepEqual(state.prs, {}, 'no state entry recorded for the PR after the abort')
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('a process-group SIGTERM during `gh pr merge` emits no event, marks no agentBusy, and exits 0', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'renovate-signal-test-'))
  try {
    const rulesPath = join(homeDir, 'rules.json')
    const ghLogPath = join(homeDir, 'gh.log')
    const stateFile = join(homeDir, 'state.json')
    writeFileSync(
      rulesPath,
      JSON.stringify([
        { match: 'search prs', stdout: [PR_ITEM] },
        { match: '\\.isArchived', stdout: { isArchived: false } },
        { match: 'pr view 42 .*number,title,url', stdout: MERGEABLE_PR_DETAILS },
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
        { match: 'pr merge', stdout: 'merged\n', delaySeconds: 1 },
      ])
    )
    const env = {
      ...process.env,
      HOME: homeDir,
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      FAKE_GH_RULES: rulesPath,
      FAKE_GH_LOG: ghLogPath,
      RENOVATE_MONITOR_AUTHOR: 'app/renovate',
      RENOVATE_MONITOR_SCOPE: 'acme/*',
      RENOVATE_MONITOR_STATE_FILE: stateFile,
    }

    // detached: true makes this child its own process-group leader (pid === pgid), so signalling
    // -pid reaches it and every descendant it spawns (the fake gh script), the same way a real
    // `kill -TERM -$PGID` would.
    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', CLI_MAIN, 'renovate-pr-monitor', '--once'],
      { env, detached: true }
    )
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })

    await waitFor(() => ghLogHasCall(ghLogPath, 'pr', 'merge'))
    process.kill(-child.pid!, 'SIGTERM')

    const exit = await new Promise<number | null>((resolve) => child.on('close', resolve))

    assert.equal(exit, 0, `expected exit 0, got stdout: ${stdout}`)
    assert.match(stdout, /\[monitor\] received shutdown signal; exiting/)
    assert.doesNotMatch(stdout, /"event":/, 'no event was emitted')
    const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as {
      prs: Record<string, { agentBusy?: boolean }>
    }
    assert.equal(state.prs['acme/repo#42']?.agentBusy, undefined, 'no agentBusy write')
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

// RENOVATE_MONITOR_HOLD_RELAX_HOURS carries its raw, possibly zero-padded digit strings
// (config.ts's holdRelaxStartRaw/EndRaw) into the startup banner untouched — never reformatted
// through Number, which would print "22-6" instead of "22-06".
test('the startup banner prints hold-relax hours raw, zero-padding preserved', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'renovate-signal-test-'))
  try {
    const rulesPath = join(homeDir, 'rules.json')
    writeFileSync(rulesPath, JSON.stringify([{ match: 'search prs', stdout: [] }]))
    const env = {
      ...process.env,
      HOME: homeDir,
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      FAKE_GH_RULES: rulesPath,
      FAKE_GH_LOG: join(homeDir, 'gh.log'),
      RENOVATE_MONITOR_AUTHOR: 'app/renovate',
      RENOVATE_MONITOR_SCOPE: 'acme/*',
      RENOVATE_MONITOR_STATE_FILE: join(homeDir, 'state.json'),
      RENOVATE_MONITOR_HOLD_FOR_HUMAN_PRS: 'true',
      RENOVATE_MONITOR_HOLD_RELAX_HOURS: '22-06',
    }

    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', CLI_MAIN, 'renovate-pr-monitor', '--once'],
      { env }
    )
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })

    const exit = await new Promise<number | null>((resolve) => child.on('close', resolve))

    assert.equal(exit, 0, `expected exit 0, got stdout: ${stdout}`)
    assert.match(stdout, /\[monitor\] hold relaxed during 22:00-06:00 /)
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

const PR_43_ITEM = {
  number: 43,
  title: 'chore(deps): bump bar',
  url: 'https://github.com/acme/repo/pull/43',
  repository: { nameWithOwner: 'acme/repo' },
}

const AGENT_BUSY_PR_43_DETAILS = {
  ...MERGEABLE_PR_DETAILS,
  number: 43,
  url: 'https://github.com/acme/repo/pull/43',
  headRefOid: 'cafef00d',
}

test('an escalated PR does not hold back all-done', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'renovate-signal-test-'))
  try {
    const rulesPath = join(homeDir, 'rules.json')
    const ghLogPath = join(homeDir, 'gh.log')
    const stateFile = join(homeDir, 'state.json')
    writeFileSync(
      rulesPath,
      JSON.stringify([
        { match: 'search prs', stdout: [PR_ITEM, PR_43_ITEM], once: true },
        { match: 'search prs', stdout: [PR_43_ITEM] },
        { match: '\\.isArchived', stdout: { isArchived: false } },
        { match: 'pr view 42 .*number,title,url', stdout: MERGEABLE_PR_DETAILS },
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
        { match: 'pr merge', stdout: 'merged\n' },
        { match: 'pr view 43 .*number,title,url', stdout: AGENT_BUSY_PR_43_DETAILS },
      ])
    )
    writeFileSync(
      stateFile,
      JSON.stringify({
        prs: {
          'acme/repo#43': { agentBusy: true, agentStartedAt: new Date().toISOString() },
        },
      })
    )
    const env = {
      ...process.env,
      HOME: homeDir,
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      FAKE_GH_RULES: rulesPath,
      FAKE_GH_LOG: ghLogPath,
      RENOVATE_MONITOR_AUTHOR: 'app/renovate',
      RENOVATE_MONITOR_SCOPE: 'acme/*',
      RENOVATE_MONITOR_STATE_FILE: stateFile,
      RENOVATE_MONITOR_POLL_SECONDS: '1',
      RENOVATE_MONITOR_MERGE_DELAY_SECONDS: '0',
    }

    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', CLI_MAIN, 'renovate-pr-monitor'],
      { env }
    )
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })

    const deadline = Date.now() + POLL_DEADLINE_MS
    const watchdog = setInterval(() => {
      if (Date.now() > deadline) {
        child.kill('SIGKILL')
      }
    }, 100)
    const exit = await new Promise<number | null>((resolve) => child.on('close', resolve))
    clearInterval(watchdog)

    assert.equal(exit, 0, `expected exit 0, got stdout: ${stdout}`)
    assert.match(stdout, /"event": "all-done"/)
    assert.match(stdout, /"held": \[\s*"acme\/repo#43"\s*\]/)
    const exitLine = stdout.split('\n').find((l) => l.startsWith('Monitor exiting:'))
    assert.equal(
      exitLine,
      'Monitor exiting: all-done — 1 action(s) completed across this session (1 PR(s) held).'
    )
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('an incomplete search does not produce all-done though nothing else is pending', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'renovate-signal-test-'))
  try {
    const rulesPath = join(homeDir, 'rules.json')
    const ghLogPath = join(homeDir, 'gh.log')
    const stateFile = join(homeDir, 'state.json')
    writeFileSync(
      rulesPath,
      JSON.stringify([
        { match: 'search prs', stdout: [PR_ITEM], once: true },
        { match: '\\.isArchived', stdout: { isArchived: false } },
        { match: 'pr view 42 .*number,title,url', stdout: MERGEABLE_PR_DETAILS },
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
        { match: 'pr merge', stdout: 'merged\n' },
        // Every tick after the first merge finds the search scope failing but still parseable —
        // an incomplete search, forever, with nothing else pending.
        { match: 'search prs', stdout: [], exit: 1, stderr: 'HTTP 500\n' },
      ])
    )
    const env = {
      ...process.env,
      HOME: homeDir,
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      FAKE_GH_RULES: rulesPath,
      FAKE_GH_LOG: ghLogPath,
      RENOVATE_MONITOR_AUTHOR: 'app/renovate',
      RENOVATE_MONITOR_SCOPE: 'acme/*',
      RENOVATE_MONITOR_STATE_FILE: stateFile,
      RENOVATE_MONITOR_POLL_SECONDS: '1',
      RENOVATE_MONITOR_MERGE_DELAY_SECONDS: '0',
    }

    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', CLI_MAIN, 'renovate-pr-monitor'],
      { env }
    )
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    const exitPromise = new Promise<number | null>((resolve) => child.on('close', resolve))

    // Wait for several ticks past the merge — an all-done gate that ignored search incompleteness
    // would fire on the first of them and exit the process instead.
    await waitUntilOrExit(
      child,
      () => (stdout.match(/\[tick\] search incomplete/g) ?? []).length >= 2
    )
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    const exit = await exitPromise

    assert.equal(exit, null, `expected the loop to still be running, got stdout: ${stdout}`)
    assert.doesNotMatch(stdout, /"event": "all-done"/)
    const incompleteTicks = stdout.match(/\[tick\] search incomplete/g) ?? []
    assert.ok(
      incompleteTicks.length >= 2,
      `expected multiple incomplete-search ticks, got stdout: ${stdout}`
    )
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('a blocked PR that clears then re-blocks on the same head gets a fresh blockedSince', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'renovate-signal-test-'))
  try {
    const rulesPath = join(homeDir, 'rules.json')
    const ghLogPath = join(homeDir, 'gh.log')
    const stateFile = join(homeDir, 'state.json')
    const env = {
      ...process.env,
      HOME: homeDir,
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      FAKE_GH_RULES: rulesPath,
      FAKE_GH_LOG: ghLogPath,
      RENOVATE_MONITOR_AUTHOR: 'app/renovate',
      RENOVATE_MONITOR_SCOPE: 'acme/*',
      RENOVATE_MONITOR_STATE_FILE: stateFile,
    }

    // headRefOid stays 'deadbeef' across all three ticks — only the check rollup changes, so any
    // blockedSince reset must come from the classification, never from a head change.
    const runOnceTick = (rollup: unknown[]): Promise<void> => {
      writeFileSync(
        rulesPath,
        JSON.stringify([
          { match: 'search prs', stdout: [PR_ITEM] },
          { match: '\\.isArchived', stdout: { isArchived: false } },
          {
            match: 'pr view 42 .*number,title,url',
            stdout: {
              ...MERGEABLE_PR_DETAILS,
              mergeStateStatus: 'BLOCKED',
              reviewDecision: '',
              statusCheckRollup: rollup,
            },
          },
        ])
      )
      rmSync(ghLogPath, { force: true })
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--experimental-transform-types', CLI_MAIN, 'renovate-pr-monitor', '--once'],
          { env }
        )
        let stderr = ''
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk)
        })
        child.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`tick exited ${code}: ${stderr}`))
          }
        })
      })
    }

    const readBlockedSince = (): string | undefined => {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8')) as {
        prs: Record<string, { blockedSince?: string }>
      }
      return state.prs['acme/repo#42']?.blockedSince
    }

    await runOnceTick([])
    const blockedSince1 = readBlockedSince()
    assert.ok(blockedSince1, 'the first blocked tick sets blockedSince')

    await sleepMs(1100)
    await runOnceTick([
      { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: '' },
    ])
    assert.equal(readBlockedSince(), undefined, 'a non-blocked tick clears blockedSince')

    await sleepMs(1100)
    await runOnceTick([])
    const blockedSince3 = readBlockedSince()
    assert.ok(blockedSince3, 'the second blocked tick sets a fresh blockedSince')
    assert.notEqual(
      blockedSince3,
      blockedSince1,
      'blockedSince restarts rather than keeping the stale timestamp'
    )
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('a search that fails outright does not produce all-done though nothing else is pending', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'renovate-signal-test-'))
  try {
    const rulesPath = join(homeDir, 'rules.json')
    const ghLogPath = join(homeDir, 'gh.log')
    const stateFile = join(homeDir, 'state.json')
    writeFileSync(
      rulesPath,
      JSON.stringify([
        { match: 'search prs', stdout: [PR_ITEM], once: true },
        { match: '\\.isArchived', stdout: { isArchived: false } },
        { match: 'pr view 42 .*number,title,url', stdout: MERGEABLE_PR_DETAILS },
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
        { match: 'pr merge', stdout: 'merged\n' },
        // Every tick after the first merge finds the search failing outright — no stdout at all,
        // not even parseable-but-incomplete JSON.
        { match: 'search prs', exit: 1, stderr: 'HTTP 502\n' },
      ])
    )
    const env = {
      ...process.env,
      HOME: homeDir,
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      FAKE_GH_RULES: rulesPath,
      FAKE_GH_LOG: ghLogPath,
      RENOVATE_MONITOR_AUTHOR: 'app/renovate',
      RENOVATE_MONITOR_SCOPE: 'acme/*',
      RENOVATE_MONITOR_STATE_FILE: stateFile,
      RENOVATE_MONITOR_POLL_SECONDS: '1',
      RENOVATE_MONITOR_MERGE_DELAY_SECONDS: '0',
    }

    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', CLI_MAIN, 'renovate-pr-monitor'],
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
    const exitPromise = new Promise<number | null>((resolve) => child.on('close', resolve))

    // Wait for several ticks past the merge — an all-done gate that ignored a fully-failed search
    // would fire on the first of them and exit the process instead.
    await waitUntilOrExit(
      child,
      () => (stderr.match(/\[tick\] gh search failed:/g) ?? []).length >= 2
    )
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    const exit = await exitPromise

    assert.equal(exit, null, `expected the loop to still be running, got stdout: ${stdout}`)
    assert.doesNotMatch(stdout, /"event": "all-done"/)
    const failedTicks = stderr.match(/\[tick\] gh search failed:/g) ?? []
    assert.ok(
      failedTicks.length >= 2,
      `expected multiple failed-search ticks, got stderr: ${stderr}`
    )
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

test('a PR whose `gh pr view` keeps failing does not produce all-done though nothing else is pending', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'renovate-signal-test-'))
  try {
    const rulesPath = join(homeDir, 'rules.json')
    const ghLogPath = join(homeDir, 'gh.log')
    const stateFile = join(homeDir, 'state.json')
    writeFileSync(
      rulesPath,
      JSON.stringify([
        { match: 'search prs', stdout: [PR_ITEM], once: true },
        { match: '\\.isArchived', stdout: { isArchived: false } },
        { match: 'pr view 42 .*number,title,url', stdout: MERGEABLE_PR_DETAILS, once: true },
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
        { match: 'pr merge', stdout: 'merged\n' },
        // Every tick after the first merge still finds the PR in an otherwise-complete search, but
        // `gh pr view` on it now fails outright (a transient 5xx), forever.
        { match: 'search prs', stdout: [PR_ITEM] },
        { match: 'pr view 42 .*number,title,url', exit: 1, stderr: 'HTTP 502\n' },
      ])
    )
    const env = {
      ...process.env,
      HOME: homeDir,
      PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      FAKE_GH_RULES: rulesPath,
      FAKE_GH_LOG: ghLogPath,
      RENOVATE_MONITOR_AUTHOR: 'app/renovate',
      RENOVATE_MONITOR_SCOPE: 'acme/*',
      RENOVATE_MONITOR_STATE_FILE: stateFile,
      RENOVATE_MONITOR_POLL_SECONDS: '1',
      RENOVATE_MONITOR_MERGE_DELAY_SECONDS: '0',
    }

    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', CLI_MAIN, 'renovate-pr-monitor'],
      { env }
    )
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    const exitPromise = new Promise<number | null>((resolve) => child.on('close', resolve))

    // Wait for several ticks past the merge — an all-done gate that ignored the PR's failed view
    // would fire on the first of them and exit the process instead.
    await waitUntilOrExit(
      child,
      () => (stdout.match(/gh pr view failed; skipping/g) ?? []).length >= 2
    )
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    const exit = await exitPromise

    assert.equal(exit, null, `expected the loop to still be running, got stdout: ${stdout}`)
    assert.doesNotMatch(stdout, /"event": "all-done"/)
    const failedViews = stdout.match(/gh pr view failed; skipping/g) ?? []
    assert.ok(failedViews.length >= 2, `expected multiple failed-view ticks, got stdout: ${stdout}`)
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})
