import { createHash } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

// A sink names its scope; this module owns the durable layout underneath. Session-scoped state is
// partitioned per working-directory AND per raw session id; dir-scoped state is partitioned per
// working-directory only.
export type StoreScope =
  | { kind: 'session'; dirKey: string; sessionPartition: string }
  | { kind: 'session-global'; sessionPartition: string }
  | { kind: 'dir'; dirKey: string }
  | { kind: 'ticket'; ticket: string }

// What a read of a named state file found. `absent` and `unreadable` are the two cases `load`
// collapses into one null.
export type StoreRead =
  { kind: 'content'; content: string } | { kind: 'absent' } | { kind: 'unreadable'; code: string }

// Raised when a durable store exists and this process cannot read it. Carries the errno so the
// caller can say which, and a single exit code shared by every tool that can hit it: three tools
// each picking their own number would report one condition three different ways, which is the
// confusion this whole class of fix exists to remove.
//
// 26 rather than 17: review-ledger already uses 17 for an unrelated refusal (a round-close blocked
// on an outstanding senior teardown) that predates this constant, so 17 would make one review-ledger
// invocation ambiguous between two unrelated causes. 26 is the next number after every exit code any
// command in this CLI sets via setRequestedExitCode, and is clear of Stricli's own reserved band
// (1, and the truncated negatives 246 and 251-255) too.
export const STORE_UNREADABLE_EXIT = 26

// ENOTDIR, ELOOP, and ENAMETOOLONG fire while resolving a path component before the target is ever
// reached, so they say nothing exists at that exact path — planting a plain file where a ticket
// directory belongs reproduces this. EACCES, EPERM, EISDIR, and EIO all fire on the target itself.
const EXISTENCE_CONFIRMING_CODES = new Set(['EACCES', 'EPERM', 'EISDIR', 'EIO'])

// Of the codes above, only these two are a chmod/chown away from fixed — the other two mean a
// directory sits at the path or the device failed to read it, neither of which ownership touches.
const OWNERSHIP_REPAIRABLE_CODES = new Set(['EACCES', 'EPERM'])

// What an errno from a classified read actually means, as the phrase that follows a subject (a
// path, a label, or nothing at all) describing it. A site that interprets a read()'s failing code
// into its own wording calls this rather than holding its own copy, so there is one place that
// decides what an errno means instead of one per caller free to drift from the others. Excluded: a
// site that only forwards Node's own fs error message verbatim, reporting rather than deciding —
// e.g. the bare `readFileSync` read behind gate-ledger's `--output-file` flag, which reaches a
// generic `error: err.message` catch and interprets nothing, so this helper has nothing to offer
// it. Not an exhaustive list of such sites.
export const unreadableErrnoPhrase = (code: string): string =>
  !EXISTENCE_CONFIRMING_CODES.has(code)
    ? `could not be confirmed to exist or be read (${code}) — check its full path`
    : OWNERSHIP_REPAIRABLE_CODES.has(code)
      ? `exists but could not be read (${code}) — check its owner and permissions`
      : `exists but could not be read (${code})`

export class StoreUnreadableError extends Error {
  readonly code: string

  constructor(path: string, code: string) {
    super(`${path} ${unreadableErrnoPhrase(code)}`)
    this.name = 'StoreUnreadableError'
    this.code = code
  }
}

// The durable root. Home-dir-backed, NEVER os.tmpdir() — temp is age-reaped after ~3 days idle and
// that reaping is exactly the data loss FLOW-156 fixes. homedir() reads $HOME on POSIX, so tests
// override HOME to keep the real ~/.claude/workflow-state untouched.
export const storeRoot = (): string => join(homedir(), '.claude', 'workflow-state')

// The stable, filesystem-safe key for the current working directory: <basename>-<12 hex of the
// sha256 of the realpath>. realpath resolves symlinks so the key is stable across sessions and
// restarts; the hash covers the full canonical path so two directories never collide.
//
// Pinned once at process start (FLOW-165): the dir-key derives from the launch cwd's realpath and
// is cached for the process lifetime. A long-lived process — the PR monitor — may later change cwd
// or have its worktree removed underneath it; re-reading process.cwd() on every store access
// resolved a different key after a chdir, or threw ENOENT once the cwd was deleted mid-poll. The
// anchor is unchanged (same launch-cwd value as before) — only the number of times it is computed
// changes — so no existing on-disk state is re-keyed and no migration is needed.
let pinnedDirKey: string | null = null

export const resolveDirKey = (): string => {
  if (pinnedDirKey === null) pinnedDirKey = dirKeyFor(process.cwd())
  return pinnedDirKey
}

// The per-process session scope. The partition is the raw Claude session id, stable across a
// --resume restart (FLOW-155), read from the environment so every sink in a process shares one
// partition without threading it through each builder.
export const sessionScope = (): StoreScope => ({
  kind: 'session',
  dirKey: resolveDirKey(),
  sessionPartition: sessionPartition(),
})

// Session-scoped but cwd-INDEPENDENT: partitioned by the raw session id ALONE (no dirKey), so a
// session's state resolves identically from any working directory. Used for the dashboard node
// registry, whose rawId→node mapping does not depend on cwd (FLOW-173). Defaults to the ambient
// CLAUDE_CODE_SESSION_ID, but accepts an explicit rawSessionId so a caller can address a SPECIFIC
// session's registry file by id — e.g. verifying whether an explicit --session belongs to the
// current session's own registry — without relying on the environment.
export const sessionGlobalScope = (rawSessionId?: string): StoreScope => ({
  kind: 'session-global',
  sessionPartition: sessionPartitionFor(rawSessionId ?? process.env.CLAUDE_CODE_SESSION_ID),
})

// Ticket-scoped state: shared by every session working the same ticket — the team lead, each
// implementer, and each freshly-spawned senior round. Deliberately NOT partitioned by session or
// by cwd; the whole point is that a senior spawned in round 3 reads what round 1 wrote.
export const ticketScope = (ticket: string): StoreScope => ({ kind: 'ticket', ticket })

// Resolve the durable path for a named state file within a scope.
export const storePath = (scope: StoreScope, name: string): string => join(scopeDir(scope), name)

// Monotonic per-process counter so concurrent writers never share a temp path (FLOW-122).
let atomicWriteCounter = 0

// Write to a unique temp path then rename — prevents torn reads AND cross-process temp collisions.
// Relocated from dashboard/state.ts; now also creates the durable parent dir, which — unlike
// os.tmpdir() — does not pre-exist.
//
// writeFileSync's mode option only applies when the call creates `tmp` — the counter resets per
// process, so a same-pid crash between a prior writeFileSync and its renameSync (or a leftover
// from before this repo pinned 0o600 at all) can leave `tmp` on disk at some other mode, and
// renameSync installs that mode on `path` along with the fresh content. The chmodSync repairs
// `tmp` unconditionally, right before it becomes `path`, so the file that lands is always 0o600
// regardless of what `tmp` started at.
export const atomicWrite = (path: string, content: string): void => {
  ensureDurableDir(dirname(path))
  const tmp = `${path}.${process.pid}.${atomicWriteCounter++}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

// Append one line. Unlike atomicWrite this is additive, which is what makes it safe for concurrent
// writers: a fold over appended events has no lost-update window, where load-mutate-save does. The
// caller bounds the line's size (see review-ledger/ledger.ts) to keep lines small and diff-friendly
// — that bound is not a claim of atomicity under concurrent O_APPEND writers beyond what the kernel
// actually provides (PIPE_BUF governs pipes, not regular files).
//
// appendFileSync's mode option only takes effect when the call creates the file — unlike
// atomicWrite's siblings (a fresh 0600 temp file renamed over the target), an append can land on a
// file that already exists at whatever mode it was created with. The trailing chmodSync repairs
// that on every call, not just the first, so a ledger written before this fix is corrected the next
// time anything appends to it, rather than staying world-readable forever. The mode option on the
// creating call is not made redundant by that trailing chmodSync: without it, a freshly created
// file exists at 0644 under the usual 0022 umask for the interval between appendFileSync returning
// and chmodSync narrowing it — this is a multi-writer path by design, so a concurrent reader that
// opens the file inside that interval keeps its file descriptor for as long as it holds it, and the
// later chmod does not retract the access already granted.
export const appendLine = (path: string, line: string): void => {
  ensureDurableDir(dirname(path))
  appendFileSync(path, `${line}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

// Read a named state file within a scope. Returns its content, or null when the file could not be
// read — which is NOT the same as "absent": every errno collapses to null here, so a file that
// exists and is unreadable (EACCES, EISDIR, EIO) is indistinguishable from a cold start. A caller
// that acts on null as "there is nothing there" must use `loadClassified` instead.
export const load = (scope: StoreScope, name: string): string | null =>
  readIfPresent(storePath(scope, name))

// `load` with the two cases it collapses kept apart. ENOENT is the only errno treated as absent;
// every other one (ENOTDIR, EACCES on a parent directory, ...) means this process cannot confirm
// there is nothing there, not that the file positively exists — either way, a caller deciding
// whether work is outstanding must not read it as "nothing outstanding".
export const loadClassified = (scope: StoreScope, name: string): StoreRead =>
  readClassified(storePath(scope, name))

// Delete a durable state file. Idempotent: a missing file is a no-op.
export const clearStore = (scope: StoreScope, name: string): void => {
  rmSync(storePath(scope, name), { force: true })
}

// Creates `dir` and, for everything from storeRoot() down to it, repairs any level that already
// existed at a different mode — mkdirSync's `mode` option, like appendFileSync's, only applies to a
// level it actually creates, so a directory left over from before this fix (or storeRoot() itself,
// made once and never touched again) would otherwise keep its original mode forever. Repair masks
// the existing mode to its owner bits (`& 0o700`) rather than forcing exactly 0o700: the property
// this exists to guarantee is no group/other access — what leaks ticket ids, PR numbers, and
// session ids — not the owner bits, which this code has no standing to override. The mask also
// clears setuid/setgid/sticky along with the type bits, deliberately: an inherited setgid bit
// (which a Linux directory picks up from a setgid parent) implies group semantics that contradict
// a tree granting no group access at all. Only creation asserts an exact mode, via mkdirSync's
// own `mode` option below. Every caller in this codebase passes a `dir` under storeRoot() (it's
// always `dirname()` of a `storePath()` result), so the boundary check below is defensive, not a
// real branch in practice.
//
// Never touches storeRoot()'s parent (~/.claude) or anything above it — that tree is shared with the
// rest of Claude Code and this module doesn't own it. It is created (if missing at all) with no mode
// argument, at whatever the process's ambient default is, and the repair walk stops at storeRoot()
// rather than climbing into it — on both the creation path and the repair path, so the boundary means
// the same thing regardless of which one a given call takes, including for a non-normalized `dir`
// (a literal '..' segment, a trailing separator): both `dir` and `root` are resolved before either
// the boundary check or the walk runs, so a string that would otherwise pass isRootOrBeneath's
// prefix check while the kernel resolves it outside storeRoot() is caught before any chmod happens.
// resolve(), not realpathSync(): realpathSync throws on a path that doesn't exist yet, the normal
// case for a function whose job is to create one, and symlink collapse would have to apply to both
// sides or the comparison breaks (this suite's HOME override sits under os.tmpdir(), itself a
// symlink on macOS). A symlinked level *under* storeRoot() redirecting a chmod outside it is a
// residual this doesn't close — planting one already requires write access inside the user's home,
// so it's an accepted limit, not an escalation.
export const ensureDurableDir = (rawDir: string): void => {
  const root = resolve(storeRoot())
  const dir = resolve(rawDir)
  mkdirSync(dirname(root), { recursive: true })
  if (!isRootOrBeneath(dir, root)) {
    mkdirSync(dir, { recursive: true })
    return
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (let current = dir; ; current = dirname(current)) {
    chmodSync(current, statSync(current).mode & 0o700)
    if (current === root) break
  }
}

// True when `dir` is storeRoot() itself or anything under it — never a sibling that merely shares
// its prefix as a string (a bare startsWith would also match e.g. `workflow-state-backup`).
const isRootOrBeneath = (dir: string, root: string): boolean =>
  dir === root || dir.startsWith(root + sep)

// The session partition trusts CLAUDE_CODE_SESSION_ID to be present and identical across every
// context that touches a session-scoped sink — the agent's Bash tool, the Stop-hook CLI, and the
// wake mod's `mailbox check` (GATE-B: the hook passes --session equal to this env var; the surrounding
// hook design otherwise avoids trusting env, so this dependency is called out deliberately). If it
// ever diverged, the failure is fail-safe OVER-isolation — a session fails to see its OWN state
// (e.g. stop-gate reads empty and allows) — never a cross-session leak.
const sessionPartition = (): string => sessionPartitionFor(process.env.CLAUDE_CODE_SESSION_ID)

const sessionPartitionFor = (raw: string | undefined): string =>
  raw && raw.length > 0 ? safeSegment(raw) : 'no-session'

const scopeDir = (scope: StoreScope): string => {
  switch (scope.kind) {
    case 'session':
      return join(storeRoot(), scope.dirKey, scope.sessionPartition)
    case 'session-global':
      return join(storeRoot(), 'sessions', scope.sessionPartition)
    case 'dir':
      return join(storeRoot(), scope.dirKey)
    case 'ticket':
      return join(storeRoot(), 'tickets', ticketSegment(scope.ticket))
  }
}

// ticketScope is the first safeSegment caller to use its result as sole identity, with no hash
// disambiguator the way dirKeyFor has one — and the value comes straight from an untrusted
// --ticket flag rather than a resolved filesystem path. Two failure modes follow directly from
// safeSegment alone: '..' passes through unchanged (dots are in its allowed set) and resolves
// outside tickets/ entirely, and distinct raw tickets that only differ in a disallowed character
// ('FLOW/245', 'FLOW 245') collapse onto one sanitized segment and share a ledger.
//
// Fixed by only reaching for a hash when sanitization would actually lose information: a ticket
// that is already a valid segment (and not the literal '.' or '..', nor '', all of which are
// unchanged by sanitization but collapse under path.join the same way '.' does) keeps its exact,
// unhashed path — every ticket key in real use (Jira's own format) is untouched, so no ledger
// already on disk moves. A ticket that sanitization WOULD alter, or that IS '.'/'..'/'', gets a
// hash of the raw value appended; two distinct raw tickets that sanitize to the same string now get
// different segments, and a hash-suffixed segment can never be exactly '.', '..', or '', which
// closes the traversal case as a side effect of closing the collision case.
const ticketSegment = (ticket: string): string => {
  const sanitized = safeSegment(ticket)
  if (sanitized === ticket && sanitized !== '.' && sanitized !== '..' && sanitized !== '')
    return sanitized
  const hash = createHash('sha256').update(ticket).digest('hex').slice(0, 12)
  return `${sanitized}-${hash}`
}

const dirKeyFor = (cwd: string): string => {
  const canonical = realpathSync(cwd)
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12)
  return `${safeSegment(basename(canonical))}-${hash}`
}

const readIfPresent = (path: string): string | null => {
  const read = readClassified(path)
  return read.kind === 'content' ? read.content : null
}

export const readClassified = (path: string): StoreRead => {
  try {
    return { kind: 'content', content: readFileSync(path, 'utf-8') }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', code: code ?? 'UNKNOWN' }
  }
}

const safeSegment = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, '_')
