import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { findHeadingCitationFindings } from './heading-citations.ts'
import { runCheckRefs } from './main.ts'
import { setRequestedExitCode, getRequestedExitCode } from '../runtime-exit-code.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

const captureStdout = (run: () => void): string => {
  const original = process.stdout.write.bind(process.stdout)
  let captured = ''
  process.stdout.write = ((chunk: string) => {
    captured += chunk
    return true
  }) as typeof process.stdout.write
  try {
    run()
  } finally {
    process.stdout.write = original
  }
  return captured
}

// --- The three FLOW-194 instances, reintroduced on purpose and shown to fail ---

test('findHeadingCitationFindings: citing two headings the file has neither of', () => {
  const content = [
    '## Overview',
    '',
    '**No section restates another.** See `## Proposed Approach` and `## Proposed Fix`.',
  ].join('\n')
  const findings = findHeadingCitationFindings(content, 'fixture.md')
  assert.equal(findings.length, 2)
  assert.ok(findings.every((f) => f.category === 'heading-citation'))
})

test('findHeadingCitationFindings: citing `## Proposed Fix` when the file defines only `## Proposed Approach`', () => {
  const content = [
    '## Proposed Approach',
    'The change at a high level.',
    '',
    '**No section restates another.** The overlap to watch is `Scope` against `## Proposed Fix`.',
  ].join('\n')
  const findings = findHeadingCitationFindings(content, 'fixture.md')
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.matched, '`## Proposed Fix`')
})

test('findHeadingCitationFindings: citing `## Proposed Approach` when the file defines only `## Proposed Fix`', () => {
  const content = [
    '## Proposed Fix',
    'High-level approach.',
    '',
    '**No section restates another.** The overlap to watch is `Scope` against `## Proposed Approach`.',
  ].join('\n')
  const findings = findHeadingCitationFindings(content, 'fixture.md')
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.matched, '`## Proposed Approach`')
})

// --- Synthetic reproduction of the harmonization mechanism (not a check against live template
// content: systematic-debugging-reference.md's own "No section restates another" sentence backtick-
// quotes `Proposed Fix` without a `##` prefix today, so it never exercises this check at all; the
// real-tree coverage for that file is the whole-repo scan below) ---

test('findHeadingCitationFindings: a de-duplication sentence citing a heading the target file does not declare fails the check', () => {
  // Demonstrates the mechanism a template harmonization could trip: a file whose own de-duplication
  // sentence cites a heading only a DIFFERENT template defines.
  const content = [
    '## Proposed Fix',
    'High-level approach. What changes, what the new behavior is.',
    '',
    '## Scope',
    'Bullet list of what the fix touches.',
    '',
    '**No section restates another.** The overlap to watch is `Scope` against `## Proposed Approach`: ' +
      'Scope names what the change touches, the approach section says what it does.',
  ].join('\n')
  const findings = findHeadingCitationFindings(content, 'fixture-debugging.md')
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.matched, '`## Proposed Approach`')
})

// --- FLOW-258: the gate covers levels 2–6, not just level 2 ---

test('findHeadingCitationFindings: a `###` citation that resolves to a declared heading is not flagged', () => {
  const content = [
    '## Overview',
    '',
    '### Details',
    'The detail text.',
    '',
    'See `### Details` for the full list.',
  ].join('\n')
  const findings = findHeadingCitationFindings(content, 'fixture.md')
  assert.deepEqual(findings, [])
})

test('findHeadingCitationFindings: a `###` citation that does not resolve reports the named-filter inventory', () => {
  const content = [
    '## Overview',
    '',
    '### Details',
    'The detail text.',
    '',
    'See `### Missing Section` for the full list.',
  ].join('\n')
  const findings = findHeadingCitationFindings(content, 'fixture.md')
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.matched, '`### Missing Section`')
  assert.equal(
    findings[0]?.fix,
    'no matching heading in this file — it has (## and deeper): ## Overview, ### Details'
  )
})

// --- Current tree, whole-repo, via the real public entry point ---

test('runCheckRefs: current tree raises no heading-citation findings', () => {
  setRequestedExitCode(99)
  const stdout = captureStdout(() => runCheckRefs(REPO_ROOT))
  const output = JSON.parse(stdout) as { findings: { category: string }[]; count: number }
  const headingCitationFindings = output.findings.filter((f) => f.category === 'heading-citation')
  assert.deepEqual(headingCitationFindings, [])
  assert.equal(getRequestedExitCode(), 0)
})

// --- The anti-revert for the fenced-headings decision ---
//
// Headings declared only inside a fenced code block still count as headings of the file — these
// two reference docs template the artifact they cite. Excluding fenced content here reintroduces
// eleven false positives (6 in architecture-reference.md — one line carries two citations — plus
// 5 in syncing-plans-to-jira/SKILL.md); see the comment at the collection site in
// heading-citations.ts. This is a synthetic, minimal reproduction of that mechanism, plus a named
// check against the real files it was measured against.

test('findHeadingCitationFindings: a heading declared only inside a fenced block still satisfies a citation to it', () => {
  const content = [
    'Some reference doc that templates another document.',
    '',
    '~~~markdown',
    '## The change at a glance',
    '~~~',
    '',
    'The diagram lives under `## The change at a glance` above.',
  ].join('\n')
  const findings = findHeadingCitationFindings(content, 'fixture-template.md')
  assert.deepEqual(findings, [])
})

// --- Real regression, caught by CI on the merged tree: skills/memory-review/SKILL.md cites
// `## Rules`, and the heading exists in that same file — but only inside a fenced ```markdown
// template, indented three spaces as list-continuation under a numbered step. Same axis, same fix
// as fence-shape.ts's BOLD_LEAD_IN_RE: a heading collector
// that anchors at column 0 misses a heading the file genuinely declares, just nested under a list
// item. This is architecture-reference.md's case, not reload-goal.md's — the file templates the
// artifact it cites, so no CROSS_DOCUMENT_CITATIONS entry is needed once indentation is collected.
test('findHeadingCitationFindings: an indented heading inside a fenced template (nested under a list item) still satisfies its citation', () => {
  const content = [
    '1. Create it when it is absent and there is a standard to record.',
    '',
    '   ```markdown',
    '   # Review Standards',
    '',
    '   ## Rules',
    '   ```',
    '',
    '2. An entry is a single `-` bullet under `## Rules`.',
  ].join('\n')
  const findings = findHeadingCitationFindings(content, 'fixture-indented-template.md')
  assert.deepEqual(findings, [])
})

// --- The opposite direction from every other limit in this checker. Shapes
// 1-9 (in fence-shape.ts) and the earlier heading-citations gaps all OVER-flag or stay silent on
// a genuine ambiguity — this one UNDER-flags. A line inside ANY fenced block that trims to `## X`
// was counting as a declaration of `## X`, so a citation resolved against a CODE SAMPLE, not a
// real heading. Unlike the noun-phrase-vs-imperative limits, this is closable at the root: the
// fence's info string (`bash` vs `markdown`) is a machine-readable, decidable signal — no judgment
// call needed. Both the unindented and indented forms predate 5c4fbcf; a fix that only closed the
// indented margin would leave the original hole open while looking closed.
//
// Shared fixture builder, same rationale as every other pair in this file: the blind tests and
// their control must differ in exactly the fence's info string (and, for the second blind test,
// the heading's own indentation), nothing else.
const codeFenceHeadingFixture = (fenceInfo: string, headingLine: string): string =>
  [
    '```' + fenceInfo,
    headingLine,
    'content',
    '```',
    '',
    'This cites `## Fake Section` — resolves only if the fence above is markdown-labeled.',
  ].join('\n')

test('findHeadingCitationFindings: a heading inside a ```bash code sample does not satisfy its citation', () => {
  const content = codeFenceHeadingFixture('bash', '## Fake Section')
  const findings = findHeadingCitationFindings(content, 'fixture.md')
  assert.equal(findings.length, 1)
})

test('findHeadingCitationFindings: the same heading, indented, inside a ```bash code sample still does not satisfy its citation', () => {
  const content = codeFenceHeadingFixture('bash', '  ## Fake Section')
  const findings = findHeadingCitationFindings(content, 'fixture.md')
  assert.equal(findings.length, 1)
})

// The non-vacuity control: same fixture, `markdown` in place of `bash`. Without it, the two tests
// above could pass for the wrong reason — a checker that flags every citation unconditionally,
// fence content notwithstanding, would also "pass" them. This proves the mechanism actually
// differentiates by info string rather than always flagging.
test('findHeadingCitationFindings: control — the same heading inside a ```markdown fence DOES satisfy its citation', () => {
  const content = codeFenceHeadingFixture('markdown', '## Fake Section')
  const findings = findHeadingCitationFindings(content, 'fixture.md')
  assert.deepEqual(findings, [])
})

test('findHeadingCitationFindings: architecture-reference.md passes because its citations resolve to fenced headings', () => {
  const relPath = 'skills/architecture/references/architecture-reference.md'
  const content = readFileSync(new URL(relPath, `file://${REPO_ROOT}`), 'utf-8')
  const findings = findHeadingCitationFindings(content, relPath)
  assert.deepEqual(findings, [])
})

test('findHeadingCitationFindings: syncing-plans-to-jira/SKILL.md passes because its `## Tasks` citations resolve to a fenced heading', () => {
  const relPath = 'skills/syncing-plans-to-jira/SKILL.md'
  const content = readFileSync(new URL(relPath, `file://${REPO_ROOT}`), 'utf-8')
  const findings = findHeadingCitationFindings(content, relPath)
  assert.deepEqual(findings, [])
})

// --- Cross-document citations: exactly the two documented exceptions ---

test("findHeadingCitationFindings: reload-goal.md citing the PRD template's North Star heading is not flagged", () => {
  const relPath = 'commands/reload-goal.md'
  const content = readFileSync(new URL(relPath, `file://${REPO_ROOT}`), 'utf-8')
  const findings = findHeadingCitationFindings(content, relPath)
  assert.deepEqual(findings, [])
})

test('findHeadingCitationFindings: process-improvement-notes/SKILL.md citing the notes-file Consolidated Digest heading is not flagged', () => {
  const relPath = 'skills/process-improvement-notes/SKILL.md'
  const content = readFileSync(new URL(relPath, `file://${REPO_ROOT}`), 'utf-8')
  const findings = findHeadingCitationFindings(content, relPath)
  assert.deepEqual(findings, [])
})

test('findHeadingCitationFindings: the cross-document exception is keyed by file, not a global string allowlist', () => {
  // The same citation text that is exempted for reload-goal.md must still be flagged for an
  // unrelated file that has no business citing a heading from another document.
  const content = '`## North Star — what we are really trying to accomplish` is not defined here.'
  const findings = findHeadingCitationFindings(content, 'skills/some-other-skill/SKILL.md')
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.fix, 'this file declares no ## or deeper headings')
})

// --- CommonMark line endings: \n, \r, and \r\n all scan the same ---

// splitLines splits this CR-only file into its three logical lines, so HEADING_RE's `^` anchor
// matches `## Real Heading` on its own line same as it would under \n, the heading is collected,
// and the citation resolves — a leading non-heading sentence changes nothing either way.
test('findHeadingCitationFindings: a heading declared later in a CR-only file is still collected and satisfies its own citation', () => {
  const content = [
    'Intro paragraph, not a heading.',
    '## Real Heading',
    'See `## Real Heading` above for details.',
  ].join('\r')
  const findings = findHeadingCitationFindings(content, 'fixture.md')
  assert.deepEqual(findings, [])
})

// The test above pins whether a heading is collected at all; this one pins where an unresolved
// citation is reported. Under a \n-only splitter a CR-only file collapses to one "line", so every
// finding lands at line 1 regardless of which logical line the citation is actually on.
test('findHeadingCitationFindings: an unresolved citation is reported at its own logical line number, not line 1, under CR-only line endings', () => {
  const content = ['## Overview', 'See `## Missing Section` here.'].join('\r')
  const findings = findHeadingCitationFindings(content, 'fixture.md')
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.line, 2)
})

// Combines the two CR-only checks above under \r\n: a declared heading must still satisfy its own
// citation (proving CRLF headings are collected and trimmed correctly), and the one unresolved
// citation must land at its own logical line, not a line shifted by a spurious blank line a
// \r-then-\n alternation (tried in the wrong order) would insert between every CRLF pair — split-
// lines.ts's own header comment names that exact ordering hazard. A fixture that never resolves any
// citation (the two-missing-headings case this replaced) cannot exercise either property: whether a
// heading is collected only matters when some citation depends on it, and whether a line number is
// right only matters when an assertion checks it.
test('findHeadingCitationFindings: a heading declared later in a CRLF file still satisfies its own citation, and an unresolved citation is reported at its own logical line number', () => {
  const content = [
    'Intro paragraph, not a heading.',
    '## Real Heading',
    'See `## Real Heading` above, and `## Missing Section` here.',
  ].join('\r\n')
  const findings = findHeadingCitationFindings(content, 'fixture.md')
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.matched, '`## Missing Section`')
  assert.equal(findings[0]?.line, 3)
})
