// The board's-eye view of a session node, and the parser that turns `session list` stdout into a
// typed array of them. Split out of status.ts (FLOW-173) so session-id.ts can reuse
// `parseBoardNodes` for board-resolve without creating an import cycle: status.ts already imports
// from session-id.ts (`resolveRawSessionId`), so a session-id.ts -> status.ts import would have
// been circular. Neither status.ts nor session-id.ts imports the other here.

import { isSessionExternalId, isRootExternalId } from './registry.ts'
import { resolveDashboardBin, invokeDashboardBin } from './invoke.ts'

// The system id every claude-workflow node registers under — enter.ts's
// `session register --system-id` argument.
const SYSTEM_ID = 'claude-workflow'

export interface BoardNode {
  id: string
  externalId: string
  title: string
  phase: string
  lifecycle: 'active' | 'paused' | 'ended' | 'closed'
  parentId: string | null
  openItemCount: number
  // Per-type pending counts (REV-72). `undefined` when the installed ai-workflow-app predates it —
  // deliberately NOT defaulted to zeroes, because "backend too old to say" and "no questions open"
  // must stay distinguishable: the approval guard fails open on the first and blocks on the second.
  openItemCounts?: { question: number; approval: number; comment: number }
}

const LIFECYCLE_VALUES = ['active', 'paused', 'ended', 'closed'] as const

type ParseResult = { ok: true; nodes: BoardNode[] } | { ok: false; error: string }

// Board rows for THIS raw session only — its roots (the legacy `rawId`, or a minted `rawId_<suffix>`
// — FLOW-190) and their keyed children (`…:<key>`). Shape matching lives in registry.ts's
// isSessionExternalId, which is also what enter.ts composes against. Other systems' and other
// sessions' nodes are not ours to report. Fails closed — `ok: false` — the moment the payload doesn't match the
// documented shape, INCLUDING at the whole-payload level: empty/whitespace-only stdout is treated
// as a fault, not a legitimate empty board (measured directly against the real ai-workflow-app,
// 2026-07-09: every zero-row `session list` query we ran printed the literal `[]`, exit 0; empty
// stdout is therefore not a known-legitimate output and is treated as a fault). Below the
// whole-payload check, the same fail-closed stance applies per row: a row or session that is
// `null` is a distinct case from one that is merely missing (JSON `null` survives `JSON.parse`),
// but both are rejected the same way, same as a row whose shape is otherwise wrong. The error
// names the row index and field (or, for a whole-payload fault, names that) so an operator gets a
// signal instead of one generic message covering every failure shape.
export const parseBoardNodes = (out: string, rawSessionId: string): ParseResult => {
  // Fails closed rather than reporting a fake empty board — see the fails-closed note above this
  // function for the measurement this rests on. A fake empty board here is not merely wrong, it
  // is fail-open exactly where /restart-jobs reads "board does not have this node" and repairs
  // local state (clears the pointer, forgets cached state) on the strength of that report — a
  // parser fault would be able to drive a state mutation.
  if (out.trim() === '') return { ok: false, error: 'session list returned empty output' }
  let rows: unknown
  try {
    rows = JSON.parse(out)
  } catch {
    return { ok: false, error: 'invalid JSON' }
  }
  if (!Array.isArray(rows)) return { ok: false, error: 'payload is not an array' }

  const nodes: BoardNode[] = []
  for (const [i, row] of rows.entries()) {
    if (typeof row !== 'object' || row === null)
      return { ok: false, error: `row ${i}: not an object` }
    const session = (row as { session?: unknown }).session
    if (typeof session !== 'object' || session === null)
      return { ok: false, error: `row ${i}: session is not an object` }
    const s = session as Record<string, unknown>
    if (s.systemId !== SYSTEM_ID) continue
    const externalId = s.externalId
    if (typeof externalId !== 'string')
      return { ok: false, error: `row ${i}: session.externalId is not a string` }
    if (!isSessionExternalId(externalId, rawSessionId)) continue
    // The id is load-bearing — repair/loadState correlate on it — so a missing or non-string id
    // is treated the same as a malformed externalId: reject the whole payload rather than let
    // `String(undefined)` silently mint the literal id "undefined".
    if (typeof s.id !== 'string')
      return { ok: false, error: `row ${i}: session.id is not a string` }
    const lifecycle = s.lifecycle
    if (!isLifecycle(lifecycle))
      return {
        ok: false,
        error: `row ${i}: session.lifecycle is not one of active/paused/ended/closed (got ${JSON.stringify(lifecycle)})`,
      }
    nodes.push({
      id: s.id,
      externalId,
      title: String(s.title ?? ''),
      phase: String(s.phase ?? ''),
      lifecycle,
      parentId: s.parentId === null || s.parentId === undefined ? null : String(s.parentId),
      openItemCount: safeCount((row as { openItemCount?: unknown }).openItemCount),
      openItemCounts: parseItemCounts((row as { openItemCounts?: unknown }).openItemCounts),
    })
  }
  return { ok: true, nodes }
}

// This session's own board node — by internal id, or (the root case: nothing has been entered yet,
// so `sessionId` is still the raw session id) by root external id. Shared by status.ts's
// resolveBoardLifecycle and item.ts's approval guard (FLOW-211), both of which need "the board node
// for this session" as their first step and previously duplicated this exact lookup.
//
// Resolves the binary and reads the board exactly once. `null` on every uncertain outcome —
// binary absent, call failed, payload unparseable, or the node simply not present — never thrown;
// callers decide what `null` means for them (status.ts's isSessionLive falls back to local state; item.ts's guard
// fails open). `opts.quiet` is forwarded to `invokeDashboardBin` as-is — see invoke.ts for what it
// does; status.ts's callers want a real board fault surfaced, so they pass nothing, while item.ts's
// guard passes `{ quiet: true }` (it reads the board before a mutation it then still performs).
export const findBoardNodeFor = (
  rawSessionId: string,
  sessionId: string,
  opts?: { quiet?: boolean }
): BoardNode | null => {
  const bin = resolveDashboardBin()
  if (bin === null) return null
  const out = invokeDashboardBin(bin, ['session', 'list'], opts)
  if (out === null) return null
  const parsed = parseBoardNodes(out, rawSessionId)
  if (!parsed.ok) return null
  // Anchored on `sessionId`, NOT `rawSessionId` — deliberate, and the "obvious correction" is a
  // real bug. Anchored on rawSessionId, the root-external-id arm would match the root on EVERY
  // call, so a caller resolving a child leaf's lifecycle (e.g. watch.ts's
  // resolveBoardLifecycle(rawId, <child leaf uuid>)) would get the ROOT back whenever it sorts
  // earlier in parsed.nodes, reporting the wrong node's state. Anchored on sessionId the arm is
  // self-consistent: it can only fire when sessionId IS the raw id.
  return (
    parsed.nodes.find((n) => n.id === sessionId || isRootExternalId(n.externalId, sessionId)) ??
    null
  )
}

const isLifecycle = (value: unknown): value is BoardNode['lifecycle'] =>
  typeof value === 'string' && (LIFECYCLE_VALUES as readonly string[]).includes(value)

// A non-numeric openItemCount must not become NaN — JSON.stringify(NaN) silently emits `null`,
// which would violate the declared `number` type on the wire. Not identity-bearing (unlike id),
// so an invalid count degrades to 0 rather than rejecting the whole payload.
const safeCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

// Undefined unless every key is present and a valid COUNT — a non-negative integer, not merely
// numeric. A partial or malformed payload is "unknown", not a partial count — the guard's fail-open
// path is the safe reading, and a half-parsed breakdown would silently under-report questions.
// `question: -1` or `question: 1.5` is exactly as malformed as `question: "1"`: a count that isn't
// a whole number ≥ 0 cannot be what it claims to be, so it must fail closed against this parser
// too, not pass through as a number the guard then treats as a legitimate count.
const parseItemCounts = (value: unknown): BoardNode['openItemCounts'] => {
  if (typeof value !== 'object' || value === null) return undefined
  const { question, approval, comment } = value as Record<string, unknown>
  const isCount = (n: unknown): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0
  if (!isCount(question) || !isCount(approval) || !isCount(comment)) return undefined
  return { question, approval, comment }
}
