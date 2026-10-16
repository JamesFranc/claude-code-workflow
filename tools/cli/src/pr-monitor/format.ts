import type { StateChange } from './state.ts'

export const formatChanges = (prNumber: string, repo: string, changes: StateChange[]): string => {
  const lines: string[] = [`[pr-monitor] changes detected on ${repo}#${prNumber}`, '']

  for (const change of changes) {
    lines.push(`  [${change.type}] ${change.detail}`)
  }

  return lines.join('\n')
}
