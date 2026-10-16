import { invokeDashboardBin, resolveDashboardBin } from './invoke.ts'
import { parseBoardNodes, type BoardNode } from './board-nodes.ts'
import {
  loadRegistry,
  registryLeaves,
  registryRoot,
  isSessionExternalId,
  isRootExternalId,
  type RegistryNode,
} from './registry.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'

// The raw process-level session id: explicit flag, else the Claude env var. No pointer mapping.
export const resolveRawSessionId = (explicit?: string): string => {
  const id = tryResolveRawSessionId(explicit)
  if (id === null) throw new Error('No session id: pass --session or set CLAUDE_CODE_SESSION_ID')
  return id
}

// Throw-free variant for callers that can proceed without a session id (enter's marker write).
export const tryResolveRawSessionId = (explicit?: string): string | null => {
  const id = explicit ?? process.env.CLAUDE_CODE_SESSION_ID
  return id ? id : null
}

// An explicit id composed as the raw session id itself, a minted root (`rawId_suffix`), or any
// keyed external id under either — it names THIS session, never an internal node id (a hook passes
// the raw external id; a user pastes an internal id off the board, which never takes this shape).
const looksExternal = (explicit: string, rawId: string): boolean =>
  isSessionExternalId(explicit, rawId)

// Total, non-throwing. Sole leaf; root on ambiguity; raw id when nothing has been entered.
// Deliberately skips the board-resolve fallback that resolveSessionTarget has: a live session
// always has a non-empty registry (cwd-independent, holds every entered node), so an empty
// registry here means "nothing entered yet", not "pointer lost" — no subprocess round-trip is
// needed to confirm that. Reserving resolveViaBoard for resolveSessionTarget keeps this resolver's
// hot/background callers (stop-gate, mailbox check) at their prior zero-subprocess-call cost in the
// common (and empty) case.
export const resolveSessionId = (explicit?: string): string => {
  const rawEnv = tryResolveRawSessionId()

  if (explicit !== undefined) {
    // No ambient session to verify against — nothing local to check the explicit id against, so
    // trust it as given (there is no "current session" whose registry it could leak past).
    if (rawEnv === null) return explicit
    // A candidate internal id is trusted only when it is actually a node in THIS session's own
    // registry — checked locally, no subprocess round-trip (preserves this resolver's
    // zero-cost-in-the-common-case contract). A typo, a stale id, or another session's internal
    // id is NOT trusted silently: it falls through to normal leaf-based resolution below, exactly
    // as if no explicit id had been given.
    if (
      !looksExternal(explicit, rawEnv) &&
      loadRegistry(rawEnv).some((n) => n.internalId === explicit)
    ) {
      return explicit
    }
  }

  if (rawEnv === null) {
    throw new Error('No session id: pass --session or set CLAUDE_CODE_SESSION_ID')
  }
  const nodes = loadRegistry(rawEnv)
  const leaves = registryLeaves(nodes)
  if (leaves.length === 1) return leaves[0].internalId
  if (leaves.length > 1) return (registryRoot(nodes) ?? leaves[0]).internalId
  return rawEnv
}

// Strict, throwing. For mutation verbs (item add / link add) and leaf-popping (leave).
export const resolveSessionTarget = (explicit?: string, key?: string): string => {
  const rawEnv = tryResolveRawSessionId()

  if (explicit !== undefined) {
    if (rawEnv === null) return explicit
    if (!looksExternal(explicit, rawEnv)) {
      // Verify locally first (registry membership, no subprocess), then against the board (a
      // node this session's `session list` reports as active) before giving up. An id that
      // verifies against neither — a typo, a stale/ended id, or another session's internal id —
      // must never pass through to a mutation call unverified.
      if (loadRegistry(rawEnv).some((n) => n.internalId === explicit)) return explicit
      // Resolved once and reused for both the board attempt and the message below — same
      // reasoning as the keyless zero-leaf path further down: a second resolve could disagree
      // with this one if the binary's availability changed in between.
      const bin = resolveDashboardBin()
      if (isLiveBoardNode(explicit, rawEnv, bin)) return explicit
      if (bin === null) {
        throw new Error(
          `dashboard: --session ${explicit} is not a live node in the local registry, and ai-workflow-app is not reachable to check the board for one`
        )
      }
      throw new Error(
        `dashboard: --session ${explicit} is not a live node for this session (checked the local registry and the board)`
      )
    }
  }

  if (rawEnv === null) {
    throw new Error('No session id: pass --session or set CLAUDE_CODE_SESSION_ID')
  }
  const nodes = loadRegistry(rawEnv)
  if (key !== undefined) {
    const match = nodes.find((n) => n.key === key)
    if (match === undefined)
      throw new Error(
        `dashboard: no active node with key "${key}" (active nodes: ${describeNodes(nodes)})`
      )
    return match.internalId
  }
  const leaves = registryLeaves(nodes)
  if (leaves.length === 1) return leaves[0].internalId
  if (leaves.length > 1)
    throw new Error(
      `dashboard: multiple active leaves (${describeLeaves(nodes)}) — pass --key <one of them> or --session <internal id> to choose`
    )
  // Resolved once and reused for both the board attempt and the message below — not re-resolved
  // after the attempt, which could disagree with this answer if the binary's availability changed
  // in between (invoke.ts's own contract on telling "unavailable" apart from "failed").
  const bin = resolveDashboardBin()
  const viaBoard = resolveViaBoard(rawEnv, bin)
  if (viaBoard !== null) return viaBoard
  // Two different causes reach this point looking identical: nothing was ever entered here, or
  // `session enter` WAS run but returned at its own availability gate without registering a leaf
  // (dashboard-protocol.md §1) — the app being unreachable now is evidence for the second cause, so
  // it is worth saying, not folding into one generic "run session enter" message that fits only the
  // first.
  if (bin === null) {
    throw new Error(
      'dashboard: no active board session for this Claude session, and ai-workflow-app is not ' +
        'reachable to check the board for one.\n' +
        'This may mean nothing was entered here — or it may mean `session enter` ran while the app ' +
        'was unreachable: it returns before registering a leaf in that case, so this is the ' +
        'expected state for such a session, not a fluke. Either way the remedy is the same once the ' +
        'app is reachable.\n' +
        'Make ai-workflow-app reachable, then run `dashboard session enter`.'
    )
  }
  throw new Error(
    'dashboard: no active board session for this Claude session — run `dashboard session enter` first'
  )
}

// Thin wrapper for a CLI verb that cannot proceed without a resolved target: reuses
// resolveSessionTarget's own message on stderr and requests exit 1 instead of letting the throw
// reach Stricli's default handler as a raw stack trace. Returns null on refusal.
export const resolveSessionTargetOrRefuse = (explicit?: string, key?: string): string | null => {
  try {
    return resolveSessionTarget(explicit, key)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    setRequestedExitCode(1)
    return null
  }
}

// Mutation verb, `link add` ONLY. `session enter` with no --key targets the deterministic ROOT
// (enter.ts: externalId = key ? ... : rootExternalId). Plain resolveSessionTarget with no --key
// targets the sole LEAF instead — same omitted flag, two different nodes. A root's key is always
// null, so --key can never name it, which left the multi-child-root case with no correct keyless
// form at all. --root is the explicit way to name the root when --key cannot; every other target is
// already nameable by the key its own `enter` minted. Keyless with neither is refused (not silently
// resolved to a leaf) the moment the local root has ANY children — the reader must say which node
// they meant. Scoped to link add alone, and deliberately: `link add --kind ticket` writes a node's
// IDENTITY (dashboard-protocol.md §1 — a ticket-level node carries exactly one kind:ticket link,
// its own), so a silently wrong target corrupts it. An item belongs to whichever node the work is
// on, which is what item.ts already decided for the FLOW-211 approval guard — "Scoped to ONE
// node … in-spec (§3.1 reads 'on one node at once') and a conscious choice, not an oversight." Same
// reasoning, same conclusion: item add and leave keep resolveSessionTarget's keyless-sole-leaf
// behavior because that behavior is correct for them, not because widening was skipped.
export const resolveLinkAddTarget = (explicit?: string, key?: string, root = false): string => {
  const targetingFlagCount = [root, key !== undefined, explicit !== undefined].filter(
    Boolean
  ).length
  if (targetingFlagCount > 1) {
    throw new Error(
      'dashboard: --root, --key, and --session are mutually exclusive — pass at most one to target a node'
    )
  }

  if (root) {
    const rawEnv = tryResolveRawSessionId()
    if (rawEnv === null) {
      throw new Error('No session id: pass --session or set CLAUDE_CODE_SESSION_ID')
    }
    const rootNode = registryRoot(loadRegistry(rawEnv))
    if (rootNode === undefined) {
      throw new Error(
        'dashboard: --root was passed, but no root is recorded locally — run `dashboard session enter` first'
      )
    }
    return rootNode.internalId
  }

  // No --root, no --key, no --session: the ambiguous shape. Refuse rather than silently landing on
  // whichever leaf the root's children happen to produce — that silent landing on a branch/PR-level
  // node instead of the ticket node is the exact defect class this resolver exists to close.
  if (key === undefined && explicit === undefined) {
    const rawEnv = tryResolveRawSessionId()
    if (rawEnv !== null) {
      const nodes = loadRegistry(rawEnv)
      const rootNode = registryRoot(nodes)
      if (rootNode !== undefined && nodes.some((n) => n.parentId === rootNode.internalId)) {
        const childNames = nodes
          .filter((n) => n.parentId === rootNode.internalId)
          .map((c) => c.key ?? c.internalId)
          .join(', ')
        throw new Error(
          `dashboard: the session root has active children (${childNames}) — pass --root to target the root, or --key <one of them> to target a specific child`
        )
      }
    }
  }

  return resolveSessionTarget(explicit, key)
}

const describeLeaves = (nodes: RegistryNode[]): string =>
  registryLeaves(nodes)
    .map((l) => l.key ?? '<root>')
    .join(', ') || '<none>'

// Widened form of describeLeaves for the --key branch: nodes.find above searches every node, not
// just leaves, so a not-found message listing only leaves omits a real non-leaf key that WAS in
// scope for the lookup that just failed. Excludes the root (key === null): the lookup is
// `n.key === key` against a string --key, which can never match it, so listing it as a remedy
// offers an entry no --key value can ever address.
const describeNodes = (nodes: RegistryNode[]): string =>
  nodes
    .filter((n): n is RegistryNode & { key: string } => n.key !== null)
    .map((n) => n.key)
    .join(', ') || '<none>'

// Fetch and filter this session's board nodes (systemId/externalId-scoped by parseBoardNodes), or
// null if the board is unavailable or the payload doesn't parse. Shared by resolveViaBoard and
// the explicit-id board-verification in resolveSessionTarget. NOT folded into board-nodes.ts's
// `findBoardNodeFor` (the other board-fetch-and-match helper, shared by status.ts and item.ts):
// that one returns a single matched node for "the board node for this session id"; both callers
// here (resolveViaBoard, isLiveBoardNode) need the full filtered node LIST to search over their
// own predicate (root + active, or id + active) — a single-node contract doesn't fit either.
// `bin`, when passed, is used as-is (including null, meaning "known unreachable, don't probe
// again") instead of resolving fresh — the caller already resolved it once and needs that same
// answer to drive both this call and its own message selection (invoke.ts's own contract: two
// independent resolves can disagree if the binary's availability changes in between).
const fetchBoardNodes = (
  rawId: string,
  bin: string | null = resolveDashboardBin()
): BoardNode[] | null => {
  if (bin === null) return null
  const out = invokeDashboardBin(bin, ['session', 'list'])
  if (out === null) return null
  const parsed = parseBoardNodes(out, rawId)
  return parsed.ok ? parsed.nodes : null
}

// Resolve this session's active ROOT → internal id via the board (FLOW-190: the root's external
// id is `rawId` for a legacy node or `rawId_<suffix>` for a minted one, never a keyed child). Never
// returns an external id. Requires the matched root to be genuinely active — an ended/closed root
// must not be silently resolved as if it were still live, sending a mutation to a session that is
// no longer open.
const resolveViaBoard = (
  rawId: string,
  bin: string | null = resolveDashboardBin()
): string | null => {
  const nodes = fetchBoardNodes(rawId, bin)
  if (nodes === null) return null
  const root = nodes.find((n) => isRootExternalId(n.externalId, rawId) && n.lifecycle === 'active')
  return root ? root.id : null
}

// Is `id` a board node belonging to THIS session (fetchBoardNodes already scopes to rawId's own
// externalId/rawId:key rows) that is genuinely active? Used to verify an explicit --session value
// not found in the local registry before trusting it as a mutation target — parseBoardNodes' own
// externalId filter is what keeps another session's internal id from ever matching here, even if
// that id happens to be a real, live node elsewhere on the board.
const isLiveBoardNode = (
  id: string,
  rawId: string,
  bin: string | null = resolveDashboardBin()
): boolean => {
  const nodes = fetchBoardNodes(rawId, bin)
  if (nodes === null) return false
  return nodes.some((n) => n.id === id && n.lifecycle === 'active')
}
