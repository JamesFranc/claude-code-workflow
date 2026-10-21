import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { PrivateTerms } from '../publish-check/terms.ts'
import { publicNotes } from './notes.ts'

const SOURCE = 'seedorg/source'
const TERMS: PrivateTerms = {
  handles: ['seedhandle'],
  privateRepos: ['seedorg/hidden'],
  privateHosts: ['git.seed.invalid'],
  phrases: ['project falcon'],
}

const releaseBody = (
  repo: string
): string => `## [1.4.0](https://github.com/${repo}/compare/seed-v1.3.0...seed-v1.4.0) (2026-10-18)


### Features

* [SEED-12] publish the snapshot from the release workflow ([#37](https://github.com/${repo}/issues/37)) ([f3e8589](https://github.com/${repo}/commit/f3e8589b3113040d0e7afa8975c5f6fdd9bf633f))


### Bug Fixes

* [SEED-10] post approvals at every go-ahead point ([#32](https://github.com/${repo}/issues/32)) ([a75eda0](https://github.com/${repo}/commit/a75eda0561a851e9225980c031c817b0a865d5fb))
`

const PUBLIC_BODY =
  '## 1.4.0 (2026-10-18)\n\n\n### Features\n\n* publish the snapshot from the release workflow\n\n\n### Bug Fixes\n\n* post approvals at every go-ahead point\n'

test('rewrites a release-please body for the public repo', () => {
  assert.deepEqual(publicNotes(releaseBody(SOURCE), SOURCE, TERMS), {
    kind: 'notes',
    notes: PUBLIC_BODY,
  })
})

test('matches the source repo link case-insensitively', () => {
  assert.deepEqual(publicNotes(releaseBody('SeedOrg/Source'), SOURCE, TERMS), {
    kind: 'notes',
    notes: PUBLIC_BODY,
  })
})

test('keeps links to other repositories', () => {
  const entry =
    '* add [docs](https://github.com/other/repo/blob/main/README.md) link ([#5](https://github.com/seedorg/source/issues/5))\n'

  assert.deepEqual(publicNotes(entry, SOURCE, TERMS), {
    kind: 'notes',
    notes: '* add [docs](https://github.com/other/repo/blob/main/README.md) link\n',
  })
})

test('refuses an inline PR reference it cannot strip', () => {
  const result = publicNotes(
    '* fix it, closes [#9](https://github.com/seedorg/source/issues/9)\n',
    SOURCE,
    TERMS
  )

  assert.deepEqual(result, { kind: 'refused', reason: 'the public notes would still name #9' })
})

test('refuses a ticket key mid-sentence', () => {
  const result = publicNotes('* follow up on SEED-4 in the monitor\n', SOURCE, TERMS)

  assert.deepEqual(result, { kind: 'refused', reason: 'the public notes would still name SEED-4' })
})

test('refuses plain text naming the source repo', () => {
  const result = publicNotes('* mirror seedorg/source to the snapshot\n', SOURCE, TERMS)

  assert.deepEqual(result, {
    kind: 'refused',
    reason: 'the public notes would still name seedorg/source',
  })
})

test('replaces notes with no entries', () => {
  assert.deepEqual(
    publicNotes(
      '## [1.4.1](https://github.com/seedorg/source/compare/a...b) (2026-10-19)\n',
      SOURCE,
      TERMS
    ),
    { kind: 'notes', notes: 'No user-facing changes.\n' }
  )
})

test('refuses a private term of each category', () => {
  const cases: [string, string][] = [
    ['* thanks seedhandle for the fix', 'seedhandle'],
    ['* mirror seedorg/hidden to the snapshot', 'seedorg/hidden'],
    ['* see https://git.seed.invalid/docs for details', 'git.seed.invalid'],
    ['* finish Project   Falcon rollout', 'Project   Falcon'],
  ]

  for (const [entry, match] of cases) {
    assert.deepEqual(publicNotes(`${entry}\n`, SOURCE, TERMS), {
      kind: 'refused',
      reason: `the public notes would still name ${match}`,
    })
  }
})

test('strips a run of adjacent ticket keys', () => {
  for (const entry of [
    '* [SEED-1][SEED-2] merge the two paths',
    '* [SEED-1] [SEED-2] merge the two paths',
  ]) {
    assert.deepEqual(publicNotes(`${entry}\n`, SOURCE, TERMS), {
      kind: 'notes',
      notes: '* merge the two paths\n',
    })
  }
})

test('refuses a credential and a home-directory path but not a placeholder one', () => {
  const credential = 'sk-' + 'a'.repeat(24)
  const home = '/Users/' + 'someone'

  assert.deepEqual(publicNotes(`* rotate ${credential} now\n`, SOURCE, TERMS), {
    kind: 'refused',
    reason: 'the public notes would still name sk-a… (27 characters)',
  })
  assert.deepEqual(publicNotes(`* read ${home}/notes for details\n`, SOURCE, TERMS), {
    kind: 'refused',
    reason: `the public notes would still name ${home}`,
  })
  assert.deepEqual(publicNotes('* read /Users/you/notes for details\n', SOURCE, TERMS), {
    kind: 'notes',
    notes: '* read /Users/you/notes for details\n',
  })
})
