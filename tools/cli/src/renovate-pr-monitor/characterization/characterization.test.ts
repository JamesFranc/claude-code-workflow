// Recaptures every case in cases.ts and compares it byte for byte with expected/, which
// capture.ts generates. A failure here means the TypeScript renovate-pr-monitor command's
// behaviour changed, or expected/ is stale — run capture.ts to see which.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { classifyCases, tickCases } from './cases.ts'
import { runClassify, runTick, serialize } from './harness.ts'

const EXPECTED_DIR = join(import.meta.dirname, 'expected')
const TICK_DIR = join(EXPECTED_DIR, 'tick')

const readClassifyExpected = (): Record<string, string> =>
  JSON.parse(readFileSync(join(EXPECTED_DIR, 'classify.json'), 'utf8')) as Record<string, string>

test('classify', () => {
  const results = Object.fromEntries(classifyCases.map((c) => [c.name, runClassify(c)] as const))
  assert.equal(serialize(results), readFileSync(join(EXPECTED_DIR, 'classify.json'), 'utf8'))
})

describe('tick', { concurrency: 4 }, () => {
  for (const c of tickCases) {
    test(c.name, async () => {
      const capture = await runTick(c)
      assert.equal(serialize(capture), readFileSync(join(TICK_DIR, `${c.name}.json`), 'utf8'))
    })
  }
})

test('all classify outputs are captured', () => {
  const values = new Set(Object.values(readClassifyExpected()))
  assert.deepEqual(
    [...values].sort(),
    [
      'agent-busy',
      'left-alone',
      'blocked',
      'blocked-stuck',
      'ci-failed',
      'ci-pending',
      'major',
      'major-skip',
      'mergeable',
      'needs-approval',
      'needs-rebase',
      'rebase-conflict',
      'skip',
      'unknown',
    ].sort()
  )
})

test('expected files match the catalogue', () => {
  const tickFileNames = readdirSync(TICK_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
  assert.deepEqual(tickFileNames.sort(), tickCases.map((c) => c.name).sort())

  assert.deepEqual(
    Object.keys(readClassifyExpected()).sort(),
    classifyCases.map((c) => c.name).sort()
  )
})

test('search and scope cases record their exit', () => {
  for (const name of [
    'owner-and-repo-one-fails',
    'search-fails',
    'search-succeeds-with-stderr',
    'bad-scope',
  ]) {
    const capture = JSON.parse(readFileSync(join(TICK_DIR, `${name}.json`), 'utf8')) as {
      live: { exit: unknown; stderr: unknown }
    }
    assert.equal(typeof capture.live.exit, 'number')
    assert.equal(typeof capture.live.stderr, 'string')
  }
})
