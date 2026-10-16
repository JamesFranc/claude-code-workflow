import {
  resolveSessionId,
  resolveSessionTarget,
  resolveLinkAddTarget,
  resolveRawSessionId,
  tryResolveRawSessionId,
} from './session-id.ts'
import { dashboardAvailable, invokeDashboard, resolveDashboardBin } from './invoke.ts'
import { loadState, stateFileIsCorrupt, refuseCorruptState } from './state.ts'
import {
  loadRegistry,
  registryLeaves,
  registryRoot,
  removeRegistryNode,
  isSessionExternalId,
  type RegistryNode,
} from './registry.ts'
import { runItemWithdraw } from './item.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { ticketNodes } from './key.ts'

// Heartbeat every live leaf, not just the resolved one — the backend's touchAncestors bumps the
// whole chain up from each, so a `--key`-targeted sibling stays alive too. Falls back to the
// single resolved session when the registry is empty (before first `enter`, or an explicit
// internal --session), matching the prior single-target behavior in that case.
export const runHeartbeat = (session?: string): void => {
  if (!dashboardAvailable()) return
  let targets: string[]
  try {
    const rawId = resolveRawSessionId(session)
    const leaves = registryLeaves(loadRegistry(rawId))
    targets = leaves.length > 0 ? leaves.map((l) => l.internalId) : [resolveSessionId(session)]
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    setRequestedExitCode(1)
    return
  }
  for (const id of targets) invokeDashboard(['session', 'heartbeat', '--id', id])
}

/**
 * End a node: withdraw its open items, tell the board it is done, and remove it from the
 * registry. Fails LOUD rather than silently ending the wrong node — the two ways that could
 * otherwise happen, both via the non-throwing resolveSessionId:
 *   - An explicit --session that does not verify to a live node (stale, removed, a typo, or
 *     another session's internal id) must not fall through to resolveSessionId's own fallback and
 *     end whatever the SOLE LEAF happens to be — a completely different, unrelated node.
 *   - A bare `end` with more than one live leaf must not resolve via resolveSessionId's ambiguity
 *     fallback, which returns the ROOT — silently ending the whole epic instead of refusing.
 * Both are destructive; `end` refuses instead of guessing. The zero-leaf and single-leaf
 * fallbacks are unchanged — see the inline comments below.
 */
export const runEnd = (session?: string): void => {
  const rawId = tryResolveRawSessionId()
  if (rawId === null) return // nothing resolvable at all — silent no-op, unchanged

  const nodes = loadRegistry(rawId)
  // FLOW-190: "not one of THIS session's external ids" — must cover the minted root and its
  // children, not just the legacy `rawId` / `rawId:key` shapes, or the root's own external id gets
  // misread as an internal node id and the lookup below misses.
  const explicitInternalTarget = session !== undefined && !isSessionExternalId(session, rawId)

  let sessionId: string
  if (explicitInternalTarget) {
    // Verify via the same registry-then-board liveness check resolveSessionTarget already does
    // for explicit ids, but substitute an `end`-specific fail-loud message rather than letting
    // resolveSessionTarget's own message (which can mention --key, a flag `end` does not have)
    // leak through. Never name a flag `end` does not have.
    try {
      sessionId = resolveSessionTarget(session)
    } catch {
      process.stderr.write(`dashboard: no active session ${session} to end\n`)
      setRequestedExitCode(1)
      return
    }
  } else {
    // No explicit target: end the sole live leaf, or fail loud on ambiguity — a bare `end` must
    // never destroy the whole epic just because resolveSessionId's non-throwing fallback would
    // have collapsed >1 leaves to the root. `--session <internal id>` (already accepted, no new
    // flag needed) is how the caller disambiguates.
    //
    // Zero leaves (nothing ever entered) is NOT ambiguous — it falls back to ending the raw
    // session id itself, same as resolveSessionId's own empty-registry fallback (unchanged from
    // before this fix): a caller that never called `enter` can still bare `end` the session it
    // registered directly, e.g. a Stop hook that always ends on exit regardless of whether this
    // session ever entered a board node.
    const leaves = registryLeaves(nodes)
    if (leaves.length > 1) {
      process.stderr.write(
        `dashboard: multiple active leaves (${leaves.map((l) => l.key ?? '<root>').join(', ')}) — pass --session <internal id> to choose which to end\n`
      )
      setRequestedExitCode(1)
      return
    }
    sessionId = leaves.length === 1 ? leaves[0].internalId : rawId
  }

  // One `loadState`, shared by the guard below and the open-items count in the withdraw block, so
  // those two cannot disagree about a file rewritten between them. `stateFileIsCorrupt` does its
  // own read, so the guard's first conjunct still answers about a read of its own.
  const dashState = loadState(sessionId)

  // Before any teardown, not inside the withdraw below: `dashState?.openItemIds ?? []` reads a
  // state file this process could not read as a node with nothing open, so the withdraw is skipped
  // and `session end` still fires — ending a session whose items stay open on the board.
  // Both halves, because each alone is wrong in a different direction. `stateFileIsCorrupt` also
  // answers true for a file `loadState` reads through — a bad `deferredIdCounter` is one of its
  // arms and not one of loadState's — and refusing on that ends nothing and strands a session whose
  // open items are perfectly legible. `dashState === null` alone cannot separate an absent file
  // from an unreadable one, and an absent file is the ordinary cold start. The conjunction is
  // `stateFileIsCorrupt` supplying the absent-vs-unreadable split that `loadState` collapses,
  // applied to exactly the condition under which the `?? []` read below lies.
  if (stateFileIsCorrupt(sessionId) && dashState === null) {
    refuseCorruptState(sessionId, 'end this session')
    return
  }

  // Stays true when the board is unreachable, so the registry-removal gate below is a
  // no-op on that path — unchanged from before this gate existed.
  let withdrawn = true
  if (dashboardAvailable()) {
    // Withdraw any still-open dashboard items so hasPendingWork's dashboard branch goes false
    // and the Stop hook stops re-blocking on session exit. Done BEFORE the registry removal
    // below, not after: runItemWithdraw resolves its OWN session argument via
    // resolveSessionTargetOrRefuse, and while the registry entry still exists that resolves via a
    // local, certain registry hit; once removed, the same explicit id can only resolve via a board
    // round-trip, which can fail on reachability or payload parsing — resolveSessionTargetOrRefuse
    // catches that failure and returns null rather than throwing, so runItemWithdraw returns false
    // and withdrawn below follows it. dashboard/dashboard.test.ts's "a withdraw that fails to
    // clear the ledger holds off marking the session ended" and "...holds off removing the
    // registry entry too" tests guard the withdrawn-gate consequence below.
    const openItemIds = dashState?.openItemIds ?? []
    withdrawn = openItemIds.length === 0 || runItemWithdraw(undefined, true, sessionId)
    // A withdraw that didn't actually clear the ledger leaves openItemIds pointing at items the
    // board still considers open — ending the session here would bury that instead of surfacing
    // it, and removing the registry entry below would strand those items with no local handle
    // left to retry the withdraw against. A `session end` call that fails outright is the same
    // hazard, so its result gates withdrawn too — invokeDashboard returns null on failure and
    // `result.stdout ?? ''` (possibly empty but successful) otherwise, so this checks against
    // null rather than truthiness.
    if (withdrawn) withdrawn = invokeDashboard(['session', 'end', '--id', sessionId]) !== null
  }
  // Keep the registry consistent on an explicit `end` too, not just `leave` — otherwise an
  // ended node would linger as a phantom leaf/root that later resolves point at. A no-op when
  // sessionId doesn't name a registry node (a board-only verified id, never locally entered).
  // Unconditional on dashboardAvailable() — local state stays consistent even when the board
  // itself is unreachable (withdrawn defaults to true in that case). `nodes` was captured before
  // any mutation in this call, so it is still accurate here.
  if (withdrawn && nodes.some((n) => n.internalId === sessionId)) {
    removeRegistryNode(rawId, sessionId)
  }
}

/**
 * Finish a leaf: end it (runEnd tears down items/session/registry entry), which makes its
 * parent the new sole leaf automatically (it's now the deepest remaining node) — this replaces the
 * prior pop-to-parent-pointer behavior via the tree, not a stored pointer.
 *
 * `--key` targets a specific LEAF by key, and an explicit `--session <internal id>` targets one by
 * the internal id read off the board — either when there is more than one live leaf (mirrors item
 * add's resolveSessionTarget targeting; link add now diverges — resolveLinkAddTarget requires
 * --root or --key as soon as the root has ANY children, not only when there are several leaves),
 * or to name a leaf explicitly even when it would otherwise be the unambiguous sole leaf. Without
 * either, the sole live leaf is targeted, or the ambiguity error below fires. Either way the
 * target must be a LEAF — a node with live children in the registry is refused (popping it would
 * end a node out from under its descendants, orphaning them); the caller must leave the children
 * first. The same root guard applies uniformly to whichever node gets selected — targeting never
 * bypasses the "ends the whole epic" confirmation.
 *
 * `--session` naming the raw session id itself (or its `rawId:key` external form) is NOT node
 * targeting — it is the ordinary "which Claude session" selector every other verb uses, and falls
 * through to the no-target (key or sole-leaf) path below. Only a `--session` that names something
 * ELSE — an internal node id, e.g. one read off the board — is treated as a target: passed
 * straight to resolveRawSessionId instead, it would be silently treated AS the raw id, look up an
 * empty registry, and report "nothing to leave" — the same class of bug runEnd had with its own
 * rawId re-derivation.
 *
 * Empty registry: "nothing entered" is NOT "at the root" — there is no backend session to end
 * either way, so this is an informative no-op (exit 0) regardless of `--root`. This differs from
 * the prior pointer-based behavior, where a pointer-less rawId fell back to itself and always hit
 * the root guard (even refusing a bare `leave` there); the registry model has nothing to refuse or
 * end when it's empty, entered-root-then-left-with---root being the genuinely useful case, and
 * that stays covered by the 1-leaf-at-root path below.
 *
 * Ambiguity: more than one live leaf, with no --key/--session to disambiguate, means `leave`
 * doesn't know which to pop — fail loud rather than guess, mirroring resolveSessionTarget's
 * sibling-ambiguity throw. The error names the actual leaf keys, and --key names one of them, so
 * the message is always actionable as written.
 *
 * Root guard: `parentId === null` is exactly "the target IS the root" — a plain `leave` there
 * would end the whole epic, so refuse unless `root` is true — the caller must pass `--root` to do
 * that deliberately.
 */
export const runLeave = (session?: string, root = false, key?: string): void => {
  const rawId = tryResolveRawSessionId()
  if (rawId === null) return
  const nodes = loadRegistry(rawId)
  const leaves = registryLeaves(nodes)

  // FLOW-190: "not one of THIS session's external ids" — must cover the minted root and its
  // children, not just the legacy `rawId` / `rawId:key` shapes, or the root's own external id gets
  // misread as an internal node id and the lookup below misses.
  const explicitInternalTarget = session !== undefined && !isSessionExternalId(session, rawId)

  let target: RegistryNode
  if (explicitInternalTarget) {
    const match = nodes.find((n) => n.internalId === session)
    const resolved = resolveLeafTarget(
      nodes,
      leaves,
      match,
      `dashboard: no active board session with id "${session}"`
    )
    if (resolved === undefined) return
    target = resolved
  } else if (key !== undefined) {
    const match = nodes.find((n) => n.key === key)
    const resolved = resolveLeafTarget(
      nodes,
      leaves,
      match,
      `dashboard: no active board session with key "${key}"`
    )
    if (resolved === undefined) return
    target = resolved
  } else {
    if (leaves.length === 0) {
      // Same ambiguity resolveSessionTarget's own zero-leaf message resolves (dashboard-protocol.md
      // §1): nothing was ever entered here, or `session enter` ran while the app was unreachable and
      // returned before registering a leaf — worth distinguishing rather than defaulting to the
      // first cause's phrasing for both.
      if (resolveDashboardBin() === null) {
        process.stderr.write(
          'dashboard: nothing to leave — no active board session for this session, and ' +
            'ai-workflow-app is not reachable to check the board for one.\n' +
            'This may mean nothing was entered here — or it may mean `session enter` ran while the ' +
            'app was unreachable: it returns before registering a leaf in that case, so this is the ' +
            'expected state for such a session, not a fluke. Either way there is nothing to leave: ' +
            '`enter` never reaches the registry write when the app is unreachable, so making ' +
            'ai-workflow-app reachable now would not change what a retry finds here.\n'
        )
      } else {
        process.stderr.write(
          'dashboard: nothing to leave — no active board session for this session\n'
        )
      }
      return
    }
    if (leaves.length > 1) {
      process.stderr.write(
        `dashboard: multiple active leaves (${leaves.map((l) => l.key ?? '<root>').join(', ')}) — pass --key to choose which to leave\n`
      )
      setRequestedExitCode(1)
      return
    }
    target = leaves[0]
  }

  if (target.parentId === null && !root) {
    process.stderr.write(
      'dashboard: active leaf is the root — `leave` here ends the whole epic; pass `--root` to do that deliberately\n'
    )
    setRequestedExitCode(1)
    return
  }
  // The converse of the guard above. When the root has children, registryLeaves excludes it,
  // so the no-target path above resolves to a CHILD leaf — and the check above never fires, because
  // target.parentId isn't null. Without this, `--root` is silently ignored and the child gets ended
  // instead, exit 0, with no sign the root was never touched. `--root` asserts "the target IS the
  // root"; refuse rather than end the wrong node when that assertion doesn't hold.
  if (root && target.parentId !== null) {
    process.stderr.write(rootRefusalMessage(nodes, registryRoot(nodes)))
    setRequestedExitCode(1)
    return
  }
  // runEnd(target.internalId) already removes the node itself, gated on withdrawn succeeding —
  // an unconditional second removal here would run even when that gate refused, discarding the
  // protection it exists to provide.
  runEnd(target.internalId)
}

// Three genuinely different situations, not two — collapsing any pair loses information the reader
// needs to act:
//   1. No root recorded locally at all — nothing to name as having children.
//   2. A root IS recorded, but it isn't this target's ancestor (children === [] even though the
//      guard above already confirmed target.parentId !== null: the recorded root has no children of
//      its own in this partial/inconsistent registry, e.g. after a repair --forget left a
//      disconnected subtree). Naming it "the root has active children" here would be the same
//      wrong-claim bug the empty-parens fix addressed, just without the visible parens — there is a
//      recorded root, but it has no children to leave, so that specific claim is still false.
//   3. A root IS recorded and DOES have children — the original, common case.
// Extracted to a named helper with early returns, not left as a ternary/IIFE inline in runLeave —
// mirroring enter.ts's recoveryAdvice, pulled out of a nested ternary for the same reason: entangled
// conditionals selecting a message across several state axes are exactly what let two wrong
// branches (the empty-parens bug, and this "not this target's ancestor" bug) go unnoticed until
// review, rather than being traceable by inspection.
const rootRefusalMessage = (
  nodes: RegistryNode[],
  actualRoot: RegistryNode | undefined
): string => {
  if (actualRoot === undefined) {
    return `dashboard: --root was passed, but no root is recorded locally and the resolved target has a live parent — release it and its ancestors first, then \`dashboard session leave --root\`\n`
  }
  const children = nodes.filter((n) => n.parentId === actualRoot.internalId)
  if (children.length === 0) {
    return `dashboard: --root was passed, but the recorded root is not this target's ancestor — release the target and its ancestors first, then \`dashboard session leave --root\`\n`
  }
  const childNames = children.map((c) => c.key ?? c.internalId).join(', ')
  return `dashboard: --root was passed, but the root has active children (${childNames}) — leave those first, then \`dashboard session leave --root\`\n`
}

// Resolve a --key/--session target to a live registry LEAF, or write the appropriate refusal (not
// found / not a leaf, naming its children) and return undefined. Shared by both targeting paths in
// runLeave — they differ only in how `match` was looked up (by key text vs. by internal id); the
// not-found and not-a-leaf checks are identical either way.
const resolveLeafTarget = (
  nodes: RegistryNode[],
  leaves: RegistryNode[],
  match: RegistryNode | undefined,
  notFoundMessage: string
): RegistryNode | undefined => {
  if (match === undefined) {
    process.stderr.write(`${notFoundMessage}\n`)
    setRequestedExitCode(1)
    return undefined
  }
  const isLeaf = leaves.some((l) => l.internalId === match.internalId)
  if (!isLeaf) {
    const children = nodes.filter((n) => n.parentId === match.internalId)
    const childNames = children.map((c) => c.key ?? c.internalId).join(', ')
    process.stderr.write(
      `dashboard: ${match.key ?? match.internalId} has active child sessions (${childNames}) — leave those first\n`
    )
    setRequestedExitCode(1)
    return undefined
  }
  return match
}

// Mutation verb — resolves strictly: fails loud on sibling ambiguity (pass --key) rather than
// silently guessing which active board session to attach the link to. `--root` explicitly targets
// the session root, whose key is always null and so can never be named with --key. Caught here
// (rather than left to propagate to Stricli's default handler) so a refusal surfaces as the
// resolver's own clean, actionable message and exit code — not a raw stack trace — mirroring
// runEnd's own try/catch above for its explicit-target verification.
export const runLinkAdd = (
  kind: string,
  label: string,
  url: string,
  session?: string,
  key?: string,
  root = false
): void => {
  if (!dashboardAvailable()) return
  let sessionId: string
  try {
    sessionId = resolveLinkAddTarget(session, key, root)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    setRequestedExitCode(1)
    return
  }
  if (root && kind === 'ticket' && refuseRootLinkForKeyedTicket(label)) return
  invokeDashboard([
    'link',
    'add',
    '--session',
    sessionId,
    '--kind',
    kind,
    '--label',
    label,
    '--url',
    url,
  ])
}

// `--root` on a ticket link means "this ticket IS the session root". When the registry already holds
// a node keyed for this ticket — a story under an epic root, or its -resumed replacement — the root
// is someone else's node (the epic's), and attaching the link there corrupts its identity
// (dashboard-protocol.md §1: a ticket-level node carries exactly one kind:ticket link, its own).
const refuseRootLinkForKeyedTicket = (ticket: string): boolean => {
  const rawSessionId = tryResolveRawSessionId()
  if (rawSessionId === null) return false
  const own = ticketNodes(loadRegistry(rawSessionId), ticket)
  if (own.length === 0) return false
  const keys = own.map((n) => n.key).join(', ')
  const suggestion =
    own.length === 1
      ? `Pass --key ${own[0].key} (resolve it with \`dashboard session key --ticket ${ticket}\`).`
      : `Which one the link belongs to is not this verb's call — resolve it with ` +
        `\`dashboard session key --ticket ${ticket}\` (it names every match and refuses to guess).`
  process.stderr.write(
    `dashboard link add: ${ticket} has its own board node (${keys}) — --root would attach its ` +
      `ticket link to the session root instead. ${suggestion}\n`
  )
  setRequestedExitCode(1)
  return true
}
