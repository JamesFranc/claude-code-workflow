import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { GIT_MAX_BUFFER_BYTES } from '../proof-ledger/git-exec.ts'
import { ledgerFileExists, readLedger, type ComputedStance, type Ledger } from './ledger.ts'

// Ports the re-arming predicate in skills/code-review/references/checklist.md §Review Stance from a
// hand-executed shell recipe into a command. The recipe stays in that file: it is the specification
// this module must match, and it remains the fallback for the one case this module cannot decide by
// itself — clause (b) with a new-scope pair set that survives the specification's own pre-filter,
// which needs the TypeScript compiler.
//
// Why this exists at all: the stance was a self-declared field nothing computed and nothing checked,
// so `--stance adversarial` was free and correct-by-default while `cleanup` cost a multi-page manual
// pipeline. Every round was therefore declared adversarial and the convergence mechanism never fired.

// Whether a clause reached a decision. 'undetermined' is a first-class answer and is never collapsed
// to 'did-not-fire': a clause this module cannot decide must not license a cleanup round, which is
// the exact failure — a stance nothing computes — this module exists to close.
export type ClauseVerdict = 'fired' | 'did-not-fire' | 'undetermined'

// How a path counts for the predicate's clause (a) and for the delta tiers. Ported from the
// classifier in §Delta-scoped rounds — bounding what you read.
export type PathKind = 'code' | 'test' | 'documentation'

export interface ClauseResult {
  verdict: ClauseVerdict
  // The paths that fired the clause — the A/D paths for (a), the new-territory paths for (c). Empty
  // on a 'did-not-fire', and empty on (b) whichever way it lands, since (b) reports pairs instead.
  paths: string[]
  // Clause (b) only: the "<sha> <path>" new-scope pairs left undetermined, so the caller can run the
  // declaration-diff recipe over exactly those and nothing else.
  pairs?: string[]
  note?: string
}

export interface DeltaScope {
  // 'tier-1' — no code path touched, mechanically satisfied. 'tier-2-candidate' — code was touched,
  // so the round qualifies only if every added and removed line falls inside a comment, which is a
  // lexical question this module does not answer; `command` is the exact diff to read. 'none' — no
  // previous round has closed, so there is no delta to scope to.
  tier: 'tier-1' | 'tier-2-candidate' | 'none'
  paths: string[]
  codePaths: string[]
  command?: string
}

export interface StanceReport {
  ticket: string
  pinnedSha: string
  round: number
  anchorRound: number
  anchorSha: string
  previousRoundSha: string | null
  stance: ComputedStance
  clauses: { a: ClauseResult; b: ClauseResult; c: ClauseResult }
  deltaScope: DeltaScope
  // Present only when the CONSTRUCTION GAP guard skipped rather than ran — see constructionGap below.
  notes?: string[]
}

export type StanceFailure =
  'no-ledger' | 'missing-round-record' | 'null-anchor' | 'git-precondition' | 'stale-recorded-sha'

// A result rather than a throw: the run layer maps each failure to its own exit code, and a thrown
// error carries no way to tell an unresolvable sha (a caller mistake) from a missing denominator (a
// soundness stop) from a null anchor (an escalation).
export type StanceOutcome =
  | { ok: true; report: StanceReport }
  | { ok: false; code: StanceFailure; error: string; detail?: string[] }

export const computeStance = (
  ticket: string,
  pinnedSha: string,
  repoRoot: string,
  anchorOverride?: string
): StanceOutcome => {
  if (!ledgerFileExists(ticket))
    return { ok: false, code: 'no-ledger', error: `no ledger on disk for ticket ${ticket}` }
  const ledger = readLedger(ticket)
  if (anchorOverride === undefined && ledger.resolvedAnchor === null)
    return {
      ok: false,
      code: 'null-anchor',
      error: `no round has closed with an adversarial stance for ${ticket} — a stop-and-escalate, never a value to default past`,
    }
  const anchorSha = anchorOverride ?? ledger.resolvedAnchor!.reviewedSha
  const resolvedAnchorRound = resolveAnchorRound(repoRoot, ledger, anchorOverride, anchorSha)
  const anchorRound = resolvedAnchorRound.round

  // `^{commit}` peels to a real object, unlike a bare `rev-parse --verify` on a well-formed 40-hex
  // string, which git accepts as syntactically valid without checking the object store at all.
  // `origin/main` is checked here too because clauseC below interpolates it into a git range with
  // no guard of its own — a repo with no such remote-tracking ref (no remote configured, or a
  // default branch other than main) must fail this refusal, not the execFileSync call inside
  // clauseC. An explicit --anchor is a caller-supplied value for this run and is checked here
  // alongside pinnedSha and origin/main; anchorSha with no override is the ledger's own recorded
  // value and is checked separately below, where an unresolvable or non-ancestor result means
  // something different (see checkRecordedSha).
  const unresolvable = [
    pinnedSha,
    'origin/main',
    ...(anchorOverride !== undefined ? [anchorSha] : []),
  ].filter((rev) => revParseQuiet(repoRoot, `${rev}^{commit}`) === null)
  if (unresolvable.length > 0)
    return {
      ok: false,
      code: 'git-precondition',
      error: `unresolvable ref(s): ${unresolvable.map((rev) => describeUnresolvedRev(repoRoot, rev)).join('; ')}`,
    }

  if (anchorOverride === undefined) {
    const stale = checkRecordedSha(repoRoot, 'the anchor round', anchorSha, pinnedSha)
    if (stale !== null) return stale
  } else {
    const ancestry = checkForwardRange(repoRoot, 'anchor', anchorSha, pinnedSha)
    if (!ancestry.ok) return ancestry.failure
  }

  const pairs = roundPairs(repoRoot, anchorSha, pinnedSha)
  if (!pairs.ok) return pairs.failure
  const discharged = dischargedPairs(ledger, pairs.pairs)
  if (discharged.ambiguous.length > 0)
    return {
      ok: false,
      code: 'git-precondition',
      error: 'a fixCommit prefix on the ledger matches more than one commit in this round range',
      detail: discharged.ambiguous,
    }
  const gap = denominatorGaps(repoRoot, anchorSha, pinnedSha, pairs)
  if (!gap.ok) return gap.failure

  const newScope = pairs.pairs.filter((pair) => !discharged.pairs.has(pair))
  const a = clauseA(repoRoot, anchorSha, pinnedSha, discharged.pairs)
  const b = clauseB(repoRoot, newScope)
  const c = clauseC(repoRoot, anchorSha, anchorRound, pinnedSha, ledger)

  const results = [a, b, c]
  const stance: ComputedStance = results.some((r) => r.verdict === 'fired')
    ? 'adversarial'
    : results.some((r) => r.verdict === 'undetermined')
      ? 'undetermined'
      : 'cleanup'

  // `reportRound` is the round this report describes. Without --anchor it is the live round, exactly
  // as before. With --anchor replaying a historical round (pinnedSha is that round's own
  // reviewedSha), it must be that round's number, not the ledger's live round, or previousRoundSha
  // below inherits the same round-mixing this override exists to avoid. An --anchor whose pinnedSha
  // is not a recorded round's reviewedSha is the live-tip use (a synthetic anchor for the round
  // currently open), where the live round is still the right value — see resolveReportRound.
  const reportRound = resolveReportRound(repoRoot, ledger, anchorOverride, pinnedSha)

  // Read off the ledger at reportRound's predecessor rather than computed by this module, so it
  // carries no guarantee of resolving — a licensed --reason override on either closing command can record a
  // well-formed but nonexistent reviewedSha (checkDeclaredStance's own unresolvable-sha refusal only
  // ever covers the round it is CURRENTLY closing, not a value some earlier round already has on
  // record). deltaScope below interpolates it into a git range with no guard of its own beyond the
  // check just below. Always a ledger-recorded value, never a caller override, so it goes through
  // checkRecordedSha rather than the plain unresolvable/checkForwardRange pair the anchor override
  // case above uses.
  const previousRoundSha = ledger.reviewedShas[String(reportRound - 1)] ?? null
  if (previousRoundSha !== null) {
    const stale = checkRecordedSha(
      repoRoot,
      `round ${reportRound - 1}`,
      previousRoundSha,
      pinnedSha
    )
    if (stale !== null) return stale
  } else if (reportRound >= 2) {
    // checklist.md §Delta-scoped rounds — bounding what you read: an absent entry at round 2 or
    // later means the ledger is missing a record it should have, a stop-and-escalate rather than a
    // value to substitute past. A record can go missing from a ledger that parses cleanly — a write
    // that landed the 'round' event and not the 'round-reviewed' one, a hand-edited ledger, a gap
    // replayed under --anchor — so this refuses on the missing record itself, never on
    // skippedLines; skippedLines only adds ambiguity to the error text when it is also nonzero.
    return {
      ok: false,
      code: 'missing-round-record',
      error:
        `previousRoundSha resolved to null at report round ${reportRound} — the ledger is missing ` +
        `round ${reportRound - 1}'s 'round-reviewed' record` +
        (ledger.skippedLines > 0
          ? ` (ambiguous: ${ledger.skippedLines} ledger line(s) for ${ticket} could not be parsed, so this may also be a dropped line rather than a record that was simply never written)`
          : ''),
    }
  }
  const notes = [...(resolvedAnchorRound.note ? [resolvedAnchorRound.note] : []), ...gap.notes]
  return {
    ok: true,
    report: {
      ticket,
      pinnedSha,
      round: reportRound,
      anchorRound,
      anchorSha,
      previousRoundSha,
      stance,
      clauses: { a, b, c },
      deltaScope: deltaScope(repoRoot, previousRoundSha, pinnedSha),
      ...(notes.length > 0 ? { notes } : {}),
    },
  }
}

// Clause (a): a new or deleted non-test, non-doc file. The fixCommit exclusion applies to additions
// only, and only as the checklist states it — a brand-new file introduced by a commit that discharges
// an earlier round's finding is that round's own remedy, not new scope for this round to re-litigate.
// A deletion carries no such exclusion in the checklist, so none is applied here: adding one would
// widen what a cleanup round waves through beyond what the specification licenses.
const clauseA = (
  repoRoot: string,
  anchorSha: string,
  pinnedSha: string,
  dischargedPairSet: ReadonlySet<string>
): ClauseResult => {
  const entries = gitLines(repoRoot, [
    'diff',
    '--find-renames',
    '--name-status',
    `${anchorSha}..${pinnedSha}`,
  ])
    .map(parseNameStatus)
    .filter((entry): entry is { status: string; path: string } => entry !== null)
    .filter((entry) => classifyPath(entry.path) === 'code')

  const fired: string[] = []
  for (const entry of entries) {
    if (entry.status === 'D') {
      fired.push(entry.path)
      continue
    }
    if (entry.status !== 'A') continue
    // Range before `--`, or git ignores it.
    const introducers = gitLines(repoRoot, [
      'log',
      '--format=%H',
      '--diff-filter=A',
      `${anchorSha}..${pinnedSha}`,
      '--',
      entry.path,
    ])
    const allDischarged =
      introducers.length > 0 &&
      introducers.every((sha) => dischargedPairSet.has(`${sha} ${entry.path}`))
    if (!allDischarged) fired.push(entry.path)
  }
  return fired.length > 0
    ? { verdict: 'fired', paths: sortedUnique(fired) }
    : { verdict: 'did-not-fire', paths: [] }
}

// Extensions tsc can emit a declaration for — ported verbatim from checklist.md §Checking clause (b).
const DECLARABLE_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']

// The one package the declaration-diff recipe can compile a declaration against — ported verbatim
// from checklist.md §Checking clause (b)'s own `tools/cli/src/*` guard arm and its
// `subpath="${path#tools/cli/src/}"` line. A declarable-extension path outside this prefix (a
// root-level config like eslint.config.js, or a file in some future second package) would survive
// DECLARABLE_EXTENSIONS but can never produce a declaration under tools/cli's own tsconfig.json, so
// it is excluded here too rather than reported as undetermined and handed to a recipe that hard-stops
// on it.
const COMPILABLE_PACKAGE_PREFIX = 'tools/cli/src/'

// Clause (b): the exported surface changed, restricted to new-scope pairs that survive the
// specification's own pre-filter. checklist.md §Checking clause (b) skips a pair before the
// declaration diff when its path is outside DECLARABLE_EXTENSIONS, outside COMPILABLE_PACKAGE_PREFIX,
// or when the path is not present at both sides of the pair (an add/delete clause (a) already caught,
// or a rename clause (c) already catches at its destination) — an empty new-scope set and a new-scope
// set consisting only of such skipped pairs are the same decisive negative: clause (b) does not fire.
// A set with at least one pair surviving the pre-filter needs the declaration-diff recipe and the
// TypeScript compiler, which this module does not run: it reports exactly those pairs and says so.
const clauseB = (repoRoot: string, newScope: readonly string[]): ClauseResult => {
  if (newScope.length === 0)
    return {
      verdict: 'did-not-fire',
      paths: [],
      note: "no new-scope (commit, path) pairs — every (commit, path) pair this round's range touches is one some finding on the ledger has ever named as its own (fixCommit, file) pair, with no round or acceptance check of its own",
    }
  const examined = newScope.filter((pair) => {
    const path = pair.slice(pair.indexOf(' ') + 1)
    if (!DECLARABLE_EXTENSIONS.some((ext) => path.endsWith(ext))) return false
    if (!path.startsWith(COMPILABLE_PACKAGE_PREFIX)) return false
    const sha = pair.slice(0, pair.indexOf(' '))
    return catFileExists(repoRoot, `${sha}^:${path}`) && catFileExists(repoRoot, `${sha}:${path}`)
  })
  return examined.length === 0
    ? {
        verdict: 'did-not-fire',
        paths: [],
        note: "every new-scope pair was skipped by the specification's own pre-filter (a non-ts extension, a path outside the one compilable package, or absence at one side of the pair) before the declaration diff — see skills/code-review/references/checklist.md, Checking clause (b)",
      }
    : {
        verdict: 'undetermined',
        paths: [],
        pairs: sortedUnique(examined),
        note: 'run the declaration-diff recipe in skills/code-review/references/checklist.md, Checking clause (b), over exactly these pairs',
      }
}

// Clause (c): new territory — a path changed since the anchor that the anchor round never saw. The
// anchor round's own diff is not the full record of what its senior read, so a path named anywhere in
// a finding raised at or before the anchor round counts as already reasoned about. Substring match
// against file, summary, and withdrawnReason only — deliberately not the raw finding JSON, which also
// matches an unrelated `hint` pointer.
const clauseC = (
  repoRoot: string,
  anchorSha: string,
  anchorRound: number,
  pinnedSha: string,
  ledger: Ledger
): ClauseResult => {
  const changed = sortedUnique(
    gitLines(repoRoot, ['diff', '--find-renames', '--name-only', `${anchorSha}..${pinnedSha}`])
  )
  const reviewed = new Set(
    gitLines(repoRoot, ['diff', '--find-renames', '--name-only', `origin/main...${anchorSha}`])
  )
  const anchorFindingText = ledger.findings
    .filter((finding) => finding.raisedInRound <= anchorRound)
    .flatMap((finding) => [finding.file, finding.summary, finding.withdrawnReason ?? ''])
    .join('\n')
  const newTerritory = changed.filter(
    (path) => !reviewed.has(path) && !anchorFindingText.includes(path)
  )
  return newTerritory.length > 0
    ? { verdict: 'fired', paths: newTerritory }
    : { verdict: 'did-not-fire', paths: [] }
}

// Tier 1 is mechanical and decided here. Tier 2 asks whether every added and removed line falls
// inside a comment — and "comment" there excludes any line a tool reads as a directive (a
// suppression comment, a shebang, a type annotation a type-checker consumes), which is a lexical
// question per language, not a path question. So tier 2 is reported as a candidate with the exact
// diff to read, never asserted. Each code path is its own shell-quoted argument after `--`: git
// treats a quoted multi-path string as a single pathspec that matches nothing, and the resulting
// empty diff exits 0 exactly as a genuine zero-line diff does.
const deltaScope = (
  repoRoot: string,
  previousRoundSha: string | null,
  pinnedSha: string
): DeltaScope => {
  if (previousRoundSha === null) return { tier: 'none', paths: [], codePaths: [] }
  const paths = sortedUnique(
    gitLines(repoRoot, [
      'diff',
      '--find-renames',
      '--name-only',
      `${previousRoundSha}..${pinnedSha}`,
    ])
  )
  const codePaths = paths.filter((path) => classifyPath(path) === 'code')
  if (codePaths.length === 0) return { tier: 'tier-1', paths, codePaths }
  return {
    tier: 'tier-2-candidate',
    paths,
    codePaths,
    command: `git diff -U0 ${previousRoundSha}..${pinnedSha} -- ${codePaths.map(shellQuote).join(' ')}`,
  }
}

// clause (c) suppresses findings by round, not by sha — an override's round must come from
// `reviewedShas`, not the ledger's own current round, or it suppresses findings raised after it. Both
// sides of the match are normalized (see normalizeSha) — `anchorSha` and each `reviewedShas` value can
// independently be full or abbreviated, and neither spelling may defeat the match.
const resolveAnchorRound = (
  repoRoot: string,
  ledger: Ledger,
  anchorOverride: string | undefined,
  anchorSha: string
): { round: number; note?: string } => {
  if (anchorOverride === undefined) return { round: ledger.resolvedAnchor?.round ?? 0 }
  const normalizedAnchorSha = normalizeSha(repoRoot, anchorSha)
  const found = Object.entries(ledger.reviewedShas).find(
    ([, sha]) => normalizeSha(repoRoot, sha) === normalizedAnchorSha
  )
  if (found) return { round: Number(found[0]) }
  return {
    round: 0,
    note: `--anchor ${anchorSha} is not a recorded round on this ledger, so anchorRound is 0 and clause (c) suppressed no prior findings — the result is biased toward adversarial, not cleanup`,
  }
}

// Historical-replay use of --anchor passes a pinnedSha that is itself a recorded round's own
// reviewedSha (replay round N with pinnedSha = reviewedShas[N], anchor = reviewedShas[N-1]) — the
// report describes round N, not whatever round is live on the ledger today. --anchor's other use, a
// synthetic anchor for the round currently open, passes a pinnedSha that matches no recorded round;
// there the live round is still correct and this returns it unchanged. Both sides of the match are
// normalized (see normalizeSha), for the same reason resolveAnchorRound above normalizes its own
// match.
const resolveReportRound = (
  repoRoot: string,
  ledger: Ledger,
  anchorOverride: string | undefined,
  pinnedSha: string
): number => {
  if (anchorOverride === undefined) return ledger.round
  const normalizedPinnedSha = normalizeSha(repoRoot, pinnedSha)
  const found = Object.entries(ledger.reviewedShas).find(
    ([, sha]) => normalizeSha(repoRoot, sha) === normalizedPinnedSha
  )
  return found ? Number(found[0]) : ledger.round
}

// The stance verb answers "what changed since <earlierLabel>" — well-formed only when that earlier
// sha precedes the pinned sha. A stale pinned sha, or history rewritten between the two, produces a
// git range that reports zero clauses firing by construction, which reads identically to a genuinely
// clean round: refusing here is what keeps `cleanup` from being reachable over a range that was
// never a forward delta. Shared by the anchor→pinned range and the previousRoundSha→pinned range —
// both are "earlier sha the report reasons forward from," and both carry the same hazard.
const checkForwardRange = (
  repoRoot: string,
  earlierLabel: string,
  earlierSha: string,
  pinnedSha: string
): { ok: true } | { ok: false; failure: StanceOutcome & { ok: false } } => {
  // git treats a commit as its own ancestor, so the earlierSha === pinnedSha case (a self-check,
  // e.g. auditing the round that is the current anchor) already passes here with no separate branch.
  if (isAncestor(repoRoot, earlierSha, pinnedSha)) return { ok: true }
  if (isAncestor(repoRoot, pinnedSha, earlierSha))
    return {
      ok: false,
      failure: {
        ok: false,
        code: 'git-precondition',
        error: `the range is backwards: ${earlierLabel} ${earlierSha} is a descendant of pinned sha ${pinnedSha}, not an ancestor of it`,
      },
    }
  return {
    ok: false,
    failure: {
      ok: false,
      code: 'git-precondition',
      error: `${earlierLabel} ${earlierSha} and pinned sha ${pinnedSha} have diverged — history was rewritten between them`,
    },
  }
}

// Whether a sha the ledger itself recorded — the anchor round's reviewedSha with no --anchor
// override, or an earlier round's own reviewedSha — still resolves and is still an ancestor of
// pinnedSha. A squash-rebase, origin/main moving out from under the branch, an interactive rebase
// that drops the tail, a reset, a checkout-and-re-pin, or a force-push rollback can each invalidate
// it: the sha stops resolving, or resolves to a commit no longer an ancestor of pinnedSha — forward
// (diverged) or backward (the branch tip is now a pre-existing ancestor of the recorded sha) alike.
// Unlike checkForwardRange's plain git-precondition (a caller-supplied --anchor the predicate
// simply cannot evaluate), any of these is the ledger's own record disagreeing with the branch it
// describes: the ledger and the branch disagree about what was reviewed, and the cause is not
// determinable from the two shas alone — it can be a caller-supplied pinnedSha that is merely
// stale, or a branch genuinely rewound past what the record names. Failing open is wrong for every
// member of that class, so this refuses rather than picking a cause to trust — the two call sites
// diverge here precisely because only one of them is a ledger record: checkForwardRange's other
// caller passes a caller-supplied --anchor override, where exit 12's plain, non-refusing treatment
// is correct because that value was never something the ledger vouched for.
const checkRecordedSha = (
  repoRoot: string,
  label: string,
  recordedSha: string,
  pinnedSha: string
): (StanceOutcome & { ok: false }) | null => {
  // No verb on this CLI re-records a round once it has closed — next-round only ever appends the
  // round currently open (see resolveAnchor in ledger.ts) — so this names no such command. --reason
  // is the one performable escape, and licensing it is a human decision, not an automated retry.
  const remedy = `this is a stop-and-escalate: no command re-records ${label}'s reviewed sha, so pass --reason to the command closing the round (\`next-round\`, or its deprecated alias \`round-close\`) to proceed deliberately, or investigate why the ledger and the branch disagree`
  if (revParseQuiet(repoRoot, `${recordedSha}^{commit}`) === null) {
    const matches = looksLikeShaPrefix(recordedSha) ? disambiguateShas(repoRoot, recordedSha) : []
    return {
      ok: false,
      code: 'stale-recorded-sha',
      error:
        matches.length > 1
          ? `${label}'s recorded reviewed sha ${recordedSha} is ambiguous in this repository: it now matches ${matches.length} objects (${matches.join(', ')}) — a new object was created since it was recorded whose prefix collides with it; ${remedy}`
          : `${label}'s recorded reviewed sha ${recordedSha} no longer resolves to an object in this repository — history was rewritten since it was recorded; ${remedy}`,
    }
  }
  const forward = checkForwardRange(repoRoot, label, recordedSha, pinnedSha)
  if (forward.ok) return null
  return {
    ok: false,
    code: 'stale-recorded-sha',
    error: `${forward.failure.error} — ${remedy}`,
  }
}

const isAncestor = (repoRoot: string, ancestor: string, descendant: string): boolean => {
  try {
    git(repoRoot, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

interface RoundPairs {
  ok: true
  pairs: string[]
  contributing: string[]
}

// Every (commit, path) pair the round range touches, each commit diffed against its own first parent
// rather than the combined range diff — a clean merge that resolves entirely to one side can match
// every parent on some paths while still changing others relative to the first. A root commit falls
// back to the empty tree. `contributing` is the separate question of which commits actually changed a
// tree, decided by tree-hash comparison rather than diff emptiness: an empty commit and an `-s ours`
// merge both have an empty first-parent diff without being a construction defect.
const roundPairs = (
  repoRoot: string,
  anchorSha: string,
  pinnedSha: string
): RoundPairs | { ok: false; failure: StanceOutcome & { ok: false } } => {
  let emptyTree: string
  let shas: string[]
  try {
    emptyTree = git(repoRoot, ['hash-object', '-t', 'tree', '/dev/null']).trim()
    shas = gitLines(repoRoot, ['log', '--format=%H', `${anchorSha}..${pinnedSha}`])
  } catch (err) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: 'git-precondition',
        error: `cannot enumerate the commits in ${anchorSha}..${pinnedSha}`,
        detail: [describeExecFailure(err)],
      },
    }
  }
  const pairs: string[] = []
  const contributing: string[] = []
  for (const sha of shas) {
    const parent = revParseQuiet(repoRoot, `${sha}^1`) ?? emptyTree
    for (const path of gitLines(repoRoot, ['diff', '--name-only', parent, sha]))
      pairs.push(`${sha} ${path}`)
    const parentTree = revParseQuiet(repoRoot, `${sha}^1^{tree}`) ?? emptyTree
    if (git(repoRoot, ['rev-parse', `${sha}^{tree}`]).trim() !== parentTree) contributing.push(sha)
  }
  return { ok: true, pairs: sortedUnique(pairs), contributing: sortedUnique(contributing) }
}

// Every (commit, path) pair the ledger records as discharged, with the commit resolved by prefix
// match against this round's own commits — a fixCommit on the ledger may be abbreviated. A prefix
// matching more than one commit in range is refused rather than guessed at: picking either one
// silently changes what counts as new scope. Exported so the ambiguous-match branch can be tested
// directly against synthetic pairs, the same way classifyPath is, rather than needing two real git
// commits whose shas happen to collide on a prefix.
//
// Excludes exactly the (commit, path) pair the finding names — finding.file — not every path the
// matched commit touches: a fix commit's diff commonly reaches beyond the one file a finding cited,
// and crediting the whole commit would silently spare every other path it happens to touch, including
// an unrelated new file added in the same commit. Reads allFixCommits, not fixCommit, so a commit is
// excluded once any finding-status event has ever named it, not only the finding's current folded
// value. A finding re-raised and re-fixed under a new commit does not un-exclude the earlier one.
export const dischargedPairs = (
  ledger: Ledger,
  pairs: readonly string[]
): { pairs: Set<string>; ambiguous: string[] } => {
  const shas = sortedUnique(pairs.map((pair) => pair.slice(0, pair.indexOf(' '))))
  const pairSet = new Set(pairs)
  const out = new Set<string>()
  const ambiguous: string[] = []
  for (const finding of ledger.findings) {
    for (const fixCommit of finding.allFixCommits) {
      const matches = shas.filter((sha) => sha.startsWith(fixCommit))
      if (matches.length > 1) {
        ambiguous.push(`finding ${finding.id} fixCommit ${fixCommit} matches ${matches.join(',')}`)
        continue
      }
      if (matches.length !== 1) continue
      const sha = matches[0]
      const pair = `${sha} ${finding.file}`
      if (pairSet.has(pair)) out.add(pair)
    }
  }
  return { pairs: out, ambiguous }
}

// The two denominator guards. A missing denominator invalidates every verdict downstream of it, so
// both halt rather than warn. COMMIT GAP has no precondition — its own left side is `git log`, not a
// net diff. CONSTRUCTION GAP's denominator is the net range diff, which is sound only when the anchor
// lies on the pinned sha's first-parent chain; off-chain a path can differ between the endpoints
// because the anchor sits off the line rather than because anything changed along it, so the guard
// skips and records why. A skip is never mistaken for a pass.
const denominatorGaps = (
  repoRoot: string,
  anchorSha: string,
  pinnedSha: string,
  pairs: RoundPairs
): { ok: true; notes: string[] } | { ok: false; failure: StanceOutcome & { ok: false } } => {
  const pairShas = new Set(pairs.pairs.map((pair) => pair.slice(0, pair.indexOf(' '))))
  const commitGap = pairs.contributing.filter((sha) => !pairShas.has(sha))
  if (commitGap.length > 0)
    return {
      ok: false,
      failure: {
        ok: false,
        code: 'git-precondition',
        error: `COMMIT GAP: commit(s) changed a tree across ${anchorSha}..${pinnedSha} with no (commit, path) pair recorded for them — the denominator is incomplete`,
        detail: commitGap,
      },
    }

  // A null here can only mean anchorSha does not resolve, never that it is ambiguous — not a
  // property of this line, but of what already ran before denominatorGaps is ever reached.
  // computeStance branches on anchorOverride before calling this: the override branch runs anchorSha
  // through the unresolvable filter above (which includes anchorSha exactly when the override is
  // set), and the ledger-recorded branch runs it through checkRecordedSha — both refuse an
  // unresolvable-or-ambiguous anchorSha before denominatorGaps can be reached. A second caller that
  // invokes denominatorGaps without running one of those two checks first would break this.
  const anchorFull = revParseQuiet(repoRoot, anchorSha)
  const onFirstParentChain =
    anchorFull !== null &&
    gitLines(repoRoot, ['rev-list', '--first-parent', pinnedSha]).includes(anchorFull)
  if (!onFirstParentChain)
    return {
      ok: true,
      notes: [
        `CONSTRUCTION GAP SKIPPED: ${anchorSha} is not on ${pinnedSha}'s first-parent chain, so the net range diff is not a sound denominator here; the union of per-commit first-parent diffs is the only sound one, and it is what this report already used. Coverage lost: a partial emission whose path is touched by no other commit in range.`,
      ],
    }

  const pairPaths = new Set(pairs.pairs.map((pair) => pair.slice(pair.indexOf(' ') + 1)))
  const constructionGap = sortedUnique(
    gitLines(repoRoot, ['diff', '--name-only', `${anchorSha}..${pinnedSha}`])
  ).filter((path) => !pairPaths.has(path))
  if (constructionGap.length > 0)
    return {
      ok: false,
      failure: {
        ok: false,
        code: 'git-precondition',
        error: `CONSTRUCTION GAP: path(s) changed across ${anchorSha}..${pinnedSha} with no (commit, path) pair recorded for them — the denominator is incomplete`,
        detail: constructionGap,
      },
    }
  return { ok: true, notes: [] }
}

// The classifier from §Delta-scoped rounds, ported in the order that section states it: test first,
// then the skills/agents exception, then documentation, then code. In this repo skills/ and agents/
// are not commentary about the shipped artifact, they ARE the shipped artifact, so a change there is
// a production-behaviour change and "no code touched" must not wave it through. `docs` is matched as
// a leading path segment rather than any segment: the narrower read classifies more paths as code,
// which is the conservative direction — it can only make a round adversarial that might have been
// cleanup, never the reverse.
export const classifyPath = (path: string): PathKind => {
  const segments = path.split('/')
  if (/\.(test|spec)\./.test(basename(path))) return 'test'
  if (/(_test\.(go|py)|_spec\.rb|Tests?\.cs)$|^test_.*\.py$/.test(basename(path))) return 'test'
  if (
    segments
      .slice(0, -1)
      .some((segment) => segment === '__tests__' || segment === 'test' || segment === 'tests')
  )
    return 'test'
  if (segments[0] === 'skills' || segments[0] === 'agents') return 'code'
  if (/\.mdx?$/.test(path)) return 'documentation'
  if (segments[0] === 'docs') return 'documentation'
  return 'code'
}

// `--find-renames` emits a status letter that may carry a similarity score (R100, C75) and, for a
// rename or copy, two tab-separated paths. Only single-path A and D lines matter to clause (a): a
// rename git already resolved is not a new file for that clause's purposes.
const parseNameStatus = (line: string): { status: string; path: string } | null => {
  const fields = line.split('\t')
  if (fields.length !== 2) return null
  const status = fields[0].charAt(0)
  return status.length === 0 || fields[1].length === 0 ? null : { status, path: fields[1] }
}

export const revParseQuiet = (repoRoot: string, rev: string): string | null => {
  try {
    return git(repoRoot, ['rev-parse', '--verify', '--quiet', rev]).trim() || null
  } catch {
    return null
  }
}

// Every object (of any type) in repoRoot whose full sha starts with prefix — the shas
// revParseQuiet's failure on a short prefix cannot itself distinguish: a prefix matching nothing
// and a prefix matching several objects both fail `rev-parse --verify`, and only this call tells
// them apart.
export const disambiguateShas = (repoRoot: string, prefix: string): string[] => {
  try {
    return gitLines(repoRoot, ['rev-parse', `--disambiguate=${prefix}`])
  } catch {
    return []
  }
}

// git's own minimum for `--disambiguate`. Guards disambiguateShas against being asked to
// disambiguate 'origin/main' or any other ref name, which is never ambiguous in the sense this
// module cares about — only a short sha prefix (pinnedSha, an --anchor override, or a ledger-recorded
// reviewedSha, all shaped by parseShaLike's 7-40 lowercase hex) can be.
const looksLikeShaPrefix = (value: string): boolean => /^[0-9a-f]{4,40}$/.test(value)

// Distinguishes why `rev` failed to resolve — ambiguous (matches more than one object) or missing
// (matches none) — the same distinction disambiguateShas exists to draw for `--fix-commit`'s exit 15,
// extended here to every caller in this module that can hand a short sha prefix to revParseQuiet.
const describeUnresolvedRev = (repoRoot: string, rev: string): string => {
  const matches = looksLikeShaPrefix(rev) ? disambiguateShas(repoRoot, rev) : []
  return matches.length > 1
    ? `${rev} is ambiguous: matches ${matches.length} objects in this repository (${matches.join(', ')})`
    : `${rev} does not resolve to an object in this repository`
}

// Normalizes to git's own canonical (full) spelling of a rev, or the raw string unchanged when it
// does not resolve — a licensed --reason override on either closing command can record a well-formed but
// nonexistent reviewedSha (see computeStance's previousRoundSha comment), and this must not throw
// over that. `parseShaLike` admits 7-40 hex, so nothing upstream of this module guarantees any two
// shas naming the same commit are spelled the same way; no sha comparison in this module may depend
// on which spelling either side happened to use.
const normalizeSha = (repoRoot: string, sha: string): string =>
  revParseQuiet(repoRoot, `${sha}^{commit}`) ?? sha

const catFileExists = (repoRoot: string, rev: string): boolean => {
  try {
    git(repoRoot, ['cat-file', '-e', rev])
    return true
  } catch {
    return false
  }
}

const gitLines = (repoRoot: string, args: readonly string[]): string[] =>
  git(repoRoot, args)
    .split('\n')
    .filter((line) => line.length > 0)

// `--no-replace-objects` and an emptied GIT_GRAFT_FILE for the same reason proof-ledger's own git
// calls pass them: a refs/replace ref or a graft file can make a sha resolve to an object that is not
// the one on the branch, which silently changes every range this module reads.
const git = (repoRoot: string, args: readonly string[]): string =>
  execFileSync('git', ['--no-replace-objects', ...args], {
    cwd: repoRoot,
    stdio: 'pipe',
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    env: { ...process.env, GIT_GRAFT_FILE: '/dev/null' },
  }).toString()

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort()

// POSIX single-quoting: the only character that cannot appear inside single quotes is the quote
// itself, which is closed, escaped, and reopened. The emitted command is copied and run by a human,
// so an unquoted path with a space in it would silently become two pathspecs.
const shellQuote = (value: string): string => `'${value.split("'").join(`'\\''`)}'`

const describeExecFailure = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)
