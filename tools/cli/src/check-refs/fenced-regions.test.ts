import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findFencedRegions } from './fenced-regions.ts'

// --- The corruption class, not just one shape. An earlier version of
// FENCE_OPEN_RE required the info string to butt directly against the fence characters
// (`(\S*)` with no preceding `\s*`), so any fence-opener line whose info string didn't fit that
// exact shape failed to match as an opener at all. That isn't "slightly less tolerant than
// blocks.ts" — it corrupts the region map: with openIndex left null, the region's own LATER bare
// closing fence gets misread as a FRESH opener, producing a region at the wrong start line, with
// an empty infoString, wrongly flagged unterminated. Every assertion below checks the real
// start/end/infoString/unterminated shape, not `.length > 0` — a `.length > 0` check would have
// passed on the corrupted result too, since a (wrong) region still exists.

test('findFencedRegions: a space before the info string ("~~~ markdown") is tolerated, mirroring blocks.ts', () => {
  const content = ['~~~ markdown', 'content line', '~~~'].join('\n')
  const regions = findFencedRegions(content.split('\n'))
  assert.deepEqual(regions, [{ start: 1, end: 1, infoString: 'markdown' }])
})

test('findFencedRegions: an info string with trailing words ("~~~markdown extra") is recognised as an opener but excluded by its info string, without corrupting the region map', () => {
  const content = ['~~~markdown extra', 'content line', '~~~'].join('\n')
  const regions = findFencedRegions(content.split('\n'))
  // The region itself is correctly bounded (right start/end line, not the later bare closer
  // misread as a fresh opener) — it's excluded from being treated as a `markdown` region only by
  // its consumers' `=== 'markdown'` comparison, not by failing to be recognised as a fence at all.
  assert.deepEqual(regions, [{ start: 1, end: 1, infoString: 'markdown extra' }])
})

test('findFencedRegions: a case-varied info string ("~~~Markdown") is recognised as an opener, preserving case for the downstream comparison to reject', () => {
  const content = ['~~~Markdown', 'content line', '~~~'].join('\n')
  const regions = findFencedRegions(content.split('\n'))
  assert.deepEqual(regions, [{ start: 1, end: 1, infoString: 'Markdown' }])
})

// Control: the clean, already-correct shape must still resolve exactly as before. Proves the
// widened opener regex doesn't lose precision on the case every consumer actually depends on.
test('findFencedRegions: control — a clean "~~~markdown" opener still resolves correctly', () => {
  const content = ['~~~markdown', 'content line', '~~~'].join('\n')
  const regions = findFencedRegions(content.split('\n'))
  assert.deepEqual(regions, [{ start: 1, end: 1, infoString: 'markdown' }])
})

test('findFencedRegions: an unrecognised info string no longer corrupts an unrelated LATER bare fence into a fresh opener', () => {
  // Two independent fenced blocks: the first has a trailing-word info string (previously
  // unrecognised as an opener), the second is a clean, unrelated bash block. Before this fix, the
  // first block's own closer got misread as opening a new region, and the second block's opener
  // and closer were consumed as if they were content inside that bogus region.
  const content = [
    '~~~markdown extra',
    'first block content',
    '~~~',
    '',
    '```bash',
    'echo second block',
    '```',
  ].join('\n')
  const regions = findFencedRegions(content.split('\n'))
  assert.deepEqual(regions, [
    { start: 1, end: 1, infoString: 'markdown extra' },
    { start: 5, end: 5, infoString: 'bash' },
  ])
})
