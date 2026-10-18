import type { ChangeType, StateChange } from './state.ts'

export const formatChanges = (prNumber: string, repo: string, changes: StateChange[]): string => {
  const lines: string[] = [`[pr-monitor] changes detected on ${repo}#${prNumber}`, '']

  for (const change of changes) {
    lines.push(`  [${change.type}] ${change.detail}`)
    const instruction = approvalInstructions[change.type]
    if (instruction) {
      lines.push(`    → ${instruction}`)
    }
  }

  return lines.join('\n')
}

// The changes whose PR Lifecycle handler ends in an approval item, and the line printed under each
// (FLOW-427). The handler is read once, when the skill loads; the wake line is the one place the
// agent is sure to see when the event lands, the same reason releasedItemInstruction
// (dashboard/released.ts) puts its command there.
const approvalInstructions: Partial<Record<ChangeType, string>> = {
  CI_GREEN_ON_DRAFT:
    'run the PR Lifecycle CI_GREEN_ON_DRAFT handler (flush the deferred queue, check for open questions); it ends in a `dashboard item add --type approval` flip-to-ready item, never an info note. Withdraw any note already posted for it.',
  MERGE_READY:
    'run the PR Lifecycle MERGE_READY handler (flush the deferred queue, check for open questions, move the ticket to review, look up approvers); it ends in a `dashboard item add --type approval` merge item, never an info note. Withdraw any note already posted for it.',
}
