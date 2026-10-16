import { test } from 'node:test'
import assert from 'node:assert/strict'
import { globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { findQuestionFlagFindings } from './question-flags.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const FILE = 'hooks/example.sh'
const MD_FILE = 'skills/example.md'

test('a bare invocation produces one finding whose fix names all three flags', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --prompt "..."',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--recommend'))
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(findings[0]?.fix.includes('--why-mine'))
})

test('a line carrying all four required flags produces none', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --recommend "x" --stalls none --why-mine scope --prompt "p"',
    FILE
  )
  assert.equal(findings.length, 0)
})

test('a line carrying two of four required flags names only the missing ones in fix', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --stalls none --why-mine scope',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--recommend'))
  assert.ok(findings[0]?.fix.includes('--prompt'))
  assert.ok(!findings[0]?.fix.includes('--stalls'))
  assert.ok(!findings[0]?.fix.includes('--why-mine'))
})

test('a backslash-continued invocation whose flags are on continuation lines produces none, under LF line endings', () => {
  const content = [
    'dashboard item add --type question \\',
    '  --recommend "x" \\',
    '  --stalls none \\',
    '  --why-mine scope \\',
    '  --prompt "p"',
  ].join('\n')
  const findings = findQuestionFlagFindings(content, FILE)
  assert.equal(findings.length, 0)
})

test('a backslash-continued invocation still missing a flag produces one finding, anchored on the first line', () => {
  const content = [
    'dashboard item add --type question \\',
    '  --recommend "x" \\',
    '  --stalls none',
  ].join('\n')
  const findings = findQuestionFlagFindings(content, FILE)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.line, 1)
  assert.ok(findings[0]?.fix.includes('--why-mine'))
})

test('two invocations in one file produce two findings with distinct line values', () => {
  const content = [
    'dashboard item add --type question --prompt "one"',
    '',
    'dashboard item add --type question --prompt "two"',
  ].join('\n')
  const findings = findQuestionFlagFindings(content, FILE)
  assert.equal(findings.length, 2)
  assert.equal(findings[0]?.line, 1)
  assert.equal(findings[1]?.line, 3)
})

test('col points at the start of the matched invocation, not at column 1', () => {
  const findings = findQuestionFlagFindings('run: dashboard item add --type question', FILE)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.col, 16)
})

test('a bare --type=question invocation is caught the same as --type question', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type=question --prompt "..."',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--recommend'))
})

// Documents the check's known limitation (see the comment in question-flags.ts): it matches
// `item add --type` as a contiguous literal, so a bare invocation whose flags are reordered so
// `--type` no longer immediately follows `item add` is a real miss, not a bug to fix here.
test('a bare invocation with --type reordered away from item add is a documented miss', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --prompt "..." --type question',
    FILE
  )
  assert.equal(findings.length, 0)
})

// Documents stripQuotedValues's known limitation (see the comment in question-flags.ts): an
// unterminated quote has no closing match in argument-value position, so the span is left unstripped
// and a required flag's name sitting inside the unterminated value satisfies the presence check for
// the real flag.
test('a required flag hidden inside an unterminated quoted value is a documented miss', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --prompt "p" --recommend "unclosed --stalls none --why-mine scope',
    FILE
  )
  assert.equal(findings.length, 0)
})

// A second, balanced-count instance of the same limitation: the quote count is even (2), but the
// closing quote is followed by "x" instead of a delimiter, so the lookahead rejects it as a close and
// the span is left unstripped — the limitation is about quote position, not quote parity.
test('a required flag hidden inside a value closed against a non-delimiter is a documented miss', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --prompt "use --recommend a --stalls b --why-mine c"x',
    FILE
  )
  assert.equal(findings.length, 0)
})

// A third instance of the unterminated-region limitation, not the escape mechanism failing: when the
// character the escape consumes is the value's own would-be closing quote and nothing unescaped of
// the same kind follows it, the region never actually closes — it only looks closed at a glance.
test('a required flag hidden inside a value whose only closing quote is itself backslash-escaped is a documented miss', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --recommend r --why-mine w --prompt "note --stalls x\\"',
    FILE
  )
  assert.equal(findings.length, 0)
})

// Same shape in the single-quote arm, isolated from the double-quote arm above.
test('a required flag hidden inside a single-quoted value whose only closing quote is itself backslash-escaped is a documented miss', () => {
  const findings = findQuestionFlagFindings(
    "dashboard item add --type question --recommend r --why-mine w --prompt 'note --stalls x\\'",
    FILE
  )
  assert.equal(findings.length, 0)
})

// A longer option name that merely starts with a required flag (--recommendation vs. --recommend)
// must not satisfy the presence check via substring match.
test('a line carrying --recommendation (not --recommend) is treated as missing --recommend', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --recommendation "x" --stalls none --why-mine scope',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--recommend'))
})

// Negative control for the token-boundary fix: the = form of a flag must still count as present.
test('a line carrying --why-mine=scope (the = form) is not reported as missing --why-mine', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --recommend "x" --stalls none --why-mine=scope --prompt "p"',
    FILE
  )
  assert.equal(findings.length, 0)
})

// A required flag's name appearing inside a quoted argument value must not satisfy the presence
// check for the real flag — --stalls here is genuinely absent; it only appears as text inside
// --recommend's quoted value.
test('a required flag name appearing only inside a quoted value is treated as missing', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --recommend "discuss --stalls none" --why-mine scope',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(!findings[0]?.fix.includes('--recommend'))
  assert.ok(!findings[0]?.fix.includes('--why-mine'))
})

// All three required flags are genuinely absent — the flag names only appear as prose inside
// --prompt's quoted value. Every one of the three must be named as missing, not just the one
// nearest a quote boundary.
test('all three required flags named only inside --prompt text are all reported missing', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --prompt "declare --recommend --stalls and --why-mine"',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--recommend'))
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(findings[0]?.fix.includes('--why-mine'))
})

// Pins stripQuotedValues's lookbehind anchor in isolation: a mid-word apostrophe ("user's",
// "agents'") must not open a match. Without the lookbehind, the apostrophe in "user's" pairs with
// a later, unrelated apostrophe and blanks the real flags between them — the exact regression this
// anchor exists to prevent (see the comment in question-flags.ts).
test('a mid-word apostrophe does not open a quoted-value match (lookbehind)', () => {
  const findings = findQuestionFlagFindings(
    "dashboard item add --type question — the user's call --recommend a --stalls b --why-mine c --prompt p, the agents' view",
    FILE
  )
  assert.equal(findings.length, 0)
})

// Pins stripQuotedValues's lookahead anchor in isolation: a quote closed against a non-delimiter
// (here, the "'" in "90s" and the apostrophe in "don't") must not close a match. Without the
// lookahead, the opening quote before "90s" would pair with the apostrophe in "don't" and blank the
// real flags between them.
test('a quote closed against a non-delimiter does not close a quoted-value match (lookahead)', () => {
  const findings = findQuestionFlagFindings(
    "dashboard item add --type question — back in the '90s, --recommend a --stalls b --why-mine c --prompt p, don't skip",
    FILE
  )
  assert.equal(findings.length, 0)
})

// Pins the strip's delimiter set (a backtick counts as a delimiter alongside whitespace/`=`/end): a
// quoted value whose closing quote sits against a backtick still strips. --stalls is genuinely absent
// here — its name only survives as text inside --why-mine's value, immediately before the closing
// backtick that a shipped Markdown example wraps it in.
test('a required flag hidden inside a value closing against a backtick is caught', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --recommend a --why-mine "mention --stalls none"`',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(!findings[0]?.fix.includes('--recommend'))
  assert.ok(!findings[0]?.fix.includes('--why-mine'))
})

// Pins the presence check's own delimiter set: a flag written as Markdown inline code (backtick
// immediately against the flag name, no whitespace) still reads as present — the false-positive
// direction, which blocks the repo rather than merely missing a real defect.
test('a flag written as markdown inline code is recognized as present', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question `--recommend a` --stalls b --why-mine c --prompt p',
    FILE
  )
  assert.equal(findings.length, 0)
})

// Pins the quoted-region content exclusion: a stray backtick inside a malformed span must not let two
// unrelated quote characters pair across it and blank real, present flags between them. All three
// flags here are genuinely present as plain tokens; only the surrounding quote/backtick punctuation is
// unusual.
test('quote characters do not pair across an intervening backtick and blank real flags', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --prompt "x` `--recommend a --stalls b --why-mine c` `y"',
    FILE
  )
  assert.equal(findings.length, 0)
})

// Same pairing-must-not-happen guarantee in the single-quote arm, isolated from the double-quote arm
// above: a stray backtick pair inside a single-quoted span must not let the two single quotes pair
// across it and blank real, present flags between them.
test('quote characters do not pair across an intervening backtick in the single-quote arm', () => {
  const findings = findQuestionFlagFindings(
    "dashboard item add --type question --prompt 'x `--recommend a --stalls b --why-mine taste` y'",
    FILE
  )
  assert.equal(findings.length, 0)
})

// Pins the escape mechanism a region's content admits (see the comment in question-flags.ts): a
// backslash-escaped quote inside a quoted value no longer closes the region early, so the value
// strips as one whole match and --stalls — genuinely absent, appearing only as prose inside
// --recommend's escaped-quote value — is caught as missing.
test('a required flag hidden inside a value containing a backslash-escaped inner quote is caught', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --recommend "write \\"note\\" about --stalls later" --why-mine scope',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(!findings[0]?.fix.includes('--recommend'))
  assert.ok(!findings[0]?.fix.includes('--why-mine'))
})

// Same escape guarantee in the single-quote arm, isolated from the double-quote arm above: a
// backslash-escaped inner single quote no longer closes the region early either.
test('a required flag hidden inside a single-quoted value containing a backslash-escaped inner quote is caught', () => {
  const findings = findQuestionFlagFindings(
    "dashboard item add --type question --recommend 'write \\'note\\' about --stalls later' --why-mine scope",
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(!findings[0]?.fix.includes('--recommend'))
  assert.ok(!findings[0]?.fix.includes('--why-mine'))
})

// Pins that a quoted value can span a continuation boundary at all: the value opens on the first
// physical line and its closing quote sits on the next, joined by a trailing backslash. Because the
// continuation join runs before stripQuotedValues ever sees the span (see the comment in
// question-flags.ts), the joined span carries no embedded newline — the two physical lines read as
// one ordinary single-line quoted value once joined, no escape mechanism required. --stalls sits past
// the close and is genuinely absent outside the quoted value.
test('a required flag hidden inside a quoted value that continuation-joins across two lines is caught', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --recommend "line one\\\nline two --stalls x" --why-mine scope',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(!findings[0]?.fix.includes('--recommend'))
  assert.ok(!findings[0]?.fix.includes('--why-mine'))
})

// Pins that the escape excludes the backtick on purpose (see the comment in question-flags.ts): even
// when every backtick in a malformed span is itself backslash-escaped, the backtick still acts as a
// hard delimiter rather than being swallowed as escaped content — the same pairing-must-not-happen
// shape as 'quote characters do not pair across an intervening backtick and blank real flags' above,
// so escaping the backticks cannot be used to smuggle two unrelated quote characters past that guard.
test('an escaped backtick does not open the region content to the pairing guard it protects against', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --prompt "x\\` \\`--recommend a --stalls b --why-mine c\\` \\`y"',
    FILE
  )
  assert.equal(findings.length, 0)
})

// Pins the strip's lookbehind anchor's backtick member: a quoted value that OPENS immediately
// against a backtick still strips. The quote CLOSES at end of span, so this fixture also depends on
// the lookahead `$` member (pinned by 'all three required flags named only inside --prompt text are
// all reported missing'); reverting the lookbehind's backtick alternative alone reds only this test.
// All three flags sit inside the quoted region, so a correct strip reports all three missing; failing
// to recognize the backtick as a valid open delimiter leaves the region unstripped, and only
// --recommend (the one flag not also preceded by a plain space inside the region) would fail the
// presence check.
test('a required flag hidden inside a value opening against a backtick is caught along with its siblings', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question `"--recommend a --stalls b --why-mine taste"',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--recommend'))
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(findings[0]?.fix.includes('--why-mine'))
})

// Pins the presence check's close-side backtick member, isolated from the open-side member pinned by
// 'a flag written as markdown inline code is recognized as present' above: a flag immediately followed
// by a backtick with no intervening whitespace still reads as present.
test('a flag immediately followed by a backtick is recognized as present (close-side backtick)', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --recommend` --stalls b --why-mine c --prompt p',
    FILE
  )
  assert.equal(findings.length, 0)
})

// Pins the accepted regression the backtick content exclusion introduces (see the comment in
// question-flags.ts): --stalls appears only as prose inside --why-mine's quoted value, but the value
// itself wraps --stalls in its own pair of backticks, so --stalls reads as present via its backtick
// neighbors even though the enclosing quoted region never stripped. This is a documented miss, not a
// bug to fix here — the inner backticks are what stop the enclosing region from being treated as a
// strippable quoted value at all; the false positive that exclusion actually fixes (two unrelated
// quote characters pairing across a stray backtick and blanking real, present flags) is pinned by
// 'quote characters do not pair across an intervening backtick and blank real flags' above.
test('a required flag named only inside a value that wraps it in its own backticks is a documented miss', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --recommend a --prompt p --why-mine "mention `--stalls` none"',
    FILE
  )
  assert.equal(findings.length, 0)
})

// Pins stripQuotedValues's lookbehind anchor's `=` member: a quoted value that OPENS immediately
// against `=` (the --prompt="..." form) still strips. The quote also closes at end of span, so this
// fixture also depends on the lookahead `$` member (pinned by 'all three required flags named only
// inside --prompt text are all reported missing'); reverting the lookbehind's `=` alternative alone
// reds only this test.
test('a required flag hidden inside a value opening against = is caught along with its siblings', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --prompt="use --recommend a --stalls b --why-mine c"',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--recommend'))
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(findings[0]?.fix.includes('--why-mine'))
})

// Pins the presence check's close-side `$` member: a flag as the final token in the span, with
// nothing following it, still reads as present. The other two flags in this fixture are each
// followed by a space, pinning the close-side whitespace member pinned by 'a line carrying all three
// flags produces none'.
test('a flag as the final token in the span is recognized as present (close-side end-of-span)', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --recommend a --stalls b --prompt p --why-mine',
    FILE
  )
  assert.equal(findings.length, 0)
})

// Pins the presence check's open-side `^` member: a flag as the first token in the span, with
// nothing preceding it, still reads as present.
test('a flag as the first token in the span is recognized as present (open-side start-of-span)', () => {
  const findings = findQuestionFlagFindings(
    '--why-mine taste dashboard item add --type question --recommend a --stalls b --prompt p',
    FILE
  )
  assert.equal(findings.length, 0)
})

// Pins the presence check's excluded open-side member: `=` deliberately does NOT open a match, so a
// flag name glued to a DIFFERENT flag's `=` value (here --prompt=--recommend) does not read as the
// real --recommend flag being present. --prompt itself is still present (a plain space opens it, `=`
// closes it), so only --recommend is reported missing.
test('a flag name glued to a different flag’s "=" value is not recognized as present (excluded open-side =)', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --prompt=--recommend --stalls b --why-mine c',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.fix.includes('--recommend'), true)
  assert.equal(findings[0]?.fix.includes('--stalls'), false)
  assert.equal(findings[0]?.fix.includes('--prompt'), false)
})

// Pins stripQuotedValues's lookbehind anchor's `^` member: a quoted value that opens at the very
// start of the span still strips. The quote also closes against a plain space, so this fixture also
// depends on the lookahead's `\s` member; reverting that member alone reds both this test and 'a
// required flag name appearing only inside a quoted value is treated as missing' above (its own
// quoted value likewise closes against a space) — not just this one.
test('a required flag hidden inside a value opening at the start of the span is caught along with its sibling', () => {
  const findings = findQuestionFlagFindings(
    '"use --recommend a --stalls b" dashboard item add --type question --why-mine c',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--recommend'))
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(!findings[0]?.fix.includes('--why-mine'))
})

// --- stripQuotedValues's full modelled surface: alternation arms, content-class exclusions, `g` ---

// Pins the single-quote arm's actual stripping duty. Every existing single-quote-arm test above
// ('a mid-word apostrophe...', 'a quote closed against a non-delimiter...', 'quote characters do not
// pair across an intervening backtick in the single-quote arm') asserts findings.length === 0 —
// each pins a case where the arm correctly refuses to strip, none pins a case where it actually
// strips. Deleting the single-quote arm entirely does not red any of them; only a fixture whose
// missing-flag count depends on the strip having happened does.
test("a required flag hidden inside a single-quoted value is caught, pinning the single-quote arm's stripping duty", () => {
  const findings = findQuestionFlagFindings(
    "dashboard item add --type question --prompt='use --recommend a --stalls b --why-mine c'",
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--recommend'))
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(findings[0]?.fix.includes('--why-mine'))
})

// Pins the double-quote arm's own-quote content-class exclusion: two separate double-quoted regions
// in one span, neither hiding a required flag. Dropping the exclusion (widening the arm's content
// class to admit `"`) makes the first region's opening quote pair with the second region's closing
// quote instead, blanking the literal, unquoted --stalls and --why-mine tokens that sit between them.
test('two double-quoted values in one span do not blank the plain flags between them (double-quote own-quote exclusion)', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --recommend "a" --stalls none --why-mine "taste" --prompt "p"',
    FILE
  )
  assert.equal(findings.length, 0)
})

// Mirrors the double-quote case above for the single-quote arm's own-quote content-class exclusion.
test('two single-quoted values in one span do not blank the plain flags between them (single-quote own-quote exclusion)', () => {
  const findings = findQuestionFlagFindings(
    "dashboard item add --type question --recommend 'a' --stalls none --why-mine 'taste' --prompt 'p'",
    FILE
  )
  assert.equal(findings.length, 0)
})

// Pins the regex's `g` flag: two strippable regions on one span — a single-quoted first region and a
// double-quoted second, the second (not the first) hiding a required flag name. Without `g`,
// String.replace stops after the first region, leaving the second's --stalls readable as a literal
// token and the finding disappears. One region of each arm keeps this isolated from both own-quote
// exclusions: with nothing of its own arm left to pair against, dropping either exclusion has no
// second same-arm region to fuse with and the count does not move.
test('a required flag hidden in the second of two quoted regions on one span is still caught (g flag)', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --recommend \'a\' --why-mine b --prompt "mention --stalls only here"',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(!findings[0]?.fix.includes('--recommend'))
  assert.ok(!findings[0]?.fix.includes('--why-mine'))
})

// --- CommonMark line endings: \n, \r, and \r\n all scan the same ---

// Reproduces the CR-only silent degradation directly: an unrelated later line that happens to name
// two of the three flags must not satisfy the presence check for a bare invocation on an earlier
// line. Splitting on \n alone collapses a CR-only file into a single "line" spanning the whole
// file, so the unrelated line's flag names leak into the invocation's own span.
test('a bare invocation is not fooled by an unrelated later line naming the flags, under CR-only line endings', () => {
  const content = [
    'dashboard item add --type question',
    'Elsewhere the doc mentions --stalls and --why-mine for style.',
  ].join('\r')
  const findings = findQuestionFlagFindings(content, FILE)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.line, 1)
  assert.ok(findings[0]?.fix.includes('--recommend'))
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(findings[0]?.fix.includes('--why-mine'))
})

// Distinct from the miss above: even when the unrelated-flag leak doesn't apply, a CR-only file
// collapsed to one "line" reports every finding at line 1, regardless of which logical line the
// invocation is actually on.
test('a bare invocation is reported at its own logical line number, not line 1, under CR-only line endings', () => {
  const content = [
    'Intro text with no invocation here.',
    'dashboard item add --type question --prompt "x"',
  ].join('\r')
  const findings = findQuestionFlagFindings(content, FILE)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.line, 2)
})

// Confirms the close-side `$` lookahead isn't fooled by a trailing \r under CRLF: a flag as the
// last token before a CRLF line ending still reads as present.
test('a flag as the last token before a CRLF line ending is still recognized as present', () => {
  const content =
    'dashboard item add --type question --recommend a --stalls b --prompt p --why-mine\r\nNext line unrelated.'
  const findings = findQuestionFlagFindings(content, FILE)
  assert.equal(findings.length, 0)
})

// Confirms the continuation join isn't fooled by a trailing \r under CRLF: splitLines already
// consumes a CRLF pair as one delimiter, so the split line's own trailing backslash is the last
// character the join sees, with no stray \r after it.
test('a backslash-continued invocation whose flags are on continuation lines produces none, under CRLF line endings', () => {
  const content = [
    'dashboard item add --type question \\',
    '  --recommend "x" \\',
    '  --stalls none \\',
    '  --why-mine scope \\',
    '  --prompt "p"',
  ].join('\r\n')
  const findings = findQuestionFlagFindings(content, FILE)
  assert.equal(findings.length, 0)
})

// --- Continuation join runs before the match, not after (see the comment in question-flags.ts) ---

// The corpus's actual gap: `item add` and `--type question` on separate physical lines, joined by a
// trailing backslash. Matching against the raw physical line before joining never sees this
// invocation at all — INVOCATION_PATTERN never matches a line containing only `item add`. Joining
// first, then matching the joined span, is what makes it visible.
test('an invocation whose "item add" and "--type question" are split across a continuation line is caught', () => {
  const content = [
    'dashboard item add \\',
    '  --type question \\',
    '  --recommend "x" \\',
    '  --stalls none',
  ].join('\n')
  const findings = findQuestionFlagFindings(content, FILE)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.line, 1)
  assert.ok(findings[0]?.fix.includes('--why-mine'))
  assert.ok(!findings[0]?.fix.includes('--recommend'))
  assert.ok(!findings[0]?.fix.includes('--stalls'))
})

// Pins `col` and `matched` for a multi-line invocation where the match itself starts on the FIRST
// physical line: `col` is 1-based, relative to that line's own start, which here is the same as its
// offset within the joined span since nothing precedes it on line 1. `matched` is sliced from the
// match's own start (not the span's, and not the physical line's) to the span's end, so it carries
// this invocation's own text — "item add", not the "dashboard " that precedes it — and crosses onto
// the second physical line to pick up its flags; the three spaces between `add` and `--type` are the
// trailing space before the deleted backslash plus the next line's own two-space indentation, with no
// separator inserted between them. This fixture cannot exercise a match that starts on a LATER
// physical line than the one the walk began at — see the next test for that case.
test('col and matched reflect the invocation itself, from its own match to the span end, not the whole span', () => {
  const content = ['dashboard item add \\', '  --type question --prompt "x"'].join('\n')
  const findings = findQuestionFlagFindings(content, FILE)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.line, 1)
  assert.equal(findings[0]?.col, 11)
  assert.equal(findings[0]?.matched, 'item add   --type question --prompt "x"')
})

// The match itself begins on the SECOND physical line, inside a fenced bash block so the join still
// runs: line 1's own "item add" is decorative prose, not immediately followed by "--type", so it
// contributes no match of its own — the real "item add ... --type question" text starts only once
// line 2 is appended. `line`/`col` must point at line 2 and a column relative to line 2's own start,
// not at line 1 (the walk's start) with a column that is only meaningful as an offset into the
// joined span — which, projected onto line 1's own 33-character length, would point past its end.
test('col and line are attributed to the physical line the match actually starts on, not the line the join started at', () => {
  const content = [
    '```bash',
    '# reminder: item add needs care \\',
    'dashboard item add --type question --recommend a --stalls b --why-mine c',
    '```',
  ].join('\n')
  const findings = findQuestionFlagFindings(content, 'skills/example.md')
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.line, 3)
  assert.equal(findings[0]?.col, 11)
  assert.ok(findings[0]?.fix.includes('--prompt'))
})

// The pre-filter's own limit (see the comment in question-flags.ts): an invocation whose own `item
// add` is itself split across the continuation boundary never reaches the join, because the line
// that would trigger it — `dashboard item \` — doesn't contain the literal substring `item add`.
test('an invocation whose own "item add" is split across a continuation boundary is a documented miss', () => {
  const content = ['dashboard item \\', '  add --type question --prompt "x"'].join('\n')
  const findings = findQuestionFlagFindings(content, FILE)
  assert.equal(findings.length, 0)
})

// --- stripQuotedValues's `=` close delimiter ---

// Pins the `=` close-delimiter shape directly (see the comment in question-flags.ts): a quoted value
// immediately followed by `=` still closes and strips. --stalls sits inside this quoted value, so a
// correct strip reports it missing; without the `=` close, the region is left unstripped and
// --stalls's plain-space neighbors inside it would satisfy the presence check regardless of the
// surrounding quotes, reading as present instead.
test('a quoted value hiding a flag and closing against = is still stripped and the flag reported missing', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --recommend "use --stalls b"=x --why-mine c',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(!findings[0]?.fix.includes('--recommend'))
  assert.ok(!findings[0]?.fix.includes('--why-mine'))
})

// --- An entire invocation wrapped in one quoted region (e.g. `echo "…"`) is scanned, not blanked ---

// A complete, correct invocation wrapped by a shell `echo "…"` opens and closes its outer quote
// against delimiters exactly as legitimately as an ordinary argument value does — stripQuotedValues
// must not blank it wholesale just because it happens to be quoted.
test('a complete invocation wrapped in one quoted region (echo "...") produces no findings', () => {
  const findings = findQuestionFlagFindings(
    'echo "dashboard item add --type question --recommend R --stalls none --why-mine taste --prompt P"',
    FILE
  )
  assert.equal(findings.length, 0)
})

// The broken sibling of the test above: the same outer-quote wrapping, but genuinely missing three
// of the four flags. Before the fix, this and the correct case above were byte-identical (both
// reported all four flags missing) because the whole region was blanked; now the wrapped text is
// scanned like any other line, and only the flags actually absent are reported.
test('an incomplete invocation wrapped in one quoted region (echo "...") names only the flags actually missing', () => {
  const findings = findQuestionFlagFindings(
    'echo "dashboard item add --type question --prompt P"',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--recommend'))
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(findings[0]?.fix.includes('--why-mine'))
  assert.ok(!findings[0]?.fix.includes('--prompt'), '--prompt is present in the wrapped text')
})

// Same shape reproduced in Markdown, inside a fenced block (the corpus's actual echo-emitting
// shape, e.g. a hook script quoted in a fenced example).
test('a complete invocation wrapped in one quoted region reproduces the same fix in Markdown', () => {
  const content = [
    '```bash',
    'echo "dashboard item add --type question --recommend R --stalls none --why-mine taste --prompt P"',
    '```',
  ].join('\n')
  assert.equal(findQuestionFlagFindings(content, MD_FILE).length, 0)
})

// --- The gate omits --prompt: --type question's own mandatory flag ---

// The declaration-flag trio can be fully present and the gate still owes a finding, because
// --prompt is a Stricli parse-time requirement, not one item.ts itself enforces.
test('a line carrying all three declaration flags but missing --prompt is caught', () => {
  const findings = findQuestionFlagFindings(
    'dashboard item add --type question --recommend a --stalls b --why-mine c',
    FILE
  )
  assert.equal(findings.length, 1)
  assert.ok(findings[0]?.fix.includes('--prompt'))
  assert.ok(!findings[0]?.fix.includes('--recommend'))
  assert.ok(!findings[0]?.fix.includes('--stalls'))
  assert.ok(!findings[0]?.fix.includes('--why-mine'))
})

// --- The join is restricted to fenced code in Markdown ---

// A trailing backslash outside a fence is a CommonMark hard line break, not a shell continuation:
// the prose after it must not be read as part of the invocation above it, even when that prose
// happens to name the very flags the invocation is missing.
test('an unfenced Markdown hard line break does not join the invocation to the following prose', () => {
  const content = [
    'dashboard item add --type question --recommend a \\',
    'and remember to pass --stalls and --why-mine too',
  ].join('\n')
  const findings = findQuestionFlagFindings(content, MD_FILE)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.line, 1)
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(findings[0]?.fix.includes('--why-mine'))
})

// Same non-join, but the line below is a second, complete invocation rather than plain prose: the
// first invocation's own missing flags must not be masked by the second one's presence, because
// outside a fence the two lines are never joined into one span at all.
test('an unfenced Markdown hard line break does not let a following complete invocation mask the first one', () => {
  const content = [
    'dashboard item add --type question --recommend a \\',
    'dashboard item add --type question --recommend x --stalls s --why-mine w --prompt p',
  ].join('\n')
  const findings = findQuestionFlagFindings(content, MD_FILE)
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.line, 1)
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(findings[0]?.fix.includes('--why-mine'))
  assert.ok(findings[0]?.fix.includes('--prompt'))
})

// The same continuation shape, but inside a fenced code block: here the trailing backslash is a
// real shell continuation again, and the join must still happen — restricting the join to fenced
// Markdown does not mean Markdown never joins, only that prose outside a fence never does.
test('the same continuation shape inside a fenced code block still joins, and passes when complete', () => {
  const content = [
    '```bash',
    'dashboard item add --type question --recommend a \\',
    '  --stalls b --why-mine c --prompt p',
    '```',
  ].join('\n')
  const findings = findQuestionFlagFindings(content, MD_FILE)
  assert.equal(findings.length, 0)
})

// Two separate invocations sharing one fenced, continuation-joined span: without global matching
// scoped per invocation, the single-match/whole-span-scan design finds the first invocation's own
// missing flags satisfied by the second invocation's flags later in the same span, and the second
// invocation is never even reached — reporting zero findings for two incomplete invocations. Global
// matching alone (without also scoping the flag search per invocation) reintroduces the same masking
// from the other direction, so this is the test that reds the index-skip-only and global-match-only
// designs alike.
test('two invocations sharing one fenced continuation-joined span each get their own finding, not masked by the other', () => {
  const content = [
    '```bash',
    'dashboard item add --type question --recommend a \\',
    'dashboard item add --type question --stalls s --why-mine w --prompt p',
    '```',
  ].join('\n')
  const findings = findQuestionFlagFindings(content, MD_FILE)
  assert.equal(findings.length, 2)
  assert.equal(findings[0]?.line, 2)
  assert.ok(findings[0]?.fix.includes('--stalls'))
  assert.ok(findings[0]?.fix.includes('--why-mine'))
  assert.ok(findings[0]?.fix.includes('--prompt'))
  assert.ok(!findings[0]?.fix.includes('--recommend'))
  assert.equal(findings[1]?.line, 3)
  assert.ok(findings[1]?.fix.includes('--recommend'))
  assert.ok(!findings[1]?.fix.includes('--stalls'))
  assert.ok(!findings[1]?.fix.includes('--why-mine'))
  assert.ok(!findings[1]?.fix.includes('--prompt'))
})

// stripQuotedValues blanks a quoted value to an equal-length run of spaces, not to the empty
// string. findQuestionFlagFindings slices `scanned` with windowStart/windowEnd offsets computed
// against `span`, not against `scanned` — a quoted value stripped to zero length inside the first
// invocation's own window shifts every later invocation's window out of alignment with the
// underlying text, dropping real flags off the front of that window.
test('a long quoted value in one invocation does not misalign a later invocation’s flag window', () => {
  const content = [
    '```bash',
    `dashboard item add --type question --recommend "${'A'.repeat(60)}" \\`,
    'dashboard item add --type question --stalls s --why-mine w --prompt p',
    '```',
  ].join('\n')
  const findings = findQuestionFlagFindings(content, MD_FILE)
  assert.equal(findings.length, 2)
  assert.ok(findings[1]?.fix.includes('--recommend'))
  assert.ok(!findings[1]?.fix.includes('--stalls'))
  assert.ok(!findings[1]?.fix.includes('--why-mine'))
  assert.ok(!findings[1]?.fix.includes('--prompt'))
})

// `matched` used to be `span.trim()` for every finding on a span, so two findings on
// the same shared span came back byte-identical — a reader could not tell which invocation either
// one was about, even though their line/col already differed correctly. `matched` is now sliced from
// each invocation's own match to the next invocation's (or the span's end), so it names its own
// invocation and excludes its sibling's flags.
test('matched carries only its own invocation, not the whole shared span', () => {
  const content = [
    '```bash',
    'dashboard item add --type question --recommend a \\',
    'dashboard item add --type question --stalls s --why-mine w --prompt p',
    '```',
  ].join('\n')
  const findings = findQuestionFlagFindings(content, MD_FILE)
  assert.equal(findings.length, 2)
  assert.notEqual(findings[0]?.matched, findings[1]?.matched)
  assert.equal(findings[0]?.matched, 'item add --type question --recommend a dashboard')
  assert.equal(findings[1]?.matched, 'item add --type question --stalls s --why-mine w --prompt p')
  assert.ok(!findings[0]?.matched.includes('--stalls'))
  assert.ok(!findings[1]?.matched.includes('--recommend'))
})

// --- Performance: a pre-filter-passing, backslash-continued line never starts a
// second, redundant walk over lines an earlier walk already consumed ---

// Times `run(n)`, taking the minimum over several trials so one GC pause or scheduler hiccup on a
// busy machine can't inflate a single sample past the ceiling below — the true cost of the work is
// its best case across trials, not whatever the noisiest one happened to be.
const timeMin = (run: (n: number) => void, n: number, trials = 5): number => {
  let min = Infinity
  for (let t = 0; t < trials; t += 1) {
    const start = performance.now()
    run(n)
    const elapsed = performance.now() - start
    if (elapsed < min) min = elapsed
  }
  return min
}

// Every line contains 'item add' and ends in a backslash, so every one of them passes the
// pre-filter — the adversarial input the pre-filter alone does not bound. 8x-ing N should roughly
// 8x the time, not roughly 64x (or worse) it; a generous ratio ceiling absorbs run-to-run noise
// while still catching a real regression back to the old per-line-restart behavior. None of
// these lines carries `--type question`, so this exercises only the walk-count axis (how many lines
// get joined) — zero matches means zero calls into the per-match cost the next test guards. See that
// next test for the axis this one is structurally blind to.
test('scanning N pre-filter-passing continuation lines grows roughly linearly with N, not quadratically', () => {
  const build = (n: number): string =>
    Array.from({ length: n }, () => 'dashboard item add \\').join('\n')
  const run = (n: number): void => {
    findQuestionFlagFindings(build(n), FILE)
  }

  timeMin(run, 500) // warm up the function before taking measurements
  const small = timeMin(run, 2000)
  const large = timeMin(run, 16000) // 8x the lines

  assert.ok(
    large < small * 15 + 5,
    `expected roughly linear growth (8x lines) but got ${small}ms -> ${large}ms`
  )
})

// A fenced span holding N complete, individually-matching invocations, each missing only --prompt —
// unlike the test above, every line matches INVOCATION_PATTERN, so this exercises the axis that used
// to be quadratic: resolving each match's physical line used to rescan a span's segments from the
// start every time (O(matches²)), and `matched` used to copy the whole span per match (O(matches ×
// span)). Growing N 64x should grow the time well under 64x², not anywhere near it. Measured on the
// machine this comment was written on (4 reps, `large` steady at 53.4–59.2ms): linear (this
// implementation) scales ~59–79x at this ratio; restoring the rescan-from-start locator this
// replaced — with its own early `break` once the owning segment is found, the shape that actually
// shipped, not an unbounded scan — as a mutant scales ~1127–2401x. A reader re-measuring on a
// different floor should expect the ratio to move (the denominator below is the noisy term — see
// `small`); a stated invariant that holds across every rep here is `large` itself staying close to
// ~55ms at N=64000, not the ratio to `small`. The ceiling below sits close enough to the linear
// figure to survive contention (~3.5–4.6x headroom over a steady `large`) while staying ~5x under
// the defect ratio — both margins measured, neither a coin flip. 9 trials (up from the default 5)
// narrows the noise floor `timeMin` reports on both sides of the comparison; `small`, not `large`, is
// the volatile one (a ~1ms min-of-9 floor moves more than a ~55ms one), and the ceiling is derived
// from it, so a favourably low `small` tightens rather than loosens the bound.
test('scanning N matching invocations on one shared span grows roughly linearly with match count, not quadratically', () => {
  const build = (n: number): string => {
    const invocation = 'dashboard item add --type question --recommend a --stalls b --why-mine c'
    const lines = ['```bash']
    for (let i = 0; i < n; i += 1) lines.push(i < n - 1 ? `${invocation} \\` : invocation)
    lines.push('```')
    return lines.join('\n')
  }
  const run = (n: number): void => {
    const findings = findQuestionFlagFindings(build(n), MD_FILE)
    assert.equal(findings.length, n, `expected one finding per invocation at N=${n}`)
  }

  timeMin(run, 200, 9) // warm up the function before taking measurements
  const small = timeMin(run, 1000, 9)
  const large = timeMin(run, 64000, 9) // 64x the matches

  assert.ok(
    large < small * 250 + 20,
    `expected roughly linear growth (64x matches) but got ${small}ms -> ${large}ms`
  )
})

// --- Wiring: the hooks/*.sh glob must reach the real file ---

test('globSync over hooks/*.sh includes the literal hooks/askuserquestion-guard.sh', () => {
  const scannedFiles = globSync('hooks/*.sh', { cwd: REPO_ROOT })
  assert.ok(
    scannedFiles.includes('hooks/askuserquestion-guard.sh'),
    `hooks glob over ${REPO_ROOT} did not produce the literal 'hooks/askuserquestion-guard.sh' — ` +
      'findQuestionFlagFindings would silently never scan the real file'
  )
})
