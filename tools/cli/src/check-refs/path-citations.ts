import { readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { splitLines } from '../split-lines.ts'
import { findFencedRegions } from './fenced-regions.ts'
import type { Finding } from './main.ts'

// A backticked token is a citation only when its first segment names a tree this repo cites into.
// Paths under any other root (`src/…`, `infra/…`) are illustrative examples of a user's code, not
// references to this repo, and are left alone. `docs/` is listed because `docs/plans/` is
// gitignored, so a citation into it cannot resolve in CI's fresh checkout — a local run where the
// file happens to exist passes it.
//
// What this does not see: a path that is not backticked, or is not the whole of its backticked
// span (inside a larger code span such as `cat skills/x.md`, or with a `:NN` suffix), a path with
// no extension, a § heading that does not directly follow its backticked path, a numeric `§N`
// section citation, and a missing heading whose text begins with a shorter heading the target does
// declare (`§Tests & Gates` passes against a file with only `## Tests`).
const CITABLE_ROOTS = new Set([
  'skills',
  'agents',
  'commands',
  'hooks',
  'tools',
  'docs',
  'references',
])

const PATH_CITATION_RE =
  /`((?:\.{1,2}\/)*[\w.-]+(?:\/[\w.-]+)*\/[\w.-]+\.[A-Za-z]+)`(?:\s*§\s*([^\n`]*))?/g

const HEADING_RE = /^\s*#{1,6} /

export const findPathCitationFindings = (
  content: string,
  file: string,
  root: string
): Finding[] => {
  const findings: Finding[] = []
  const lines = splitLines(content)

  for (let i = 0; i < lines.length; i++) {
    const re = new RegExp(PATH_CITATION_RE)
    let match: RegExpExecArray | null
    while ((match = re.exec(lines[i] ?? '')) !== null) {
      const cited = match[1] ?? ''
      if (!isCitable(cited)) {
        continue
      }

      const target = resolveCitation(cited, file, root)
      const at = { file, line: i + 1, col: match.index + 1 }
      if (target === undefined) {
        findings.push({
          ...at,
          category: 'path-citation',
          matched: `\`${cited}\``,
          fix: 'no such file from the repo root, this file’s directory, or its skill root',
        })
        continue
      }

      const section = match[2]
      if (section === undefined || /^\d/.test(section)) {
        continue
      }

      const next = (lines[i + 1] ?? '').replace(/^[\s>]+/, '')
      const wrapped = `${section.trim()} ${next}`.trim()
      if (!citesHeadingOf(wrapped, readHeadings(join(root, target)))) {
        findings.push({
          ...at,
          category: 'path-heading-citation',
          matched: match[0],
          fix: `${target} has no heading that the text after § starts with`,
        })
      }
    }
  }

  return findings
}

const isCitable = (cited: string): boolean =>
  cited.startsWith('./') || cited.startsWith('../') || CITABLE_ROOTS.has(cited.split('/')[0] ?? '')

// Tried in order: the repo root, the citing file's own directory, then — for a file inside a skill —
// the skill root, which is how a skill's references/ files cite their siblings. A candidate that
// escapes the repo root never resolves.
const resolveCitation = (cited: string, file: string, root: string): string | undefined => {
  const skillRoot = /^skills\/[^/]+/.exec(file)?.[0]
  const bases = ['', dirname(file), ...(skillRoot === undefined ? [] : [skillRoot])]

  return bases
    .map((base) => normalize(join(base, cited)))
    .find((candidate) => !candidate.startsWith('..') && isFile(join(root, candidate)))
}

// Headings inside a non-markdown fence are code samples, not declarations — the same rule
// heading-citations.ts applies to same-file citations.
const readHeadings = (absPath: string): string[] => {
  const lines = splitLines(readFileSync(absPath, 'utf-8'))
  const regions = findFencedRegions(lines)
  const inCodeFence = (i: number): boolean =>
    regions.some((r) => r.infoString !== 'markdown' && i >= r.start && i <= r.end)

  return lines
    .filter((line, i) => HEADING_RE.test(line) && !inCodeFence(i))
    .map((line) => line.trim().replace(/^#+\s+/, ''))
}

// Citations name a heading by its name — the part before the first whitespace-then-`—`,
// whitespace-then-`(`, or `:`-then-whitespace — and prose runs straight on after it
// (`§Verify Against Reality enumerates…`), often across a line wrap, which the caller joins. The
// citation holds when its text starts, at a word boundary, with a heading's full text or its name.
const citesHeadingOf = (section: string, headings: readonly string[]): boolean =>
  headings.some((h) => [h, headingName(h)].some((name) => startsWithWord(section, name)))

const headingName = (heading: string): string => heading.split(/\s+[—(]|:\s/)[0] ?? heading

const startsWithWord = (text: string, prefix: string): boolean =>
  text.startsWith(prefix) && !/[\p{L}\p{N}]/u.test(text.charAt(prefix.length))

const isFile = (absPath: string): boolean =>
  statSync(absPath, { throwIfNoEntry: false })?.isFile() ?? false
