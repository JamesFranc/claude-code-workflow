import { escapeRegExp } from '../check-refs/escape-regexp.ts'
import { privateTextMatches } from '../publish-check/scan.ts'
import type { PrivateTerms } from '../publish-check/terms.ts'

// Release-please notes link every entry into the source repository. The snapshot is public and the
// source is not, so each link would 404 there, and the PR numbers, commit shas and ticket keys name
// things only the source can see.
export type PublicNotes = { kind: 'notes'; notes: string } | { kind: 'refused'; reason: string }

export const publicNotes = (
  source: string,
  sourceRepo: string,
  terms: PrivateTerms
): PublicNotes => {
  const repoUrl = escapeRegExp(`https://github.com/${sourceRepo}`)
  const lines = source
    .trimEnd()
    .split('\n')
    .map((line) => publicLine(line, repoUrl))

  if (!lines.some((line) => ENTRY_PATTERN.test(line))) {
    return { kind: 'notes', notes: `${NO_CHANGES}\n` }
  }

  const notes = lines.join('\n') + '\n'
  const leak = privateReference(notes, sourceRepo, terms)
  return leak === undefined
    ? { kind: 'notes', notes }
    : { kind: 'refused', reason: `the public notes would still name ${leak}` }
}

const publicLine = (line: string, repoUrl: string): string =>
  line
    .replace(new RegExp(` \\(\\[#\\d+\\]\\(${repoUrl}[^)]*\\)\\)`, 'gi'), '')
    .replace(new RegExp(` \\(\\[[0-9a-f]{7,40}\\]\\(${repoUrl}[^)]*\\)\\)`, 'gi'), '')
    .replace(new RegExp(`\\[([^\\]]*)\\]\\(${repoUrl}[^)]*\\)`, 'gi'), '$1')
    .replace(TICKET_PREFIX_PATTERN, '$1')

// Refuses the source repo's name, anything publish-check refuses in an exported line (a private
// term, a credential, a home-directory path), a #N reference or a ticket key left in the notes.
// Nothing else is checked: a bare commit sha, or a link into another private repo that carries no
// term and no #N, is published.
const privateReference = (
  notes: string,
  sourceRepo: string,
  terms: PrivateTerms
): string | undefined => {
  if (notes.toLowerCase().includes(sourceRepo.toLowerCase())) {
    return sourceRepo
  }

  return (
    privateTextMatches(notes, terms)[0] ??
    PR_REFERENCE_PATTERN.exec(notes)?.[0] ??
    TICKET_KEY_PATTERN.exec(notes)?.[0]
  )
}

const NO_CHANGES = 'No user-facing changes.'
const ENTRY_PATTERN = /^\s*\* /
const TICKET_PREFIX_PATTERN = /^(\s*\* )(?:\[[A-Z][A-Z0-9]*-\d+\]\s*)+/
const PR_REFERENCE_PATTERN = /#\d+\b/
const TICKET_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/
