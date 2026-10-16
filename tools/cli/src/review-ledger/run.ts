import { execFileSync } from 'node:child_process'
import { setRequestedExitCode } from '../runtime-exit-code.ts'
import { GIT_MAX_BUFFER_BYTES } from '../proof-ledger/git-exec.ts'
import { manifestPath, parseManifest } from '../gate-ledger/manifest.ts'
import {
  appendEvent,
  appendEvents,
  claimRoundAdvance,
  findingId,
  instructionId,
  noteId,
  ledgerFileExists,
  readLedger,
  releaseRoundClaim,
  type ComputedStance,
  type FindingOrigin,
  type Ledger,
  type LedgerEvent,
  type NoteTarget,
  type ReviewStance,
  type ReviewVerdict,
  type SeniorCondition,
} from './ledger.ts'
import {
  classifyPath,
  computeStance,
  disambiguateShas,
  revParseQuiet,
  type StanceFailure,
} from './stance.ts'
import {
  readClassified,
  STORE_UNREADABLE_EXIT,
  StoreUnreadableError,
} from '../workflow-store/store.ts'

// The run layer. Every command prints JSON on stdout — the ledger is read by agents, so
// machine-readable output is the contract. Exit codes use setRequestedExitCode, the same mechanism
// `workflow-state check` uses:
//
//   0 — success. `finding open` on a fresh id, or one already `open`, uses this.
//   4 — `finding open` refused because that finding is already `withdrawn`. The withdrawal reason
//       is printed on stdout as JSON so the caller can act on it without a second read.
//   5 — `finding status` / `instruction dispose` / `finding assign` naming an id the ledger does
//       not contain. A disposition against a nonexistent id is a caller bug, not a no-op; failing
//       loudly is what stops a typo'd id reading as a discharged finding. `note done` naming an id
//       no `note add` ever recorded exits here too.
//   6 — `finding status --status withdrawn`, `instruction dispose` on any disposition other than
//       `acted`, or `round-close`/`next-round` refusing a declared stance — either because it contradicts the
//       computed one, or because computeStance hit a stance failure
//       STANCE_FAILURE_REFUSES_DECLARATION classifies as refusing (the compiler forces every
//       StanceFailure member to be classified there, so that Record is the source of truth this
//       comment does not re-enumerate), where there is no computed stance to contradict at all —
//       each because `--reason` is absent or blank. A withdrawal, non-acted disposition, or
//       unlicensed stance refusal degrades the record to a silent "no": `finding open`'s exit-4
//       refusal on a withdrawn id with no withdrawnReason on record omits the reason key entirely
//       rather than fabricating one, so a reasonless withdrawal still produces a refusal carrying
//       nothing to act on. Failing loudly here is what the ledger exists to guarantee.
//   7 — `finding open` on an id already `fixed`, or `instruction record` on an id already disposed
//       (anything but `pending`), actually re-arms it — status/disposition goes back to open/pending
//       rather than being silently discarded — and this code marks the call as a re-raise rather
//       than a first-time open/record, so the caller can tell the two apart without a second read.
//       `note add` on an id already `done` re-arms it the same way.
//   8 — `round` / `show` / `stance` found no ledger on disk for this ticket. This is the *expected*
//       state at round 1, before anything has written to the ledger; it is a signal, not an error.
//       Later in a ticket's life the same exit means the ledger you expected is missing — most likely
//       a mistyped `--ticket`. The command cannot tell these apart, because on disk they are the same
//       state: the caller distinguishes them by whether it had reason to expect a ledger.
//       `stance` reaches this exit through the same `ledgerFileExists` check `round`/`show` make
//       directly, just routed through `computeStance`'s `no-ledger` code and `EXIT_BY_STANCE_FAILURE`
//       below rather than a literal `setRequestedExitCode(8)`.
//       readLedger bootstraps a fresh ticket silently on read, which every write-path command above
//       needs — but a pure read command has no write to justify that leniency, and a bootstrapped
//       empty ledger is byte-for-byte identical to a genuinely clean one. That is exactly why the
//       two states above can't be split: without this exit, `show --status open` on either one
//       returns zero open findings and reads as a silent, indistinguishable-from-clean all-clear.
//   9 — `round-close` or `next-round` lost the exclusive claim on the round it read — another
//       caller claimed that same round first. Nothing is appended on this path: the caller that lost
//       is not a partial or duplicate closer of the round, it did not close it at all. If the
//       winning caller's appends threw (a disk write error, say), it releases its own claim before
//       rethrowing — see releaseRoundClaim — so a retry after that failure reads the same round
//       again and is free to claim it itself.
//       Recovery past that is the same for both commands: every close advances through the one
//       shared path (see closeRound; `round-close` is a deprecated alias for `next-round`, not a
//       separate non-advancing door), so if the winning caller completed its appends, the round has
//       genuinely advanced — re-running reads the NEW round and races for that one instead.
//       The one case with no automatic recovery is the winning caller being killed outright between
//       claiming and appending: nothing runs to release the claim, the round itself never advances,
//       and every retry re-reads the same stuck round, loses the same claim, and exits 9 again,
//       forever. That residual case requires manually deleting the orphaned
//       `round-<N>.advance-claim` file under the ticket's store dir before either command can
//       proceed.
//  10 — `stance` computed a verdict of `undetermined`: at least one clause of the re-arming
//       predicate could not be decided mechanically. This is a real answer, not an error — it is
//       specifically NOT `cleanup`, and it must not be read as one. The report on stdout names the
//       clause and, for clause (b), the exact new-scope pairs the declaration-diff recipe in
//       skills/code-review/references/checklist.md still has to be run over.
//  11 — `stance` found `resolvedAnchor` null: no round has closed with an adversarial stance yet.
//       This fires at round 1 too when `stance` is called directly with no `--anchor` override —
//       unlike the two closing commands, which never reach this check at round 1 at all (checkDeclaredStance's
//       own `if (round === 1) return {}`), `stance` has no such skip. The checklist calls a null
//       anchor a stop-and-escalate, never a value to default past — most likely a mis-stamped round
//       1, diagnosable from `show`'s reviewedStances.
//  12 — a git precondition failed: an unresolvable repo root; `--sha`, `origin/main`, or a
//       caller-supplied `--anchor` override value that does not itself resolve to an object, or
//       (`--sha`/`--anchor` only — both parse with `parseShaLike`'s 7-40 lowercase hex, same as
//       `--fix-commit`) names more than one object there — disambiguateShas draws that distinction
//       the same way it does for exit 15; a caller-supplied `--anchor` override whose range against
//       the pinned sha is backwards or has diverged from it; `git` failing to enumerate the round
//       range's commits; a `fixCommit` prefix on the ledger matching more than one commit in range;
//       or one of the two denominator guards (COMMIT GAP, CONSTRUCTION GAP). (The ledger's own
//       recorded anchor or prior-round reviewed sha hits the same backwards/diverged/ambiguous checks
//       through a different path and reports stale-recorded-sha at exit 14 instead — see that entry.)
//       Each of these leaves the denominator incomplete, and every clause verdict is computed against
//       that denominator, so a partial answer here is worse than none: the command refuses rather
//       than reporting a verdict it cannot stand behind.
//       `finding open` reaches this same code when it cannot resolve a repo root, or `origin/main` or
//       the diff against it, while checking whether a non-check `--file` lies in that diff. A check
//       file never reaches it: it is classified before any git call (runOpenFindingScoped).
//  13 — `stance` found `previousRoundSha` null at report round 2 or later: the ledger is missing a
//       'round-reviewed' record it should have. checklist.md §Delta-scoped rounds — bounding what
//       you read calls this a stop-and-escalate, never a value to substitute past — the delta-tier
//       counterpart of code 11's stop-and-escalate for `resolvedAnchor`. Fires on the missing record
//       itself, not on whether the ledger also has unparseable lines; when it does, the error text
//       says so, since the null is then ambiguous as well as wrong, but that never gates the refusal.
//  14 — `stance` found a sha the ledger itself recorded — the anchor round's reviewedSha, or an
//       earlier round's own reviewedSha — no longer resolves, now names more than one object (a
//       `--reviewed-sha` override on either closing command can record a short parseShaLike-shaped prefix, and a
//       later commit's own object can come to share it), or resolves but is no longer an ancestor of
//       the pinned sha (forward or backward). This is the ledger's own record disagreeing with the
//       branch it describes, and the cause is not determinable from the two shas alone, so it is a
//       stop-and-escalate: no command re-records a prior round's reviewed sha, so pass `--reason` to
//       the command closing the round (`next-round`, or its deprecated alias `round-close`) to
//       proceed deliberately, or investigate why the ledger and the branch disagree.
//  15 — `finding status --fix-commit` named a value that could not be verified as a commit: it does
//       not resolve to one in the resolved repo root, no repo root could be resolved at all (an
//       unresolvable --repo-root, or a cwd outside any repository), or the value names more than one
//       object there. That third cause is the price of `--fix-commit` accepting a short prefix in the
//       first place: it parses with `parseShaLike` (7-40 lowercase hex), not the `parseFullSha`
//       (exactly 40 hex) that `proof-ledger`'s own `--sha` uses — a full sha is git-unique by
//       construction, but a 7-char prefix can collide with another object in a large enough repo, and
//       git itself has no way to tell "collides with something" apart from "matches nothing" short of
//       asking. Shape alone (parseShaLike's 7-40 lowercase hex) does not prove the sha is real or
//       singular, so all three causes refuse here rather than skipping. This differs from
//       `checkDeclaredStance`'s own null-repoRoot skip for the two closing commands,
//       where an unrun check just means the round-closing contradiction check did not fire this
//       time and can still be re-derived from the ledger at any later round — nothing false is
//       recorded either way. A skipped `--fix-commit` check would instead append a success payload,
//       `{id, status: 'fixed'}`, indistinguishable from a validated one, into this ledger's
//       append-only event log, which has no verb to remove or edit a `fixCommit` once recorded — a
//       fabricated or unverifiable one would be permanent. A checker that cannot run must not wedge
//       the round closed behind it (`checkDeclaredStance`'s case), but neither may it silently pass
//       a value it never actually checked into a record with no way to take it back (this case).
//  16 — `finding open` refused the target. Three causes, each named in the error: `--file` is a
//       check file (`*-proofs.md`, `*-3-impl.md`, `proof-ledger:<id>`, `gate-ledger:<gate>`) and no
//       `--check` names the capture or gate the claim cites; `--check` was given but is neither a
//       12-hex capture id nor a gate declared for the ticket, or was given on a file that is not a
//       check file; or `--file` is neither a check file nor a path in the diff against origin/main
//       (`git diff "$(git merge-base origin/main HEAD)..HEAD" --name-only`). There is no escape
//       hatch: a PR body, Jira description or commit message defect is `note add`, and anything
//       else outside the diff is a process note. `--out-of-diff` was that hatch and was the route
//       for 34 of FLOW-335's 48 findings; it is gone.
//  17 — `round-close` or `next-round` refused to close a round carrying one or more recorded senior
//       spawns with no recorded shutdown, and no `--senior-condition` + `--senior-reason` licensed
//       the exception. Every outstanding agent id is named, not just one — a round can carry more
//       than one senior (a replacement spawned after the first was left without a shutdown), and a
//       licensed close discharges all of them at once. This is the refusal FLOW-323 exists to add:
//       before it, skipping the senior teardown changed no state any check could read, so the
//       omission was invisible. A round with no senior entries at all is NOT refused — a ledger
//       written before this ticket has no senior events, and an absent record is an absence of
//       knowledge rather than evidence of a leak.
//  18 — `senior shutdown` refused because the `--agent-id` given matches none of the round's
//       recorded spawns from `senior spawned` — but only once spawns exist to compare against. The
//       recorded and given ids are both printed so the caller can see which is stale without a
//       second read. Accepting an unmatched id would discharge the round's teardown obligation
//       against an agent that was never torn down, which is the one outcome the record exists to
//       make impossible; a shutdown for a round with no spawn on record at all is a different case
//       and is accepted, since the spawn event may simply have been lost.
//  19 — `round-close` or `next-round` refused because the round it read is already closed: a
//       `round-reviewed` event for it is already on the log. Before the round-model redesign's
//       close-always-advances change, `round-close` and `next-round` were alternatives, not a
//       sequence — the first closed without advancing, the second closed and advanced — and this exit
//       caught one specific ordering of running both: `next-round` then `round-close`, because
//       `round-close` left the counter on the round it had just closed. `round-close` is now a
//       deprecated alias for `next-round` (see runCloseRound): both go through the one shared
//       closeRound, and both advance in the same append that records the close. Under normal use this
//       narrows 19 to its true meaning — a genuine double-close of the SAME round — and that ordering
//       moves to exit 20 instead: the second closer now lands on the fresh, unreviewed round the first
//       one just opened, not on the round it re-closed. What keeps 19 reachable at all is a ledger
//       WEDGED before this change shipped — closed under the old non-advancing `round-close`, where
//       `ledger.round` still points at an already-`reviewedShas`-stamped round (see exit 24's own
//       comment for the same wedge from the spawn side). Closing such a ledger reads that stuck round
//       and finds it already closed: a genuine double-close, just one whose first half predates this
//       code. It is separate from exit 9 because the two states are opposite: 9 says another live
//       caller holds the round and this one appended nothing, which invites waiting or retrying; 19
//       says the round is finished and a retry can only duplicate it. Before this exit existed, the
//       second call fell through to the claim, hit the claim the old non-advancing `round-close`
//       deliberately never released, and reported 9 — sending the caller to hunt a concurrent process
//       that does not exist while the ticket sat wedged.
//  20 — `round-close` or `next-round` refused because the round it read carries no review mark —
//       condition unchanged by close-always-advances, population grown. Before that change this exit
//       caught only ONE ordering of running both commands back to back — `round-close` then
//       `next-round` — because the other ordering (`next-round` then `round-close`) landed on a round
//       `round-close` believed was still open but `reviewedShas` already covered, which is what exit
//       19 used to catch instead. Now that both commands close and advance identically, EITHER
//       ordering of a repeat close lands on the same place: the fresh, unreviewed round the first
//       call just opened. The 19/20 split by ordering disappears; 19 is ordering-independent (see its
//       own comment) and 20 absorbs both orderings of "closed it again too soon." The log is
//       append-only and no verb removes a `round-reviewed`, so a false one this check refuses is
//       permanent whichever command would have appended it.
//  21 — `round-close` or `next-round` refused to stamp the round with a sha some EARLIER round
//       already recorded, and no `--sha-reuse-reason` licensed it. A round follows fixes and fixes
//       are commits, so a repeated sha is either a close aimed at the wrong round — a re-run of a
//       command still in the scrollback, after a prior close advanced past the round it names and
//       something has since marked the round it now lands on — or a genuine re-review of a sha that
//       did not move, which --sha-reuse-reason licenses. This check cannot tell them apart, which is
//       why the licence is a flag and not a heuristic. checkShaReuse itself is indifferent to the
//       marks, unlike checkRoundReviewed, and that is what lets this exit reach the case 20 cannot:
//       a round carrying a review mark satisfies checkRoundReviewed, so 20 passes it through
//       and this check is the only one left to catch a stale sha. The EXIT is not indifferent,
//       though — a repeat close typed straight after the first lands on the round that close just
//       minted, which carries no mark, so 20 refuses it before this check ever runs. It applies
//       under either command name for the same reason 19 and 20 now do — `round-close` is a
//       deprecated alias for `next-round`, not a separate door with separate coverage.
//
// What 20 and 21 cover between them, in the three parts they actually divide into — none of them
// unconditional, because the coverage is not:
//   - 20 fires on a round with no review mark, on either door.
//   - 21 fires on a close at a sha some earlier round already recorded, on both doors, once the
//     round carries a mark. checkShaReuse ignores the marks; the exit does not, because 20 refuses
//     an unmarked round before this check runs.
//   - Neither fires on a genuinely reviewed round closed at a genuinely new but WRONG sha. On a
//     ledger whose senior recorded its review, `reviews["<n>"].sha` in `review-ledger show` is the
//     sha to compare against — but nothing compares it automatically, so the round closes, the stamp
//     is wrong, and it is corrected by reading `review-ledger show` against the commits the round
//     actually reviewed. Named here rather than left implied, because the reader's default
//     assumption on meeting two guards is that they compose to something total.
// See checkShaReuse for why 21's comparison is exact rather than git-normalized.
//
//  22 — a `senior` or `review` command refused the `--round` it was given. One exit code for one family — a
//       `--round` the ledger cannot honour — but the two commands demand different things of it,
//       because a spawn and a shutdown are wrong in different directions:
//         `senior spawned` demands EQUALITY: `--round` must match `ledger.round` exactly. This
//         record is the only thing that arms the exit-17 guard, so a mistyped round would otherwise
//         land the spawn on a round nobody is closing and disarm the guard silently, with no other
//         state anywhere to catch the mismatch.
//         `senior shutdown` demands only NOT-AHEAD-OF: `--round` must not exceed `ledger.round`.
//         Equality would be wrong here — a teardown can legitimately be reported late, against a
//         round that has already closed, and refusing that would lose the record of a real shutdown.
//         A round the ledger has not reached yet is the case with no innocent reading: no senior can
//         have been spawned for it, so the round's senior list is necessarily empty, and without this
//         check the shutdown takes exit 18's no-spawns-on-record carve-out and folds into a `seniors`
//         entry carrying a shutdownAt. That entry satisfies checkRoundReviewed while never looking
//         outstanding, so the round later closes as reviewed with neither exit 20 nor exit 17 firing.
//         `review start` and `review complete` demand EQUALITY, as `senior spawned` does.
//         The check therefore runs BEFORE the recorded-seniors lookup, not after it.
//  23 — `senior spawned` refused because the round it names already has a spawn on record for that
//       SAME agent id (see Ledger.seniors). It names no new senior, and appending it would only
//       duplicate the entry the fold already holds. A spawn of a DIFFERENT agent id for a round that
//       already has one on record is NOT this case — it is a replacement senior, and is accepted,
//       adding its own entry.
//  24 — `senior spawned` refused because the round it names already has a `reviewedShas` entry.
//       Since the round-model redesign's close-always-advances change, a round closed through either
//       command name advances `ledger.round` in the same append that records it, so exit 22's
//       round-match check alone now catches a spawn aimed at a round closed AFTER that change
//       shipped — the counter has already moved off it. This exit stays reachable for a round closed
//       BEFORE that change, under the old `round-close` that closed without advancing: its
//       `reviewedShas` entry exists but `ledger.round` still points at it, so `--round` matching
//       `ledger.round` passes exit 22's check even though the round is closed. FLOW-323's own ledger
//       is in exactly that state. Such ledgers are unwedged one at a time by `round-advance` (see
//       exit 25); until a given ledger is unwedged, exit 22 does not protect it and this exit is
//       the only thing that does. Unrefused, the spawn would record an outstanding senior nothing
//       can ever discharge. This exit's reachable population shrinks monotonically and is terminal:
//       each ledger `round-advance` unwedges moves its counter off the closed round, after which
//       exit 22 covers that ledger and this exit becomes unreachable for it too. It must not be
//       deleted now, on the reasoning that the post-change code path never reaches it — and must
//       not be treated as permanently load-bearing either, once every ledger predating this change
//       has been unwedged.
//  25 — `round-advance` refused: the current round is not already closed, so there is nothing to
//       unwedge. NOT "no recorded review" (that is exit 20's condition, checked on close, not on
//       advance): a round can be reviewed but not yet closed, and refusing `round-advance` on
//       missing review rather than on missing closure would let a caller skip the close entirely and
//       bypass exits 17, 20, 21 and the stance check in one command. This is `round-advance`'s only
//       exit code — it is also what makes a second call safe, since the round it advances to is by
//       construction unclosed.
//  26 — reachable from every command above: readLedger throws StoreUnreadableError when the ledger
//       exists and cannot be read, and `check`'s declaredGateNames throws the same for a gate
//       manifest that exists and cannot be read — so this code, like gate-ledger's own 26, does not
//       say WHICH file was unreadable; the error message names the path. runGuarded maps the throw
//       here (STORE_UNREADABLE_EXIT, shared across all three ledgers — see workflow-store/store.ts)
//       and writes `{error, code}` as JSON on stdout, the same contract as gate-ledger and
//       proof-ledger.
//  27 — `round-close` or `next-round` refused a round whose review its senior has not recorded
//       complete, on a ledger where any round has a `review start` (Ledger.reviewLifecycle).
//       Licensed by --senior-condition with --senior-reason, the pair exit 17 takes, and recorded
//       on the round's close.
//  28 — `review start` refused a round whose review is already complete, which means that round
//       was reviewed and never closed; or `review complete` refused a round with no start on
//       record, or one already complete.
//  29 — any other unexpected throw (a disk I/O or permissions failure, say), caught by runGuarded
//       and reported as JSON `{error}` on stdout. Not 9, which this module already uses for a lost
//       advance claim.
//
// 252 is Stricli's own parse-failure code, not set by this module — thrown from the CLI parsing
// layer before any of the run* functions below are reached (e.g. `--reviewed-sha` failing
// parseShaLike's shape check). It is documented here only so a caller reading this file for "what
// can this command exit with" finds the answer in one place.

// Every review-ledger command's body runs inside this (commands/review-ledger.ts wraps each
// `func`), so an unexpected throw — a disk I/O failure, say — lands as JSON on stdout plus a
// documented exit, not a raw stack trace from Stricli. Same guarantee gate-ledger/run.ts and
// proof-ledger/run.ts give; the generic code is 29, not their 9, because 9 already means a lost
// advance claim here.
export const runGuarded = (fn: () => void): void => {
  try {
    fn()
  } catch (err) {
    if (err instanceof StoreUnreadableError) {
      writeJson({ error: err.message, code: err.code })
      setRequestedExitCode(STORE_UNREADABLE_EXIT)
      return
    }
    writeJson({ error: err instanceof Error ? err.message : String(err) })
    setRequestedExitCode(29)
  }
}

export const runShowRound = (ticket: string): void => {
  if (!ledgerFileExists(ticket)) {
    writeJson({ error: `no ledger on disk for ticket ${ticket}` })
    setRequestedExitCode(8)
    return
  }
  const ledger = readLedger(ticket)
  writeJson({ ticket: ledger.ticket, round: ledger.round })
}

// Prints the stance the re-arming predicate computes for `--sha`, as JSON. This is the command the
// senior runs instead of hand-executing the recipe in skills/code-review/references/checklist.md —
// the reason the stance was never actually evaluated is that deciding to do the cheap round cost
// more than doing the expensive one, and a command is what removes that asymmetry.
export const runStance = (ticket: string, sha: string, repo?: string, anchor?: string): void => {
  const repoRoot = resolveRepoRoot(repo)
  if (repoRoot === null) {
    writeJson({
      error: `cannot resolve a git repo root from ${repo ?? process.cwd()}`,
    })
    setRequestedExitCode(12)
    return
  }
  const outcome = computeStance(ticket, sha, repoRoot, anchor)
  if (!outcome.ok) {
    writeJson({
      error: outcome.error,
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
    })
    setRequestedExitCode(EXIT_BY_STANCE_FAILURE[outcome.code])
    return
  }
  writeJson(outcome.report)
  // An undetermined verdict exits non-zero so a caller that reads only the exit status cannot mistake
  // it for a computed `cleanup`. Nothing about the report is withheld — it is printed in full first.
  if (outcome.report.stance === 'undetermined') setRequestedExitCode(10)
}

const EXIT_BY_STANCE_FAILURE: Record<StanceFailure, number> = {
  'no-ledger': 8,
  'missing-round-record': 13,
  'null-anchor': 11,
  'git-precondition': 12,
  'stale-recorded-sha': 14,
}

// An explicit --repo-root wins; otherwise the repo containing the caller's cwd. Returns null rather than
// throwing so each caller decides for itself what a null root means, rather than all sharing one
// stack trace: `runStance` and `runSetFindingStatus`'s --fix-commit check both refuse on it — a git
// precondition, and a value about to be written into an append-only ledger, are each something a
// null root cannot be waved through on. `closeRound`'s stance check (`checkDeclaredStance`), shared
// by `runCloseRound` and `runNextRound`,
// instead treats it as an unrun check and skips, since a re-arming predicate that never ran this
// round can still be re-derived from the ledger at any later one — nothing false is recorded either
// way.
const resolveRepoRoot = (repo?: string): string | null => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repo ?? process.cwd(),
      stdio: 'pipe',
      maxBuffer: GIT_MAX_BUFFER_BYTES,
    })
      .toString()
      .trim()
  } catch {
    return null
  }
}

// The diff's changed paths against origin/main, or null if any git step failed — same null-on-
// failure contract as resolveRepoRoot, for the same reason: runOpenFindingScoped decides what a
// failure means (refuse at exit 12) rather than this helper throwing one shared stack trace.
const diffFilesAgainstOriginMain = (repoRoot: string): string[] | null => {
  try {
    const mergeBase = execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], {
      cwd: repoRoot,
      stdio: 'pipe',
      maxBuffer: GIT_MAX_BUFFER_BYTES,
    })
      .toString()
      .trim()
    return execFileSync('git', ['diff', `${mergeBase}..HEAD`, '--name-only', '-z'], {
      cwd: repoRoot,
      stdio: 'pipe',
      maxBuffer: GIT_MAX_BUFFER_BYTES,
    })
      .toString()
      .split('\0')
      .filter((line) => line.length > 0)
  } catch {
    return null
  }
}

// `--reviewed-sha` stamps the CURRENT round (the one being closed) with the sha the senior
// reviewed, before the round counter advances — see the 'round-reviewed' LedgerEvent comment in
// ledger.ts for why it's keyed to the closing round rather than the round that follows. `--stance`
// stamps the same event with what kind of review that sha got — see the ReviewStance comment in
// ledger.ts. Both required: a round is a review round by definition, and an optional flag moves the
// state this mechanism exists to capture out of the store and into "whether the caller remembered" —
// with no back-fill once the round has advanced. The CLI parser (parseNonBlankString /
// buildCommand's --stance validator) guarantees non-blank, valid values reach this function, so
// there is no emptiness or invalid-value branch here.
//
// The declared stance is now checked against the computed one before the round closes. A
// contradiction is refused unless `--reason` licenses it, and the reason is recorded on the event
// permanently. Before this check, `--stance adversarial` was accepted unconditionally and was never
// wrong in a direction anything could observe, while `cleanup` had to be earned by hand-executing a
// multi-page recipe — so every round was declared adversarial and the convergence mechanism the
// stance exists to drive never fired. The refusal is what makes the two declarations cost the same.
// The round-end call, and every close's only door. Before the round-model redesign's
// close-always-advances change, this command closed a round AND advanced the counter, while
// `round-close` was the separate command that closed WITHOUT advancing — used on the
// approved/terminal path where the re-arming `next-round` deliberately never runs (FLOW-323's
// original root cause, half B). Closing without advancing turned out to be the wrong split — see
// closeRound below — so every close now advances through this one function, and `round-close` is a
// deprecated alias for it (see runCloseRound).
export const runNextRound = (
  ticket: string,
  reviewedSha: string,
  stance: ReviewStance,
  reason?: string,
  repo?: string,
  seniorCondition?: SeniorCondition,
  seniorReason?: string,
  shaReuseReason?: string,
  scopeChange?: string
): void => {
  const outcome = closeRound(
    ticket,
    reviewedSha,
    stance,
    reason,
    repo,
    seniorCondition,
    seniorReason,
    shaReuseReason,
    scopeChange
  )
  if (!outcome.closed) return
  writeJson({
    ticket,
    round: outcome.round,
    computedStance: outcome.computed,
    ...(outcome.stanceOverridden ? { stanceOverridden: true } : {}),
  })
}

// Deprecated alias, not a separate command. `round-close` used to close a round without advancing
// the counter, a distinct behaviour from `next-round`'s close-and-advance — see runNextRound's
// comment above for why that split ended. Every close now advances through the one shared
// closeRound, so the two names now do the same thing byte-for-byte; `round-close` stays registered
// only so existing callers (shipped skill text and scripts) keep working. New callers use
// `next-round`.
export const runCloseRound = runNextRound

// A refusal returns `closed: false` having already written its own JSON and set its exit code, so
// the caller bails on one check instead of restating each refusal shape. The success arm carries the
// round the close just advanced TO (not the round it closed) and the stance verdict, because the
// caller's own output line is built from them — re-deriving either would mean a second
// checkDeclaredStance, which shells out to git again and can answer differently than the call that
// actually gated the close.
type CloseOutcome =
  | { closed: false }
  | { closed: true; round: number; computed: ComputedStance | undefined; stanceOverridden: boolean }

const closeRound = (
  ticket: string,
  reviewedSha: string,
  stance: ReviewStance,
  reason?: string,
  repo?: string,
  seniorCondition?: SeniorCondition,
  seniorReason?: string,
  shaReuseReason?: string,
  scopeChange?: string
): CloseOutcome => {
  const ledger = readLedger(ticket)
  // Before anything else, and on both doors. A round already carrying a 'round-reviewed' event is
  // finished; every later check answers a question about closing a round that no longer needs
  // closing, and the stance check in particular would refuse first with exit 6 — a second wrong
  // diagnosis stacked on this one.
  const alreadyClosed = ledger.reviewedShas[String(ledger.round)]
  if (alreadyClosed !== undefined) {
    writeJson({
      error: `round ${ledger.round} is already closed`,
      round: ledger.round,
      reviewedSha: alreadyClosed,
      remedy:
        'this round is already closed. A retry after a close whose success you did not see does NOT land here — every close advances, so the retry meets the fresh round that close opened and is refused there instead. Reaching this means the counter still points at a round that is already stamped, which is a ledger wedged by a close made before closes advanced. `review-ledger round-advance --ticket <TICKET-ID> --reason <why the counter is moving without a close>` appends the one missing advance and repairs nothing else; run `review-ledger show` first to confirm that is the state you are in. `round-close` is a deprecated alias for `next-round`; neither runs twice against the same round.',
    })
    setRequestedExitCode(19)
    return { closed: false }
  }
  // After 19, before the stance check — same ordering argument as 19's own: an unreviewed round has
  // no review for a stance to describe, and letting checkDeclaredStance answer first would report a
  // stance disagreement for a round that should never have been closed at all. A round that is both
  // already closed and unreviewed reports 19, because "it is closed, stop" is the actionable half.
  // Under either command name: a 'round-reviewed' event this check would have refused is permanent
  // once appended, and both names close and advance through the same path — closing a round with no
  // trace of review is the identical false record regardless of which name was used to reach it.
  const unreviewed = checkRoundReviewed(ledger, ledger.round)
  if (unreviewed !== undefined) {
    writeJson({
      error: unreviewed,
      round: ledger.round,
      remedy:
        'this round carries no review mark. If a prior close has already advanced past the round you meant to close, that round is closed — check `review-ledger show`. If this round genuinely was reviewed, record its senior teardown with `review-ledger senior shutdown --ticket <TICKET-ID> --round N --agent-id X`. That clears this refusal; it clears the exit-17 one only when it is the last senior on the round still outstanding, so run one call per outstanding agent id, not one per round. `senior spawned` clears this refusal too, and leaves that senior owing a teardown; the close then meets the remaining guards in order, and which of them answers depends on the sha it passes, whether its senior recorded the review complete, and the stance it computes.',
    })
    setRequestedExitCode(20)
    return { closed: false }
  }
  // After 20, before the stance check, and on BOTH doors. Ordered here for the reason 19 and 20 were:
  // a round being stamped with a sha an earlier round already carries is a question about whether
  // this close should happen at all, and letting checkDeclaredStance answer first reports a stance
  // disagreement about a close that was already wrong. Ordered after 20 because "this round was
  // never reviewed" is the more specific diagnosis when both fire.
  const shaReuse = checkShaReuse(ledger, ledger.round, reviewedSha)
  const shaReuseLicensed = shaReuseReason !== undefined && shaReuseReason.trim().length > 0
  if (shaReuse !== undefined && !shaReuseLicensed) {
    writeJson({
      error: shaReuse.refusal,
      round: ledger.round,
      reviewedSha,
      priorRound: shaReuse.priorRound,
      remedy:
        "this sha is already recorded as an earlier round's reviewed sha, and a round follows fixes, so the sha normally moves between rounds. Two things produce that and this guard cannot tell them apart. Either the close is aimed at the wrong round — check `review-ledger show` against the round you meant — or the sha genuinely did not move, because the previous round's findings were all ruled invalid and the same commit is being re-reviewed. The second is legitimate: pass --sha-reuse-reason to record it.",
    })
    setRequestedExitCode(21)
    return { closed: false }
  }
  // After 21, before the stance check, on both doors. On a ledger whose seniors record their own
  // reviews, a round closes only once its review is recorded complete, because until then its
  // finding set may be partial. A senior gone before recording it is licensed by the pair exit 17
  // takes. A ledger with no review events never arms this.
  const seniorLicensed =
    seniorCondition !== undefined && seniorReason !== undefined && seniorReason.trim().length > 0
  const review = ledger.reviews[String(ledger.round)]
  const reviewIncomplete = ledger.reviewLifecycle && review?.state !== 'complete'
  if (reviewIncomplete && !seniorLicensed) {
    writeJson({
      error: `round ${ledger.round}'s review is not recorded complete`,
      round: ledger.round,
      review: review ?? null,
      agentIds: (ledger.seniors[String(ledger.round)] ?? []).map((s) => s.agentId),
      remedy:
        "wait for the round's senior to run `review-ledger review complete`; until it does, its findings may not all be on the ledger. If the senior is gone, pass --senior-condition and --senior-reason to close without it.",
    })
    setRequestedExitCode(27)
    return { closed: false }
  }
  const check = checkDeclaredStance(ticket, ledger.round, reviewedSha, stance, repo, scopeChange)
  const licensed =
    check.refusal !== undefined
      ? check.licensedBy === 'scope-change'
        ? scopeChange !== undefined && scopeChange.trim().length > 0
        : reason !== undefined && reason.trim().length > 0
      : false
  if (check.refusal !== undefined && !licensed) {
    writeJson({
      error: check.refusal,
      declaredStance: stance,
      computedStance: check.computed,
      ...(check.detail !== undefined ? { detail: check.detail } : {}),
    })
    setRequestedExitCode(6)
    return { closed: false }
  }
  const seniorCheck = checkSeniorAccounted(ledger, ledger.round)
  if (seniorCheck.refusal !== undefined && !seniorLicensed) {
    writeJson({
      error: seniorCheck.refusal,
      round: ledger.round,
      agentIds: seniorCheck.agentIds,
      remedy:
        'shut down every outstanding senior named in agentIds and record each with `review-ledger senior shutdown`, or pass --senior-condition and --senior-reason once to close over all of them deliberately',
    })
    setRequestedExitCode(17)
    return { closed: false }
  }
  // The read above and the appends below are two separate steps with nothing held across the gap
  // by themselves — two concurrent callers can both read round N here. claimRoundAdvance closes
  // that gap: only the first caller to claim round N proceeds to close it; every other caller
  // refuses cleanly, appending nothing, rather than both writing a 'round-reviewed' for N and both
  // advancing to N+1.
  if (!claimRoundAdvance(ticket, ledger.round)) {
    writeJson({ error: `round ${ledger.round} is already being advanced by another caller` })
    setRequestedExitCode(9)
    return { closed: false }
  }
  // Not a bare finally: a claim that actually closes the round (the appends below succeed) must
  // stay held forever, per claimRoundAdvance's own contract — releasing it here on the success path
  // too would let the same round be claimed and closed a second time. Only the failure path has
  // anything to undo, since it never finished closing anything.
  try {
    // One append, not two. The licence and the close are only meaningful together: written
    // separately, a throw after the first leaves a senior-shutdown on the log with no round closed,
    // the fold reads its shutdownAt as non-null, and the retry's guard no longer fires — the guard
    // disarming itself by half-failing. See appendEvents for what that buys and what it does not.
    //
    // A licensed close records the exception as a fact on the log rather than leaving it in an argv
    // the shell forgets. Recorded only on an actual override, mirroring stanceReason below: flags
    // passed on a round whose senior was already accounted for describe nothing.
    //
    // Both halves of the licence, not just the reason. The condition is the half that survives
    // serialize()'s free-text shrink, so recording the reason alone leaves a licensed close that can
    // reach a reader as an ordinary one.
    //
    // One event per outstanding senior, not one for the round: a round can carry more than one
    // (a replacement senior spawned after the first was left without a shutdown), and a licensed
    // close discharges the obligation for all of them, not just whichever one the check happened to
    // name first. They share one reason and one condition — the licence describes the situation the
    // close was made under, not any one agent.
    const licenceEvent: LedgerEvent[] =
      seniorCheck.refusal !== undefined && seniorCheck.agentIds !== undefined
        ? seniorCheck.agentIds.map((agentId) => ({
            kind: 'senior-shutdown' as const,
            at: nowIso(),
            round: ledger.round,
            agentId,
            reason: seniorReason,
            ...(seniorCondition !== undefined ? { condition: seniorCondition } : {}),
          }))
        : []
    appendEvents(ticket, [
      ...licenceEvent,
      {
        kind: 'round-reviewed',
        at: nowIso(),
        round: ledger.round,
        reviewedSha,
        stance,
        computedStance: check.computed,
        // Recorded only on an actual override or a licensed predicate failure — a reason passed on
        // a round nothing contradicted describes nothing, and storing it would make every later
        // reader hunt for a disagreement that never happened. The check is licensedBy: a refusal
        // licensed by scope-change records scopeChange, not stanceReason.
        ...(check.refusal !== undefined &&
        licensed &&
        check.licensedBy !== 'scope-change' &&
        reason !== undefined &&
        reason.trim().length > 0
          ? { stanceReason: reason }
          : {}),
        // Same rule for scope-change: recorded when it licensed an adversarial-against-cleanup
        // override. A licensed override has no refusal, so we check overridden directly.
        ...(check.overridden === true &&
        check.licensedBy === 'scope-change' &&
        scopeChange !== undefined &&
        scopeChange.trim().length > 0
          ? { scopeChange }
          : {}),
        // Same rule, and the marker rides with the reason rather than being inferred from it: a
        // reader asking whether this close was licensed reads one fixed field instead of testing
        // free text for emptiness.
        ...(shaReuse !== undefined && shaReuseLicensed
          ? { shaReuseLicensed: true as const, shaReuseReason }
          : {}),
        ...(reviewIncomplete
          ? { reviewIncompleteLicensed: true as const, reviewIncompleteReason: seniorReason }
          : {}),
      },
      // Every close advances, in the same append that records the close — not a second append made
      // later by whichever caller happens to want advancing. Before the round-model redesign's
      // close-always-advances change, this event was appended separately by `next-round` alone,
      // after `closeRound` returned; `round-close` never appended it, which is the behaviour that
      // made the two commands different. One append means one point of failure to release the claim
      // from (the catch below), rather than two — see runNextRound's comment for why the second
      // try/catch this used to need is gone.
      { kind: 'round', at: nowIso(), round: ledger.round + 1 },
    ])
  } catch (err) {
    releaseRoundClaim(ticket, ledger.round)
    throw err
  }
  return {
    closed: true,
    round: ledger.round + 1,
    computed: check.computed,
    stanceOverridden: check.refusal !== undefined && licensed,
  }
}

// Moves a wedged ledger's counter forward without closing anything. A ledger closed before the
// round-model redesign's close-always-advances change carries a reviewedShas entry for a round the
// counter is still sitting on: the closer refuses that round at exit 19, and until this function
// existed closeRound above was the only appender of a 'round' event, so nothing could move it. The
// wedge is precisely one missing event, and this is the supported form of appending it.
//
// No claim is taken. closeRound holds claimRoundAdvance because it writes a close and an advance
// that must not both happen twice; this writes one 'round' event and closes nothing, and the fold's
// last-write-wins on round makes two concurrent calls a no-op collision rather than a corruption.
// Advance against a concurrent close is safer still and for a stronger reason than last-write-wins:
// a wedged round is exactly the state closeRound refuses first, at exit 19, so the close is gone
// before it reaches anything this appends. Nobody should add a lock here.
//
// It repairs the counter and nothing else. Senior obligations outstanding on the wedged round are
// left alone, and no later close revisits them — checkSeniorAccounted runs only for the round being
// closed, so N's outstanding seniors are beyond exit 17 from the moment N closed, not from this
// advance. While the round is still wedged, exit 24 refuses new spawns onto it; once this command
// runs, the counter moves off it and exit 22 takes over. See exit 24's header for that handoff.
export const runRoundAdvance = (ticket: string, reason: string): void => {
  const ledger = readLedger(ticket)
  // Closure is the precondition, not review — see exit 25's header comment for what accepting on a
  // reviewed-but-unclosed round would let a caller bypass.
  if (ledger.reviewedShas[String(ledger.round)] === undefined) {
    writeJson({
      error: `round ${ledger.round} is not closed — there is nothing to advance past`,
      round: ledger.round,
      remedy:
        'close the round with `review-ledger next-round`, which advances the counter on its own',
    })
    setRequestedExitCode(25)
    return
  }
  appendEvent(ticket, { kind: 'round', at: nowIso(), round: ledger.round + 1, reason })
  // The reason is deliberately not echoed back. serialize() may shrink it on the way to disk, so
  // echoing the argv value would report a reason the ledger does not hold — see
  // Ledger.roundAdvanceReasons for why that shrink leaves no trace to reconcile against.
  writeJson({ ticket, round: ledger.round + 1, advancedFrom: ledger.round })
}

export const runRecordSeniorSpawned = (ticket: string, round: number, agentId: string): void => {
  const ledger = readLedger(ticket)
  // This record is the ONLY thing that arms the exit-17 guard, so a mistyped --round cannot be left
  // to disarm it silently: unrefused, the spawn would land on a round nobody is closing, the round
  // actually being closed would find no entry, take the deliberate no-entry-is-not-a-refusal path,
  // and exit 0 printing a line byte-identical to an accounted close — nothing else in the system can
  // tell those two apart.
  if (round !== ledger.round) {
    writeJson({
      error: `--round ${round} does not match the ledger's current round ${ledger.round}`,
      round,
      ledgerRound: ledger.round,
    })
    setRequestedExitCode(22)
    return
  }
  // A round closed before the round-model redesign's close-always-advances change, under the old
  // non-advancing `round-close`, still has `ledger.round` pointing at it — so a spawn can pass the
  // check above (--round matches ledger.round) against a round that is in fact already closed. See
  // exit 24's header comment for the full wedged-ledger case. Left unrefused, that spawn records an
  // outstanding senior nothing can ever discharge: exit 19 refuses every further close on this round,
  // and exit 17 is only evaluated on the close path.
  if (ledger.reviewedShas[String(round)] !== undefined) {
    writeJson({
      error: `round ${round} is already closed — no further senior may be spawned for it`,
      round,
      reviewedSha: ledger.reviewedShas[String(round)],
      remedy:
        'this round is closed and the counter never moved off it, which is a ledger wedged by a close made before closes advanced — the same state that refuses a close at exit 19. `review-ledger round-advance --ticket <TICKET-ID> --reason <why the counter is moving without a close>` appends the one missing advance and repairs nothing else; run `review-ledger show` first to confirm that is the state you are in. Once the counter has moved, spawn the senior against the round it moved to.',
    })
    setRequestedExitCode(24)
    return
  }
  const seniorsForRound = ledger.seniors[String(round)] ?? []
  const existing = seniorsForRound.find((s) => s.agentId === agentId)
  // A second spawn of the SAME agentId for a round that already has it on record is refused rather
  // than appended: it names no new senior, and appending it would only duplicate the entry the fold
  // already holds. A spawn of a DIFFERENT agentId is a replacement senior — the round's first left
  // without a shutdown, a second spawned in its place — and is accepted, adding its own entry.
  if (existing !== undefined) {
    writeJson({
      error: `round ${round} already has agent id ${agentId} recorded as a senior — spawn a different agent id to record a replacement`,
      round,
      recordedAgentIds: seniorsForRound.map((s) => s.agentId),
      givenAgentId: agentId,
    })
    setRequestedExitCode(23)
    return
  }
  appendEvent(ticket, { kind: 'senior-spawned', at: nowIso(), round, agentId })
  writeJson({ ticket, round, ledgerRound: ledger.round, agentId, recorded: 'spawned' })
}

export const runRecordSeniorShutdown = (
  ticket: string,
  round: number,
  agentId: string,
  reason?: string
): void => {
  const ledger = readLedger(ticket)

  // A shutdown against a round the ledger has not reached yet, refused before the lookup below can
  // read that round's (necessarily empty) senior list and wave it through the no-spawns carve-out.
  // Unrefused, such a shutdown folds into a `seniors` entry carrying a shutdownAt, which satisfies
  // checkRoundReviewed without ever looking outstanding — so the round later closes as reviewed with
  // neither exit 20 nor exit 17 firing. The predicate is `>` and not `!==` because a shutdown
  // recorded against an ALREADY-CLOSED earlier round is legitimate: a teardown can be reported late,
  // after its round has closed, and refusing it would lose the record of a real shutdown.
  if (round > ledger.round) {
    writeJson({
      error: `round ${round} is ahead of the ledger's current round — no senior can have been spawned for it yet`,
      round,
      ledgerRound: ledger.round,
    })
    setRequestedExitCode(22)
    return
  }

  const recorded = ledger.seniors[String(round)] ?? []

  // An agent id that matches none of the round's recorded spawns is refused rather than appended —
  // but only once spawns exist to compare against: the point of the record is that one of the
  // round's OWN seniors was torn down, and accepting any id would let a typo or a stale copy-paste
  // discharge the obligation for an agent still running. A round with no spawns on record at all has
  // nothing to compare against, so nothing refuses — the same carve-out as before, over a list.
  if (recorded.length > 0 && !recorded.some((s) => s.agentId === agentId)) {
    writeJson({
      error: 'agent id does not match any senior recorded for this round',
      round,
      recordedAgentIds: recorded.map((s) => s.agentId),
      givenAgentId: agentId,
    })
    setRequestedExitCode(18)
    return
  }

  appendEvent(ticket, {
    kind: 'senior-shutdown',
    at: nowIso(),
    round,
    agentId,
    ...(reason !== undefined ? { reason } : {}),
  })
  writeJson({ ticket, round, agentId, recorded: 'shutdown' })
}

export const runRecordReviewStart = (ticket: string, round: number, sha: string): void => {
  const ledger = readLedger(ticket)
  if (round !== ledger.round) {
    writeJson({
      error: `--round ${round} does not match the ledger's current round ${ledger.round}`,
      round,
      ledgerRound: ledger.round,
      remedy:
        'stop and tell the team lead: the ledger is not on the round you were spawned for, so an earlier round was run without being closed, or the round number is wrong',
    })
    setRequestedExitCode(22)
    return
  }
  if (ledger.reviews[String(round)]?.state === 'complete') {
    writeJson({
      error: `round ${round}'s review is already complete and the round was never closed`,
      round,
      remedy:
        'stop and tell the team lead: it must close this round with `review-ledger next-round` before a new review starts',
    })
    setRequestedExitCode(28)
    return
  }
  appendEvent(ticket, { kind: 'review-start', at: nowIso(), round, sha })
  writeJson({ ticket, round, sha, recorded: 'review-start' })
}

export const runRecordReviewComplete = (
  ticket: string,
  round: number,
  sha: string,
  verdict: ReviewVerdict
): void => {
  const ledger = readLedger(ticket)
  if (round !== ledger.round) {
    writeJson({
      error: `--round ${round} does not match the ledger's current round ${ledger.round}`,
      round,
      ledgerRound: ledger.round,
    })
    setRequestedExitCode(22)
    return
  }
  const review = ledger.reviews[String(round)]
  if (review === undefined || review.state === 'complete') {
    writeJson({
      error:
        review === undefined
          ? `round ${round} has no review start on record`
          : `round ${round}'s review is already complete`,
      round,
    })
    setRequestedExitCode(28)
    return
  }
  appendEvent(ticket, { kind: 'review-complete', at: nowIso(), round, sha, verdict })
  writeJson({ ticket, round, sha, verdict, recorded: 'review-complete' })
}

// Five outcomes. `computed` is present only when the predicate actually ran and produced a value —
// on every other path it is left absent, never defaulted to 'undetermined', so the ledger cannot
// read a round the checker skipped as one that returned a real answer (see ledger.ts's own comments
// on computedStance and isComputedStanceOrAbsent).
//
// Round 1 is adversarial by convention with no anchor to compare against, so there is nothing for a
// declaration to contradict — the predicate does not run, and nothing refuses. An unresolvable repo
// root, and any computeStance failure that is not a stop-and-escalate (no ledger on disk, a git
// precondition), are the same case: the predicate could not run, so nothing refuses. A checker that
// cannot run must not wedge the round closed behind it.
//
// A null anchor, a missing round record from round 2 on, or a stale recorded sha (a rewritten branch
// history that left a round's own recorded reviewed sha unresolvable or no longer an ancestor of the
// sha under evaluation) is different: computeStance DID run, and what it found is that round 1 was
// mis-stamped, a prior round's own 'round-reviewed' record is missing, or a prior round's reviewed
// sha no longer describes this branch's history — the checklist calls all three a stop-and-escalate,
// never a value to default past, so these are the three failures that still refuse. Each stays
// refusable and `--reason`-licensable like a genuine contradiction, but none is one: `computed` stays
// absent on this path too, so a round closed over a licensed stop-and-escalate is distinguishable on
// the ledger from a round closed over a licensed declared-vs-computed contradiction, which always
// carries a real computed value.
//
// An `undetermined` computed value is a real answer the predicate produced — clause (b) could not be
// decided mechanically — and it contradicts nothing either way: it is not a licence to declare
// cleanup, but the senior's own report, not this command, is where that judgement is made.
//
// A `Record<StanceFailure, boolean>` rather than an equality test, so the compiler — not a reviewer —
// forces every new StanceFailure member to be classified here before it type-checks, the same
// guarantee EXIT_BY_STANCE_FAILURE already gives runStance.
const STANCE_FAILURE_REFUSES_DECLARATION: Record<StanceFailure, boolean> = {
  'no-ledger': false,
  'missing-round-record': true,
  'null-anchor': true,
  'git-precondition': false,
  'stale-recorded-sha': true,
}

// Is this close stamping the round with a sha some EARLIER round already recorded? Every round
// follows fixes and fixes are commits, so between two rounds the sha moves; a repeat is either a
// close aimed at a round that is not the one in front of it or a licensed re-review of a sha that
// did not move, and this check cannot tell them apart. The check is orthogonal
// to checkRoundReviewed — it fires however marked the round is, which is what makes it catch the
// case where a review mark exists but belongs to a round already closed and advanced past.
//
// Exact string comparison, deliberately. `reviewedShas` holds whatever `--reviewed-sha` was given,
// and parseShaLike accepts 7 to 40 hex characters, so the same commit written short in one round and
// long in another does NOT collide here and is not caught. Normalizing would mean resolving both
// through git, which would make this guard depend on a repo root it does not otherwise need and fail
// open whenever git is unavailable — a guard that silently stops guarding is worse than one whose
// coverage is stated.
const checkShaReuse = (
  ledger: Ledger,
  round: number,
  reviewedSha: string
): { refusal: string; priorRound: number } | undefined => {
  for (const [key, sha] of Object.entries(ledger.reviewedShas)) {
    const priorRound = Number(key)
    if (sha !== reviewedSha || priorRound >= round) continue
    return {
      refusal: `sha ${reviewedSha} is already recorded as round ${priorRound}'s reviewed sha`,
      priorRound,
    }
  }
  return undefined
}

// Was this round reviewed? Three marks, and each is evidence that a review happened: a senior
// recorded for the round, a finding raised in it, or a review its senior recorded starting. A round
// carrying no review mark is indistinguishable from the round `next-round` mints as it advances —
// because that is exactly what it is.
//
// An instruction dispatched in the round is deliberately not a mark, though the ledger records
// one and an earlier form of this check accepted it. An instruction means the team lead typed; it is
// produced by relaying a finding or a ruling, so it accumulates in the hundreds on an ordinary
// ticket and appears in rounds where nobody reviewed anything. Accepting it made this predicate
// answer a question about whether the lead had spoken, under a name that promises a review — so it
// returned `undefined` for the one state it exists to catch, and did so on the path where the false
// `round-reviewed` it waves through is permanent: the log is append-only and no verb removes one.
//
// This fails toward refusing rather than toward closing, which is the correct direction for a check
// whose false negative is an unrecoverable ledger and whose false positive is one command that
// prints how to proceed.
const checkRoundReviewed = (ledger: Ledger, round: number): string | undefined => {
  if (ledger.reviews[String(round)] !== undefined) return undefined
  if ((ledger.seniors[String(round)]?.length ?? 0) > 0) return undefined
  if (ledger.findings.some((f) => f.raisedInRound === round)) return undefined
  return `round ${round} has no recorded review: no review mark on it`
}

const checkSeniorAccounted = (
  ledger: Ledger,
  round: number
): { refusal?: string; agentIds?: string[] } => {
  const seniors = ledger.seniors[String(round)] ?? []
  // No entries at all is NOT a refusal. A ledger written before FLOW-323 has no senior events, and a
  // round whose senior was never recorded must not read as a leak the check invented — the check
  // reports what the ledger knows, and an absent record is an absence of knowledge, not evidence.
  const outstanding = seniors.filter((s) => s.shutdownAt === null).map((s) => s.agentId)
  if (outstanding.length === 0) return {}
  return {
    refusal: `round ${round} has senior(s) with no recorded shutdown: ${outstanding.join(', ')}`,
    agentIds: outstanding,
  }
}

const checkDeclaredStance = (
  ticket: string,
  round: number,
  reviewedSha: string,
  declared: ReviewStance,
  repo?: string,
  scopeChange?: string
): {
  computed?: ComputedStance
  refusal?: string
  licensedBy?: 'reason' | 'scope-change'
  overridden?: boolean
  detail?: string[]
} => {
  if (round === 1) return {}
  const repoRoot = resolveRepoRoot(repo)
  if (repoRoot === null) {
    // Only refuse when a repo was explicitly provided — a missing repo means we're in a context
    // where the stance check cannot run (test environment, legacy caller), and refusing there
    // would break every existing test that uses synthetic SHAs.
    if (repo !== undefined) {
      return {
        refusal: `round ${round} stance predicate failed: could not resolve repo root at ${repo} — resolve the predicate failure before closing`,
      }
    }
    return {}
  }
  const outcome = computeStance(ticket, reviewedSha, repoRoot)
  if (!outcome.ok) {
    if (STANCE_FAILURE_REFUSES_DECLARATION[outcome.code]) {
      return { refusal: outcome.error }
    }
    // Refuse on any stance failure, not just the listed ones — a predicate that could not run is
    // not a stance check that passed, and proceeding silently records a round with no stance
    // verification at all.
    return {
      refusal: `round ${round} stance predicate failed: ${outcome.error} — resolve the predicate failure before closing`,
    }
  }
  const computed = outcome.report.stance
  if (computed === 'undetermined' || computed === declared) return { computed }
  if (declared === 'adversarial' && computed === 'cleanup') {
    if (scopeChange === undefined || scopeChange.trim().length === 0) {
      return {
        computed,
        refusal: `declared stance ${declared} contradicts the computed stance ${computed} — pass --scope-change naming what changed`,
        licensedBy: 'scope-change',
        overridden: true,
      }
    }
    return { computed, licensedBy: 'scope-change', overridden: true }
  }
  return {
    computed,
    refusal: `declared stance ${declared} contradicts the computed stance ${computed} — pass --reason to record why the declaration stands`,
    licensedBy: 'reason',
    overridden: true,
  }
}

// The id is computed, then the ledger is checked for that id's status. A withdrawn finding refuses
// mechanically — the caller sees the reason and exit 4 rather than a silently re-opened finding. A
// finding already `fixed` is genuinely re-armed (the ledger fold flips it back to `open`) rather
// than silently discarded, and exit 7 tells the caller this was a re-raise, not a fresh id.
// `origin` defaults to 'senior' when omitted, so every call site that existed before this parameter
// did keeps stamping findings the same way it always has. `check` only stamps the event with the
// capture or gate a check-file finding cites — the classification that requires it lives in
// runOpenFindingScoped below. The diff-scope decision itself lives in runOpenFindingScoped below,
// the CLI's own entry point for `finding open`, so every test exercising this function directly with
// a fabricated `file` keeps working unchanged.
export const runOpenFinding = (
  ticket: string,
  file: string,
  symbol: string,
  summary: string,
  hint?: string,
  origin?: FindingOrigin,
  check?: string
): void => {
  const id = findingId(ticket, file, symbol, summary, check)
  const ledger = readLedger(ticket)
  const existing = ledger.findings.find((finding) => finding.id === id)
  if (existing !== undefined && existing.status === 'withdrawn') {
    writeJson({
      id,
      refused: true,
      ...(existing.withdrawnReason !== undefined ? { reason: existing.withdrawnReason } : {}),
    })
    setRequestedExitCode(4)
    return
  }
  appendEvent(ticket, {
    kind: 'finding-open',
    at: nowIso(),
    id,
    round: ledger.round,
    file,
    symbol,
    summary,
    ...(hint !== undefined ? { hint } : {}),
    origin: origin ?? 'senior',
    ...(check !== undefined ? { check } : {}),
  })
  if (existing !== undefined && existing.status === 'fixed') {
    writeJson({ id, reopened: true })
    setRequestedExitCode(7)
    return
  }
  writeJson({ id })
}

// A check file is one the review reads only to confirm a proof happened: the ticket's proofs file,
// its implementation plan, or a ledger row named by prefix. Matched on the path the caller passes,
// basename or repo-relative, so a proofs file outside the repository (docs/plans in the parent
// workspace) classifies the same as one inside it.
const CHECK_TARGET_FILE = /(?:^|\/)[^/]*-(?:proofs|3-impl)\.md$/

const CAPTURE_ID = /^[0-9a-f]{12}$/

// The suffix after the colon in a virtual check target (proof-ledger:<id>, gate-ledger:<gate>) —
// undefined for a file-path check target (*-proofs.md, *-3-impl.md), which has no suffix to compare.
const VIRTUAL_CHECK_TARGET = /^(?:proof-ledger|gate-ledger):([\s\S]+)$/

export const isCheckTarget = (file: string): boolean =>
  CHECK_TARGET_FILE.test(file) || VIRTUAL_CHECK_TARGET.test(file)

// The real entry point for `finding open` — commands/review-ledger.ts calls this, not
// runOpenFinding directly. Every target is one of three classes, and the class decides the route
// (skills/code-review/references/checklist.md §What Is In Scope): a CHECK file opens only with
// --check naming the capture or gate its claim cites; a SHIPPED path — one `git diff "$(git
// merge-base origin/main HEAD)..HEAD" --name-only` prints — opens as before; everything else is
// OUTSIDE and refused. There is no flag that argues with the class.
//
// The check-file test runs FIRST, before any git call: a proofs file lives outside the repository,
// so a caller filing against it has no reason to expect origin/main to resolve in whatever
// --repo-root it passes, and a guard that blocks the one out-of-diff route on a precondition that
// route never needed is not fail-closed, just closed (the FLOW-309 ordering defect).
export const runOpenFindingScoped = (
  ticket: string,
  file: string,
  symbol: string,
  summary: string,
  hint?: string,
  origin?: FindingOrigin,
  check?: string,
  repo?: string,
  prose?: boolean
): void => {
  if (isCheckTarget(file)) {
    if (check === undefined) {
      writeJson({
        error:
          `--file ${file} is a check file (the proofs file, the implementation plan, or a ledger ` +
          'row) and is filed only against a capture that does not support it — pass --check ' +
          '<capture-id|gate> naming the proof-ledger capture or declared gate the claim cites; ' +
          'wording is not a finding',
      })
      setRequestedExitCode(16)
      return
    }
    if (!CAPTURE_ID.test(check)) {
      const gates = declaredGateNames(ticket)
      if (!(Array.isArray(gates) && gates.includes(check))) {
        writeJson({
          error:
            `--check ${check} names neither a proof-ledger capture id (12 lowercase hex) nor a gate ` +
            `declared for ${ticket} (${describeDeclaredGates(gates)})`,
        })
        setRequestedExitCode(16)
        return
      }
    }
    const virtualSuffix = VIRTUAL_CHECK_TARGET.exec(file)?.[1]
    if (virtualSuffix !== undefined && virtualSuffix !== check) {
      writeJson({
        error: `--file ${file} names ${virtualSuffix} but --check is ${check} — a finding's target and its citation must name the same capture or gate`,
      })
      setRequestedExitCode(16)
      return
    }
    runOpenFinding(ticket, file, symbol, summary, hint, origin, check)
    return
  }
  if (check !== undefined) {
    writeJson({
      error:
        `--check is only for a check file (*-proofs.md, *-3-impl.md, proof-ledger:<id>, ` +
        `gate-ledger:<gate>) — ${file} is not one; a defect in a shipped file is filed without it`,
    })
    setRequestedExitCode(16)
    return
  }
  const repoRoot = resolveRepoRoot(repo)
  if (repoRoot === null) {
    writeJson({
      error:
        `cannot resolve a git repo root from ${repo ?? process.cwd()} — pass --repo-root ` +
        'pointing at the checkout under review',
    })
    setRequestedExitCode(12)
    return
  }
  const diffFiles = diffFilesAgainstOriginMain(repoRoot)
  if (diffFiles === null) {
    writeJson({
      error:
        `cannot resolve the diff against origin/main from ${repoRoot} — fetch origin, or pass ` +
        '--repo-root pointing at the checkout under review',
    })
    setRequestedExitCode(12)
    return
  }
  if (!diffFiles.includes(file)) {
    writeJson({
      error:
        `--file ${file} is not in the diff (git diff "$(git merge-base origin/main HEAD)..HEAD" ` +
        '--name-only) and is not a check file — a PR body, Jira description or commit message ' +
        'defect is `review-ledger note add`; anything else outside the diff is a process note, ' +
        'not a finding',
    })
    setRequestedExitCode(16)
    return
  }
  // Prose-artifact routing: when --prose is passed and the file is documentation, the mismatch is
  // accuracy-polish (not a false claim about program behavior), so it routes to a note rather than
  // a finding. The senior makes the accuracy-polish vs false-claim call — the CLI cannot.
  // runAddNote writes the note's own {id} JSON — the route is named by the note existing at all.
  if (prose === true && classifyPath(file) === 'documentation') {
    runAddNote(ticket, 'pr-body', `Prose accuracy: ${file} — ${summary}`)
    return
  }
  runOpenFinding(ticket, file, symbol, summary, hint, origin)
}

// The gate names for this ticket, or why none can be named. [] for no manifest; parseManifest's own
// thrown message for one this process read and could not turn into a gate list. Declaring nothing
// and declaring something unusable are different facts, and the refusal above prints one of them
// back as the declared set. parseManifest throws from six places: JSON.parse's own SyntaxError, and
// five validation throws — the top-level `gates`-array shape check, and the four per-row checks on
// row-is-an-object, name, command and owner. The message is carried rather than described because
// those five validation throws fire on content that parsed perfectly, so any sentence this function
// composed about syntax would be wrong for them — the same reason gate-ledger's loadDeclaredGates
// keeps the thrown message as `detail`. A manifest that
// cannot be READ at all throws instead: review-ledger's runGuarded maps StoreUnreadableError to
// exit 26 (documented above), which prescribes repairing the file rather than declaring over it.
const declaredGateNames = (ticket: string): string[] | UnusableManifest => {
  const path = manifestPath(ticket)
  const read = readClassified(path)
  if (read.kind === 'unreadable') throw new StoreUnreadableError(path, read.code)
  if (read.kind === 'absent') return []
  try {
    return parseManifest(path, read.content).map((gate) => gate.name)
  } catch (err) {
    return { detail: err instanceof Error ? err.message : String(err) }
  }
}

interface UnusableManifest {
  detail: string
}

// What the refusal above says about the declared set, in the parenthetical after the ticket. The
// refusal itself is the same in all three cases and stays at exit 16 — `--check` names no gate this
// process can confirm — so only the reason differs. The path is not added here: every parseManifest
// throw already prefixes it, so `detail` carries it and naming it again would print it twice.
const describeDeclaredGates = (gates: string[] | UnusableManifest): string => {
  if (!Array.isArray(gates)) return `does not declare a usable gate list: ${gates.detail}`
  return gates.length > 0 ? gates.join(', ') : 'none declared'
}

export const runSetFindingStatus = (
  ticket: string,
  id: string,
  status: 'fixed' | 'withdrawn',
  reason?: string,
  fixCommit?: string,
  repo?: string
): void => {
  const ledger = readLedger(ticket)
  const existing = ledger.findings.find((finding) => finding.id === id)
  if (existing === undefined) {
    writeJson({ error: `no finding with id ${id}` })
    setRequestedExitCode(5)
    return
  }
  if (status === 'withdrawn' && (reason === undefined || reason.trim().length === 0)) {
    writeJson({ error: 'finding status withdrawn requires --reason' })
    setRequestedExitCode(6)
    return
  }
  if (fixCommit !== undefined) {
    const repoRoot = resolveRepoRoot(repo)
    const target = repoRoot ?? repo ?? process.cwd()
    if (repoRoot === null || revParseQuiet(repoRoot, `${fixCommit}^{commit}`) === null) {
      const matches = repoRoot === null ? [] : disambiguateShas(repoRoot, fixCommit)
      writeJson({
        error:
          matches.length > 1
            ? `--fix-commit ${fixCommit} is ambiguous in ${target}: it matches ${matches.length} ` +
              `objects (${matches.join(', ')}) — pass enough of the sha to name exactly one`
            : `--fix-commit ${fixCommit} does not resolve to a commit in ${target}: either the sha ` +
              `names nothing there, or ${target} is not a git repository — pass --repo-root ` +
              'pointing at the repo the fix commit belongs to',
      })
      setRequestedExitCode(15)
      return
    }
  }
  appendEvent(ticket, {
    kind: 'finding-status',
    at: nowIso(),
    id,
    round: ledger.round,
    status,
    ...(reason !== undefined ? { reason } : {}),
    ...(fixCommit !== undefined ? { fixCommit } : {}),
  })
  // A withdrawn id disposed 'fixed' is a legal transition (withdrawn in error, later genuinely
  // fixed) — refusing it the way runOpenFinding refuses 'finding open' on a withdrawn id would be
  // wrong here. What must not happen is the caller reading {id, status: 'fixed'} indistinguishably
  // from a finding that was never withdrawn: surface the resurrection at call time, on top of
  // resurrectedFromWithdrawn's own durable record in the ledger fold (Ledger.ts's 'finding-status'
  // case). The key is omitted entirely when withdrawnReason is undefined, matching that same fold
  // guard — one representation of one fact, not a CLI-only empty string standing in for absence.
  if (existing.status === 'withdrawn' && status === 'fixed') {
    writeJson({
      id,
      status,
      ...(existing.withdrawnReason !== undefined
        ? { resurrectedFromWithdrawn: existing.withdrawnReason }
        : {}),
    })
    return
  }
  writeJson({ id, status })
}

// Re-recording an id whose disposition is anything but `pending` re-arms it (the ledger fold flips
// it back to `pending`) — the same re-raise semantics, and the same exit-7 signal, as
// runOpenFinding above.
export const runRecordInstruction = (ticket: string, text: string): void => {
  const ledger = readLedger(ticket)
  const id = instructionId(ticket, text)
  const existing = ledger.instructions.find((instruction) => instruction.id === id)
  appendEvent(ticket, { kind: 'instruction', at: nowIso(), id, round: ledger.round, text })
  if (existing !== undefined && existing.disposition !== 'pending') {
    writeJson({ id, reopened: true })
    setRequestedExitCode(7)
    return
  }
  writeJson({ id })
}

// Assigns ownership at dispatch time — a separate step from finding-open because ownership is
// decided after a finding is raised, not at raise time. Exits 5 on an id the ledger does not
// contain, matching runSetFindingStatus/runDisposeInstruction's convention for the same case.
export const runAssignFinding = (ticket: string, id: string, owner: string): void => {
  const ledger = readLedger(ticket)
  const existing = ledger.findings.find((finding) => finding.id === id)
  if (existing === undefined) {
    writeJson({ error: `no finding with id ${id}` })
    setRequestedExitCode(5)
    return
  }
  appendEvent(ticket, { kind: 'finding-assign', at: nowIso(), id, round: ledger.round, owner })
  writeJson({ id, owner })
}

export const runDisposeInstruction = (
  ticket: string,
  id: string,
  disposition: 'acted' | 'not-acted' | 'not-applicable',
  reason?: string
): void => {
  const ledger = readLedger(ticket)
  const existing = ledger.instructions.find((instruction) => instruction.id === id)
  if (existing === undefined) {
    writeJson({ error: `no instruction with id ${id}` })
    setRequestedExitCode(5)
    return
  }
  if (disposition !== 'acted' && (reason === undefined || reason.trim().length === 0)) {
    writeJson({ error: `instruction disposition ${disposition} requires --reason` })
    setRequestedExitCode(6)
    return
  }
  appendEvent(ticket, {
    kind: 'instruction-disposition',
    at: nowIso(),
    id,
    round: ledger.round,
    disposition,
    ...(reason !== undefined ? { reason } : {}),
  })
  // Mirrors runSetFindingStatus's resurrectedFromWithdrawn surfacing above, against the fold's own
  // supersededReason guard (ledger.ts's 'instruction-disposition' case): `existing.reason !==
  // undefined && event.reason === undefined`. Without this, a caller reading {id, disposition} here
  // sees no trace of the reason this disposition just dropped, even though the durable record
  // captured it — the key is omitted entirely when there is nothing to carry, same as
  // resurrectedFromWithdrawn.
  writeJson({
    id,
    disposition,
    ...(existing.reason !== undefined && reason === undefined
      ? { supersededReason: existing.reason }
      : {}),
  })
}

// One disposition call for N instructions — the implementer's standing self-check items and
// not-applicable instructions are disposed as one batch per round rather than one call each.
// Every id must exist before any event is appended: a partial batch would leave the caller unable
// to tell which ids discharged and which did not without re-reading the ledger.
export const runDisposeInstructionBatch = (
  ticket: string,
  ids: string[],
  disposition: 'acted' | 'not-acted' | 'not-applicable',
  reason?: string
): void => {
  const ledger = readLedger(ticket)
  const missing = ids.filter(
    (id) => !ledger.instructions.some((instruction) => instruction.id === id)
  )
  if (missing.length > 0) {
    writeJson({ error: `no instruction(s) with id(s): ${missing.join(', ')}` })
    setRequestedExitCode(5)
    return
  }
  if (disposition !== 'acted' && (reason === undefined || reason.trim().length === 0)) {
    writeJson({ error: `instruction disposition ${disposition} requires --reason` })
    setRequestedExitCode(6)
    return
  }
  appendEvents(
    ticket,
    ids.map((id) => ({
      kind: 'instruction-disposition' as const,
      at: nowIso(),
      id,
      round: ledger.round,
      disposition,
      ...(reason !== undefined ? { reason } : {}),
    }))
  )
  writeJson({ ids, disposition, count: ids.length })
}

// A record defect for the lead. Re-adding an id already `done` re-arms it — the same re-raise
// semantics, and the same exit-7 signal, as runOpenFinding and runRecordInstruction above.
export const runAddNote = (ticket: string, target: NoteTarget, text: string): void => {
  const ledger = readLedger(ticket)
  const id = noteId(ticket, target, text)
  const existing = ledger.notes.find((note) => note.id === id)
  appendEvent(ticket, { kind: 'note-add', at: nowIso(), id, round: ledger.round, target, text })
  if (existing !== undefined && existing.done) {
    writeJson({ id, reopened: true })
    setRequestedExitCode(7)
    return
  }
  writeJson({ id })
}

export const runDoneNote = (ticket: string, id: string): void => {
  const ledger = readLedger(ticket)
  if (!ledger.notes.some((note) => note.id === id)) {
    writeJson({ error: `no note with id ${id}` })
    setRequestedExitCode(5)
    return
  }
  appendEvent(ticket, { kind: 'note-done', at: nowIso(), id })
  writeJson({ id, done: true })
}

export const runShow = (ticket: string, status?: 'open' | 'fixed' | 'withdrawn'): void => {
  if (!ledgerFileExists(ticket)) {
    writeJson({ error: `no ledger on disk for ticket ${ticket}` })
    setRequestedExitCode(8)
    return
  }
  const ledger = readLedger(ticket)
  const findings =
    status === undefined ? ledger.findings : ledger.findings.filter((f) => f.status === status)
  writeJson({ ...ledger, findings, notes: ledger.notes.filter((note) => !note.done) })
}

const nowIso = (): string => new Date().toISOString()

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
