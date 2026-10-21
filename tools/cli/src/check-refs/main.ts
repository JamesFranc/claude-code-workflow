import { globSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { splitLines } from '../split-lines.ts'
import { findEntryCapFindings } from './entry-cap.ts'
import { findFenceShapeFindings } from './fence-shape.ts'
import { findHeadingCitationFindings } from './heading-citations.ts'
import { findPathCitationFindings } from './path-citations.ts'
import { findQuestionFlagFindings } from './question-flags.ts'
import { findCommandExampleFindings } from './command-examples.ts'
import { findSkillNameFindings } from './skill-name.ts'
import { escapeRegExp } from './escape-regexp.ts'

export interface Finding {
  file: string
  line: number
  col: number
  category:
    | 'relative'
    | 'env-var'
    | 'absolute'
    | 'fence-shape'
    | 'heading-citation'
    | 'path-citation'
    | 'path-heading-citation'
    | 'entry-cap'
    | 'question-flag'
    | 'command-example'
    | 'skill-name'
  matched: string
  fix: string
}

interface CheckRefsOutput {
  findings: Finding[]
  count: number
}

export const runCheckRefs = (root: string): void => {
  const toolNames = readBinToolNames(root)
  const findings = scanFiles(root, toolNames)

  for (const f of findings) {
    console.error(formatFinding(f))
  }

  const output: CheckRefsOutput = { findings, count: findings.length }
  process.stdout.write(JSON.stringify(output) + '\n')
  setRequestedExitCode(findings.length > 0 ? 1 : 0)
}

const scanFiles = (root: string, toolNames: readonly string[]): Finding[] => {
  const files = [
    ...globSync('skills/**/*.md', { cwd: root }),
    ...globSync('agents/**/*.md', { cwd: root }),
    ...globSync('commands/**/*.md', { cwd: root }),
    ...globSync('CLAUDE.md', { cwd: root }),
  ]
  const markdownFindings = files.flatMap((relPath) => scanFile(root, relPath, toolNames))
  // hooks/*.sh ships instruction text to agents too — a bare invocation there silences questions
  // exactly as one in a skill does, and a command in a heredoc is a template an agent copies — but it
  // is shell, not Markdown, so only the question-flag and command-example checks apply.
  // hooks/test-*.sh is excluded: those files are local test harnesses that ship fixtures to a test
  // runner, not instructions to an agent.
  const hookFindings = globSync('hooks/*.sh', { cwd: root })
    .filter((relPath) => !relPath.startsWith('hooks/test-'))
    .flatMap((relPath) => {
      const content = readFileSync(join(root, relPath), 'utf-8')
      return [
        ...findQuestionFlagFindings(content, relPath),
        ...findCommandExampleFindings(content, relPath, toolNames),
      ]
    })
  return [...markdownFindings, ...hookFindings]
}

const scanFile = (root: string, relPath: string, toolNames: readonly string[]): Finding[] => {
  const content = readFileSync(join(root, relPath), 'utf-8')
  const lines = splitLines(content)
  const lineFindings = lines.flatMap((line, i) => scanLine(line, relPath, i + 1, toolNames))
  const fenceFindings = findFenceShapeFindings(content, relPath)
  const headingCitationFindings = findHeadingCitationFindings(content, relPath)
  const pathCitationFindings = findPathCitationFindings(content, relPath, root)
  const entryCapFindings = findEntryCapFindings(content, relPath)
  const questionFlagFindings = findQuestionFlagFindings(content, relPath)
  const commandExampleFindings = findCommandExampleFindings(content, relPath, toolNames)
  const skillNameFindings = findSkillNameFindings(content, relPath)
  return [
    ...lineFindings,
    ...fenceFindings,
    ...headingCitationFindings,
    ...pathCitationFindings,
    ...entryCapFindings,
    ...questionFlagFindings,
    ...commandExampleFindings,
    ...skillNameFindings,
  ]
}

const scanLine = (
  line: string,
  file: string,
  lineNum: number,
  toolNames: readonly string[]
): Finding[] => {
  const findings: Finding[] = []

  const toolsUnion = toolNames.map(escapeRegExp).join('|')
  const binPattern = new RegExp(`(?:([^\\s\`"'(]+)\\/)?bin\\/(${toolsUnion})`, 'g')
  let match: RegExpExecArray | null
  while ((match = binPattern.exec(line)) !== null) {
    const prefix = match[1]
    const tool = match[2]!
    const col = match.index + 1
    const matched = match[0]
    findings.push({
      file,
      line: lineNum,
      col,
      category: classifyBinRef(prefix),
      matched,
      fix: tool,
    })
  }

  return findings
}

const classifyBinRef = (prefix: string | undefined): Finding['category'] => {
  if (prefix === undefined || prefix === '') {
    return 'relative'
  }
  if (prefix.endsWith('}')) {
    return 'env-var'
  }
  return 'absolute'
}

const formatFinding = (f: Finding): string => {
  if (
    f.category === 'fence-shape' ||
    f.category === 'heading-citation' ||
    f.category === 'path-citation' ||
    f.category === 'path-heading-citation' ||
    f.category === 'entry-cap' ||
    f.category === 'question-flag' ||
    f.category === 'command-example' ||
    f.category === 'skill-name'
  ) {
    return `${f.file}:${f.line}:${f.col}  ${f.category}  '${f.matched}' → ${f.fix}`
  }
  return `${f.file}:${f.line}:${f.col}  ${f.category}  '${f.matched}' → use bare '${f.fix}'`
}

const readBinToolNames = (root: string): readonly string[] =>
  readdirSync(join(root, 'bin'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
