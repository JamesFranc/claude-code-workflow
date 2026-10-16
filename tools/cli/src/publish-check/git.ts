import { execFileSync } from 'node:child_process'

// Any failure that stops the check before it can say whether the export set is clean. It maps to
// exit 2, so a broken run is never read as "findings" (1) or as "clean" (0).
export class PublishCheckCannotRun extends Error {}

export const git = (repo: string, args: readonly string[], failure: string): string =>
  run('git', ['--no-replace-objects', '-C', repo, ...args], failure)

export const run = (command: string, args: readonly string[], failure: string): string => {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: OUTPUT_LIMIT_BYTES,
    })
  } catch (error) {
    const detail = stderrOf(error)
    throw new PublishCheckCannotRun(detail.length > 0 ? `${failure}: ${detail}` : failure)
  }
}

const stderrOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'stderr' in error
    ? String(error.stderr ?? '').trim()
    : ''

const OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024
