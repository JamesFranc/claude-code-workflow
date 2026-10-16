import { markWorkflowEntered } from '../workflow-state/state.ts'
import { dashboardAvailable, invokeDashboard } from './invoke.ts'
import { resolveRawSessionId, tryResolveRawSessionId } from './session-id.ts'
import { loadState, refuseCorruptState, saveState, stateFileIsCorrupt } from './state.ts'
import { reproducesDeclarationGrammar } from './item.ts'
import {
  loadRegistry,
  registryLeaves,
  registryRoot,
  upsertRegistryNode,
  mintRootSuffix,
  ROOT_DELIMITER,
  type RegistryNode,
} from './registry.ts'
import { setRequestedExitCode } from '../runtime-exit-code.ts'

/**
 * An argument-validation refusal from `runEnter` — the same class of failure `item.ts`'s
 * `--recommend`/`--stalls` and `runItemDropDeferred`'s `--reason` refuse with a `dashboard:`-prefixed
 * stderr line and exit 1. Those siblings write and return; this one throws, because `runEnter`'s
 * unit tests assert the refusals with `assert.throws`. The command layer (`commands/dashboard.ts`)
 * catches this type and renders it as the same operator-visible contract, so the two are equivalent
 * from the outside. It is a distinct type rather than a message-prefix check so an unexpected
 * internal error still surfaces as one, with its stack, instead of being flattened into a refusal.
 */
export class DashboardEnterRefusal extends Error {}

/**
 * Start (or re-enter) work on a node, making it the current leaf. Identity-driven, but the
 * identity is now service-owned (FLOW-132): the client composes an opaque `externalId` from THIS
 * session's current top-level board session's external id — its "root": the live registry root's
 * externalId when one exists, else minted fresh (FLOW-190) — plus the key, and sends it alongside a
 * fixed `systemId`; the backend register upsert (which reactivates an ended node — FLOW-117)
 * finds-or-creates the node and mints/returns the real session UUID. The node is recorded in the
 * rawId's node registry (with its parent's UUID) so heartbeat/mailbox/`leave` resolve it by leaf.
 * The raw session id groups a conversation's nodes; it does not name any one of them, and is never
 * itself composed into an external id post-FLOW-190 (a legacy root minted before FLOW-190, where
 * `externalId === rawId`, still resolves via the back-compat arm, but new roots never take that
 * shape).
 *
 * Key/parent-key combinations (in terms of the composed external id, not the returned UUID; `root`
 * below is this call's resolved root external id, resolved once — see `resolveRootExternalId` —
 * NOT the raw session id):
 *   - no key: this IS the root (externalId = root, parentExternalId = undefined).
 *   - key, no parent-key: child of the root (externalId = root:key, parentExternalId = root).
 *   - key + parent-key: nests under the named parent (externalId = root:key,
 *     parentExternalId = root:parentKey) — composed FLAT off the root in both cases, never nested
 *     through the parent's own external id (a keyed parent's external id already IS `root:parentKey`;
 *     nesting through it would double up to `root:parentKey:key`).
 *   - parent-key with no key: invalid — a parentless root cannot have a parent. Throws.
 *   - --parent-session (no key): this session's root, nested on the board under the other session's
 *     current node; recorded locally with no parent.
 *
 * Nesting is not enforced here. `enter` creates the node it is asked for; which nodes are worth
 * creating is guidance the skills carry at each call site (FLOW-205). Three prior attempts to make
 * the CLI adjudicate this (FLOW-125, FLOW-123, FLOW-180) each shipped a rule the next round of
 * defects walked around.
 */
export const runEnter = (
  key: string | undefined,
  phase: string,
  title?: string,
  parentKey?: string,
  session?: string,
  retitle = false,
  parentSession?: string
): void => {
  // Argument validation happens BEFORE the marker write: invalid args must never grant edit
  // rights via a marker that gets written and then the call throws (FLOW-147).
  if (parentKey !== undefined && key === undefined) {
    throw new DashboardEnterRefusal(
      'dashboard session enter: --parent-key requires --key (a parentless root cannot have a parent)'
    )
  }
  if (retitle && title === undefined) {
    throw new DashboardEnterRefusal(
      'dashboard session enter: --retitle requires --title (nothing to rename to)'
    )
  }
  if (parentSession !== undefined && (key !== undefined || parentKey !== undefined)) {
    throw new DashboardEnterRefusal(
      'dashboard session enter: --parent-session nests this session’s root, so it takes no --key or --parent-key'
    )
  }
  if (parentSession !== undefined && parentSession === tryResolveRawSessionId(session)) {
    throw new DashboardEnterRefusal(
      'dashboard session enter: --parent-session names this session’s own id — nesting a session under itself would parent its root with itself or its own child'
    )
  }
  // Resolved before the marker write below, like every other refusal here: a --parent-session with
  // nothing to nest under must not leave edit rights behind.
  const foreignParentExternalId =
    parentSession === undefined ? undefined : resolveForeignParentExternalId(parentSession)
  // A deferred question's --phase composes unvalidated into composeDeferredEntry's "Deferred at
  // <phase>" blockquote line the same way --recommend/--stalls compose into the declaration line.
  // Checked here, at runtime, not in commands/dashboard.ts's parsePhase — a Stricli parse-callback
  // throw exits 252, while every sibling grammar guard (item.ts's --recommend/--stalls) uses this
  // exit-1 `dashboard:`-prefixed contract instead.
  if (/[\r\n]/.test(phase)) {
    throw new DashboardEnterRefusal(
      'dashboard session enter: --phase carries a line break — the "Deferred at <phase>" line it can compose into must stay one line'
    )
  }
  if (reproducesDeclarationGrammar(phase)) {
    throw new DashboardEnterRefusal(
      'dashboard session enter: --phase reproduces the declaration line’s own grammar (a " · " ' +
        'delimiter, a Unicode-equivalent form of it, a leading or trailing "·", or a "**Label:**" ' +
        'marker) — it could forge or corrupt the "Deferred at <phase>" line it can compose into'
    )
  }
  // FLOW-147: the workflow marker must be written before any board interaction — the enforcement
  // layer must see "workflow entered" even when the dashboard binary is absent or registration
  // fails. tryResolveRawSessionId returns null where resolveRawSessionId would throw, so this
  // resolution stays throw-free on the dashboard-unavailable path.
  const earlyRawId = tryResolveRawSessionId(session)
  // FLOW-190: resolved ONCE, here, and reused by both the guards below and the register call
  // further down. Two resolveRootExternalId calls against an empty registry would mint two
  // different ids, and the guards would then be checking a different node than the one entered.
  const earlyRootExternalId =
    earlyRawId === null ? null : resolveRootExternalId(earlyRawId, loadRegistry(earlyRawId))
  // FLOW-180 retitle guard. It reads this session's registry, so it needs the root's external id —
  // but it must still run before markWorkflowEntered, for the same reason the arg validation above
  // does: a refused enter must not leave edit rights behind.
  if (earlyRawId !== null && earlyRootExternalId !== null) {
    const registry = loadRegistry(earlyRawId)
    assertNotSilentRetitle(
      registry,
      key ? `${earlyRootExternalId}:${key}` : earlyRootExternalId,
      title,
      retitle
    )
  }
  if (earlyRawId !== null) markWorkflowEntered(earlyRawId, { phase, key, via: 'dashboard-enter' })
  if (!dashboardAvailable()) return
  let rawId: string
  try {
    rawId = resolveRawSessionId(session)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    setRequestedExitCode(1)
    return
  }
  // Reuses the id resolved before the guards (FLOW-190) — the `??` arm is unreachable: earlyRawId
  // was resolved from the same source resolveRawSessionId just used, so it is non-null here.
  const rootExternalId = earlyRootExternalId ?? resolveRootExternalId(rawId, loadRegistry(rawId))
  // The service owns the id now (FLOW-132) — the client only composes the opaque external
  // correlation id and sends it alongside a fixed system id; the service finds-or-creates and
  // mints/returns the real UUID (captured from register's stdout below). Everything composes off
  // the ROOT's external id, not the raw session id (FLOW-190): the raw session id groups a
  // conversation's nodes, it does not name any one of them.
  const externalId = key ? `${rootExternalId}:${key}` : rootExternalId
  const parentExternalId =
    foreignParentExternalId ??
    (parentKey ? `${rootExternalId}:${parentKey}` : key ? rootExternalId : undefined)
  // Only send --title when the caller explicitly passed one — the backend preserves the node's
  // existing title when --title is omitted. Previously this defaulted to `key`, which meant a
  // plain re-enter (no --title) clobbered an already-set real title back down to the bare key
  // (the live FLOW-149 incident). A keyed node *created* without --title now registers with no
  // client-sent title — acceptable because every skill template passes --title on first enter.
  const title_ = title
  const args = [
    'session',
    'register',
    '--system-id',
    'claude-workflow',
    '--external-id',
    externalId,
    '--phase',
    phase,
  ]
  if (title_ !== undefined) args.push('--title', title_)
  if (parentExternalId !== undefined) args.push('--parent-external-id', parentExternalId)
  const out = invokeDashboard(args)
  if (out === null) return // available-but-failed surfaced loudly; leave pointer/state intact
  const registerOutput = parseRegisterOutput(out)
  if ('error' in registerOutput) {
    process.stderr.write(
      `dashboard: could not parse session register output — ${registerOutput.error}\n`
    )
    setRequestedExitCode(1)
    return
  }
  const { nodeId, parentId, lifecycle } = registerOutput
  // A root nested under another session's node (--parent-session) is still THIS session's root:
  // its parent lives in the other session's registry, so locally it records no parent at all.
  const localParentId = foreignParentExternalId === undefined ? parentId : null
  // REV-66: register returns the untouched row when it declines to reactivate a closed node — the
  // FLOW-117 guard correctly refuses to resurrect a session the user marked Done. That outcome used
  // to be indistinguishable from success, so a dead node was recorded as live and every later write
  // failed "Session is closed". Refuse here instead, before any registry or state write. The
  // workflow marker above is deliberately NOT rolled back (FLOW-147): it must survive a failed
  // registration so the enforcement layer still sees an entered workflow.
  if (lifecycle !== undefined && lifecycle !== 'active') {
    // The recovery advice must match the state the caller is actually in, on both axes:
    //
    // WHICH NODE: this guard fires for keyed enters too, so a fixed "leave --root" would tell a
    // user whose *child* node is dead to end the whole epic — the destructive action, recommended
    // at their most confused moment.
    //
    // WHETHER THERE IS ANYTHING TO LEAVE: this returns before the registry write, so if the node
    // was never recorded locally there is nothing for `leave` to release — it would just print
    // "nothing to leave" — and re-running `enter` mints a fresh id by itself.
    const registryNow = loadRegistry(rawId)
    const recorded = registryNow.find((n) => n.externalId === externalId)
    // Existence and labels are SEPARATE lists, deliberately. Deriving "are there children" from the
    // key-filtered list would let a null-keyed child vanish from the count, so the helper would take
    // the no-children branch and emit a bare `leave --root` when a child actually exists. A display
    // concern must never be able to weaken an existence check.
    const children = registryNow.filter(
      (n) => recorded !== undefined && n.parentId === recorded.internalId
    )
    const childKeys = children.map((n) => n.key).filter((k): k is string => k !== null)
    const recovery = recoveryAdvice(key, recorded, children.length, childKeys)
    process.stderr.write(
      `dashboard: board session ${nodeId} is ${lifecycle}, not active — not recording it as live. ${recovery}\n`
    )
    setRequestedExitCode(1)
    return
  }
  if (stateFileIsCorrupt(nodeId)) {
    refuseCorruptState(nodeId, 'enter')
    return
  }
  // Reached when register returned a parentId for a parent that is NOT in this session's local
  // registry — e.g. a keyed enter after the root's registry entry was lost or `repair --forget`-ten
  // while the board node survived. Stub the parent in so `leave` walking past the last real
  // descendant still has its internal id (FLOW-173 review).
  //
  // It is NOT the backend auto-creating an implicit root. An earlier version of this comment said
  // so; that was verified false during FLOW-190's acceptance run — `resolveParentId` (register.ts)
  // THROWS `no live parent session with that external id` when the parent does not exist, so a
  // keyed enter with no prior root fails at register rather than reaching here. Whether any live
  // path still reaches this block is unverified.
  //
  // Reactivation edge: this stub always writes parentId: null, because ancestry beyond the one
  // edge in this register response isn't known locally. If parentExternalId itself names a
  // previously --forget-ten or ended node that this call reactivates (FLOW-117) and that node
  // actually has a real ancestor of its own, the stub mislabels it as a root here. The practical
  // effect is fail-safe, not silently wrong: an extra root-shaped registry entry can make
  // resolveSessionTarget see more live leaves than the real tree has, producing a spurious (but
  // loud) sibling-ambiguity error rather than a wrong silent resolution — see restart-jobs.md's
  // re-parent-onto-a-dead-node warning for the user-facing shape of this.
  if (
    localParentId !== null &&
    parentExternalId !== undefined &&
    !loadRegistry(rawId).some((n) => n.internalId === localParentId)
  ) {
    const parentKeyForStub =
      parentExternalId === rootExternalId ? null : parentExternalId.slice(rootExternalId.length + 1)
    // Deliberately no `title` here: this stub records only what THIS register response knows about
    // the parent.
    upsertRegistryNode(rawId, {
      internalId: localParentId,
      externalId: parentExternalId,
      key: parentKeyForStub,
      parentId: null,
    })
  }
  // Coalesce the node's own parentId with any already-recorded registry value, mirroring
  // saveState's preserve-if-already-set behavior below (FLOW-136) — a re-enter without
  // --parent-key (or with a different one) must not clobber the node's real, already-recorded
  // parent. Deliberately NOT paired into the stub above: the stub's (parentId, parentExternalId)
  // must stay a consistent pair from THIS register call, whereas the coalesced nodeParentId here
  // may be an older/deeper ancestor whose externalId doesn't match parentExternalId at all.
  const existingNode = loadRegistry(rawId).find((n) => n.internalId === nodeId)
  const nodeParentId = existingNode?.parentId ?? localParentId
  upsertRegistryNode(rawId, {
    internalId: nodeId,
    externalId,
    key: key ?? null,
    parentId: nodeParentId,
    // Title tracks what the board now holds: the value we just sent when we sent one, otherwise
    // whatever was already recorded (FLOW-180).
    title: title ?? existingNode?.title,
  })
  const existing = loadState(nodeId)
  // Preserve any already-tracked open items on re-entry — a fresh node has none; re-entering
  // an active node must not wipe its open-item tracking.
  const openItemIds = existing?.openItemIds ?? []
  // `parentId` coalesces with the established value the same way the backend register.ts upsert's
  // preserve-if-already-set behavior does, so a re-enter without --parent-key (or with a different
  // one) doesn't clobber the node's real, already-recorded parent locally and send `leave` to the
  // wrong ancestor.
  saveState(nodeId, {
    ...(existing ?? {}),
    registered: true,
    phase,
    openItemIds,
    parentId: existing?.parentId ?? localParentId,
  })
}

/**
 * What the caller should actually do about a board node that came back non-active. Three axes, and
 * getting any of them wrong ships an instruction that does nothing, does something *else*, or loops
 * forever:
 *
 *  - recorded locally? — nothing to release if not.
 *  - keyed or the root? — `leave --root` on a keyed node ends the whole epic.
 *  - children? — `leave` targets a LEAF, so with children present the recorded node is never the
 *    leaf `resolveLeafTarget` would pick: a keyed leave refuses (the parent isn't a leaf); a bare
 *    `--root` refuses whenever the resolved target isn't the root — a guard scoped to "resolved
 *    target already WAS the root" instead would silently walk `--root` to a CHILD leaf and exit 0.
 *    Either way, the advice below must say "release the children first," never a bare
 *    `leave --root`/`leave --key`.
 */
const recoveryAdvice = (
  key: string | undefined,
  recorded: RegistryNode | undefined,
  childCount: number,
  childKeys: string[]
): string => {
  if (recorded === undefined) {
    // Nothing local to release. Re-running only helps when it would compose a DIFFERENT external
    // id — true for a keyless enter, which mints fresh. A keyed enter recomposes
    // `<root>:<key>` from the still-recorded root, hits the same closed node, and loops forever;
    // restart-jobs.md's new-key guidance is the real answer there.
    if (key === undefined) {
      return 'Nothing was recorded locally — re-run `dashboard session enter`, which mints a new id.'
    }
    return `Re-running \`--key ${key}\` would compose this same id and fail identically — re-enter under a NEW key instead, e.g. \`--key ${key}-resumed\` (see restart-jobs.md).`
  }
  const release = key === undefined ? 'leave --root' : `leave --key ${key}`
  // Branch on childCount, NEVER on childKeys.length — the latter is a display list that a
  // null-keyed child drops out of, which would silently route a node that HAS children into the
  // no-children advice. Name them when we can; say "children" when we can't.
  if (childCount > 0) {
    const named = childKeys.length > 0 ? ` (${childKeys.map((k) => `--key ${k}`).join(', ')})` : ''
    return `Release its children first${named} via \`dashboard session leave\`, then \`dashboard session ${release}\`, then re-enter.`
  }
  return `Run \`dashboard session ${release}\` to release it, then re-enter.`
}

/**
 * The external id of THIS session's current top-level board session. Reuses the live root recorded
 * in the registry when there is one — that is the ordinary phase re-enter — and mints a new one
 * when there is not. Since `runLeave`/`runEnd` remove the node from the registry, "no live root"
 * is exactly the state after a leave, so the next keyless enter starts a genuinely new board
 * session (FLOW-190). A registry root minted before FLOW-190 has `externalId === rawId` and is
 * returned unchanged, so existing sessions keep resolving without migration.
 *
 * The suffix is random rather than a counter: a counter would have to be persisted, and would reset
 * to its first value if the state dir were ever cleared — re-minting an id that already exists on
 * the board and silently re-creating the bug this fixes.
 */
const resolveRootExternalId = (rawId: string, nodes: RegistryNode[]): string => {
  const root = registryRoot(nodes)
  if (root !== undefined) return root.externalId
  // Minting lives in registry.ts beside the validator that must accept its output — do NOT inline
  // a `randomUUID()` expression here, that split is the whole failure mode.
  return `${rawId}${ROOT_DELIMITER}${mintRootSuffix()}`
}

/**
 * The external id of the board node another Claude session is working on, so this session's root
 * can nest under it — a teammate's permission node under its lead's current node (FLOW-378). Same
 * pick as resolveSessionId: the sole leaf, else the root when there are several.
 */
const resolveForeignParentExternalId = (parentSession: string): string => {
  const nodes = loadRegistry(parentSession)
  const leaves = registryLeaves(nodes)
  const node = leaves.length === 1 ? leaves[0] : (registryRoot(nodes) ?? leaves[0])

  if (node === undefined) {
    throw new DashboardEnterRefusal(
      `dashboard session enter: --parent-session ${parentSession} has no live board node to nest under`
    )
  }

  return node.externalId
}

/**
 * A node already in this session's registry has been entered before, so `--title` on it is a
 * RENAME, not a naming. Renaming is legitimate — JTBD, Quick Change and Systematic Debugging each
 * re-title the root once the real ticket summary exists, and the Renovate PR monitor re-titles its
 * session node with a one-liner summarising an outcome that decided nothing (code changed,
 * all-done) — never for a stop that asks a question — but it must be deliberate, and those four
 * sites pass --retitle. Anything else carrying a different --title is the FLOW-180 defect:
 * an agent appending a title to a phase re-enter and silently renaming the root, often the epic.
 * Fails open when the node has no recorded title (a registry written before FLOW-180).
 */
const assertNotSilentRetitle = (
  registry: RegistryNode[],
  externalId: string,
  title: string | undefined,
  retitle: boolean
): void => {
  if (retitle || title === undefined) return
  const existing = registry.find((n) => n.externalId === externalId)
  if (existing === undefined || existing.title === undefined) return
  if (existing.title === title) return
  throw new DashboardEnterRefusal(
    `dashboard session enter: refusing to rename a node that already exists.\n` +
      `  node:     ${externalId}\n` +
      `  current:  ${existing.title}\n` +
      `  --title:  ${title}\n` +
      `A node entered earlier in this session keeps its title. Omit --title on a phase re-enter — ` +
      `the existing title is preserved automatically. Pass --retitle only if you really mean to ` +
      `rename it.`
  )
}

// register's stdout contract (FLOW-132): one JSON line —
// {"id":"<uuid>","parentId":"<uuid>"|null,"lifecycle":"<lifecycle>"} — the human-readable
// "Session registered: <id>" line stays on stderr. `lifecycle` was added by REV-66 and is optional
// here: an older ai-workflow-app build omits it, and that must keep working rather than hard-fail.
// `id` is not optional — every downstream consumer (hashId, loadState, the registry write) treats
// it as a required string, so a response missing it is refused here, the same as
// parseReleasedItems refuses a malformed release payload. `parentId` must be a string or `null` —
// anything else (omitted, a number, an object) is refused the same way, since every downstream
// consumer treats it as `string | null`. The output crosses a process boundary, so
// unparseable JSON is refused the same way rather than left to JSON.parse's own uncaught throw —
// its `error` is worded distinctly from the missing-id case so the caller's message never claims a
// response had an id field when it never parsed at all.
const parseRegisterOutput = (
  out: string
):
  | { nodeId: string; parentId: string | null; lifecycle: string | undefined }
  | { error: string } => {
  let parsed: { id?: string; parentId?: unknown; lifecycle?: string }
  try {
    parsed = JSON.parse(out) as typeof parsed
  } catch {
    return { error: 'not valid JSON' }
  }
  if (typeof parsed.id !== 'string' || parsed.id === '') return { error: 'missing id' }
  if (typeof parsed.parentId !== 'string' && parsed.parentId !== null)
    return { error: 'parentId is not a string or null' }
  return { nodeId: parsed.id, parentId: parsed.parentId, lifecycle: parsed.lifecycle }
}
