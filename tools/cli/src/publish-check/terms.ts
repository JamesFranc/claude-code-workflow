import { readFileSync } from 'node:fs'

import { git, PublishCheckCannotRun } from './git.ts'

export const PRIVATE_TERMS_PATH = '.private-terms.json'

export interface PrivateTerms {
  handles: readonly string[]
  privateRepos: readonly string[]
  privateHosts: readonly string[]
  phrases: readonly string[]
}

// Read from the commit being checked, not the working tree: the file is excluded from the export
// set, so it is never among the files scanned.
export const readPrivateTerms = (repo: string, sha: string): PrivateTerms =>
  parsePrivateTerms(
    git(repo, ['show', `${sha}:${PRIVATE_TERMS_PATH}`], `no ${PRIVATE_TERMS_PATH} at ${sha}`)
  )

// For a repo that does not carry the file, such as a clone of the published snapshot.
export const readPrivateTermsFile = (path: string): PrivateTerms => {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new PublishCheckCannotRun(`cannot read ${path}: ${errorCode(error)}`)
  }

  return parsePrivateTerms(raw)
}

export const errorCode = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : String(error)

const parsePrivateTerms = (raw: string): PrivateTerms => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw malformed('not valid JSON')
  }

  if (!isRecord(parsed)) {
    throw malformed('not a JSON object')
  }

  return {
    handles: termList(parsed, 'handles'),
    privateRepos: termList(parsed, 'privateRepos'),
    privateHosts: termList(parsed, 'privateHosts'),
    phrases: termList(parsed, 'phrases'),
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const termList = (record: Record<string, unknown>, field: string): string[] => {
  const value = record[field]
  if (!isTermList(value)) {
    throw malformed(`${field} must be an array of non-blank strings`)
  }

  return value
}

const isTermList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((term) => typeof term === 'string' && term.trim().length > 0)

const malformed = (detail: string): PublishCheckCannotRun =>
  new PublishCheckCannotRun(`${PRIVATE_TERMS_PATH} is malformed: ${detail}`)
