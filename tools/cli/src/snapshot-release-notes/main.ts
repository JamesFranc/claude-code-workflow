import { readFileSync } from 'node:fs'

import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { PublishCheckCannotRun } from '../publish-check/git.ts'
import { errorCode, readPrivateTermsFile, type PrivateTerms } from '../publish-check/terms.ts'
import { publicNotes, type PublicNotes } from './notes.ts'

export interface SnapshotReleaseNotesFlags {
  file: string
  sourceRepo: string
  terms: string
}

export const runSnapshotReleaseNotes = (flags: SnapshotReleaseNotesFlags): void => {
  const outcome = snapshotReleaseNotes(flags)
  if (outcome.kind === 'refused') {
    console.error(`snapshot-release-notes: refused: ${outcome.reason.replace(/\s+/g, ' ')}`)
    setRequestedExitCode(REFUSED_EXIT)
    return
  }

  process.stdout.write(outcome.notes)
  setRequestedExitCode(0)
}

const snapshotReleaseNotes = (flags: SnapshotReleaseNotesFlags): PublicNotes => {
  if (!SOURCE_REPO_PATTERN.test(flags.sourceRepo)) {
    return { kind: 'refused', reason: `--source-repo must be owner/name, got ${flags.sourceRepo}` }
  }

  let source: string
  try {
    source = readFileSync(flags.file, 'utf8')
  } catch (error) {
    return { kind: 'refused', reason: `cannot read ${flags.file}: ${errorCode(error)}` }
  }

  let terms: PrivateTerms
  try {
    terms = readPrivateTermsFile(flags.terms)
  } catch (error) {
    if (error instanceof PublishCheckCannotRun) {
      return { kind: 'refused', reason: error.message }
    }

    throw error
  }

  return publicNotes(source, flags.sourceRepo, terms)
}

const SOURCE_REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const REFUSED_EXIT = 2
