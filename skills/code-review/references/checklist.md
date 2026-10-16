# Code Review — Checklist

Reviewer procedure, framing, and long-form guidance for the Code Review skill. Read this once before your first run of the skill in a session — the procedure in `SKILL.md` is what you execute against. The rules a diff must satisfy — every `- [ ]` item — live in `references/review-rules.md`.

## Overview

**On an adversarial round — round 1, or a round where adversarial mode has re-armed (§Review Stance) — review adversarially, not confirmatorily.** Your job on such a round is not to confirm the code looks right — it's to assume it's broken and find where. The checklist below is a *floor* of things that must hold, not the shape of your attention. For every non-trivial function, branch, loop, or recursion in the diff, actively enumerate the inputs and states that would break it — the empty case, the self-referential case, the cycle, the absent or filtered-out neighbor, the out-of-range boundary — and for each either point to the symbol (or the test, or a quoted literal where no symbol exists) — with the line as a locator beside it — that handles it, or report the break. If you can't name what you tried to break it with, you haven't reviewed it. A bot finding a correctness bug after your clean sign-off is a review **miss**, not an acceptable backstop: reproduce it (per **Verify Against Reality**), fix it, and treat the class it belongs to as something the next review catches first. This targets real correctness and termination defects — it does **not** reverse the over-validation decline in **Boundary Philosophy**; a bot's suggestion to add defensive validation at an internal layer still gets a reasoned decline on the thread.

Review the implementation thoroughly so the user finds **nothing** when they look at the PR. No style issues. No missed requirements. No security gaps. No architectural drift. Nothing.

This skill is followed by the senior engineer as their review workflow. It is NOT invoked as a slash command — it's included in the senior engineer's prompt by Team Dispatch.

## What Is In Scope

**The review surface is the diff. Nothing else.**

```bash
git diff "$(git merge-base origin/main HEAD)..HEAD" --name-only
```

`finding open` classifies every target, and no flag argues with the class:

| The target | Class | The route |
|---|---|---|
| a path that command prints | **shipped** | `finding open`, as always |
| the proofs file, the implementation plan, a proof-ledger capture, a gate-ledger run — `*-proofs.md`, `*-3-impl.md`, `proof-ledger:<id>`, `gate-ledger:<gate>` | a **check** | `finding open --check <capture-id\|gate>`, and only when the capture or gate the claim cites does not support it. Wording, structure and typos are not reviewable: `finding open` refuses a check file without `--check` (exit 16), and `--check` must name a 12-hex capture id or a gate declared for the ticket |
| the PR body, the Jira description, a commit message | a **record** | `review-ledger note add --ticket "<TICKET-ID>" --target pr-body\|jira-description\|commit-message --text "<what to fix>"` — a note to the team lead, who fixes it directly. It opens no finding, fails no round, and no later round re-reads it |
| anything else outside the diff | **outside** | not filable — `finding open` refuses it (exit 16). Report it to the team lead as a process note and let it go |

Two rows refine the **shipped** class for documentation paths (`*.md`, `*.mdx`, `docs/`, except
`skills/` and `agents/`, which are code — see *Delta-scoped rounds* below). The accuracy-polish vs
false-claim call is the senior's; the CLI cannot make it, so the senior passes `--prose` when it
judges the mismatch is accuracy-polish:

| The target | Class | The route |
|---|---|---|
| `--file` is a documentation path and `--prose` is passed | **shipped-prose** | `finding open --prose` routes to `note add --target pr-body` with the file and summary in the note text — it opens no finding, fails no round, exit 0 |
| `--file` is a documentation path and `--prose` is NOT passed | **shipped** | `finding open`, as always — a false claim about program behavior fails the round |

A defect in shipped text that quotes or restates a proofs claim targets the shipped file — it is in
the diff, and needs no other route. A design document the diff disagrees with is filed against the
file in the diff that disagrees with it (*Architecture compliance*), never against the document.

This is not a quality exemption. It is a termination condition. Evidence built to prove a fix is
itself an artifact, and an artifact inside the review surface is reviewable, so a round that commits
new evidence gives the next round more to find than it had. That loop does not converge: findings
per round stay flat while the shipped diff stops changing, and the round count grows without the
change improving.

This termination condition stands even when the defect would otherwise violate a user review
standard. `review-rules.md` §User Review Standards withholds override of an exemption only where
doing so would make a gate unsatisfiable or non-terminating; overriding this one falls on the
second ground, deliberately, not by oversight: a user standard adds a blocking requirement; it does
not repeal the reason this rule exists. Exempting user-standard violations from it would restore
the same non-convergence: a fixture, scratch script, or capture built only to prove this round's
fix would become reviewable again next round solely because a user standard was the rule it
happened to violate.

Two consequences, both binding:

- **A round may not enlarge the review surface.** Fixes go in the diff. Evidence goes in the report
  to the team lead — a pasted command and its output — or into the proof ledger, which is a gate
  rather than a review surface and stays required wherever the review rules require it. What belongs
  in neither is a bespoke fixture or scratch script written to prove one round's fix and then left
  behind for the next round to review.
- **Match the instrument to the claim.** A claim about what a shell construct does is settled by
  running that construct and reading its exit status, in seconds. Building a fixture, recording a
  red and a green, and reviewing both costs a round and proves the same sentence. Reach for a
  purpose-built fixture only where the behaviour cannot be re-run cheaply on demand. This says
  nothing about the proof ledger's red and green captures: where the review rules require those,
  cheapness of re-running is not an exemption from them.

Neither of these caps the number of rounds, and neither lowers the bar. They bound what a round is
allowed to make reviewable.

### The artifacts no gate reads

Nothing mechanical checks what anything this workflow writes under `docs/plans/` in the parent
workspace says: the PRD (`-1-prd.md`), the architecture doc (`-2-arch.md`), the bug summary
(`-1-bug.md`), the change summary (`-1-change.md`), the implementation plan (`-3-impl.md`), the
ticket's proofs file, and the process-improvement notes. That directory is gitignored — so they are
in no diff, no commit, no `check-refs` pass and no CI run, and nothing that reads git can reach
them. The mechanical reads they do get check no sentence: `validate-mermaid` parses a design
document's fenced `mermaid` blocks and `render-diagrams` compiles its fenced `d2` blocks before it is
hosted (`skills/workflow-guide/references/notification-protocol.md` §Phase 0), and hosting copies
the text as written (§Phase 1 there). This is structural rather than an oversight, and it is not a gap a
wider gate would close: CI has no copy of a gitignored file to read, and a hook reading the single
copy on one machine would be a gate whose coverage depended on whose machine ran it.

That none of them is checked does not separate any of them from the others, so it is not what
decides how a defect in one is handled. §What Is In Scope decides it, by class. The PRD, the
architecture doc, the bug and change summaries, and the process-improvement notes are **outside**:
never a target. A diff that disagrees with its design document is a finding against the diff
(*Architecture compliance*), and a design document that is wrong about something the diff does not
touch is a process note. The implementation plan and the proofs file are **checks**: a row in one is
filed only with `--check`, and only when the capture or gate it cites does not support it — a
capture index whose id names nothing on the proof-ledger is that case, and `--check` takes the id
the row cites. Its prose is never a target. This review is not the proofs file's last reader — the
next round's senior reads it against its own sha, and teardown reads the final reviewed sha out of
it (`skills/team-cleanup/SKILL.md` §4. Shut Down Team Members) — which is why a capture it fails to
name is a check that failed, and why nothing else in it is.

**Name the limit wherever you rely on one of them.** A sentence that treats the plan, the proofs
file, or the notes as checked is false, and nothing in the artifact itself reveals that — an
unreviewed one reads exactly like a reviewed one. A round spent on the prose of a file no reader
outside this workspace can open changes no tracked file, and the numbers a reader would reach for to
judge whether a review is converging — a round's finding count, and that count divided by the size
of the delta the round reviewed — cannot tell such a round from a productive one. That is the
reason the classes are enforced by `finding open` rather than stated here.

## Review Stance

**Round 1 is adversarial. Every later round is cleanup, unless adversarial mode has re-armed by the
predicate below.** The stance governs what you go looking for; it never changes the bar. The user —
and any bot reviewer — still finds nothing you didn't already catch, on every round.

The predicate is a command — `review-ledger stance` — not something to evaluate by hand; see *The
re-arming predicate* below. It has nothing to compute at round 1: no round has closed yet, so the
command refuses on whichever precondition it hits first — the ledger file not existing yet, the
anchor being null, or a `--sha`/`--repo-root` git precondition failing before either of those is even
checked — round 1 stays unconditionally adversarial without running it.

### The adversarial round

Round 1, plus any round where the re-arming predicate fires. Run the full procedure in `SKILL.md`
against this round's diff — the full diff, or the delta if this round *also* qualifies as
delta-scoped (the two axes are independent — see *Delta scope and cleanup stance are independent*
below): the Universal Review Checklist, the Work-Type Extra Checks, the Domain-Specific Checklists,
and the enumerate-the-breaking-inputs discipline in §Overview.

### The cleanup round

Every other round. A cleanup round verifies exactly five things:

1. **Each dispatched fix landed** — the commit exists, and it touches the symbol the finding cited.
2. **Each finding the fix was for is discharged** — the defect is no longer present at that symbol.
3. **The edited passages carry no regression** — read the *whole* edited passage, not just the
   changed clause. A scope narrowed to the changed clause misses exactly this class of regression:
   an edit landing mid-line inside an unbroken paragraph can silently absorb everything after it
   into a new block, changing what the passage says without touching the line the diff highlights.
4. **Every caller of a changed helper still matches its contract** — if the fix changed a
   non-exported helper's signature, return shape, or behavior, grep its containing file for every
   call site and confirm each still matches. Do this regardless of whether the re-arming predicate's
   clause (b) fired: clause (b) only catches an *exported* surface change, so a non-exported
   contract break can land a caller-breaking fix while the round stays cleanup.
5. **Every commit in the round's delta that no finding cites gets a content read of its own diff.**
   A commit from `git log "<previous-round-reviewed-sha>".."<pinned-sha>"` is uncited unless some
   finding's `allFixCommits` (`review-ledger show --ticket "<TICKET-ID>"`) holds a value that is a
   prefix of its full sha — the same matching `dischargedPairs`
   (`tools/cli/src/review-ledger/stance.ts`) applies. When the ledger is absent, or records no fix
   commits at all, every commit in the delta counts as uncited. The read is scoped to that commit's
   own diff: a defect found there is a finding like any other, but the read itself does not re-arm
   adversarial mode, does not change the round's stance, and does not widen the round beyond that
   diff.

A cleanup round does **not** re-walk the checklist over the full diff, and does **not** open findings
on text the anchor round already covered (see *The re-arming predicate* below for what "anchor round"
means — it moves when adversarial mode re-arms, it is not always round 1). Text the anchor round
covered and passed is settled; re-opening it is the loop this section exists to cut.

Something outside these five checks that also looks like it might violate a user review standard
still routes under trigger 1 (*Routed lines*), exactly as anything else outside a cleanup round's
scope does. *Routed lines*' own absolute binds **a finding** — it stops the carve-out from disposing
of one a round has actually opened, not the act of routing an observation a cleanup round was never
chartered to adjudicate in the first place. That confirmation happens on an adversarial round, or in
the team lead's own read of the routed line once it reaches them; either way, the finding it becomes
there is where the absolute's guarantee actually bites.

### Delta-scoped rounds — bounding what you read

A round that changes **no production behaviour** is read as a delta, not as a full diff: review
`git diff "<previous-round-reviewed-sha>".."<pinned-sha>"` rather than `git diff origin/main..."<pinned-sha>"`.

`<previous-round-reviewed-sha>` is `reviewedShas[String(<current round> - 1)]` from
`review-ledger show --ticket "<TICKET-ID>"` — the sha the immediately preceding round closed on,
regardless of that round's stance (unlike `<anchor-reviewed-sha>` above, this is never the anchor
round specifically). Read it with `jq -r '.reviewedShas["<N-1>"]'`. A round only reaches this section
after at least one prior round has closed, and every round close appends a `round-reviewed` event
before the `round` event that advances past it (see the `LedgerEvent` comment in `ledger.ts`), so the
entry exists for any round past the first. An absent entry at round 2 or later means the ledger is
missing a record it should have — stop and escalate rather than substituting `origin/main` or the
anchor sha in its place, either of which would silently widen or narrow what gets reviewed.

This is measured, not asserted. A round qualifies on **either** tier. Both tiers, and clause (a)
below, classify a path the same way — clause (c) does not consume this classifier at all; it asks
whether a path is new *territory*, regardless of what kind of file it is: **test** is `*.test.*`,
`*.spec.*`, a file named by its language's colocated-test convention (`*_test.go`, `test_*.py`,
`*_test.py`, `*_spec.rb`, `*Test.cs`, `*Tests.cs`), or anything under a `__tests__/`, `test/`, or
`tests/` directory; **documentation** is
`*.md`, `*.mdx`, or anything under `docs/`, **except anything under `skills/` or `agents/`, which
counts as code**: in this repo those directories are not commentary about the shipped artifact, they
*are* the shipped artifact, so a change there is a production-behavior change and "no code touched"
must not wave it through; **everything else is code** — this explicitly includes an extensionless
script or executable (e.g. `bin/*`), which is code, not a fourth, unclassified kind. A test helper
that is not itself a suite — a fixture, a worker, a spawned child-process entry point — must still
live under one of the test directories above (or match one of the test file names above) for this
classifier to read it as test.

- **Tier 1 — no code touched.** `git diff --find-renames --name-only "<previous-round-reviewed-sha>".."<pinned-sha>"`
  matches no code path (definitions above). Mechanical: if every path in the list is a test file or
  documentation, the tier is satisfied by that output alone.
- **Tier 2 — code touched, comments only.** `git diff -U0 "<previous-round-reviewed-sha>".."<pinned-sha>" -- "<code-path-1>" "<code-path-2>"`
  shows every added and removed line falling inside a comment — pass each code path as its own
  argument after `--`, never joined into one quoted string: git treats a quoted multi-path string as
  a single pathspec that matches nothing, so the diff comes back empty and exits 0 on a genuinely
  nonexistent pathspec exactly as it would on a real zero-line diff, and a round that touched
  production code reads as comment-only. The implementer produces this diff as the round's evidence;
  you verify it by reading that same diff. A changed line that is not a comment fails the tier, and
  the round is a full-diff round. **"Comment" here means prose the compiler,
  linter, and runtime ignore — it excludes any line a tool reads as a directive: a suppression
  comment (`@ts-expect-error`, `eslint-disable`, `eslint-disable-next-line` and siblings), a shebang,
  and a JSDoc/docstring type annotation a type-checker consumes. Any of those in the diff fails the
  tier even though it is syntactically a comment, because it changes compile, lint, or runtime
  behavior — exactly what "no production behaviour" rules out.**

**Scope, not depth.** A delta-scoped round still blocks on everything a full round blocks on. And the
delta is a *starting point for reading*, not a keyhole: read the **whole edited passage** each hunk
sits in, not the changed clause. A mid-paragraph edit boundary can silently absorb the following
text into a new block — visible only by reading the passage, not the hunk.

**Delta scope and cleanup stance are independent.** A round can be delta-scoped and adversarial (the
re-arming predicate fired on a doc-only change — rare but possible via clause (c)), or full-diff and
cleanup. Evaluate each separately and report both.

### Routed lines

A **routed line** goes back to the team lead as file, symbol, one sentence, and whether it violates
a user review standard — and nothing more; the senior states that last fact, it does not argue it.
A routed line is **not** a finding: it does not block approval, it is not recorded in the findings
ledger with status `open`, and it does not by itself justify another round. The team lead decides
whether an unmarked routed line becomes a finding, a ticket, or nothing; a routed line marked as
violating a user review standard is bound by the team lead's must-open duty
(`skills/team-dispatch/SKILL.md` step 20, *Open a routed line before disposing of it*). A senior may
not hold approval on a routed line.

**Trigger 2 (one bite per site) never routes a finding that violates a user review standard.**
`review-rules.md` §User Review Standards makes those rules additive-only — never relaxed,
overridden, or waived by *this carve-out* — and letting trigger 2 route such a finding would be
exactly such a waiver. Trigger 1 (something outside a cleanup round's scope) routes an observation
that was never a finding to begin with — a cleanup round cannot open findings outside its five
checks. Both triggers set the same marker; the must-open duty is what turns a marked line into a
finding, not the point either trigger routes it. This binds the routed-line carve-out only. Other
mechanisms in this checklist also keep a defect from blocking approval, and each states its own
relationship to user standards at its own site wherever `review-rules.md` §User Review Standards
obligates it — not here.

Two things route. Trigger 1 applies on a cleanup round; trigger 2 binds on every round, adversarial
or cleanup.

**1. Something outside a cleanup round's scope.** A cleanup round that meets something its five
checks do not cover returns it as a routed line rather than opening a finding on it.

**2. One bite per site.** Once a finding against a `(file, symbol)` has been discharged with a
`--fix-commit`, a later finding against the **remediation prose** at that same `(file, symbol)` is a
routed line. The site has had its bite. `file` and `symbol` establish the site; a finding's
`allFixCommits` — every commit any status event has ever named for it, not only the latest
`fixCommit`, and counting only a commit that is an ancestor of the pinned sha — establishes that the
prose is remediation, so the prose must be text one of those commits wrote or rewrote — read `git
show "<each fixCommit>"` to check each one. A finding fixed, reopened, and fixed again under a
different commit carries remediation prose under more than one of them; checking only the latest
`fixCommit` can miss an earlier one. Prose at a discharged symbol that no recorded fix commit
touched, or whose recorded fix commits include none that is an ancestor of the pinned sha, is an
ordinary finding.

**One bite per site governs prose. Anything that is not prose is governed by the ordinary bar, on
every round.** The routed side is comments, docstrings, error strings, doc paragraphs and PR
sentences — text whose defect is that it could be more accurate. A discharged site whose *code* is
wrong is a fix that is incorrect, and a fix that is incorrect is a finding on any round. Ask whether
the finding is against prose before asking anything else.

**An error string that is merely imprecise routes with the rest; shipped text that makes a false
claim about what the program does is not imprecision.** A refusal string naming an exit code the
command does not return, or a message telling an operator to run something and stating a result that
command does not produce, is the program telling its user something untrue about itself. The test is
whether a reader who believes the text and acts on it ends up somewhere the text said they would not.

**To block on that basis at a discharged site, demonstrate the divergence.** Name the input state,
what the text claims happens, and the outcome that differs — citing either a captured run or the
control flow that decides it (the guard, the branch, the symbol). A claim about a branch is
demonstrated by the guard order that decides it, which no single run can exhibit. Without a named
divergence it is a routed line, however wrong the text reads: *a reader might act on this and be
surprised* is available against almost any string, and a criterion evaluated in the reviewer's head
is the one this rule exists to replace. This gate is one of the exits this section gives from
*One bite per site*; it adds nothing to a site that rule never reached.

### The re-arming predicate

The predicate answers one question: has anything changed, or come newly into view, since the last
time a senior looked at everything — the most recent adversarial round — that a cleanup round isn't
licensed to wave through? Adversarial mode re-arms for round N when **any** clause below fires against
`git diff "<anchor-reviewed-sha>".."<pinned-sha>"`. Each clause is a command whose output either fires or
does not.

`<anchor-reviewed-sha>` and `<anchor-round>` are `resolvedAnchor.reviewedSha` and `resolvedAnchor.round`
from `review-ledger show --ticket "<TICKET-ID>"`. `resolvedAnchor` is set only by a `round-reviewed`
event whose stance is `adversarial`. `null` means no round has closed with an adversarial stance — a
stop-and-escalate, never a value to default past. A cleanup round never moves the anchor.

**The ledger must be current with respect to the branch before evaluating.** Clause (b)'s new-scope
exclusion reads `allFixCommits` off the ledger to tell prior-round-demanded remedy apart from
new work. Commit, then dispose with `--fix-commit`, then evaluate the predicate — never in between; a
commit that has landed but isn't yet disposed reads as new-scope with no exemption. The same ordering
applies to any externally-raised finding (CodeRabbit, a human comment, the user) — open it, dispose it
with `--fix-commit` when the fix lands, and only then evaluate.

**Run the command; do not hand-execute the recipe.** This applies from round 2 on — at round 1
`resolvedAnchor` is unconditionally `null`, so skip straight to *The adversarial round* above instead
of running anything. `review-ledger stance --ticket "<TICKET-ID>"
--sha "<pinned-sha>"` evaluates this predicate and prints the answer as JSON: `stance`
(`adversarial` / `cleanup` / `undetermined`), a per-clause verdict with the paths or pairs that drove
it, `anchorRound` / `anchorSha` / `previousRoundSha`, and the delta tier. Exit `0` means it computed
a stance; `8` means the ledger file doesn't exist yet; `10` means `undetermined`; `11` means the null
anchor this section already calls a stop-and-escalate; `12` means a git precondition failed and no
verdict downstream of it can be trusted; `13` means the previous round's reviewed sha came back null
at report round 2 or later — the ledger is missing a `round-reviewed` record it should have, the
stop-and-escalate *Delta-scoped rounds — bounding what you read* above names; `14` means a recorded
reviewed sha — the anchor round's or a previous round's — no longer resolves, or resolves but is no
longer an ancestor of the pinned sha: branch history was rewritten since it was recorded, and this is
a stop-and-escalate — no command re-records a prior round's reviewed sha, so pass `--reason` to
the close (`next-round`, or its deprecated alias `round-close`) to proceed
deliberately, or investigate why the ledger and the branch disagree. This
table is exhaustive for what `computeStance` itself can return, and only that: a malformed
`--sha`/`--anchor`/`--ticket` never reaches `computeStance` at all — Stricli's own argument parsing
refuses it first, exiting `252` before the command body runs.

The clause table and the recipes below it are the **definition** the command implements, and they
remain what you run in exactly one case: `clauses.b.verdict` is `undetermined`, which happens only
when at least one new-scope pair survives the pre-filter in *Checking clause (b)* below (a
declarable extension, present at both sides of the pair, inside the one package the declaration diff
can compile). The report lists those surviving pairs in `clauses.b.pairs` — run *Checking clause (b)*
over those and nothing else. `clauses.b.verdict` is `did-not-fire` on two distinct causes the report's
own `clauses.b.note` names: the new-scope set was empty, or it was non-empty but every pair was
dropped by the pre-filter before any pair could survive it — either way, there is nothing left to
compile.

`undetermined` is not `cleanup`. A round whose computed stance is `undetermined` is reviewed
adversarially unless you resolved the undetermined clause yourself and say in your report which
recipe you ran and what it returned.

**Report the computed stance, and close the round with it.** The senior states the computed stance in
the review report; the team lead is the one who closes the round and declares it, on every round end
including the approved one, running `review-ledger next-round --ticket "<TICKET-ID>" --reviewed-sha
"<sha>" --stance "<adversarial|cleanup>"`. Every close advances, whether the round that follows is
another review round or the ticket's terminal one, so there is no separate terminal verb to choose:
`review-ledger round-close --ticket "<TICKET-ID>" --reviewed-sha "<sha>" --stance
"<adversarial|cleanup>"` is a deprecated alias for that same command and does the same thing.

Run it once per round. Running the second verb after the first does not close anything again — the
counter has already moved, so the round the second call names is the fresh one, and it refuses
whichever order the two names are used in. Which code it refuses with depends on what that fresh
round carries: **exit 20** while it holds no senior, no finding and no review start, which is the
state a re-run typed straight after the close finds it in; **exit 21** once that round carries any
mark — a senior recorded for it, a finding raised in it, or a review start — because the sha the
second call passes is then still the one the closed round already stamped.

Three guards stand at that close and they do not compose to something total, so read what each covers
rather than assuming they are a wall:

- **Exit 20** fires on a round carrying no senior, no finding raised in it and no review start, on
  either command. An instruction dispatched in the round is not a mark: it means the lead typed, not
  that anyone reviewed, and it accumulates in the hundreds on an ordinary ticket.
- **Exit 21** fires on a close at a sha some earlier round already recorded, under either command
  name, once the round being closed carries a mark — the sha check itself ignores the marks, but
  exit 20 refuses an unmarked round before it runs. One cause is the stray re-run of a command still
  in the scrollback, after the close has advanced past the round it names and something has since
  marked the round it now lands on. `--sha-reuse-reason` licenses the other, a re-review of a sha
  that did not move because the previous round's findings were all ruled invalid, and records the
  licence on the ledger. The refusal cannot tell the two apart, which is why the licence is a flag
  you pass rather than something it infers.
- **Exit 27** fires on a round whose review its senior has not recorded complete, on a ledger where
  any round has a `review start`: until `review-ledger review complete` lands, the round's finding
  set may be partial. A senior gone before recording it is licensed by the `--senior-condition` and
  `--senior-reason` pair exit 17 takes, recorded on the round's close. A ledger with no review events
  never arms it.
- **None** catches a genuinely reviewed round closed at a new but *wrong* sha. On a ledger whose
  senior recorded its review, `reviews["<n>"].sha` in `review-ledger show` is the sha to compare
  against — but nothing compares it automatically, so the round closes, the stamp is wrong, and
  `review-ledger show` read against the commits the round actually reviewed is what finds it.

**Exit 19 is a different refusal from any of those, and it is the one with a separate remedy.** It
fires when the round is already closed. On a ledger written before every close advanced, that is a
wedge rather than a stray: the round is closed and the counter still points at it, so no close will
ever move it. `review-ledger round-advance --ticket "<TICKET-ID>" --reason "<why the counter is
moving without a close>"` appends the one missing advance and repairs nothing else. It takes no
`--round` — on a wedged ledger the wedged round is the current one — and it refuses with exit 25 if
the current round is not closed, which is what makes re-running it safe.

When an exit 20 is genuinely wrong — the round really was reviewed — `review-ledger senior shutdown
--ticket "<TICKET-ID>" --round N --agent-id X` clears it and, once every outstanding senior on the round has its own shutdown
recorded, the exit-17 refusal too — one call per outstanding agent id, not one call per round.
`senior spawned` clears exit 20 as well, and leaves that senior owing a teardown; the close is then
subject to the remaining guards in order, so which refusal the retry meets depends on the sha it
passes, the review its senior has or hasn't recorded, and the stance it computes. On a ledger armed
by a `review start`, a round refused with exit 20 also meets exit 27 on retry, which the
`--senior-condition`/`--senior-reason` pair licenses.

That command checks the declared value against this predicate's own computation
only when the computation is **decided** (`adversarial` or `cleanup`) — it refuses a contradiction
unless `--reason` licenses it, and the reason lands on the ledger permanently. When the computation is
`undetermined` there is nothing decided to check the declaration against, and the command lets any
declared stance through with no refusal at all; the control for that case is the senior's own report
of which *Checking clause (b)* recipe run they performed and what it returned, not this command.

| Clause | Fires when |
|---|---|
| **(a) New or deleted non-test, non-doc file** | `git diff --find-renames --name-status "<anchor-reviewed-sha>".."<pinned-sha>"` contains an `A` or `D` line whose path is not test and not documentation (*Delta-scoped rounds — bounding what you read* above — a new `bin/*` script is code, and fires this clause) |
| **(b) Exported surface changed** | Restricted to **new-scope (commit, path) pairs** — see *New-scope commits* below. The emitted type declaration for at least one exported symbol in a new-scope pair's path differs between that commit's own parent and the commit itself — see *Checking clause (b)* below. A body-only or comment-only edit does not fire; an added, removed, or altered exported parameter, type, or return type does, and only for work no prior round already demanded |
| **(c) New territory** | `git diff --find-renames --name-only "<anchor-reviewed-sha>".."<pinned-sha>"` contains a path absent from **the union of** `git diff --find-renames --name-only origin/main..."<anchor-reviewed-sha>"` and every path named by a finding raised in round 1 through the anchor round — see *Checking clause (c)* below |

**New-scope commits.** A commit that only implements what an earlier round explicitly demanded is not
new scope for *this* round to re-litigate, even when it legitimately changes an exported signature.
Exclude those commits before asking whether anything *else* changed the exported surface — by
(commit, path) pair, not by commit alone, and never filtered by which round raised the finding: a
commit discharging a round-2 finding is exactly as much "already demanded" as one discharging a
round-1 finding, and every later round has to recognize both. A finding's `fixCommit` also drops to a
new value on every later status transition, including a reopen-and-refix, so exclude a commit once it
has *ever* been named as a finding's fix — not only by the currently recorded value — or a commit
that discharged an earlier occurrence of a finding, then got superseded by a later fixCommit on the
same finding, would silently re-enter new scope.

```bash
# without this, `$?` after any pipe below reads the last stage's exit status only — a failing
# `review-ledger show` piped into a succeeding `jq`/`sort` reports success, and every guard in this
# block that trusts `$?` goes silent exactly when it matters most:
set -o pipefail

# every (commit, path) pair this round's range touches, diffed against each commit's own first
# parent, not the combined diff — a clean merge that resolves entirely to one side can match every
# parent on some paths while still changing others relative to the first, and the first-parent
# diff is the one that catches that case (the same comparison *Checking clause (b)* performs). A
# root commit falls back to the empty tree since it has no parent to diff against:
EMPTY_TREE="$(git hash-object -t tree /dev/null)"
git log --format=%H "<anchor-reviewed-sha>..<pinned-sha>" | while read -r sha; do
  parent1="$(git rev-parse --verify --quiet "$sha^1")" || parent1="$EMPTY_TREE"
  git diff --name-only "$parent1" "$sha" | sed "s|^|$sha |"
done | LC_ALL=C sort -u > /tmp/round-pairs.txt

# every (commit, path, finding id) triple the ledger records as discharged, commit resolved by
# prefix match against this round's own commits, over every fixCommit a finding has ever had (not
# only its current value) — one jq expression, no shell loop, no git call. The collision guard's
# error(...) call is jq's only way to halt this recipe from inside the filter, and a trailing
# `| sort` would report sort's exit status instead and let the guard's failure pass silently — so
# jq's own output is captured and checked before anything downstream can read it, and a failed
# guard exits this recipe immediately, the same way the commit-gap and construction-gap guards
# below do, rather than letting cut and comm run against an incomplete /tmp/discharged-triples.txt.
# `set -o pipefail` above covers the other way this pipe can fail: `review-ledger show` itself
# erroring or wedging with no stdout, which the guard below could not otherwise distinguish from a
# real empty ledger — see "Sweep the class" further down, which classifies other pipelines in this
# recipe by what an unread failure there actually does:
rm -f /tmp/discharged-triples.txt
review-ledger show --ticket "<TICKET-ID>" | \
  jq -r --rawfile pairsraw /tmp/round-pairs.txt '
    ( $pairsraw | rtrimstr("\n") | split("\n") | map(select(length > 0))
        | map(capture("^(?<sha>[0-9a-f]+) (?<path>.*)$")) ) as $pairs
    | ( $pairs | map(.sha) | unique ) as $shas
    | ( [ .findings[]
          | . as $f
          | ($f.allFixCommits // [])[]
          | . as $fixCommit
          | ($shas | map(select(startswith($fixCommit)))) as $m
          | if ($m | length) > 1
            then error("ambiguous fixCommit " + $fixCommit + " on finding " + $f.id
                        + " matches " + ($m | join(",")))
            else empty end
        ] ) as $collision_guard
    | [ .findings[]
        | . as $f
        | ($f.allFixCommits // [])[]
        | . as $fixCommit
        | ($shas | map(select(startswith($fixCommit)))) as $m
        | ( if ($m | length) == 1 then $m[0] else empty end ) as $full
        | $pairs[]
        | select(.sha == $full and .path == $f.file)
        | "\(.sha) \(.path) \($f.id)"
      ][]
  ' > /tmp/discharged-triples.raw
if [ $? -ne 0 ]; then
  echo "the discharge jq pipeline failed — see jq's own error above for the cause (an ambiguous fixCommit collision, a missing /tmp/round-pairs.txt, and malformed 'review-ledger show' output are examples, not the full list); resolve it before proceeding" >&2
  exit 1
fi
LC_ALL=C sort -u /tmp/discharged-triples.raw > /tmp/discharged-triples.txt
rm -f /tmp/discharged-triples.raw

LC_ALL=C cut -d' ' -f1,2 /tmp/discharged-triples.txt | LC_ALL=C sort -u > /tmp/discharged-pairs.txt

LC_ALL=C comm -23 /tmp/round-pairs.txt /tmp/discharged-pairs.txt > /tmp/new-scope-pairs.txt
if [ $? -ne 0 ]; then
  echo "comm failed computing new-scope-pairs from /tmp/round-pairs.txt and /tmp/discharged-pairs.txt" >&2
  exit 1
fi

# commit coverage (primary) and path coverage (secondary) — both appended here, right after
# construction and discharge derivation finish and before any later fence treats round-pairs.txt
# as complete:

# every commit in range whose own tree actually changed, via tree-hash comparison rather than
# diff emptiness (an empty commit or an `-s ours` merge both have an empty first-parent diff
# without being a construction defect):
git log --format=%H "<anchor-reviewed-sha>..<pinned-sha>" > /tmp/contributing-commits-shas.txt
if [ $? -ne 0 ]; then
  echo "git log failed building the contributing-commits sha list from <anchor-reviewed-sha>..<pinned-sha>" >&2
  exit 1
fi
while read -r sha; do
  parent_tree="$(git rev-parse --verify --quiet "$sha^1^{tree}")" || parent_tree="$EMPTY_TREE"
  if [ "$(git rev-parse "$sha^{tree}")" != "$parent_tree" ]; then echo "$sha"; fi
done < /tmp/contributing-commits-shas.txt | LC_ALL=C sort -u > /tmp/contributing-commits.txt
if [ $? -ne 0 ]; then
  echo "sort failed building /tmp/contributing-commits.txt from /tmp/contributing-commits-shas.txt" >&2
  exit 1
fi

LC_ALL=C comm -23 /tmp/contributing-commits.txt \
  <(LC_ALL=C cut -d' ' -f1 /tmp/round-pairs.txt | LC_ALL=C sort -u) > /tmp/commit-gap.txt
if [ $? -ne 0 ]; then
  echo "comm failed computing commit-gap from /tmp/contributing-commits.txt" >&2
  exit 1
fi

# each side materialized to its own file with its own `$?` check, not read from a process
# substitution directly — a failing left-hand substitution here would go undetected in the same
# direction as the exit-status-masking defect above (comm -23 reports fewer paths as gapped, not
# more); see "Sweep the class" below for why the commit-gap comm above's right-hand process
# substitution — a separate site from the comm's own left-hand failure, already checked above via
# `$?` — needs no such per-side materialization: its failure direction is already safe.
git diff --name-only "<anchor-reviewed-sha>..<pinned-sha>" > /tmp/construction-gap-lhs-raw.txt
if [ $? -ne 0 ]; then
  echo "git diff --name-only failed while building the construction-gap left side — <anchor-reviewed-sha>/<pinned-sha> is likely bad" >&2
  exit 1
fi
LC_ALL=C sort -u /tmp/construction-gap-lhs-raw.txt > /tmp/construction-gap-lhs.txt
if [ $? -ne 0 ]; then
  echo "sort failed building the construction-gap left side from /tmp/construction-gap-lhs-raw.txt" >&2
  exit 1
fi
LC_ALL=C cut -d' ' -f2- /tmp/round-pairs.txt | LC_ALL=C sort -u > /tmp/construction-gap-rhs.txt
if [ $? -ne 0 ]; then
  echo "cut/sort failed while building the construction-gap right side from /tmp/round-pairs.txt" >&2
  exit 1
fi
LC_ALL=C comm -23 /tmp/construction-gap-lhs.txt /tmp/construction-gap-rhs.txt > /tmp/construction-gap.txt
if [ $? -ne 0 ]; then
  echo "comm failed computing construction-gap from /tmp/construction-gap-lhs.txt and /tmp/construction-gap-rhs.txt" >&2
  exit 1
fi

if [ -s /tmp/commit-gap.txt ]; then
  echo "COMMIT GAP: the following commit(s) changed a tree across <anchor-reviewed-sha>..<pinned-sha> but /tmp/round-pairs.txt has no line for them — everything downstream (Reporting clause (b)'s own reports and verdict, and both accounting identities) would proceed on a missing denominator:" >&2
  cat /tmp/commit-gap.txt >&2
  exit 1
fi
git rev-list --first-parent "<pinned-sha>" > /tmp/first-parent-chain.txt
if [ $? -ne 0 ]; then
  echo "git rev-list --first-parent failed — <pinned-sha> is likely bad" >&2
  exit 1
fi
anchor_sha="$(git rev-parse "<anchor-reviewed-sha>")"
if [ $? -ne 0 ]; then
  echo "git rev-parse failed to resolve <anchor-reviewed-sha> — it is likely bad" >&2
  exit 1
fi
if LC_ALL=C grep -qx "$anchor_sha" /tmp/first-parent-chain.txt; then
  if [ -s /tmp/construction-gap.txt ]; then
    echo "CONSTRUCTION GAP: the following path(s) changed across <anchor-reviewed-sha>..<pinned-sha> but /tmp/round-pairs.txt has no line for them — everything downstream (Reporting clause (b)'s own reports and verdict, and both accounting identities) would proceed on a missing denominator:" >&2
    cat /tmp/construction-gap.txt >&2
    exit 1
  fi
else
  echo "SKIPPED: unsound denominator — <anchor-reviewed-sha> is off <pinned-sha>'s first-parent chain" > /tmp/construction-gap.txt
  echo "CONSTRUCTION GAP SKIPPED: <anchor-reviewed-sha> is not on <pinned-sha>'s first-parent chain, so the net range diff is not a sound denominator here — off-chain, a path can differ between the endpoints because the anchor sits off the line, not because anything changed along it, and /tmp/round-pairs.txt is correct to omit it; no sound off-chain denominator exists except the union of per-commit first-parent diffs, which is /tmp/round-pairs.txt itself, so skip is the only option, not a shortcut. Coverage lost: partial emission where the lost path is touched by no other commit in range — COMMIT GAP is unaffected." >&2
fi
```

`COMMIT GAP` and `CONSTRUCTION GAP` both `exit 1` and halt the recipe — a missing denominator
invalidates everything downstream, including *Reporting clause (b)*'s verdict and both accounting
identities. `CONSTRUCTION GAP`'s own denominator (the net range diff) is sound only when
`<anchor-reviewed-sha>` lies on `<pinned-sha>`'s first-parent chain; off-chain the guard above skips
instead of false-firing and writes a sentinel line to `/tmp/construction-gap.txt`, so a skip is never
mistaken for a pass — no `exit 1`, since the range is fine and only the denominator is not. Commit
coverage carries no such precondition: its own left side is `git log`, not a net diff.

**What `set -o pipefail` fixes above, and the one further pipe it can break outright.** The defect
fixed above is a *guarded* pipe reading the wrong stage's exit status; `set -o pipefail` fixes it
because something
(`if [ $? -ne 0 ]`) reads `$?` right after. `pipefail` can also break a pipe outright: when the
last stage exits before its producer finishes writing, the producer dies of `SIGPIPE` and
`pipefail` reports *that* death — not the last stage's real exit status. The first-parent chain
check that used to gate `CONSTRUCTION GAP`, `git rev-list --first-parent "<pinned-sha>" |
LC_ALL=C grep -qx …`, has that shape: `grep -qx` exits at its first match, so on a first-parent
chain long enough to exceed the pipe buffer before the match is found, `pipefail` turned a true
(on-chain) result into a reported failure, skipping `CONSTRUCTION GAP` on ranges it should have
checked. It is fixed above by materializing `git rev-list` to `/tmp/first-parent-chain.txt` with
its own `$?` check and running `grep -qx` against that file instead of a pipe — not by scoping or
removing `pipefail`, which the guarded pipe above still needs.

**Sweep the class: commands whose exit status nothing reads, classified by what the silent failure
actually does.** A syntax-keyed sweep — grep for a pipe, for `<(...)`, for `$(...)` — only ever
certifies the shapes it was told to look for, and each fix introduces a new construct the next grep
cannot match; a bare `sort -u > file` or `comm -23 A B > file` is neither a pipe, a process
substitution, nor a command substitution, and three consecutive sweeps missed both. What follows is
a set of commands and pipelines read by hand across the review recipe (fences 1 through 8) and the
separate sweep-count illustration further down (fence 9), each classified by what an unread failure
of that specific command actually produces downstream — commands and sites a reviewer can consult
and extend, not a certified-complete population. A command absent from this list has not been
checked against it, and is not cleared by its absence.

*Fixed this round:*

- The `comm -23` building `/tmp/commit-gap.txt` — `comm`'s own failure (its left-hand file
  unreadable, say) empties or truncates `/tmp/commit-gap.txt`, which `[ -s ... ]` reads as "no
  gap"; the right-hand process substitution feeding the same `comm` fails in a different,
  safe direction, analyzed separately below. Checked now with `[ $? -ne 0 ]` immediately after.
- The `comm -23` building `/tmp/construction-gap.txt` — the exact defect the sort-steps finding
  was raised against, one stage downstream of the two inputs this file already checks: both inputs
  are guarded, the `comm` that reads them was not, and its failure produces the identical
  empty-file/`[ -s ... ]`-false symptom. Checked now the same way.
- *Checking clause (c)*'s terminal `comm -23`, printed directly rather than redirected to a file —
  a failure here prints nothing for the reviewer to iterate over, indistinguishable from a genuine
  empty result. Checked now the same way.
- The `tr '\n' ' ' | grep -o 'hard stop' | wc -l` sweep-count example under *A widened sweep class
  is a finding generator, not a convergence check* — the one command in this population that sits
  outside the recipe above. This one is not an exit-status defect on
  its original shape: `tr` and `grep` both succeed, exit 0, on every run. The defect is that the
  command named its subject by a bare relative path, so its answer silently depended on the
  reviewer's ambient working directory — run from this repo's worktree it counted one file, run
  from the main checkout one directory up it counted a different one, both times with a plausible,
  non-zero, correctly-formatted count and no error on either stream. The class-exhaustion judgement
  two paragraphs below this fence reads that count directly, so this was never a case nothing
  decides on. First fixed by resolving and printing an absolute path beside the count — which
  turned out to be a second instance of the same defect one level up: `cd "$(dirname "$CHECKLIST")"`
  still resolves against the reviewer's own directory, so a directory with no
  `skills/code-review/references/` beneath it (this repo's own workspace root, holding several
  checkouts as siblings rather than being one, is exactly such a place) made the `cd` fail, the
  `$(...)` collapse to empty, and the fence print a well-formed-looking `counting /checklist.md`
  beside a confident `0` — a made-up location asserted with more authority than the bare number it
  replaced, not a bare number itself, and worse for it. Fixed for real by anchoring to
  `git rev-parse --show-toplevel` instead of the reviewer's cwd, and refusing to report anything —
  no path, no count, `exit 1` — when the resolved checkout has no such file, rather than let a
  confident absolute path assert a location nothing backs. The `echo "counting $CHECKLIST"` line
  this leaves behind is itself unguarded but display-only: the count two lines later comes from its
  own independent `tr`/`grep`/`wc -l` pipe reading the same now-verified `$CHECKLIST`, not from
  anything this echo does, so a failure here would only cost the label, not the count.
- `git log --format=%H "<anchor-reviewed-sha>..<pinned-sha>"` feeding `/tmp/contributing-commits.txt`
  — materialized to its own file, `/tmp/contributing-commits-shas.txt`, with its own `$?` check, so a
  bad `<anchor-reviewed-sha>`/`<pinned-sha>` endpoint is reported by name here rather than surfacing
  downstream as a misattributed failure of the terminal `sort` that reads from it.
- The terminal `LC_ALL=C sort -u > /tmp/contributing-commits.txt` that closes the tree-hash loop — a
  failed `sort` empties or truncates the file, which is the commit-gap `comm -23`'s own left-hand
  operand; an empty left-hand operand makes `comm -23` report nothing as gapped,
  `[ -s /tmp/commit-gap.txt ]` reads false, and `COMMIT GAP` never fires — silent, and the `comm`'s
  own `$?` check immediately below it cannot see this failure, since `comm` still exits 0 against an
  empty-but-readable left operand. The loop's own last iteration can also trip this guard, though not
  unconditionally: its body ends in an `if [ ... ]; then echo "$sha"; fi` compound, which returns 0
  whether or not the inner `git rev-parse "$sha^{tree}"` succeeded — that command runs inside a
  command substitution used as a `[` operand, so its own exit status is discarded before the `if`
  ever sees it, and a failing tree lookup instead yields an empty comparison operand, over-inclusive
  rather than silent (already covered below, in the `EMPTY_TREE`/tree-equality bullet). But when the
  branch is taken, the compound's own exit status is `echo`'s, not an unconditional 0; with
  `set -o pipefail` live above, a failing `echo` (a closed stdout, a full disk) reaches this same
  guard and prints "sort failed" for a `sort` that never actually ran against bad input — a narrow,
  real misattribution this fence accepts rather than a guarantee the loop cannot trigger it. The
  per-commit row emitter bullet below rests its own fail-loud verdict on this file "still list[ing]
  that commit" independently of `/tmp/round-pairs.txt` — a claim that only holds once this file's own
  construction is itself guarded, which this fix is. Checked now with `[ $? -ne 0 ]` immediately
  after the loop's pipe into `sort`.
- `git diff --name-only "<anchor-reviewed-sha>..<pinned-sha>"` feeding
  `/tmp/construction-gap-lhs.txt` — the same class as the `git log` split above, on the
  construction-gap left side rather than the commit-gap left side: materialized to its own file,
  `/tmp/construction-gap-lhs-raw.txt`, with its own `$?` check, so a bad `<anchor-reviewed-sha>`/
  `<pinned-sha>` endpoint is reported by name here rather than surfacing downstream as a
  misattributed failure of the terminal `sort` that reads from it. Unlike the right side's
  `cut`/`sort` guard two bullets below, `git diff --name-only` is a single command that can be
  isolated cheaply, the same way `git log` was above — so this one gets its own name instead of
  sharing a message with `sort`.

*Checked against this round's classes and found out of scope, with a stated reason:*

- The clause (b) emit-check, `[ ! -f "/tmp/decls-before/$declpath" ] || [ ! -f "/tmp/decls-after/$declpath" ]`
  — the same missing-vs-unreadable gap fence 9's `[ ! -r ]` fix closes, but not the same threat
  model: `/tmp/decls-before` and `/tmp/decls-after` are created by `tsc --outDir` moments earlier in
  this same process, under this same user, so nothing between that write and this read can leave the
  file present but unreadable to the process that just created it — unlike fence 9's
  `$CHECKLIST`, which names a file in a checkout this recipe did not create and cannot assume
  permissions on. No `[ ! -r ]` added here.

*Unguarded, but fail-loud — a bad read here degrades the result in a direction later logic already
catches, not a further finding:*

- The `comm -23` building `/tmp/new-scope-pairs.txt` (clause (b)'s own input) — a failed `comm`
  truncates or empties that file; *Checking clause (b)*'s guard-computation loop reads it directly
  (`done < /tmp/new-scope-pairs.txt`), so an empty file drives `/tmp/guard-skipped-pairs.txt` and
  `/tmp/guard-examined-pairs.txt` toward zero. `excluded` is derived independently, from
  `/tmp/discharged-pairs.txt`, not from this file — independence is exactly what makes the first
  accounting identity catch it: `guard_skipped + examined` come up short against the untouched
  `total`, and the mismatch fires. Fail-loud, not silent; the `$?` check added here is a
  diagnostic-precision improvement (fails immediately, at the actual point of failure, with a
  message naming it), not a silent-pass fix.
- The right-hand process substitution `<(LC_ALL=C cut -d' ' -f1 /tmp/round-pairs.txt |
  LC_ALL=C sort -u)` feeding the commit-gap `comm -23` — a failing `cut` or `sort` here starves the
  substitution, and `comm` reads an empty or truncated second operand; an empty right-hand set for
  `comm -23` can only make the left side (`/tmp/commit-gap.txt`) *larger*, flagging more commits as
  gapped than actually are, not fewer — over-inclusive, the safe direction, distinct from `comm`'s
  own left-hand failure fixed above.
- `excluded=$(comm -12 /tmp/round-pairs.txt /tmp/discharged-pairs.txt | wc -l)` in the accounting
  identity — the `$?` check this pipeline carried was reading `wc -l`'s own exit status, not
  `comm`'s, and `wc -l` succeeds (exit `0`) whether it counts a real zero lines or the empty stream
  a failing `comm` produces. The site was never silent, though: the identity's own closing
  comparison (`total -ne excluded+guard_skipped+examined`) reaches a real mismatch once `excluded`
  comes out wrong and the other two terms don't — this fence is one of 9 separate bash blocks with
  no guarantee they run in one continuous shell session carrying an earlier fence's
  `set -o pipefail` forward, but the identity's arithmetic doesn't depend on `pipefail` either way.
  What the old check's message got wrong was coverage, not outcome — it claimed to detect a `comm`
  failure it could not actually observe. Rebuilt the way every other `comm`/`sort` site in this
  file already is: materialized to its own file (`/tmp/excluded-pairs.txt`) with its own `$?`
  check, then `wc -l <` that file separately, so the check and its message now agree about what
  failed and where.
- The terminal `LC_ALL=C sort -u > /tmp/round-pairs.txt` closing that same loop — a failed `sort`
  here empties or truncates the file, which every later clause reads as its own primary input:
  `total`, the discharge jq pipeline, `new-scope-pairs.txt`, and both the commit-gap and
  construction-gap right-hand operands (`cut -f1`/`cut -f2-` over this same file) all shrink toward
  empty with it. An empty right-hand operand for either `comm -23` is over-inclusive, not
  under-inclusive — confirmed against a fixture with a populated `/tmp/contributing-commits.txt`
  and an empty `/tmp/round-pairs.txt`: the commit-gap `comm -23` reported every contributing commit
  as gapped, `COMMIT GAP` fired, `exit 1`. The recipe halts here before the accounting identities
  further down are ever reached, so their own arithmetic never has to cover this case.
- Inside the same loop, the per-commit row emitter — `git diff --name-only "$parent1" "$sha" |
  sed "s|^|$sha |"` — is a distinct failure source from `git log`/the endpoint being bad, and from
  the loop's own terminal `sort` above: a `git diff` or `sed` failure on one iteration silently
  drops only that commit's rows from `/tmp/round-pairs.txt`, leaving the rest of the file, and the
  terminal `sort`'s own exit status, untouched. `/tmp/contributing-commits.txt`, built independently
  by the tree-hash loop below and guarded by its own `$?` check above, still lists that commit; the
  `COMMIT GAP` check further down catches the mismatch and halts the recipe — fail-loud, not silent.
- The ten `printf … >>` appends across the two `while` loops in *Checking clause (b)* — five in the
  guard-computation loop (`non-ts-extension`, `out-of-package`, `absent-at-parent`,
  `absent-at-commit`, and the loop's own success append to `/tmp/guard-examined-pairs.txt`) and
  five in the declaration-diff loop (`emit-missing`, `own-file-type-error`,
  `module-resolution-error`, `diff-trouble`, and the loop's own success append to
  `/tmp/diffed-pairs.txt`) — a failed append drops that pair from every list it could otherwise
  land in. Nine of the ten leave `total` and `examined` themselves unchanged, dropping only from a
  file whose count is compared against one of those two, not from the file that count *is* — the
  guard-computation loop's own success append is the one exception, since it writes
  `/tmp/guard-examined-pairs.txt` directly and `examined` is that file's own line count, so a
  failure there reduces `examined` itself. Either way the first accounting identity catches a
  dropped guard-computation-loop append (the sum comes up short against `total`, whether because a
  skip-list undercounts or because `examined` itself just did) and the second catches a dropped
  declaration-diff-loop append (the sum comes up short against `examined`) — fail-loud in
  both, and the same `/tmp`-writable precondition the truncations below share.
- `EMPTY_TREE="$(git hash-object -t tree /dev/null)"` and the tree-equality test
  `[ "$(git rev-parse "$sha^{tree}")" != "$parent_tree" ]` — an empty value in either makes the
  comparison over-inclusive (a missing round-pairs row `COMMIT GAP` catches; an extra entry in
  `/tmp/contributing-commits.txt`), not under-inclusive.
- `LC_ALL=C sort -u /tmp/discharged-triples.raw > /tmp/discharged-triples.txt` and the
  `cut -d' ' -f1,2 … | sort -u > /tmp/discharged-pairs.txt` pipeline after it — a failure in either
  empties or truncates `/tmp/discharged-pairs.txt`, which only ever makes the `comm -23` above
  report *more* as new-scope, not fewer — over-inclusive, the safe direction.
- `git log --format=%H "<anchor-reviewed-sha>..<pinned-sha>"` feeding `/tmp/round-pairs.txt` — a
  failure here means `<anchor-reviewed-sha>`/`<pinned-sha>` is bad, already the named uncovered case
  below ("a bad endpoint corrupts every clause identically, since they all read from the same
  source"), not a new gap. The same invocation feeding `/tmp/contributing-commits.txt` is listed
  under *Fixed this round* above — it is materialized to its own file and checked separately, rather
  than sharing this bullet's disposition.
- The two `git archive … | tar -x -C …` extractions, the `rm -rf`/`mkdir -p` that clear and
  recreate their target directories immediately before each one, and the four `ln -s` calls wiring
  `node_modules` into each archived tree — any of these failing starves the pair's own compile of
  its source file or its dependencies; the emit-missing hard stop
  (`[ ! -f "/tmp/decls-before/$declpath" ]`) and the module-resolution hard stop
  (`grep -qE 'error TS(2307|2305|2614|2724):'`) between them catch every way an incomplete archive
  or a missing symlink can degrade the compile, so a further `$?` check on any of these would
  duplicate an already-enforced hard stop, not close a gap.
- The two `tsc … --outDir … 2>&1 | tee *.errs` invocations — deliberately not gated on their own
  raw exit status at all; the extended discussion immediately below this recipe (*"`tsc -p` here
  compiles the whole package…"* through *"…none of the loop's four skip tokens fires"*) is the
  record of why, and names the three hard stops plus the `diff`-trouble check that stand in for it.
- `diff "/tmp/decls-before/$declpath" "/tmp/decls-after/$declpath"` — its own `$diff_status` is
  captured and checked (`-ge 2`) two lines later; guarded, not a candidate.
- `git cat-file -e "$sha^:$path"` / `git cat-file -e "$sha:$path"` and
  `parent1="$(git rev-parse … "$sha^1")" || parent1="$EMPTY_TREE"` /
  `parent_tree="$(git rev-parse … "$sha^1^{tree}")" || parent_tree="$EMPTY_TREE"` — each carries
  its own `||` fallback; guarded, not a candidate.
- Every `grep -q…` used directly as an `if`/`||` condition (the anchor-sha membership test, and
  both diagnostic checks inside the declaration-diff loop) — the exit status *is* what is read;
  guarded by construction, not a candidate.

*Unguarded, informational only — no pass/fail decision reads these, so "silent pass" does not
apply:*

- *Reporting clause (b)*'s own display fence (the `awk … | tee /tmp/discharged-report.txt`
  pipeline, and the two `wc -l < file` / `cat file` pairs for `/tmp/guard-skipped-pairs.txt` and
  `/tmp/verdict-skipped-pairs.txt`) prints what a human reads directly; a failure here degrades
  what is *shown*, not what is *decided* — the two accounting identities immediately following
  re-derive every count from its own source file independently of this fence's own commands, so a
  broken display does not change whether clause (b) is reported as fired.
- `review-ledger show … | jq -r '...' > /tmp/anchor-findings.txt` (building clause (c)'s candidate
  list) — already named and reasoned through immediately below this recipe ("This pipe has no `$?`
  guard at all — a failing `review-ledger show` here produces the identical symptom … so the same
  sanity-check already catches both causes"); not re-litigated here.
- The eight `: > file` truncations resetting stale state between runs, and the two `rm -f` cleanups
  around the discharge-triples sort — a failure here is a symptom of `/tmp` itself being
  unwritable, a precondition every other write in this recipe shares equally and none of them
  individually guards against; naming it once here, rather than as ten near-identical line items,
  is the accurate count of what is actually at risk.
- The off-chain sentinel `echo "SKIPPED: unsound denominator …" > /tmp/construction-gap.txt` — the
  on-chain branch always freshly writes this file via the `comm -23` above with its own `$?`
  check; off-chain, this echo is the only write, and shares the same `/tmp`-writable precondition
  as the truncations above. The `[ -s /tmp/construction-gap.txt ]` test runs once, inside the
  on-chain branch only, reading what that branch's own `comm -23` just wrote — the off-chain branch
  this echo belongs to never reaches that test at all, and nothing downstream reads this echo's own
  result either; the recipe reports `CONSTRUCTION GAP SKIPPED` and moves on regardless of whether
  this write itself succeeded.
- `set -o pipefail` itself, at the top of the first fence — a `set` builtin failing on a supported
  option is not a real failure mode in a POSIX-compliant shell; if it somehow did, every `$?` check
  later in this fence that depends on `pipefail` to see past a masked pipe stage would silently
  revert to the vulnerability this recipe exists to close, which is a reason to trust this line,
  not a reason to guard it.
- The diagnostic `echo …` / `cat … >&2` calls throughout this recipe (`COMMIT GAP`,
  `CONSTRUCTION GAP`, `CONSTRUCTION GAP SKIPPED`, and every guard's own `>&2` message) — each sits
  immediately before its own `exit 1` or is the terminal statement of a branch that has already
  decided; a failure writing to stderr here does not change what was decided, only whether the
  reviewer sees why.
- `echo "=== $sha $path ==="`, printed to stdout immediately before each pair's `diff` call in the
  declaration-diff loop — a header labeling the diff that follows for a human reading the loop's
  output directly, not a stderr diagnostic and not the terminal statement of a decided branch: the
  `diff` two lines below captures its own exit status into `diff_status` and is checked
  immediately after, and `/tmp/diffed-pairs.txt` is appended from that check independently of this
  echo. A failure here changes only which header a reader sees above which diff, not what the loop
  decides.

**If `/tmp/new-scope-pairs.txt` is empty, clause (b) does not fire** — (a) and (c) are unaffected, and
*Checking clause (b)* below never runs. Truncate its skip lists here instead, so *Reporting clause
(b)* doesn't read stale state from a previous run or error on a fresh machine:

```bash
: > /tmp/guard-skipped-pairs.txt
: > /tmp/guard-examined-pairs.txt
: > /tmp/verdict-skipped-pairs.txt
: > /tmp/diffed-pairs.txt
```

A `fixCommit`-introduced brand-new **non-test, non-doc** file is the same "an earlier round asked for
this" case as clause (b): apply the identical (commit, path) exclusion before treating clause (a) as
fired, resolving which commit introduced the path with
`git log --format=%H --diff-filter=A "<anchor-reviewed-sha>".."<pinned-sha>" -- "<path>"` (range before `--`,
or git ignores it). A deletion carries no such exclusion — the checklist licenses none, so a deleted
path always fires clause (a) regardless of what discharged it. Clause (c) needs no such exclusion — it
answers a file-level question (was this file reviewed at all), not a commit-level one, so a file it has
already established as reviewed stays reviewed no matter which later commit next touches it.

**Checking clause (b).** Not every pair in `/tmp/new-scope-pairs.txt` reaches the declaration diff — a
path outside the extensions `tsc` can emit a declaration for, outside the one package the recipe below
can compile a declaration against (`tools/cli/src/`), or one not **present at both SHAs**, is skipped
first. Compute the guard explicitly and record what it drops, with reason, so a "did not fire" verdict
can be read as "examined every remaining pair," not "dropped some before looking":

```bash
: > /tmp/guard-skipped-pairs.txt
: > /tmp/guard-examined-pairs.txt
while read -r sha path; do
  case "$path" in
    *.ts|*.mts|*.cts|*.tsx|*.js|*.mjs|*.cjs|*.jsx) ;;
    *) printf '%s %s non-ts-extension\n' "$sha" "$path" >> /tmp/guard-skipped-pairs.txt; continue ;;
  esac
  case "$path" in
    tools/cli/src/*) ;;
    *) printf '%s %s out-of-package\n' "$sha" "$path" >> /tmp/guard-skipped-pairs.txt; continue ;;
  esac
  git cat-file -e "$sha^:$path" 2>/dev/null \
    || { printf '%s %s absent-at-parent\n' "$sha" "$path" >> /tmp/guard-skipped-pairs.txt; continue; }
  git cat-file -e "$sha:$path" 2>/dev/null \
    || { printf '%s %s absent-at-commit\n' "$sha" "$path" >> /tmp/guard-skipped-pairs.txt; continue; }
  printf '%s %s\n' "$sha" "$path" >> /tmp/guard-examined-pairs.txt
done < /tmp/new-scope-pairs.txt
```

An `out-of-package` entry is a declarable-extension path outside `tools/cli/src/` (a root-level config
like `eslint.config.js`, or a file in some future second package) — real in-scope work the pre-filter
above still has to drop, since the declaration diff below can only ever compile `tools/cli`'s own
`tsconfig.json`, and letting such a pair through would reach the emit-missing failure below on a path
that was never going to produce a declaration in the first place, misdiagnosing a scope problem as a
broken recipe or pair.

An `absent-at-parent`/`absent-at-commit` entry is either an add/delete clause (a) already caught, or a
rename — `.mts`/`.cts` compile with no extra flags; `.mjs`/`.cjs`/`.jsx` need `--allowJs`; `.tsx` needs
`--jsx preserve` specifically (not `--jsx react-jsx`, which resolves an implicit `react/jsx-runtime`
module this repo has no dependency for and fails unconditionally) — a rename below git's similarity
threshold reaches `/tmp/round-pairs.txt` as a plain delete+add for the same commit and gets dropped
here on both sides; *Checking clause (c)*'s own `--find-renames` diff catches the destination as new
territory either way, so nothing is silently unreviewed.

For each pair that survives into `/tmp/guard-examined-pairs.txt`, diff that commit's own parent
against the commit itself. Extracting the single file with `git show sha:path > /tmp/before.ext` does
not work in this repo: TypeScript resolves both relative imports and bare-specifier package imports
from the file's own directory, so a lone file dropped into `/tmp` cannot see its siblings or
`node_modules`, and every import in it fails with a loud, visible `TS2307`. The fix is to compile the
pair inside a full tree, not a lone file — which means `tsc -p tsconfig.json` (project mode) instead
of naming the file directly, so the real `tsconfig.json` governs the compile rather than a hand-picked
subset of its flags.

Project mode reads `tsconfig.base.json` for real, which means its `"noEmit": true` now genuinely
governs the compile — the single-file invocation this replaces skips tsconfig discovery entirely and
falls back to `noEmit`'s own default of `false`, so it was never actually suppressed by this setting;
project mode is what puts `noEmit` in effect, not what this recipe extracts a lone file into. Forcing
`--noEmit false` on the command line is therefore this fix's own requirement, not a pre-existing
suppression it undoes. Skip the flag and the corrected recipe exits `0` having written nothing — the
same unfalsifiable failure in a new place: nothing in the transcript to tell "did not fire" apart from
a real negative.

```bash
: > /tmp/verdict-skipped-pairs.txt
: > /tmp/diffed-pairs.txt
TSC="$PWD/tools/cli/node_modules/.bin/tsc"
while read -r sha path; do
  ext="${path##*.}"
  declext="d.ts"
  flags=""
  case "$ext" in
    mts) declext="d.mts" ;;
    cts) declext="d.cts" ;;
    tsx) flags="--jsx preserve" ;;
    js)  flags="--allowJs" ;;
    mjs) declext="d.mts"; flags="--allowJs" ;;
    cjs) declext="d.cts"; flags="--allowJs" ;;
    jsx) flags="--allowJs" ;;
  esac
  # the out-of-package guard above already restricted $path to tools/cli/src/* (rootDir "src") —
  # update its case arm and this stripped prefix together if a second package is ever added, both
  # here and in the outDir layout below.
  subpath="${path#tools/cli/src/}"
  declpath="${subpath%.*}.$declext"
  rm -rf /tmp/clause-b-before /tmp/clause-b-after /tmp/decls-before /tmp/decls-after
  mkdir -p /tmp/clause-b-before /tmp/clause-b-after
  git archive "$sha^" | tar -x -C /tmp/clause-b-before
  git archive "$sha"  | tar -x -C /tmp/clause-b-after
  # symlinked twice: the workspace root for hoisted deps, the package itself for its own
  # dependencies (typescript, @stricli/core) and @types/node, which node's type resolution
  # looks for starting from the compiled package's own node_modules, not the workspace root's.
  ln -s "$PWD/node_modules" /tmp/clause-b-before/node_modules
  ln -s "$PWD/node_modules" /tmp/clause-b-after/node_modules
  ln -s "$PWD/tools/cli/node_modules" /tmp/clause-b-before/tools/cli/node_modules
  ln -s "$PWD/tools/cli/node_modules" /tmp/clause-b-after/tools/cli/node_modules
  ( cd /tmp/clause-b-before/tools/cli && "$TSC" -p tsconfig.json --declaration --emitDeclarationOnly \
      --noEmit false --outDir /tmp/decls-before $flags ) 2>&1 | tee /tmp/clause-b-before.errs
  ( cd /tmp/clause-b-after/tools/cli  && "$TSC" -p tsconfig.json --declaration --emitDeclarationOnly \
      --noEmit false --outDir /tmp/decls-after  $flags ) 2>&1 | tee /tmp/clause-b-after.errs
  if [ ! -f "/tmp/decls-before/$declpath" ] || [ ! -f "/tmp/decls-after/$declpath" ]; then
    printf '%s %s emit-missing\n' "$sha" "$path" >> /tmp/verdict-skipped-pairs.txt
    echo "CLAUSE (b) EMIT FAILURE: $sha $path produced no $declpath on at least one side — this is not a case to skip past, it means the recipe or the pair broke; fix it before trusting any verdict from this round" >&2
    exit 1
  fi
  if grep -qF "src/$subpath(" /tmp/clause-b-before.errs || grep -qF "src/$subpath(" /tmp/clause-b-after.errs; then
    printf '%s %s own-file-type-error\n' "$sha" "$path" >> /tmp/verdict-skipped-pairs.txt
    echo "CLAUSE (b) OWN-FILE ERROR: tsc reported a diagnostic inside $sha $path itself (a \"src/$subpath(\" line in its own output) — any compile error in the pair's own file can mean its declaration is degraded, not only a module-resolution error (an implicit-any coercion like TS7022/7023/7006 erases an inferred type to \`any\` with no resolution code at all); this is not a case to skip past, fix it before trusting any verdict from this round" >&2
    exit 1
  fi
  if grep -qE 'error TS(2307|2305|2614|2724):' /tmp/clause-b-before.errs /tmp/clause-b-after.errs; then
    printf '%s %s module-resolution-error\n' "$sha" "$path" >> /tmp/verdict-skipped-pairs.txt
    echo "CLAUSE (b) MODULE RESOLUTION ERROR: $sha $path — a module-resolution diagnostic (TS2307 unresolvable, or TS2305/2614/2724 wrong exported member) appears somewhere in at least one side's compile output; an unresolved or wrong-shape dependency erases inferred types to \`any\` through whichever file imports it directly, including a sibling the pair itself never touches, and inference then carries that erasure into the pair's own declaration — this is not a case to skip past, fix it before trusting any verdict from this round" >&2
    exit 1
  fi
  echo "=== $sha $path ==="
  diff "/tmp/decls-before/$declpath" "/tmp/decls-after/$declpath"
  diff_status=$?
  if [ "$diff_status" -ge 2 ]; then
    printf '%s %s diff-trouble\n' "$sha" "$path" >> /tmp/verdict-skipped-pairs.txt
    echo "CLAUSE (b) DIFF FAILURE: $sha $path — diff exited $diff_status, meaning trouble (an unreadable file or other failure), not a completed comparison; this is not a case to skip past, fix it before trusting any verdict from this round" >&2
    exit 1
  fi
  printf '%s %s\n' "$sha" "$path" >> /tmp/diffed-pairs.txt
done < /tmp/guard-examined-pairs.txt
```

`tsc -p` here compiles the whole package, not just the pair's own file — that is what lets its sibling
imports resolve — so its own exit status reflects errors anywhere in the package, including ones the
pair never touched, and is not a usable gate on its own. File existence is not enough either: with
`noEmitOnError` unset in this repo's tsconfig, `tsc` writes a best-effort `.d.ts` past a real compile
error even in the pair's own file, and an unresolvable dependency in the archived tree (nothing
installs for a historical tree — it only borrows today's `node_modules` via the symlinks above) can
erase a real exported type to `any` while the file still emits, which reads as a clean pass on
existence alone and can produce either a false empty diff (both sides degrade the same way) or a
spurious one (only one side does). `tsc` prefixes each diagnostic with the file's own
project-relative path (`src/commands/gate-ledger.ts(2,45): error TS2307: …`), which makes any
diagnostic against the pair's own file mechanically separable from the rest of the package's output —
grepping the captured diagnostics for `src/$subpath(` and hard-stopping on a match catches every
degradation the pair's own file can produce, not only unresolved imports: an implicit-any coercion
(`TS7022`, `TS7023`, `TS7006`, and the rest of that family) erases an inferred type to `any` with no
module-resolution code at all, and this check catches it because it keys on the file, not the code.

That check has a scope limit of its own: when the unresolvable dependency is imported by a
**sibling** instead, the diagnostic is reported against the sibling's path, not the pair's — but
inference still carries the sibling's erased type into anything the pair exports through it, and the
pair's own file contributes no diagnostic of its own. Because nothing installs for an archived
historical tree — it only borrows today's `node_modules` via the symlinks above — a resolution
failure anywhere in the package is not incidental noise the way an arbitrary type error would be: the
tree is expected to resolve cleanly against that borrowed `node_modules`, so any `TS2307` (cannot find
module) or wrong-exported-member diagnostic (`TS2305`, `TS2614`, `TS2724`) indicts the compile itself,
regardless of which file it names. Grepping for those specific codes across the whole package, on both
sides, and hard-stopping on a match closes that sibling gap. This does not reintroduce the problem
with using `tsc -p`'s bare exit status as the gate: that objection was about *type* errors anywhere in
the package, which are routine and often pre-existing; a *resolution* failure is never routine here.

**The two checks are additive, not redundant, and neither subsumes the other on purpose.** The
own-file check is broad in error *kind* (any diagnostic at all — implicit-any included) but narrow in
*location* (the pair's own file only). The module-resolution check is broad in *location* (anywhere in
the package) but narrow in *kind* (the four resolution/wrong-export codes only, because a package-wide
hard stop on implicit-any would hard-stop on the exact routine, unrelated noise the exit-status
objection rejected — the pair's own file is the one place that noise isn't tolerable, which is why the
own-file check, and only the own-file check, catches it regardless of code). A non-empty `diff` on any
pair that clears all three checks fires the clause; trust the `[ ! -f ... ]` and `grep` checks above —
all three hard stops, not recorded skips — before reading an empty diff as "did not fire," not stdout
alone. A fourth check sits apart from those three and answers a different question: the three ask
whether a comparison can be trusted, and this one asks whether it happened at all, by reading `diff`'s
own exit status. `diff` itself can exit `2` and write only to stderr instead of comparing, and the
loop's own exit-status check above catches that directly, ending the run before this reading is
reached rather than leaving it to be inferred from stdout. A signal recorded into a list a "did not
fire" verdict is free to skip past is not a signal; `emit-missing`, `own-file-type-error`, and
`module-resolution-error` — the trust checks — plus `diff-trouble` — the ran-at-all check —
all end the run instead.

What this still cannot see, demonstrated rather than suspected: an implicit-any coercion in a
**sibling** — the same `TS7022`/`TS7023`/`TS7006` family the own-file check catches when it names the
pair directly — erases the pair's declaration through inference exactly as the sibling-resolution case
does, but trips neither hard stop: it isn't in the pair's own file, and it carries none of the four
resolution codes. This is not merely undetected: for a pair whose own file re-exports the sibling's
named function by bare identifier (`export const x = someNamedFunction`), the emitted declaration
references it as `typeof someNamedFunction` rather than inlining its signature, so the pair's `.d.ts`
is byte-identical before and after the sibling's parameter erases to `any`. That pair clears all
three trust checks — the `.d.ts` exists on both sides, so the emit check passes; neither grep matches,
so the own-file and resolution checks pass — and its diff runs to completion at exit `0`, clearing the
ran-at-all check too, so none of the loop's four skip tokens fires. It produces an empty `diff`, lands
in `/tmp/diffed-pairs.txt` rather than any skip list, balances the accounting identity below, and
*Reporting clause (b)* presents it exactly as it presents a
genuinely unchanged export. Clause (b) does not fail to notice this pair — it examines it, counts it,
and reports a negative verdict that is false, not merely absent. Scope: only tested against a
bare-identifier re-export of a named function declaration; a sibling export re-exported as an
arrow-function const (`export const x = (cb) => cb()`) inlines its structural type instead and diffs
correctly, so this false-verdict case is not established beyond the named-function-declaration shape
tested. Beyond that specific, demonstrated case: a dependency that resolves to a *wrong version* which
still exports every name the compile touches, under the same names, produces no diagnostic on either
side, so a `.d.ts` that is quietly wrong in a way that matches its own dependency's (equally wrong,
but present) shape passes every check here undetected too. It is not established that these two named
gaps are the complete set of ways an inferred type can degrade without tripping one of the three hard
stops; treat this paragraph as what has been demonstrated to escape, not as a closed inventory of
everything that can.

**Reporting clause (b).** The verdict is not just fired / did not fire — it carries what was excluded,
at every point a pair can leave the pipeline before contributing to it: the ledger exclusion, the
guard drop, and an emit failure inside the declaration-diff loop are each invisible without their own
list, and a "did not fire" that silently dropped a pair at any of them is indistinguishable from one
that carried every pair through to a genuinely empty diff. Report all three lists whichever way the
clause fired — all empty is a real, different answer from never having looked.

```bash
LC_ALL=C awk 'NR==FNR { inrange[$0]; next } ($1 " " $2) in inrange { print $2, $1, $3 }' \
  /tmp/round-pairs.txt /tmp/discharged-triples.txt | tee /tmp/discharged-report.txt
wc -l < /tmp/guard-skipped-pairs.txt
cat /tmp/guard-skipped-pairs.txt
wc -l < /tmp/verdict-skipped-pairs.txt
cat /tmp/verdict-skipped-pairs.txt
```

Close the report with an identity rather than trusting the three lists are exhaustive — every term is
a file one of the reports above already built:

```bash
total=$(wc -l < /tmp/round-pairs.txt)
if [ $? -ne 0 ]; then
  echo "wc -l failed reading /tmp/round-pairs.txt" >&2
  exit 1
fi
LC_ALL=C comm -12 /tmp/round-pairs.txt /tmp/discharged-pairs.txt > /tmp/excluded-pairs.txt
if [ $? -ne 0 ]; then
  echo "comm failed computing excluded-pairs from /tmp/round-pairs.txt and /tmp/discharged-pairs.txt" >&2
  exit 1
fi
excluded=$(wc -l < /tmp/excluded-pairs.txt)
if [ $? -ne 0 ]; then
  echo "wc -l failed reading /tmp/excluded-pairs.txt" >&2
  exit 1
fi
guard_skipped=$(wc -l < /tmp/guard-skipped-pairs.txt)
if [ $? -ne 0 ]; then
  echo "wc -l failed reading /tmp/guard-skipped-pairs.txt" >&2
  exit 1
fi
examined=$(wc -l < /tmp/guard-examined-pairs.txt)
if [ $? -ne 0 ]; then
  echo "wc -l failed reading /tmp/guard-examined-pairs.txt" >&2
  exit 1
fi
if [ "$total" -ne "$((excluded + guard_skipped + examined))" ]; then
  echo "ACCOUNTING MISMATCH: $total round-pairs, but $excluded + $guard_skipped + $examined = $((excluded + guard_skipped + examined)) accounted for" >&2
  exit 1
fi
```

And a second identity for the declaration-diff loop specifically, since a pair can balance the first
identity as `examined` while still being dropped silently inside the loop:

```bash
verdict_skipped=$(wc -l < /tmp/verdict-skipped-pairs.txt)
if [ $? -ne 0 ]; then
  echo "wc -l failed reading /tmp/verdict-skipped-pairs.txt" >&2
  exit 1
fi
diffed=$(wc -l < /tmp/diffed-pairs.txt)
if [ $? -ne 0 ]; then
  echo "wc -l failed reading /tmp/diffed-pairs.txt" >&2
  exit 1
fi
if [ "$examined" -ne "$((verdict_skipped + diffed))" ]; then
  echo "ACCOUNTING MISMATCH: $examined guard-examined pairs, but $verdict_skipped + $diffed = $((verdict_skipped + diffed)) accounted for" >&2
  exit 1
fi
```

A failing identity means an exit exists that this section has not yet given a list for.

**Checking clause (c).** The anchor round's own diff is not the full record of what the anchor round's
senior reviewed — a stale-reference sweep or a finding's own reasoning routinely reads files outside
that round's diff. Check candidates against the ledger before concluding a path is unreviewed:

```bash
review-ledger show --ticket "<TICKET-ID>" | \
  jq -r '.resolvedAnchor.round as $anchor | .findings[] | select(.raisedInRound <= $anchor) |
    (.file // ""), (.summary // ""), (.withdrawnReason // "")' \
  > /tmp/anchor-findings.txt
git diff --find-renames --name-only "<anchor-reviewed-sha>..<pinned-sha>" > /tmp/clause-c-lhs-unsorted.txt
if [ $? -ne 0 ]; then
  echo "git diff --find-renames --name-only failed while building clause (c)'s left side — <anchor-reviewed-sha>/<pinned-sha> is likely bad" >&2
  exit 1
fi
LC_ALL=C sort -u /tmp/clause-c-lhs-unsorted.txt > /tmp/clause-c-lhs.txt
if [ $? -ne 0 ]; then
  echo "sort failed while building clause (c)'s left side from /tmp/clause-c-lhs-unsorted.txt" >&2
  exit 1
fi
git diff --find-renames --name-only "origin/main...<anchor-reviewed-sha>" > /tmp/clause-c-rhs-unsorted.txt
if [ $? -ne 0 ]; then
  echo "git diff --find-renames --name-only failed while building clause (c)'s right side — origin/main/<anchor-reviewed-sha> is likely bad" >&2
  exit 1
fi
LC_ALL=C sort -u /tmp/clause-c-rhs-unsorted.txt > /tmp/clause-c-rhs.txt
if [ $? -ne 0 ]; then
  echo "sort failed while building clause (c)'s right side from /tmp/clause-c-rhs-unsorted.txt" >&2
  exit 1
fi
LC_ALL=C comm -23 /tmp/clause-c-lhs.txt /tmp/clause-c-rhs.txt
if [ $? -ne 0 ]; then
  echo "comm failed computing clause (c)'s candidate paths from /tmp/clause-c-lhs.txt and /tmp/clause-c-rhs.txt" >&2
  exit 1
fi
```

Capture `.resolvedAnchor.round` with `as $anchor` before entering `.findings[]` — inside the iteration
`.resolvedAnchor` is out of scope and evaluates to `null`, silently emptying the file and making clause
(c) *over*-fire on every path rather than staying quiet; `jq` still exits `0` either way, so sanity-check
`/tmp/anchor-findings.txt` is non-empty before trusting a "doesn't fire" verdict. This pipe has no
`$?` guard at all — a failing `review-ledger show` here produces the identical symptom, an empty
`/tmp/anchor-findings.txt`, so the same sanity-check already catches both causes; no separate guard
is added here for that reason. For each path the
`comm` above prints, `grep -qF "<path>" /tmp/anchor-findings.txt` — a hit anywhere in `file`, `summary`,
or `withdrawnReason` (not the raw finding JSON, which also matches an unrelated `hint` pointer) for a
finding raised **at or before** the anchor round means it was already reasoned about; no hit means
genuinely new territory.

Report which clause fired. If none fires, the round is cleanup — say so explicitly in your report, so
the team lead can see the stance you reviewed under rather than infer it.

**What this predicate does not cover.** A commit with an incomplete path list is invisible to both
checks above when every path it omits is also covered by some other commit's row. A bad
`<anchor-reviewed-sha>`/`<pinned-sha>` endpoint corrupts every clause identically, since they all read
from the same source. Clause (b)'s exclusion is (commit, path)-scoped: new exported surface added to
the very path a finding already names, inside the commit that discharges it, stays excluded — a
discipline requirement on how fix commits are composed, not something the command can close by itself.
And the exclusion trusts the ledger's `allFixCommits` values at face value — a wrong-but-real citation
over-excludes, and a commit that discharges a finding but was never cited under-excludes and re-arms
adversarial over its own remedy. The defense for both is disposal discipline (cite `--fix-commit`
immediately, once, correctly), not a mechanical check this recipe can run for itself.

### A widened sweep class is a finding generator, not a convergence check

This file is hard-wrapped, so a multi-word pattern grepped line-by-line cannot match an instance that
straddles a wrap; fold newlines before trusting a count — single-word patterns cannot straddle and
need no folding. Count the folded output with `grep -o` piped to `wc -l`, never with `grep -c`: the
fold puts the whole file on one line, so `grep -c` reports 1 for any pattern that matches at all,
which is further from the truth than the line-based count it replaced. The folded form runs as
written:

```bash
CHECKLIST_ROOT="$(git rev-parse --show-toplevel)" || { echo "not inside a git checkout — cannot resolve checklist.md" >&2; exit 1; }
CHECKLIST="$CHECKLIST_ROOT/skills/code-review/references/checklist.md"
if [ ! -f "$CHECKLIST" ]; then
  echo "no checklist.md at $CHECKLIST — this checkout does not have the file this sweep counts" >&2
  exit 1
fi
if [ ! -r "$CHECKLIST" ]; then
  echo "$CHECKLIST exists but is not readable — cannot count what this sweep cannot read" >&2
  exit 1
fi
echo "counting $CHECKLIST"
tr '\n' ' ' < "$CHECKLIST" | grep -o 'hard stop' | wc -l
```

A sweep that reports zero must be able to name the set it ran over, and a line-based grep for a
multi-word phrase on a wrapped file cannot make that claim. Naming the set also means naming which
file was actually read, and naming it is not the same as naming it *correctly*: a path built by
resolving against the reviewer's current directory can still assert a location with full confidence
— a well-formed absolute path, a plausible non-zero-looking `0`, exit `0` — while answering for
nowhere real, if that directory has no `skills/code-review/references/checklist.md` beneath it at
all (a workspace root holding several checkouts as subdirectories, rather than a checkout itself, is
exactly such a place). Anchoring to `git rev-parse --show-toplevel` instead answers for the checkout
the reviewer is actually inside, whichever one that is, and the `[ ! -f "$CHECKLIST" ]` check
refuses to report anything — no path, no count — when that checkout turns out not to have the file
in the first place, rather than let a stale variable print a location nothing backs.

Existing but unreadable is a third case neither check above catches: `[ ! -f ]` passes, and the
shell's own redirection into `tr` fails before `tr` ever runs — a diagnostic reaches stderr, but
nothing inspects the failure, and `tr` itself never execs — the failed redirection aborts it before
that — so `grep` and `wc -l` downstream see an immediately-closed, empty pipe rather than a
redirected stdin, and still report a confident `0` for a file this fence never actually read. The
`[ ! -r "$CHECKLIST" ]` check above closes that gap the same way `[ ! -f "$CHECKLIST" ]` closes its
own — by refusing to report anything rather than letting the pipe's downstream stages manufacture a
plausible-looking answer. `set -o pipefail` is not the fix here the way it is in the recipe fences
above: `grep -o 'hard stop'` legitimately exits `1` on a genuine zero-match count, so turning that
pipe's exit status into this fence's own would misreport a correct "0 hard stops" answer as a
failure — the pre-flight `-r` check catches the unreadable-file case before the pipe ever runs,
without touching how the pipe's own exit status is read.

When you sweep for other instances of a defect class, the class is the one the finding named, and
the scope is the one the sweep capture carries: `proof-ledger record --capture sweep --scope` names
the package dirs of the files the change touches, derived from the diff, and `record` refuses any
other scope and any found path outside it (in grep/rg's line or `-l` listing output; a custom
formatter is not checked) (`skills/team-dispatch/SKILL.md` step 6, *Sweep*). **A
sweep is never widened.** Not to a broader class — a class drawn by description has no bound — and
not to a wider tree: a site outside the scope, anywhere else in a monorepo, is a process note for the
team lead, never a finding and never a reason to run the pattern over more of the tree. A reviewer
wanting more coverage inside the scope asks for a second pattern with a different blind spot, not a
wider scope. A site inside the scope that a later pass finds is a new finding against this class,
not a contradiction of an earlier pass that found none.

## Before You Start

Read and understand these artifacts:
- **The PRD** — what problem is being solved, success criteria, scope
- **The architecture doc** — contracts, data structures, key decisions, sequencing
- **The implementation plan** — what was intended to be built, task breakdown
- **The project's CLAUDE.md** — project-specific standards and conventions
- **The user review standards** — the absolute path the team lead passed, read additively with a per-repo `<repo-root>/.claude/review-standards.md` if it exists. Every rule there is a blocking checklist item for this review (`review-rules.md` §User Review Standards). Three states, not two: no path was passed — say so in your review report; a path was passed and the file exists but is empty — a no-op, nothing to enforce yet; a path was passed and the file is missing or unreadable — say so in your review report exactly as for no path passed, never treat it as a no-op.
- **The review ledger** (required when the ledger is present; no-ops only if the `review-ledger` CLI is absent) — `review-ledger show --ticket "<TICKET-ID>"` gives your round number, the findings still `open`, the ones `fixed` and their commit, and the ones `withdrawn` with the reason (`agents/senior-engineer.md` §How You Work step 3).

You are reviewing **the SHA the team lead pinned you to** — never the working tree or `HEAD`
(`agents/senior-engineer.md` §How You Work step 4). **What you read at that SHA is this round's
scope, not automatically the whole branch** — the full diff on an adversarial round, the delta on a
delta-scoped one, and the two axes are independent, so a round can be both (§Review Stance, *Delta
scope and cleanup stance are independent*). Run `git diff origin/main..."<pinned-sha>"`
for the full diff — three-dot, not two-dot: this repo squash-merges, so `origin/main` keeps advancing
past our merge-base with other tickets' commits, and only three-dot's merge-base-relative comparison
keeps those out of the diff.

**Never fabricate references.** If you're unsure whether something is documented in the PRD, architecture doc, or plan, re-read the document. Do not cite a document you haven't read. "I'm not sure" is always better than an invented citation.

## Detect Work Type and Domains

Read the PRD and architecture doc to determine what kind of work this is. Apply the universal checklist (always), plus the relevant work-type extra checks:

- **New feature / rinse-and-repeat** — follows established patterns of other repos, doesn't diverge
- **Migration** — data integrity, nothing lost, old code removed, rollback considered
- **Major refactor** — no behavioral changes, existing tests still valid, no regressions
- **Greenfield** — architecture foundations solid, patterns established correctly
- **Bug fix** — root cause actually addressed, not just symptoms, regression test added

If uncertain about the type, apply all extra checks. Missing a relevant check is worse than running an unnecessary one.

### Domain Detection

After determining the primary work type, scan the diff for **domain signals**. Each detected domain adds its domain-specific checklist section to the review. Multiple domains can apply — they are additive.

| Domain | Signals in the diff |
|--------|-------------------|
| **Database** | Schema files (`*.schema.*`, `drizzle/*`, `prisma/*`, `*.entity.*`), migration files, SQL DDL, ORM model definitions |
| **API** | Route/handler files, OpenAPI/Swagger specs, request/response type definitions, middleware changes |
| **CI/CD** | Workflow files (`.github/workflows/*`, `Dockerfile`, `docker-compose.*`), infrastructure-as-code (`infra/*`, `cdk/*`, `pulumi/*`), deploy scripts |
| **Data Serialization** | `toJSON`/`fromJSON`, `to_dict`/`from_dict`, `serialize`/`deserialize`, `toPlainObject`/`fromPlainObject` methods |
| **GraphQL** | `.graphql` schema files, resolver files (`*resolver*`, `*resolvers*`), DataLoader imports/definitions, codegen configs (`codegen.ts`, `codegen.yml`), `gql` tagged template literals |

If no domain signals are detected, skip the domain checklists entirely.

See `references/review-rules.md` for the Universal Review Checklist, Work-Type Extra Checks, and Domain-Specific Checklists.

## Parallelized Review (Large Diffs)

For large diffs — rewrites, migrations, or large multi-file changes — the senior engineer should parallelize the review using its own sub-agents (it has the Agent tool). This section provides guidance for how to split and aggregate the review.

### When to Parallelize

When the diff is large enough to benefit — rewrites, migrations, and big multi-file changes. For small or moderate diffs, review directly without sub-agents.

### How to Split

Choose a strategy based on the diff shape (see the senior engineer agent definition for detailed patterns):

- **By concern layer:** Each sub-agent owns specific checklist sections across all files. Best for diffs touching many files across domains.
- **By component:** Each sub-agent owns all checklist sections for a subset of files. Best for multi-component rewrites.
- **By old-vs-new comparison:** Separate sub-agents for feature parity analysis, new code quality, and cleanup verification. Best for migrations.

Each sub-agent receives:
- The diff (full or relevant subset)
- The specific checklist sections or files they're responsible for
- All artifacts (PRD, architecture doc, implementation plan, CLAUDE.md), plus the review-standards path(s) when their section includes User Review Standards

**No sub-agent is still running once its report lands, and none before aggregating.** The first report can land many minutes before the last. Outcome to bring about: `skills/workflow-guide/references/routing.md` §Research Delegation

### How to Aggregate

The senior engineer collects sub-agent reports and produces a single consolidated review:
1. Merge all issues into one report
2. De-duplicate overlapping findings from different sub-agents
3. Check for cross-cutting concerns that no single sub-agent would catch (e.g., a new parameter added in one component but not wired in another)
4. Apply the same approval bar: **the user finds nothing**
5. Report to the team lead with the standard format: specific issues citing file and symbol — or a quoted literal where no symbol exists — with line numbers as hints, never alone, grouped by theme, clear pass/fail verdict. When you `SendMessage` the team lead with a plain-string `message`, always include a `summary` (a 5–10 word UI preview) — the tool rejects a bare string.
