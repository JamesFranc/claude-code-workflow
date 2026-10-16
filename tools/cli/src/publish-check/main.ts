import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { withExportSet } from './export-set.ts'
import { git, PublishCheckCannotRun } from './git.ts'
import { scanExportSet, type Finding } from './scan.ts'
import { readPrivateTerms, readPrivateTermsFile } from './terms.ts'

export interface PublishCheckFlags {
  commit: string
  repo: string
  terms?: string
}

export const runPublishCheck = (flags: PublishCheckFlags): void => {
  try {
    report(publishCheck(flags.repo, flags.commit, flags.terms))
  } catch (error) {
    const reason = error instanceof PublishCheckCannotRun ? error.message : String(error)
    console.error(`publish-check: could not run: ${reason}`)
    setRequestedExitCode(CANNOT_RUN_EXIT)
  }
}

export interface CheckResult {
  files: number
  findings: Finding[]
}

export const publishCheck = (repo: string, commit: string, termsPath?: string): CheckResult => {
  git(repo, ['rev-parse', '--git-dir'], `not a git repository: ${repo}`)
  const sha = git(
    repo,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^{commit}`],
    `unreadable commit: ${commit}`
  ).trim()
  const terms =
    termsPath === undefined ? readPrivateTerms(repo, sha) : readPrivateTermsFile(termsPath)

  return withExportSet(repo, sha, (dir, files) => ({
    files: files.length,
    findings: scanExportSet(dir, files, terms),
  }))
}

const report = (result: CheckResult): void => {
  if (result.findings.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, files: result.files }) + '\n')
    setRequestedExitCode(0)
    return
  }

  reportFindings(result.findings)
}

export const reportFindings = (findings: readonly Finding[]): void => {
  for (const finding of findings) {
    console.error(formatFinding(finding))
  }
  process.stdout.write(JSON.stringify({ ok: false, findings }) + '\n')
  setRequestedExitCode(FINDINGS_EXIT)
}

const formatFinding = (finding: Finding): string => {
  const line = finding.line === undefined ? '' : `:${finding.line}`

  return `${finding.class} ${oneLine(finding.path)}${line} ${oneLine(finding.match)}`
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ')

const FINDINGS_EXIT = 1
const CANNOT_RUN_EXIT = 2
