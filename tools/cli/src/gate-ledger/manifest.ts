import { atomicWrite, storePath, ticketScope } from '../workflow-store/store.ts'

// Who normally runs a gate. 'senior' is accepted on a record because a senior that re-runs a gate
// under a licensed condition still records it (see the role table in skills/team-dispatch/SKILL.md).
export type GateRole = 'implementer' | 'team-lead' | 'senior'

// Who a manifest may declare as a gate's owner — narrower than GateRole, and enforced: parseManifest
// rejects 'senior' outright, because the senior's own gate — the review checklist — has no command
// and no exit status and is therefore never declared in a manifest at all.
export type DeclaredGateOwner = Exclude<GateRole, 'senior'>

export interface DeclaredGate {
  name: string
  command: string
  owner: DeclaredGateOwner
}

// The store file holding a ticket's declared-gate list — ticket-scoped, the same scope and the
// same store `ledger.ts` already uses for that ticket's recorded gate runs. Never a file in the
// repo the gates run against: declaring, recording, and checking a ticket's gates all stay inside
// the workflow's own store, so nothing ever ends up in a repo's working tree for an agent to
// commit or gitignore.
const MANIFEST_FILE = 'declared-gates.json'

// The store path a ticket's declared-gate list lives at. Deterministic — no filesystem walk,
// unlike the repo-root manifest this replaced: a ticket's gates are declared once (`gate-ledger
// declare`) and every later `record`/`check` for that ticket resolves the same path.
export const manifestPath = (ticket: string): string =>
  storePath(ticketScope(ticket), MANIFEST_FILE)

// Parse and validate already-read text. Throws on anything malformed rather than silently dropping
// a row: a manifest this function half-accepts would under-report the declared list, and
// under-reporting the declared list is precisely the blind spot the coverage check exists to close.
// Takes content rather than a path so that whoever read the file owns the absent/unreadable
// distinction — a second read here would be a second answer to "is there a manifest".
export const parseManifest = (path: string, content: string): DeclaredGate[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    // Prefixed with the path like every throw below it. Callers print this message as the whole
    // reason a manifest is unusable, and a bare SyntaxError names no file.
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    })
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { gates?: unknown }).gates)
  )
    throw new Error(`${path}: expected an object with a "gates" array`)
  const gates = (parsed as { gates: unknown[] }).gates
  return gates.map((rawGate, i) => {
    if (typeof rawGate !== 'object' || rawGate === null)
      throw new Error(`${path}: gates[${i}] is not an object`)
    const { name, command, owner } = rawGate as Record<string, unknown>
    if (typeof name !== 'string' || name.trim().length === 0)
      throw new Error(`${path}: gates[${i}].name must be a non-blank string`)
    if (typeof command !== 'string' || command.trim().length === 0)
      throw new Error(`${path}: gates[${i}].command must be a non-blank string`)
    if (owner !== 'implementer' && owner !== 'team-lead')
      throw new Error(
        `${path}: gates[${i}].owner must be implementer or team-lead (never senior — see the comment on DeclaredGateOwner above)`
      )
    return { name, command, owner }
  })
}

// Persist a ticket's declared-gate list into the store, atomically. `content` is JSON text that
// has already been validated by the caller (`runDeclare` validates via `parseManifest`'s own shape
// checks before calling this) — written as-is, not re-parsed.
export const writeManifest = (ticket: string, content: string): void => {
  atomicWrite(manifestPath(ticket), content)
}
