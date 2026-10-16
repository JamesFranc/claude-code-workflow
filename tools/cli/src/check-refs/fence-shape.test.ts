import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { findFenceShapeFindings } from './fence-shape.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

const gitShow = (sha: string, relPath: string): string =>
  execFileSync('git', ['show', `${sha}:${relPath}`], { cwd: REPO_ROOT, encoding: 'utf-8' })

// The published snapshot has no history, so these commits exist only in the source repo. The snapshot
// is the one tree without `.private-terms.json` (tracked in the source, excluded from the export), so
// the tests skip only there; a shallow source checkout still runs them and fails.
const isSnapshot = (): boolean =>
  spawnSync('git', ['cat-file', '-e', 'HEAD:.private-terms.json'], { cwd: REPO_ROOT }).status !== 0

const hasCommit = (sha: string): boolean =>
  spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: REPO_ROOT }).status === 0

const historySkip = (...shas: string[]): string | false => {
  if (!isSnapshot()) {
    return false
  }

  const missing = shas.filter((sha) => !hasCommit(sha))
  return missing.length === 0
    ? false
    : `needs commit(s) ${missing.join(', ')}, absent from this clone`
}

// The RED input is real history, not a fixture: at 1351aac, quick-change/SKILL.md's glance section
// has a "**Required.**..." prose paragraph between the heading and the diagram (no blank line right
// after the heading either). Both shas are on main and survive any squash; the tests skip in a clone
// without that history (the published snapshot).
//
// Exact count, not `> 0`: an aggregate "some finding exists" assertion can go green for the wrong
// reason and hide a scope gap elsewhere in the checker (this is exactly how the original prefix-only
// Rule A and the missing Rule B rode through review against this same input). One finding here: Rule B
// (the bolded "**Required.**" lead-in).
test(
  'findFenceShapeFindings: flags the pre-FLOW-202 quick-change template (prose between heading and diagram)',
  { skip: historySkip('1351aac') },
  () => {
    const content = gitShow('1351aac', 'skills/quick-change/SKILL.md')
    const findings = findFenceShapeFindings(content, 'skills/quick-change/SKILL.md')
    assert.equal(findings.length, 1)
    assert.ok(findings.every((f) => f.category === 'fence-shape'))
    assert.equal(findings.filter((f) => f.fix.startsWith('move this bolded instruction')).length, 1)
  }
)

test(
  'findFenceShapeFindings: the post-FLOW-202 quick-change template at the same path is clean',
  { skip: historySkip('737aff1') },
  () => {
    const content = gitShow('737aff1', 'skills/quick-change/SKILL.md')
    const findings = findFenceShapeFindings(content, 'skills/quick-change/SKILL.md')
    assert.deepEqual(findings, [])
  }
)

const TEMPLATE_FILES = [
  'skills/quick-change/SKILL.md',
  'skills/architecture/references/architecture-reference.md',
  'skills/systematic-debugging/references/systematic-debugging-reference.md',
]

for (const relPath of TEMPLATE_FILES) {
  test(`findFenceShapeFindings: current tree — ${relPath} is clean`, () => {
    const content = readFileSync(new URL(relPath, `file://${REPO_ROOT}`), 'utf-8')
    const findings = findFenceShapeFindings(content, relPath)
    assert.deepEqual(findings, [])
  })
}

// --- CommonMark line endings: \n, \r, and \r\n all scan the same ---

// Exercises the whole pipeline — outer-fence detection and Rule B's bolded-lead-in matching — under
// CR-only line endings. On its own this assertion cannot distinguish Rule B genuinely running from
// findOuterFencedRegions finding zero regions and findFenceShapeFindings returning [] before Rule B
// ever runs (splitting on \n alone collapses a CR-only file into one giant "line", so no fence
// markers are found on any line): both paths report zero findings on clean content. The paired test
// below, which injects a bolded leak into this same file, is what proves Rule B actually ran — it
// reports 0 under the early-return path and 1 under the real one.
test('findFenceShapeFindings: architecture-reference.md stays clean when its line endings are CR-only', () => {
  const relPath = 'skills/architecture/references/architecture-reference.md'
  const content = readFileSync(new URL(relPath, `file://${REPO_ROOT}`), 'utf-8').replace(
    /\n/g,
    '\r'
  )
  const findings = findFenceShapeFindings(content, relPath)
  assert.deepEqual(findings, [])
})

// Same file, same CR-only line endings, but with a bolded Rule B leak injected into the otherwise-real
// content. Under the early-return path this reports 0, identically to the clean test above — the
// two together are what shows the check ran rather than never firing: a checker that always reports
// clean cannot pass both.
test('findFenceShapeFindings: the same injected defect is still caught when line endings are CR-only', () => {
  const relPath = 'skills/architecture/references/architecture-reference.md'
  const clean = readFileSync(new URL(relPath, `file://${REPO_ROOT}`), 'utf-8')
  const injected = clean.replace(
    '## Overview\nHigh-level summary',
    '## Overview\n**Injected leak.** Proves the CR-only file was scanned.\nHigh-level summary'
  )
  const findings = findFenceShapeFindings(injected.replace(/\n/g, '\r'), relPath)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.fix.startsWith('move this bolded instruction'), true)
})

// Same real-history fixture as the first test in this file, under CR-only line endings: splitting
// on \n alone collapses the whole file into one "line", so findOuterFencedRegions finds no outer
// fence at all and the check silently reports zero findings instead of the one bolded leak. (At
// 1351aac, quick-change/SKILL.md also has an unbolded leak Rule B doesn't catch, so "one" is exact.)
test(
  'findFenceShapeFindings: the one bolded leak is still caught when line endings are CR-only',
  { skip: historySkip('1351aac') },
  () => {
    const content = gitShow('1351aac', 'skills/quick-change/SKILL.md').replace(/\n/g, '\r')
    const findings = findFenceShapeFindings(content, 'skills/quick-change/SKILL.md')
    assert.equal(findings.length, 1)
    assert.equal(findings.filter((f) => f.fix.startsWith('move this bolded instruction')).length, 1)
  }
)

// Regression guard: the same clean template under CRLF line endings.
test('findFenceShapeFindings: architecture-reference.md stays clean when its line endings are CRLF', () => {
  const relPath = 'skills/architecture/references/architecture-reference.md'
  const content = readFileSync(new URL(relPath, `file://${REPO_ROOT}`), 'utf-8').replace(
    /\n/g,
    '\r\n'
  )
  const findings = findFenceShapeFindings(content, relPath)
  assert.deepEqual(findings, [])
})

test('findFenceShapeFindings: does not flag author-fillable placeholders elsewhere in the template', () => {
  const content = [
    'Template:',
    '',
    '~~~markdown',
    '# [Title] — Architecture',
    '',
    '**Jira:** [TICKET-ID]',
    '',
    '## The change at a glance',
    '',
    '```mermaid',
    'graph TD',
    '    A --> B',
    '```',
    '',
    '## Stories',
    '1. **Story title** — Brief description of what this delivers',
    '2. **Story title** — Brief description',
    '~~~',
  ].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  assert.deepEqual(findings, [])
})

// --- Rule B: bolded instruction blocks anywhere in the fence.
test('findFenceShapeFindings: Rule B catches a bolded instruction outside the glance section', () => {
  const content = [
    'Template:',
    '',
    '~~~markdown',
    '# [Title] — Architecture',
    '',
    '**Jira:** [TICKET-ID]',
    '',
    '## The change at a glance',
    '',
    '```mermaid',
    'graph TD',
    '    A --> B',
    '```',
    '',
    '## Risks / Open Questions',
    'Known unknowns.',
    '',
    '**Technical unknowns MUST be validated, not assumed.** Some more instruction text.',
    '~~~',
  ].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.line, 18)
  assert.equal(
    findings[0]?.matched,
    '**Technical unknowns MUST be validated, not assumed.** Some more instruction text.'
  )
})

test('findFenceShapeFindings: `**Jira:** [TICKET-ID]` is exempt from Rule B', () => {
  const content = ['~~~markdown', '**Jira:** [TICKET-ID]', '~~~'].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  assert.deepEqual(findings, [])
})

// --- Rule B's exemption is a SHAPE (bold label ending in `:`, immediately followed by a `[` or `<`
// placeholder opener), not a literal `**Jira:**` string. This reverses an earlier ruling that
// rejected the shape as too broad ("a future `**Something:** [PLACEHOLDER]` leaks through
// unnoticed") — that reasoning was wrong: the shape IS the slot-occupying-vs-slot-adjacent
// discriminator from FLOW-202's review, not an exception to it. Other real fields discovered via a
// whole-repo lint (skills/process-improvement-notes/SKILL.md's `**Status:**`, `**Slips:**`,
// `**Harden:**`, `**Examples:**`) all match; that file is not edited here — the checker was wrong,
// not the doc.
test('findFenceShapeFindings: other field labels beyond `**Jira:**` are exempt by shape, not by name', () => {
  const content = [
    '~~~markdown',
    '**Status:** [Phase — e.g., JTBD, Architecture, Implementation, Review, PR Feedback, Merged]',
    '**Slips:** <the concrete failure mode(s) — what went wrong, specifically>',
    '**Harden:** <the prescribed discipline or fix that would prevent it>',
    '**Examples:** <the story / ticket IDs where it showed up>',
    '~~~',
  ].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  assert.deepEqual(findings, [])
})

// --- The anti-revert for the shape reversal: every historical leak this rule exists to catch must
// still be flagged under the new, broader exemption. Without this, a later widening of the shape
// could silently re-open Rule B. `**Required.**` is the load-bearing case — the shortest leak and
// the closest to looking like a field (a single bolded word ending in a period, not a colon) — so
// it is asserted on its own, not just folded into the others.
test('findFenceShapeFindings: `**Required.**` — the shortest, closest-to-exempt historical leak — is still flagged', () => {
  const content = [
    '~~~markdown',
    '## The change at a glance',
    '**Required.** A mermaid diagram that conveys the change on its own.',
    '~~~',
  ].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  const ruleBFindings = findings.filter((f) => f.fix.startsWith('move this bolded instruction'))
  assert.equal(ruleBFindings.length, 1)
  assert.ok(ruleBFindings[0]?.matched.startsWith('**Required.**'))
})

test('findFenceShapeFindings: all five historical leak shapes are still flagged under the field-label exemption', () => {
  const leakLines = [
    '**Required.** A mermaid diagram that conveys the change on its own.',
    '**No section restates another.** The overlap to watch is `Scope` against `Proposed Approach`.',
    '**Technical unknowns MUST be validated, not assumed.** Flag it as a risk.',
    '**Cite evidence for what you DID verify.** Link the `path:line` you read.',
    '**Phrase risks as verification gates.** Each risk should have an "if X then Y" mitigation.',
  ]
  const content = ['~~~markdown', ...leakLines, '~~~'].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  const ruleBFindings = findings.filter((f) => f.fix.startsWith('move this bolded instruction'))
  assert.equal(ruleBFindings.length, 5)
  for (const leakLine of leakLines) {
    assert.ok(
      ruleBFindings.some((f) => f.matched === leakLine),
      `expected "${leakLine}" to be flagged`
    )
  }
})

// --- The boundary the enumerated anti-revert above CANNOT see: this is a SIXTH shape, not one of
// the five known leaks, so a test that only re-asserts the known set would not have caught it.
// FIELD_LABEL_RE originally matched the label and the placeholder OPENER, then stopped — nothing
// required the placeholder to run to the end of the line, so trailing prose after it closes rode
// through exempt. That trailing text is slot-ADJACENT (the author's content never replaces it),
// which is exactly the shape of a leak by the same discriminator that exempts the field itself —
// "**Note:** [optional] describe the risk here..." is an instruction leak in a field-label costume.
// End-anchoring the regex closes this. Pins the boundary itself, not just the known set on either
// side of it.
test('findFenceShapeFindings: a field label followed by trailing prose after its placeholder is still flagged', () => {
  const content = [
    '~~~markdown',
    '**Note:** [optional] describe the risk here, and always cite the file you read.',
    '**Tip:** <placeholder> remember to cite path:line for every claim you make.',
    '~~~',
  ].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  const ruleBFindings = findings.filter((f) => f.fix.startsWith('move this bolded instruction'))
  assert.equal(ruleBFindings.length, 2)
  assert.ok(ruleBFindings[0]?.matched.startsWith('**Note:**'))
  assert.ok(ruleBFindings[1]?.matched.startsWith('**Tip:**'))
})

// --- A SEVENTH shape, also not covered by the enumerated anti-revert: the label charset was
// unbounded (spaces allowed, no word limit), so an entire sentence qualified as a "label". A
// one-keystroke edit (period to colon) plus a placeholder turns three of the five historical
// FLOW-149 leaks into an exempt field — the bold sentence stays in the produced document, the
// author only replaces the bracket, which is slot-ADJACENT and exactly what Rule B exists to
// catch. Bounding the label to 1-3 words closes this. These three are the real leaks with a colon
// substituted for their final period, not synthetic strings.
test('findFenceShapeFindings: a sentence cannot pose as a field label by adding a colon and a placeholder', () => {
  const content = [
    '~~~markdown',
    '**Cite evidence for what you DID verify:** [example]',
    '**Technical unknowns MUST be validated not assumed:** [list]',
    '**Always cite path/line for every claim you make:** [example]',
    '~~~',
  ].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  const ruleBFindings = findings.filter((f) => f.fix.startsWith('move this bolded instruction'))
  assert.equal(ruleBFindings.length, 3)
})

// --- The word bound alone doesn't close this: a slash chains words together as fake "one word"
// tokens, so a many-word sentence with zero spaces slips the 1-3-word count entirely. Narrowing the
// label charset to alphanumerics only (dropping `/` and `()`, which no real label ever used) closes
// it. This is a real leak shape, not a contrived string: "Always cite path/line for every claim you
// make" is the actual FLOW-202 guidance sentence, slash-joined instead of space-joined.
test('findFenceShapeFindings: slash-joined words cannot pose as a short label by hiding spaces', () => {
  const content = [
    '~~~markdown',
    '**Always/cite/path/line/for/every/claim:** [example]',
    '~~~',
  ].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  const ruleBFindings = findings.filter((f) => f.fix.startsWith('move this bolded instruction'))
  assert.equal(ruleBFindings.length, 1)
  assert.ok(ruleBFindings[0]?.matched.startsWith('**Always/cite/path/line/for/every/claim:**'))
})

// --- Documented, NOT closed by the word-count bound: a one-word label with an INSTRUCTION inside
// the bracket, rather than a noun-phrase placeholder value. All five real placeholder contents are
// noun phrases (`[TICKET-ID]`, `<the concrete failure mode(s)…>`) — separating those from an
// imperative inside a bracket would need a syntactic discriminator we don't have. The obvious one
// ("opens with an article or an all-caps token") separates today's cases and breaks on the first
// legitimate `<risk description>`, at which point it gets widened — a fragile discriminator is
// worse than a named limit, because it looks closed. Zero observed instances; not a rerun of
// FLOW-202's disproved "contains an imperative" test — that disproof was about section-description
// PROSE (killed by legitimate descriptions like "Skip this section if…" being full of imperatives);
// this population is bracketed placeholder CONTENTS, and none of the five real ones contain one.
// Different population, not re-tested here, so the disproof doesn't transfer — this is a named "we
// have no reliable test", not an inherited "already proven impossible".
//
// Shared fixture builder, same rationale as sequencingFixture (§3.6): the blind test and its
// control must differ in exactly the bracket content, nothing else, so a typo in one fixture's
// fence can't leave the other silently untouched.
const noteFieldFixture = (bracketedLine: string): string =>
  ['~~~markdown', bracketedLine, '~~~'].join('\n')

test('findFenceShapeFindings: documents a bound the label-length fix does NOT close — an imperative inside the bracket stays exempt', () => {
  const content = noteFieldFixture('**Note:** [Always validate assumptions before committing]')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  assert.deepEqual(findings, [])
})

// The limit test's non-vacuity control, same technique as the tripwire's (§3.5): a `[]` result on
// the blind fixture alone is indistinguishable between "the checker correctly exempts this shape"
// and "the checker never looked" (e.g. a later typo breaking the fence). An unbracketed leak at the
// same position — same fence, same single line, no colon/bracket shape at all — proves the fixture
// is genuinely scanned, because it only produces a finding if Rule B actually evaluated that line.
test('findFenceShapeFindings: the imperative-in-bracket fixture is live — an unbracketed leak at the same position IS flagged', () => {
  const content = noteFieldFixture('**Always validate assumptions before committing.**')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  const ruleBFindings = findings.filter((f) => f.fix.startsWith('move this bolded instruction'))
  assert.equal(ruleBFindings.length, 1)
  assert.ok(ruleBFindings[0]?.matched.startsWith('**Always validate assumptions'))
})

// --- A NINTH shape, on an axis neither the bracket nor the label limit touches: POSITION, not
// content. Rule B only flags lines that BEGIN with `**` — a bulleted instruction
// ("- **Always validate...**"), a blockquoted one ("> **Always validate...**"), or one appended to
// a sentence ("Known unknowns. **Always validate...**") is invisible. This is more realistic than
// any constructed shape in this file: bulleted guidance is ordinary authorial behaviour. Not
// closable, and not an oversight — the anchor is what keeps `1. **Story title** — Brief
// description` (a legitimate slot-occupying label in the Stories section, see "does not flag
// author-fillable placeholders" above) correctly exempt. Separating a bulleted LEAK from a bulleted
// LABEL collapses to the same noun-phrase-vs-imperative undecidability as the bracket limit —
// dropping the anchor would flag every `**Story title**`. Zero observed instances.
//
// Shared fixture builder, same rationale as sequencingFixture (§3.6) and noteFieldFixture above:
// the blind test and its control must differ in exactly the line's own leading characters (the list
// marker), nothing else.
const nonInitialBoldFixture = (line: string): string =>
  ['~~~markdown', '## Risks', 'Known unknowns.', '', line, '~~~'].join('\n')

test("findFenceShapeFindings: documents Rule B's third limit — a bulleted instruction is not line-initial, so it is not flagged", () => {
  const content = nonInitialBoldFixture('- **Always validate assumptions before committing.**')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  assert.deepEqual(findings, [])
})

// The limit test's non-vacuity control, same technique as the bracket limit's (above) and the
// tripwire's (§3.5): the same line, with only the list marker removed so it becomes line-initial,
// asserting it IS flagged. Proves the fixture is genuinely scanned rather than silently skipped.
test('findFenceShapeFindings: the bulleted-instruction fixture is live — the same line made line-initial IS flagged', () => {
  const content = nonInitialBoldFixture('**Always validate assumptions before committing.**')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  const ruleBFindings = findings.filter((f) => f.fix.startsWith('move this bolded instruction'))
  assert.equal(ruleBFindings.length, 1)
  assert.ok(ruleBFindings[0]?.matched.startsWith('**Always validate assumptions'))
})

// --- Real history: the four bolded in-fence leaks FLOW-202 removed, in one file (Rule B).
test(
  'findFenceShapeFindings: 1351aac architecture-reference.md — all four bolded historical in-fence leaks are caught',
  { skip: historySkip('1351aac') },
  () => {
    const content = gitShow('1351aac', 'skills/architecture/references/architecture-reference.md')
    const findings = findFenceShapeFindings(
      content,
      'skills/architecture/references/architecture-reference.md'
    )
    assert.equal(findings.length, 4)
    assert.equal(findings.filter((f) => f.fix.startsWith('move this bolded instruction')).length, 4)
  }
)

// --- The gap: unbolded prose inside the fence is not flagged by Rule B. This gap covers both prose
// the template deliberately keeps (the Sequencing guidance below) and real leaks that merely happen
// to be unbolded — 1351aac's "An Ilograph walkthrough is an additional companion when available,
// never the substitute." sat inside the fence, unbolded; Rule B does not flag it when run against
// 1351aac's text, even though FLOW-202 (737aff1f) moved it out of the fence as a real leak.
//
// A SYNTHETIC fixture, deliberately not a pin against real file content or line numbers: an earlier
// version of this test read architecture-reference.md off disk and asserted an exact line's exact
// prose. That coupled the test to live wording it doesn't need — any legitimate edit to
// `## Sequencing`, or an unrelated insertion above that line, would fail it for a reason that tells
// the maintainer nothing (its `deepEqual(findings, [])` half was already covered by the
// TEMPLATE_FILES loop above, so the pin added no real coverage). This fixture documents a fact
// about the CHECKER's blind spot, not a fact about one file's current text.
// Shared base for the tripwire test and its non-vacuity control below: the two fixtures must
// differ in EXACTLY the bolded-vs-unbolded gap paragraph, nothing else. Two separate string
// literals only hold that property by inspection — a typo introduced into one fixture's fence
// (breaking the region so the checker silently stops scanning) would leave the other's copy
// untouched, and both tests would stay green while the vacuity the control exists to catch went
// undetected. Building both from one function makes "differ in exactly one dimension" structural:
// a fence typo in the shared base breaks both tests identically, not just one.
const sequencingFixture = (gapParagraph: string[]): string =>
  [
    '~~~markdown',
    '## The change at a glance',
    '',
    '```mermaid',
    'graph TD',
    '    A --> B',
    '```',
    '',
    '## Sequencing',
    'What needs to be built first. Dependencies between pieces.',
    '',
    ...gapParagraph,
    '~~~',
  ].join('\n')

test('findFenceShapeFindings: documents the known gap — unbolded prose in the fence is not flagged', () => {
  const content = sequencingFixture([
    'Unbolded prose describing sequencing guidance for the author to follow — the deliberate,',
    'documented gap this test exists to record, not a leak this checker is meant to catch.',
  ])
  const findings = findFenceShapeFindings(content, 'fixture.md')
  assert.deepEqual(findings, [])
})

// The tripwire's non-vacuity control, COMMITTED rather than run once and discarded: the exact same
// fixture as above, with the unbolded gap paragraph replaced by a bolded one. A `[]` result on the
// unbolded fixture only means something if SOME input at that same position produces a finding —
// otherwise `[]` is indistinguishable from the checker never having looked (e.g. a later typo that
// breaks the outer fence and silently stops scanning would give the identical `[]`). This is the
// same technique as the indentation-tolerance test above (a Rule B leak that only survives if the
// region is genuinely scanned) — applied here because the tripwire's entire assertion is negative,
// so it needs the positive control committed, not just eyeballed during development.
test('findFenceShapeFindings: the tripwire fixture is live — the same position, bolded, IS flagged', () => {
  const content = sequencingFixture([
    '**Bolded sequencing guidance for the author to follow — the control proving the fixture above',
    'is genuinely scanned, not skipped.**',
  ])
  const findings = findFenceShapeFindings(content, 'fixture.md')
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.matched.startsWith('**Bolded sequencing guidance'))
})

// --- Fail closed on a malformed fence, not open. If the outer fence never closes, the checker must
// not go silently clean — a malformed template getting zero scrutiny is worse than a checker that
// doesn't exist, because it *reads* as verified. Mirrors validate-mermaid/blocks.ts's
// `unterminated: true` handling rather than diverging from it.
test('findFenceShapeFindings: an unterminated outer fence is flagged, not silently skipped', () => {
  const content = [
    'Template:',
    '',
    '~~~markdown',
    '# [Title] — Architecture',
    '',
    '**Jira:** [TICKET-ID]',
    '',
    '## The change at a glance',
    '',
    '```mermaid',
    'graph TD',
    '    A --> B',
    '```',
    '',
    '**Bolded leak.** Still checked after the unterminated fence.',
    '',
    '## Overview',
    'High-level summary.',
    // no closing ~~~ — the fence never terminates
  ].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')

  const unterminated = findings.filter((f) => f.fix.includes('never closed'))
  assert.equal(unterminated.length, 1)
  assert.equal(unterminated[0]?.line, 3)
  assert.equal(unterminated[0]?.matched, '~~~markdown')

  // The region still runs to EOF and still gets checked — the bolded leak inside it is still
  // caught, not swallowed by the unterminated state.
  assert.ok(findings.some((f) => f.fix.startsWith('move this bolded instruction')))
})

test('findFenceShapeFindings: a terminated fence with content after the leaked line is unaffected by the unterminated check', () => {
  const content = [
    '~~~markdown',
    '## The change at a glance',
    '',
    '```mermaid',
    'graph TD',
    '```',
    '',
    '## Overview',
    'ok',
    '~~~',
  ].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  assert.equal(
    findings.filter((f) => f.fix.includes('never closed')).length,
    0,
    'a properly closed fence must not be flagged as unterminated'
  )
})

// --- The outer-fence parser mirrors blocks.ts semantics: same-or-longer run closes it, leading
// indentation is tolerated. A close fence SHORTER than the open run must not close it.
test('findFenceShapeFindings: a shorter closing run does not close a longer opening fence', () => {
  const content = [
    '~~~~markdown',
    '## The change at a glance',
    '',
    '```mermaid',
    'graph TD',
    '```',
    '',
    '## Overview',
    'ok',
    '~~~', // 3 tildes — shorter than the 4-tilde open — does not close it
    'more content that is still "inside" the unterminated fence',
  ].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  assert.equal(findings.filter((f) => f.fix.includes('never closed')).length, 1)
})

test('findFenceShapeFindings: a same-or-longer closing run does close the fence', () => {
  const content = [
    '~~~~markdown',
    '## The change at a glance',
    '',
    '```mermaid',
    'graph TD',
    '```',
    '',
    '## Overview',
    'ok',
    '~~~~~', // 5 tildes — at least as long as the 4-tilde open — closes it
  ].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  assert.deepEqual(findings, [])
})

// --- The outer fence only recognized tildes, so identical template
// content was checked or invisible purely by which delimiter it used. Four real backtick-fenced
// `markdown` blocks were entirely out of scope — including skills/jtbd/references/jtbd-reference.md's
// PRD template, the exact document class FLOW-202's leak appeared in. blocks.ts already handles
// both delimiters generically for the inner mermaid fence; this brings the outer fence into parity.
// A backtick-fenced template (no nested ```mermaid — real backtick-fenced blocks in this repo don't
// nest one, unlike the tilde-fenced glance templates) with the same Rule B leak as the tilde test
// above must produce the same finding.
test('findFenceShapeFindings: a backtick-fenced markdown block is checked the same as a tilde-fenced one', () => {
  const content = [
    'Template:',
    '',
    '```markdown',
    '# [Title] — PRD',
    '',
    '**Jira:** [TICKET-ID]',
    '',
    '## Risks',
    'Known unknowns.',
    '',
    '**Technical unknowns MUST be validated, not assumed.** Some more instruction text.',
    '```',
  ].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  const ruleBFindings = findings.filter((f) => f.fix.startsWith('move this bolded instruction'))
  assert.equal(ruleBFindings.length, 1)
  assert.ok(ruleBFindings[0]?.matched.startsWith('**Technical unknowns MUST be validated'))
})

// A tilde run must not close a backtick-opened fence, mirroring blocks.ts's same-character
// requirement. Constructed so the assertion is behavioral, not just a regex claim: if the `~~~`
// line incorrectly closed the ``` region, the leak line below it would fall OUTSIDE any fenced
// region and produce ZERO findings (Rule B only scans inside detected regions). It only appears if
// the region correctly stayed open past the mismatched delimiter, all the way to the real
// backtick close.
test('findFenceShapeFindings: a tilde run does not close a backtick-opened fence', () => {
  const content = [
    '```markdown',
    '~~~',
    '**Leak after the tilde line that must not have closed the fence.**',
    '```',
  ].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  const ruleBFindings = findings.filter((f) => f.fix.startsWith('move this bolded instruction'))
  assert.equal(ruleBFindings.length, 1)
})

// Deliberately NOT a "findings is empty" assertion: if the indented open marker fails to match,
// findOuterFencedRegions finds zero regions and findFenceShapeFindings returns [] via its early
// exit — the same empty result an indentation bug would produce. A real Rule B leak planted inside
// the indented fence is the positive control: it only appears in the output if the region was
// actually found and scanned, so it proves indentation tolerance rather than assuming it.
test('findFenceShapeFindings: leading indentation on the outer fence markers themselves is tolerated', () => {
  const content = [
    '  ~~~markdown',
    '## The change at a glance',
    '',
    '```mermaid',
    'graph TD',
    '```',
    '',
    '## Risks',
    '**Bolded leak.** Proves the indented region was actually scanned, not skipped.',
    '  ~~~',
  ].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.matched.startsWith('**Bolded leak.**'))
})

// --- The test above indents only the fence MARKERS — every body
// line sits at column 0, so it never exercises an indented BODY. That gap let a real fail-open
// through: findOuterFencedRegions tolerates indentation on fence markers, but GLANCE_HEADING_RE,
// HEADING_RE, and BOLD_LEAD_IN_RE all anchored at column 0 — an indented template body (the real
// shape of a fence nested under a numbered list item, e.g.
// skills/process-improvement-notes/SKILL.md) was found as a region and then matched by nothing. The
// file read clean while a leak sat inside it. This fixture indents the WHOLE body — heading,
// diagram, and bolded leak alike — mirroring that real nested-list shape, and asserts it IS still
// flagged. This is the test that would have caught the gap; the marker-only test above did not,
// and is kept because the two cover different things.
test('findFenceShapeFindings: an indented template BODY (not just indented fence markers) is still scanned', () => {
  const content = [
    '1. Create the notes file with this template:',
    '',
    '   ~~~markdown',
    '   ## The change at a glance',
    '',
    '   ```mermaid',
    '   graph TD',
    '   ```',
    '',
    '   ## Risks',
    '   **Bolded leak inside an indented body.** This is the exact shape CodeRabbit found.',
    '   ~~~',
  ].join('\n')
  const findings = findFenceShapeFindings(content, 'fixture.md')
  const ruleBFindings = findings.filter((f) => f.fix.startsWith('move this bolded instruction'))
  assert.equal(ruleBFindings.length, 1)
  assert.ok(ruleBFindings[0]?.matched.includes('Bolded leak inside an indented body'))
})
