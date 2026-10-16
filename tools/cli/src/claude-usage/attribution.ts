import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Roles come from the `agent_type` on the spawning session's teammate_spawned record — NOT from
// `~/.claude/teams/<session-id>/config.json`, whose `members` list is live team membership (it
// shrinks as teammates shut down, per team-cleanup's own shutdown-verification step) rather than a
// durable record of which agentId held which role.
export type Role = 'implementer' | 'senior-engineer' | 'team-lead' | 'solo' | 'other'

export type TicketSource = 'workflow-state' | 'spawn-prompt' | 'inherited' | 'git-branch'

export type Attribution = {
  role: Role
  ticket?: string
  ticketSource?: TicketSource
  // True only when every tier failed to resolve a ticket AND a workflow-state key was recorded
  // (this session's own, or the lead it inherited from) that had no ticket-shaped token in it —
  // e.g. a literal board key like `style-citation-convention`. Distinguishes "we saw a record and
  // it wasn't a ticket" from "we never saw a record at all", so the coverage footer can report the
  // two separately instead of folding both into one "unattributed" number.
  recordedNonTicket?: boolean
}

// Everything a transcript scan must collect for attribution, keyed by raw session id or agent id.
export type AttributionIndex = {
  agentIdBySession: Map<string, string>
  agentTypeByAgentId: Map<string, string>
  ticketByAgentId: Map<string, string>
  parentSessionByAgentId: Map<string, string>
  // agentIds seen spawned by two different parent sessions — the same collision
  // `setUnambiguousParent` guards against for main.ts's own session rollup, and the reason
  // `agentIdBySession`/`agentTypeByAgentId`/`ticketByAgentId` all key off `agentId` in the first
  // place. `agentId` (`agentName@teamName`) is not guaranteed unique across parent sessions; when the
  // same agentId resolves to two different parents, neither can be trusted, so both are discarded
  // rather than picking one. Once an agentId lands here, `parentSessionByAgentId` never gets a new
  // entry for it either — tier 3 (inherited) has nothing to inherit from a parent it can no longer
  // tell apart.
  ambiguousAgentIds: Set<string>
  leadSessions: Set<string>
  branchTicketBySession: Map<string, string>
  // The project-key prefixes of every ticket-shaped token tiers 1-2 extracted (workflow-state keys
  // on disk, and `--key` arguments parsed out of spawn prompts during the scan), used to reject
  // branch-shaped false positives in tier 4. This bounds what it *cannot* prove, not just what it
  // can: a prefix lands here only because SOME recorded string contained that ticket shape
  // somewhere, never because a human confirmed the ticket is real, and a non-ticket-shaped record
  // (a literal board key like `style-citation-convention`) contributes nothing at all — it is not
  // "observed on a real ticket" in any stronger sense than "this letter-prefix showed up next to a
  // number once." Populated by `populateProjectKeys` after the scan completes, not once per
  // transcript line — see its call site in main.ts for why the position is load-bearing.
  projectKeys: Set<string>
  // Raw per-agentId bookkeeping for indexSpawnedTeammate's agentType/ticket agreement rule — every
  // parent session that has sent a record for this agentId, and for each field, which of those
  // parents supplied a value and what those values were. Kept separately from
  // parentSessionByAgentId/ambiguousAgentIds above, which serve a different question (is there a
  // single trusted parent to inherit a ticket from) and only ever remember one parent at a time.
  spawnRecordsByAgentId: Map<string, SpawnRecordAccumulator>
}

// Every distinct parent session id that has sent a spawn record naming a given agentId (`parents`),
// and, per field, which of those parents supplied a value (`*Parents`) and the distinct values they
// supplied (`*Values`). See indexSpawnedTeammate for how this drives the agreement rule.
type SpawnRecordAccumulator = {
  parents: Set<string>
  agentTypeValues: Set<string>
  agentTypeParents: Set<string>
  ticketValues: Set<string>
  ticketParents: Set<string>
}

export const createAttributionIndex = (): AttributionIndex => ({
  agentIdBySession: new Map(),
  agentTypeByAgentId: new Map(),
  ticketByAgentId: new Map(),
  parentSessionByAgentId: new Map(),
  ambiguousAgentIds: new Set(),
  leadSessions: new Set(),
  branchTicketBySession: new Map(),
  projectKeys: new Set(),
  spawnRecordsByAgentId: new Map(),
})

export const attributeSession = (
  rawSessionId: string,
  index: AttributionIndex,
  claudeDir: string
): Attribution => {
  const role = resolveRole(rawSessionId, index)
  const ticket = resolveTicket(rawSessionId, index, claudeDir)
  return { ...role, ...ticket }
}

const resolveRole = (rawSessionId: string, index: AttributionIndex): { role: Role } => {
  const agentId = index.agentIdBySession.get(rawSessionId)
  const agentType = agentId === undefined ? undefined : index.agentTypeByAgentId.get(agentId)
  // Both agent types are the implementer ROLE. `workflow:advanced-implementer` was retired in
  // FLOW-330, but this resolver reads historical transcripts, which carry whatever agent type ran
  // at the time — tickets worked between 2026-09-05 and that removal can carry spawn records
  // naming it. Dropping the clause would not clean anything up; it would move those tickets' real
  // implementer tokens into `other` and silently zero their Implementer column.
  if (agentType === 'workflow:implementer' || agentType === 'workflow:advanced-implementer')
    return { role: 'implementer' }
  if (agentType === 'workflow:senior-engineer') return { role: 'senior-engineer' }
  // `other` can't tell apart two distinct states: a discarded parent-collision disagreement (no
  // entry in agentTypeByAgentId at all — see indexSpawnedTeammate) and a recognized agentId whose
  // agent_type this resolver just doesn't map to a role — both land here the same way. The second
  // state is a real, live population, not a hypothetical: `eng400-ecr-audit@session-b005db1b`
  // carries `agent_type: 'general-purpose'` in the 2026-08-24 corpus (out of 530 spawn records
  // indexed) and resolves to `other` on that basis alone, no collision involved. A jump in `other`
  // doesn't say which of the two moved.
  if (agentId !== undefined) return { role: 'other' }
  return { role: index.leadSessions.has(rawSessionId) ? 'team-lead' : 'solo' }
}

const resolveTicket = (
  rawSessionId: string,
  index: AttributionIndex,
  claudeDir: string
): { ticket?: string; ticketSource?: TicketSource; recordedNonTicket?: boolean } => {
  const own = readWorkflowStateTicket(claudeDir, rawSessionId)
  if (own !== undefined && 'ticket' in own)
    return { ticket: own.ticket, ticketSource: 'workflow-state' }

  const agentId = index.agentIdBySession.get(rawSessionId)
  let inherited: WorkflowStateLookup
  if (agentId !== undefined) {
    const fromPrompt = index.ticketByAgentId.get(agentId)
    if (fromPrompt !== undefined) return { ticket: fromPrompt, ticketSource: 'spawn-prompt' }

    const parent = index.parentSessionByAgentId.get(agentId)
    inherited = parent === undefined ? undefined : readWorkflowStateTicket(claudeDir, parent)
    if (inherited !== undefined && 'ticket' in inherited)
      return { ticket: inherited.ticket, ticketSource: 'inherited' }
  }

  const fromBranch = index.branchTicketBySession.get(rawSessionId)
  // Only accept a branch ticket whose project key was observed on a real ticket elsewhere.
  // fromBranch, once set, is always TICKET_TOKEN-shaped and so always contains a '-'; the split
  // never yields an empty first segment to fall back for.
  if (fromBranch !== undefined && index.projectKeys.has(fromBranch.split('-')[0]))
    return { ticket: fromBranch, ticketSource: 'git-branch' }

  const recordedNonTicket =
    (own !== undefined && 'shapeless' in own) ||
    (inherited !== undefined && 'shapeless' in inherited)
  return recordedNonTicket ? { recordedNonTicket: true } : {}
}

// The team lead / implementer contract has every teammate run
// `workflow-state record-entry --phase implementation --key <TICKET-ID>` as its first action, so
// the spawn prompt carries the ticket even when the teammate never got as far as running it.
const SPAWN_PROMPT_TICKET = /--key\s+([A-Za-z][A-Za-z0-9]{1,9}-\d{1,6})/
// A ticket-shaped token is not the same thing as a ticket. `renovate/node-20.x` uppercases to
// NODE-20.X and matches this pattern, and so does `renovate/pnpm-10.x` (PNPM-10) — those still get
// through and rely on `populateProjectKeys` as the guard below. `renovate/actions-checkout-5.x`,
// `chore/update-node-22`, and `v2-cleanup-3` no longer match at all, so they're stopped here.
// Anchored at the start of the string or immediately after a `/`, not at a bare word boundary: a
// branch prefix (`fix/eng-398-...`) or a restart-recovery suffix (`flow-100-resumed-2`) still
// extracts cleanly, but a token buried mid-segment with no `/` before it — `v2-cleanup-3` uppercases
// to V2-CLEANUP-3, and a bare `\b` would read that as ticket CLEANUP-3 — no longer matches at all.
// `normalizeTicket` below reuses this same pattern for workflow-state keys, which have the identical
// problem: `readWorkflowStateTicket` is not the git-branch tier, but a free-text `key` field is just
// as capable of carrying a prefix or suffix around the real ticket.
const TICKET_TOKEN = /(?:^|\/)([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/

export const indexSpawnedTeammate = (
  index: AttributionIndex,
  result: object,
  sessionId: string
): void => {
  const record = result as Record<string, unknown>
  if (record.status !== 'teammate_spawned') return
  index.leadSessions.add(sessionId)

  const agentId =
    (typeof record.agent_id === 'string' && record.agent_id) ||
    (typeof record.teammate_id === 'string' && record.teammate_id)
  if (!agentId) return

  const agentType = typeof record.agent_type === 'string' ? record.agent_type : undefined
  const matched = typeof record.prompt === 'string' ? SPAWN_PROMPT_TICKET.exec(record.prompt) : null
  // matched[1] already conforms to the ticket shape, so normalizeTicket re-extracting it can only
  // fail if that invariant is ever broken elsewhere — guard rather than assume.
  const ticket = matched?.[1] === undefined ? undefined : normalizeTicket(matched[1])

  setUnambiguousParent(index.parentSessionByAgentId, index.ambiguousAgentIds, agentId, sessionId)

  const acc = index.spawnRecordsByAgentId.get(agentId) ?? {
    parents: new Set<string>(),
    agentTypeValues: new Set<string>(),
    agentTypeParents: new Set<string>(),
    ticketValues: new Set<string>(),
    ticketParents: new Set<string>(),
  }
  index.spawnRecordsByAgentId.set(agentId, acc)
  acc.parents.add(sessionId)
  if (agentType !== undefined) {
    acc.agentTypeValues.add(agentType)
    acc.agentTypeParents.add(sessionId)
  }
  if (ticket !== undefined) {
    acc.ticketValues.add(ticket)
    acc.ticketParents.add(sessionId)
  }

  // A value survives only if every distinct parent that has ever named this agentId supplied it,
  // and every value any of them supplied agrees — recomputed from the full accumulator on every
  // record, so the result depends only on the final set of records for this agentId, never on the
  // order they arrived in. A parent's own silence on a later record doesn't erase a value an
  // earlier record from that same parent set (its supplied-set and value-set are already
  // satisfied); a parent's own *contradiction* on a later record does — the one deliberate
  // divergence from today's last-writer-wins, since a parent disagreeing with itself is no more
  // trustworthy than two different parents disagreeing.
  //
  // That divergence has a real cost, not just a theoretical one: a second, different agent_type
  // from the *same* parent is at least as likely to be a legitimate re-spawn under the same
  // agentId with a changed role, where today's last-writer-wins would arguably be the more correct
  // answer, as it is to be a genuine within-parent collision. We can't tell the two apart from the
  // record alone, so the conservative choice — discard rather than trust the latest — is taken
  // anyway, and the re-spawn case pays for it by losing a role that live data actually claimed.
  //
  // As of the 2026-08-24 corpus this tradeoff is theoretical rather than paid. Measured 2026-08-24:
  // 1 same-parent duplicate out of 527 distinct agentIds (530 spawn records indexed) --
  // `eng400-ecr-audit@session-b005db1b`, which supplies identical `general-purpose` on both of its
  // records and no --key on either, so there is nothing for the two records to contradict. That
  // figure needs re-running as the corpus grows, same as the safeSegment count.
  setAgreedValue(
    index.agentTypeByAgentId,
    agentId,
    acc.parents,
    acc.agentTypeParents,
    acc.agentTypeValues
  )
  setAgreedValue(index.ticketByAgentId, agentId, acc.parents, acc.ticketParents, acc.ticketValues)
}

// `map`'s entry for `agentId` holds a value only when every parent in `parents` also appears in
// `suppliedByParents` (every distinct parent that named this agentId supplied this field at least
// once) and `values` has exactly one member (every value any of them supplied is the same one).
// Otherwise the entry is absent. The size comparison below is the actual check; it's equivalent to
// the "every parent in parents also appears in suppliedByParents" phrasing above only because
// `suppliedByParents` (agentTypeParents/ticketParents) is always a subset of `parents` — indexSpawnedTeammate
// adds a parent to `acc.parents` before it ever conditionally adds that same parent to
// `acc.agentTypeParents`/`acc.ticketParents`, so `suppliedByParents` can never contain a parent
// `parents` doesn't. All three sets accumulate across every record ever seen for this agentId, so
// calling this again after a later record can only change the outcome based on what that record
// added — never based on when it arrived.
const setAgreedValue = (
  map: Map<string, string>,
  agentId: string,
  parents: ReadonlySet<string>,
  suppliedByParents: ReadonlySet<string>,
  values: ReadonlySet<string>
): void => {
  const [value] = values
  if (values.size === 1 && suppliedByParents.size === parents.size) map.set(agentId, value)
  else map.delete(agentId)
}

// Shared with main.ts's own parent-session rollup (a separate parents/ambiguous pair, not this
// module's AttributionIndex) — same collision, same fix: on conflict, forget the mapping and never
// re-learn it for this agentId. Two different scan passes over the same signal would drift if one
// used first-seen-wins and the other used ambiguous-forever.
export const setUnambiguousParent = (
  parents: Map<string, string>,
  ambiguous: Set<string>,
  agentId: string,
  sessionId: string
): void => {
  const previous = parents.get(agentId)
  if (previous !== undefined && previous !== sessionId) {
    parents.delete(agentId)
    ambiguous.add(agentId)
  } else if (!ambiguous.has(agentId)) {
    parents.set(agentId, sessionId)
  }
}

export const indexGitBranch = (
  index: AttributionIndex,
  branch: string,
  sessionId: string
): void => {
  if (index.branchTicketBySession.has(sessionId)) return
  const matched = TICKET_TOKEN.exec(branch.toUpperCase())
  if (matched?.[1] !== undefined) index.branchTicketBySession.set(sessionId, matched[1])
}

// Tier 4 is the only tier that reads a ticket out of free text a human typed for another purpose,
// so it is the only one that can invent one. Gate it on the project keys the higher-confidence
// tiers actually observed — workflow-state on disk AND the tickets parsed out of spawn prompts
// during the scan. FLOW-242 is accepted because FLOW-238 was seen; NODE-20 is rejected because no
// session ever recorded a NODE- ticket.
export const populateProjectKeys = (index: AttributionIndex, claudeDir: string): void => {
  let sessions: string[] = []
  try {
    sessions = readdirSync(join(claudeDir, 'workflow-state', 'sessions'))
  } catch {
    // No workflow-state directory at all — sessions stays the empty array declared above.
  }
  for (const session of sessions) {
    const result = readWorkflowStateTicket(claudeDir, session)
    addProjectKey(index, result !== undefined && 'ticket' in result ? result.ticket : undefined)
  }
  for (const ticket of index.ticketByAgentId.values()) addProjectKey(index, ticket)
}

const addProjectKey = (index: AttributionIndex, ticket: string | undefined): void => {
  const [projectKey] = (ticket ?? '').split('-')
  // A session directory with no readable workflow file yields `undefined` here, which splits to
  // ['']. Tier 4's only reader can never look up an empty key, so admitting one changes no
  // behaviour today — it just makes `projectKeys` stop meaning what its own declaration says.
  if (projectKey !== undefined && projectKey.length > 0) index.projectKeys.add(projectKey)
}

// A workflow-state record was found and read; either it contained a ticket-shaped token, or it
// contained a `key` that is not ticket-shaped at all (`shapeless`) — e.g. a literal board key like
// `style-citation-convention`. `undefined` means no record was found at all. Keeping these three
// states distinct (rather than collapsing "shapeless" into "not found") is what lets the coverage
// footer report "we saw a record and it wasn't a ticket" separately from "we never saw a record".
type WorkflowStateLookup = { ticket: string } | { shapeless: true } | undefined

// `<claudeDir>/workflow-state/sessions/<safeSegment(sessionId)>/workflow-<sha256>.json`. The
// filename hash is not recomputed here — the directory holds exactly one workflow file per
// session, so the first match is read instead of duplicating the store's hashing.
const readWorkflowStateTicket = (claudeDir: string, sessionId: string): WorkflowStateLookup => {
  const directory = join(claudeDir, 'workflow-state', 'sessions', safeSegment(sessionId))
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.startsWith('workflow-') || !entry.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(directory, entry), 'utf-8')) as {
        workflow?: { key?: unknown }
      }
      const key = parsed.workflow?.key
      if (typeof key === 'string' && key.length > 0) {
        const ticket = normalizeTicket(key)
        return ticket === undefined ? { shapeless: true } : { ticket }
      }
    } catch {
      continue
    }
  }
  return undefined
}

// Mirrors only the character-sanitizing replace of safeSegment in workflow-store/store.ts, not the
// containment guard below. That module's dirKeyFor always appends a hash suffix, so its own segment
// can never come out exactly '.', '..', or '' regardless of input. Its sessionPartitionFor excludes
// only '' (`raw && raw.length > 0`); '.' and '..' are truthy with length >= 1, so they pass through
// its own safeSegment unchanged and reach scopeDir's join unguarded. That module's
// session-partition scheme is unrelated too — sessionPartitionFor's 'no-session' fallback doesn't
// reach here. parseUsageResponse's own fallback (main.ts) does: it resolves a transcript line's
// missing sessionId/session_id to the literal 'unknown', which flows through as rawSessionId into a
// lookup at <claudeDir>/workflow-state/sessions/unknown/. Measured 2026-08-24: 0 occurrences of
// rawSessionId === 'unknown' across 453,064 usage-bearing lines in 1,321 transcripts — re-run that
// count before relying on this. If it ever goes non-zero, every session-less response collapses
// onto that one 'unknown' rawSessionId, undercounting coverage.sessions and buildDayRoleRows'
// sessionsSeen the same way any other session-id collision would.
const safeSegment = (value: string): string => {
  const sanitized = value.replaceAll(/[^a-zA-Z0-9._-]/g, '_')
  // '', '.', and '..' are the three inputs join(base, segment) resolves outside base/segment -- '.'
  // and '..' as themselves, '' as a no-op that leaves the path at base. Each gets its own sentinel,
  // distinct from the other two, so two different escaping session ids never collapse onto the same
  // directory and recreate the collision the comment above warns about.
  if (sanitized === '') return '_empty_'
  // Length-preserving so '.' and '..' map to distinct sentinels ('_', '__'), not one shared segment.
  return sanitized === '.' || sanitized === '..' ? '_'.repeat(sanitized.length) : sanitized
}

// A workflow-state `key` is free text a human or a prior tool run chose — it can carry a
// restart-recovery suffix (`FLOW-100-resumed`, `-resumed-2`), an unrelated suffix appended later
// (`-collide`, `-redprobe`, `-v`), or be a literal board key with no ticket in it at all
// (`style-citation-convention`). Extracting the ticket-shaped token, same as TICKET_TOKEN does for
// git branches, handles all of those uniformly instead of stripping one exact suffix; a shapeless
// value yields `undefined` rather than being uppercased and returned as if it were a ticket.
const normalizeTicket = (value: string): string | undefined =>
  TICKET_TOKEN.exec(value.toUpperCase())?.[1]
