import { spawnSync } from 'node:child_process'
import { splitLines } from '../split-lines.ts'
import { escapeRegExp } from './escape-regexp.ts'
import { fencedLineIndices, findFencedRegions } from './fenced-regions.ts'
import type { Finding } from './main.ts'

// A shipped command example is a template an agent copies out and runs, so it must survive being
// run as written. The failure this rule exists for is the unquoted `<placeholder>`: to a shell it is
// a redirection, not a word. `cmd <branch-name>` is a syntax error (`bash -n` rejects it, nothing in
// the block runs). `cmd --label <TICKET-ID> --url x` parses, so `bash -n` accepts it, but run as
// written it fails with `TICKET-ID: No such file or directory` (exit 1, the command never runs)
// unless a file named `TICKET-ID` exists, in which case the command runs without the argument,
// reading that file as stdin and writing a file named `--url`. Both are fixed the same way: wrap
// the placeholder in double quotes, `"<branch-name>"`, so it reaches argv as one word.
//
// Three surfaces are checked:
//   1. A fenced block tagged `bash`, `sh` or `shell`, indented or not. Its dedented body must pass
//      `bash -n`, and no line may carry an unquoted placeholder — heredoc bodies and comments
//      excepted, since neither is shell syntax.
//   2. A single-backtick inline code span outside every fence, from the first known command in it
//      (a `bin/` tool name, or `git`, `gh`, `pnpm`) to the end of the span.
//   3. A heredoc body in `hooks/*.sh`, from the first known command on a line to the end of that
//      line. A hook's heredoc is the text it prints to an agent, so a command in it is a template
//      too; the hook's own code is not scanned.
//
// What it does not see, by construction, so a clean run means "none in these shapes" and no more:
//   - A fence with any other info string, or none (`text`, `markdown`, untagged). Tag a block as
//     shell to have it checked; tag a deliberately non-runnable sketch `text` to keep it out.
//   - A shell fence nested inside another fence (a ```bash block inside a ~~~markdown template),
//     because `findFencedRegions` tracks only the outermost level.
//   - An inline span with no known command in it — a flag fragment like `--pr <n>`, or a command
//     run through a path (`bin/dashboard`) rather than its bare name.
//   - A double-backtick inline span, a span broken across lines, and a hook's printed text that is
//     not in a heredoc (an `echo` argument).
//   - A placeholder that ends in whitespace before its `>`, which is indistinguishable from a real
//     redirection pair (`sort <in.txt >out.txt`) and is deliberately not matched.
//   - Command substitution written with backticks inside double quotes: only `$( … )` is tracked.
//   - A `<<word` inside `$(( … ))` arithmetic, which reads as a heredoc opener and hides the rest of
//     its fence.
//   - On a hook heredoc line, prose after the command word containing a character `blankQuoted`
//     reads as opening a quote or comment (`'`, `"`, ` #`), which hides every later placeholder on
//     that line.
const SHELL_INFO_STRINGS: ReadonlySet<string> = new Set(['bash', 'sh', 'shell'])
const EXTERNAL_COMMANDS = ['git', 'gh', 'pnpm'] as const
const PLACEHOLDER_PATTERN = /<[A-Za-z](?:[^<>\n]*[^\s<>])?>/g
const HEREDOC_PATTERN = /(?<!<)<<(?!<)-?\s*(?:\\|(["']?))([A-Za-z_][A-Za-z0-9_]*)\1/g
const INLINE_SPAN_PATTERN = /(?<!`)`([^`\n]+)`(?!`)/g

export const findCommandExampleFindings = (
  content: string,
  file: string,
  toolNames: readonly string[]
): Finding[] => {
  const lines = splitLines(content)
  const commandStart = commandStartPattern(toolNames)
  if (!file.endsWith('.md')) {
    return findHeredocFindings(lines, file, commandStart)
  }
  return [
    ...findShellFenceFindings(lines, file),
    ...findInlineSpanFindings(lines, file, commandStart),
  ]
}

const findShellFenceFindings = (lines: readonly string[], file: string): Finding[] =>
  findFencedRegions(lines)
    .filter((region) => SHELL_INFO_STRINGS.has(region.infoString))
    .flatMap((region) => {
      const body = lines.slice(region.start, region.end + 1)
      if (body.every((line) => line.trim() === '')) {
        return []
      }
      return [
        ...findSyntaxFindings(body, region.start, file),
        ...findFencePlaceholderFindings(body, region.start, file),
      ]
    })

const findInlineSpanFindings = (
  lines: readonly string[],
  file: string,
  commandStart: RegExp
): Finding[] => {
  const fenced = fencedLineIndices(lines)
  return lines.flatMap((line, i) =>
    fenced.has(i)
      ? []
      : [...line.matchAll(INLINE_SPAN_PATTERN)].flatMap((span) =>
          findCommandFindings(span[1] ?? '', span.index + 1, i + 1, file, commandStart)
        )
  )
}

const findHeredocFindings = (
  lines: readonly string[],
  file: string,
  commandStart: RegExp
): Finding[] => {
  const findings: Finding[] = []
  let delimiter: string | null = null
  lines.forEach((line, i) => {
    if (delimiter === null) {
      delimiter = findUnquotedHeredoc(line, blankQuoted(line, []).text)?.[2] ?? null
      return
    }
    if (line.trim() === delimiter) {
      delimiter = null
      return
    }
    findings.push(...findCommandFindings(line, 0, i + 1, file, commandStart))
  })
  return findings
}

// `bash -n` reports at most its first syntax error, so a fence yields at most one syntax finding;
// fixing it and re-running surfaces the next. Its "line N" is relative to the fence body, so it is
// mapped back to the file line. If bash cannot be started at all the fence is reported rather than
// passed: an unchecked fence must not read as a clean one.
const findSyntaxFindings = (
  body: readonly string[],
  firstLineIndex: number,
  file: string
): Finding[] => {
  const result = spawnSync('bash', ['-n'], {
    input: dedent(body).join('\n') + '\n',
    encoding: 'utf-8',
  })
  if (result.error) {
    return [
      commandExampleFinding(
        file,
        firstLineIndex + 1,
        1,
        (body[0] ?? '').trim(),
        `bash -n could not run (${result.error.message}), so this fence is unchecked`
      ),
    ]
  }
  if (result.status === 0) {
    return []
  }
  const message = (result.stderr.split('\n')[0] ?? '').replace(/^bash: /, '')
  const bodyLine = Number(/line (\d+):/.exec(message)?.[1] ?? '1')
  return [
    commandExampleFinding(
      file,
      firstLineIndex + bodyLine,
      1,
      (body[bodyLine - 1] ?? '').trim(),
      `bash -n rejects this fence: ${message}`
    ),
  ]
}

// A quoted string can run across lines, so the quoting state is carried from one line to the next.
// A heredoc body is data, not shell — it is skipped from the line after the operator to the line
// that closes it, and the operator itself is blanked so its delimiter is not read as a placeholder.
const findFencePlaceholderFindings = (
  body: readonly string[],
  firstLineIndex: number,
  file: string
): Finding[] => {
  const findings: Finding[] = []
  let open: readonly QuoteContext[] = []
  let delimiter: string | null = null
  body.forEach((line, i) => {
    if (delimiter !== null) {
      if (line.trim() === delimiter) {
        delimiter = null
      }
      return
    }
    const blanked = blankQuoted(line, open)
    const heredoc = findUnquotedHeredoc(line, blanked.text)
    const shellText = heredoc ? blankOperator(blanked.text, heredoc) : blanked.text
    open = blanked.open
    findings.push(...findPlaceholders(shellText, 0, firstLineIndex + i + 1, file))
    if (heredoc) {
      delimiter = heredoc[2] ?? null
    }
  })
  return findings
}

// A heredoc operator counts only where the quote-blanked text still shows its `<<`: inside quotes
// it is data.
const findUnquotedHeredoc = (line: string, shellText: string): RegExpExecArray | null =>
  [...line.matchAll(HEREDOC_PATTERN)].find(
    (match) => shellText.slice(match.index, match.index + 2) === '<<'
  ) ?? null

const blankOperator = (shellText: string, heredoc: RegExpExecArray): string => {
  const start = heredoc.index
  return (
    shellText.slice(0, start) +
    ' '.repeat(heredoc[0].length) +
    shellText.slice(start + heredoc[0].length)
  )
}

const findCommandFindings = (
  segment: string,
  segmentOffset: number,
  lineNumber: number,
  file: string,
  commandStart: RegExp
): Finding[] => {
  const start = commandStart.exec(segment)?.index
  if (start === undefined) {
    return []
  }
  const shellText = ' '.repeat(start) + blankQuoted(segment.slice(start), []).text
  return findPlaceholders(shellText, segmentOffset, lineNumber, file)
}

const findPlaceholders = (
  shellText: string,
  segmentOffset: number,
  lineNumber: number,
  file: string
): Finding[] =>
  [...shellText.matchAll(PLACEHOLDER_PATTERN)].map((match) =>
    commandExampleFinding(
      file,
      lineNumber,
      segmentOffset + match.index + 1,
      match[0],
      `quote the placeholder so it reaches argv as one word: "${match[0]}"`
    )
  )

// Bash quoting, as far as telling a quoted placeholder from an unquoted one needs: '…' is literal;
// "…" honours backslash escapes and opens `$( … )`, whose contents are unquoted shell again with
// their own quoting; an unquoted backslash escapes the next character; and an unquoted `#` that
// starts a word begins a comment. Every quoted, escaped or commented character becomes a space, so
// what remains is the text a shell would read as syntax, at the same columns as the original.
type QuoteContext = 'single' | 'double' | 'substitution' | 'group'

const blankQuoted = (
  text: string,
  carried: readonly QuoteContext[]
): { text: string; open: readonly QuoteContext[] } => {
  const stack = [...carried]
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    const context = stack.at(-1)
    if (context === 'single') {
      if (ch === "'") {
        stack.pop()
      }
      out += ' '
      continue
    }
    if (ch === '\\') {
      out += ' '.repeat(Math.min(2, text.length - i))
      i++
      continue
    }
    if (context === 'double') {
      if (ch === '$' && text.charAt(i + 1) === '(') {
        stack.push('substitution')
        out += '  '
        i++
        continue
      }
      if (ch === '"') {
        stack.pop()
      }
      out += ' '
      continue
    }
    if (ch === "'" || ch === '"') {
      stack.push(ch === "'" ? 'single' : 'double')
      out += ' '
      continue
    }
    if (ch === '(') {
      stack.push(text.charAt(i - 1) === '$' ? 'substitution' : 'group')
    }
    if (ch === ')' && (context === 'substitution' || context === 'group')) {
      stack.pop()
    }
    if (ch === '#' && (i === 0 || /\s/.test(text.charAt(i - 1)))) {
      return { text: out + ' '.repeat(text.length - i), open: stack }
    }
    out += ch
  }
  return { text: out, open: stack }
}

const commandStartPattern = (toolNames: readonly string[]): RegExp => {
  const names = [...toolNames, ...EXTERNAL_COMMANDS].map(escapeRegExp).join('|')
  return new RegExp(`(?<![\\w./$-])(?:${names})\\s`)
}

const dedent = (body: readonly string[]): string[] => {
  const indents = body
    .filter((line) => line.trim() !== '')
    .map((line) => line.length - line.trimStart().length)
  const strip = Math.min(...indents)
  return body.map((line) => line.slice(strip))
}

const commandExampleFinding = (
  file: string,
  line: number,
  col: number,
  matched: string,
  fix: string
): Finding => ({ file, line, col, category: 'command-example', matched, fix })
