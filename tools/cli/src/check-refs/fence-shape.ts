import { splitLines } from '../split-lines.ts'
import { findFencedRegions } from './fenced-regions.ts'
import type { FencedRegion } from './fenced-regions.ts'
import type { Finding } from './main.ts'

// Templates embed their reference document inside an outer fenced `markdown` block — tildes when
// the template itself contains a nested ```mermaid fence (so the inner fence doesn't terminate the
// outer one early), backticks when it doesn't need to nest anything. Only files with such an outer
// fence are template docs subject to this check.
//
// BOTH DELIMITERS accepted — mirrors validate-mermaid/blocks.ts's fence semantics rather than
// diverging from it on this axis too. `extractMermaidBlocks`'s open-fence pattern already handles
// `` ` `` or `~` generically for the inner mermaid fence; this outer fence used to accept only
// `~`, which left four real, backtick-fenced `markdown` blocks entirely invisible to this checker
// — including skills/jtbd/references/jtbd-reference.md's PRD template, the exact document class
// FLOW-202's leak appeared in. Confirmed those four are currently clean (0 findings each, both
// as-is and with tildes substituted in), so bringing them into scope is gate-neutral, not a new
// leak surfacing.
//
// Region detection itself (indentation, same-character/same-or-longer-run closing, unterminated
// handling) now lives in the shared fenced-regions.ts, reused by heading-citations.ts too — one
// fence parser, not two.

const BOLD_LEAD_IN_RE = /^\s*\*\*/

// Rule B's exemption — a SHAPE, not a literal `**Jira:**` prefix. This is a reversal: an earlier
// version of this rule allowlisted only the literal `**Jira:**` prefix, reasoning that a
// shape-based exemption ("bold followed by a bracketed placeholder") would let a future
// `**Something:** [PLACEHOLDER]` leak through unnoticed. That reasoning was wrong. A bold label
// ending in `:` immediately followed by a placeholder opener (`[` or `<`) means the author
// replaces the placeholder while the label stays in the produced document — that IS the
// slot-occupying-vs-slot-adjacent discriminator from FLOW-202's review, not an exception to it.
// Verified against every historical leak this rule exists to catch (`**Required.**`,
// `**No section restates another.**`, the three FLOW-149 Risks instructions): none contains a
// colon inside the bold followed immediately by `[` or `<` — they're sentences, not fields. Every
// known legitimate field (`**Jira:**`, `**Status:**`, `**Slips:**`, `**Harden:**`, `**Examples:**`)
// matches. `**Jira:**` needs no special case anymore; the shape subsumes it.
//
// END-ANCHORED — the placeholder must run to the end of the line, not just open. An earlier version
// of this regex matched the opener (`[` or `<`) and stopped, so trailing prose after the placeholder
// closes rode through unflagged (e.g. `**Note:** [optional] describe the risk here...`). That text
// is slot-ADJACENT, not slot-occupying — the author's content never replaces it — which is exactly
// the shape of a leak by the same discriminator that exempts the field itself. Every one of the five
// real fields already ends at its placeholder close, so this is what they measurably are, not a
// guess: `**Jira:** [TICKET-ID]`, `**Status:** [Phase — …]`, `**Slips:**`/`**Harden:**`/
// `**Examples:** <…>`. Verified tree-wide (not just the three canonical templates): 7 lines
// exempted by the un-anchored regex, all 7 still exempt end-anchored — zero regressions on the
// clean tree.
//
// LABEL BOUNDED to one-to-three words — a short noun phrase, not a sentence. The earlier charset
// (`[A-Za-z0-9 /()]+`, unbounded) allowed spaces with no limit, so an entire sentence qualified as
// a "label": a one-keystroke edit (period to colon) turns three of the five historical FLOW-149
// leaks into an exempt field — `**Cite evidence for what you DID verify:** [example]` stays in the
// produced document (slot-ADJACENT), it doesn't get replaced by the placeholder. The bound is
// measured from every real label observed, not granted generously in advance: `Jira`, `Status`,
// `Slips`, `Harden`, `Examples` are each a single alphanumeric word — none uses a space, slash, or
// paren. "A field label is a short noun phrase" is the statable principle; three words is
// comfortable headroom over the observed one, not an arbitrary count.
//
// CHARSET NARROWED to alphanumerics only — `/` and `(` `)` dropped. Nothing real ever used them
// (see above); keeping them was speculative width of exactly the kind that let a whole sentence
// pose as a label in the first place (shape seven). They also left a hole the word bound alone
// doesn't close: slashes can chain words together as fake "one word" tokens, e.g.
// `**Always/cite/path/line/for/every/claim:** [example]` — seven words wide, but zero spaces, so it
// slipped the 1-3-word count. Removing unexercised permissiveness costs nothing on the clean tree.
//
// NOT CLOSED BY EITHER BOUND, documented rather than chased: a one-word label with an imperative
// INSIDE the bracket — `**Note:** [Always validate assumptions before committing]` — still exempts.
// All five real placeholder contents are noun phrases (`[TICKET-ID]`, `<the concrete failure
// mode(s) — what went wrong, specifically>`), so nothing in the current tree forces the question.
// But no reliable syntactic test separates a noun phrase from an imperative inside a bracket: the
// obvious one — "opens with an article or an all-caps token" — separates today's cases and breaks
// on the first legitimate `<risk description>`, at which point it gets widened. That
// widen-on-contact cycle is how the trailing-prose and sentence-label gaps arrived. A fragile
// discriminator is worse than a named limit, because it looks closed. Zero observed instances.
//
// The SAME undecidability applies to the label itself, not just the bracket: a 1-3 word imperative
// (`**Always validate assumptions:**`) is syntactically indistinguishable from a noun-phrase label
// — `**Always validate assumptions:** [example]`, `**Cite evidence:** [path/line]`, and
// `**Do not assume:** [evidence]` are all exempt today. Bounding harder does not close the class —
// `**Cite:** [evidence]` is already a one-word imperative — and it would break legitimate two-word
// fields like `**Due date:** [date]` or `**Parent epic:** [KEY]` first, restarting the same
// widen-on-contact cycle. This is an instance of the bracket-side undecidability above, at a
// different position, not a separate problem with its own fix.
//
// See the committed tests + controls below documenting all of this as current (exempt) behaviour,
// so a later widening can't silently move the boundary.
const FIELD_LABEL_RE = /^\s*\*\*[A-Za-z0-9]+(?: [A-Za-z0-9]+){0,2}:\*\*\s+[[<][^\]>]*[\]>]\s*$/

export const findFenceShapeFindings = (content: string, file: string): Finding[] => {
  const lines = splitLines(content)
  const regions = findOuterFencedRegions(lines)
  if (regions.length === 0) return []

  const findings: Finding[] = []

  for (const region of regions) {
    // Fail closed, not open: an unterminated fence gets its own finding, but the region still runs
    // to end-of-file and Rule B still checks whatever content it contains. A malformed template
    // reads as "needs attention" at minimum — never as silently clean because the walker gave up.
    if (region.unterminated) findings.push(unterminatedFenceFinding(lines, region, file))
    findings.push(...findRuleBFindings(lines, region, file))
  }
  return findings
}

const unterminatedFenceFinding = (lines: string[], region: FencedRegion, file: string): Finding => {
  const openLine = region.start // 1-indexed line of the opening `~~~markdown` fence
  return {
    file,
    line: openLine,
    col: 1,
    category: 'fence-shape',
    matched: lines[openLine - 1] ?? '',
    fix: 'this ~~~markdown fence is never closed before end of file — close it so the template is checkable',
  }
}

// Rule B — inside a ~~~markdown fence, no line may begin with `**`, except a bold FIELD LABEL (see
// FIELD_LABEL_RE above). This is a structural-position test (line-initial bolded lead-in), not a
// content test, so it doesn't resurrect the "contains an imperative" / "cross-references another
// artifact" discriminators FLOW-202 disproved. It catches bolded instructions in any section, for
// lines that *begin* with `**` — e.g. the FLOW-149 Risks-section instructions. (Rule A, a
// glance-section shape check, was removed in FLOW-374; the "Rule B" name is kept so test names
// and history stay searchable.)
//
// NOT CLOSED, third stated limit alongside the bracket and label ones above: a bolded instruction
// that is not line-initial — after a list marker, a blockquote marker, or appended to a sentence —
// is not flagged (`Known unknowns. **Always validate...**`, `- **Always validate...**`,
// `> **Always validate...**` all exempt today). The anchor is deliberate, not an oversight:
// `1. **Story title** — Brief description` must stay exempt, and separating a bulleted instruction
// leak from a bulleted legitimate label collapses to the same noun-phrase-vs-imperative
// undecidability as the bracket limit above — dropping the anchor would flag every `**Story
// title**` in the Stories section. Zero observed instances. See the committed test + control below.
const findRuleBFindings = (lines: string[], region: FencedRegion, file: string): Finding[] => {
  const findings: Finding[] = []

  for (let i = region.start; i <= region.end; i++) {
    const line = lines[i] ?? ''
    if (!BOLD_LEAD_IN_RE.test(line)) continue
    if (FIELD_LABEL_RE.test(line)) continue

    findings.push({
      file,
      line: i + 1,
      col: 1,
      category: 'fence-shape',
      matched: line,
      fix: 'move this bolded instruction out of the fenced template — it leaks into every document written from it',
    })
  }
  return findings
}

// Filters the shared scanner down to the outer `markdown`-labeled fences this checker cares
// about — a nested ```mermaid or other non-`markdown` fence inside one is not itself a separate
// region here (findFencedRegions already tracks only the outermost level; see fenced-regions.ts).
const findOuterFencedRegions = (lines: readonly string[]): FencedRegion[] =>
  findFencedRegions(lines).filter((region) => region.infoString === 'markdown')
