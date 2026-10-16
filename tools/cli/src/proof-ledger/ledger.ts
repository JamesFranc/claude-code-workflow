import { createHash } from 'node:crypto'
import {
  appendLine,
  loadClassified,
  StoreUnreadableError,
  storePath,
  ticketScope,
} from '../workflow-store/store.ts'
import { writeCapturedOutput, type CapturedOutput } from '../workflow-store/captured-output.ts'
import { fitLine, type FitLineResult } from '../workflow-store/line-budget.ts'

// The four acceptance-contract fields, as capture kinds. 'red' and 'green' are the two halves of a
// RED baseline; 'sweep' and 'evidence' discharge the contract's other two fields.
export type CaptureKind = 'sweep' | 'red' | 'green' | 'evidence'

export interface ProofCaptureEvent {
  kind: 'proof-capture'
  at: string
  id: string
  task: string
  capture: CaptureKind
  sha: string
  command: string
  exitStatus: number
  outputPath: string
  outputSha256: string
  outputBytes: number
  tail: string
  // On a capture recorded now, present only on 'red': the git diff of the mutation that was
  // actually applied, so the mutation can be checked against the pre-fix code instead of taken on
  // the implementer's word. The ledger is append-only, so a row recorded before record refused
  // these fields on a non-red capture can still carry them under another kind — a legacy-equivalent
  // state this ledger's validity rules already tolerate, the same way unverifiedMutationPaths'
  // absence tolerates a row that predates that field.
  mutationPath?: string
  mutationSha256?: string
  mutationBytes?: number
  truncated?: true
  lineTruncated?: true
  note?: string
  // Present only when this capture's --command never read the tree at all, so --sha names only
  // which commit it belongs to rather than something it certified — declared by the caller, never
  // derived from --command's text, since only the caller knows whether it reads the repository.
  // This is what makes "a recorded command that never reads the repository" an enumerable set over
  // the ledger's own history, rather than something checkable only against documented examples.
  shaIsLabel?: true
  // Present only on a 'red' capture recorded with a --repo-root check (never on one recorded under
  // NO_REPO_ROOT_CHECK, where this never ran): every path redMutationMismatch could not resolve and
  // verify, in the exact shape it returned — [] when every section verified. Derived only, at record
  // time, by redMutationMismatch; never caller-settable. Absence is deliberately never "verified" —
  // it means either this row predates the field or its capture never ran the check at all, both
  // legacy-equivalent states this ledger's validity rules already tolerated before this field existed
  // (the marker must survive to a later read, not just the record call's own stdout; the ambiguity
  // between a row that predates the field and one whose capture never ran the check could not close
  // before this field existed, because nothing was persisted at all).
  unverifiedMutationPaths?: string[]
  // Present on every sweep recorded since FLOW-337: the package dirs the sweep was allowed to run
  // over, repo-relative, verified at record time against the diff at --sha (runRecord's
  // sweepScopeRefusal). Absent on a sweep recorded before, and on every other capture kind.
  scope?: string[]
}

// A capture-requirement declaration, as previously written by a now-removed `require` command.
// readProofLedger still classifies lines of this kind rather than counting them as unparseable,
// since existing ledgers already contain them and an unparseable line makes check/show exit 4.
export interface ExpectedCommand {
  kind: CaptureKind
  command: string
}

export interface ProofRequirementEvent {
  kind: 'proof-requirement'
  at: string
  id: string
  task: string
  required: CaptureKind[]
  expectCommands: ExpectedCommand[]
  note?: string
}

export type LedgerEvent = ProofCaptureEvent | ProofRequirementEvent

export interface ProofLedger {
  ticket: string
  captures: ProofCaptureEvent[]
  requirements: ProofRequirementEvent[]
  skippedLines: number
}

const LEDGER_FILE = 'proof-ledger.jsonl'

export const proofLedgerPath = (ticket: string): string =>
  storePath(ticketScope(ticket), LEDGER_FILE)

export const readProofLedger = (ticket: string): ProofLedger => {
  const read = loadClassified(ticketScope(ticket), LEDGER_FILE)
  if (read.kind === 'unreadable') throw new StoreUnreadableError(proofLedgerPath(ticket), read.code)
  const lines =
    read.kind === 'absent' ? [] : read.content.split('\n').filter((l) => l.trim().length > 0)
  const captures: ProofCaptureEvent[] = []
  const requirements: ProofRequirementEvent[] = []
  let skippedLines = 0
  for (const line of lines) {
    const event = parseEvent(line)
    if (event === null) skippedLines += 1
    else if (event.kind === 'proof-capture') captures.push(event)
    else requirements.push(event)
  }
  return { ticket, captures, requirements, skippedLines }
}

// Every capture recorded for one (task, capture, sha), in append order. A re-capture does not
// replace the one it repeats: both stay visible.
export const capturesFor = (
  ledger: ProofLedger,
  task: string,
  capture: CaptureKind,
  sha: string
): ProofCaptureEvent[] =>
  ledger.captures.filter((c) => c.task === task && c.capture === capture && c.sha === sha)

export const appendProofCapture = (
  ticket: string,
  event: ProofCaptureEvent
): { noteTruncated: boolean } => {
  const { line, shrunkFields } = serialize(event)
  appendLine(proofLedgerPath(ticket), line)
  return { noteTruncated: shrunkFields.includes('note') }
}

export const writeProofOutput = (
  ticket: string,
  capture: CaptureKind,
  task: string,
  sha: string,
  output: string
): CapturedOutput => writeCapturedOutput(ticket, 'proof-output', `${capture}-${task}`, sha, output)

export const writeMutationDiff = (
  ticket: string,
  task: string,
  sha: string,
  diff: string
): CapturedOutput => writeCapturedOutput(ticket, 'proof-output', `mutation-${task}`, sha, diff)

// Content-addressed: the same command, at the same sha, for the same task, producing byte-identical
// output yields the same id. That is what lets a proofs-file index entry be checked against the
// ledger without holding any state between the two.
export const captureId = (
  task: string,
  capture: CaptureKind,
  sha: string,
  command: string,
  outputSha256: string
): string =>
  createHash('sha256')
    .update([task, capture, sha, command, outputSha256].join(' '))
    .digest('hex')
    .slice(0, 12)

// tail and note are the only free-text fields shrunk to fit the line budget — tail holds the END of
// the command's output, where a failure message is, so it keeps its end, and its full content always
// has a sidecar (the output file written alongside this event), so shrinking it here loses nothing.
// note has no sidecar, so a shrunk note IS a real, permanent loss — appendProofCapture reports it via
// FitLineResult.shrunkFields so the caller can surface it. command is deliberately NOT listed: it is
// the identifier `--expect-command` matches against and `captureId` hashes, so a command silently
// different from what was passed would corrupt both silently. Losing part of a command must fail loud
// instead — an oversized command runs the line over budget with nothing left to shrink, and fitLine
// throws.
const serialize = (event: ProofCaptureEvent): FitLineResult<ProofCaptureEvent> =>
  fitLine(
    event,
    [
      { name: 'tail', keep: 'end' },
      { name: 'note', keep: 'front' },
    ],
    'proof-ledger'
  )

const isCaptureKind = (value: unknown): value is CaptureKind =>
  value === 'sweep' || value === 'red' || value === 'green' || value === 'evidence'

// A line this fold cannot use is COUNTED, never thrown on — one corrupt line must not make the whole
// ledger unreadable. The count alone proves nothing; it is `run.ts`'s `runCheck` that turns a
// non-zero count into a blocking result (exit 4) rather than letting the corrupt line quietly read
// as an absent capture or absent requirement.
const parseEvent = (line: string): LedgerEvent | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const e = parsed as Record<string, unknown>
  if (e.kind === 'proof-capture') return parseCaptureEvent(e)
  if (e.kind === 'proof-requirement') return parseRequirementEvent(e)
  return null
}

const parseCaptureEvent = (e: Record<string, unknown>): ProofCaptureEvent | null => {
  if (typeof e.task !== 'string' || typeof e.sha !== 'string' || typeof e.id !== 'string')
    return null
  if (typeof e.command !== 'string' || typeof e.exitStatus !== 'number') return null
  if (!isCaptureKind(e.capture)) return null
  if (
    e.scope !== undefined &&
    !(Array.isArray(e.scope) && e.scope.every((dir) => typeof dir === 'string'))
  )
    return null
  return e as unknown as ProofCaptureEvent
}

const parseRequirementEvent = (e: Record<string, unknown>): ProofRequirementEvent | null => {
  if (typeof e.task !== 'string' || typeof e.id !== 'string') return null
  if (!Array.isArray(e.required) || !e.required.every(isCaptureKind)) return null
  if (
    !Array.isArray(e.expectCommands) ||
    !e.expectCommands.every(
      (ec): ec is ExpectedCommand =>
        typeof ec === 'object' &&
        ec !== null &&
        isCaptureKind((ec as Record<string, unknown>).kind) &&
        typeof (ec as Record<string, unknown>).command === 'string'
    )
  )
    return null
  return e as unknown as ProofRequirementEvent
}
