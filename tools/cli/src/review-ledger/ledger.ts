import { linkSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { hashId } from '../dashboard/state.ts'
import {
  appendLine,
  ensureDurableDir,
  loadClassified,
  StoreUnreadableError,
  storePath,
  ticketScope,
} from '../workflow-store/store.ts'

// Whether a round's review re-examined the whole surface (adversarial) or was scoped to a fix-up
// pass over prior findings (cleanup). The re-arming predicate in
// skills/code-review/references/checklist.md needs this to pick its comparison anchor: a cleanup
// round doesn't extend what counts as "already reviewed", so anchoring to it would let genuinely
// new territory hide behind a round that never actually looked at it.
export type ReviewStance = 'adversarial' | 'cleanup'

// A stance the CLI computed rather than a caller declared, which admits a third answer the declared
// form cannot: 'undetermined', meaning at least one clause of the re-arming predicate could not be
// decided mechanically. It lives here rather than in stance.ts so the ledger's own event types can
// name it without importing the computation module — stance.ts imports from this file, and the
// reverse edge would be a cycle.
export type ComputedStance = ReviewStance | 'undetermined'

// Who raised a finding. Distinguishes the senior's own review from a finding that arrived through
// some other channel — CodeRabbit, a human's PR comment, the user — so the ledger doesn't read as
// though the senior caught everything on it. 'senior' is a write-time default only: `finding open`
// stamps it into the event it appends whenever a *call site* omits `--origin` (the senior's own
// call site is the one that does — see agents/senior-engineer.md). It is never applied at read
// time to an *event* that has no origin key, which is a different thing — see the `origin` field
// comment on `Finding` below for how those pre-existing events are folded.
export type FindingOrigin = 'senior' | 'coderabbit' | 'human' | 'user' | 'team-lead'

// The two licences that let a round close over a senior with no recorded shutdown. Deliberately the
// same shape as gate-ledger's --condition/--reason: a deliberate exception is recorded rather than
// silent. There is no 'because I say so' member — a lead who simply forgot has no licence, and that
// is the entire point of the check. `already-gone` covers a senior that terminated before the
// shutdown handshake could reach it, which is a real observed case: the teardown request comes back
// "no agent named … is reachable" because the agent had already completed.
//
// It lives in this file rather than beside the check it gates, because the senior-shutdown event
// below carries it and the ledger's own event types cannot import from the run layer — run.ts
// imports this file, and the reverse edge would be a cycle. Same argument as ComputedStance above.
//
// A third member, 'no-senior-spawned', was removed as a category error rather than trimmed for
// tidiness. A licence is only ever consulted when a refusal fires, and a refusal only fires when a
// spawn IS on record — so that member named exactly the state that never refuses. It could not
// license anything, and passing it discarded its reason and returned a success line byte-identical
// to an ordinary close: the "closed over it" case wearing the "closed over it and left a record"
// costume, which is the one distinction this whole check exists to draw. The situation it was reaching
// for — a senior that was spawned but never recorded — is served by `senior shutdown --ticket
// <TICKET-ID> --round N --agent-id X`, which records a shutdown with no spawn on record and
// attaches a real agent id.
export type SeniorCondition = 'unreachable' | 'already-gone'

// What a record note targets. A closed list: a record is one of the two things a human reads after
// the ticket (the PR body, the Jira description) or the commit message the squash rewrites — there
// is no free-text target, because a free-text target is how `--out-of-diff` became the route for
// every paperwork finding.
export type NoteTarget = 'pr-body' | 'jira-description' | 'commit-message'

// The verdict a senior records when it finishes reviewing a round.
export type ReviewVerdict = 'approve' | 'changes'

// One line per event, folded on read. See the plan's "Append-only event log" rationale: multiple
// roles write the same ticket's ledger concurrently, and a load-mutate-save cycle loses updates.
export type LedgerEvent =
  | {
      kind: 'round'
      at: string
      round: number
      // Why the counter moved without a close. Present only on a `round-advance` event: a close
      // appends this event too, and its explanation belongs to the round-reviewed beside it.
      //
      // Named `reason` rather than `advanceReason` deliberately — shrinkFreeText's field list names
      // `reason`, so an oversized explanation is halved until the line fits and the advance still
      // lands, where an unshrinkable name would reach serialize()'s "cannot fit" throw and leave a
      // wedged ledger wedged. A command whose only job is unwedging must not be blockable by the
      // length of its own prose. senior-shutdown's `reason` made the same call for the same reason.
      reason?: string
    }
  // Stamps the round being CLOSED with the sha the senior reviewed, appended by `next-round
  // --reviewed-sha` (or its deprecated alias `round-close`) in the same append as the 'round' event
  // that advances past it — every close advances, so the two events land together. Keyed by the
  // round number it closes — round 1's reviewed sha is the event with round: 1, not round: 2 — so a
  // reader never has to reason about an off-by-one between "the round reviewed" and "the round
  // that follows."
  | {
      kind: 'round-reviewed'
      at: string
      round: number
      reviewedSha: string
      stance: ReviewStance
      // What the predicate computed for this sha at the moment the round closed, recorded alongside
      // the declared stance rather than in place of it: the declared stance is what actually shaped
      // the review that happened, so it stays the value reviewedStances and resolvedAnchor read.
      // This is the audit trail — before it, a declared stance was a claim nothing could ever be
      // checked against.
      computedStance?: ComputedStance
      // Why the declaration was allowed to stand against a contradicting computation. Present only
      // on an overridden round. A reason recorded here is the whole cost of an override, and it is
      // what makes an override a decision someone made rather than a default nobody noticed.
      stanceReason?: string
      // What changed to justify an adversarial stance against a computed cleanup. Present only on
      // an adversarial-against-cleanup override. Named separately from stanceReason because the two
      // answer different questions: stanceReason explains why the declaration stands, scopeChange
      // names what changed to justify the adversarial stance.
      scopeChange?: string
      // Set when this close was licensed past the sha-reuse refusal. A fixed marker beside the free
      // text rather than a prefix inside it: "was this close licensed" is then answerable without
      // reading, parsing, or trusting the explanation, and it stays answerable if the explanation is
      // ever lost. Same shape as `truncated` for the same reason.
      //
      // Note it does NOT survive a shrink the way senior-shutdown's `condition` does — no field on
      // this event is shrinkable (shrinkFreeText's list names `reason`, not `stanceReason` or
      // `shaReuseReason`), so an oversized one reaches serialize()'s "cannot fit" throw instead.
      // The marker earns its place here on the first argument alone.
      shaReuseLicensed?: true
      // Why closing this round at a sha an earlier round already recorded is correct anyway. The
      // legitimate case is a re-review of an unchanged sha: a round whose findings were all ruled
      // invalid produces no commits, so the round that re-reviews it closes at the same sha.
      shaReuseReason?: string
      // Set when this close was licensed past exit 27: the round's senior was gone before it
      // recorded `review complete`. Same marker-beside-reason shape as shaReuseLicensed.
      reviewIncompleteLicensed?: true
      reviewIncompleteReason?: string
    }
  // The senior spawned for a round, recorded at spawn time by the team lead. This is the state that
  // did not exist before FLOW-323: without an agent identity on the round, a skipped shutdown
  // changes nothing any check could read. Keyed by the round the senior was spawned FOR, the same
  // keying as round-reviewed above.
  | { kind: 'senior-spawned'; at: string; round: number; agentId: string }
  // The teardown of a round's senior. Separate from senior-spawned rather than a field on it: the
  // two happen hours apart and are written by different calls, so a single mutable record would
  // reintroduce exactly the load-mutate-save cycle the append-only log exists to avoid.
  | {
      kind: 'senior-shutdown'
      at: string
      round: number
      agentId: string
      // Present only on a shutdown recorded without an acknowledged handshake — an agent already
      // gone, or one that never acknowledged. A reason recorded here is the whole cost of closing a
      // round over an unconfirmed teardown, and it is what makes that a decision someone made
      // rather than a default nobody noticed. Same shape as round-reviewed's stanceReason.
      reason?: string
      // Which of the two licences was claimed. Recorded alongside `reason` and not in place of it:
      // `reason` is shrinkable to the empty string by serialize()'s free-text pass, so a licensed
      // close whose line was oversized can reach a reader with no surviving trace of the licence at
      // all. This field is a fixed-width enum, is never shrunk, and keeps the two conditions
      // distinguishable on the record — which is what makes gate-ledger's --condition/--reason
      // parity true here rather than merely claimed.
      condition?: SeniorCondition
      truncated?: true
    }
  // The senior's own record that its review of a round began, and that it finished. Written by the
  // reviewer rather than the lead, so a round the lead never recorded still leaves a trace.
  | { kind: 'review-start'; at: string; round: number; sha: string }
  | { kind: 'review-complete'; at: string; round: number; sha: string; verdict: ReviewVerdict }
  | {
      kind: 'finding-open'
      at: string
      id: string
      round: number
      file: string
      symbol: string
      hint?: string
      summary: string
      origin?: FindingOrigin
      // Kept for ledgers written before FLOW-337: `finding open --out-of-diff` no longer exists, so
      // no new event carries this, but old lines still parse and `show` still renders it.
      outOfDiff?: string
      // The proof-ledger capture id or declared gate a check-file finding cites — present exactly
      // when `--file` is a check file (runOpenFindingScoped), which is filed only against a capture
      // that does not support its claim. Absent on every finding against a shipped path.
      check?: string
      truncated?: true
    }
  | {
      kind: 'finding-status'
      at: string
      id: string
      round: number
      status: 'fixed' | 'withdrawn'
      reason?: string
      fixCommit?: string
      truncated?: true
    }
  // Ownership is decided at dispatch, which happens after a finding is raised — a separate event
  // from finding-open rather than a field on it.
  | { kind: 'finding-assign'; at: string; id: string; round: number; owner: string }
  | { kind: 'instruction'; at: string; id: string; round: number; text: string; truncated?: true }
  | {
      kind: 'instruction-disposition'
      at: string
      id: string
      round: number
      disposition: 'acted' | 'not-acted' | 'not-applicable'
      reason?: string
      truncated?: true
    }
  // A record defect — the PR body, the Jira description, a commit message — addressed to the team
  // lead as a to-do and nothing else. Not a finding: nothing gates on it, `next-round` and the
  // stance computation never read it, and no round fails on it.
  | {
      kind: 'note-add'
      at: string
      id: string
      round: number
      target: NoteTarget
      text: string
      truncated?: true
    }
  | { kind: 'note-done'; at: string; id: string }

export interface Finding {
  id: string
  raisedInRound: number
  file: string
  symbol: string
  hint?: string
  summary: string
  status: 'open' | 'fixed' | 'withdrawn'
  withdrawnReason?: string
  // A --reason given on a fixed disposition without a --fix-commit — the fix landed somewhere a
  // commit sha can't name, e.g. a PR evidence comment. Kept separate from withdrawnReason: the two
  // never coexist (a finding is fixed xor withdrawn), but naming them the same way a reader expects
  // them to mean the same thing when they answer different questions — why this was declined, vs.
  // where this was actually fixed.
  fixReason?: string
  fixCommit?: string
  // Every fixCommit any `finding-status` event has ever named for this finding, oldest first —
  // unlike fixCommit above, never dropped on a re-raise or a later status event, only ever grown.
  // dischargedPairs (stance.ts) reads this, not fixCommit, so a commit already credited as a fix
  // stays excluded from new scope even after the finding was reopened and fixed again elsewhere.
  allFixCommits: string[]
  // Set only when a `finding-status` event flips a *withdrawn* finding to `fixed` — carries the
  // withdrawal's own reason forward so the fold cannot silently forget a withdrawal happened.
  // withdrawn -> fixed stays a legal transition (a finding withdrawn in error and later genuinely
  // fixed is real); what was wrong was that flip unconditionally dropping withdrawnReason left no
  // trace of the withdrawal for any later reader, including the senior. Cleared like the other
  // status-episode fields on the next finding-status event and on a finding-open re-raise (see
  // both call sites below) — it describes one specific past transition, not a standing flag.
  resurrectedFromWithdrawn?: string
  // Absent on a finding folded from a line written before this field existed (FLOW-245's own
  // ledger already holds 82 such findings) — there is no historical fact to backfill from, so this
  // stays optional rather than defaulting to 'senior' on read the way pre-migration stance does in
  // resolveAnchor below. Every finding-open written after this field shipped carries one: runOpenFinding
  // stamps 'senior' itself when `--origin` is omitted, so absence here is specifically a pre-migration
  // signal, not an omitted flag.
  origin?: FindingOrigin
  // Who is fixing it, set at dispatch. Without this, ownership lives only in a chat message no
  // later round and no respawned senior can read — the same defect class as the missing
  // reviewed-sha: state the mechanism depends on, kept outside the store that survives the round.
  owner?: string
  // The reason a pre-FLOW-337 `finding open --out-of-diff` gave for naming a path outside the diff —
  // absent on every finding written since, and on every finding whose --file the diff-scope guard
  // verified. Carried forward on a re-raise the same way hint/origin are: the fold's 'finding-open'
  // case does not fold a re-raise event's own fields back in (only status flips to 'open'), so this
  // reads from the finding's original open, not from whatever a later re-raise event happened to
  // pass.
  outOfDiff?: string
  // The capture id or gate a check-file finding cites — see the `check` field on the finding-open
  // event. Carried from the finding's original open the same way outOfDiff is.
  check?: string
  // Set when the event that produced this record was shrunk by serialize() to fit MAX_LINE_BYTES —
  // either the opening `finding-open` or a later `finding-status`. Which field was shortened is not
  // recorded: shrinkFreeText halves the longest field above its floor, so the summary may well have
  // survived whole while outOfDiff, hint or reason was cut. Carried through so a reader of `show`
  // can see this record is partial rather than believing a truncated one complete.
  truncated?: true
}

// `pending` is the FLOW-217 guarantee holding off disk: an instruction with no disposition event is
// visibly undischarged in every later round without any agent restating it in prose.
export interface Instruction {
  id: string
  dispatchedInRound: number
  text: string
  disposition: 'pending' | 'acted' | 'not-acted' | 'not-applicable'
  reason?: string
  // Set when an `instruction` or `instruction-disposition` event shrunk this record's text or
  // reason to fit MAX_LINE_BYTES — carried through so a reader of `show` can see this record is
  // partial rather than believing a truncated one complete.
  truncated?: true
  // Set only when an `instruction-disposition` event drops a reason the existing disposition
  // actually had (existing.reason !== undefined) by supplying none of its own (event.reason ===
  // undefined) — regardless of which disposition either side names. `--reason` is optional even on
  // `acted` (only not-acted/not-applicable require it, at the exit-6 guard in run.ts), so a reason
  // can be attached to, and then dropped from, any of the three. Carries the old reason forward so
  // the fold cannot silently forget it was ever recorded. This shares Finding.resurrectedFromWithdrawn's
  // capture-before-drop shape, but not its trigger: resurrectedFromWithdrawn fires only on the one
  // named withdrawn->fixed transition, where this fires on any reason-dropping re-disposition. It
  // is cleared like `reason` on the next instruction-disposition event and on an instruction-record
  // re-arm (see both call sites below).
  supersededReason?: string
}

// A record defect the lead fixes directly. `done` flips on note-done and back on a re-add — the
// same re-arm shape as Finding and Instruction, so a note the lead marked done in error and the
// next round re-raises reads as open again rather than being silently dropped.
export interface Note {
  id: string
  raisedInRound: number
  target: NoteTarget
  text: string
  done: boolean
  truncated?: true
}

export interface RoundSenior {
  round: number
  agentId: string
  // null until a senior-shutdown event for this entry's agentId lands. An entry whose senior is
  // still live and a round with no entry at all for that agentId are different states: the first is
  // an entry with a null shutdownAt, the second is the entry's plain absence. `round-close` refuses
  // on any entry in the first state — a ledger written before this field existed has no entries and
  // must never read as a leak.
  shutdownAt: string | null
  shutdownReason?: string
  // Which licence the close was made under, when it was made under one. Present exactly when the
  // shutdown was recorded by a licensed close rather than by a real teardown, so it also answers
  // the question shutdownReason cannot once shrunk: whether a licence was claimed at all.
  shutdownCondition?: SeniorCondition
  // Set when serialize() shrank the event that produced this record — shutdownReason is then partial.
  // Carried through for the same reason Finding and Instruction carry it: the licence reason is the
  // audit artifact a licensed close exists to produce, and a halved one presenting as complete is
  // the record silently overstating what it holds.
  truncated?: true
}

// One round's review as its senior recorded it. A round with no entry has not started.
export interface RoundReview {
  state: 'in-progress' | 'complete'
  sha: string
  startedAt: string
  completedAt?: string
  verdict?: ReviewVerdict
}

export interface Ledger {
  ticket: string
  round: number
  findings: Finding[]
  instructions: Instruction[]
  // Every note ever added, done or not — `show` filters to the open ones; the fold keeps all so a
  // re-add of a done note can find it.
  notes: Note[]
  skippedLines: number
  // The sha reviewed to close each round, keyed by the round number it closes (round 1's entry is
  // key "1", not "2" — see the 'round-reviewed' LedgerEvent comment). JSON object keys are always
  // strings, so a reader looks this up as reviewedShas[String(n)]. A round with no 'round-reviewed'
  // event on record (every round in a ledger written before this field existed, or a round nobody
  // has finished reviewing yet) simply has no entry — not a parse failure.
  reviewedShas: Record<string, string>
  // The stance each closed round was reviewed under, same keying as reviewedShas. FROZEN on the
  // round's first 'round-reviewed' event rather than last-write-wins: a later re-record for an
  // already-closed round (see resolveAnchor) can correct its reviewedSha but not its stance, because
  // the review that actually happened already shaped every finding and instruction raised that round
  // under the original stance. This is the canonical statement of the freeze invariant — every other
  // reference to it in this file (the fold below, resolveAnchor, resolvedAnchor's own comment here)
  // points back to this comment rather than restating why.
  reviewedStances: Record<string, ReviewStance>
  // What the predicate computed for each closed round, same keying and the same freeze-on-first-
  // record rule as reviewedStances above — for the same reason: the computation that ran at close
  // time is the one the round's declaration was checked against, and a later re-record cannot
  // retroactively change what was checked. Absent for every round closed before this field existed,
  // and for a round whose computation could not run.
  computedStances: Record<string, ComputedStance>
  // The override reason for each round whose declared stance contradicted the computed one, same
  // keying and freeze rule. A round with no entry was not overridden.
  stanceReasons: Record<string, string>
  // The scope-change explanation for each round whose declared adversarial stance contradicted a
  // computed cleanup stance, same keying and freeze rule as stanceReasons. A round with no entry
  // was not an adversarial-against-cleanup override.
  scopeChanges: Record<string, string>
  // The sha-reuse licence reason for each round closed at a sha an earlier round already recorded,
  // same keying and freeze rule as stanceReasons. A round with no entry was not licensed past that
  // refusal; an entry with an empty string is a licensed close whose reason did not survive, which
  // is why presence rather than truthiness is the test.
  shaReuseReasons: Record<string, string>
  // Why the counter was advanced past a round by `round-advance` instead of by a close, keyed by
  // the round advanced FROM — the wedged round itself, not the one that follows — with the same
  // freeze rule as stanceReasons. A round with no entry was advanced past by an ordinary close.
  //
  // A shrunk reason arrives here indistinguishable from a complete one, with no trace at all. The
  // value is a bare string with nowhere to carry serialize()'s `truncated` marker, unlike Finding
  // and Instruction, which are records with a field for it — and the marker is set: serialize()
  // stamps it on the raw event, and parseEvent drops it here. Reading it means opening the JSONL.
  // Nor is an empty entry the trace it might look like: shrinking stops the moment the line fits,
  // and everything else on a round event is tiny, so the reason is halved and left non-empty.
  roundAdvanceReasons: Record<string, string>
  // The seniors spawned for each round, keyed by round number as a string, same keying as
  // reviewedShas — one list entry per distinct agentId spawned for that round, in spawn order. A
  // round normally has one entry; a replacement senior (the first left without a shutdown, a second
  // spawned in its place) adds a second. Each entry's own agentId is frozen at its first
  // senior-spawned event; a repeat spawn of that SAME agentId does not add a second entry or move
  // anything. shutdownAt is last-write-wins within its own entry — a shutdown is a terminal fact, and
  // re-recording it is idempotent. A ledger written before this field held one senior per round folds
  // here as a one-element list.
  seniors: Record<string, RoundSenior[]>
  // Each round's review, keyed by round number as a string, same keying as reviewedShas. Until a
  // round's entry is `complete`, its findings may be a partial set.
  reviews: Record<string, RoundReview>
  // True once any round has a review-start on record. It arms closeRound's exit 27; a ledger with
  // no review events never arms it and closes as it did before they existed.
  reviewLifecycle: boolean
  // The exit-27 licence reason for each round closed without a review-complete, same keying and
  // freeze rule as shaReuseReasons.
  reviewIncompleteReasons: Record<string, string>
  // The comparison anchor the re-arming predicate reads directly rather than re-deriving itself:
  // the highest-numbered round on record with an adversarial stance, computed from reviewedStances
  // /reviewedShas above (see resolveAnchor). Because reviewedStances freezes on first record (see its
  // own comment just above), once a round is on record as adversarial nothing later can move it off —
  // there is no fallback to round 1 or to anything else (see the ReviewStance comment). null therefore
  // means "no round has closed with an adversarial stance", which covers both no round reviewed at
  // all, and rounds reviewed but every one stamped 'cleanup'. The second is reachable: round 1 is
  // adversarial by convention, not by enforcement, and closing round 1 with `--stance cleanup` on
  // either closing command (`round-close`, `next-round`) is accepted. From round 2 on, a null anchor
  // is the signal of a mis-stamped round 1 — diagnosable from
  // reviewedStances — and is a stop-and-escalate, never a value to default past.
  resolvedAnchor: { round: number; reviewedSha: string } | null
}

// MAX_LINE_BYTES bounds each ledger line's size defensively; it is not a POSIX atomicity guarantee.
// PIPE_BUF (also 4096 on Linux) governs atomic writes to a PIPE, not a regular file opened with
// O_APPEND — this module makes no claim about appendFileSync's atomicity under concurrent writers
// beyond what the kernel actually provides. The bound exists to keep lines diff-friendly and to cap
// worst-case truncation, not to guarantee non-interleaving. Free text is truncated to fit and
// flagged — never dropped, and never silently shortened.
const MAX_LINE_BYTES = 4096

const LEDGER_FILE = 'review-ledger.jsonl'

// A separator that cannot occur in a path, a symbol, or a Jira key, so no value can span the
// boundary and forge a collision with a different field split.
const ID_SEP = '\u0000'

let claimPublishCounter = 0

// Exclusive per-round claim guarding closeRound's read-then-write, on the shared path both
// runCloseRound and runNextRound take: readLedger's round is a plain
// read with nothing held across the gap to the appendEvent calls that close it, so two concurrent
// callers can both read round N and both believe they are the one closing it. This claims
// round N itself; a caller that goes on to actually close the round (both appends succeed) never
// releases it, because the round a claim names can never be claimed a second time regardless of who
// holds it or for how long. A caller whose appends fail after claiming has not closed anything —
// see releaseRoundClaim below, which undoes exactly that case. Same exclusive-hard-link idiom as
// tryExclusiveClaim in lock.ts/dashboard/state.ts: write the claim to a private temp file first,
// then install it with linkSync, which fails with EEXIST if another caller's link already landed —
// unlike a direct writeFileSync(..., { flag: 'wx' }), the write and the exclusivity check are two
// different filesystem operations there, whereas here the temp file's content is fully durable
// before the exclusive step is even attempted.
export const claimRoundAdvance = (ticket: string, round: number): boolean => {
  const path = roundClaimPath(ticket, round)
  ensureDurableDir(dirname(path))
  const tempPath = `${path}.${process.pid}.${claimPublishCounter++}.tmp`
  writeFileSync(tempPath, String(process.pid), { mode: 0o600 })
  try {
    linkSync(tempPath, path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    return false
  } finally {
    // Never leak the temp: the successful case links a SECOND directory entry to the same inode
    // (removing this one leaves the claim file's content intact), and the EEXIST/throw cases mean
    // the temp was never installed anywhere at all.
    rmSync(tempPath, { force: true })
  }
}

// Undoes a claimRoundAdvance that won but never got to close the round: the round's two appends
// (round-reviewed, then round) never happened, so the round has not actually advanced and holding
// the claim would only wedge every future caller at exit 9 forever with no round to show for it.
// force: true because a caller that raced to claim and then crashed before appending has already
// left nothing to remove here — this is called from the append failure path, not from a crash, but
// stays defensive rather than assuming the file is always present. Never called on the success path:
// once both appends land, the claim is exactly the permanent record claimRoundAdvance's own comment
// describes, and removing it here would let the same round be claimed and closed a second time.
export const releaseRoundClaim = (ticket: string, round: number): void => {
  rmSync(roundClaimPath(ticket, round), { force: true })
}

// Shared by both callers above (claimRoundAdvance, releaseRoundClaim) — neither is its sole caller
// any more, so it sits below both rather than below just one, per this repo's CLAUDE.md top-down
// convention for a helper with more than one caller.
const roundClaimPath = (ticket: string, round: number): string =>
  storePath(ticketScope(ticket), `round-${round}.advance-claim`)

export const findingId = (
  ticket: string,
  file: string,
  symbol: string,
  summary: string,
  check?: string
): string =>
  hashId(
    [ticket, file, symbol, summary, ...(check !== undefined ? [check] : [])].join(ID_SEP)
  ).slice(0, 12)

export const instructionId = (ticket: string, text: string): string =>
  hashId([ticket, 'instruction', text].join(ID_SEP)).slice(0, 12)

export const noteId = (ticket: string, target: NoteTarget, text: string): string =>
  hashId([ticket, 'note', target, text].join(ID_SEP)).slice(0, 12)

// True only once this ticket has appended at least one event — i.e. a file exists at
// ledgerPath(ticket). readLedger deliberately does NOT make this distinction (see its own test,
// "readLedger on a ticket with no file returns round 1 and empty arrays, not a throw"): every
// write-path command needs a brand-new ticket to bootstrap silently, with no separate creation
// step. A read-only summary command has the opposite need — `show`/`round` on a typo'd or
// never-created ticket must not read as a legitimately clean, zero-finding ledger, because that is
// indistinguishable from an actually-clean branch and hides exactly the failure the ledger exists
// to catch.
// Absent means absent and nothing else, derived from the same classified read readLedger uses so
// that one mechanism answers "is there a ledger here" instead of two that can drift apart.
// existsSync answers a different question — "is there a directory entry I can stat" — and returns
// false for a file whose parent directory denies traversal, so that route reported exit 8, "no
// ledger on disk", about a ledger that was on disk. An unreadable ledger is not an absent one:
// this returns true for it, and readLedger below raises rather than bootstrapping it as empty.
export const ledgerFileExists = (ticket: string): boolean =>
  loadClassified(ticketScope(ticket), LEDGER_FILE).kind !== 'absent'

export const readLedger = (ticket: string): Ledger => {
  const read = loadClassified(ticketScope(ticket), LEDGER_FILE)
  if (read.kind === 'unreadable') throw new StoreUnreadableError(ledgerPath(ticket), read.code)
  const lines =
    read.kind === 'absent' ? [] : read.content.split('\n').filter((l) => l.trim().length > 0)

  let round = 1
  let skippedLines = 0
  const findings = new Map<string, Finding>()
  const instructions = new Map<string, Instruction>()
  const notes = new Map<string, Note>()
  const reviewedShas: Record<string, string> = {}
  const reviewedStances: Record<string, ReviewStance> = {}
  const computedStances: Record<string, ComputedStance> = {}
  const stanceReasons: Record<string, string> = {}
  const scopeChanges: Record<string, string> = {}
  const shaReuseReasons: Record<string, string> = {}
  const roundAdvanceReasons: Record<string, string> = {}
  const seniors: Record<string, RoundSenior[]> = {}
  const reviews: Record<string, RoundReview> = {}
  const reviewIncompleteReasons: Record<string, string> = {}
  let reviewLifecycle = false

  for (const line of lines) {
    const event = parseEvent(line)
    if (event === null) {
      skippedLines += 1
      continue
    }
    switch (event.kind) {
      case 'round':
        round = event.round
        // Keyed by the round advanced FROM — see Ledger.roundAdvanceReasons. Freezes on the first
        // event that carries one, the same rule stanceReasons follows: a later advance past the
        // same round cannot rewrite why the first one happened.
        if (
          event.reason !== undefined &&
          roundAdvanceReasons[String(event.round - 1)] === undefined
        )
          roundAdvanceReasons[String(event.round - 1)] = event.reason
        break
      case 'round-reviewed':
        // Stance freezes on the round's first record — see Ledger.reviewedStances' comment above;
        // sha stays correctable. computedStance and stanceReason freeze with it, for the same
        // reason: they record what was checked at close time, which a later correction cannot move.
        if (reviewedStances[String(event.round)] === undefined) {
          reviewedStances[String(event.round)] = event.stance
          if (event.computedStance !== undefined)
            computedStances[String(event.round)] = event.computedStance
          if (event.stanceReason !== undefined)
            stanceReasons[String(event.round)] = event.stanceReason
          if (event.scopeChange !== undefined) scopeChanges[String(event.round)] = event.scopeChange
          if (event.shaReuseLicensed === true)
            shaReuseReasons[String(event.round)] = event.shaReuseReason ?? ''
          if (event.reviewIncompleteLicensed === true)
            reviewIncompleteReasons[String(event.round)] = event.reviewIncompleteReason ?? ''
        }
        reviewedShas[String(event.round)] = event.reviewedSha
        break
      case 'senior-spawned': {
        // Append, not overwrite — see Ledger.seniors' comment. A repeat spawn of the SAME agentId
        // does not add a second entry or move anything about the one it already has; a spawn of a
        // DIFFERENT agentId is a replacement senior and gets its own entry, in spawn order.
        const list = (seniors[String(event.round)] ??= [])
        if (!list.some((s) => s.agentId === event.agentId))
          list.push({ round: event.round, agentId: event.agentId, shutdownAt: null })
        break
      }
      case 'senior-shutdown': {
        const list = (seniors[String(event.round)] ??= [])
        const existing = list.find((s) => s.agentId === event.agentId)
        const updated: RoundSenior = {
          round: event.round,
          agentId: event.agentId,
          shutdownAt: event.at,
          ...(event.reason !== undefined ? { shutdownReason: event.reason } : {}),
          ...(event.condition !== undefined ? { shutdownCondition: event.condition } : {}),
          ...(event.truncated === true ? { truncated: true } : {}),
        }
        if (existing !== undefined) {
          // Last-write-wins within this one entry — a shutdown is a terminal fact, and re-recording
          // it is idempotent.
          list[list.indexOf(existing)] = updated
        } else {
          // A shutdown naming an agentId with no matching spawn in this round's list still records
          // it: the spawn event may have been lost (a crash between spawn and record), or this
          // round's list may be empty entirely, and dropping the shutdown would leave the round
          // looking like it never had a senior at all — the one state that reads as clean. Recording
          // it makes the round accounted for, which is what the check asks.
          list.push(updated)
        }
        break
      }
      case 'review-start':
        reviewLifecycle = true
        // A replacement senior restarting the round keeps the first start time.
        reviews[String(event.round)] = {
          state: 'in-progress',
          sha: event.sha,
          startedAt: reviews[String(event.round)]?.startedAt ?? event.at,
        }
        break
      case 'review-complete':
        reviews[String(event.round)] = {
          state: 'complete',
          sha: event.sha,
          startedAt: reviews[String(event.round)]?.startedAt ?? event.at,
          completedAt: event.at,
          verdict: event.verdict,
        }
        break
      case 'finding-open': {
        const existing = findings.get(event.id)
        if (existing === undefined) {
          findings.set(event.id, {
            id: event.id,
            raisedInRound: event.round,
            file: event.file,
            symbol: event.symbol,
            summary: event.summary,
            status: 'open',
            allFixCommits: [],
            ...(event.hint !== undefined ? { hint: event.hint } : {}),
            ...(event.origin !== undefined ? { origin: event.origin } : {}),
            ...(event.outOfDiff !== undefined ? { outOfDiff: event.outOfDiff } : {}),
            ...(event.check !== undefined ? { check: event.check } : {}),
            ...(event.truncated === true ? { truncated: true } : {}),
          })
        } else if (existing.status === 'fixed') {
          // A re-raise of a finding believed fixed reopens it — the fix did not hold. fixCommit,
          // fixReason, and withdrawnReason no longer describe the reopened finding, so all three are
          // dropped rather than carried forward stale. owner is kept: a finding re-raised on the same
          // file and symbol still belongs to whoever was assigned it, and the lead re-runs finding
          // assign at dispatch regardless. origin is also kept, not overwritten from the re-raise
          // event: it names who first raised this finding, the same "not updated on re-raise"
          // treatment raisedInRound already gets.
          findings.set(event.id, {
            ...omitKeys(existing, [
              'fixCommit',
              'fixReason',
              'withdrawnReason',
              'resurrectedFromWithdrawn',
            ]),
            status: 'open',
          })
        }
        // status 'open': idempotent, no-op. status 'withdrawn': the run layer refuses this before
        // it ever appends, so the fold treats it as a no-op defensively rather than reopening.
        break
      }
      case 'finding-status': {
        const existing = findings.get(event.id)
        if (existing === undefined) break
        // withdrawnReason, fixReason, and fixCommit are all dropped unconditionally, then re-added
        // only if THIS event supplies one — none of the three carries forward from a prior status
        // episode. A fixed->withdrawn transition with no --fix-commit on the withdrawal must not
        // leave the old fix's commit (or reason) attached to a finding that turned out not fixed,
        // and the reverse transition must not leave a stale withdrawal reason on a finding now fixed.
        // The one exception: a withdrawn->fixed flip captures the withdrawal's own reason into
        // resurrectedFromWithdrawn before it is dropped, so the fold still shows a withdrawal
        // happened instead of reading identically to a finding that was never withdrawn at all.
        findings.set(event.id, {
          ...omitKeys(existing, [
            'withdrawnReason',
            'fixReason',
            'fixCommit',
            'resurrectedFromWithdrawn',
          ]),
          status: event.status,
          ...(event.status === 'withdrawn' && event.reason !== undefined
            ? { withdrawnReason: event.reason }
            : {}),
          ...(event.status === 'fixed' && event.reason !== undefined
            ? { fixReason: event.reason }
            : {}),
          ...(event.fixCommit !== undefined ? { fixCommit: event.fixCommit } : {}),
          ...(event.fixCommit !== undefined && !existing.allFixCommits.includes(event.fixCommit)
            ? { allFixCommits: [...existing.allFixCommits, event.fixCommit] }
            : {}),
          ...(existing.status === 'withdrawn' &&
          event.status === 'fixed' &&
          existing.withdrawnReason !== undefined
            ? { resurrectedFromWithdrawn: existing.withdrawnReason }
            : {}),
          ...(event.truncated === true ? { truncated: true } : {}),
        })
        break
      }
      case 'finding-assign': {
        const existing = findings.get(event.id)
        if (existing === undefined) break
        findings.set(event.id, { ...existing, owner: event.owner })
        break
      }
      case 'instruction': {
        const existing = instructions.get(event.id)
        if (existing === undefined) {
          instructions.set(event.id, {
            id: event.id,
            dispatchedInRound: event.round,
            text: event.text,
            disposition: 'pending',
            ...(event.truncated === true ? { truncated: true } : {}),
          })
        } else if (existing.disposition !== 'pending') {
          // Re-recording a disposed instruction re-arms it — the same re-raise semantics as
          // finding-open above. A stale reason (and any supersededReason from an even earlier
          // re-disposition) from the old disposition is dropped with it.
          instructions.set(event.id, {
            ...omitKeys(existing, ['reason', 'supersededReason']),
            disposition: 'pending',
          })
        }
        break
      }
      case 'instruction-disposition': {
        const existing = instructions.get(event.id)
        if (existing === undefined) break
        // reason is dropped unconditionally, then re-added only if THIS event supplies one — the
        // same non-carry-forward rule as finding-status above. A not-acted disposition's reason must
        // not survive onto a later acted disposition that supplies none. The one exception: when
        // this event drops a reason the existing disposition actually carried — whichever
        // disposition that was, since `--reason` is optional even on `acted` — that reason is
        // captured into supersededReason first, so the fold still shows a reason-bearing disposition
        // happened instead of reading identically to one that was never disposed with a reason at
        // all.
        instructions.set(event.id, {
          ...omitKeys(existing, ['reason', 'supersededReason']),
          disposition: event.disposition,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
          ...(existing.reason !== undefined && event.reason === undefined
            ? { supersededReason: existing.reason }
            : {}),
          ...(event.truncated === true ? { truncated: true } : {}),
        })
        break
      }
      case 'note-add': {
        const existing = notes.get(event.id)
        if (existing === undefined) {
          notes.set(event.id, {
            id: event.id,
            raisedInRound: event.round,
            target: event.target,
            text: event.text,
            done: false,
            ...(event.truncated === true ? { truncated: true } : {}),
          })
        } else if (existing.done) {
          notes.set(event.id, { ...existing, done: false })
        }
        break
      }
      case 'note-done': {
        const existing = notes.get(event.id)
        if (existing === undefined) break
        notes.set(event.id, { ...existing, done: true })
        break
      }
    }
  }

  return {
    ticket,
    round,
    findings: [...findings.values()],
    instructions: [...instructions.values()],
    notes: [...notes.values()],
    skippedLines,
    reviewedShas,
    reviewedStances,
    computedStances,
    stanceReasons,
    scopeChanges,
    shaReuseReasons,
    roundAdvanceReasons,
    seniors,
    reviews,
    reviewLifecycle,
    reviewIncompleteReasons,
    resolvedAnchor: resolveAnchor(reviewedStances, reviewedShas),
  }
}

// Drops the given optional keys from a copy of obj. Used instead of a destructure-and-discard so
// the dropped-field names aren't unused local bindings the linter has to be told to ignore.
const omitKeys = <T, K extends keyof T>(obj: T, keys: readonly K[]): T => {
  const copy = { ...obj }
  for (const key of keys) delete copy[key]
  return copy
}

// The highest-numbered round on record with an adversarial stance, or null if there is none.
// Derived from reviewedStances/reviewedShas after the fold completes, rather than tracked as a
// third value set inline as 'round-reviewed' events are seen: a round-reviewed event can be
// re-recorded for a round that already closed (e.g. correcting its reviewed sha) — the CLI only
// ever closes the CURRENT round, so a repeat for an already-closed one only reaches the ledger as a
// direct append, the same way the pre-migration and invalid-stance cases below do. reviewedShas
// stays last-write-wins on such a repeat; reviewedStances does not (see its freeze invariant on
// Ledger, above) — a correction can fix a wrong sha but never retroactively un-review a round under
// a different stance. Making resolvedAnchor a function of the two maps rather than a fourth thing
// kept in sync by hand means it cannot disagree with them: whatever they say, this does too,
// automatically.
const resolveAnchor = (
  reviewedStances: Record<string, ReviewStance>,
  reviewedShas: Record<string, string>
): { round: number; reviewedSha: string } | null => {
  let anchorRound: number | null = null
  for (const key of Object.keys(reviewedStances)) {
    if (reviewedStances[key] !== 'adversarial') continue
    const round = Number(key)
    if (anchorRound === null || round > anchorRound) anchorRound = round
  }
  return anchorRound === null
    ? null
    : { round: anchorRound, reviewedSha: reviewedShas[String(anchorRound)] }
}

export const appendEvent = (ticket: string, event: LedgerEvent): void => {
  appendEvents(ticket, [event])
}

// Append several events in ONE write. Every event is serialized first, so a serialize() throw on any
// of them happens before a single byte is written and the whole group is dropped together.
//
// This is what a caller needs when two events are only meaningful as a pair. closeRound's licensed
// close is the case: a `senior-shutdown` recording the licence, and the `round-reviewed` closing the
// round. Written separately, a throw between them leaves the licence on the log with no close — and
// because the fold reads that lone shutdown as `shutdownAt` non-null, the retry's guard does not
// fire. The guard would disarm itself by half-failing.
//
// The atomicity here is exactly the atomicity a single-event append already has — one appendFileSync
// on an O_APPEND descriptor — and no more. It closes the throw-between-writes window, which is the
// window the pairing needs closed. It does not make the group atomic against a kernel-level partial
// write or a crash mid-syscall, and MAX_LINE_BYTES' own comment above is explicit that no such
// guarantee is claimed for one line either.
export const appendEvents = (ticket: string, events: readonly LedgerEvent[]): void => {
  if (events.length === 0) return
  appendLine(ledgerPath(ticket), events.map(serialize).join('\n'))
}

// Shared by both callers above (readLedger, appendEvents) — neither is its sole caller any
// more, so it sits below both rather than below just one, per this repo's CLAUDE.md top-down
// convention for a helper with more than one caller.
const ledgerPath = (ticket: string): string => storePath(ticketScope(ticket), LEDGER_FILE)

// Serialize, then shrink the free-text fields until the line fits. Truncation is flagged on the
// event itself so a reader can see the text is partial rather than believing it complete.
const serialize = (event: LedgerEvent): string => {
  let candidate = event
  let line = JSON.stringify(candidate)
  while (Buffer.byteLength(line, 'utf-8') > MAX_LINE_BYTES) {
    const shrunk = shrinkFreeText(candidate)
    if (shrunk === null)
      throw new Error(
        `review-ledger: event cannot fit in ${MAX_LINE_BYTES} bytes even with free text removed`
      )
    candidate = { ...shrunk, truncated: true } as LedgerEvent
    line = JSON.stringify(candidate)
  }
  return line
}

// summary/text are required non-blank by parseEvent's own validation, so they floor at 1 char, not
// 0 — shrinking one to blank would make the very next read of this line treat it as corrupt.
// reason/hint/outOfDiff are optional there and floor at 0 — each is explanatory and may be removed
// entirely; the summary is the finding and must never be sacrificed to preserve one of these.
const SHRINK_FLOOR = { summary: 1, text: 1, reason: 0, hint: 0, outOfDiff: 0 } as const

// Halve the longest field still above its floor. Returns null when every shrinkable field has
// reached its floor — which is also what happens when the line is oversized because of a field
// this function does not touch at all (file, symbol — durable identifiers, deliberately excluded
// from truncation): summary/reason/text/hint/outOfDiff all bottom out and this returns null, so
// serialize() reaches its declared "cannot fit" throw instead of looping.
//
// The floor matters for termination, not just correctness: a field already sitting at its floor is
// excluded from "longest" (its length is never > its own floor), so it can never be re-selected and
// returned unchanged — which is what let this loop hang before: a 1-char floor with no exclusion
// meant a field parked at length 1 kept being "shrunk" to length 1 forever, byte-identical, while
// the real oversized field (symbol, never in this list) sat untouched and the line never got
// shorter.
const shrinkFreeText = (event: LedgerEvent): LedgerEvent | null => {
  const fields = ['summary', 'reason', 'text', 'hint', 'outOfDiff'] as const
  let longest: (typeof fields)[number] | null = null
  let longestLength = 0
  for (const field of fields) {
    const value = (event as Record<string, unknown>)[field]
    if (
      typeof value === 'string' &&
      value.length > SHRINK_FLOOR[field] &&
      value.length > longestLength
    ) {
      longest = field
      longestLength = value.length
    }
  }
  if (longest === null) return null
  const value = (event as Record<string, unknown>)[longest] as string
  const floor = SHRINK_FLOOR[longest]
  const newLength = Math.max(floor, Math.floor(value.length / 2))
  return { ...event, [longest]: value.slice(0, newLength) }
}

// Every kind is validated field-by-field against its declared shape — a partial or wrong-typed
// event is rejected outright rather than cast past the type system, which is what let a
// finding-open with no file/symbol/summary fold in, a finding-status with status 'banana' hide a
// real finding from every --status filter, and a round of -5 be accepted, all with skippedLines
// staying 0 throughout.
const parseEvent = (line: string): LedgerEvent | null => {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>
    if (!isNonBlankString(raw.at)) return null
    switch (raw.kind) {
      case 'round':
        // `reason` is optional-or-absent, not required: every close appends one of these without a
        // reason, and so did every writer that predates round-advance. Keys this case does not name
        // are dropped rather than rejected, which is what lets a reader older than `reason` fold a
        // line written by a newer one without raising skippedLines — the version-skew property the
        // round-model design leans on to add this field without adding an event kind.
        return isPositiveInt(raw.round) && isOptionalString(raw.reason)
          ? {
              kind: 'round',
              at: raw.at,
              round: raw.round,
              ...(raw.reason !== undefined ? { reason: raw.reason as string } : {}),
            }
          : null
      case 'round-reviewed':
        // stance didn't exist when this event kind was first shipped, so a line written before
        // then (round 1 on every ledger from that era) has no stance field at all. Backfilling that
        // absent case to 'adversarial' is a deliberate read of what actually happened, not an
        // arbitrary default: every one of those pre-existing rounds was the first full look at its
        // surface, which is what 'adversarial' means. That reasoning covers only "the field never
        // existed" — a line written after stance shipped that carries some other value was written
        // by a writer that knew about the field and got it wrong, so there is no historical fact to
        // backfill from. That case is rejected outright, same as this function rejects a
        // finding-status of 'banana' elsewhere: silently coercing a corrupted or mistyped stance to
        // 'adversarial' would move resolvedAnchor forward on a round that was never actually a
        // full-surface review — the exact false-cleanup this mechanism exists to prevent.
        return isPositiveInt(raw.round) &&
          isNonBlankString(raw.reviewedSha) &&
          isStanceOrAbsent(raw.stance) &&
          isComputedStanceOrAbsent(raw.computedStance) &&
          isOptionalString(raw.stanceReason) &&
          isOptionalString(raw.scopeChange) &&
          isTrueFlagOrAbsent(raw.shaReuseLicensed) &&
          isOptionalString(raw.shaReuseReason) &&
          isTrueFlagOrAbsent(raw.reviewIncompleteLicensed) &&
          isOptionalString(raw.reviewIncompleteReason)
          ? {
              kind: 'round-reviewed',
              at: raw.at,
              round: raw.round,
              reviewedSha: raw.reviewedSha,
              stance: raw.stance ?? 'adversarial',
              ...(raw.computedStance !== undefined
                ? { computedStance: raw.computedStance as ComputedStance }
                : {}),
              ...(raw.stanceReason !== undefined
                ? { stanceReason: raw.stanceReason as string }
                : {}),
              ...(raw.scopeChange !== undefined ? { scopeChange: raw.scopeChange as string } : {}),
              ...(raw.shaReuseLicensed === true ? { shaReuseLicensed: true } : {}),
              ...(raw.shaReuseReason !== undefined
                ? { shaReuseReason: raw.shaReuseReason as string }
                : {}),
              ...(raw.reviewIncompleteLicensed === true ? { reviewIncompleteLicensed: true } : {}),
              ...(raw.reviewIncompleteReason !== undefined
                ? { reviewIncompleteReason: raw.reviewIncompleteReason as string }
                : {}),
            }
          : null
      case 'senior-spawned':
        return isPositiveInt(raw.round) && isNonBlankString(raw.agentId)
          ? { kind: 'senior-spawned', at: raw.at, round: raw.round, agentId: raw.agentId }
          : null
      case 'senior-shutdown':
        return isPositiveInt(raw.round) &&
          isNonBlankString(raw.agentId) &&
          isOptionalString(raw.reason) &&
          isSeniorConditionOrAbsent(raw.condition) &&
          isTrueFlagOrAbsent(raw.truncated)
          ? {
              kind: 'senior-shutdown',
              at: raw.at,
              round: raw.round,
              agentId: raw.agentId,
              ...(raw.reason !== undefined ? { reason: raw.reason as string } : {}),
              ...(raw.condition !== undefined
                ? { condition: raw.condition as SeniorCondition }
                : {}),
              ...(raw.truncated === true ? { truncated: true } : {}),
            }
          : null
      case 'review-start':
        return isPositiveInt(raw.round) && isNonBlankString(raw.sha)
          ? { kind: 'review-start', at: raw.at, round: raw.round, sha: raw.sha }
          : null
      case 'review-complete':
        return isPositiveInt(raw.round) && isNonBlankString(raw.sha) && isReviewVerdict(raw.verdict)
          ? {
              kind: 'review-complete',
              at: raw.at,
              round: raw.round,
              sha: raw.sha,
              verdict: raw.verdict,
            }
          : null
      case 'finding-open':
        return isNonBlankString(raw.id) &&
          isPositiveInt(raw.round) &&
          isNonBlankString(raw.file) &&
          isNonBlankString(raw.symbol) &&
          isNonBlankString(raw.summary) &&
          isOptionalString(raw.hint) &&
          isOriginOrAbsent(raw.origin) &&
          isOptionalString(raw.outOfDiff) &&
          isOptionalString(raw.check) &&
          isTrueFlagOrAbsent(raw.truncated)
          ? {
              kind: 'finding-open',
              at: raw.at,
              id: raw.id,
              round: raw.round,
              file: raw.file,
              symbol: raw.symbol,
              summary: raw.summary,
              ...(raw.hint !== undefined ? { hint: raw.hint as string } : {}),
              ...(raw.origin !== undefined ? { origin: raw.origin as FindingOrigin } : {}),
              ...(raw.outOfDiff !== undefined ? { outOfDiff: raw.outOfDiff as string } : {}),
              ...(raw.check !== undefined ? { check: raw.check as string } : {}),
              ...(raw.truncated === true ? { truncated: true } : {}),
            }
          : null
      case 'finding-status':
        return isNonBlankString(raw.id) &&
          isPositiveInt(raw.round) &&
          (raw.status === 'fixed' || raw.status === 'withdrawn') &&
          isOptionalString(raw.reason) &&
          isShaLikeOrAbsent(raw.fixCommit) &&
          isTrueFlagOrAbsent(raw.truncated)
          ? {
              kind: 'finding-status',
              at: raw.at,
              id: raw.id,
              round: raw.round,
              status: raw.status,
              ...(raw.reason !== undefined ? { reason: raw.reason as string } : {}),
              ...(raw.fixCommit !== undefined ? { fixCommit: raw.fixCommit as string } : {}),
              ...(raw.truncated === true ? { truncated: true } : {}),
            }
          : null
      case 'finding-assign':
        return isNonBlankString(raw.id) && isPositiveInt(raw.round) && isNonBlankString(raw.owner)
          ? { kind: 'finding-assign', at: raw.at, id: raw.id, round: raw.round, owner: raw.owner }
          : null
      case 'instruction':
        return isNonBlankString(raw.id) &&
          isPositiveInt(raw.round) &&
          isNonBlankString(raw.text) &&
          isTrueFlagOrAbsent(raw.truncated)
          ? {
              kind: 'instruction',
              at: raw.at,
              id: raw.id,
              round: raw.round,
              text: raw.text,
              ...(raw.truncated === true ? { truncated: true } : {}),
            }
          : null
      case 'instruction-disposition':
        return isNonBlankString(raw.id) &&
          isPositiveInt(raw.round) &&
          (raw.disposition === 'acted' ||
            raw.disposition === 'not-acted' ||
            raw.disposition === 'not-applicable') &&
          isOptionalString(raw.reason) &&
          isTrueFlagOrAbsent(raw.truncated)
          ? {
              kind: 'instruction-disposition',
              at: raw.at,
              id: raw.id,
              round: raw.round,
              disposition: raw.disposition,
              ...(raw.reason !== undefined ? { reason: raw.reason as string } : {}),
              ...(raw.truncated === true ? { truncated: true } : {}),
            }
          : null
      case 'note-add':
        return isNonBlankString(raw.id) &&
          isPositiveInt(raw.round) &&
          isNoteTarget(raw.target) &&
          isNonBlankString(raw.text) &&
          isTrueFlagOrAbsent(raw.truncated)
          ? {
              kind: 'note-add',
              at: raw.at,
              id: raw.id,
              round: raw.round,
              target: raw.target,
              text: raw.text,
              ...(raw.truncated === true ? { truncated: true } : {}),
            }
          : null
      case 'note-done':
        return isNonBlankString(raw.id) ? { kind: 'note-done', at: raw.at, id: raw.id } : null
      default:
        return null
    }
  } catch {
    return null
  }
}

// Shared by parseEvent above, their sole caller — moved below it per this repo's CLAUDE.md
// top-down convention for a helper and its caller.
const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const isNonBlankString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string'

// The same shape parseShaLike enforces at the CLI layer (7-40 lowercase hex characters), so a
// fixCommit on the ledger can never be the empty string — dischargedPairs matches it against a
// round's commits with sha.startsWith(fixCommit), and every sha startsWith(''), which would silently
// discharge every commit in range.
const isShaLikeOrAbsent = (value: unknown): value is string | undefined =>
  value === undefined || (typeof value === 'string' && /^[0-9a-f]{7,40}$/.test(value))

// Every set-or-absent boolean marker on an event validates through here: `truncated` on the kinds
// that carry it, and `shaReuseLicensed` on round-reviewed. `false` is rejected along with everything
// else that is not `true`, so the field has two states on the wire rather than three and no reader
// has to decide what a written-out `false` was meant to mean.
const isTrueFlagOrAbsent = (value: unknown): value is true | undefined =>
  value === undefined || value === true

const isStanceOrAbsent = (value: unknown): value is ReviewStance | undefined =>
  value === undefined || value === 'adversarial' || value === 'cleanup'

// undefined is a round closed before this field existed, or one whose computation could not run —
// there is no historical fact to backfill from, so unlike stance it does NOT default to
// 'adversarial': a computed stance nobody computed must not read as one that was. Anything present
// but outside the three known values rejects the whole event, the same policy isStanceOrAbsent and
// isOriginOrAbsent apply.
const isComputedStanceOrAbsent = (value: unknown): value is ComputedStance | undefined =>
  value === undefined || value === 'adversarial' || value === 'cleanup' || value === 'undetermined'

// undefined is a pre-migration line (this field didn't exist yet); anything present but not one of
// the five known values is a corrupted or mistyped origin and rejects the whole event, the same
// policy isStanceOrAbsent applies to stance — silently coercing an unrecognized value would fold in
// a finding whose origin reads as legitimate when it isn't.
const isOriginOrAbsent = (value: unknown): value is FindingOrigin | undefined =>
  value === undefined ||
  value === 'senior' ||
  value === 'coderabbit' ||
  value === 'human' ||
  value === 'user' ||
  value === 'team-lead'

const isNoteTarget = (value: unknown): value is NoteTarget =>
  value === 'pr-body' || value === 'jira-description' || value === 'commit-message'

const isReviewVerdict = (value: unknown): value is ReviewVerdict =>
  value === 'approve' || value === 'changes'

// undefined is either a pre-migration line or an ordinary unlicensed shutdown, which are the same
// shape on the wire and are both legitimate. Anything present but not one of the two licences
// rejects the whole event, the same policy isOriginOrAbsent applies: a condition is the durable half
// of a licence, so folding in an unrecognized one would put a licence on the record that names a
// state the check cannot produce.
const isSeniorConditionOrAbsent = (value: unknown): value is SeniorCondition | undefined =>
  value === undefined || value === 'unreachable' || value === 'already-gone'
