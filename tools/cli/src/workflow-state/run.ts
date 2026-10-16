import { loadState, stateFileIsCorrupt } from '../dashboard/state.ts'
import { resolveRawSessionId, resolveSessionId } from '../dashboard/session-id.ts'
import { RegistryUnreadableError } from '../dashboard/registry.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { loadWorkflowState, markWorkflowEntered, recordBypass } from './state.ts'

// Marker-only entry point: a Team-Dispatch teammate has its
// own distinct raw session id (see the gate-proofs file's session-id table) and so needs its
// own marker, but must NEVER run `dashboard session enter` for it — that would mint a second
// board node for a story the lead already registered, breaking the board's one-ticket-one-node
// model. This verb writes only the local marker, no board interaction, no dashboard node. Named
// `record-entry` (not `enter`) and stamped `via: 'record-entry'` — it does not enter a workflow
// or mint a board node, and the marker must always be traceable to the verb that wrote it.
export const runRecordEntry = (phase: string, key: string | undefined, session?: string): void => {
  // Same class of defect as runBypass's blank --reason: a blank phase
  // would satisfy the gate with an unusable marker. --key is cosmetic (carries a display key,
  // not consulted by the gate check itself), so a blank key is normalized to omitted rather than
  // rejected outright.
  if (phase.trim().length === 0) {
    throw new Error('workflow-state record-entry: --phase must not be empty')
  }
  // Store the trimmed value, not the raw one: "implementation"
  // and "  implementation  " should read back identically everywhere the marker is displayed.
  const trimmedPhase = phase.trim()
  const normalizedKey = key !== undefined && key.trim().length === 0 ? undefined : key
  const rawId = resolveRawSessionId(session)
  markWorkflowEntered(rawId, { phase: trimmedPhase, key: normalizedKey, via: 'record-entry' })
  process.stdout.write(
    `workflow-state: entry recorded for this session (phase=${trimmedPhase}${normalizedKey !== undefined ? `, key=${normalizedKey}` : ''})\n`
  )
}

// Exit contract (consumed by hooks/workflow-entry-gate.sh): 0 = workflow or bypass present,
// 3 = neither (block). Any other failure mode (missing session id) throws → generic non-zero,
// which the gate hook treats as infra error and FAILS OPEN — never brick edits on a crash.
export const runCheck = (session?: string): void => {
  const rawId = resolveRawSessionId(session)
  const state = loadWorkflowState(rawId)
  if (state?.workflow !== undefined || state?.bypass !== undefined) return
  setRequestedExitCode(3)
}

export const runBypass = (reason: string, session?: string): void => {
  // A blank/whitespace-only reason defeats the audit trail the whole bypass mechanism exists
  // for. Guarded here, not in the command func, so every
  // caller of this run layer — not just the CLI — gets the same protection.
  if (reason.trim().length === 0) {
    throw new Error('workflow-state bypass: --reason must not be empty')
  }
  // Store the trimmed value, not the raw one — same rationale
  // as runRecordEntry's trimmedPhase.
  const trimmedReason = reason.trim()
  const rawId = resolveRawSessionId(session)
  recordBypass(rawId, trimmedReason)
  process.stdout.write(`workflow-state: bypass recorded for this session: ${trimmedReason}\n`)
}

// One line for the UserPromptSubmit banner. Local reads only — no board subprocess on the
// per-prompt path (the same local-only discipline dashboard/state.ts's parentId reads use: never
// put the board on a hot path).
export const runBanner = (session?: string): void => {
  const rawId = resolveRawSessionId(session)
  const state = loadWorkflowState(rawId)
  const openItems = resolveOpenItems(rawId)
  if (state?.workflow === undefined && state?.bypass === undefined) {
    process.stdout.write(
      `Workflow status: NO WORKFLOW ACTIVE — before editing project files, enter one (JTBD / Quick Change / Systematic Debugging). open items: ${openItems}\n`
    )
    return
  }
  process.stdout.write(`Workflow status: ${bannerBody(state, openItems)}\n`)
}

// A registry that could not be loaded must not delete the workflow-status half of the banner: that
// read is resolveSessionId's own, one level below the try/catch a caller further up might otherwise
// expect to cover it. A state file whose open-item list could not be read reports 'unknown' for the
// same reason the registry does — `loadState` returns null for it exactly as it does for a cold
// start, and a printed `0` is a count this process never read. Both halves of that guard, because
// `stateFileIsCorrupt` also answers true for a file `loadState` reads through — a bad
// `deferredIdCounter` is an arm of its own — and that file's `openItemIds` is right there to count.
// `0` is left to the two cases that really are zero: no state file at all, or one holding a valid
// empty list.
const resolveOpenItems = (rawId: string): number | 'unknown' => {
  let sessionId: string
  try {
    sessionId = resolveSessionId(rawId)
  } catch (error) {
    if (error instanceof RegistryUnreadableError) return 'unknown'
    throw error
  }
  if (stateFileIsCorrupt(sessionId) && loadState(sessionId) === null) return 'unknown'
  return loadState(sessionId)?.openItemIds.length ?? 0
}

const bannerBody = (
  state: NonNullable<ReturnType<typeof loadWorkflowState>>,
  openItems: number | 'unknown'
): string => {
  const parts: string[] = []
  if (state.workflow !== undefined) {
    parts.push(`active (phase=${state.workflow.phase}`)
    if (state.workflow.key !== undefined) parts.push(`key=${state.workflow.key}`)
    parts.push(`via=${state.workflow.via}`)
    parts.push(`entered=${state.workflow.enteredAt})`)
  }
  if (state.bypass !== undefined) parts.push(`bypass="${state.bypass.reason}"`)
  parts.push(`open items: ${openItems}`)
  return parts.join(' ')
}
