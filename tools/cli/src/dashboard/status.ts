import { resolveRawSessionId } from './session-id.ts'
import { resolveDashboardBin, invokeDashboardBin } from './invoke.ts'
import { loadState, stateFileIsCorrupt, corruptStateDiagnosis } from './state.ts'
import { loadRegistry, registryLeaves } from './registry.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { parseBoardNodes, findBoardNodeFor, type BoardNode } from './board-nodes.ts'

export interface LocalNode {
  sessionId: string
  phase: string
  openItemIds: string[]
  parentId: string | null
}

// A candidate id whose state file is present and could not be read. Its own type rather than a
// LocalNode with blanked fields: every field a LocalNode carries is one this process failed to read,
// and a zeroed `openItemIds` here would read as a session with nothing open.
export interface CorruptLocalNode {
  sessionId: string
  reason: string
}

export type BoardLifecycle = BoardNode['lifecycle'] | 'unknown'

// The board's view of one session's lifecycle, for the Stop gate's liveness check (`isSessionLive`).
// Every uncertain outcome — binary absent, call failed, payload unparseable, or our node simply not
// present — collapses to 'unknown'. A `paused` own-node is NOT one of those outcomes: `parseBoardNodes`
// accepts it (FLOW-190), so it parses like active/ended/closed and this function
// returns the real `'paused'` value, not `'unknown'`. Callers decide what 'unknown' means for them
// (the Stop gate's `isSessionLive` falls back to hasPendingWork). Silent on the
// parse/absence paths — bin absent, unparseable payload, or our node not present — unlike
// buildReport it turns none of those into a stderr line or non-zero exit. A genuinely
// available-but-failing `session list` DOES still
// surface through invokeDashboardBin (stderr + requested non-zero exit) before collapsing to
// 'unknown'; that is intended — a real board fault is worth surfacing, and it is harmless here:
// the Stop hook maps any non-zero stop-gate exit to
// 'allow', so `block ⟹ exit 0` still holds.
// Node matching (internal id, or — when `sessionId` is still the raw session id because nothing
// has been entered yet — root external id) is `findBoardNodeFor`'s (board-nodes.ts), shared with
// item.ts's approval guard (FLOW-211) — see that function for the sessionId-vs-rawSessionId
// anchoring note; the same nuance applies to this function's callers (e.g. stop-gate.ts).
export const resolveBoardLifecycle = (rawSessionId: string, sessionId: string): BoardLifecycle => {
  const node = findBoardNodeFor(rawSessionId, sessionId)
  return node ? node.lifecycle : 'unknown'
}

/**
 * Both sides of the session state, side by side. Deliberately carries NO verdict, drift flag, or
 * recommendation (FLOW-133): judging whether local state is wrong — and what should replace it —
 * is the agent's job, because only the agent knows what work is in flight. The tool reports facts.
 */
export interface SessionStatusReport {
  rawSessionId: string
  dashboardAvailable: boolean
  // The registry has no single "active" slot (FLOW-173) — this is the sole live leaf when the
  // registry is unambiguous (exactly one leaf), else null (nothing entered, or more than one live
  // leaf — see localLeafIds/localNodes for the full picture in that case). Field name kept for
  // minimal churn; it is no longer backed by a stored pointer.
  localActiveSessionId: string | null
  // Every live registry leaf's internal id, always populated straight from the registry —
  // independent of whether a leaf also has cached per-node state. Without this, an ambiguous
  // (>1-leaf) session would show localActiveSessionId: null and localNodes could still be missing a
  // registry-only leaf (one with no saveState call of its own, e.g. an enter.ts implicit-root
  // stub) entirely, since localNodesFor only reports ids that resolve via loadState — leaving the
  // user with no id to recover with.
  localLeafIds: string[]
  localNodes: LocalNode[]
  // Candidate ids `loadState` returned null for BECAUSE the file is present and unreadable, rather
  // than absent. Without this the two are byte-identical in the report — and `status` is what the
  // person diagnosing the unreadable file is running. Additive: `localNodes` still holds exactly
  // the nodes that resolved, so nothing reading it sees a shape it did not before.
  corruptLocalNodes: CorruptLocalNode[]
  boardNodes: BoardNode[]
}

export const runStatus = (json: boolean, session?: string): void => {
  const report = buildReport(session)
  if (report === null) return
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
}

const buildReport = (session?: string): SessionStatusReport | null => {
  let rawSessionId: string
  try {
    rawSessionId = resolveRawSessionId(session)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    setRequestedExitCode(1)
    return null
  }
  const registryNodes = loadRegistry(rawSessionId)
  const registryLeafNodes = registryLeaves(registryNodes)
  const localActiveSessionId =
    registryLeafNodes.length === 1 ? registryLeafNodes[0]!.internalId : null
  const localLeafIds = registryLeafNodes.map((n) => n.internalId)
  const registryNodeIds = registryNodes.map((n) => n.internalId)

  // Resolved exactly once — not dashboardAvailable() followed by a second, independent resolve
  // inside invokeDashboard. Two resolves can disagree if the binary's availability changes
  // between them (a real race, not hypothetical: resolveDashboardBin's no-env-var path spawns a
  // `command -v` probe with a 2000ms timeout); one resolve cannot.
  const bin = resolveDashboardBin()
  if (bin === null) {
    const local = localNodesFor(candidateIds([], registryNodeIds, rawSessionId))
    return {
      rawSessionId,
      dashboardAvailable: false,
      localActiveSessionId,
      localLeafIds,
      localNodes: local.nodes,
      corruptLocalNodes: local.corrupt,
      boardNodes: [],
    }
  }

  const out = invokeDashboardBin(bin, ['session', 'list'])
  if (out === null) return null // available-but-failed — invokeDashboardBin already surfaced it

  const parsed = parseBoardNodes(out, rawSessionId)
  if (!parsed.ok) {
    process.stderr.write(`dashboard: could not parse session list output: ${parsed.error}\n`)
    setRequestedExitCode(1)
    return null
  }

  const local = localNodesFor(candidateIds(parsed.nodes, registryNodeIds, rawSessionId))
  return {
    rawSessionId,
    dashboardAvailable: true,
    localActiveSessionId,
    localLeafIds,
    localNodes: local.nodes,
    corruptLocalNodes: local.corrupt,
    boardNodes: parsed.nodes,
  }
}

// Which node ids might have a local state file: every board node of ours, plus every node in the
// registry, plus the raw session id itself. A registry node is included even when the board has
// no such node — that dangling case is exactly the drift the agent needs to see. The raw id is
// included unconditionally because resolveSessionId falls back to it whenever the registry is
// empty (session-id.ts) — item state then gets written under the raw id, and without it here that
// local node could never be reported or `--forget`-ten.
const candidateIds = (
  boardNodes: BoardNode[],
  registryNodeIds: string[],
  rawSessionId: string
): string[] => {
  const ids = new Set(boardNodes.map((n) => n.id))
  for (const id of registryNodeIds) ids.add(id)
  ids.add(rawSessionId)
  return [...ids]
}

const localNodesFor = (ids: string[]): { nodes: LocalNode[]; corrupt: CorruptLocalNode[] } => {
  const nodes: LocalNode[] = []
  const corrupt: CorruptLocalNode[] = []
  for (const sessionId of ids) {
    const state = loadState(sessionId)
    if (state === null) {
      // `loadState` collapses "no file" and "file present and unreadable" onto the same null. Only
      // the second is a fact about this session, and dropping it made a leaf whose state cannot be
      // read indistinguishable from one that never had any.
      if (stateFileIsCorrupt(sessionId)) {
        corrupt.push({ sessionId, reason: corruptStateDiagnosis(sessionId) })
      }
      continue
    }
    nodes.push({
      sessionId,
      phase: state.phase,
      openItemIds: state.openItemIds,
      parentId: state.parentId ?? null,
    })
  }
  return { nodes, corrupt }
}

const formatReport = (report: SessionStatusReport): string => {
  const lines: string[] = []
  lines.push(`raw session:  ${report.rawSessionId}`)
  lines.push(
    `active leaf:  ${report.localActiveSessionId ?? '(none — 0 or multiple live registry leaves; see live leaves below)'}`
  )
  lines.push(
    `live leaves:  ${report.localLeafIds.length > 0 ? report.localLeafIds.join(', ') : '(none)'}`
  )
  lines.push(`dashboard:    ${report.dashboardAvailable ? 'available' : 'unavailable'}`)

  lines.push('', 'local nodes:')
  if (report.localNodes.length === 0) lines.push('  (none)')
  for (const node of report.localNodes) {
    lines.push(`  ${node.sessionId}`)
    lines.push(
      `      phase=${node.phase} openItems=${node.openItemIds.length} parent=${node.parentId ?? 'null'}`
    )
  }

  // Printed only when there is something to print: an always-on "(none)" row would add a line to
  // every ordinary run to report the absence of a rare fault.
  if (report.corruptLocalNodes.length > 0) {
    lines.push('', 'local nodes that could not be read:')
    for (const node of report.corruptLocalNodes) {
      lines.push(`  ${node.sessionId}`)
      lines.push(`      ${node.reason}`)
    }
  }

  lines.push('', 'board nodes:')
  if (!report.dashboardAvailable) {
    lines.push('  (unknown — dashboard unavailable, not checked)')
  } else if (report.boardNodes.length === 0) {
    lines.push('  (none)')
  }
  for (const node of report.boardNodes) {
    // Labeled explicitly: externalId can contain `/` (a branch-keyed node), which
    // assertIdShape rejects — the agent must copy `id`, not externalId, into repair.
    lines.push(`  id (use with repair): ${node.id}  [${node.lifecycle}]`)
    lines.push(`      externalId=${node.externalId}`)
    lines.push(
      `      phase=${node.phase} openItems=${node.openItemCount} parent=${node.parentId ?? 'null'}`
    )
  }

  return `${lines.join('\n')}\n`
}
