export interface FencedRegion {
  start: number // 0-indexed, inclusive — first line of content inside the fence
  end: number // 0-indexed, inclusive — last line of content inside the fence
  infoString: string // text after the fence marker on the opening line, e.g. "markdown", "bash", ""
  unterminated?: true // fence opened but never closed before end of file — region runs to EOF
}

// Generic top-level fenced-region scanner — single-level, not recursive, shared by every check-refs
// module that reads fenced regions, each filtering on or reading the infoString as its own check
// needs. "One parser, not two" is this epic's own thesis; this is the third time it applies
// (validate-mermaid's blocks.ts, then fence-shape.ts's own outer-fence detection, now this).
//
// Mirrors validate-mermaid/blocks.ts's fence semantics: either delimiter (`` ` `` or `~`), leading
// indentation tolerated, and a fence closes only on a run of the SAME character at least as long as
// the one that opened it. A fence nested inside another (e.g. a ```mermaid block inside a
// ~~~markdown one) never closes the outer region early, because its own open/close lines don't
// match the outer fence's character — this repo's own convention (tildes outside, backticks
// inside) relies on exactly that property. A naive open/close toggle that ignores fence character
// would misclassify content after a nested fence as no longer "inside" the outer one — measured
// directly: a naive toggle reported real heading declarations inside ~~~markdown regions as being
// in a "plain" (no-info-string) fence, because it flipped state on the nested ```mermaid close.
// This scanner does not chase nested fences either — it deliberately tracks only the outermost
// level, same as fence-shape.ts always has — so a `## ` line inside a nested mermaid block is
// still attributed to the outer region's infoString, not specially excluded.
//
// EVERY fence-shaped line is recognised as an opener, whole rest-of-line captured verbatim and
// trimmed into infoString — not just ones whose info string happens to already fit `\S*`. An
// earlier version required the info string to butt directly against the fence chars with no
// whitespace, so a CommonMark-valid `~~~ markdown` (space before the info string) — or any other
// info-string shape the fence-chars-then-\S* pattern didn't anticipate, e.g. `~~~markdown extra`
// — failed to match as an opener at all. That's not merely "less tolerant than blocks.ts on one
// axis": an unrecognised opener leaves openIndex null, so the region's own LATER bare closing
// fence gets misread as a fresh opener instead — the region map corrupts, reporting the wrong
// start line, an empty infoString, and unterminated:true, none of which are true. Recognising
// every fence-shaped line as an opener (whatever its info string) prevents the corruption
// entirely; the existing downstream `=== 'markdown'` comparison still does the actual selecting,
// so `~~~ markdown` matches (mirrors blocks.ts's own whitespace tolerance) while
// `~~~markdown extra` and `~~~Markdown` correctly don't (blocks.ts rejects `` ```mermaid x `` and
// `` ```Mermaid `` too — exclusion is the correct mirror, not a gap; see row 7 of the axis table).
const FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})([^\n]*)$/

export const findFencedRegions = (lines: readonly string[]): FencedRegion[] => {
  const regions: FencedRegion[] = []
  let openIndex: number | null = null
  let fenceRun = ''
  let infoString = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (openIndex === null) {
      const open = FENCE_OPEN_RE.exec(line)
      if (open) {
        openIndex = i
        fenceRun = open[2] ?? '```'
        infoString = (open[3] ?? '').trim()
      }
      continue
    }
    // Mirrors blocks.ts: leading/trailing whitespace tolerated, the run must be at least as long
    // as the one that opened the fence, and it must be the SAME character — a backtick fence can
    // never be closed by a tilde run or vice versa.
    const fenceChar = fenceRun.charAt(0)
    const close = new RegExp(`^\\s*${fenceChar}{${fenceRun.length},}\\s*$`).test(line)
    if (close) {
      regions.push({ start: openIndex + 1, end: i - 1, infoString })
      openIndex = null
    }
  }
  if (openIndex !== null) {
    regions.push({ start: openIndex + 1, end: lines.length - 1, infoString, unterminated: true })
  }
  return regions
}

// Every 0-indexed line inside a fenced code block, backtick or tilde, any info string. An
// unterminated fence's region runs to EOF, so its lines are included: a malformed fence is still a
// run of lines a human meant as one block.
export const fencedLineIndices = (lines: readonly string[]): Set<number> => {
  const indices = new Set<number>()
  for (const region of findFencedRegions(lines)) {
    for (let i = region.start; i <= region.end; i += 1) {
      indices.add(i)
    }
  }
  return indices
}
