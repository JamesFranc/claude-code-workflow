import { resolveSessionId, resolveRawSessionId } from '../dashboard/session-id.ts'
import {
  loadState as loadDashboardState,
  hashId,
  stateFileIsCorrupt,
  corruptStateDiagnosis,
} from '../dashboard/state.ts'
import { atomicWrite, clearStore, load, sessionScope, storePath } from '../workflow-store/store.ts'
import { pollTargets } from './check.ts'
import { resolveBoardLifecycle } from '../dashboard/status.ts'
import { RegistryUnreadableError } from '../dashboard/registry.ts'
import { invokeDashboardBin, resolveDashboardBin } from '../dashboard/invoke.ts'
import {
  formatReleasedEntry,
  parseReleasedItems,
  type ReleasedItem,
} from '../dashboard/released.ts'

// The Stop hook calls this, so the bounding logic lives here where it is unit-testable and the hook
// stays a thin, POSIX-portable shell wrapper (FLOW-136). Prints `allow`, or `block` followed by a
// newline and the reason text — generated here, in TypeScript, so the hook never has to interpolate
// a constant it doesn't own.
export const MAX_BLOCKS = 2

export const runStopGate = (session?: string): void => {
  let sessionId: string
  try {
    sessionId = resolveSessionId(session)
  } catch (error) {
    // "No session id" keeps its original answer: there is no session, so there is nothing to gate.
    // A registry that could not be loaded — unreadable, or readable and not a node list — is the
    // opposite case and must not borrow that answer: work may be outstanding and this process
    // cannot see it. It PRINTS the block and returns normally rather
    // than throwing: hooks/mailbox-watch.sh maps any non-zero exit from this command back to
    // `allow` with stderr discarded, so an escaping throw would land on the same silent release
    // this branch exists to remove. `stop_hook_active` bounds the block to one extra turn.
    if (error instanceof RegistryUnreadableError) {
      console.log(`block\n${unloadableRegistryReason(error)}`)
      return
    }
    console.log('allow')
    return
  }

  let rawId: string | undefined
  try {
    rawId = resolveRawSessionId(session)
  } catch {
    rawId = undefined
  }

  // Same canonical, drift-proof key the gate state has always used — the resolved anchor recomputes
  // fresh on every call and drifts as the registry's live-leaf set changes shape, and keying the
  // attempt counter to it would silently reset the FLOW-136 bound on drift.
  const gateKey = rawId ?? sessionId

  if (!isSessionLive(sessionId, rawId)) {
    clearGateState(gateKey)
    console.log('allow')
    return
  }

  // Aggregated over every registered node, not just the anchor — otherwise the
  // signature itself drifts along with the anchor even when the underlying pending work hasn't
  // changed at all, spuriously re-arming the counter the gateKey fix above just made stable.
  // Mirrors pollTargets' own node-aggregate contract used for polling and liveness.
  //
  // Guarded the same way isSessionLive's own internal pollTargets call is: an unreadable
  // registry here must not escape uncaught — hooks/mailbox-watch.sh maps any non-zero exit from
  // this command back to `allow` with stderr discarded, the exact silent release the catch around
  // `resolveSessionId` above already exists to prevent.
  let targets: string[]
  let registryUnreadable: RegistryUnreadableError | undefined
  try {
    targets = rawId !== undefined ? pollTargets(rawId, sessionId) : [sessionId]
  } catch (error) {
    if (!(error instanceof RegistryUnreadableError)) {
      throw error
    }
    registryUnreadable = error
    targets = [sessionId]
  }

  const openItemIds = targets
    .flatMap((id) => {
      const dashState = loadDashboardState(id)
      return dashState?.registered ? dashState.openItemIds : []
    })
    .sort()
  // A target whose state file is present and could not be read contributes nothing above —
  // `loadDashboardState` returns null for it exactly as it does for a node with no state file at
  // all. Collected separately so neither the signature nor the reason below can treat "this node
  // has nothing open" and "this node's open set could not be read" as the same fact. It is also
  // why this gate is blocking at all: `hasPendingWork` counts such a node as pending.
  //
  // Both halves, and the same ones `hasPendingWork` uses: `stateFileIsCorrupt` also answers true
  // for a file `loadDashboardState` reads through — a bad `deferredIdCounter` is an arm of its own
  // — and that node's open set is already counted above, so naming it here would report a set that
  // read fine as unknown. `loadDashboardState(...) === null` alone cannot tell an absent file from
  // an unreadable one.
  const unreadableTargets = targets
    .filter((id) => stateFileIsCorrupt(id) && loadDashboardState(id) === null)
    .sort()
  // The ANCHOR's own phase, never another node's. The zero-item reason names this back to the
  // agent as the work to continue with, and `pollTargets` spans every registered node — so picking
  // "the first node that has a phase" could name work this agent is not doing,
  // non-deterministically as the node set changes shape. Absent -> the reason omits the phase
  // rather than guessing.
  const activePhase = loadDashboardState(sessionId)?.phase

  // A released item is not a wait: reading it never consumes it, so an unconsumed one stays released
  // on the board and reads as unanswered. Read only when every local read succeeded: an unreadable
  // registry or state file already blocks below, with its own reason.
  const released =
    registryUnreadable === undefined && unreadableTargets.length === 0 ? releasedItems(targets) : []

  // An open item with nothing released is a wait the wake mod (hooks/wake.ts) answers: it checks the
  // board while the session is idle and starts a turn when the answer is released. Nothing is left
  // for this gate to ask for, so it allows — and re-arms, so a later zero-item stop starts a fresh
  // budget.
  if (
    registryUnreadable === undefined &&
    unreadableTargets.length === 0 &&
    released.length === 0 &&
    openItemIds.length > 0
  ) {
    clearGateState(gateKey)
    console.log('allow')
    return
  }

  const signature = computeSignature(openItemIds, unreadableTargets, registryUnreadable, released)
  const stored = loadGateState(gateKey)
  // A signature change means the pending situation changed while the gate was blocking — re-arm
  // rather than stay exhausted from the prior attempts.
  const attempts = (stored?.signature === signature ? stored.attempts : 0) + 1
  saveGateState(gateKey, { attempts, signature })

  // Exhausted: the loop must be impossible regardless of why the agent keeps stopping.
  if (attempts > MAX_BLOCKS) {
    console.log('allow')
    return
  }

  console.log(
    `block\n${buildReason(openItemIds, unreadableTargets, activePhase, registryUnreadable, released)}`
  )
}

// Whether this session has a live or pending board node the gate should answer for: true when any
// registered node has pending work or the board confirms it \`active\`. An uncertain board (binary
// absent, call failed, unparseable) falls back to local pending work, so the gate never blocks a
// session whose liveness it cannot confirm. Checked over every registered node, not just the
// resolved anchor, so a live sibling leaf is not skipped while the anchor itself is idle.
export const isSessionLive = (sessionId: string, rawId?: string): boolean => {
  let targets: string[]
  try {
    targets = rawId !== undefined ? pollTargets(rawId, sessionId) : [sessionId]
  } catch (error) {
    // A registry that cannot be enumerated must not read as "no node is live".
    if (!(error instanceof RegistryUnreadableError)) {
      throw error
    }
    return true
  }

  for (const id of targets) {
    if (hasPendingWork(id)) {
      return true
    }
    const dashState = loadDashboardState(id)
    if (
      dashState?.registered &&
      rawId !== undefined &&
      resolveBoardLifecycle(rawId, id) === 'active'
    ) {
      return true
    }
  }

  return false
}

// An unreadable state file counts as pending, matching every other uncertain outcome — binary
// absent, call failed, unparseable.
//
// Both halves, because that rule is about UNCERTAINTY and `stateFileIsCorrupt` also answers true
// where there is none: a bad `deferredIdCounter` is an arm of its own that `loadState` never
// consults, so such a file's open set is sitting there readable and counting it as pending would
// block over a board it can see is empty. `loadState(...) === null` alone cannot separate an
// absent file from an unreadable one, and an absent file is the ordinary cold start.
//
// One `loadState`, shared by the guard's second conjunct and the count, so those two cannot
// disagree about a file rewritten between them.
export const hasPendingWork = (sessionId: string): boolean => {
  const dashState = loadDashboardState(sessionId)
  if (stateFileIsCorrupt(sessionId) && dashState === null) {
    return true
  }

  return dashState?.registered === true && dashState.openItemIds.length > 0
}

interface ReleasedOnNode {
  item: ReleasedItem
  nodeId: string
}

// Released items across the session's nodes, read the way `mailbox check` reads them. A board that
// cannot be reached, or a node whose read fails or does not parse, contributes nothing: this gate
// never blocks on what it could not read, and falls through to its local reads instead. Quiet, so a
// failed read leaves this command's exit status alone — hooks/mailbox-watch.sh maps any non-zero
// exit to `allow`. The first failed read, or one whose output does not parse, ends the loop, so the
// loop itself makes at most one such call.
const releasedItems = (targets: string[]): ReleasedOnNode[] => {
  const bin = resolveDashboardBin()
  if (bin === null) {
    return []
  }

  const released: ReleasedOnNode[] = []
  for (const nodeId of targets) {
    const out = invokeDashboardBin(bin, ['answers', '--session', nodeId], { quiet: true })
    const items = out === null ? null : parseReleasedItems(out)
    if (items === null) {
      break
    }
    released.push(...items.map((item) => ({ item, nodeId })))
  }

  return released
}

// The pending-work "signature" this gate is blocking on: the sorted open dashboard item ids, plus
// the sorted ids of any target whose own open set could not be read. Both must already be sorted by
// the caller so the signature is stable between calls — otherwise it flaps and silently resets the
// counter every time instead of only on a genuine change.
//
// The second key is omitted when nothing is unreadable, so a signature stored before this existed
// still compares equal and no live gate re-arms on the upgrade. It is in the key at all because a
// node that was live and genuinely empty, and then became unreadable, is otherwise no change at
// all: both states read as `items: []`, the counter stays exhausted from before, and the gate
// releases a session whose open set it can no longer see. It does NOT distinguish two pending sets
// that both landed while the file was unreadable — nothing here can, since neither was ever read.
// Released ids are a third key, omitted when none are released for the same reason: a newly
// released item is a change in what is pending, and re-arms the counter.
const computeSignature = (
  openItemIds: string[],
  unreadableTargets: string[],
  registryUnreadable?: RegistryUnreadableError,
  released: ReleasedOnNode[] = []
): string => {
  const releasedIds = released.map(({ item }) => item.id).sort()

  return JSON.stringify({
    items: openItemIds,
    ...(unreadableTargets.length > 0 ? { unreadable: unreadableTargets } : {}),
    ...(registryUnreadable !== undefined ? { registryUnreadable: registryUnreadable.message } : {}),
    ...(releasedIds.length > 0 ? { released: releasedIds } : {}),
  })
}

// Each reason names only what is true of its own case. With zero open items, a stop parks the
// session on a wake condition that cannot occur (FLOW-223). With unreadable state, nothing here can
// say what is pending, so the reason says what to repair.
const buildReason = (
  openItemIds: string[],
  unreadableTargets: string[],
  activePhase?: string,
  registryUnreadable?: RegistryUnreadableError,
  released: ReleasedOnNode[] = []
): string => {
  if (registryUnreadable !== undefined) {
    return buildRegistryUnreadableReason(registryUnreadable, openItemIds)
  }
  if (unreadableTargets.length > 0) {
    return buildUnknownPendingReason(openItemIds, unreadableTargets)
  }
  if (released.length > 0) {
    return buildConsumeReason(released)
  }
  return buildKeepWorkingReason(activePhase)
}

// Mirrors buildUnknownPendingReason's shape; the registry-specific lead itself comes from
// registryUnreadableLead, shared with unloadableRegistryReason. This call site is already inside
// the MAX_BLOCKS counter, so it states that release condition instead of unloadableRegistryReason's
// own (which answers for the unconditional resolveSessionId-catch path above, outside the counter).
const buildRegistryUnreadableReason = (
  error: RegistryUnreadableError,
  openItemIds: string[]
): string => {
  const known =
    openItemIds.length > 0
      ? ` Items that did read: ${openItemIds.join(', ')} — which may not be all of them.`
      : ''
  return (
    `${registryUnreadableLead(error)}${known} Inspect and repair or remove the file by hand. ` +
    `This gate releases after ${MAX_BLOCKS} attempts either way.`
  )
}

// Neither body below can be told here. "Nothing is pending" asserts precisely what this process
// failed to read, and naming the ids that DID read presents a partial list as the whole one. So
// this one says what is unknown and what repairs it, the same shape unloadableRegistryReason uses
// for the registry's own version of this.
const buildUnknownPendingReason = (openItemIds: string[], unreadableTargets: string[]): string => {
  const diagnosed = unreadableTargets.map((id) => `${id} (${corruptStateDiagnosis(id)})`).join(', ')
  const known =
    openItemIds.length > 0
      ? ` Items that did read: ${openItemIds.join(', ')} — which may not be all of them.`
      : ''
  return (
    'Whether any board item is waiting on an answer cannot be determined: local state for ' +
    `${diagnosed} could not be read, so any item recorded there is invisible to this gate.${known} ` +
    "Inspect and repair or remove the file by hand — `dashboard status` lists this session's " +
    `leaves and says what it could not read. This gate releases after ${MAX_BLOCKS} attempts ` +
    'either way.'
  )
}

// Released board items nobody has consumed. Each is rendered in full, as a read of it prints it, so
// the agent can act on it whether or not it has seen it yet.
const buildConsumeReason = (released: ReleasedOnNode[]): string => {
  const entries = released.map(({ item, nodeId }) => formatReleasedEntry(item, nodeId)).join('\n')

  return (
    'Released board items are still unconsumed. Reading an answer never consumes it, and an ' +
    'unconsumed item stays released on the board, reading as unanswered. ' +
    `Act on each one, then consume it:\n${entries}\n` +
    `This gate releases after ${MAX_BLOCKS} attempts either way.`
  )
}

// Nothing is pending anywhere across this session's registered nodes. Stopping here is the FLOW-223
// defect: the agent parks mid-workflow on a wake condition that cannot occur, and only the user
// typing revives it. Advisory — MAX_BLOCKS bounds it, so this text gets one turn to land.
const buildKeepWorkingReason = (activePhase: string | undefined): string => {
  // Truthiness, NOT `!== undefined`. `DashboardSessionState.phase` is a required `string` and
  // `loadState` normalizes a missing field to `''` (dashboard/state.ts's `String(raw.phase ?? '')`),
  // so `undefined` here means only "no state file at all". A registered anchor with an empty phase
  // is reachable on exactly the path this fix targets — `item.ts` seeds `phase: ''`, and the
  // consume/resolve paths spread that state forward clearing only `openItemIds` — and an
  // `!== undefined` guard would emit the literal "You are in the `` phase." to the agent.
  const phase = activePhase ? ` You are in the \`${activePhase}\` phase.` : ''

  return (
    'Nothing is pending on the board: no dashboard item is waiting on an answer, so nothing can ' +
    `wake you if you stop now.${phase} Continue with the work instead: re-read your active plan ` +
    'or design doc and do the next step. End this turn ONLY if you can name a specific pending ' +
    'thing and the event that will wake you: a teammate you have messaged who owes you a reply ' +
    '(name them), a background task you started that re-invokes you when it exits (name it), or ' +
    'a monitor armed on a condition that can actually occur (name the condition). These do NOT ' +
    'count: that the user might come back; that a teammate might have something for you; or work ' +
    'you have finished and want to be told what to do next — that last one is a ' +
    '`dashboard item add`, not a wait. If you cannot name one, you have no wake path and you keep ' +
    'working. If you need a decision from the user, post it with `dashboard item add` FIRST — the ' +
    'item is what makes the wait real.'
  )
}

interface GateState {
  attempts: number
  signature: string
}

const gateName = (sessionId: string): string => `mailbox-gate-${hashId(sessionId)}.json`

const loadGateState = (sessionId: string): GateState | null => {
  const content = load(sessionScope(), gateName(sessionId))
  if (content === null) {
    return null
  }
  try {
    const raw = JSON.parse(content) as Partial<GateState>
    if (typeof raw.attempts !== 'number' || typeof raw.signature !== 'string') {
      return null
    }
    return { attempts: raw.attempts, signature: raw.signature }
  } catch {
    return null
  }
}

// A torn write here would make loadGateState's JSON.parse fail and return null, resetting attempts
// to 0 on the very next call — silently losing the FLOW-136 bound. atomicWrite (temp + rename).
const saveGateState = (sessionId: string, state: GateState): void => {
  atomicWrite(storePath(sessionScope(), gateName(sessionId)), JSON.stringify(state, null, 2))
}

const clearGateState = (sessionId: string): void => {
  clearStore(sessionScope(), gateName(sessionId))
}

// The block reason for a registry that could not be loaded. Names the file and what went wrong, and
// says what is unknown rather than asserting a count of open items this process could not read. The
// remedy holds for every errno the read can fail with and for malformed content alike.
const unloadableRegistryReason = (error: RegistryUnreadableError): string =>
  `${registryUnreadableLead(error)} Inspect and repair or remove the file by hand, then ` +
  `continue. This gate releases on the next stop attempt either way.`

// Shared opening sentence for both registry-unreadable reasons: the fact itself, plus the one
// concrete detail RegistryUnreadableError carries, which holds for every errno and for malformed
// content alike. Each caller appends its own distinct remedy and release condition.
const registryUnreadableLead = (error: RegistryUnreadableError): string =>
  `Your dashboard registry could not be loaded, so whether any board item is waiting on an answer ` +
  `cannot be determined. ${error.message}.`
