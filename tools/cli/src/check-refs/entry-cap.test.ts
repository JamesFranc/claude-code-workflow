import { test } from 'node:test'
import assert from 'node:assert/strict'
import { globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { findEntryCapFindings, REVIEW_RULES_PATH } from './entry-cap.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CAP = 162

const fixtureWithEntries = (count: number): string =>
  Array.from({ length: count }, (_, i) => `- [ ] Entry ${i + 1}`).join('\n')

test('findEntryCapFindings: one entry over the cap fails', () => {
  const findings = findEntryCapFindings(fixtureWithEntries(CAP + 1), REVIEW_RULES_PATH)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.category, 'entry-cap')
  assert.equal(findings[0]?.matched, `${CAP + 1} entries`)
})

test('findEntryCapFindings: exactly at the cap passes', () => {
  const findings = findEntryCapFindings(fixtureWithEntries(CAP), REVIEW_RULES_PATH)
  assert.equal(findings.length, 0)
})

test('findEntryCapFindings: over the cap in an unrelated file is ignored', () => {
  const findings = findEntryCapFindings(fixtureWithEntries(CAP + 1), 'skills/other/SKILL.md')
  assert.equal(findings.length, 0)
})

// --- CommonMark line endings: splitLines normalizes LF, CR, and CRLF to the same line count ---

test('findEntryCapFindings: the count is identical whether the fixture uses LF, CR, or CRLF line endings', () => {
  const lf = fixtureWithEntries(CAP + 1)
  const cr = lf.replace(/\n/g, '\r')
  const crlf = lf.replace(/\n/g, '\r\n')
  const expected = findEntryCapFindings(lf, REVIEW_RULES_PATH)[0]?.matched
  assert.equal(expected, `${CAP + 1} entries`)
  assert.equal(findEntryCapFindings(cr, REVIEW_RULES_PATH)[0]?.matched, expected)
  assert.equal(findEntryCapFindings(crlf, REVIEW_RULES_PATH)[0]?.matched, expected)
})

test('findEntryCapFindings: an entry immediately after a lone U+2028 is not counted (unlike a raw multiline-anchor regex, which treats U+2028 as a line terminator)', () => {
  const base = fixtureWithEntries(CAP - 1)
  const fixture = `${base}\n- [ ] Entry ${CAP}\u2028- [ ] Entry ${CAP + 1}`
  const findings = findEntryCapFindings(fixture, REVIEW_RULES_PATH)
  assert.equal(
    findings.length,
    0,
    'splitLines does not treat U+2028 as a line terminator, so the trailing "- [ ] Entry N+1" is ' +
      'part of the same logical line as its predecessor, not a line of its own — count stays at ' +
      'the cap, not one over it'
  )
})

// --- Wiring: REVIEW_RULES_PATH must match what the real scan produces ---

test('REVIEW_RULES_PATH matches the path scanFiles produces for the real file', () => {
  const scannedFiles = globSync('skills/**/*.md', { cwd: REPO_ROOT })
  assert.ok(
    scannedFiles.includes(REVIEW_RULES_PATH),
    `scanFiles' glob over ${REPO_ROOT} did not produce the literal '${REVIEW_RULES_PATH}' — ` +
      'findEntryCapFindings would silently never match the real file'
  )
})
