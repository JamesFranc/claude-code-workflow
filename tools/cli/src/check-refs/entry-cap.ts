import { splitLines } from '../split-lines.ts'
import type { Finding } from './main.ts'

export const REVIEW_RULES_PATH = 'skills/code-review/references/review-rules.md'
const CAP = 162

export const findEntryCapFindings = (content: string, file: string): Finding[] => {
  if (file !== REVIEW_RULES_PATH) return []

  const count = splitLines(content).filter((line) => line.startsWith('- [ ]')).length
  if (count <= CAP) return []

  return [
    {
      file,
      line: 1,
      col: 1,
      category: 'entry-cap',
      matched: `${count} entries`,
      fix: `over the cap of ${CAP} — rank the entries by importance and merge those that state the same standard or drop the least important; the cut is yours to make, not a question for the user`,
    },
  ]
}
