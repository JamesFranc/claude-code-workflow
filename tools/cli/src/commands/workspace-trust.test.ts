import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EnsureAction } from '../workspace-trust/main.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

const runCli = (
  args: string[],
  options: { cwd?: string; configDir?: string; home?: string } = {}
): { stdout: string; stderr: string; status: number | null } => {
  const env = { ...process.env }
  if (options.home !== undefined) {
    delete env.CLAUDE_CONFIG_DIR
    env.HOME = options.home
  } else if (options.configDir !== undefined) {
    env.CLAUDE_CONFIG_DIR = options.configDir
  }
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, ...args],
    { encoding: 'utf8', cwd: options.cwd, env }
  )
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

test('CLI: workspace-trust ensure is registered and takes --repo', () => {
  const { stdout } = runCli(['workspace-trust', 'ensure', '--help'])
  assert.match(stdout, /--repo/)
})

// The outcome × channel grid. Every action this command can report is checked against all three
// channels a caller can observe (the stdout JSON `action` field, the stderr marker line, and the
// process exit code), so no cell in the matrix goes unverified. `GRID` is typed as
// `Record<EnsureAction, GridCase>` (not an array), so a fifth action added to `EnsureAction` fails to
// compile here rather than going silently untested.
type GridCase = {
  expectedExitCode: number
  expectedMarker: string
  // Substring the stderr line's tail (after "<action> — ") must contain. Pins the
  // `output.reason ?? output.repoRoot` fallback in `formatStderrLine`: trusted/already-trusted have
  // no `reason`, so the tail falls back to `repoRoot`; refused/failed always carry a `reason`.
  expectedTail: string
  arrange: () => { launchDir: string; repoArg: string; configDir: string; extraCleanup?: string }
}

const GRID: Record<EnsureAction, GridCase> = {
  trusted: {
    expectedExitCode: 0,
    expectedMarker: '✓',
    expectedTail: 'repo',
    arrange: () => {
      const launchDir = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-trust-grid-trusted-')))
      const repo = join(launchDir, 'repo')
      const configDir = join(launchDir, 'config')
      mkdirSync(repo)
      mkdirSync(configDir)
      execFileSync('git', ['-C', repo, 'init', '-q'])
      writeFileSync(join(configDir, '.claude.json'), '{}\n')
      return { launchDir, repoArg: repo, configDir }
    },
  },
  'already-trusted': {
    expectedExitCode: 0,
    expectedMarker: '·',
    expectedTail: 'repo',
    arrange: () => {
      const launchDir = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-trust-grid-already-')))
      const repo = join(launchDir, 'repo')
      const configDir = join(launchDir, 'config')
      mkdirSync(repo)
      mkdirSync(configDir)
      execFileSync('git', ['-C', repo, 'init', '-q'])
      writeFileSync(
        join(configDir, '.claude.json'),
        JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } })
      )
      return { launchDir, repoArg: repo, configDir }
    },
  },
  refused: {
    expectedExitCode: 1,
    expectedMarker: '✗',
    expectedTail: 'outside the directory this command was invoked from',
    arrange: () => {
      const launchDir = realpathSync(
        mkdtempSync(join(tmpdir(), 'workspace-trust-grid-refused-in-'))
      )
      const outside = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-trust-grid-refused-out-')))
      const configDir = join(launchDir, 'config')
      mkdirSync(configDir)
      writeFileSync(join(configDir, '.claude.json'), '{}\n')
      return { launchDir, repoArg: outside, configDir, extraCleanup: outside }
    },
  },
  failed: {
    expectedExitCode: 2,
    expectedMarker: '‼',
    expectedTail: 'is not valid JSON',
    arrange: () => {
      const launchDir = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-trust-grid-failed-')))
      const repo = join(launchDir, 'repo')
      const configDir = join(launchDir, 'config')
      mkdirSync(repo)
      mkdirSync(configDir)
      execFileSync('git', ['-C', repo, 'init', '-q'])
      writeFileSync(join(configDir, '.claude.json'), '{ not valid json')
      return { launchDir, repoArg: repo, configDir }
    },
  },
}

for (const [outcome, { expectedExitCode, expectedMarker, expectedTail, arrange }] of Object.entries(
  GRID
)) {
  test(`CLI: ${outcome} reports action, stderr marker+tail, and exit code ${expectedExitCode}`, () => {
    const { launchDir, repoArg, configDir, extraCleanup } = arrange()
    try {
      const { stdout, stderr, status } = runCli(['workspace-trust', 'ensure', '--repo', repoArg], {
        cwd: launchDir,
        configDir,
      })
      assert.match(stdout, new RegExp(`"action":"${outcome}"`))
      assert.match(stderr, new RegExp(`^${expectedMarker} workspace-trust: ${outcome} — `, 'm'))
      assert.ok(
        stderr.includes(expectedTail),
        `expected stderr to contain "${expectedTail}", got: ${stderr}`
      )
      assert.equal(status, expectedExitCode)
    } finally {
      rmSync(launchDir, { recursive: true, force: true })
      if (extraCleanup !== undefined) rmSync(extraCleanup, { recursive: true, force: true })
    }
  })
}

test('CLI: a repo outside the launch dir writes nothing to the config', () => {
  const launchDir = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-trust-cli-in-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-trust-cli-out-')))
  const configDir = join(launchDir, 'config')
  mkdirSync(configDir)
  writeFileSync(join(configDir, '.claude.json'), '{}\n')
  try {
    runCli(['workspace-trust', 'ensure', '--repo', outside], { cwd: launchDir, configDir })
    assert.equal(
      JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')).projects,
      undefined
    )
  } finally {
    rmSync(launchDir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('CLI: a real invocation trusts the repo root and exits 0', () => {
  const launchDir = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-trust-cli-')))
  const repo = join(launchDir, 'repo')
  const configDir = join(launchDir, 'config')
  mkdirSync(repo)
  mkdirSync(configDir)
  execFileSync('git', ['-C', repo, 'init', '-q'])
  writeFileSync(join(configDir, '.claude.json'), '{}\n')
  try {
    const { stderr, status } = runCli(['workspace-trust', 'ensure', '--repo', repo], {
      cwd: launchDir,
      configDir,
    })
    assert.doesNotMatch(stderr, /No flag registered/)
    assert.equal(status, 0)
    const config = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8'))
    assert.equal(config.projects[repo].hasTrustDialogAccepted, true)
  } finally {
    rmSync(launchDir, { recursive: true, force: true })
  }
})

// Pins the `--repo` default: no test above ever omits the flag, so a mutation replacing
// `process.cwd()` with a sentinel default would pass every other test in this file.
test('CLI: omitting --repo trusts the current directory', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-trust-default-')))
  const configDir = mkdtempSync(join(tmpdir(), 'workspace-trust-default-config-'))
  execFileSync('git', ['-C', repo, 'init', '-q'])
  writeFileSync(join(configDir, '.claude.json'), '{}\n')
  try {
    const { stdout, status } = runCli(['workspace-trust', 'ensure'], { cwd: repo, configDir })
    assert.equal(status, 0)
    assert.match(stdout, /"action":"trusted"/)
    const config = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8'))
    assert.equal(config.projects[repo]?.hasTrustDialogAccepted, true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  }
})

// Every other test in this file sets CLAUDE_CONFIG_DIR, so the tested branch of
// `globalConfigPath` is the test-only one and the production fallback (`?? homedir()`) is
// unpinned. `os.homedir()` reads $HOME on POSIX, so overriding HOME exercises the real fallback
// path without ever touching the real ~/.claude.json.
test('CLI: without CLAUDE_CONFIG_DIR, falls back to $HOME/.claude.json', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-trust-home-')))
  const repo = join(home, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['-C', repo, 'init', '-q'])
  try {
    const { stdout, status } = runCli(['workspace-trust', 'ensure', '--repo', repo], {
      cwd: home,
      home,
    })
    assert.equal(status, 0)
    assert.match(stdout, /"action":"trusted"/)
    const config = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    assert.equal(config.projects[repo]?.hasTrustDialogAccepted, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
