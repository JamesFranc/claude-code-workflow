import { splitLines } from '../split-lines.ts'
import type { Finding } from './main.ts'

// The Agent Skills specification (https://agentskills.io/specification) requires a skill's `name`
// to use only lowercase letters, numbers and hyphens, to be at most 64 characters, and to match its
// parent directory name.
const MAX_NAME_LENGTH = 64
const SKILL_FILE_RE = /^skills\/([^/]+)\/SKILL\.md$/
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const NAME_RE = /^name:\s*(.*?)\s*$/
const QUOTED_RE = /^(["'])(.*?)\1(?:\s+#.*)?$/
const TRAILING_COMMENT_RE = /(^|\s+)#.*$/

interface Frontmatter {
  shape: 'missing' | 'unterminated' | 'closed'
  nameLine: { line: number; value: string } | undefined
}

export const findSkillNameFindings = (content: string, file: string): Finding[] => {
  const dir = SKILL_FILE_RE.exec(file)?.[1]
  if (dir === undefined) {
    return []
  }

  const { shape, nameLine } = readFrontmatter(splitLines(content))
  const name = nameLine === undefined ? undefined : scalarValue(nameLine.value)
  const actions = requiredActions(dir, shape, name)
  if (actions.length === 0) {
    return []
  }

  const fix = actions.join(', then ')
  if (shape === 'unterminated') {
    return [skillNameFinding(file, 1, '(unterminated frontmatter)', fix)]
  }
  if (nameLine === undefined || name === undefined) {
    return [skillNameFinding(file, 1, '(no name)', fix)]
  }
  return [skillNameFinding(file, nameLine.line, name, fix)]
}

// Every condition the file fails contributes its action, so the fix names all that must change
// before the check passes, and a condition added later cannot leave an older message false.
const requiredActions = (
  dir: string,
  shape: Frontmatter['shape'],
  name: string | undefined
): string[] => {
  const actions: string[] = []
  if (shape === 'missing') {
    actions.push('start the file with a `---` frontmatter block')
  }
  if (shape === 'unterminated') {
    actions.push('close the frontmatter with a `---` line after its last key')
  }
  if (!SLUG_RE.test(dir) || dir.length > MAX_NAME_LENGTH) {
    actions.push(
      `rename the directory to a lowercase hyphenated slug of at most ${MAX_NAME_LENGTH} characters (letters, numbers, hyphens) and set the frontmatter \`name\` to match`
    )
  } else if (shape === 'unterminated') {
    actions.push(`make sure the frontmatter holds \`name: ${dir}\``)
  } else if (name !== dir) {
    actions.push(`set the frontmatter \`name: ${dir}\``)
  }
  return actions
}

const FENCE_RE = /^---\s*$/

const readFrontmatter = (lines: string[]): Frontmatter => {
  if (!FENCE_RE.test(lines[0] ?? '')) {
    return { shape: 'missing', nameLine: undefined }
  }

  let nameLine: Frontmatter['nameLine']
  for (let i = 1; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i] ?? '')) {
      return { shape: 'closed', nameLine }
    }
    const value = nameLine === undefined ? NAME_RE.exec(lines[i] ?? '')?.[1] : undefined
    if (value !== undefined) {
      nameLine = { line: i + 1, value }
    }
  }
  return { shape: 'unterminated', nameLine: undefined }
}

const scalarValue = (value: string): string => {
  const quoted = QUOTED_RE.exec(value)
  return quoted === null ? value.replace(TRAILING_COMMENT_RE, '') : (quoted[2] ?? '')
}

const skillNameFinding = (file: string, line: number, matched: string, fix: string): Finding => ({
  file,
  line,
  col: 1,
  category: 'skill-name',
  matched,
  fix,
})
