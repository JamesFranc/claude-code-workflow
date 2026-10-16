import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { stderrBeyondNodeWarnings } from '../testing/subprocess-stderr.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))
const createdDirs: string[] = []

after(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('publish-check passes a clean export set and skips excluded files', () => {
  const result = publishCheck(makeRepo({}))

  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, files: CLEAN_FILE_COUNT })
  assert.equal(stderrBeyondNodeWarnings(result.stderr), '')
})

test('publish-check reports a credential without echoing it', () => {
  const token = seedToken()
  const result = publishCheck(makeRepo({ 'README.md': `token ${token}\n` }))

  assert.equal(result.status, 1)
  assert.equal(result.stdout.includes(token) || result.stderr.includes(token), false)
  assert.deepEqual(findingsOf(result), [
    { class: 'credential', path: 'README.md', line: 1, match: 'ghp_… (40 characters)' },
  ])
  assert.equal(
    stderrBeyondNodeWarnings(result.stderr),
    'credential README.md:1 ghp_… (40 characters)'
  )
})

test('publish-check reports a personal handle in any case', () => {
  const result = publishCheck(makeRepo({ 'README.md': 'Written by SeedHandle.\n' }))

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'personal-handle', path: 'README.md', line: 1, match: 'SeedHandle' },
  ])
})

test('publish-check reports a home directory that names someone', () => {
  const result = publishCheck(makeRepo({ 'README.md': `${seedHome()}\n` }))

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    {
      class: 'home-directory',
      path: 'README.md',
      line: 1,
      match: ['', 'Users', 'alice'].join('/'),
    },
  ])
})

test('publish-check allows a placeholder home directory', () => {
  const result = publishCheck(makeRepo({ 'README.md': `${placeholderHome()}\n` }))

  assert.equal(result.status, 0)
})

test('publish-check reports a link on a private host or its subdomain', () => {
  const result = publishCheck(
    makeRepo({ 'README.md': 'See https://eu.tracker.seed.invalid/browse/X-1\n' })
  )

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'private-link', path: 'README.md', line: 1, match: 'eu.tracker.seed.invalid' },
  ])
})

test('publish-check reports a private repo name', () => {
  const result = publishCheck(makeRepo({ 'README.md': 'Clone seedorg/seedrepo.git first.\n' }))

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'private-repo', path: 'README.md', line: 1, match: 'seedorg/seedrepo' },
  ])
})

test('publish-check reports personal wording', () => {
  const result = publishCheck(makeRepo({ 'README.md': 'This is a seed private phrase here.\n' }))

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'personal-wording', path: 'README.md', line: 1, match: 'seed private phrase' },
  ])
})

test('publish-check reports a missing licence file', () => {
  const result = publishCheck(makeRepo({ LICENSE: null }))

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'missing-licence', path: 'LICENSE', match: 'no licence file' },
  ])
  assert.equal(stderrBeyondNodeWarnings(result.stderr), 'missing-licence LICENSE no licence file')
})

test('publish-check reports a manifest with another licence id', () => {
  const result = publishCheck(makeRepo({ '.claude-plugin/plugin.json': '{"license":"MIT"}\n' }))

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'missing-licence', path: '.claude-plugin/plugin.json', match: 'license: "MIT"' },
  ])
})

test('publish-check reports a runtime dependency with no notice', () => {
  const result = publishCheck(
    makeRepo({
      'tools/cli/package.json': manifest({
        dependencies: { 'left-pad': '1.0.0', 'right-pad': '1.0.0' },
      }),
    })
  )

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'missing-notice', path: 'THIRD-PARTY-NOTICES.md', match: 'right-pad' },
  ])
})

test('publish-check reports a missing notices file', () => {
  const result = publishCheck(makeRepo({ 'THIRD-PARTY-NOTICES.md': null }))

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'missing-notice', path: 'THIRD-PARTY-NOTICES.md', match: 'no notices file' },
  ])
})

test('publish-check reports a phrase wrapped across two lines at the line where it starts', () => {
  const result = publishCheck(
    makeRepo({ 'README.md': 'Intro.\nThis is a seed private\nphrase here.\n' })
  )

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'personal-wording', path: 'README.md', line: 2, match: 'seed private\nphrase' },
  ])
  assert.equal(
    stderrBeyondNodeWarnings(result.stderr),
    'personal-wording README.md:2 seed private phrase'
  )
})

test('publish-check reports a private term in a path name, with no line', () => {
  const result = publishCheck(makeRepo({ 'docs/seedhandle-notes.md': 'Nothing.\n' }))

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'personal-handle', path: 'docs/seedhandle-notes.md', match: 'seedhandle' },
  ])
})

test('publish-check prints a finding for a path with a newline on one stderr line', () => {
  const name = 'notes\nby seedhandle.md'
  const result = publishCheck(makeRepo({ [name]: 'Nothing.\n' }))

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'personal-handle', path: name, match: 'seedhandle' },
  ])
  assert.equal(
    stderrBeyondNodeWarnings(result.stderr),
    'personal-handle notes by seedhandle.md seedhandle'
  )
})

test('publish-check reports a private term in a symlink target, with no line', () => {
  const repo = makeRepo({})
  symlinkSync('../seedhandle-target', join(repo, 'shortcut'))
  commitAll(repo, 'link')
  const result = publishCheck(repo)

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'personal-handle', path: 'shortcut', match: 'seedhandle' },
  ])
})

test('publish-check scans a file holding a NUL byte, with no line', () => {
  const result = publishCheck(makeRepo({ 'data.bin': '\u0000 by seedhandle\n' }))

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'personal-handle', path: 'data.bin', match: 'seedhandle' },
  ])
})

test('publish-check reports a dependency declared in the root manifest with no notice', () => {
  const result = publishCheck(
    makeRepo({
      'package.json': manifest({
        dependencies: { 'right-pad': '1.0.0', 'local-pkg': 'workspace:*' },
      }),
    })
  )

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'missing-notice', path: 'THIRD-PARTY-NOTICES.md', match: 'right-pad' },
  ])
})

test('publish-check reports an excluded path that reaches the export set', () => {
  const result = publishCheck(makeRepo({ '.gitattributes': '.private-terms.json export-ignore\n' }))

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'personal-handle', path: 'CHANGELOG.md', line: 1, match: 'seedhandle' },
    { class: 'export-leak', path: 'CHANGELOG.md', match: 'CHANGELOG.md' },
  ])
})

test('publish-check reads the commit, not the working tree', () => {
  const repo = makeRepo({})
  writeFileSync(join(repo, 'README.md'), 'Written by seedhandle.\n')
  commitAll(repo, 'leak')
  writeFileSync(join(repo, 'NOTES.md'), 'Untracked note by seedhandle.\n')

  const earlier = publishCheck(repo, '--commit', 'HEAD~1')
  const latest = publishCheck(repo)

  assert.equal(earlier.status, 0)
  assert.equal(latest.status, 1)
  assert.deepEqual(findingsOf(latest), [
    { class: 'personal-handle', path: 'README.md', line: 1, match: 'seedhandle' },
  ])
})

test('publish-check cannot run outside a git repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-check-not-a-repo-'))
  createdDirs.push(dir)
  const result = publishCheck(dir)

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(
    stderrBeyondNodeWarnings(result.stderr),
    /^publish-check: could not run: not a git repository: /
  )
})

test('publish-check cannot run on an unreadable commit', () => {
  const result = publishCheck(makeRepo({}), '--commit', 'no-such-ref')

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(
    stderrBeyondNodeWarnings(result.stderr),
    'publish-check: could not run: unreadable commit: no-such-ref'
  )
})

test('publish-check cannot run without a private-terms file', () => {
  const result = publishCheck(makeRepo({ '.private-terms.json': null }))

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(
    stderrBeyondNodeWarnings(result.stderr),
    /^publish-check: could not run: no \.private-terms\.json at [0-9a-f]{40}/
  )
})

test('publish-check cannot run on a malformed private-terms file', () => {
  const result = publishCheck(makeRepo({ '.private-terms.json': '{"handles":"x"}\n' }))

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(
    stderrBeyondNodeWarnings(result.stderr),
    'publish-check: could not run: .private-terms.json is malformed: handles must be an array of non-blank strings'
  )
})

test('publish-check reads the private terms from --terms in a repo without the file', () => {
  const repo = makeRepo({
    '.private-terms.json': null,
    'README.md': 'This is a seed private phrase here.\n',
  })
  const termsPath = writeTermsFile(baselineFiles()['.private-terms.json'])

  const result = publishCheck(repo, '--terms', termsPath)

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'personal-wording', path: 'README.md', line: 1, match: 'seed private phrase' },
  ])
})

test('publish-check prefers --terms over the file at the commit', () => {
  const repo = makeRepo({ 'README.md': 'Written by otherhandle.\n' })
  const termsPath = writeTermsFile(
    JSON.stringify({ handles: ['otherhandle'], privateRepos: [], privateHosts: [], phrases: [] }) +
      '\n'
  )

  const result = publishCheck(repo, '--terms', termsPath)

  assert.equal(result.status, 1)
  assert.deepEqual(findingsOf(result), [
    { class: 'personal-handle', path: 'README.md', line: 1, match: 'otherhandle' },
  ])
})

test('publish-check cannot run when the --terms file is unreadable', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'publish-check-terms-')), 'absent.json')
  createdDirs.push(dirname(missing))

  const result = publishCheck(makeRepo({}), '--terms', missing)

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(
    stderrBeyondNodeWarnings(result.stderr),
    `publish-check: could not run: cannot read ${missing}: ENOENT`
  )
})

const writeTermsFile = (content: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-check-terms-'))
  createdDirs.push(dir)
  const path = join(dir, 'terms.json')
  writeFileSync(path, content)
  return path
}

const publishCheck = (repo: string, ...args: string[]) =>
  spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, 'publish-check', '--repo', repo, ...args],
    { encoding: 'utf8', timeout: 60_000 }
  )

const findingsOf = (result: { stdout: string }): unknown => JSON.parse(result.stdout).findings

// Builds a one-commit repo from the baseline files, with each override replacing a file's content
// or, as null, removing it.
const makeRepo = (overrides: Record<string, string | null>): string => {
  const repo = mkdtempSync(join(tmpdir(), 'publish-check-test-'))
  createdDirs.push(repo)

  for (const [path, content] of Object.entries({ ...baselineFiles(), ...overrides })) {
    if (content === null) {
      continue
    }
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }

  git(repo, 'init', '-q')
  commitAll(repo, 'seed')
  return repo
}

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

// The files a clean fixture repo ships: everything below except the two excluded paths.
const CLEAN_FILE_COUNT = 8

const baselineFiles = (): Record<string, string> => ({
  LICENSE: 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n',
  'package.json': manifest({}),
  'tools/cli/package.json': manifest({ dependencies: { 'left-pad': '1.0.0' } }),
  '.claude-plugin/plugin.json': manifest({}),
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

const manifest = (extra: Record<string, unknown>): string =>
  JSON.stringify({ license: 'GPL-3.0-or-later', ...extra }) + '\n'

// Seeds a token or a home directory would be a finding in the export set of this very repo if
// written as a literal, so they are assembled at run time.
const seedToken = (): string => ['gh', 'p_', 'a'.repeat(36)].join('')
const seedHome = (): string => ['', 'Users', 'alice', 'notes'].join('/')
const placeholderHome = (): string => ['', 'Users', 'x', 'notes'].join('/')
