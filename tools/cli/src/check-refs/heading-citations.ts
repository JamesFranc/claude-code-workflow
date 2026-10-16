import { splitLines } from '../split-lines.ts'
import { findFencedRegions } from './fenced-regions.ts'
import type { Finding } from './main.ts'

// A citation may legitimately name a heading in ANOTHER document — but only when this
// file does not template that document. Keyed by file so the exemption cannot leak.
const CROSS_DOCUMENT_CITATIONS: Record<string, string[]> = {
  'commands/reload-goal.md': ['## North Star — what we are really trying to accomplish'], // lives in the resolved PRD
  'skills/process-improvement-notes/SKILL.md': ['## Consolidated Digest'], // heading to CREATE in the notes file
}

// Require a `##`-or-deeper prefix inside the backticks — level 1 is deliberately not checked
// (a backticked `# …` in prose is far more often an anchor or a format description than a title
// citation). A narrow rule with a small exception list (CROSS_DOCUMENT_CITATIONS, above) beats
// a broad rule with a large one.
const CITATION_RE = /`(#{2,6} [^`]+)`/g

// Indentation tolerated — same axis, same fix as fence-shape.ts's BOLD_LEAD_IN_RE:
// a parser that tolerates indentation but rules that anchor at column 0
// go blind to indented content. Here it matters for headings declared inside a fenced template
// that is itself nested under a list item, e.g. skills/memory-review/SKILL.md's `   ## Rules`
// — three-space indented as list-continuation under "1. Create it when it is absent…", inside a
// ```markdown block that templates review-standards.md's header format. Excluding the indentation
// left that heading uncollected even though the file genuinely declares it (as a template, not as
// its own top-level structure) — the same "a file has a heading if it declares it" principle
// architecture-reference.md and syncing-plans-to-jira.md already rely on, just blind to one more
// axis. The collected heading is trimmed (below), so `   ## Rules` and a `` `## Rules` `` citation
// match on the same normalized text.
const HEADING_RE = /^\s*#{2,6} /

export const findHeadingCitationFindings = (content: string, file: string): Finding[] => {
  const lines = splitLines(content)

  // Headings inside a `markdown`-labeled fenced block COUNT — this is deliberate, not a parser
  // gap. These reference docs template the artifact they cite: architecture-reference.md's
  // citations resolve to headings declared inside its own ~~~markdown fence, and
  // syncing-plans-to-jira/SKILL.md's `## Tasks` citations resolve to the Jira-description template
  // inside its own fence. A file "has" a heading if it declares it — as its own structure or as a
  // template it defines. Excluding markdown-fenced content here reintroduces eleven false
  // positives across those two files (6 in architecture-reference.md — one line alone carries two
  // citations, `## Data Structures` and `## API Contracts` — plus 5 in
  // syncing-plans-to-jira/SKILL.md).
  //
  // Headings inside any OTHER fenced block (```bash, ```mermaid at top level, or no info string at
  // all) do NOT count — that was a false-negative hole, not a parser gap either: a `## Fake
  // Section` line inside a code SAMPLE is not a declaration, and a citation resolving against it is
  // wrong in the opposite direction from every other stated limit in this checker (those all
  // over-flag; this one under-flagged). The signal is machine-readable — the fence's info string —
  // unlike the noun-phrase-vs-imperative limits in fence-shape.ts, which have no such signal and
  // stay documented rather than closed. Shared findFencedRegions (fenced-regions.ts) does the
  // classification; nested fences are not chased (a `## ` inside a ```mermaid block nested in a
  // ~~~markdown region still counts, attributed to the outer region — far more contrived than the
  // code-sample case, and chasing it risks the 47 real declarations this rule protects).
  const fencedRegions = findFencedRegions(lines)
  const isInNonMarkdownFence = (lineIndex: number): boolean =>
    fencedRegions.some(
      (region) =>
        region.infoString !== 'markdown' && lineIndex >= region.start && lineIndex <= region.end
    )

  const ownHeadings = new Set(
    lines
      .filter((line, i) => HEADING_RE.test(line) && !isInNonMarkdownFence(i))
      .map((line) => line.trim())
  )

  const exceptions = new Set(CROSS_DOCUMENT_CITATIONS[file] ?? [])

  const findings: Finding[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const re = new RegExp(CITATION_RE)
    let match: RegExpExecArray | null
    while ((match = re.exec(line)) !== null) {
      const citation = (match[1] ?? '').trim()
      if (ownHeadings.has(citation)) continue
      if (exceptions.has(citation)) continue

      findings.push({
        file,
        line: i + 1,
        col: match.index + 1,
        category: 'heading-citation',
        matched: match[0],
        fix:
          ownHeadings.size > 0
            ? `no matching heading in this file — it has (## and deeper): ${[...ownHeadings].join(', ')}`
            : 'this file declares no ## or deeper headings',
      })
    }
  }
  return findings
}
