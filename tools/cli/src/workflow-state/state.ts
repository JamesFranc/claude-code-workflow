import { hashId } from '../dashboard/state.ts'
import {
  atomicWrite,
  clearStore,
  load,
  sessionGlobalScope,
  storePath,
} from '../workflow-store/store.ts'

// The enforcement layer's source of truth: "a workflow has been entered in this session".
// Keyed by the RAW Claude session id (not a board-minted node UUID) so it exists and is
// readable even when the dashboard binary or backend is absent — see FLOW-147 / arch R3.
export interface WorkflowState {
  workflow?: WorkflowMarker
  bypass?: WorkflowBypass
}

export interface WorkflowMarker {
  phase: string
  enteredAt: string
  // Carries whatever the entry skill was keyed on — a ticket id, an epic key, or a branch name.
  // Named `key` (not `ticket`) because it is not always a ticket.
  key?: string
  // Provenance: which verb wrote this marker. 'dashboard-enter'
  // = the board-registering path (dashboard/enter.ts, mints/updates a board node); 'record-entry'
  // = the marker-only teammate verb (workflow-state record-entry), which never touches the board.
  // Required and validated like phase/enteredAt — an untraceable marker is exactly the gap this
  // field closes.
  via: 'dashboard-enter' | 'record-entry'
}

export interface WorkflowBypass {
  reason: string
  grantedAt: string
}

const workflowName = (rawSessionId: string): string => `workflow-${hashId(rawSessionId)}.json`

// FLOW-183: session-global (cwd-independent) scope, keyed by rawSessionId alone — mirrors
// store.ts's sessionGlobalScope registry rationale, since this marker must resolve identically
// regardless of which directory the process happens to be launched/read from.
export const workflowStateFilePath = (rawSessionId: string): string =>
  storePath(sessionGlobalScope(rawSessionId), workflowName(rawSessionId))

export const loadWorkflowState = (rawSessionId: string): WorkflowState | null => {
  const content = load(sessionGlobalScope(rawSessionId), workflowName(rawSessionId))
  if (content === null) return null
  try {
    const raw = JSON.parse(content) as Partial<WorkflowState>
    const workflow = normalizeMarker(raw.workflow)
    const bypass = normalizeBypass(raw.bypass)
    return {
      ...(workflow !== undefined ? { workflow } : {}),
      ...(bypass !== undefined ? { bypass } : {}),
    }
  } catch {
    return null
  }
}

const saveWorkflowState = (rawSessionId: string, state: WorkflowState): void => {
  atomicWrite(workflowStateFilePath(rawSessionId), JSON.stringify(state, null, 2))
}

// Updater: spreads existing state and overrides only the marker (state.ts's constructor/updater
// rule — an updater must never rebuild fields it isn't authoritative for, e.g. bypass).
export const markWorkflowEntered = (
  rawSessionId: string,
  entry: { phase: string; key?: string; via: WorkflowMarker['via'] }
): void => {
  const existing = loadWorkflowState(rawSessionId)
  saveWorkflowState(rawSessionId, {
    ...existing,
    workflow: {
      phase: entry.phase,
      enteredAt: new Date().toISOString(),
      via: entry.via,
      ...(entry.key !== undefined ? { key: entry.key } : {}),
    },
  })
}

// Updater: same spread rule; overrides only bypass.
export const recordBypass = (rawSessionId: string, reason: string): void => {
  const existing = loadWorkflowState(rawSessionId)
  saveWorkflowState(rawSessionId, {
    ...existing,
    bypass: { reason, grantedAt: new Date().toISOString() },
  })
}

export const clearWorkflowState = (rawSessionId: string): void => {
  clearStore(sessionGlobalScope(rawSessionId), workflowName(rawSessionId))
}

// Validates a raw marker read off disk (never trust it blank): a marker missing its required
// `phase`/`enteredAt` strings must not be treated as "workflow entered" — that would open the
// gate on `{"workflow":{}}` and print `phase=undefined` in the banner. Mirrors dashboard/state.ts's
// loadState normalize-on-read discipline.
const normalizeMarker = (raw: Partial<WorkflowMarker> | undefined): WorkflowMarker | undefined => {
  if (raw === undefined || typeof raw.phase !== 'string' || typeof raw.enteredAt !== 'string')
    return undefined
  // The blank-phase invariant belongs here, not just in the writers: this is the ONE place every
  // marker — from every current AND future writer — passes through before the gate ever sees it.
  // The run-layer guards (runBypass/runRecordEntry) stay as defense-in-depth, but this is what
  // actually closes the gap; dashboard/enter.ts's writer has no equivalent guard, so without this
  // check a blank-phase marker it wrote would open the gate.
  if (raw.phase.trim().length === 0) return undefined
  if (raw.key !== undefined && typeof raw.key !== 'string') return undefined
  if (raw.via !== 'dashboard-enter' && raw.via !== 'record-entry') return undefined
  return {
    phase: raw.phase,
    enteredAt: raw.enteredAt,
    via: raw.via,
    ...(raw.key !== undefined ? { key: raw.key } : {}),
  }
}

const normalizeBypass = (raw: Partial<WorkflowBypass> | undefined): WorkflowBypass | undefined => {
  if (raw === undefined || typeof raw.reason !== 'string' || typeof raw.grantedAt !== 'string')
    return undefined
  return { reason: raw.reason, grantedAt: raw.grantedAt }
}
