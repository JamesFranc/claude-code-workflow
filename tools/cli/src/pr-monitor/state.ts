import {
  existsSync,
  linkSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import {
  atomicWrite,
  ensureDurableDir,
  sessionGlobalScope,
  sessionScope,
  storePath,
  storeRoot,
  unreadableErrnoPhrase,
} from '../workflow-store/store.ts'

// --- Types ---

export interface CiCheck {
  name: string
  state: string
}

export interface ReviewThread {
  path: string
  line: number | null
  isResolved: boolean
  firstCommentBody?: string
  firstCommentId?: string
}

export interface Review {
  id?: string
  author: string
  authorType: string // 'User' | 'Bot' | 'Mannequin' | 'Organization' | 'Unknown'
  state: string
  body?: string
}

export interface BotComment {
  id: string
  author: string
  // Absent on state saved before FLOW-373; compareStates never reads a missing hash as an edit.
  bodyHash?: string
}

export interface MainComment {
  id: string
  author: string
}

export type CoderabbitStatus = 'none' | 'rate-limited' | 'paused'

export interface PrState {
  ciChecks: Record<string, string>
  // isMergeReady runs on `previous` too, so a truncated check set persisted as green would
  // suppress the merge-ready edge from the store side.
  ciChecksFetchFailed: boolean
  unresolvedThreads: ReviewThread[]
  // True means the thread list is not known to be complete: isMergeReady's knownNoOpenThreads
  // treats it as possibly-open and refuses merge-ready.
  fetchFailed: boolean
  prState: string
  isDraft: boolean
  reviews: Review[]
  coderabbitSkipped: boolean
  coderabbitStatus: CoderabbitStatus
  coderabbitCooloffMinutes: number | null
  coderabbitThrottleCount: number
  mergeable: string
  mergeStateStatus: string
  headSha: string
  botComments: BotComment[]
  mainComments: MainComment[]
  ciGreenOnDraftFired: boolean
  timestamp: string
  // Why prState is UNKNOWN; set by fetchPrState only on that path and never persisted.
  unknownReason?: string
}

export type ChangeType =
  | 'CI_FAILURE'
  | 'NEW_THREADS'
  | 'NEW_BOT_COMMENTS'
  | 'MERGED'
  | 'CLOSED'
  | 'MERGE_READY'
  | 'READY_FOR_REVIEW'
  | 'CI_GREEN_ON_DRAFT'
  | 'MERGE_CONFLICT'
  | 'CODERABBIT_RATE_LIMITED'
  | 'CODERABBIT_PAUSED'
  // Kebab-case per CLAUDE.md §Naming Conventions.
  | 'new-main-comments'
  | 'monitor-wedged'
  | 'bot-comments-edited'

export interface StateChange {
  type: ChangeType
  detail: string
}

// --- Durable store (per raw session; cwd-independent, NOT global) ---
// Each session keeps its own watched PRs and baselines — not necessarily the session that opened
// the PR; a session routinely watches a PR it did not open, and each watcher keeps its own
// baseline (store-scope.test.ts's 3a/3b). Registering, `--stop` and `mailbox check` resolve the
// same partition (the session id from CLAUDE_CODE_SESSION_ID, or `--session` for the check), so
// they address one store regardless of which directory each ran from (FLOW-216). Cold start: a
// first read finds no file at the new path — see readStoreRaw()/adoptLegacy() below for the
// one-time adoption of the pre-FLOW-216 cwd-keyed file(s), merged across every directory this
// session was ever launched from, before falling back to a clean slate.

const STALE_ENTRY_MS = 14 * 24 * 60 * 60_000 // 14 days

// pr-monitor's per-session directory under the durable root. lock.ts joins its lock files here.
// Session-partitioned but cwd-INDEPENDENT: registration runs from whatever directory the
// orchestrator's shell happens to be in — repo root, worktree — and a cwd-derived key gave the same
// PR a different baseline per directory, so every poll after a change of directory read an absent
// file, fell back to cleanBaseline(), and re-emitted every transition (FLOW-216). The session
// partition is KEPT deliberately: two sessions watching one PR must each keep their own baseline
// and their own wake stream, so this must never become a PR-global store.
// The optional rawSessionId is for out-of-process readers — mailbox/check.ts resolves its own raw
// id from `--session` or the env var and passes it here, so the dead-monitor query reads the same
// session's locks that the wake check reports for (FLOW-224). Omitted, this is byte-identical to
// the previous no-arg form: sessionGlobalScope() falls back to CLAUDE_CODE_SESSION_ID
// (workflow-store/store.ts), which is what every existing caller relies on.
export const storeDir = (rawSessionId?: string): string =>
  storePath(sessionGlobalScope(rawSessionId), 'pr-monitor')
export const statePath = (): string => join(storeDir(), 'state.json')

const prKey = (prNumber: string, repo: string): string => `${repo}#${prNumber}`

interface StoreEntry {
  state: PrState
  updatedAt: string
}

interface SelfComments {
  ids: string[]
  updatedAt: string
}

// A PR this session's `mailbox check` polls (FLOW-402): written by `pr-monitor --pr --repo`,
// removed by `--stop`, by a MERGED/CLOSED event, or by the wedge bound. Never pruned by age:
// watching is an explicit registration, and a PR that stays open for weeks is still being waited
// on. An unreadable store degrades to empty in loadStore and the next write drops this map with it
// — the same pre-existing degrade every other subtree here has.
export interface WatchedPr {
  prNumber: string
  repo: string
  registeredAt: string
  consecutiveUnknown: number
  // Why the latest UNKNOWN poll failed; set with each count, cleared with it.
  lastFailure?: string
  // When a check last began polling this PR; the check polls the least recently polled first.
  lastPolledAt?: string
}

interface Store {
  prs: Record<string, StoreEntry>
  selfComments?: Record<string, SelfComments>
  selfReady?: Record<string, string>
  watched?: Record<string, WatchedPr>
}

const MAX_SELF_COMMENT_IDS = 200

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== ''

const normalizeWatched = (raw: Partial<WatchedPr> | undefined): WatchedPr | null => {
  if (!raw || !isNonEmptyString(raw.prNumber) || !isNonEmptyString(raw.repo)) {
    return null
  }
  if (!isNonEmptyString(raw.registeredAt)) {
    return null
  }
  const count = raw.consecutiveUnknown
  return {
    prNumber: raw.prNumber,
    repo: raw.repo,
    registeredAt: raw.registeredAt,
    consecutiveUnknown:
      typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : 0,
    ...(isNonEmptyString(raw.lastFailure) ? { lastFailure: raw.lastFailure } : {}),
    ...(isNonEmptyString(raw.lastPolledAt) ? { lastPolledAt: raw.lastPolledAt } : {}),
  }
}

const normalizeSelfComments = (raw: Partial<SelfComments> | undefined): SelfComments | null => {
  if (!raw || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))) {
    return null
  }
  const ids = Array.isArray(raw.ids)
    ? raw.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
  return { ids: ids.slice(-MAX_SELF_COMMENT_IDS), updatedAt: raw.updatedAt }
}

const normalizeState = (raw: Partial<PrState>): PrState => {
  const threads = objectArray<ReviewThread>(raw.unresolvedThreads)
  return {
    ciChecks: isRecord(raw.ciChecks) ? raw.ciChecks : {},
    // Defaults to FAILED for a legacy entry written before the field existed, and for a
    // wrong-shaped ciChecks: in both cases the check set on hand is not one we can call complete.
    ciChecksFetchFailed: booleanOr(raw.ciChecksFetchFailed, true) || !isRecord(raw.ciChecks),
    unresolvedThreads: threads ?? [],
    // Defaults to FAILED for a legacy entry written before the field existed: that entry's empty
    // thread list may be an unreadable fetch, and there is no way to tell now. Defaulting to
    // succeeded would let such an entry read merge-ready as `previous` and swallow the next real
    // MERGE_READY; defaulting to failed can only cost one redundant emission of a true statement.
    //
    // A wrong-shaped thread list takes the same route, and must not simply become `[]`: an empty
    // list is what isMergeReady reads as knownNoOpenThreads, so coercing garbage to it asserts
    // "no open threads" on the strength of a value we could not read. `fetchFailed` already means
    // "the thread list could not be established", which is exactly what a wrong shape tells us.
    fetchFailed: booleanOr(raw.fetchFailed, true) || threads === null,
    prState: raw.prState ?? 'UNKNOWN',
    isDraft: booleanOr(raw.isDraft, true),
    reviews: (objectArray<Review>(raw.reviews) ?? []).map((r) => ({
      author: r.author ?? 'unknown',
      authorType: r.authorType ?? 'Unknown',
      state: r.state ?? 'PENDING',
    })),
    coderabbitSkipped: booleanOr(raw.coderabbitSkipped, false),
    coderabbitStatus: raw.coderabbitStatus ?? 'none',
    coderabbitCooloffMinutes: raw.coderabbitCooloffMinutes ?? null,
    coderabbitThrottleCount: numberOr(raw.coderabbitThrottleCount, 0),
    mergeable: raw.mergeable ?? 'UNKNOWN',
    mergeStateStatus: raw.mergeStateStatus ?? 'UNKNOWN',
    headSha: stringOr(raw.headSha, ''),
    botComments: objectArray<BotComment>(raw.botComments) ?? [],
    mainComments: objectArray<MainComment>(raw.mainComments) ?? [],
    ciGreenOnDraftFired: booleanOr(raw.ciGreenOnDraftFired, false),
    timestamp: raw.timestamp ?? new Date().toISOString(),
  }
}

const booleanOr = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' ? value : fallback

const stringOr = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback

// normalizeState runs inside loadStore's try, and every one of these fields is consumed with
// `.map`/`.filter`. A wrong shape therefore throws where the catch returns an empty store, so one
// malformed field on one PR discards the persisted state of every PR, silently. Returning null
// for "unusable" lets each field's caller choose a fallback that fails closed for its own consumer
// rather than sharing one that happens to fail open for some of them.
const objectArray = <T>(value: unknown): T[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'object' && entry !== null)
    ? (value as T[])
    : null

// Excludes arrays: Object.values(['success']) is ['success'], which reads as every check green.
// Checks each value's type too: a non-string value (e.g. a boolean or number) is not one of the
// checks a run can produce, and passing it through would let a corrupted status masquerade as one.
const isRecord = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((v) => typeof v === 'string')

// Every sibling cwd-derived dirKey's pr-monitor directory for THIS session, under storeRoot() — the
// base every pre-FLOW-216 legacy file (state OR lock) lived under. Scanning only THIS process's own
// dirKey (sessionScope()'s) finds a legacy file correctly only when the first post-upgrade launch
// happens to be from the same directory it was last written from — a coin flip, and a new story's
// worktree defeats it immediately. 'sessions' is excluded: it is the NEW session-global root
// (FLOW-173), never a legacy dirKey.
//
// Exported for lock.ts's legacyLockPaths: this same gap applied to lock files, unnoticed when
// S2/S2b were written — the traversal belongs here exactly once rather than
// existing twice with a chance to drift.
//
// Sorted by dirKey name: readdirSync's order is unspecified, but lock.ts's reportLegacyHolders
// lists every live legacy holder it finds, so an unsorted scan would name them in a different order
// from run to run for the exact same on-disk state. Sorting fixes the order without pretending
// there is only ever one legacy holder to find.
export const legacySiblingStoreDirs = (): string[] => {
  const scope = sessionScope()
  if (scope.kind !== 'session') return [] // sessionScope() always returns 'session'; narrows the type
  const { sessionPartition: partition } = scope
  try {
    return readdirSync(storeRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'sessions')
      .map((entry) => entry.name)
      .sort()
      .map((dirKey) => join(storeRoot(), dirKey, partition, 'pr-monitor'))
  } catch {
    return []
  }
}

// Every pre-FLOW-216 legacy pr-monitor state file for THIS session, one per sibling directory (see
// legacySiblingStoreDirs above).
const legacyStatePaths = (): string[] =>
  legacySiblingStoreDirs()
    .map((dir) => join(dir, 'state.json'))
    .filter((path) => existsSync(path))

// Merge every sibling directory's legacy store into one, per PR key — different directories can
// hold different, unrelated PRs (the bug doc's own reproduction found two), so this is a per-key
// merge (newest updatedAt wins), never a whole-file-wins. Persisting the merge is an optimization,
// not the point of this function: the caller already has the merged content in hand, and returns
// it regardless of whether the persist succeeds — losing it here would reproduce the exact
// cleanBaseline() wake this migration exists to prevent.
//
// Legacy files are LEFT IN PLACE, never removed — an earlier version of this fix deleted them after
// a successful persist, which review caught as actively harmful: a pre-upgrade monitor may still be
// RUNNING and reading/writing its own dirKey's state.json. stopLegacyMonitor's legacy check is
// per-PR, but this state file is per-DIRECTORY and holds every PR that directory's monitors have
// ever watched — so adopting PR B's baseline here, while PR A's live pre-upgrade monitor still owns
// the very same file, and then deleting it would yank the file out from under that RUNNING process:
// its next loadStore finds nothing, falls back to cleanBaseline(), and fires a spurious wake in the
// OLD process. Exactly the symptom this ticket removes — caused by the migration itself.
//
// Leaving the file is safe indefinitely: readStoreRaw (below) only ever consults a legacy path when
// the new path read fails with ENOENT, so once statePath() exists here, this file is never read
// again by this session. Nothing later deletes it either — it is left in place, unread, until
// whatever else already cleans up that dirKey directory (if anything ever does) gets to it.
//
// Residual trade, chosen deliberately: leaving the file instead of deleting it swaps a GUARANTEED,
// IMMEDIATE spurious wake (deletion, above) for a smaller, POSSIBLE, LATER one. The merge snapshots
// PR A's baseline at whatever state it was in when PR B's monitor happened to adopt it, while A's
// live pre-upgrade monitor keeps updating the (now orphaned, from the new store's point of view)
// legacy file underneath it. When A's old monitor eventually exits and a new one starts, statePath()
// already exists, so it reads the frozen snapshot instead of A's fresher legacy data and may re-emit
// whatever changed in between — but only once A's OLD process has already exited, never while it is
// still running. Strictly better than the deleted version, and deliberately not fixed further: the
// alternative — coupling this store to the lock module to skip snapshotting entries with a live
// legacy holder — buys protection against a rare, one-time transitional wake at the cost of a
// permanent cross-module dependency.
const adoptLegacy = (): string | null => {
  const merged: Record<string, StoreEntry> = {}
  const found: string[] = []
  for (const legacyPath of legacyStatePaths()) {
    let parsed: Partial<Store>
    try {
      parsed = JSON.parse(readFileSync(legacyPath, 'utf-8')) as Partial<Store>
    } catch {
      continue // unreadable or corrupt — leave it in place rather than guess
    }
    for (const [key, entry] of Object.entries(parsed.prs ?? {})) {
      // An unparseable updatedAt must never win a slot: Date.parse gives NaN, and any comparison
      // against NaN is false — so a garbage entry seen first would take the slot unconditionally
      // (via `!existing`) and then every later, genuinely valid entry would lose to it forever
      // (`validMs > NaN` is false too). Matches loadStore's own updatedAt guard below.
      if (
        !entry ||
        typeof entry.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(entry.updatedAt))
      ) {
        continue
      }
      const existing = merged[key]
      if (
        !existing ||
        new Date(entry.updatedAt).getTime() > new Date(existing.updatedAt).getTime()
      ) {
        merged[key] = entry
      }
    }
    found.push(legacyPath)
  }
  if (found.length === 0) return null

  const raw = JSON.stringify({ prs: merged })
  withStoreLock(() => {
    // A concurrent writer may have already established current-format content between our
    // caller's ENOENT read and this lock's acquisition — never clobber it with a stale legacy
    // merge that predates it. The in-memory `raw` is still returned below either way.
    if (existsSync(statePath())) return
    try {
      atomicWrite(statePath(), raw)
    } catch {
      // best-effort — the merged content is still returned below even if the persist failed
    }
  })
  return raw
}

// Read the store. The new path, once present, always wins outright — legacy is consulted ONLY
// when it is absent (ENOENT), so a surviving legacy file can never resurrect a stale baseline over
// a live one. Any OTHER read failure (EACCES, EIO, ...) also skips the legacy merge — the current
// path exists but is transiently unreadable, not absent, so merging legacy over it would risk
// overwriting newer state with older — and degrades to null (-> loadStore's `{ prs: {} }`) instead
// of propagating, since the --ack-comment process and the lock-free loaders have no catch at all.
//
// Two consequences of that degrade:
//   1. One spurious re-emit for each watched PR polled from the clean baseline.
//   2. A LATENT risk on the NEXT write: writeStore's atomicWrite renameSync's a fresh temp file
//      over statePath(). rename needs write permission on the DIRECTORY, not the file, so an EACCES
//      on the file itself very likely still lets the rename through — silently replacing the store
//      and discarding every OTHER PR's baseline and the watched list it held.
const readStoreRaw = (): string | null => {
  try {
    return readFileSync(statePath(), 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.error(
        `pr-monitor: state store ${unreadableErrnoPhrase(code ?? 'UNKNOWN')}; ` +
          `continuing from a clean baseline; this poll may re-emit transitions already seen`
      )
      return null
    }
  }
  return adoptLegacy()
}

const loadStore = (): Store => {
  const rawText = readStoreRaw()
  if (rawText === null) return { prs: {} }
  try {
    const raw = JSON.parse(rawText) as Partial<Store>
    const entries = raw.prs ?? {}
    const now = Date.now()
    const prs: Record<string, StoreEntry> = {}
    for (const [key, entry] of Object.entries(entries)) {
      if (!entry || typeof entry.updatedAt !== 'string') continue
      if (now - new Date(entry.updatedAt).getTime() > STALE_ENTRY_MS) continue // prune stale
      prs[key] = {
        state: normalizeState(entry.state ?? {}),
        updatedAt: entry.updatedAt,
      }
    }
    const rawSelfComments = raw.selfComments ?? {}
    const selfComments: Record<string, SelfComments> = {}
    for (const [key, entry] of Object.entries(rawSelfComments)) {
      const normalized = normalizeSelfComments(entry)
      if (!normalized) continue
      if (now - new Date(normalized.updatedAt).getTime() > STALE_ENTRY_MS) continue // prune stale
      selfComments[key] = normalized
    }
    const rawSelfReady = raw.selfReady ?? {}
    const selfReady: Record<string, string> = {}
    for (const [key, recordedAt] of Object.entries(rawSelfReady)) {
      if (typeof recordedAt !== 'string' || !Number.isFinite(Date.parse(recordedAt))) {
        continue
      }
      selfReady[key] = recordedAt
    }
    const watched: Record<string, WatchedPr> = {}
    for (const [key, entry] of Object.entries(raw.watched ?? {})) {
      const normalized = normalizeWatched(entry)
      if (normalized) {
        watched[key] = normalized
      }
    }
    return { prs, selfComments, selfReady, watched }
  } catch {
    return { prs: {} }
  }
}

const writeStore = (store: Store): void => {
  atomicWrite(statePath(), JSON.stringify(store, null, 2))
}

export const loadState = (prNumber: string, repo: string): PrState | null => {
  const store = loadStore()
  const entry = store.prs[prKey(prNumber, repo)]
  return entry ? entry.state : null
}

// `checkStartedAt` is when the check running this poll began. The `--ack-ready` ack is spent only
// when it was recorded no later than that: see pollOnce for why that anchor is safe.
export const saveState = (
  prNumber: string,
  repo: string,
  state: PrState,
  checkStartedAt: string = new Date().toISOString()
): void => {
  withStoreLock(() => {
    const store = loadStore()
    const key = prKey(prNumber, repo)
    store.prs[key] = { state, updatedAt: new Date().toISOString() }
    const ackedAt = store.selfReady?.[key]
    if (store.selfReady && ackedAt !== undefined && ackedAt <= checkStartedAt) {
      delete store.selfReady[key]
    }
    writeStore(store)
  })
}

export const deleteState = (prNumber: string, repo: string): void => {
  withStoreLock(() => {
    const store = loadStore()
    const key = prKey(prNumber, repo)
    delete store.prs[key]
    if (store.selfComments) delete store.selfComments[key]
    if (store.selfReady) {
      delete store.selfReady[key]
    }
    writeStore(store)
  })
}

export const recordSelfComment = (prNumber: string, repo: string, commentId: string): void => {
  withStoreLock(() => {
    const store = loadStore()
    const key = prKey(prNumber, repo)
    const existing = store.selfComments?.[key]?.ids ?? []
    if (existing.includes(commentId)) return
    store.selfComments = {
      ...(store.selfComments ?? {}),
      [key]: {
        ids: [...existing, commentId].slice(-MAX_SELF_COMMENT_IDS),
        updatedAt: new Date().toISOString(),
      },
    }
    writeStore(store)
  })
}

export const loadSelfCommentIds = (prNumber: string, repo: string): string[] =>
  loadStore().selfComments?.[prKey(prNumber, repo)]?.ids ?? []

// `pr-monitor --ack-ready`: the lead is about to run `gh pr ready` itself. The next draft→ready
// edge this PR's poller observes is its own action, not news (FLOW-281), so any unspent ack
// suppresses it. Only a check that began after the ack was recorded spends it (saveState): the
// acking turn ran `gh pr ready` before it ended, and a check starts only while the session is idle,
// so every read of such a check is after the flip, and a PR still in draft means `gh pr ready`
// failed. A check that began earlier — a turn can start while a check is running — leaves the ack
// for the next one, because its reads may precede the flip.
export const recordSelfReady = (prNumber: string, repo: string): void => {
  withStoreLock(() => {
    const store = loadStore()
    store.selfReady = {
      ...(store.selfReady ?? {}),
      [prKey(prNumber, repo)]: new Date().toISOString(),
    }
    writeStore(store)
  })
}

export const loadSelfReadyAt = (prNumber: string, repo: string): string | undefined =>
  loadStore().selfReady?.[prKey(prNumber, repo)]

export const watchPr = (prNumber: string, repo: string): void => {
  withStoreLock(() => {
    const store = loadStore()
    const key = prKey(prNumber, repo)
    if (store.watched?.[key]) {
      return
    }
    store.watched = {
      ...(store.watched ?? {}),
      [key]: { prNumber, repo, registeredAt: new Date().toISOString(), consecutiveUnknown: 0 },
    }
    writeStore(store)
  })
}

export const unwatchPr = (prNumber: string, repo: string): boolean => {
  let removed = false
  withStoreLock(() => {
    const store = loadStore()
    const key = prKey(prNumber, repo)
    if (!store.watched?.[key]) {
      return
    }
    delete store.watched[key]
    removed = true
    writeStore(store)
  })
  return removed
}

// Sorted by key, so a check that reports two PRs reports them in the same order every time.
export const loadWatched = (): WatchedPr[] =>
  Object.entries(loadStore().watched ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, pr]) => pr)

// The wedge counter. Both only touch an entry that still exists: a check whose snapshot predates a
// `--stop` must not bring the PR back (FLOW-402 F9). recordUnknownPoll returns the new count and
// the failure it stored, or null when the PR is no longer watched.
export const recordUnknownPoll = (
  prNumber: string,
  repo: string,
  failure: string
): { count: number; failure: string } | null => {
  let result: { count: number; failure: string } | null = null
  withStoreLock(() => {
    const store = loadStore()
    const entry = store.watched?.[prKey(prNumber, repo)]
    if (!entry) {
      return
    }
    entry.consecutiveUnknown += 1
    entry.lastFailure = failure
    result = { count: entry.consecutiveUnknown, failure }
    writeStore(store)
  })
  return result
}

// Stamps the PR as polled by the check that is starting on it. A PR that is no longer watched is
// left alone.
export const markPolled = (
  prNumber: string,
  repo: string,
  polledAt: string = new Date().toISOString()
): void => {
  withStoreLock(() => {
    const store = loadStore()
    const entry = store.watched?.[prKey(prNumber, repo)]
    if (!entry) {
      return
    }
    entry.lastPolledAt = polledAt
    writeStore(store)
  })
}

export const clearUnknownPolls = (prNumber: string, repo: string): void => {
  withStoreLock(() => {
    const store = loadStore()
    const entry = store.watched?.[prKey(prNumber, repo)]
    if (!entry || (entry.consecutiveUnknown === 0 && entry.lastFailure === undefined)) {
      return
    }
    entry.consecutiveUnknown = 0
    delete entry.lastFailure
    writeStore(store)
  })
}

// --- Cross-process store write lock (FLOW-261 review finding 226a2a5d12a8) ---
//
// saveState/deleteState/recordSelfComment above each do a whole-store read-modify-write —
// loadStore() -> mutate one subtree -> writeStore(store) — and adoptLegacy's persist above is a
// conditional whole-store overwrite gated on the same file. --ack-comment runs recordSelfComment
// in its OWN process with no lock of its own (its CLI branch takes no other lock), while
// `mailbox check` calls saveState on every poll in a SEPARATE process — interleaved, the poller's
// stale snapshot overwrites a just-recorded selfComments id, and no later --ack-comment call
// brings it back. Every writer to
// statePath() holds this lock across its ENTIRE read-modify-write span, not just the final write,
// so no writer's output can ever be computed from a snapshot another writer has already
// superseded. loadState and loadSelfCommentIds stay lock-free pure reads — their only path to a
// write is adoptLegacy's, which is already covered above.
//
// Deliberately not lock.ts's claimLock: that is a one-holder claim held for the Renovate monitor's
// whole lifetime, with a heartbeat — a short-lived --ack-comment process must be able to take
// this lock too, so this is its own primitive, mirroring claimLock's exclusive-create +
// stale-steal shape without importing lock.ts itself (lock.ts already imports FROM this module, so
// importing back would make the two circular).
const STORE_LOCK_STALE_MS = 30_000 // generous: the critical section is a handful of sync fs calls
const STORE_LOCK_RETRY_DELAY_MS = 5
const STORE_LOCK_MAX_ATTEMPTS = 200 // 200 * 5ms = up to ~1s waiting out a live, non-stale holder

interface StoreLockData {
  pid: number
  acquiredAt: string
}

export const storeLockPath = (): string => `${statePath()}.lock`

let storeLockTempCounter = 0

// Exclusive publish, mirroring lock.ts's tryExclusiveClaim: write the complete JSON to a unique
// temp file first, then atomically install it with an exclusive (no-overwrite) hard link — never
// a direct writeFileSync(path, ..., { flag: 'wx' }), which would make only the CREATE exclusive,
// not the WRITE atomic.
const tryExclusiveStoreLock = (path: string, data: StoreLockData): boolean => {
  const tempPath = `${path}.${process.pid}.${storeLockTempCounter++}.tmp`
  writeFileSync(tempPath, JSON.stringify(data), { mode: 0o600 })
  try {
    linkSync(tempPath, path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    return false
  } finally {
    rmSync(tempPath, { force: true })
  }
}

// Validated, not asserted — the same reasoning lock.ts's isValidLockData carries. The consequence
// here is specific to this lock: `pid` reaches `isStoreLockProcessAlive`'s `process.kill(pid, 0)`,
// and POSIX gives zero and negative pids process-GROUP meaning, so an unvalidated `0` returns
// without throwing and reads as a live holder. Nothing else ever reclaims that file, so every
// subsequent writer waits out the full attempt budget and then degrades to an UNLOCKED
// read-modify-write — permanently reopening the lost-update window this lock exists to close.
//
// The shape is millisecond precision, matching the `new Date().toISOString()` that acquireStoreLock
// writes.
const STORE_LOCK_TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const isValidStoreLockData = (data: unknown): data is StoreLockData => {
  if (!data || typeof data !== 'object') return false
  const row = data as Partial<Record<keyof StoreLockData, unknown>>
  if (typeof row.pid !== 'number' || !Number.isInteger(row.pid) || row.pid <= 0) return false
  return typeof row.acquiredAt === 'string' && STORE_LOCK_TIMESTAMP_SHAPE.test(row.acquiredAt)
}

const readStoreLockData = (path: string): StoreLockData | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    return isValidStoreLockData(parsed) ? parsed : null
  } catch {
    return null
  }
}

const isStoreLockProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH = no such process; EPERM = exists but not signalable by us (treat as alive)
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Alive AND fresh. Checking pid liveness, not just elapsed time, means a holder that died without
// running its `finally` (SIGKILL, OOM, a hard crash) reads as stale on the very next check, rather
// than only after STORE_LOCK_STALE_MS elapses.
//
// STORE_LOCK_TIMESTAMP_SHAPE constrains digit positions, not calendar validity, so a shape-valid
// but calendar-invalid acquiredAt (e.g. `2024-13-01T00:00:00.000Z`) passes isValidStoreLockData and
// still yields NaN from `new Date(...).getTime()`. NaN fails every comparison, so the age check
// alone would always read that holder as stale regardless of whether its process is actually
// running. Falling back to isStoreLockProcessAlive in that case keeps a genuinely alive holder with
// a corrupted acquiredAt from having its lock stolen.
const isLiveStoreLockHolder = (data: StoreLockData): boolean => {
  const lockAge = Date.now() - new Date(data.acquiredAt).getTime()
  if (Number.isNaN(lockAge)) return isStoreLockProcessAlive(data.pid)
  return lockAge < STORE_LOCK_STALE_MS && isStoreLockProcessAlive(data.pid)
}

const isStoreLockStale = (data: StoreLockData): boolean => !isLiveStoreLockHolder(data)

// A synchronous, blocking sleep — Node has no sync setTimeout, so this is the established pattern
// elsewhere in this codebase for a real wait inside sync code (ledger.test.ts, lock.race-child.ts).
export const blockingSleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Every temp/steal file tryExclusiveStoreLock/acquireStoreLock create is removed by their own
// finally/rmSync in the normal case; one survives only when its writer died between creating it
// and that cleanup (SIGKILL, OOM, a hard crash) mid-acquire — the same failure mode the lock file
// itself tolerates via isStoreLockStale. Reap by mtime rather than by pid: the writer that would
// know its own temp file's name is gone, so age past STORE_LOCK_STALE_MS is the only signal left
// that a file is abandoned rather than a concurrent racer's in-flight write.
const reapStoreLockTempFiles = (path: string): void => {
  const dir = dirname(path)
  const prefix = `${basename(path)}.`
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue
    const fullPath = join(dir, entry)
    try {
      if (now - statSync(fullPath).mtimeMs > STORE_LOCK_STALE_MS) rmSync(fullPath, { force: true })
    } catch {
      // already gone, or unreadable — leave it for the next reap
    }
  }
}

// A failed acquire degrades rather than propagates, matching readStoreRaw's precedent above: an
// uncaught throw here would reach saveState/deleteState/recordSelfComment and fail that PR's poll
// on every check (pollWatched would report each on stdout) — strictly worse than the
// transient, self-healing lost-update window this lock exists to close. The caller still runs its
// read-modify-write unlocked in this case; withStoreLock's storeLockDepth bookkeeping stays correct
// either way, and releaseStoreLock's ownership check (below) removes only a lock naming this
// process's own pid, so a degraded call that never actually acquired never deletes a lock it does
// not own.
const degradeStoreLockAcquire = (reason: string): void => {
  console.error(
    `pr-monitor: could not acquire the store write lock (${reason}) — continuing without it; ` +
      'this write may race a concurrent writer'
  )
}

// Acquire the store write lock, stealing a stale holder's file (a process that died mid-write)
// rather than blocking on it forever — mirrors lock.ts's claimLock claim loop, substituting
// isStoreLockStale's fixed freshness window for its heartbeat, since this lock's holders are
// short-lived critical sections with no heartbeat of their own.
const acquireStoreLock = (): void => {
  const path = storeLockPath()
  ensureDurableDir(dirname(path))
  reapStoreLockTempFiles(path)

  try {
    for (let attempt = 0; attempt < STORE_LOCK_MAX_ATTEMPTS; attempt++) {
      const data: StoreLockData = { pid: process.pid, acquiredAt: new Date().toISOString() }
      if (tryExclusiveStoreLock(path, data)) return

      const current = readStoreLockData(path)
      if (current && !isStoreLockStale(current)) {
        blockingSleep(STORE_LOCK_RETRY_DELAY_MS)
        continue // held by a live, recent writer — wait it out
      }

      // Looks stale (or unreadable) — steal it via an atomic rename so we hold the sole reference
      // to whatever is actually at `path` right now, then discard it and retry the claim.
      const stealPath = `${path}.steal.${process.pid}.${storeLockTempCounter++}.tmp`
      try {
        renameSync(path, stealPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        continue // another racer already reclaimed or removed it — retry the exclusive create
      }
      rmSync(stealPath, { force: true })
    }
  } catch (err) {
    degradeStoreLockAcquire((err as Error).message)
    return
  }
  // A live, non-stale holder made no progress across the whole wait budget — real contention from
  // a genuinely busy writer, or (with pid liveness now covering the SIGKILL/OOM/crash case above)
  // one whose pid was reused by an unrelated live process. Degrade instead of failing loudly: a
  // silent fallback here still reopens the lost-update window, but a thrown error would fail the
  // check outright, which is strictly worse.
  degradeStoreLockAcquire(
    `timed out after ${STORE_LOCK_MAX_ATTEMPTS * STORE_LOCK_RETRY_DELAY_MS}ms waiting on a live holder`
  )
}

// Ownership-checked, mirroring lock.ts's releaseLock: only remove the lock file if it still names
// THIS process. Without this check, a release running after this process's own hold went stale and
// was stolen by another writer would delete THAT writer's lock instead of its own — reopening the
// exact unserialized window this lock exists to close, for whichever third writer acquires next.
const releaseStoreLock = (): void => {
  const path = storeLockPath()
  const existing = readStoreLockData(path)
  if (existing?.pid !== process.pid) return
  try {
    rmSync(path)
  } catch {
    // already gone
  }
}

// Reentrant per-process: a mutator holding this lock across its own read-modify-write span calls
// loadStore() internally, which may reach adoptLegacy()'s persist — itself gated on this same
// lock, so it stays protected when reached from an unlocked reader too. Re-entering a
// non-reentrant lock from within the same call stack would deadlock; storeLockDepth tracks a
// same-process hold so a nested call reuses it instead of trying to re-acquire.
let storeLockDepth = 0

const withStoreLock = <T>(fn: () => T): T => {
  if (storeLockDepth > 0) {
    storeLockDepth++
    try {
      return fn()
    } finally {
      storeLockDepth--
    }
  }
  acquireStoreLock()
  storeLockDepth = 1
  try {
    return fn()
  } finally {
    storeLockDepth = 0
    releaseStoreLock()
  }
}

// --- Synthetic clean baseline (drives first-poll problem-state events) ---

export const cleanBaseline = (): PrState => ({
  ciChecks: {},
  ciChecksFetchFailed: false,
  unresolvedThreads: [],
  fetchFailed: false,
  prState: 'OPEN',
  isDraft: true,
  reviews: [],
  coderabbitSkipped: false,
  coderabbitStatus: 'none',
  coderabbitCooloffMinutes: null,
  coderabbitThrottleCount: 0,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headSha: '',
  botComments: [],
  mainComments: [],
  ciGreenOnDraftFired: false,
  timestamp: new Date().toISOString(),
})

// --- Merge readiness (tightened) ---

// Reviews that constitute a decision on the PR. COMMENTED and PENDING are NOT decisions:
// GitHub's own reviewDecision ignores them, and a trailing COMMENTED (e.g. CodeRabbit's
// release-notes summary, posted right after its APPROVED) must never unset a standing
// approval.
const DECISION_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'])

// Reduce reviews to each author's latest decision review. GraphQL returns reviews
// chronologically, so the last decision in array order wins; non-decision reviews
// (COMMENTED / PENDING) are skipped so a later comment never overwrites an earlier APPROVED.
const latestDecisionByAuthor = (reviews: Review[]): Review[] =>
  Object.values(
    reviews.reduce<Record<string, Review>>((acc, r) => {
      if (DECISION_STATES.has(r.state)) acc[r.author] = r
      return acc
    }, {})
  )

const isMergeReady = (state: PrState): boolean => {
  const checks = Object.values(state.ciChecks)
  const allChecksGreen =
    !(state.ciChecksFetchFailed ?? true) &&
    checks.length > 0 &&
    checks.every((s) => s === 'success' || s === 'skipped')
  const decisionReviews = latestDecisionByAuthor(state.reviews ?? [])
  const approvals = decisionReviews.filter((r) => r.state === 'APPROVED')
  const changesRequested = decisionReviews.some((r) => r.state === 'CHANGES_REQUESTED')
  const knownNoOpenThreads =
    !(state.fetchFailed ?? true) && (state.unresolvedThreads ?? []).length === 0
  const mergeClean = (state.mergeStateStatus ?? 'UNKNOWN') === 'CLEAN'
  return (
    !(state.isDraft ?? true) &&
    allChecksGreen &&
    approvals.length > 0 &&
    !changesRequested &&
    knownNoOpenThreads &&
    mergeClean
  )
}

const isCiGreenOnDraft = (state: PrState): boolean => {
  if (!state.isDraft) return false
  if (state.ciChecksFetchFailed ?? true) return false
  const checks = Object.values(state.ciChecks)
  return checks.length > 0 && checks.every((s) => s === 'success' || s === 'skipped')
}

// --- Thread dedup helpers ---

const simpleHash = (str: string): string => {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash + char) | 0
  }
  return hash.toString(36)
}

const threadKey = (t: ReviewThread): string => {
  const base = `${t.path}:${t.line}`
  return t.firstCommentBody ? `${base}:${simpleHash(t.firstCommentBody)}` : base
}

// --- Comparison ---

// Does not consult `fetchFailed` / `ciChecksFetchFailed`, though `isMergeReady` and
// `isCiGreenOnDraft` above both do. They answer "is it safe to merge", where an unread previous
// state must never read as clean, so they refuse. This answers "what changed" for the check map:
// a failed CI-checks poll persists an empty check map, so the next good poll re-announces every
// still-red check. Fails toward noise rather than toward clean.
//
// A thread-read failure never reaches here: resolvePrState returns UNKNOWN when
// fetchUnresolvedThreads fails, and poll.ts returns before compareStates or saveState run — so
// `unresolvedThreads` below is always current when this executes.
export const compareStates = (
  previous: PrState,
  current: PrState,
  selfCommentIds: readonly string[] = [],
  selfReady = false
): StateChange[] => {
  const changes: StateChange[] = []

  // A new commit (changed head SHA) is a fresh review cycle — used to re-arm
  // per-commit signals (CI_GREEN_ON_DRAFT re-emit, CodeRabbit throttle reset).
  const headChanged =
    !!current.headSha && !!previous.headSha && current.headSha !== previous.headSha

  // PR state transitions (terminal — early return)
  if (current.prState === 'MERGED' && previous.prState !== 'MERGED') {
    changes.push({ type: 'MERGED', detail: 'PR has been merged' })
    return changes
  }

  if (current.prState === 'CLOSED' && previous.prState !== 'CLOSED') {
    changes.push({ type: 'CLOSED', detail: 'PR has been closed without merging' })
    return changes
  }

  // Merge readiness (after MERGED/CLOSED, before CI/threads)
  if (isMergeReady(current) && !isMergeReady(previous)) {
    const head = current.headSha ? ` (head ${current.headSha.slice(0, 7)})` : ''
    changes.push({
      type: 'MERGE_READY',
      detail: `PR is ready to merge — all checks green, no open threads, CLEAN, approved${head}`,
    })
  }

  // Direct draft → ready flip in GitHub that is NOT confirmed merge-ready (the user readied
  // the PR themselves instead of approving the flip-to-ready gate). `!isMergeReady` is not the
  // same as "a blocker exists": isMergeReady folds ciChecksFetchFailed into allChecksGreen, so it
  // is also false when the check map could not be read. The MERGE_READY block above already
  // covers the ready+approved+green case; guard on !isMergeReady so the two never double-emit.
  // Lets the handler withdraw the now-moot CI_GREEN_ON_DRAFT flip-to-ready item. An acked flip is
  // the lead's own `gh pr ready` and emits nothing (FLOW-281).
  if (
    (previous.isDraft ?? true) &&
    !(current.isDraft ?? true) &&
    !isMergeReady(current) &&
    !selfReady
  ) {
    changes.push({
      type: 'READY_FOR_REVIEW',
      detail: 'PR moved out of draft (ready for review) — not confirmed merge-ready',
    })
  }

  // CI green on draft (one-shot per state file via watermark, transition-only)
  if (
    isCiGreenOnDraft(current) &&
    (!isCiGreenOnDraft(previous) || headChanged) &&
    current.ciGreenOnDraftFired === false
  ) {
    current.ciGreenOnDraftFired = true
    changes.push({
      type: 'CI_GREEN_ON_DRAFT',
      detail: 'CI green on draft PR — flip to ready-for-review when you want human review',
    })
  }

  // Merge conflicts
  const prevMergeable = previous.mergeable ?? 'MERGEABLE'
  const currMergeable = current.mergeable ?? 'MERGEABLE'
  if (
    currMergeable !== 'UNKNOWN' &&
    currMergeable === 'CONFLICTING' &&
    prevMergeable !== 'CONFLICTING'
  ) {
    changes.push({
      type: 'MERGE_CONFLICT',
      detail: 'PR has merge conflicts with the base branch',
    })
  }

  // CodeRabbit review-availability transitions (rate-limited / paused).
  // Count is monitor-owned and resets on a new commit.
  const prevCoderabbit = previous.coderabbitStatus ?? 'none'
  const currCoderabbit = current.coderabbitStatus ?? 'none'
  let throttleCount = previous.coderabbitThrottleCount ?? 0
  if (headChanged) {
    throttleCount = 0
  }
  if (currCoderabbit === 'rate-limited' && prevCoderabbit !== 'rate-limited') {
    throttleCount += 1
    const mins = current.coderabbitCooloffMinutes
    const cooloff =
      mins != null
        ? `next review in ~${mins}m (retry after ${new Date(Date.now() + mins * 60_000).toISOString()})`
        : 'cooloff unknown — use fallback wait'
    changes.push({
      type: 'CODERABBIT_RATE_LIMITED',
      detail: `CodeRabbit rate-limited — ${cooloff}; occurrence ${throttleCount}`,
    })
  }
  current.coderabbitThrottleCount = throttleCount
  if (currCoderabbit === 'paused' && prevCoderabbit !== 'paused') {
    changes.push({
      type: 'CODERABBIT_PAUSED',
      detail: 'CodeRabbit paused review (active development) — re-request when work settles',
    })
  }

  // CI failures
  for (const [name, currentStatus] of Object.entries(current.ciChecks)) {
    const previousStatus = previous.ciChecks[name] ?? 'pending'
    if (currentStatus === 'failure' && previousStatus !== 'failure') {
      changes.push({
        type: 'CI_FAILURE',
        detail: `Check "${name}" failed (was: ${previousStatus})`,
      })
    }
  }

  // New unresolved review threads
  const selfIds = new Set(selfCommentIds)
  const previousThreadKeys = new Set(previous.unresolvedThreads.map(threadKey))
  const previousLegacyThreadKeys = new Set(
    previous.unresolvedThreads.map((t) => `${t.path}:${t.line}`)
  )
  const newThreads = current.unresolvedThreads.filter((t) => {
    if (t.firstCommentId && selfIds.has(t.firstCommentId)) return false
    const key = threadKey(t)
    const legacyKey = `${t.path}:${t.line}`
    return !previousThreadKeys.has(key) && !previousLegacyThreadKeys.has(legacyKey)
  })
  if (newThreads.length > 0) {
    const paths = [...new Set(newThreads.map((t) => t.path))].join(', ')
    changes.push({
      type: 'NEW_THREADS',
      detail: `${newThreads.length} new unresolved review thread${newThreads.length > 1 ? 's' : ''} in: ${paths}`,
    })
  }

  // New top-level bot comments (coderabbit et al. post findings outside review threads)
  const previousBotCommentIds = new Set((previous.botComments ?? []).map((c) => c.id))
  const newBotComments = (current.botComments ?? []).filter((c) => !previousBotCommentIds.has(c.id))
  if (newBotComments.length > 0) {
    const authors = [...new Set(newBotComments.map((c) => c.author))].join(', ')
    changes.push({
      type: 'NEW_BOT_COMMENTS',
      detail: `${newBotComments.length} new top-level bot comment${newBotComments.length > 1 ? 's' : ''} from: ${authors}`,
    })
  }

  // Edited top-level bot comments. CodeRabbit keeps one summary comment per PR and rewrites it in
  // place on each review, so its all-clear arrives as an edit under an id already seen, never as a
  // new one (FLOW-373). A previous entry with no bodyHash was saved before the hash existed: it is
  // never read as edited, or the first poll after upgrade would wake on every bot comment in the
  // store.
  const previousBotHashes = new Map(
    (previous.botComments ?? []).flatMap((c): Array<[string, string]> =>
      c.bodyHash ? [[c.id, c.bodyHash]] : []
    )
  )
  const editedBotComments = (current.botComments ?? []).filter((c) => {
    const before = previousBotHashes.get(c.id)
    return before !== undefined && c.bodyHash !== undefined && c.bodyHash !== before
  })
  if (editedBotComments.length > 0) {
    const authors = [...new Set(editedBotComments.map((c) => c.author))].join(', ')
    changes.push({
      type: 'bot-comments-edited',
      detail: `${editedBotComments.length} edited top-level bot comment${editedBotComments.length > 1 ? 's' : ''} from: ${authors}`,
    })
  }

  // New main review comments (a non-empty review body, or a top-level conversation comment from a
  // non-bot). `selfIds` is consulted here as well as on threads above: the agent posts its own main
  // comments (skills/pr-feedback/SKILL.md §Attribution), and the shared GitHub account means the
  // agent's comment carries the same author as that one human reviewer's, so inside this filter a
  // recorded id is what separates them (FLOW-261). A bot's conversation comment is separable
  // without one — `extractMainComments`' conversation arm has already split those off by login
  // before this runs. What this cannot observe: an EDIT to a main comment already seen. The id is
  // unchanged, so the diff does not fire and the edited text never reaches the lead. That is
  // deliberate — `threadKey` above hashes a thread's first comment body only because `path:line` is
  // not a stable identity for a thread, not to detect edits; a main comment has GitHub's own id, so
  // there is nothing here for a hash to compensate for.
  const previousMainCommentIds = new Set((previous.mainComments ?? []).map((c) => c.id))
  const newMainComments = (current.mainComments ?? []).filter(
    (c) => !previousMainCommentIds.has(c.id) && !selfIds.has(c.id)
  )
  if (newMainComments.length > 0) {
    const authors = [...new Set(newMainComments.map((c) => c.author))].join(', ')
    changes.push({
      type: 'new-main-comments',
      detail: `${newMainComments.length} new main review comment${newMainComments.length > 1 ? 's' : ''} from: ${authors}`,
    })
  }

  return changes
}
