import { createHash } from 'node:crypto'

import {
  atomicWrite,
  clearStore,
  load,
  loadClassified,
  sessionGlobalScope,
  storePath,
  unreadableErrnoPhrase,
} from '../workflow-store/store.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'

// Why a question is the user's to answer. Five values, seven routes — the mapping is fixed and lives
// in skills/board/references/escalation-contract.md §Required question form. There is deliberately
// no member meaning "I skipped the rungs": choosing a value IS the claim the question survived them.
//
// Lives here rather than in item.ts because DeferredQuestion below is part of the persisted state
// shape. item.ts already imports loadState/saveState from this file, so the reverse edge would be a
// cycle.
export type WhyMine = 'taste' | 'scope' | 'risk' | 'teammate-unsettled' | 'fact'

// A reference from a posted item to another item on the same board session: `--answers`,
// `--replaces` or `--related` on `item add`. Lives here for the same reason as WhyMine — a deferred
// entry persists its references.
export type ReferenceKind = 'answers' | 'replaces' | 'related'
export interface ItemReference {
  kind: ReferenceKind
  itemId: string
}

// One question deferred under contract rule 5 (escalation-contract.md §Blocking vs. deferrable): it
// stalls nothing, so it waits on the node's own state for a diff to point at instead of interrupting
// now.
//
// The PARTS are stored, never a composed prompt. `flush-deferred` composes each entry into its own
// board item at flush time, so the phase line and the `--context` link can be added then. Every
// part here was validated at defer time by the same code the posting path runs, so composing at
// flush time re-runs no per-field check.
//
// There is deliberately no `stalls` field: deferring IS the claim that nothing stalls, which is why
// `--defer` requires `--stalls none`. Storing it would invite a second, contradictory value.
export interface DeferredQuestion {
  id: string
  lede: string
  body: string
  recommend: string
  whyMine: WhyMine
  // state.phase at defer time. A flush posted at the PR boundary otherwise loses when the question
  // arose, which is the fact that tells the user whether it is still live.
  deferredAtPhase: string
  // Absent when the question was deferred with no references, including every entry written before
  // references existed. `flush-deferred` passes them when it posts.
  references?: ItemReference[]
}

export interface DashboardSessionState {
  registered: boolean
  phase: string
  openItemIds: string[]
  // `parentId` has exactly one LOCAL home: this state file. Its consumers — `runLeave`
  // (`dashboard leave`, to pop to the parent) and `status` rendering — read it from here; the
  // board also knows a node's parent (`enter`'s register response; `status`'s session list), but
  // these consumers don't need a subprocess to get it. A missing state file makes the parent
  // unknowable locally, which is what makes `runItemAdd`'s parent-less default a faithful
  // persistence of an existing unknown rather than an assertion of rootness (FLOW-136).
  //
  // Every writer of this shape spreads the state it loaded and overrides only the fields it is
  // authoritative for. A hand-rolled constructor silently drops any field it doesn't name — that is
  // what dropped `parentId` from `runItemAdd`'s save (FLOW-136) and, independently, from `enter.ts`'s
  // save (FLOW-250). A comment enumerating which fields to name goes stale the moment this shape
  // gains one; spreading everything is the version of the rule that cannot.
  parentId?: string | null
  // This node's deferred-question queue. Absent === empty: a state file written before this field
  // existed loads as an empty queue rather than failing, and a node that has never deferred anything
  // writes no key at all. Read it through `deferredQuestionsOf`, never directly, so that equivalence
  // is stated in one place.
  deferredQuestions?: DeferredQuestion[]
  // Monotonic — never decreases, and never reused once issued, even after every entry that carried
  // an id is flushed off the queue. `nextDeferredId` reads this instead of the queue's own highest
  // suffix: the queue only holds what has NOT been posted yet, so a flush that drains it to empty
  // would otherwise restart numbering from `q1` while a caller mid-invoke still holds an older id
  // from before the drain, recycling that id onto an unrelated entry (FLOW-250). Absent === 0, the
  // same "absent is the identity element" reading as
  // `deferredQuestions` above — a state file written before this field existed has issued nothing
  // under it, so 0 is correct, not a guess.
  deferredIdCounter?: number
}

export const hashId = (sessionId: string): string =>
  createHash('sha256').update(sessionId).digest('hex')

// Session-GLOBAL, not per-cwd (FLOW-196). The file is keyed by the board's internal node id, which is
// globally unique and cwd-independent, and so is every consumer of it — `enter`, `item`, `lifecycle`,
// `status`, `mailbox/check`, `mailbox/stop-gate`, `repair`, `workflow-state/run`. Under the per-dirKey
// `sessionScope()` it previously used, one logical ledger split into N never-reconciling copies as the
// agent changed directory: `consume` sent its board call to a cwd-independent target and then wrote the
// local clear into whichever copy the current cwd happened to select, so the Stop hook kept re-waking
// the session on items the board had already consumed.
const stateName = (sessionId: string): string => `dashboard-${hashId(sessionId)}.json`

export const stateFilePath = (sessionId: string): string =>
  storePath(sessionGlobalScope(), stateName(sessionId))

export const loadState = (sessionId: string): DashboardSessionState | null => {
  const content = load(sessionGlobalScope(), stateName(sessionId))
  if (content === null) return null
  try {
    const raw = JSON.parse(content) as Partial<DashboardSessionState>
    if (raw.deferredQuestions !== undefined && !isDeferredQuestionArray(raw.deferredQuestions)) {
      return null
    }
    if (loadBearingFieldIsCorrupt(raw)) return null
    return {
      registered: raw.registered ?? false,
      phase: String(raw.phase ?? ''),
      openItemIds: raw.openItemIds ?? [],
      ...(raw.parentId !== undefined
        ? { parentId: raw.parentId === null ? null : String(raw.parentId) }
        : {}),
      ...(raw.deferredQuestions !== undefined
        ? {
            deferredQuestions: raw.deferredQuestions.filter(
              (entry) => !isLegacyDroppedEntry(entry)
            ),
          }
        : {}),
      ...(typeof raw.deferredIdCounter === 'number'
        ? { deferredIdCounter: raw.deferredIdCounter }
        : {}),
    }
  } catch {
    return null
  }
}

// `raw.deferredQuestions` is a field this branch added to a shape `JSON.parse` already accepted as
// valid — a hand-repaired or hand-written file can carry a `deferredQuestions` field of the wrong
// shape and still parse. Every other field this file trusts from parsed JSON runs through its own
// typeof/Array.isArray check first — `openItemIds` via `loadBearingFieldIsCorrupt`'s own
// `isStringArray` guard below and `parseConsumedIds` in `item.ts` all
// do — but a KEY PRESENT with the
// wrong shape is not the same absence `deferredQuestionsOf`'s "absent === empty" reading covers: an
// array of the wrong element type reaching `.filter`/`.map` unguarded is an unhandled `TypeError`
// (a raw stack trace to the caller), and a well-formed array of malformed entries reaching
// `composeDeferredEntry` unguarded posts `undefined` to the board at exit 0 — the outcome
// `validateQuestionParts`'s own comment says defer-time validation makes impossible, because that
// validation never runs against a hand-edited file. So a PRESENT, invalid `deferredQuestions` is
// treated as corrupt, exactly like unparseable JSON: this returns `null` (never a state object with
// the field silently stripped), and `stateFileIsCorrupt` below returns `true` for it — every caller
// that already gates on `stateFileIsCorrupt` refuses via `refuseCorruptState` instead of reading a
// dropped array as a genuinely empty queue.
const isDeferredQuestion = (value: unknown): value is DeferredQuestion => {
  if (typeof value !== 'object' || value === null) return false
  const q = value as Record<string, unknown>
  return (
    typeof q.id === 'string' &&
    typeof q.lede === 'string' &&
    typeof q.body === 'string' &&
    typeof q.recommend === 'string' &&
    isWhyMine(q.whyMine) &&
    typeof q.deferredAtPhase === 'string' &&
    (q.references === undefined ||
      (Array.isArray(q.references) && q.references.every(isItemReference)))
  )
}

const isItemReference = (value: unknown): value is ItemReference => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const r = value as Record<string, unknown>
  return (
    (r.kind === 'answers' || r.kind === 'replaces' || r.kind === 'related') &&
    typeof r.itemId === 'string'
  )
}

const isWhyMine = (value: unknown): value is WhyMine =>
  value === 'taste' ||
  value === 'scope' ||
  value === 'risk' ||
  value === 'teammate-unsettled' ||
  value === 'fact'

// A build before FLOW-333 recorded a drop on the entry instead of removing it. Such an entry was
// already answered by the work, so it is removed on load rather than resurrected as pending.
const isLegacyDroppedEntry = (entry: DeferredQuestion): boolean => 'dropped' in entry

const isDeferredQuestionArray = (value: unknown): value is DeferredQuestion[] =>
  Array.isArray(value) && value.every(isDeferredQuestion)

// Fields are classified by REACH, not by whether a check happens to be cheap. `registered` and
// `openItemIds` are read as fact by callers that decide whether a session may go quiet with the
// user still waiting: `hasPendingWork` (mailbox/stop-gate.ts) gates on
// `registered === true && openItemIds.length > 0`, and `workflow-state/run.ts` reports
// `openItemIds.length ?? 0`. A numeric `openItemIds` gives `.length` of `undefined`, which is
// falsy and `?? 0`-proof — the gate reads "nothing open" and the session goes quiet on a corrupt
// file. `?? []` cannot catch that: `??` fires only on null/undefined, so a non-array passes
// straight through. A present-but-wrong-shaped load-bearing field is therefore treated exactly as
// unparseable JSON is — `loadState` returns null and `stateFileIsCorrupt` returns true.
//
// A caller that would read null as "nothing open" must consult `stateFileIsCorrupt` first;
// `hasPendingWork` (mailbox/stop-gate.ts) does.
//
// `phase` and `parentId` are display and navigation only; they are coerced rather than rejected,
// the same split `parseBoardNodes` (dashboard/board-nodes.ts) applies to its own rows.
const loadBearingFieldIsCorrupt = (raw: Partial<DashboardSessionState>): boolean => {
  if (raw.registered !== undefined && typeof raw.registered !== 'boolean') return true
  if (raw.openItemIds !== undefined && !isStringArray(raw.openItemIds)) return true
  return false
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

export const saveState = (sessionId: string, state: DashboardSessionState): void => {
  atomicWrite(stateFilePath(sessionId), JSON.stringify(state, null, 2))
}

// `loadState` collapses "no file", "file present but unparseable", and "file present but carrying an
// invalid `deferredQuestions`" to the same null. That is safe for a caller whose answer changes
// nothing else when it turns out wrong — but not for one whose answer is acted on as fact:
// `runItemListDeferred` prints `[]` for a corrupt file exactly as it would for a genuinely empty
// queue, and shipped procedures (team-cleanup, pr-lifecycle) branch on `[]` to skip a flush entirely.
// The criterion a caller needs is not "does it write back through `saveState`" (the shape) but "can
// an unreadable file produce the SAME observable answer as a genuinely empty or absent one, taken as
// fact by the caller or its downstream readers" (the property) — a caller meeting that checks this
// first, whether or not it goes on to overwrite anything.
export const stateFileIsCorrupt = (sessionId: string): boolean => {
  const read = loadClassified(sessionGlobalScope(), stateName(sessionId))
  if (read.kind === 'absent') return false
  // Present and unreadable is the one case that must NOT read as clean: the file holds whatever is
  // actually recorded, and this process cannot see it. `load` returns null for it exactly as it
  // does for a cold start, which is how a root-owned or mode-000 file made a live session self-exit.
  if (read.kind === 'unreadable') return true
  try {
    const raw = JSON.parse(read.content) as Partial<DashboardSessionState>
    if (raw.deferredQuestions !== undefined && !isDeferredQuestionArray(raw.deferredQuestions)) {
      return true
    }
    if (loadBearingFieldIsCorrupt(raw)) return true
    // Same principle as deferredQuestions above: a KEY PRESENT with the wrong shape is not the
    // same absence "absent === 0" covers. `loadState`'s own typeof guard would otherwise drop a
    // wrong-typed deferredIdCounter silently, reseeding nextDeferredId from the queue's
    // high-water mark alone and recycling an id already issued.
    return deferredIdCounterIsCorrupt(raw)
  } catch {
    return true
  }
}

// `nextDeferredId` treats `deferredIdCounter` as a non-negative safe integer high-water mark and
// feeds it straight into `Math.max(persisted, highestQueued) + 1`: a negative, fractional, or
// unsafe value corrupts every id minted from it (an unsafe integer collapses under float precision
// and stops advancing, minting the same id on every deferral) — so the domain, not only the type,
// is checked here.
const deferredIdCounterIsCorrupt = (raw: Partial<DashboardSessionState>): boolean =>
  raw.deferredIdCounter !== undefined &&
  (typeof raw.deferredIdCounter !== 'number' ||
    !Number.isSafeInteger(raw.deferredIdCounter) ||
    raw.deferredIdCounter < 0)

// Re-derives which of `stateFileIsCorrupt`'s arms fired, for a caller that already knows the
// answer is true and needs to say why rather than repeat the boolean. Mirrors `stateFileIsCorrupt`'s
// own read-and-parse rather than changing its signature to return the reason: every caller that
// gates on the boolean today keeps working unchanged, and any caller that has to name the defect
// rather than just act on it — a refusal, a warning, a status listing, a gate's reason — reads it
// here instead.
export const corruptStateDiagnosis = (sessionId: string): string => {
  const read = loadClassified(sessionGlobalScope(), stateName(sessionId))
  if (read.kind === 'absent') {
    // A TOCTOU window, not the common case: stateFileIsCorrupt read the file as corrupt, then the
    // file was removed before this re-derives why. "Exists but failed to parse" would be false here.
    return 'no longer exists'
  }
  if (read.kind === 'unreadable') {
    return unreadableErrnoPhrase(read.code)
  }
  try {
    const raw = JSON.parse(read.content) as Partial<DashboardSessionState>
    if (raw.deferredQuestions !== undefined && !isDeferredQuestionArray(raw.deferredQuestions)) {
      return 'parses, but its deferredQuestions field holds something other than a valid question array'
    }
    if (loadBearingFieldIsCorrupt(raw)) {
      return 'parses, but its registered or openItemIds field holds something other than a boolean and an array of strings'
    }
    if (deferredIdCounterIsCorrupt(raw)) {
      return 'parses, but its deferredIdCounter field holds something other than a non-negative safe integer'
    }
  } catch {
    // Falls through to the unparseable-JSON wording below.
  }
  return 'exists but failed to parse'
}

// Shared by every caller that guards a `stateFileIsCorrupt` check. Treating an unreadable file as
// empty is unsafe in one of two ways depending on the caller: a caller that would go on to build a
// fresh state overwrites whatever is actually recorded there (a deferred-question queue included)
// with no way back; a caller that only reads it reports a false success — an empty queue, a missing
// entry, an unblocked approval — indistinguishable from the genuine case. Either way, refuse instead
// and report why.
export const refuseCorruptState = (sessionId: string, verb: string): void => {
  process.stderr.write(
    `dashboard: ${stateFilePath(sessionId)} ${corruptStateDiagnosis(sessionId)} — refusing to ${verb}, ` +
      `since treating it as empty would either overwrite what is actually recorded there or report a ` +
      `false success as if it holds nothing. Inspect and repair or remove the file by hand, then try ` +
      `again.\n`
  )
  setRequestedExitCode(1)
}

// Discard the cached per-node state for a session id. Idempotent: a missing file is a no-op.
export const clearState = (sessionId: string): void => {
  clearStore(sessionGlobalScope(), stateName(sessionId))
}

// The node's queue as a list, with absent read as empty. Every consumer reads through this instead
// of repeating `?? []`, so the "absent === empty" rule above has exactly one implementation.
export const deferredQuestionsOf = (state: DashboardSessionState | null): DeferredQuestion[] =>
  state?.deferredQuestions ?? []

// The next queue id: `q<n>`, one past the highest of the persisted counter and the highest numeric
// suffix currently queued. Deterministic — no clock, no randomness — so the id a test writes is the
// id it asserts on. Seeding against the queue as well as the counter, rather than the counter alone,
// is the migration case: a state file written before `deferredIdCounter` existed reads it as 0, and
// taking the counter alone would then reissue ids the queue is still holding. Callers persist the
// returned `counter` onto `deferredIdCounter` on every enqueue — the caller, not this function, since
// this function does not have access to the state to save.
export const nextDeferredId = (
  state: DashboardSessionState | null
): { id: string; counter: number } => {
  const queue = deferredQuestionsOf(state)
  // Same domain bound as `deferredIdCounterIsCorrupt` above, applied to the queue-derived arm: a
  // hand-edited queue entry whose suffix exceeds Number.MAX_SAFE_INTEGER collapses under float
  // precision, and an unsafe `n` feeding `Math.max(persisted, highestQueued) + 1` below mints the
  // same id on every deferral exactly like an unsafe persisted counter would.
  const highestQueued = queue.reduce((max, entry) => {
    const match = /^q(\d+)$/.exec(entry.id)
    const n = match?.[1] === undefined ? 0 : Number(match[1])
    return Number.isSafeInteger(n) && n > max ? n : max
  }, 0)
  const persisted = state?.deferredIdCounter ?? 0
  const counter = Math.max(persisted, highestQueued) + 1
  return { id: `q${String(counter)}`, counter }
}
