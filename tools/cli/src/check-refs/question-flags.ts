import { splitLines } from '../split-lines.ts'
import { fencedLineIndices } from './fenced-regions.ts'
import type { Finding } from './main.ts'

// Every documented way to ask the user runs this verb, so a bare invocation in shipped instruction
// text is an agent about to be refused — either by Stricli's own parse layer (itemAddCommand
// declares `--prompt` mandatory, so a `--type question` invocation missing it never reaches
// tools/cli/src/dashboard/item.ts at all) or by that gate itself (--recommend/--stalls/--why-mine).
// Either way the user hears nothing. This check catches a literal `item add --type question` /
// `item add --type=question` invocation missing any required flag; the post-sweep grep in Task 5 is
// the other half. It matches `item add --type` as a contiguous literal, so it does not see an
// invocation with its flags reordered (e.g. `item add --prompt "..." --type question`, where
// `--type` no longer immediately follows `item add`) — a parser would be needed to catch that, and
// would trade this narrow miss for false positives on prose. It also only fires on `--type
// question`, so a bare `--type approval` missing its own mandatory `--prompt` is not caught here.
// `question-flags.test.ts` demonstrates both misses so the gap is documented rather than discovered
// later.
export const REQUIRED_QUESTION_FLAGS = [
  '--recommend',
  '--stalls',
  '--why-mine',
  '--prompt',
] as const
const INVOCATION_PATTERN = /item add\s+--type[\s=]question/g

// Line-scoped, with shell-semantics backslash continuation: an invocation must carry its required
// flags on its own line, or on the lines a trailing `\` continues it onto. A candidate line is
// joined with its continuation lines BEFORE the pattern is matched — a real corpus site has `item
// add` on one line and `--type question` on the next, and matching against the raw physical line
// first would never see `--type` at all. The join follows POSIX line-continuation semantics: a line
// ending in a literal backslash has the backslash and the newline both removed, and the next line is
// appended directly, with no separator inserted — so whitespace already present (the space before
// the backslash, the next line's own indentation) is what ends up between the two halves, not a
// fixed single space. That is why the pattern tolerates a run of whitespace between `item add` and
// `--type`, and between `--type` and `question`, rather than requiring exactly one.
//
// That POSIX semantics is right for a real shell file (every `hooks/*.sh` site) but wrong for
// Markdown: a trailing backslash there is a CommonMark hard line break, a prose construct, not a
// shell continuation — the text after it is unrelated prose, not part of the same command. Joining
// it anyway lets a required flag merely *named* in that following prose satisfy the presence check
// for an invocation that never actually carries it. So the join is unconditional only for a
// non-Markdown `file` (the hook scripts); for a `.md` file it is restricted to lines inside a fenced
// code block (`findFencedRegions`, shared with fence-shape.ts and heading-citations.ts) — the one
// shape in this corpus where a trailing backslash inside Markdown really is a shell continuation.
// Every shipped site that needs a join at all is inside such a fence (`skills/pr-lifecycle/SKILL.md`);
// a bare invocation split across ordinary prose is never joined, and a candidate line outside any
// fence is scanned only as itself.
//
// The join is gated behind a cheap literal pre-filter — does this physical line contain `item add`?
// — before `joinContinuation` runs at all. With the fence restriction above already responsible for
// correctness (it is what stops a hard break from masking a missing flag), the pre-filter is exactly
// what it looks like: a micro-optimization, not a correctness requirement. Dropping it would still
// scan every line through `joinContinuation`; keeping it just skips lines that cannot start a match.
//
// Every walk, join, and per-invocation resolution below is bounded to the size of what it touches,
// not its square. The outer loop advances past every line a join has already consumed, so a line
// inside an already-walked span never starts a second one; `joinContinuation` builds each span's
// pieces once and joins them a single time (see its own comment) instead of repeatedly slicing and
// re-concatenating a growing string; and within one span, `createPhysicalLocator` resolves each
// match's physical line with a forward-only cursor rather than rescanning a span's segments from the
// start on every match (see its own comment). The per-match flag-search window and the `matched`
// field are both slices of the span between one invocation's own match and the next's, so together
// they partition the span rather than each copying the whole thing — their combined cost across every
// match on a span is the span's own length, not that length times the match count.
//
// The pre-filter's own honest limit: an invocation whose own `item add` is itself split across a
// continuation boundary never reaches the walk, because the line that would trigger it doesn't
// contain the literal substring. Widening the pre-filter to `'item'` (and the pattern to tolerate
// whitespace between `item` and `add` too) would catch that split, but at a cost that is no longer
// fixed the way it was before fencing: it would now fire on every ordinary use of the word `item` in
// prose *inside a fence* — narrower than before fencing existed, but not free either — so it is not
// adopted here. The split-token shape has not occurred in this repo; `question-flags.test.ts`
// documents the miss as a known limit of this pre-filter's exact shape, not a hypothetical or
// something this fix leaves incomplete.
export const findQuestionFlagFindings = (content: string, file: string): Finding[] => {
  const lines = splitLines(content)
  const findings: Finding[] = []
  const joinable = file.endsWith('.md') ? fencedLineIndices(lines) : null

  for (let i = 0; i < lines.length;) {
    const line = lines[i] ?? ''
    if (!line.includes('item add')) {
      i += 1
      continue
    }
    const canJoin = joinable === null || joinable.has(i)
    const { span, segments, lastIndex } = canJoin
      ? joinContinuation(lines, i, joinable)
      : { span: line, segments: [{ lineIndex: i, offset: 0 }], lastIndex: i }

    const matches = [...span.matchAll(INVOCATION_PATTERN)]
    const matchOffsets = matches
      .map((match) => match.index)
      .filter((index): index is number => index !== undefined)
    const scanned = stripQuotedValues(span, matchOffsets)
    const locate = createPhysicalLocator(segments)
    for (let m = 0; m < matches.length; m += 1) {
      const match = matches[m]
      if (match === undefined || match.index === undefined) {
        continue
      }
      // The first invocation's own scan starts at the span's own start, so a flag written ahead of
      // it (see 'a flag as the first token in the span is recognized as present') still counts. Any
      // later invocation's scan starts at its own match, not the span start, so it never picks up —
      // or gets credited for — a flag that belongs to an earlier invocation in the same span.
      const windowStart = m === 0 ? 0 : match.index
      const nextMatch = matches[m + 1]
      const windowEnd = nextMatch?.index ?? span.length
      const missing = REQUIRED_QUESTION_FLAGS.filter(
        (flag) => !hasQuestionFlag(scanned.slice(windowStart, windowEnd), flag)
      )
      if (missing.length === 0) {
        continue
      }
      const { lineIndex, col } = locate(match.index)
      findings.push({
        file,
        line: lineIndex + 1,
        col,
        category: 'question-flag',
        matched: span.slice(match.index, windowEnd).trim(),
        fix: `add ${missing.join(' ')} — the CLI refuses a question without them (skills/board/references/escalation-contract.md)`,
      })
    }
    i = lastIndex + 1
  }
  return findings
}

interface JoinSegment {
  lineIndex: number
  offset: number
}

// Joins physical lines starting at `start` using shell line-continuation semantics: a line ending in
// a literal backslash has the backslash and the newline both removed, and the next line appended
// directly, with no separator inserted. The result never contains an embedded newline — the join
// consumes every one that continuation crosses. `joinable` gates each step past the first: a `null`
// set (a non-Markdown file) never stops the walk; a real set (Markdown) stops it at the first
// continuation line that sits outside a fence, so the join never crosses a fence boundary even when
// a fenced block happens to end on a backslash-continued line. `segments` records, for each physical
// line the walk consumes, that line's own index and the character offset in `span` where its content
// begins — what `createPhysicalLocator` below resolves a match position back through.
const joinContinuation = (
  lines: readonly string[],
  start: number,
  joinable: ReadonlySet<number> | null
): { span: string; segments: JoinSegment[]; lastIndex: number } => {
  // Collects each line's own contribution into `pieces` and joins once at the end, rather than
  // slicing and re-concatenating one ever-growing `span` string on every line consumed. A repeated
  // `span = span.slice(0, -1) + next` forces the engine to flatten the whole accumulated string on
  // every iteration — a cost proportional to the span's current length, not the one line actually
  // being added — which reproduces the same superlinear cost this fix exists to remove, just inside
  // a single walk instead of across many. Slicing a single physical line's own trailing backslash
  // off, as done below, costs only that line's own length, independent of how many lines precede it.
  const pieces: string[] = []
  const segments: JoinSegment[] = []
  let offset = 0
  let j = start
  let current = lines[start] ?? ''
  for (;;) {
    segments.push({ lineIndex: j, offset })
    const continues =
      current.endsWith('\\') && j + 1 < lines.length && (joinable === null || joinable.has(j + 1))
    if (!continues) {
      pieces.push(current)
      break
    }
    const stripped = current.slice(0, -1)
    pieces.push(stripped)
    offset += stripped.length
    j += 1
    current = lines[j] ?? ''
  }
  return { span: pieces.join(''), segments, lastIndex: j }
}

// Returns a function that resolves a character offset into `segments`' joined span back to the
// physical line that contributed it, and a column relative to that line's own start — not the
// span's. Callers walk matches in ascending `charOffset` order (as `matchAll` yields them), and
// `segments` is itself in ascending-offset order, so resolving each one is a merge, not a search: the
// closure's own cursor only ever moves forward, and never re-scans a segment a previous call already
// passed. Calling this once per span, and the returned function once per match on that span, is what
// keeps the whole span's worth of resolutions to the number of segments plus the number of matches,
// not their product — re-scanning `segments` from the start on every match reproduces the same
// quadratic cost `question-flags.test.ts` pins against.
const createPhysicalLocator = (
  segments: readonly JoinSegment[]
): ((charOffset: number) => { lineIndex: number; col: number }) => {
  let idx = 0
  return (charOffset: number) => {
    while (idx + 1 < segments.length && (segments[idx + 1]?.offset ?? Infinity) <= charOffset) {
      idx += 1
    }
    const owner = segments[idx] ?? { lineIndex: 0, offset: 0 }
    return { lineIndex: owner.lineIndex, col: charOffset - owner.offset + 1 }
  }
}

// A flag is present only as a complete token in `scanned` — text already passed through
// stripQuotedValues by the caller, so a flag name that only survived inside an unstripped quoted
// region does not satisfy the presence check for the real flag. `--recommend` must not be satisfied
// by `--recommendation` either. A flag wrapped in Markdown inline code (e.g. `` `--recommend` ``)
// still reads as present, on either side of the backtick.
//
// The open and close boundaries are deliberately different classes, not one shared set:
// - open — start of span, whitespace, or a backtick, but not `=`. Admitting `=` here would let a
//   flag name glued to a *different* flag's `=` value read as present (e.g. `--foo=--recommend`),
//   the same value-position false negative stripQuotedValues's own anchoring guards against.
// - close — whitespace, a backtick, `=`, or end of span. `=` belongs only here, for the flag's own
//   `--recommend=value` form.
const hasQuestionFlag = (scanned: string, flag: string): boolean =>
  new RegExp(`(?:^|[\\s\`])${flag}(?=[\\s\`]|=|$)`).test(scanned)

// Blanks out "..."/'...' regions that sit in argument-value position, replacing each match with an
// equal-length run of spaces rather than the empty string. Equal length IS load-bearing:
// findQuestionFlagFindings slices `scanned` using `windowStart`/`windowEnd` offsets computed against
// `span`, not against `scanned` itself. Those offsets stay valid only because stripQuotedValues never
// changes `scanned`'s length relative to `span` — collapsing a match to zero length would shift every
// offset past it, misaligning a later invocation's flag-search window against the underlying text.
//
// A quote opens or closes a region only
// when it sits against a delimiter — start of span, whitespace, `=`, a backtick, or end of span —
// and a region's own content excludes the backtick too. The backtick is a delimiter because the
// scanned corpus is Markdown, where a backtick ordinarily terminates an inline code span: excluding
// it would leave the quoted value nearest a backtick-wrapped example unstripped. Excluding it from a
// region's content stops two unrelated quote characters from pairing across a stray backtick in a
// malformed span and blanking real, present flags between them. Rejecting a mid-word apostrophe
// (e.g. "user's": preceded and followed by letters) is why both the open- and close-side delimiter
// checks exist, and each is required independently — one alone still admits the shape the other
// rejects, and either shape blanks real flags on well-formed text.
//
// A region's content admits a backslash escape of any character but the backtick — `\"` inside a
// double-quoted value, `\'` inside a single-quoted one — without that character closing the region,
// so a shipped example can show a literal quote inside a quoted value. The escape excludes the
// backtick on purpose: `` \` `` still acts as the same hard delimiter an unescaped backtick does
// rather than being swallowed as literal content, so escaping the backticks around a fake code span
// cannot be used to smuggle two unrelated quote characters past the pairing guard above. The span
// itself never carries an embedded newline — the continuation join above consumes every one it
// crosses — so the escape's character class has no `\n` case to matter for.
//
// When the escaped character is the value's own would-be closing quote and no unescaped quote of the
// same kind follows it, the region has no closing quote left to match at all — the escape does not
// reach past the end of the value looking for one, so the whole region is left unstripped. This is
// not inherited from the plain-unterminated-value class below: before this escape existed, a value
// whose closing quote is followed only by trailing prose (no real quote of the same kind anywhere
// after it) still closed and stripped there, because an un-escaped-aware match had no reason to look
// past that quote at all. Admitting the escape is what makes this shape ambiguous — the same
// character sequence that must NOT close the region when a real closing quote follows it later (the
// case this escape exists to catch) is indistinguishable, to this regex, from one where no real
// closing quote follows at all. Trading the second shape away is the cost of fixing the first;
// `question-flags.test.ts` pins both directions of that trade.
//
// The replace is global and per-region, not per-span: a region is blanked only when BOTH of its
// quotes sit against a delimiter. A region that fails this is left as-is; other well-formed regions
// in the same span still strip. That per-region delimiter requirement is the limitation: unterminated,
// or opened or closed against a letter or other punctuation, leaves that one region unstripped, and a
// required flag's name inside it is not caught as missing. This inherited class is distinct from the
// escaped-own-closing-quote trade documented above, which the escape mechanism itself introduces
// rather than inherits. `question-flags.test.ts` pins the plain-unterminated shape, the
// escaped-closing-quote shape on both arms, and the closed-against-a-non-delimiter half of the
// opened-or-closed shape; the opened half shares the same failure mode but is not separately pinned.
//
// `=` is a valid close delimiter too, alongside whitespace/backtick/end-of-span: a quoted value
// immediately followed by `=` (e.g. `--why-mine "c"=x`) still closes and strips correctly.
// `question-flags.test.ts` pins this shape directly.
//
// Content excluding the backtick has a second, distinct miss: a required flag's name that appears
// only as prose inside a would-be quoted value, itself wrapped in its own pair of backticks (e.g. a
// value mentioning `` `--stalls` `` as a Markdown-code example), reads as present — the flag's own
// backtick neighbors satisfy hasQuestionFlag's boundary check even though the enclosing region never
// stripped. This is a miss the content exclusion introduces, traded for the false positive it
// fixes (`question-flags.test.ts` pins both the miss and the fix it is the price of).
//
// The scanned unit is a Markdown line, not a shell command: an unresolved region's quote balance is
// a property of its English, not of a command, so reading quote state as a signal there would
// measure the prose rather than the command. That is why an unresolved region is left unstripped
// rather than reported — a property of the corpus no rewrite of this regex removes.
//
// `invocationOffsets` guards a distinct shape from all of the above: a shell `echo "…"` (or a
// Markdown fence line built the same way) can wrap an ENTIRE invocation — "item add --type
// question" and all its flags — in one quoted region that opens and closes against delimiters just
// as legitimately as an ordinary argument value does. Blanking that region wholesale erases the
// flags being scanned FOR, not a value they happen to sit inside, and every invocation caught this
// way reports the same all-flags-missing shape regardless of which flags the wrapped text actually
// carries — the caller's own INVOCATION_PATTERN match on the unstripped `span` still finds it, but
// the flag search below sees nothing left to find. A region is left unstripped when an
// invocation's own match starts inside it, so the flags within it scan as literal text instead.
const stripQuotedValues = (span: string, invocationOffsets: readonly number[] = []): string =>
  span.replace(
    /(?<=^|[\s=`])(?:"(?:[^"`\\]|\\[^`])*"|'(?:[^'`\\]|\\[^`])*')(?=[\s=`]|$)/g,
    (match: string, offset: number) => {
      const wrapsInvocation = invocationOffsets.some(
        (invocationOffset) => invocationOffset >= offset && invocationOffset < offset + match.length
      )
      return wrapsInvocation ? match : ' '.repeat(match.length)
    }
  )
