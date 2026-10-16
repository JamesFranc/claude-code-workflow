import {
  appendLine,
  loadClassified,
  StoreUnreadableError,
  storePath,
  ticketScope,
} from '../workflow-store/store.ts'
import { writeCapturedOutput, type CapturedOutput } from '../workflow-store/captured-output.ts'
import { fitLine, type FitLineResult } from '../workflow-store/line-budget.ts'
import type { GateRole } from './manifest.ts'

// The three conditions that license re-running a gate already recorded at this SHA, at one whose recorded tree is identical, or at any SHA when the tree of the SHA being recorded cannot be resolved, or recording
// one a role does not own. Closed list — see the plan's "closed re-run list" table,
// skills/team-dispatch/SKILL.md's "The team lead checks a teammate's proof rather than
// re-deriving it" step (where these three triggers are defined) and its "A gate runs once per SHA,
// and one role owns it" step (the closed re-run list applied to gates), whose vocabulary this
// deliberately reuses.
export type RerunCondition = 'inconsistent' | 'contradicted' | 'superseded'

export interface GateRunEvent {
  kind: 'gate-run'
  at: string
  gate: string
  sha: string
  // The tree `sha` names, when record could resolve it. `record`'s licence guard counts a run at
  // another sha with this tree as a prior run (and, when record cannot resolve the tree, a run at
  // any sha), and `check` reuses such a run for a sha that has none
  // of its own, so a squash or a no-op rebase (new sha, same tree) does not re-run every gate. A
  // sha's own runs always decide its state. Absent on runs recorded before it existed, or outside a
  // repo that has the sha; those match by sha only.
  tree?: string
  exitStatus: number
  role: GateRole
  outputPath: string
  outputSha256: string
  outputBytes: number
  tail: string
  truncated?: true
  lineTruncated?: true
  condition?: RerunCondition
  reason?: string
}

export interface GateLedger {
  ticket: string
  runs: GateRunEvent[]
  skippedLines: number
}

const LEDGER_FILE = 'gate-ledger.jsonl'

export const gateLedgerPath = (ticket: string): string =>
  storePath(ticketScope(ticket), LEDGER_FILE)

export const readGateLedger = (ticket: string): GateLedger => {
  const read = loadClassified(ticketScope(ticket), LEDGER_FILE)
  if (read.kind === 'unreadable') throw new StoreUnreadableError(gateLedgerPath(ticket), read.code)
  const lines =
    read.kind === 'absent' ? [] : read.content.split('\n').filter((l) => l.trim().length > 0)
  const runs: GateRunEvent[] = []
  let skippedLines = 0
  for (const line of lines) {
    const event = parseEvent(line)
    if (event === null) skippedLines += 1
    else runs.push(event)
  }
  return { ticket, runs, skippedLines }
}

// Every run recorded for one gate at the sha, or at any sha naming the same tree, in append order.
// A re-run does not replace the run it re-runs: both stay visible, which is what makes "who re-ran
// this, and under which condition" answerable from the record alone.
export const runsFor = (
  ledger: GateLedger,
  gate: string,
  sha: string,
  tree: string | null = null
): GateRunEvent[] =>
  ledger.runs.filter(
    (r) => r.gate === gate && (r.sha === sha || (tree !== null && r.tree === tree))
  )

export const appendGateRun = (ticket: string, event: GateRunEvent): void => {
  appendLine(gateLedgerPath(ticket), serialize(event).line)
}

const serialize = (event: GateRunEvent): FitLineResult<GateRunEvent> =>
  fitLine(
    event,
    [
      { name: 'tail', keep: 'end' },
      { name: 'reason', keep: 'front' },
    ],
    'gate-ledger'
  )

export const writeGateOutput = (
  ticket: string,
  gate: string,
  sha: string,
  output: string
): CapturedOutput => writeCapturedOutput(ticket, 'gate-output', gate, sha, output)

// A line this fold cannot use is COUNTED, never thrown on — the same contract review-ledger's
// parseEvent has. One corrupt line must not make the whole ledger unreadable, because an unreadable
// ledger reads to `check` as zero records, which reads as every gate missing, which blocks
// everything for a reason that has nothing to do with the gates.
const parseEvent = (line: string): GateRunEvent | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const e = parsed as Record<string, unknown>
  if (e.kind !== 'gate-run') return null
  if (typeof e.gate !== 'string' || typeof e.sha !== 'string') return null
  if (typeof e.exitStatus !== 'number') return null
  if (e.role !== 'implementer' && e.role !== 'team-lead' && e.role !== 'senior') return null
  return parsed as GateRunEvent
}
