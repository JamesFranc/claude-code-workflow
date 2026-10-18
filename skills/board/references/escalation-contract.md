# Escalation Contract — What You Decide, and What Is Genuinely the User's

Every agent in this workflow shares one rule for putting a question to the user. This file is that
rule. `skills/board/references/dashboard-protocol.md` §2 governs *how* a question is posted once it
has earned the right to exist; this file governs **whether it has**.

## The three rungs — "3 before me"

An agent may not put a question to the user until it has, **in order**:

1. **Asked itself** — do I know this, or can I work it out? A call you can make and be wrong about
   cheaply is a call you make. Being unsure is not the bar; being unable to proceed is.
2. **Looked it up** — is the answer already written down? The governing PRD or architecture doc's
   **Out of Scope**, `CLAUDE.md`, the user's review standards, memory, a pattern already in use in
   the repo, or a prior board answer on this node. An accepted limit is an answer, not an open
   question (contract rule 4).
3. **Asked a teammate** — the senior engineer, an advisor, a researcher. Even a rubber-duck pass.

Only what survives all three is the user's. The rungs are **ordered**: reaching for rung 3 without
clearing rungs 1 and 2 spends a teammate's context answering something already written down.

### Rung 3 in practice

| You are | Rung 3 is |
|---|---|
| An implementer | Spawn a **senior-engineer consult** — one question, one answer, then shut it down (`agents/senior-engineer.md` §Consult Mode). Where the `advisor` tool is available to you it substitutes for the consult — never precedes it (`agents/implementer.md` §Escalation states the model gate). |
| A team lead | Ask the senior engineer already on the team, or spawn a researcher for a codebase question (`skills/workflow-guide/references/routing.md` §Research Delegation). |
| A senior engineer | Ask the implementer whose diff it is, on the evidence. A disagreement you can settle by reading the code is not a disagreement — settle it. |

**The consult spawn is workflow-mandated** — contract rule 6 covers it, so a harness guardrail
phrased as "unless the user requested it" is already satisfied for it. Never stall on that
guardrail, and never post a board question asking permission to consult.

## The bright lines — what is genuinely the user's

Five, and only five:

1. **Irreversible or destructive acts** — deleting data, force-pushing over someone's work,
   rewriting published history outside the team's own ticket branch, closing or reopening a ticket:
   anything with no undo.
2. **Spending money** — a paid API, a new service, a plan upgrade.
3. **Changing product behaviour the user would notice** — what the thing does, not how it does it.
4. **Going outside an approved doc** — the PRD, the architecture doc, or the implementation plan the
   user signed off on. This means departing from what the doc **decided** — the behaviour it
   specifies, the contracts it sets, the approach it commits to — not from which files it happened to
   enumerate: landing work in a file the doc didn't list is not, by itself, leaving it. Ask to reopen
   the doc; never quietly widen it.
5. **A product or taste call with no technical answer** — two options both correct, and the choice
   is preference. Say which one you would take anyway.

Anything not on that list — and not the two routes below, and not a deferral-gate post under contract rule 5 — you decide. **"I am not certain" is not a bright line.** Nor is choosing what to cut when a capped rules file (the user's review standards, or `review-rules.md`) would go over its cap. Dropping an entry is not a destructive act under line 1, because it has an undo: for review-rules.md the cut is a reviewed diff, and for the review-standards file every entry that is cut, or that ranks too low to be added, is archived verbatim first. Picking which entry matters least is a judgement of importance, not a taste call under line 5. Neither is work you are declining to do, so rule 5 does not apply. Rank the entries and cut from the bottom (`skills/memory-review/SKILL.md` §The Second Store — Review Standards).

**One more route, and it is not a bright line.** A technical disagreement that you and a teammate
could not settle on evidence is still the user's — not because of what the decision is about, but
because rung 3 was climbed and did not hold. Say what each of you argued and what evidence each side
rests on. This is the only route that is a statement about the *process* rather than about the decision,
and the only one rung 3 **creates** rather than merely survives: every other route exists before you
consult and is still there afterwards, while this one does not exist until the consult has
happened and failed.

**And one route for a fact, not a decision.** Everything above is about a *decision*. A question can
instead ask for a **fact only the user holds**: something they saw, did or know that nothing written
down records, such as which session produced a report, which environment they were in, or what the
screen showed. It gets through the rungs by definition, since rung 1 cannot work it out and rungs 2
and 3 cannot find it. It is the user's, and it goes on the board declared `fact`. `--recommend`
carries your best guess, and the evidence block names where you already looked. Two things are not
`fact`. A fact you could read yourself (a file, a log, the git history, a CLI command, a prior board
answer) is a rung-2 failure: look it up. A decision dressed as a fact, such as "which approach do you
want?", takes the decision's route.

**Board when it is available, otherwise the terminal — or not asked.** A question has exactly two
outcomes. If it survives the rungs and a route above makes it the user's, it is asked: on the board
when one is available, and in the terminal when none is (`dashboard item add` exits 3 and prints the
composed question to ask; ask it, and wait for the reply). If not, it is not asked at all: you make
the call and keep working, and say what you chose in prose if it matters. There is no third outcome.
With a board available, a question asked in the terminal while you wait is never an option, and a
question the board would not take is never a question for the terminal instead. With no board, the
terminal is the board: the same rungs, routes and question form apply, and a question that would not
earn the board does not earn the terminal either.

### The small-addition carve-out

A small addition the team lead would recommend doing in this PR is **done, not asked**, subject to
the scope test below — it narrows bright line 4 only, and leaves the other four untouched. A little
scope creep is cheaper than an interrupt, and the recommendation is itself the signal that it is
fine.

**If you cannot do the work yourself, the analogue is a finding, not a question.** A reviewer who
would recommend a small addition reports it like any other finding — same judgement, different
consequence, because a reviewer has no write access to act on it. Either way it never becomes a scope
question for the user.

Within bright line 4, scope reaches the user only for an addition that is **large**, **changes
user-visible behaviour**, or **leaves what the approved PRD/architecture decided** — not which files
it happened to enumerate. If none of those three is true, bright line 4 is cleared: do the work, and
say what you did in the PR body.

**The implementation plan is deliberately absent from those three conditions.** Bright line 4 names it as an
approved doc; this narrowed test does not, because a small addition the plan did not anticipate is
the exact case the carve-out exists for. Deviating from the plan for a small addition is not the
user's — it is a line in your task report and in the PR body. None of this changes the team lead's
role: everything on `agents/implementer.md` §Escalation's *When to message the team lead* list still
goes to them — including a problem the plan did not anticipate, which is not the same thing as a
small addition it did not anticipate. Never route something to the user on the grounds that it
appears on that list — that list routes to the team lead; where it names bright lines, it points
back here for them.

This carve-out is about work you are **doing**. It is not a change to the deferral gate (contract
rule 5), which governs work you decide **not** to do — deferring is still the user's call, every
time, at the moment you decide.

### The force-push carve-out

Force-pushing the branch **the team created for its own ticket** is not bright line 1 — this narrows
that line only, and leaves the other four untouched. The workflow manufactures the divergence itself
by rebasing onto `origin/main` before every push (`skills/pr-lifecycle/SKILL.md` step 2), so
overwriting the old remote tip is an ordinary step, not a decision that is the user's.
Verify it destroys nothing, then push: the checks and the `--force-with-lease` form are in
`skills/pr-lifecycle/SKILL.md` §Force-Pushing the Team's Own Branch. Do not post a board item asking
permission for it, and do not post one announcing that you are about to.

**`rc_check1` is `0` AND a non-empty `<file>` is back on bright line 1.** That is the case where
the push would genuinely overwrite work, and it is a real question. Any other halt in that
procedure — a non-zero `rc_fetch`, a `rc_check1` that did not confirm `0`, or a `<file>` whose
emptiness you could not confirm, whatever prevented it — is a different case: a broken instrument
to repair, not a question for the user. Check 2 does not settle whether the push is safe — check 1
does: `1` is the expected state after every rebase and never on its own a reason to ask; anything
above `1` is an error, not a rebase, and stops the procedure the same way a broken check 1 does.

Everything else on bright line 1 stands unchanged: `main`, any shared or protected branch, any
branch the team did not create, and rewriting published history outside the team's own ticket
branch — anything another person may have based work on.

### Workflow improvements are notes

Any improvement to the workflow outside the story you are working is recorded in the process
improvement notes (`skills/process-improvement-notes/SKILL.md`, check-in mode) and nowhere else. The
workflow is its skills, rules, references, hooks, CLIs, agents and board. An improvement to it can
be friction that got in your way (a skill step that is wrong, a CLI that refuses what it should
allow, a rule that contradicts another rule, a gate that fires when it should not), a defect you
noticed that did not stop you, a gap, or an idea for doing it better. None of these is a board
question, an approval, an in-session "should I…?", a deferral queued under contract rule 5, or a
ticket you file on your own initiative. Write it down and carry on with the work you were given.

**This holds in the workflow's own repo.** Suppose you are working a story in the workflow's source
repo, and you read a workflow defect that the story does not touch. It is a note, not out-of-scope
work for the deferral gate. It does not become product work because its source file is in front of
you. What the current story itself changes is in scope, and a defect there is fixed in the same
cycle.

**Proposing a change is covered as much as asking about one.** "Here is how I would fix this step"
is the same interrupt as "should this step work this way?", and the notes are where both go.

**Severity is not the test.** How broken it looks, how sure you are of the fix, and how much time it
appears to be costing are all beside the point: the test is whether the observation is part of the
story you are working or about the workflow outside it. Friction that is costing a lot is a longer
note.

**Filing the note does not discharge what the friction broke.** A workflow fault can leave a defect
in the work under review: a check red, a capture the tool refuses to accept, a gate that will not run
at the sha you are about to hand over.
Route the cause to the notes and clear the consequence in the same cycle.
Never hand the defect on because the workflow caused it — that the tool is at fault is a
diagnosis, not a disposition. If you cannot clear it, the work is stalled and the boundary below
applies, with the failing check named as what stalls.

**The boundary.** "I cannot finish what you asked" is a blocker and escalates by the ordinary rules,
as the stalled work, naming what stalls; "I noticed this step is wrong and here is how I would fix
it" is a note. Nothing else here is relaxed — the five bright lines are untouched, and a bright-line
decision reached while wrestling with the workflow is still a decision for the user.

## The repo's merge method is not a question

How a PR merges is the repo's configured standard — not a per-PR decision, and not something to
re-derive on each PR. This is not a carve-out from a bright line: it was never on one. What a merge
will produce is a fact you can read, so it does not survive rung 2, let alone reach the board:

```bash
gh api "repos/<owner>/<repo>" --jq '{squash_merge_commit_title, squash_merge_commit_message}'
```

`squash_merge_commit_title` is `PR_TITLE` (the PR's title always becomes the commit subject) or
`COMMIT_OR_PR_TITLE` (the single commit's own title when the branch has exactly one commit, the PR's
title otherwise). `squash_merge_commit_message` is `COMMIT_MESSAGES` (the branch's commit messages
are concatenated; the PR body never appears in the commit), `PR_BODY` (the body becomes the permanent
commit message), or `BLANK`. Read them, follow them, move on.

If you care about a specific outcome in the squashed message, act on it yourself — shape the commit
messages while you can still amend them, or, once the user has approved the merge, perform that
approved merge with the message you want. **This section licenses the message, never the merge.**
Merging is the user's and stays board-gated — `skills/workflow-guide/contract.md` is explicit that
"the board gates on ready-for-review and merge stand" — so nothing here is an exception to it, and
"I wanted a particular commit message" is not a reason to merge ahead of the approval. What stays
unavailable is putting the *message* to the user: a merge-method or trailer concern is not an
escalation, and neither is a plan to ask about one.

## Required question form

A question that survives the rungs carries **four things** — and the evidence behind them.
The four are in the table below. The evidence is the third block of the prompt form further down:
not optional, and the part that makes the question answerable. A question with no pointer to what
the user would have to look at is the complaint this contract exists to fix.

A "question" that needs no answer is not a question. If the user only needs to know it, post it as
an info note instead (`skills/board/references/dashboard-protocol.md` §8). Something that needs the
user's go-ahead is neither: it is an approval, never a note (same section).

| Part | Where | What it is |
|---|---|---|
| **Lede** | First line of `--prompt` | The decision (or the fact you need), in one line, in plain language. No agent-speak, no preamble, no restating the ticket. The user should be able to act on this line alone. |
| **Recommendation** | `--recommend` | What you would do. There is no question for which this is unanswerable — a pure taste call still has one ("I'd take A, but this one is yours"). |
| **What stalls** | `--stalls` | What is waiting on the answer, or the literal word `none`. |
| **Why it is theirs** | `--why-mine` | `taste`, `scope`, `risk`, `teammate-unsettled`, or `fact` — the route this took, per the mapping below. Choosing one is itself the claim that the question cleared all three rungs. **The flag carries this; a sentence must not.** The CLI composes the declaration line from it, so a clause in `--prompt` saying whose call it is duplicates a line the user is already reading — cut it, and cut it hardest where the answer is fixed by the item's own type (a deferral-gate question is always `scope`, a merge approval is always the user's call) and so carries no information at all. |

The CLI composes the recommendation, what-stalls, and why-it-is-theirs flags into the declaration line itself — you never write that line by hand.

Five values, seven routes — the mapping is fixed, not a judgement, and the table below is **ordered**. The CLI validates `--recommend`, `--stalls`, and `--why-mine` and composes the declaration line itself.

| `--why-mine` | Covers |
|---|---|
| `risk` | Bright lines 1–3: an irreversible or destructive act, spending money, or changing product behaviour the user would notice. |
| `scope` | Bright line 4: going outside an approved doc — what it decided, not which files it enumerated — or deciding not to do work you found, the deferral gate (contract rule 5). |
| `taste` | Bright line 5: a product or taste call with no technical answer. |
| `teammate-unsettled` | The sixth route: a **technical** disagreement you and a teammate could not settle on evidence. A taste call the two of you argued and could not settle is still `taste` — bright line 5. |
| `fact` | The seventh route: a fact only the user holds, not a decision. A question that is also a decision takes that decision's row. |

A deferral-gate question's evidence block is whatever `skills/workflow-guide/references/routing.md`'s deferred-work rule requires.

If none of the five fits, the question is not the user's and you have not finished rung 1: decide it yourself and move on. Do not ask it anywhere (§The bright lines, *Board when it is available, otherwise the terminal*).

**More than one line can fire on the same question, and that is the common case, not the exotic
one** — a taste call that ships behaviour the user would notice crosses lines 5 and 3 both, and
going outside an approved doc is usually also a behaviour change. **Take the first row in the table
that applies.** That is what makes the mapping fixed rather than a judgement: the value never
depends on which line you happened to notice first. `teammate-unsettled` and `fact` come last because neither is about what the decision is. `teammate-unsettled` exists because the *process* failed, and `fact` is not a decision at all. Any decision row that fires is the truer answer, and the failed consult or the missing fact goes in the evidence block.

The composed prompt reads as three blocks, in this order and this form:

```markdown
<the decision, in one line — this is the --prompt you write>

<the evidence: what you checked, the options, and a pointer to what the user would have to look at — a PR URL, a file and symbol, a linked doc — this is also part of the --prompt you write>

> **Recommend:** <what you would do> · **Stalls:** <what waits, or `none`> · **Yours because:** <taste|scope|risk|teammate-unsettled|fact> — the CLI composes this line from --recommend, --stalls, and --why-mine; you never write it
```

Only the first two blocks are yours to write, both inside `--prompt`. The last block — the
declaration line — is composed by the CLI, after the question, so the user reads what is being
decided before what you recommend, from `--recommend`, `--stalls`, and `--why-mine`; do not write it
by hand in `--prompt`. `--defer` (required for a deferral-gate post; requires `--stalls
none`) does not post this item at all — with a board it queues the question on the node and prints
`{"deferredId":"<id>"}` (with no board it exits 3 and prints the question, to ask in the terminal now); `dashboard item flush-deferred` posts every queued question as its own item, in one
call, later, once there is a diff to point at (or, in a workflow with no PR, with no `--context` at
all) (`skills/board/references/dashboard-protocol.md` §2).

Keep the evidence block short enough to read on one screen. Evidence that does not fit belongs in a
linked doc or a PR comment, not in the prompt — the lede is what gets read.

A local file path is not a pointer the user can open — the board runs in a browser, which refuses
`file://` links. When Notion is configured, a screenshot, rendered frame, or other local file cited
as evidence is hosted first and cited by its hosted URL
(`skills/workflow-guide/references/notification-protocol.md` §Evidence files); a file too large to
host is cited by its local path, as that section says. When Notion is not configured, cite the local
path and say it is local, so the user knows to open it from the terminal.

**Plain language.** The lede and the evidence are written for someone deciding, not debugging: say
what is being decided and what each option costs, in words a reader who has not seen the code
would follow. No internal identifiers, function names, CLI verbs, or workflow vocabulary unless the
decision is literally about them — and then name the thing once, in a link or a code span, not as
the sentence's subject.

**Report the fact; do not explain what it means.** The user has been making these calls for years and
reads a board item to decide, not to be briefed. A caveat they could derive from the fact itself is
padding, and it costs them a read every time.

The failure shape recurs, so name it: state a fact, then add a sentence explaining what they should
conclude from it, then a third naming whose decision it is. Only the first sentence is wanted. A real
instance, from a merge approval — the useful content was `approvers at head: coderabbitai`, and
everything after it ("a bot-only approval renders like a human one", "the review-sufficiency call is
yours") was the agent explaining the significance of a fact to the person who understands it better
than the agent does.

This is `skills/workflow-guide/output-style.md` rule 10 — *state the fact; do not explain the
mechanism behind it* — reaching the board, and it binds every item's `--prompt`: questions,
approvals, and the deferred entries a flush composes.

**Verify before you post.** A question posted on evidence you have not confirmed becomes a
withdrawal and a repost, which is its own failure category. Re-read the file, re-run the command,
re-check the prior board answer — *then* post. `dashboard item withdraw` exists for when you were
wrong; it is not a substitute for checking. A repost that takes the withdrawn item's place carries
`--replaces "<id>"` naming it (`skills/board/references/dashboard-protocol.md` §2).

## Blocking vs. deferrable

**Blocking** — something genuinely stops until the user answers. Post it now, and name what stops in
`--stalls`.

**Deferrable** — nothing stops. You can keep building, and the answer only shapes what happens
later. Do not post it mid-implementation, where the user has no diff to look at: hold it, keep
working, and post it against the PR once one exists. **Two kinds never qualify, however
little they seem to stall:** a deferral-gate question (contract rule 5), and any question about the
advancing PR's own content, scope, or review findings — `skills/board/SKILL.md` §3 names both as
always entangled and never judgement calls. A deferral-gate question is **recorded** the moment it
fires — with a board, `--defer` queues it on the node, and `dashboard item flush-deferred` posts it
later: against the diff where one exists, or, in a workflow that produces no PR (a PRD, an
architecture doc), with no `--context` at all — `--context` is optional, so the queue is not waiting
on a diff that is never coming. With no board there is no queue to flush: `item add --defer` exits 3 and prints the question, and you ask it in the terminal now and wait for the reply. A question about the advancing PR's own content, scope, or review findings still **posts**
the moment it fires. Recording is not sending: what is forbidden is queuing a deferral-gate question
and never flushing it — the same user-never-sees-it failure the backstop below names for a held
question, just reached through the queue instead of through your own head.

`--defer` is not this section's "deferrable" — never pass it on a question you are holding for the
diff, however cleanly its `--stalls none` fits. Both wait for the diff; the difference is not timing
but who holds it and whether anything enforces the flush. A held question lives in your own head,
where nothing knows it exists. A `--defer` question lives on the node, where the flush and the
approval gate (`skills/board/references/dashboard-protocol.md` §3.1) both act on it. `--defer` is for
a deferral-gate post under contract rule 5 and nothing else.

**Name the terminus before you hold, and if there is no terminus, do not hold.** The terminus is the
PR. A workflow that produces no PR — a PRD, an architecture doc, a memory review,
a cleanup — has none, so the question posts now. A hold against a terminus that never arrives is
indistinguishable from deciding not to ask, and it is the silent drop this contract exists to
prevent.

**When you are unsure whether it blocks, it blocks.** Deferring something that actually stalls the
work costs the whole build; posting something deferrable costs one board item.

A held question that the work itself answers is the mechanism working, not a leak — let it go; the
user reads only the questions still open, never a list of the ones you did not ask. A queued
deferral-gate question the work itself answers before the flush is the same working case —
`dashboard item drop-deferred` removes it. What is forbidden, either way, is a live question the user
**never** sees: held and never posted, or queued and never flushed. That is the failure this contract
exists to fix.
