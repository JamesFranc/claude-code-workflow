import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRequestedExitCode } from '../runtime-exit-code.ts'
import { grantTrust, readConfig, runWorkspaceTrustEnsure } from './main.ts'
import type { ConfigIO } from './main.ts'

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  })
}

type Fixture = {
  launchDir: string
  repo: string
  worktree: string
  configPath: string
  cleanup: () => void
}

const makeFixture = (): Fixture => {
  const launchDir = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-trust-')))
  const repo = join(launchDir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q')
  writeFileSync(join(repo, 'file.txt'), 'x\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'worktree', 'add', '-q', '.worktrees/wt', '-b', 'wt')

  const configDir = join(launchDir, 'config')
  mkdirSync(configDir)
  const configPath = join(configDir, '.claude.json')
  writeFileSync(
    configPath,
    JSON.stringify(
      { numStartups: 7, projects: { '/somewhere/else': { hasTrustDialogAccepted: true } } },
      null,
      2
    )
  )

  const previousCwd = process.cwd()
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.chdir(launchDir)
  process.env.CLAUDE_CONFIG_DIR = configDir

  return {
    launchDir,
    repo,
    worktree: join(repo, '.worktrees', 'wt'),
    configPath,
    cleanup: () => {
      process.chdir(previousCwd)
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      rmSync(launchDir, { recursive: true, force: true })
    },
  }
}

const readProjects = (configPath: string): Record<string, { hasTrustDialogAccepted?: boolean }> =>
  JSON.parse(readFileSync(configPath, 'utf8')).projects

test('trusts a repo root beneath the launch dir', () => {
  const f = makeFixture()
  try {
    runWorkspaceTrustEnsure(f.repo)
    assert.equal(readProjects(f.configPath)[f.repo]?.hasTrustDialogAccepted, true)
  } finally {
    f.cleanup()
  }
})

test('a worktree path resolves to the MAIN repo root key, not the worktree path', () => {
  const f = makeFixture()
  try {
    runWorkspaceTrustEnsure(f.worktree)
    const projects = readProjects(f.configPath)
    assert.equal(projects[f.repo]?.hasTrustDialogAccepted, true)
    assert.equal(projects[f.worktree], undefined)
  } finally {
    f.cleanup()
  }
})

test('refuses a repo root outside the launch dir and writes nothing', () => {
  const f = makeFixture()
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-trust-outside-')))
  try {
    const before = readFileSync(f.configPath, 'utf8')
    runWorkspaceTrustEnsure(outside)
    assert.equal(readFileSync(f.configPath, 'utf8'), before)
  } finally {
    rmSync(outside, { recursive: true, force: true })
    f.cleanup()
  }
})

test('the launch dir itself is inside the guard', () => {
  const f = makeFixture()
  try {
    runWorkspaceTrustEnsure(f.launchDir)
    assert.equal(readProjects(f.configPath)[f.launchDir]?.hasTrustDialogAccepted, true)
  } finally {
    f.cleanup()
  }
})

test('already-trusted is a no-op — the file is byte-identical', () => {
  const f = makeFixture()
  try {
    runWorkspaceTrustEnsure(f.repo)
    const afterFirst = readFileSync(f.configPath, 'utf8')
    runWorkspaceTrustEnsure(f.repo)
    assert.equal(readFileSync(f.configPath, 'utf8'), afterFirst)
  } finally {
    f.cleanup()
  }
})

test('unrelated config keys survive the write', () => {
  const f = makeFixture()
  try {
    runWorkspaceTrustEnsure(f.repo)
    const config = JSON.parse(readFileSync(f.configPath, 'utf8'))
    assert.equal(config.numStartups, 7)
    assert.equal(config.projects['/somewhere/else'].hasTrustDialogAccepted, true)
  } finally {
    f.cleanup()
  }
})

test('a non-repo directory under the launch dir keys off its own path', () => {
  const f = makeFixture()
  const plain = join(f.launchDir, 'plain')
  mkdirSync(plain)
  try {
    runWorkspaceTrustEnsure(plain)
    assert.equal(readProjects(f.configPath)[plain]?.hasTrustDialogAccepted, true)
  } finally {
    f.cleanup()
  }
})

// A sibling directory whose name is a lexical prefix match (not a path-segment match) of the launch
// dir must not be treated as inside it — the `/a/b` vs `/a/bc` separator trap `isWithin`'s
// `sep`-aware startsWith check guards against.
test('a sibling directory sharing a path prefix is not treated as inside (separator trap)', () => {
  const outerDir = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-trust-sep-')))
  const launchDir = join(outerDir, 'ab')
  const sibling = join(outerDir, 'abc')
  mkdirSync(launchDir)
  mkdirSync(sibling)

  const configDir = join(outerDir, 'config')
  mkdirSync(configDir)
  const configPath = join(configDir, '.claude.json')
  writeFileSync(configPath, '{"projects":{}}\n')

  const previousCwd = process.cwd()
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.chdir(launchDir)
  process.env.CLAUDE_CONFIG_DIR = configDir
  try {
    runWorkspaceTrustEnsure(sibling)
    assert.equal(readProjects(configPath)[sibling], undefined)
    assert.equal(getRequestedExitCode(), 1)
  } finally {
    process.chdir(previousCwd)
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    rmSync(outerDir, { recursive: true, force: true })
  }
})

// `setRequestedExitCode(0)` on the trusted path is invisible to a single fresh-process CLI
// invocation, since a process that never errors already exits 0 by default. It is only observable
// by checking that the exit-code module state actually flips back to 0 after a PRIOR call left it
// at a non-zero value — proving the call sets it, rather than the value happening to already be 0.
test('exit code reflects the most recent outcome, not a stale one', () => {
  const f = makeFixture()
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-trust-outside-')))
  try {
    runWorkspaceTrustEnsure(outside)
    assert.equal(getRequestedExitCode(), 1)
    runWorkspaceTrustEnsure(f.repo)
    assert.equal(getRequestedExitCode(), 0)
  } finally {
    rmSync(outside, { recursive: true, force: true })
    f.cleanup()
  }
})

// An unresolvable repo path must never fall back to a lexical stand-in — a symlink or a
// not-yet-created path lexically nested under the launch dir would then pass the launch-dir guard
// without ever being confirmed to point where it claims to.
test('an unresolvable repo path is refused, not silently coerced to a lexical path', () => {
  const f = makeFixture()
  const missing = join(f.launchDir, 'does-not-exist')
  try {
    runWorkspaceTrustEnsure(missing)
    assert.equal(getRequestedExitCode(), 1)
    assert.equal(readProjects(f.configPath)[missing], undefined)
  } finally {
    f.cleanup()
  }
})

// Malformed JSON must be reported, never silently treated as an empty config — that would let the
// next write clobber whatever was actually on disk.
test('malformed JSON in the config is reported as failed, not silently replaced', () => {
  const f = makeFixture()
  try {
    writeFileSync(f.configPath, '{ this is not json')
    runWorkspaceTrustEnsure(f.repo)
    assert.equal(getRequestedExitCode(), 2)
    assert.equal(readFileSync(f.configPath, 'utf8'), '{ this is not json')
  } finally {
    f.cleanup()
  }
})

// A config that parses but isn't a JSON object (e.g. an array) must be reported, not silently
// coerced into an empty object that the next write would then clobber.
test('a non-object config is reported as failed, not silently coerced', () => {
  const f = makeFixture()
  const arrayConfig = JSON.stringify(['not', 'an', 'object'])
  try {
    writeFileSync(f.configPath, arrayConfig)
    runWorkspaceTrustEnsure(f.repo)
    assert.equal(getRequestedExitCode(), 2)
    assert.equal(readFileSync(f.configPath, 'utf8'), arrayConfig)
  } finally {
    f.cleanup()
  }
})

// A write that never lands on disk must never be reported as `trusted`. `grantTrust` is exercised
// directly here (not through the CLI) so a write that silently no-ops can be injected without
// faking the filesystem.
test('a write that never lands is retried once, then throws rather than reporting success', () => {
  const f = makeFixture()
  let writeCalls = 0
  const io: ConfigIO = {
    read: (path) => {
      const raw = readFileSync(path, 'utf8')
      return { raw, parsed: JSON.parse(raw) }
    },
    write: () => {
      writeCalls++
    },
  }
  try {
    assert.throws(() => grantTrust(f.repo, io), /did not survive a retry/)
    assert.equal(writeCalls, 2)
    assert.equal(readProjects(f.configPath)[f.repo], undefined)
  } finally {
    f.cleanup()
  }
})

// The retry must not be a no-op ritual — a write that lands only on the second attempt must still
// report `trusted`.
test('a write that lands only on retry still reports trusted', () => {
  const f = makeFixture()
  let writeCalls = 0
  const io: ConfigIO = {
    read: (path) => {
      const raw = readFileSync(path, 'utf8')
      return { raw, parsed: JSON.parse(raw) }
    },
    write: (path, content) => {
      writeCalls++
      if (writeCalls === 2) writeFileSync(path, content)
    },
  }
  try {
    const action = grantTrust(f.repo, io)
    assert.equal(action, 'trusted')
    assert.equal(writeCalls, 2)
    assert.equal(readProjects(f.configPath)[f.repo]?.hasTrustDialogAccepted, true)
  } finally {
    f.cleanup()
  }
})

// The write must never discard a concurrent writer's data. A config with `numStartups: 2` and an
// unrelated project's trust entry; an external write lands after our FIRST read (reverting
// `numStartups` and adding a second unrelated project directly to the REAL file, so every later read
// — including our own eventual write's verification — reflects it). Our SECOND read (the pre-write
// comparison in `prepareWrite`) must see the mismatch, retry from a fresh read, and build its write
// onto that fresh data — so both unrelated projects and the reverted `numStartups` survive alongside
// our own key. Before this fix, `grantTrust` built its write from the stale first read, silently
// overwriting the concurrent change; `trustEntrySet` couldn't catch it because it only checks
// whether OUR key is present.
test('an external write landing between read and write is detected — its data survives alongside our key', () => {
  const f = makeFixture()
  const before = { numStartups: 2, projects: { '/other-repo': { hasTrustDialogAccepted: true } } }
  writeFileSync(f.configPath, JSON.stringify(before))
  const concurrent = {
    numStartups: 1,
    projects: {
      '/other-repo': { hasTrustDialogAccepted: true },
      '/another-repo': { hasTrustDialogAccepted: true },
    },
  }
  try {
    let reads = 0
    const io: ConfigIO = {
      read: (path) => {
        reads++
        // The concurrent write lands exactly at our second read (the pre-write comparison) — write
        // it to the REAL file so every read from here on, including our own later verification,
        // reflects it, the same as a real external writer would.
        if (reads === 2) writeFileSync(path, JSON.stringify(concurrent))
        const raw = readFileSync(path, 'utf8')
        return { raw, parsed: JSON.parse(raw) }
      },
      write: (path, content) => writeFileSync(path, content),
    }
    const action = grantTrust(f.repo, io)
    assert.equal(action, 'trusted')
    const final = JSON.parse(readFileSync(f.configPath, 'utf8'))
    assert.equal(final.numStartups, 1)
    assert.equal(final.projects['/other-repo']?.hasTrustDialogAccepted, true)
    assert.equal(final.projects['/another-repo']?.hasTrustDialogAccepted, true)
    assert.equal(final.projects[f.repo]?.hasTrustDialogAccepted, true)
  } finally {
    f.cleanup()
  }
})

// The concurrency retry is bounded — a writer that changes the file on every single read must never
// spin forever, and must never fall through to an actual write (a clobber) once the bound is hit.
test('a config that changes on every read exhausts the bounded retry and reports failed, not a clobber', () => {
  const f = makeFixture()
  try {
    let reads = 0
    let writes = 0
    const io: ConfigIO = {
      read: () => {
        reads++
        const parsed = { projects: {}, generation: reads }
        return { raw: JSON.stringify(parsed), parsed }
      },
      write: () => {
        writes++
      },
    }
    assert.throws(() => grantTrust(f.repo, io), /changed concurrently/)
    assert.equal(writes, 0)
  } finally {
    f.cleanup()
  }
})

// grantTrust's OUTER retry must write onto its OWN fresh `prepareWrite` call, not the first
// attempt's snapshot — using the first attempt's `prepared` for the retry's write would reintroduce
// the stale-snapshot bug even though the retry's own `prepareWrite` correctly saw fresh data. The
// first write is lost AND an external write lands in the same window (call 1); the second write
// persists normally (call 2). Deliberately no read-count sentinel — that's what made the prior
// version of this test brittle to internal restructuring; call count on `write` is fine, since
// exactly two write attempts is part of grantTrust's own public contract, not an implementation
// detail.
test("the retry writes onto its own fresh prepareWrite, not the first attempt's stale snapshot", () => {
  const f = makeFixture()
  const external = {
    numStartups: 99,
    projects: { '/external-repo': { hasTrustDialogAccepted: true } },
  }
  let writeCalls = 0
  const io: ConfigIO = {
    read: (path) => {
      const raw = readFileSync(path, 'utf8')
      return { raw, parsed: JSON.parse(raw) }
    },
    write: (path, content) => {
      writeCalls++
      if (writeCalls === 1) {
        // Our own write is lost, and an external write lands in the very same window.
        writeFileSync(path, JSON.stringify(external))
      } else {
        writeFileSync(path, content)
      }
    },
  }
  try {
    const action = grantTrust(f.repo, io)
    assert.equal(action, 'trusted')
    assert.equal(writeCalls, 2)
    const final = JSON.parse(readFileSync(f.configPath, 'utf8'))
    assert.equal(final.numStartups, 99)
    assert.equal(final.projects['/external-repo']?.hasTrustDialogAccepted, true)
    assert.equal(final.projects[f.repo]?.hasTrustDialogAccepted, true)
  } finally {
    f.cleanup()
  }
})

// The write must preserve OTHER fields already on the SAME project entry, not just entries for
// OTHER projects (the "unrelated config keys survive the write" test above only covers the
// latter). Claude Code project entries carry fields beyond hasTrustDialogAccepted (allowedTools,
// mcpServers, history, …); overwriting the whole entry instead of merging onto it would silently
// wipe them.
test('other fields on the same project entry survive the write', () => {
  const f = makeFixture()
  try {
    const before = JSON.parse(readFileSync(f.configPath, 'utf8'))
    writeFileSync(
      f.configPath,
      JSON.stringify({
        ...before,
        projects: { ...before.projects, [f.repo]: { otherField: 'keep-me' } },
      })
    )
    runWorkspaceTrustEnsure(f.repo)
    const after = JSON.parse(readFileSync(f.configPath, 'utf8'))
    assert.equal(after.projects[f.repo].otherField, 'keep-me')
    assert.equal(after.projects[f.repo].hasTrustDialogAccepted, true)
  } finally {
    f.cleanup()
  }
})

// A missing config file (fresh machine — Claude Code has never run there) must be treated as an
// empty config, not an error. No other test in this file omits pre-writing the config file.
test('a missing config file (fresh machine) is treated as empty, not an error', () => {
  const launchDir = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-trust-fresh-')))
  const repo = join(launchDir, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['-C', repo, 'init', '-q'])
  const configDir = join(launchDir, 'config')
  mkdirSync(configDir)
  const configPath = join(configDir, '.claude.json')

  const previousCwd = process.cwd()
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.chdir(launchDir)
  process.env.CLAUDE_CONFIG_DIR = configDir
  try {
    runWorkspaceTrustEnsure(repo)
    assert.equal(getRequestedExitCode(), 0)
    assert.equal(readProjects(configPath)[repo]?.hasTrustDialogAccepted, true)
  } finally {
    process.chdir(previousCwd)
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    rmSync(launchDir, { recursive: true, force: true })
  }
})

// A `projects` map that parses but is the wrong shape (a string, here) must be reported, not
// silently discarded by asRecord's `{}` coercion and overwritten with a plausible-looking `trusted`
// result — that would destroy every other project's trust entry in the file.
test('a non-object "projects" value is reported as failed, not silently discarded', () => {
  const f = makeFixture()
  const badConfig = JSON.stringify({ projects: 'i am not an object' })
  try {
    writeFileSync(f.configPath, badConfig)
    runWorkspaceTrustEnsure(f.repo)
    assert.equal(getRequestedExitCode(), 2)
    assert.equal(readFileSync(f.configPath, 'utf8'), badConfig)
  } finally {
    f.cleanup()
  }
})

// Same failure mode, an array `projects` instead of a string.
test('an array "projects" value is reported as failed, not silently discarded', () => {
  const f = makeFixture()
  const badConfig = JSON.stringify({ projects: ['not', 'an', 'object'] })
  try {
    writeFileSync(f.configPath, badConfig)
    runWorkspaceTrustEnsure(f.repo)
    assert.equal(getRequestedExitCode(), 2)
    assert.equal(readFileSync(f.configPath, 'utf8'), badConfig)
  } finally {
    f.cleanup()
  }
})

// Same failure mode one level down — a non-object entry at the TARGET repo's own key.
test('a non-object entry at the target project key is reported as failed, not silently discarded', () => {
  const f = makeFixture()
  const badConfig = JSON.stringify({ projects: { [f.repo]: 'i am not an object either' } })
  try {
    writeFileSync(f.configPath, badConfig)
    runWorkspaceTrustEnsure(f.repo)
    assert.equal(getRequestedExitCode(), 2)
    assert.equal(readFileSync(f.configPath, 'utf8'), badConfig)
  } finally {
    f.cleanup()
  }
})

// A single JSON.parse failure is ambiguous between genuine corruption and a bare read racing a
// concurrent, non-atomic rewrite of this file (a torn read). readConfig's `readFile` param is a
// seam for exactly this: the file itself is fine (real fs, real fixture) — only the injected read
// function's FIRST call returns torn content, its second call reads the real file for real.
test('readConfig recovers from a transient parse failure on retry', () => {
  const f = makeFixture()
  try {
    let reads = 0
    const readFile = (path: string): string => {
      reads++
      if (reads === 1) return '{ "numStartups": 7, "projects": '
      return readFileSync(path, 'utf8')
    }
    const result = readConfig(f.configPath, readFile)
    assert.equal(reads, 2)
    assert.equal(result.parsed.numStartups, 7)
  } finally {
    f.cleanup()
  }
})

// The retry is bounded at exactly one extra attempt — not zero (no retry at all) and not more (an
// unbounded retry loop). A read function that fails every time must still throw, after exactly 2
// calls.
test('readConfig throws after exactly two failed attempts, not one and not unbounded', () => {
  const f = makeFixture()
  try {
    let reads = 0
    const readFile = (): string => {
      reads++
      return '{ still not json'
    }
    assert.throws(() => readConfig(f.configPath, readFile), /is not valid JSON/)
    assert.equal(reads, 2)
  } finally {
    f.cleanup()
  }
})
