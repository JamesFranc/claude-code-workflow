import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainTsPath = fileURLToPath(new URL('../main.ts', import.meta.url))

const runCli = (args: string[]): { stdout: string; stderr: string; status: number | null } => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', mainTsPath, ...args],
    { encoding: 'utf8' }
  )
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

const runProseAdjacency = (before: string, after: string): unknown => {
  const dir = mkdtempSync(join(tmpdir(), 'prose-adjacency-cli-test-'))
  const beforeFile = join(dir, 'before.txt')
  const afterFile = join(dir, 'after.txt')
  writeFileSync(beforeFile, before)
  writeFileSync(afterFile, after)
  try {
    const { stdout, status } = runCli([
      'prose-adjacency',
      '--before',
      beforeFile,
      '--after',
      afterFile,
    ])
    assert.equal(status, 0)
    return JSON.parse(stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('CLI: prose-adjacency registers --before and --after', () => {
  const { stdout } = runCli(['prose-adjacency', '--help'])
  assert.match(stdout, /--before/)
  assert.match(stdout, /--after/)
})

// The load-bearing case: a CONSTRUCTED pure reorder — same words, same characters, one clause
// (the "gamma delta" pair) moved from the middle to the front. Both weaker instruments read
// identical on this input; the adjacency diff is the only one of the three that sees the move.
// Asserting the first two go green is the point of this test, not incidental — a detector
// demonstrated only on input the weaker instruments also catch proves nothing about the gap it
// exists to close.
test('CLI: constructed pure reorder — word multiset and char count read identical, adjacency diff is not', () => {
  const before = 'Alpha beta gamma delta epsilon zeta'
  const after = 'gamma delta Alpha beta epsilon zeta'
  const result = runProseAdjacency(before, after) as {
    wordMultisetIdentical: boolean
    charCountIdentical: boolean
    pairsBroken: { first: string; second: string }[]
    pairsCreated: { first: string; second: string }[]
  }

  assert.equal(result.wordMultisetIdentical, true)
  assert.equal(result.charCountIdentical, true)
  assert.deepEqual(result.pairsBroken, [
    { first: 'beta', second: 'gamma' },
    { first: 'delta', second: 'epsilon' },
  ])
  assert.deepEqual(result.pairsCreated, [
    { first: 'delta', second: 'Alpha' },
    { first: 'beta', second: 'epsilon' },
  ])
})

// The realistic-shape example: the literal FLOW-202 pair (text, not shas — a squash destroys
// commits, not literal strings). This is NOT a pure reorder: the real fix also added "Cite", so a
// plain word-diff catches this one too. It exists to show the detector on a real rewrite, not to
// prove the gap — the constructed case above is the proof.
test('CLI: the FLOW-202 pair localises the move around the "not memory, not inference" junctions', () => {
  const before =
    '…must be backed by a concrete `path:line` you actually read (e.g., "resolver reads ' +
    '`ctx.req` — `src/context.ts:42`") so a reviewer can confirm the claim without re-deriving it ' +
    '— not memory, not inference.'
  const after =
    '…must be backed by a concrete `path:line` you actually read — not memory, not inference. ' +
    'Cite it (e.g., "resolver reads `ctx.req` — `src/context.ts:42`") so a reviewer can confirm ' +
    'the claim without re-deriving it.'
  const result = runProseAdjacency(before, after) as {
    wordMultisetIdentical: boolean
    charCountIdentical: boolean
    pairsBroken: { first: string; second: string }[]
    pairsCreated: { first: string; second: string }[]
  }

  // Not a pure reorder — "Cite" was added — so unlike the constructed case, both weaker
  // instruments correctly read false here too.
  assert.equal(result.wordMultisetIdentical, false)
  assert.equal(result.charCountIdentical, false)

  assert.deepEqual(result.pairsBroken, [
    { first: 'read', second: '(e.g.,' },
    { first: 're-deriving', second: 'it' },
    { first: 'it', second: '—' },
  ])
  assert.deepEqual(result.pairsCreated, [
    { first: 'read', second: '—' },
    { first: 'inference.', second: 'Cite' },
    { first: 'Cite', second: 'it' },
    { first: 'it', second: '(e.g.,' },
    { first: 're-deriving', second: 'it.' },
  ])
})

// The documented, deliberate limit: adjacency-pair equality is strictly weaker than sequence
// equality. When a moved clause's boundary junctions cancel exactly — the tokens bounding it at its
// old and new positions coincide — the adjacency multiset is unchanged even though a genuine reorder
// happened (`b` and `c` swap position; the diagram is a different Eulerian trail over the same
// multigraph of adjacent pairs). All three instruments read clean on this input. This is not a bug
// to fix — see the command's `fullDescription` — it's recorded here in executable form so a later
// "improvement" can't quietly claim the detector proves absence of a reorder.
test('CLI: documents the limit — a boundary-cancelling reorder is invisible to all three instruments', () => {
  const before = 'a b a c a'
  const after = 'a c a b a'
  const result = runProseAdjacency(before, after) as {
    wordMultisetIdentical: boolean
    charCountIdentical: boolean
    pairsBroken: unknown[]
    pairsCreated: unknown[]
  }

  assert.equal(result.wordMultisetIdentical, true)
  assert.equal(result.charCountIdentical, true)
  assert.deepEqual(result.pairsBroken, [])
  assert.deepEqual(result.pairsCreated, [])
})

test('CLI: unchanged prose emits no broken or created pairs', () => {
  const text =
    'The resolver reads ctx.req and confirms the claim without re-deriving it from memory.'
  const result = runProseAdjacency(text, text) as {
    wordMultisetIdentical: boolean
    charCountIdentical: boolean
    pairsBroken: unknown[]
    pairsCreated: unknown[]
  }

  assert.equal(result.wordMultisetIdentical, true)
  assert.equal(result.charCountIdentical, true)
  assert.deepEqual(result.pairsBroken, [])
  assert.deepEqual(result.pairsCreated, [])
})
