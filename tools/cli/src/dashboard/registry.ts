import { randomUUID } from 'node:crypto'
import {
  atomicWrite,
  loadClassified,
  sessionGlobalScope,
  storePath,
  unreadableErrnoPhrase,
} from '../workflow-store/store.ts'
import { hashId } from './state.ts'

// One live board node this Claude session owns. `parentId` is the INTERNAL parent id from the
// register response (enter.ts) — it lets us compute leaves without a board round-trip.
export interface RegistryNode {
  internalId: string
  externalId: string
  key: string | null
  parentId: string | null
  // FLOW-180: recorded so a re-enter can tell "naming this node for the first time" from
  // "renaming a node that already exists". Optional — a registry written before FLOW-180 has no
  // title, and the check that reads it fails open rather than erroring on an existing session.
  // A `level` recorded by a pre-FLOW-205 registry is simply never read (excess JSON keys parse fine).
  title?: string
}

const registryName = (rawSessionId: string): string =>
  `dashboard-registry-${hashId(rawSessionId)}.json`

export const registryFilePath = (rawSessionId: string): string =>
  storePath(sessionGlobalScope(rawSessionId), registryName(rawSessionId))

// Its own type, not a bare Error, because the three bare `catch` sites on the Stop-hook path have
// to tell it apart from "no session id": that one stays permissive (allow / no / exit), while this
// one is the case where work may be outstanding and this process cannot see it.
export class RegistryUnreadableError extends Error {
  readonly code: string

  // `reason` defaults to the errno's own phrase. RegistryMalformedError passes its own, because the
  // `code` it carries names a classification rather than an errno.
  constructor(path: string, code: string, reason: string = unreadableErrnoPhrase(code)) {
    super(`dashboard registry ${path} ${reason}`)
    this.name = 'RegistryUnreadableError'
    this.code = code
  }
}

// Registry content this process can read and cannot trust: JSON that does not parse, or a `nodes`
// field that is not an array of nodes. A SUBCLASS, so every site already routing
// RegistryUnreadableError fail-closed routes this identically without having to name it — the two
// differ in what a reader repairs, never in whether the node list may be treated as enumerated.
export class RegistryMalformedError extends RegistryUnreadableError {
  // `detail` is the whole phrase after the path, not a fragment, so the parse and shape arms can
  // each read as one sentence — the wording `corruptStateDiagnosis` (dashboard/state.ts) already
  // uses for the same two conditions on the state file.
  constructor(path: string, detail: string) {
    super(path, 'MALFORMED', detail)
    this.name = 'RegistryMalformedError'
  }
}

// The empty array is left to the two cases that really are empty: no registry file at all, or one
// holding a valid empty node list — the ordinary end state of a session whose last node left, since
// removeRegistryNode writes exactly that file. A file that exists
// and cannot be read throws RegistryUnreadableError, and one that is readable but not a node list —
// unparseable JSON, a missing or non-array `nodes`, an array holding something that is not a node —
// throws RegistryMalformedError. Every caller here takes the node list as fact: `pollTargets` polls
// the leaves it names, and `upsertRegistryNode` writes the result straight back — so any of those
// read as empty would drop every live sibling from the wake check's target set and replace every
// recorded node with the single one being added. The signature is unchanged, which is what lets one
// read fix reach all of them.
export const loadRegistry = (rawSessionId: string): RegistryNode[] => {
  const read = loadClassified(sessionGlobalScope(rawSessionId), registryName(rawSessionId))
  if (read.kind === 'absent') return []
  const path = registryFilePath(rawSessionId)
  if (read.kind === 'unreadable') throw new RegistryUnreadableError(path, read.code)
  let parsed: unknown
  try {
    parsed = JSON.parse(read.content)
  } catch {
    throw new RegistryMalformedError(path, 'exists but does not parse as JSON')
  }
  const nodes = (parsed as { nodes?: unknown } | null)?.nodes
  if (!isRegistryNodeArray(nodes)) {
    throw new RegistryMalformedError(path, 'parses, but its nodes field is not an array of nodes')
  }
  return nodes
}

const isRegistryNodeArray = (value: unknown): value is RegistryNode[] =>
  Array.isArray(value) && value.every(isRegistryNode)

// Checks the five fields the interface names and no more. Excess keys pass deliberately — a
// `level` recorded by a pre-FLOW-205 registry parses fine and is never read — and `title` is
// optional here for the same back-compat reason the interface marks it so.
const isRegistryNode = (value: unknown): value is RegistryNode => {
  if (typeof value !== 'object' || value === null) return false
  const node = value as Record<string, unknown>
  return (
    typeof node.internalId === 'string' &&
    typeof node.externalId === 'string' &&
    (typeof node.key === 'string' || node.key === null) &&
    (typeof node.parentId === 'string' || node.parentId === null) &&
    (node.title === undefined || typeof node.title === 'string')
  )
}

// Upsert by internalId. Read-modify-write: not cross-process atomic, but enter/leave are serial
// within one Claude session (same guarantee the prior single-slot pointer had).
export const upsertRegistryNode = (rawSessionId: string, node: RegistryNode): void => {
  const nodes = loadRegistry(rawSessionId).filter((n) => n.internalId !== node.internalId)
  nodes.push(node)
  saveRegistry(rawSessionId, nodes)
}

export const removeRegistryNode = (rawSessionId: string, internalId: string): void => {
  saveRegistry(
    rawSessionId,
    loadRegistry(rawSessionId).filter((n) => n.internalId !== internalId)
  )
}

// A leaf is a node no other live node names as its parent.
export const registryLeaves = (nodes: RegistryNode[]): RegistryNode[] =>
  nodes.filter((n) => !nodes.some((other) => other.parentId === n.internalId))

// The root node (parentId === null), if present. Deterministic ambiguity fallback for read/background verbs.
export const registryRoot = (nodes: RegistryNode[]): RegistryNode | undefined =>
  nodes.find((n) => n.parentId === null)

// FLOW-190: a top-level board session's external id is `<rawId>_<suffix>`, NOT the raw session id.
// A Claude session is a conversation; a board root is a unit of work, and one conversation has more
// than one of those over its life. `_` collides with neither `:` (the key separator) nor `/` (which
// can appear in a branch-keyed external id), AND is inside repair.ts's assertIdShape character
// class `[A-Za-z0-9:_-]` — a delimiter outside it would make these ids unrepairable.
export const ROOT_DELIMITER = '_'

// A minted suffix is N lowercase hex chars. Matching that shape EXACTLY, rather than accepting
// "anything after the delimiter", is what makes the predicates below airtight for non-UUID raw
// session ids: `--session` accepts an arbitrary string, so a pair like `sess` and `sess_a` would
// otherwise be prefix-related and cross-match. Real session ids are UUIDs (equal-length, no `_`)
// and cannot collide, but the predicates must not depend on that argument holding.
//
// The mint (below) and this validator are derived from ONE constant and live in ONE file,
// deliberately. If they ever disagree, every predicate here rejects every minted id,
// parseBoardNodes filters out all of this session's board rows, and `boardNodes` goes empty —
// which is the exact FLOW-190 symptom this change exists to remove. The fix would silently
// reintroduce its own bug.
const MINTED_SUFFIX_LENGTH = 8
const MINTED_SUFFIX_PATTERN = new RegExp(`^[0-9a-f]{${MINTED_SUFFIX_LENGTH}}$`)

// The `.replace(/-/g, '')` is load-bearing, not cosmetic. A v4 uuid carries a dash at index 8, so
// `randomUUID().slice(0, N)` is pure hex only for N <= 8 — measured at 2000 samples per N: N=8
// passes 2000/2000, N=9 FAILS 2000/2000 (e.g. "31521433-"). Without the replace,
// MINTED_SUFFIX_LENGTH is a trapdoor that looks tunable and is not: raise it to 9 and the mint
// emits a suffix its own validator rejects every single time. With the replace it is a genuine
// constant (verified pure hex at N = 8, 9, 12, 16, 24).
export const mintRootSuffix = (): string =>
  randomUUID().replace(/-/g, '').slice(0, MINTED_SUFFIX_LENGTH)

// Does this external id belong to THIS raw session? Covers every live shape: the legacy root (the
// raw id itself, for a node minted before FLOW-190), a minted root, and any keyed descendant of
// either. Back-compat is by shape, not migration: no existing node is ever rewritten.
//
// Both predicates anchor on the FULL raw session id BEFORE splitting on `:` — never the reverse.
// Splitting first (`externalId.split(':')[0]` then comparing) silently rejects every node of any
// session whose raw id itself contains a `:`, because the split truncates the raw id mid-way. The
// symptom of that is an empty `boardNodes` — the exact bug this change exists to fix. Raw session
// ids are UUIDs today, but `--session` accepts an arbitrary string, and the comment above commits
// these predicates to not depending on that.
export const isSessionExternalId = (externalId: string, rawId: string): boolean => {
  if (externalId === rawId || externalId.startsWith(`${rawId}:`)) return true // legacy root or child
  const prefix = `${rawId}${ROOT_DELIMITER}`
  if (!externalId.startsWith(prefix)) return false
  return MINTED_SUFFIX_PATTERN.test(externalId.slice(prefix.length).split(':')[0])
}

// Is this external id a ROOT for this raw session — legacy or minted? No explicit "contains no `:`"
// check is needed: `^[0-9a-f]{8}$` cannot match anything carrying a colon, so a keyed child is
// rejected by the suffix test itself.
export const isRootExternalId = (externalId: string, rawId: string): boolean => {
  if (externalId === rawId) return true // legacy root
  const prefix = `${rawId}${ROOT_DELIMITER}`
  if (!externalId.startsWith(prefix)) return false
  return MINTED_SUFFIX_PATTERN.test(externalId.slice(prefix.length))
}

const saveRegistry = (rawSessionId: string, nodes: RegistryNode[]): void => {
  atomicWrite(registryFilePath(rawSessionId), JSON.stringify({ nodes }, null, 2))
}
