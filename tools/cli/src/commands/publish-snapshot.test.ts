import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { stderrBeyondNodeWarnings } from '../testing/subprocess-stderr.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))
const createdDirs: string[] = []
const IDENTITY = 'Release Maintainer <release@example.invalid>'

// Every child, git and the CLI alike, reads this global config and no system config, so the host's own
// never reaches a test.
const globalConfig = (lines: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-snapshot-gitconfig-'))
  createdDirs.push(dir)
  const path = join(dir, 'gitconfig')
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}
const GLOBAL_EXCLUDES = join(dirname(globalConfig([])), 'excludes')
writeFileSync(GLOBAL_EXCLUDES, 'kept.bak\n')
const GLOBAL_CONFIG = globalConfig([
  '[core]',
  `\texcludesFile = ${GLOBAL_EXCLUDES}`,
  '[user]',
  '\tname = Global Maintainer',
  '\temail = global@example.invalid',
  '[commit]',
  '\tgpgsign = false',
  '[tag]',
  '\tgpgsign = false',
])
process.env.GIT_CONFIG_GLOBAL = GLOBAL_CONFIG
process.env.GIT_CONFIG_NOSYSTEM = '1'

after(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('publishes the export set as one commit with a version tag', () => {
  const { src, target } = makeWorld()

  const result = publishSnapshot(src, target)

  assertPublished(result, target, { published: true, version: '1.2.3' })
  const main = git(target, 'rev-parse', 'main').trim()
  assert.deepEqual(targetLog(target), [`${IDENTITY}|${IDENTITY}|release: v1.2.3`])
  assert.deepEqual(targetTree(target), exportSetTree(src))
  const paths = targetTree(target).map((line) => line.split('\t')[1])
  assert.equal(paths.includes('.private-terms.json'), false)
  assert.equal(paths.includes('CHANGELOG.md'), false)
  assert.equal(git(target, 'rev-parse', 'v1.2.3^{commit}').trim(), main)
})

test('publishing the same release again changes nothing', () => {
  const { src, target } = makeWorld()

  assertPublished(publishSnapshot(src, target), target, { published: true, version: '1.2.3' })
  const again = publishSnapshot(src, target)

  assertPublished(again, target, { published: false, version: '1.2.3' })
  assert.equal(targetLog(target).length, 1)
})

test('a later release adds one commit and drops files gone from the export set', () => {
  const { src, target } = makeWorld()
  assertPublished(publishSnapshot(src, target), target, { published: true, version: '1.2.3' })

  git(src, 'rm', '-q', 'README.md')
  writeFileSync(join(src, 'NEW.md'), 'New file.\n')
  writeFileSync(join(src, '.claude-plugin/plugin.json'), pluginJson('1.2.4'))
  commitAll(src, 'next release')
  git(src, 'tag', 'claude-workflow-v1.2.4')
  git(src, 'push', '-q', 'origin', 'HEAD:main', 'claude-workflow-v1.2.4')

  const result = publishSnapshot(src, target)

  assertPublished(result, target, { published: true, version: '1.2.4' })
  assert.deepEqual(
    targetLog(target).map((line) => line.split('|')[2]),
    ['release: v1.2.4', 'release: v1.2.3']
  )
  assert.deepEqual(targetTree(target), exportSetTree(src))
  const paths = targetTree(target).map((line) => line.split('\t')[1])
  assert.equal(paths.includes('README.md'), false)
  assert.equal(paths.includes('NEW.md'), true)
})

test('publishes to main when the target defaults to another branch holding the same tree', () => {
  const { src, target } = makeWorld()
  targetWithOtherDefault(src, target)
  const stale = addStaleMain(target)
  const other = git(target, 'rev-parse', 'other').trim()

  const result = publishSnapshot(src, target)

  assertPublished(result, target, { published: true, version: '1.2.3' })
  assert.deepEqual(targetTree(target), exportSetTree(src))
  assert.equal(git(target, 'rev-parse', 'main^').trim(), stale)
  assert.equal(git(target, 'rev-parse', 'other').trim(), other)
})

test('starts main as a root commit when the target holds only another branch', () => {
  const { src, target } = makeWorld()
  targetWithOtherDefault(src, target)
  const other = git(target, 'rev-parse', 'other').trim()

  const result = publishSnapshot(src, target)

  assertPublished(result, target, { published: true, version: '1.2.3' })
  assert.equal(git(target, 'rev-list', '--parents', '-n', '1', 'main').trim().split(' ').length, 1)
  assert.equal(git(target, 'rev-parse', 'other').trim(), other)
})

test('publishes a release whose tag is annotated', () => {
  const { src, target } = makeWorld()
  git(src, 'tag', '-d', 'claude-workflow-v1.2.3')
  git(src, 'tag', '-a', '-m', 'release', 'claude-workflow-v1.2.3')

  assertPublished(publishSnapshot(src, target), target, { published: true, version: '1.2.3' })
})

test('refuses when publish-check reports anything and pushes nothing', () => {
  const { src, target } = makeWorld({ 'README.md': 'This is a seed private phrase here.\n' })

  const result = publishSnapshot(src, target)

  assert.equal(result.status, 1)
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    findings: [
      { class: 'personal-wording', path: 'README.md', line: 1, match: 'seed private phrase' },
    ],
  })
  assert.equal(
    stderrBeyondNodeWarnings(result.stderr),
    'personal-wording README.md:1 seed private phrase'
  )
  assert.notEqual(
    spawnSync('git', ['-C', target, 'rev-parse', '--verify', '--quiet', 'main']).status,
    0
  )
})

test('refuses when HEAD is not the tip of origin/main', () => {
  const { src, target } = makeWorld()
  const tip = git(src, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(src, 'README.md'), 'Changed.\n')
  commitAll(src, 'unpushed')
  const head = git(src, 'rev-parse', 'HEAD').trim()

  const result = publishSnapshot(src, target)

  assertRefused(result, `HEAD ${head} is not the tip of origin/main (${tip})`)
  assertTargetEmpty(target)
})

test('refuses a dirty working tree', () => {
  const { src, target } = makeWorld()
  writeFileSync(join(src, 'README.md'), 'Edited, not committed.\n')

  const result = publishSnapshot(src, target)

  assertRefused(result, 'the working tree has uncommitted changes')
  assertTargetEmpty(target)
})

test('refuses when HEAD has no release tag for its version', () => {
  const { src, target } = makeWorld()
  writeFileSync(join(src, '.claude-plugin/plugin.json'), pluginJson('1.2.5'))
  commitAll(src, 'bump without tag')
  git(src, 'push', '-q', 'origin', 'HEAD:main')

  const result = publishSnapshot(src, target)

  assertRefused(result, 'no release tag claude-workflow-v1.2.5')
  assertTargetEmpty(target)
})

test('refuses a release tag that names another commit', () => {
  const { src, target } = makeWorld()
  const tagged = git(src, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(src, 'README.md'), 'Later change.\n')
  commitAll(src, 'later')
  git(src, 'push', '-q', 'origin', 'HEAD:main')
  const head = git(src, 'rev-parse', 'HEAD').trim()

  const result = publishSnapshot(src, target)

  assertRefused(result, `release tag claude-workflow-v1.2.3 names ${tagged}, not HEAD ${head}`)
  assertTargetEmpty(target)
})

test("refuses a target that is the source's own origin", () => {
  const { src, origin } = makeWorld()
  const before = git(origin, 'rev-parse', 'main').trim()

  const result = publishSnapshot(src, origin)

  assertRefused(result, OWN_ORIGIN)
  assert.equal(git(origin, 'rev-parse', 'main').trim(), before)
})

test('refuses the origin spelled with a trailing slash', () => {
  const { src, origin } = makeWorld()
  const before = git(origin, 'rev-parse', 'main').trim()

  const result = publishSnapshot(src, `${origin}/`)

  assertRefused(result, OWN_ORIGIN)
  assert.equal(git(origin, 'rev-parse', 'main').trim(), before)
})

test('refuses a GitHub spelling of the origin however its scheme and case differ', () => {
  const { src } = makeWorld()
  git(src, 'remote', 'set-url', 'origin', 'https://github.com/seedorg/source.git')

  const result = publishSnapshot(src, 'git@github.com:SeedOrg/Source.git', {}, 'seedorg/other')

  assertRefused(result, "seedorg/other is this repository's own origin")
})

test('refuses the origin spelled as a file:// url', () => {
  const { src, origin } = makeWorld()
  const before = git(origin, 'rev-parse', 'main').trim()

  const result = publishSnapshot(src, `file://${origin}`)

  assertRefused(result, OWN_ORIGIN)
  assert.equal(git(origin, 'rev-parse', 'main').trim(), before)
})

test('refuses the source repository itself as the target', () => {
  const { src, origin } = makeWorld()
  const before = git(origin, 'rev-parse', 'main').trim()
  const srcHead = git(src, 'rev-parse', 'HEAD').trim()

  const result = publishSnapshot(src, src)

  assertRefused(result, OWN_ORIGIN)
  assert.equal(git(origin, 'rev-parse', 'main').trim(), before)
  assert.equal(git(src, 'rev-parse', 'HEAD').trim(), srcHead)
})

test("refuses a copy of the origin at another path because it holds the source's history", () => {
  const { src, origin } = makeWorld()
  const copy = join(makeDir('publish-snapshot-copy-'), 'copy.git')
  execFileSync('git', ['clone', '-q', '--bare', origin, copy])
  const before = git(copy, 'rev-parse', 'main').trim()

  const result = publishSnapshot(src, copy)

  assertRefused(result, "seedorg/snapshot already holds this repository's history")
  assert.equal(git(copy, 'rev-parse', 'main').trim(), before)
})

test('publishes exported files that a gitignore rule or the global excludes file matches', () => {
  const { src, target } = makeWorld()
  writeFileSync(join(src, '.gitignore'), '*.local\n')
  writeFileSync(join(src, 'notes.local'), 'Tracked despite the ignore rule.\n')
  writeFileSync(join(src, 'kept.bak'), 'Tracked despite the global excludes.\n')
  writeFileSync(join(src, '.claude-plugin/plugin.json'), pluginJson('1.2.4'))
  git(src, 'add', '-A')
  git(src, 'add', '-f', 'notes.local', 'kept.bak')
  commitAll(src, 'ignored but tracked')
  git(src, 'tag', 'claude-workflow-v1.2.4')
  git(src, 'push', '-q', 'origin', 'HEAD:main', 'claude-workflow-v1.2.4')

  const result = publishSnapshot(src, target)

  assertPublished(result, target, { published: true, version: '1.2.4' })
  assert.deepEqual(targetTree(target), exportSetTree(src))
  const paths = targetTree(target).map((line) => line.split('\t')[1])
  assert.equal(paths.includes('notes.local'), true)
  assert.equal(paths.includes('kept.bak'), true)
})

test('refuses when no committer identity is configured', () => {
  const { src, target } = makeWorld()
  git(src, 'config', '--unset', 'user.name')
  git(src, 'config', '--unset', 'user.email')

  const result = publishSnapshot(src, target, {
    GIT_CONFIG_GLOBAL: globalConfig(['[commit]', '\tgpgsign = false']),
  })

  assertRefused(result, 'no user.name configured')
  assertTargetEmpty(target)
})

test('refuses a --to that is not owner/name', () => {
  const { src, target } = makeWorld()

  const result = publishSnapshot(src, target, {}, 'seedorg')

  assertRefused(result, '--to must be owner/name, got seedorg')
})

const publishSnapshot = (
  src: string,
  url: string,
  env: Record<string, string> = {},
  to = 'seedorg/snapshot'
) =>
  spawnSync(
    process.execPath,
    [
      '--experimental-transform-types',
      mainTsPath,
      'publish-snapshot',
      '--repo',
      src,
      '--to',
      to,
      '--url',
      url,
    ],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env } }
  )

// origin: a bare repo. src: a clone of it holding the tagged baseline release, pushed. target: an
// empty bare repo standing in for the snapshot repo. The source's own origin URL is a bare path,
// so the snapshot URL passed with --url never equals it by accident.
const makeWorld = (overrides: Record<string, string | null> = {}) => {
  const origin = makeDir('publish-snapshot-origin-')
  git(origin, 'init', '-q', '--bare', '--initial-branch=main')
  const target = makeDir('publish-snapshot-target-')
  git(target, 'init', '-q', '--bare', '--initial-branch=main')

  const src = makeDir('publish-snapshot-src-')
  git(src, 'init', '-q', '--initial-branch=main')
  git(src, 'remote', 'add', 'origin', origin)
  git(src, 'config', 'user.name', 'Release Maintainer')
  git(src, 'config', 'user.email', 'release@example.invalid')
  for (const [path, content] of Object.entries({ ...baselineFiles(), ...overrides })) {
    if (content === null) {
      continue
    }
    mkdirSync(dirname(join(src, path)), { recursive: true })
    writeFileSync(join(src, path), content)
  }
  commitAll(src, 'seed')
  git(src, 'tag', 'claude-workflow-v1.2.3')
  git(src, 'push', '-q', 'origin', 'HEAD:main', 'claude-workflow-v1.2.3')
  git(src, 'fetch', '-q', 'origin')

  return { origin, src, target }
}

const makeDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

// Leaves the target's default branch as `other`, holding the export set (published once through a
// scratch repo).
const targetWithOtherDefault = (src: string, target: string): void => {
  const scratch = makeDir('publish-snapshot-scratch-')
  git(scratch, 'init', '-q', '--bare', '--initial-branch=main')
  assert.equal(publishSnapshot(src, scratch).status, 0)
  git(scratch, 'push', '-q', target, 'main:refs/heads/other')
  git(target, 'symbolic-ref', 'HEAD', 'refs/heads/other')
}

// Makes the target's `main` a stale empty commit and returns its sha.
const addStaleMain = (target: string): string => {
  const emptyTree = git(target, 'hash-object', '-t', 'tree', '-w', '/dev/null').trim()
  const stale = git(target, 'commit-tree', '-m', 'stale', emptyTree).trim()
  git(target, 'update-ref', 'refs/heads/main', stale)
  return stale
}

const assertPublished = (
  result: { status: number | null; stdout: string; stderr: string },
  target: string,
  expected: { published: boolean; version: string }
): void => {
  assert.equal(result.status, 0)
  assert.equal(
    result.stdout,
    JSON.stringify({
      ok: true,
      published: expected.published,
      to: 'seedorg/snapshot',
      version: expected.version,
      commit: git(target, 'rev-parse', 'main').trim(),
    }) + '\n'
  )
  assert.equal(stderrBeyondNodeWarnings(result.stderr), '')
}

const OWN_ORIGIN = "seedorg/snapshot is this repository's own origin"

const assertRefused = (
  result: { status: number | null; stdout: string; stderr: string },
  reason: string
): void => {
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(stderrBeyondNodeWarnings(result.stderr), `publish-snapshot: refused: ${reason}`)
}

const assertTargetEmpty = (target: string): void => {
  assert.notEqual(
    spawnSync('git', ['-C', target, 'rev-parse', '--verify', '--quiet', 'main']).status,
    0
  )
}

const exportSetTree = (src: string): string[] => {
  const exported = execFileSync('sh', ['-c', 'git archive HEAD | tar -t'], {
    cwd: src,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((path) => path.length > 0 && !path.endsWith('/'))
  const exportedPaths = new Set(exported)

  return git(src, 'ls-tree', '-r', 'HEAD')
    .split('\n')
    .filter((line) => line.length > 0 && exportedPaths.has(line.split('\t')[1]))
}

const targetTree = (target: string): string[] =>
  git(target, 'ls-tree', '-r', 'main')
    .split('\n')
    .filter((line) => line.length > 0)

const targetLog = (target: string): string[] =>
  git(target, 'log', '--format=%an <%ae>|%cn <%ce>|%s', 'main')
    .split('\n')
    .filter((line) => line.length > 0)

const commitAll = (repo: string, message: string): void => {
  git(repo, 'add', '-A')
  git(
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-q',
    '-m',
    message
  )
}

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

const pluginJson = (version: string): string =>
  JSON.stringify({ license: 'GPL-3.0-or-later', version }) + '\n'

const manifest = (extra: Record<string, unknown>): string =>
  JSON.stringify({ license: 'GPL-3.0-or-later', ...extra }) + '\n'

const baselineFiles = (): Record<string, string> => ({
  LICENSE: 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n',
  'package.json': manifest({}),
  'tools/cli/package.json': manifest({ dependencies: { 'left-pad': '1.0.0' } }),
  '.claude-plugin/plugin.json': pluginJson('1.2.3'),
  '.claude-plugin/marketplace.json':
    JSON.stringify({ plugins: [{ license: 'GPL-3.0-or-later' }] }) + '\n',
  'THIRD-PARTY-NOTICES.md':
    '| Package | Licence | Source |\n|---|---|---|\n| `left-pad` | MIT | https://example.invalid |\n',
  'README.md': 'Nothing to see here.\n',
  'CHANGELOG.md': 'Released by seedhandle\n',
  '.gitattributes': '.private-terms.json export-ignore\nCHANGELOG.md export-ignore\n',
  '.private-terms.json':
    JSON.stringify({
      handles: ['seedhandle'],
      privateRepos: ['seedorg/seedrepo'],
      privateHosts: ['tracker.seed.invalid'],
      phrases: ['seed private phrase'],
    }) + '\n',
})
