import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { stderrBeyondNodeWarnings } from '../testing/subprocess-stderr.ts'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'snapshot-release-notes-'))

after(() => {
  rmSync(dir, { recursive: true, force: true })
})

const REPO = 'seedorg/source'
const GOOD_BODY = `## [1.4.0](https://github.com/${REPO}/compare/seed-v1.3.0...seed-v1.4.0) (2026-10-18)


### Features

* [SEED-12] publish the snapshot from the release workflow ([#37](https://github.com/${REPO}/issues/37)) ([f3e8589](https://github.com/${REPO}/commit/f3e8589b3113040d0e7afa8975c5f6fdd9bf633f))


### Bug Fixes

* [SEED-10] post approvals at every go-ahead point ([#32](https://github.com/${REPO}/issues/32)) ([a75eda0](https://github.com/${REPO}/commit/a75eda0561a851e9225980c031c817b0a865d5fb))
`
const PUBLIC_BODY =
  '## 1.4.0 (2026-10-18)\n\n\n### Features\n\n* publish the snapshot from the release workflow\n\n\n### Bug Fixes\n\n* post approvals at every go-ahead point\n'

const notesFile = (name: string, body: string): string => {
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

const TERMS_PATH = join(dir, 'terms.json')
writeFileSync(
  TERMS_PATH,
  JSON.stringify({
    handles: ['seedhandle'],
    privateRepos: ['seedorg/hidden'],
    privateHosts: ['git.seed.invalid'],
    phrases: ['project falcon'],
  })
)

const run = (file: string, sourceRepo: string, terms = TERMS_PATH) =>
  spawnSync(
    process.execPath,
    [
      '--experimental-transform-types',
      mainTsPath,
      'snapshot-release-notes',
      '--file',
      file,
      '--source-repo',
      sourceRepo,
      '--terms',
      terms,
    ],
    { encoding: 'utf8' }
  )

test('writes the public notes to stdout', () => {
  const result = run(notesFile('good.md', GOOD_BODY), REPO)

  assert.equal(result.status, 0)
  assert.equal(result.stdout, PUBLIC_BODY)
  assert.equal(stderrBeyondNodeWarnings(result.stderr), '')
})

test('refuses a leak with exit 2 and empty stdout', () => {
  const result = run(notesFile('leak.md', '* follow up on SEED-4 in the monitor\n'), REPO)

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(
    stderrBeyondNodeWarnings(result.stderr),
    'snapshot-release-notes: refused: the public notes would still name SEED-4'
  )
})

test('refuses a private term from the terms file', () => {
  const result = run(notesFile('term.md', '* thanks seedhandle for the fix\n'), REPO)

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(
    stderrBeyondNodeWarnings(result.stderr),
    'snapshot-release-notes: refused: the public notes would still name seedhandle'
  )
})

test('refuses an unreadable terms file', () => {
  const missing = join(dir, 'missing-terms.json')
  const result = run(notesFile('good3.md', GOOD_BODY), REPO, missing)

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(
    stderrBeyondNodeWarnings(result.stderr),
    `snapshot-release-notes: refused: cannot read ${missing}: ENOENT`
  )
})

test('refuses a malformed source repo', () => {
  const result = run(notesFile('good2.md', GOOD_BODY), 'not-a-repo')

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(
    stderrBeyondNodeWarnings(result.stderr),
    'snapshot-release-notes: refused: --source-repo must be owner/name, got not-a-repo'
  )
})

test('refuses an unreadable notes file', () => {
  const result = run(dir, REPO)

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(
    stderrBeyondNodeWarnings(result.stderr),
    `snapshot-release-notes: refused: cannot read ${dir}: EISDIR`
  )
})
