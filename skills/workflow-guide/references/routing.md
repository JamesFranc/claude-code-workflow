# Routing — Decision Logic, Session Nesting, Delegation

This file is the full protocol behind the contract's rule 1 (workflow-first routing) and rule 2 (board-first decisions). The contract (`skills/workflow-guide/contract.md`, injected every session) is the compact version; this is the complete reference, read on demand.

## Decision Logic

When the user gives you a task:

1. **Is it a bug, test failure, or something broken?** → Use Systematic Debugging (`workflow:systematic-debugging`). **Enter it the moment you encounter the bug — before you read a log, reproduce, or open a file to diagnose; the investigation happens *inside* the skill (its Phase 1), not before it.** It investigates root cause, and — if a code change is needed — writes a bug summary doc and chains into Team Dispatch for the full implementation, review, PR, and cleanup flow.
2. **Is it about PR review comments or feedback?** → Use PR Feedback (`workflow:pr-feedback`)
3. **Is it substantial new work — a new feature, a multi-story epic, or anything with real design space to explore?** → Use JTBD (`workflow:jtbd`) to understand the problem first; it chains into Architecture.
4. **Is it a small, well-understood change that isn't a bug?** (a tweak, small enhancement, refactor, or copy/config edit that follows an existing pattern) → Use Quick Change (`workflow:quick-change`). It writes one combined change summary doc and chains into Team Dispatch. If scoping reveals real design space, it escalates to JTBD/Architecture.
5. **Is the user asking to set up a workspace?** → Use Git Worktrees (`workflow:git-worktrees`)
6. **None of the above?** → Proceed normally, no skill needed. (But writing documentation or editing code is never "none of the above" — that is a change, so route it via Quick Change / Systematic Debugging / JTBD.)

## Dashboard Session Nesting

The dashboard tree mirrors the **work**, not Jira's hierarchy. Nodes are created by
`dashboard session enter`; nesting comes only from `--key`/`--parent-key`, and re-entering an
existing node with a new `--phase` creates **no** new node. The CLI does not adjudicate any of this —
it creates the node it is asked for. What follows is the judgement it is trusting you to make.

- **The root** is whatever the entry skill entered first with **no `--key`** — an epic (JTBD, multi-story) or a single ticket (Quick Change, Systematic Debugging, single-ticket JTBD).
- **A ticket gets its own child node only under a real epic-root node** (a multi-story epic whose epic was entered as the root). A ticket that is itself the root — or that merely belongs to a Jira epic with no epic-root *node* above it this session — re-enters the root (no `--key`). Jira epic membership is never by itself the trigger.
- **A PR gets no node of its own.** PR Lifecycle / PR Feedback re-enter the **ticket node** with a PR phase. A distinct PR node (`--key "<branch>"`) is created **only** when one ticket produces multiple PRs (e.g. a multi-repo story), and it ends when its PR merges (PR Lifecycle's `MERGED` handler), with Team Cleanup ending any that remain.
- **A root is released when the unit of work it names is done — a standalone ticket at its own
  close, or an epic once its last story closes.** Release it (`dashboard session leave --root`)
  before entering a new one — keying new, unrelated work under it instead is how a `DEV-3866` branch
  ends up under a `DEV-3867` node. Before that point, an epic's root stays live across every story
  under it: moving from one story to the next leaves the current story's own keyed node (no `--root`)
  and re-enters the next story keyed under the same still-live epic root (see `team-cleanup`'s
  Auto-Continue step).

Net: **one ticket + one PR = one node.** Extra levels appear only for a genuine multi-story epic or a genuine multi-PR ticket.

`--title` names a node on its first enter. On any later re-enter, omit it — the existing title is preserved automatically. Renaming a node you already entered requires `--retitle`, and the CLI refuses a bare `--title` that would change it (FLOW-180).

## Research Delegation

When you need to investigate the codebase to answer a question, prefer delegating to the `researcher` agent (via the Agent tool with `subagent_type: "workflow:researcher"`) rather than running the investigation inline. This preserves context for the conversation you're actually having with the user.

**If you are a teammate, pass `subagent_type` and no `name`.** `name` requests a *teammate*, the team roster is flat, and a teammate cannot spawn a teammate — passing it does not produce a named sub-agent, it fails the spawn outright with `Teammates cannot spawn other teammates`. Omitting `name` is what makes this a sub-agent. This holds for every agent a teammate spawns, not just the researcher: the implementer's consult spawn (`agents/implementer.md`), and the senior's review sub-agents (`agents/senior-engineer.md` §Sub-Agent Instructions). The team lead is the one exception — it spawns the durable roster *as* named teammates.

**Delegate when:**

- Answering would require reading 3+ files, or
- Tracing a behavior across modules, or
- Running more than a handful of greps/globs, or
- The user's question is "how does X work" and X is non-trivial

**Don't delegate when:**

- The user pointed you at a specific file or symbol (just read/grep it)
- You already have the file open from earlier in the conversation
- The answer is one tool call away

**What to pass the researcher:**

- The specific question (not "explore this area")
- Any files or symbols you already know are relevant, as starting points
- What the answer will be used for (design decision, bug diagnosis, etc.) — helps it pick the right level of detail

**What comes back:** a concise summary citing symbols — or a quoted literal where no symbol exists — with `file:line` beside them. Use it directly; don't re-investigate the same ground — and keep the symbol (or literal) when you copy a finding into a plan or doc, which outlives the line numbers (`skills/workflow-guide/references/durable-references.md`).

**Ending a research agent is an outcome, not a step you take.** A research agent is a *short-lived agent spawned to answer one question*, not part of the durable implementer/senior roster. An **un-named** research agent ends the moment it delivers its result: nothing further is owed, there is nothing to carry to Team Cleanup, and nothing to keep warm in case a follow-up comes. A **named** one does not end on its own — its spawner ends it the moment its answer lands, confirming from the harness's own live-agent state that it no longer runs.

One still running past that point is a leak, stopped by whichever agent is running Team Cleanup — the same actor and the same condition whether or not the spawner is still around. An **un-named** research agent never reaches the team config at all, so that leak is tracked through the process-notes roster instead (`skills/team-cleanup/SKILL.md` §4); a **named** one can still show up in `members[]`, where a row for it at that step is itself the missed-teardown signal §4 checks for, and is closed the same way §4 closes any other roster leak. One agent, one question — a follow-up gets a fresh researcher with a sharper question, which is what **What to pass the researcher** above already asks for: the specific question, not "explore this area".

A leaked agent that the actor responsible for stopping it tried and failed to stop is a board-blocker, not a retry loop: post it per the PR Lifecycle skill's Board Triggers (Unconditional) section rather than continuing to chase it. This rule covers every short-lived question-answering agent, whichever actor is stopping it and whether it was spawned named or un-named, including the senior engineer's own review sub-agents (`agents/senior-engineer.md` §Parallelizing Large Reviews).

## Artifact Delegation

Reading an image or PDF artifact (a screenshot, a rendered frame, a PDF) with `Read` is blocked in a durable context: the team lead, an implementer, or the senior engineer. Read it in one and it is re-sent on every later request in that session. The guard sees only a `Read`; an artifact that reaches a durable context any other way is not caught. Whatever the route, hand the `artifact-viewer` agent the absolute path and the one question to answer, and act on the words it returns (`agents/artifact-viewer.md` §Response Contract). It runs as a sub-agent of whoever needs the answer, never as a named teammate: the guard recognises the viewer only on a sub-agent's own tool calls, so a named teammate's own Read of the same path would still be blocked. It is a short-lived agent under the same rules as a researcher: one artifact and one question, shut down when the report lands.

This is enforced, not advised: `hooks/artifact-read-guard.sh` blocks a `Read` of an image or PDF path from any context except the viewer's own, and its refusal names the viewer. A path can still be passed around, attached, uploaded or cited freely. Only reading its contents is routed.

## Orchestrator Anti-patterns

Recurring patterns that erode workflow quality. Watch for these in your own behavior:

- **Escalate research on user pushback from experience.** When the user pushes back from cross-project experience against an implementer's quick finding, escalate research instead of constructing user-facing alternatives from the implementer's framing. The user's "I use this everywhere" is a signal that the implementer's first read is incomplete — dig deeper before proposing options.
- **Verify tool capabilities before asserting them.** Don't claim a tool supports a feature (JSONC, default-updater behavior, alias matching, etc.) without verifying. A 30-second source check or dry-run beats a confident-but-wrong claim that costs a round-trip.
- **Use `check-tools`, not `check-mcp`.** `check-tools` lives in the workflow plugin and reports environment/configuration intent for Jira and Notion. It does not probe MCP availability. If a configured tool fails when used, stop and report that tool as broken; do not fall back.
- **`AskUserQuestion` is never the substitute for a nuanced conversation.** While a board is available it is blocked (contract rule 3) — a clarifying question the user must answer goes on the board with its options inline in the evidence block; otherwise decide it yourself.
- **Don't ask about anything the governing PRD already answered.** Before filing a ticket, escalating, or asking a clarifying question, re-read the active PRD/design doc's Out of Scope section — an accepted limit is an answer, not an open question. (FLOW-145 #7 — supersedes the earlier FLOW-129 don't-over-gate phrasing.)
- **Deferring discovered work is the gated act — not filing the ticket — and it is gated at the moment you decide, not at project close.** The instant you catch yourself writing "deferred", "out of scope", "follow-up" or "later" about work you spotted, write what the work is and where you found it to `<tmpfile>` (temp file, never a shell string — why: `skills/board/references/dashboard-protocol.md` §2) — that prompt is the work you spotted and where, nothing else: `--why-mine` already carries why it is yours and `--recommend` carries what you recommend, and restating either in prose is the padding `skills/board/references/escalation-contract.md` §Required question form forbids — then queue `dashboard item add --type question --recommend "<one line>" --stalls none --why-mine scope --prompt "$(cat "<tmpfile>")" --defer`, then `rm -f "<tmpfile>"`. With a board, `--defer` records it on the node rather than posting or waiting, which is exactly why it requires `--stalls none`: nothing stalls while you keep building, but any advancement approval on this node is held until the queue holds no pending entry — each one flushed and then answered and consumed like any other posted question (contract rule 2 / `skills/board/references/dashboard-protocol.md` §3.1), or dropped because the work itself answered it (`dashboard item drop-deferred` removes it — the user reads only the questions still open); an empty queue alone does not permit advancement. With no board there is no queue to flush: `item add --defer` exits 3 and prints the question, and you ask it in the terminal now and wait for the reply. With a board, the user's decision on whether to file it arrives only once something flushes the queue (`dashboard item flush-deferred` — against the diff where one exists, or, in a workflow that produces no PR, with no `--context` at all, since the queue is not waiting on a diff that is never coming) and the user answers the posted questions — do not park here waiting for it. Surfacing it in the retrospective or the closing summary is too late: the deferral has already happened and the user never got the chance to say "no, do it now." Spotting follow-up work is likewise not authorization to *file* a ticket for it on your own. **With no Jira configured**, every search, read, fold and create below is skipped and none of them stops you: on approval, report the work to the user in-session as approved and untracked (*Cross-Phase Rule: No Jira, No Ticket* below). **Fold before filing.** When you queue the deferral under an active epic, query its To Do children (`parent = <EPIC-KEY> AND statusCategory = "To Do"`), paged to exhaustion as Team Cleanup's remaining-stories query is (`skills/team-cleanup/SKILL.md` step 1), and judge whether one covers the same kind of problem: the same tool or CLI, the same skill or area, the same class of defect. `--recommend` names the outcome (`fold into <KEY> — <why it fits>`, or `new ticket — nothing covers <area>`). Never fold into a ticket that is not To Do, and never fold work that would not make one coherent review with the target, however few tickets are open. A failed or partial query, or a failed read at any step below, is never "nothing fits": stop and surface it on the board, as the new-ticket path does for a failed re-read. On approval, re-read the target with `getJiraIssue`; if it is no longer To Do, or its `fields.parent.key` no longer equals the epic's key, do not fold — return the deferral to the user for a new target or a new ticket. Then, still before rewriting, read the epic's status per *Cross-Phase Rule: Never Parent a Ticket to a Done Epic* below; if it is `done` or cannot be read, do not fold — surface it on the board as that rule does. To fold, rewrite the target's problem statement and acceptance criteria in place with `editJiraIssue` so they cover the folded work — the "Correct the description in place" write in *Cross-Phase Rule: Jira Is the Ticket, Not the Working Record* below — with no appended section and no provenance, then re-read it with `getJiraIssue` and confirm the description covers the work. A fold creates no ticket, so the post-create parent re-read below applies only to a new ticket. On approval for a new ticket, create it with `Parent: <the active epic>` so Team Cleanup's live remaining-stories query (`skills/team-cleanup/SKILL.md` step 1) sees it, the epic stays open until it is done, and auto-continue picks it up like any other story — but confirm first that the epic is not already closed, per *Cross-Phase Rule: Never Parent a Ticket to a Done Epic* below; a ticket parented to a Done epic satisfies every check in this bullet and is still dropped, because that remaining-stories query is never run for a closed epic. **Then re-read the created ticket with `getJiraIssue` and confirm `fields.parent.key` equals the epic's key** — assert the equality, not merely that a parent exists. A ticket parented to a *story* beneath the epic passes an existence check and is still invisible to `parent = <EPIC-KEY>`, which matches direct children only. Unparented or mis-parented, the effect is identical: the epic closes clean and the defect this rule exists to prevent returns through a new door. If no epic is active — a standalone story — skip the fold query, say so in the same board question and let the user choose the parent (a new epic, or the current ticket), then create the ticket under that parent and confirm `fields.parent.key` equals the chosen key, exactly as above; never proceed as though it's parented. If `getJiraIssue` fails or the parent key does not match, stop and surface it rather than treat the ticket as tracked — an untracked or mis-parented ticket is invisible to the same direct-child query, which is the silent-drop this whole rule exists to prevent. Ticket-filing is never an outlet for review findings — those are fixed in the same cycle, and `workflow:code-review` routes them to the team lead, who dispatches the fix to the implementer. The workflow skills that open the ticket for the work you were *told* to do — JTBD, Architecture's story tickets, Quick Change, Systematic Debugging, Branch Setup, Syncing Plans to Jira — are not covered by this rule: the user's approval of the governing doc is that authorization. That exemption is from *this* bullet's deferral gate only — the Done-epic check referenced above applies on every path, exempt or not. (FLOW-176.) Granularity is a judgement you propose, not a default: several related deferrals are not automatically several tickets and several PRs — group them by what makes one coherent review, and say what you grouped and why. The same test decides whether a deferral folds into an already-open ticket. (FLOW-182, FLOW-384.) A workflow improvement outside the story you are working is not discovered work: a wrong step, a refusing CLI, a rule that contradicts another, or a workflow defect you noticed, even in the workflow's own repo, goes to the process improvement notes and nowhere else, never through this gate (`skills/board/references/escalation-contract.md` §Workflow improvements are notes). (FLOW-325, FLOW-352.)
- **Skipping the rungs and posting the question anyway.** "3 before me" is ordered and it is not advisory: ask yourself, look it up (the governing doc's Out of Scope, `CLAUDE.md`, the user's review standards, memory, a prior board answer on this node), then ask a teammate — an implementer spawns a senior-engineer consult, a team lead asks the senior already on the team or spawns a researcher, a senior settles it against the implementer on evidence. A question that reaches the board with no recommendation, or without saying what stalls, or without naming which bright line makes it the user's, saying that it is the sixth route, saying that it asks for a fact only the user holds, or saying that it is a deferral-gate post under contract rule 5, did not clear them. Naming one of those says why the question is the user's; it is not evidence the rungs were climbed, and a deferral-gate post clears them the same way every other question does. "I am not certain" is not a bright line; the five that are, the sixth route for a technical disagreement two teammates could not settle on evidence, and the small-addition carve-out — which narrows bright line 4 only, and does not reach an addition that is large, changes user-visible behaviour, or leaves what the approved doc decided — are in `skills/board/references/escalation-contract.md`. (FLOW-240.)

## Cross-Phase Rule: Blocked on a Human Decision → Post to the Board, Every Time

**Blocked on a human decision → post it to the board, every time.** Any phase (JTBD,
Architecture, Team Dispatch, PR Lifecycle): the moment you're blocked on a decision only the
user can make, `dashboard item add` it immediately; never rely on an in-session question alone while a board is available.
While a board is available the user watches it — a decision that lives only in the terminal is one they never see.
The open board item is what keeps the Stop hook watching for the answer; once the user answers,
consume it (`dashboard item consume --item "<id>"`) so it does not outlive the question.
**An improvement to the workflow outside the story you are working is never that decision** — it
goes to the process improvement notes and nowhere else, and the work carries on; if you cannot
finish what you were asked, that is a blocker and escalates by the ordinary rules, as the stalled
work, naming what stalls (`skills/board/references/escalation-contract.md` §Workflow improvements
are notes).

## Cross-Phase Rule: User Decisions Live on the Board First

**Every question or approval to the user is posted as a dashboard item FIRST — the board is the primary surface; the terminal is the notification that one is waiting, never the only place a decision lives, unless no board is available (contract rule 2), when the terminal is the only place.** Any phase: whenever a blocking-decision trigger fires (blocked on a human decision, a "ready"/approval gate, a credential/auth ask (post it as `dashboard item add --type approval --approval-kind credential`, never a bare `--type approval`, so the open-question guard doesn't mistake it for an advancement approval), a paused workflow (post it as `dashboard item add --type approval --approval-kind checkpoint`, the same non-advancement shape as the credential ask)) OR a skill's question protocol has a real question for the user, `dashboard item add` it FIRST, then notify in-session. **That enumeration is not the boundary, and neither is whether you noticed you were waiting — the boundary is whether your turn ends with the next step depending on the user's reply. That is a fact about the turn, not about what you recognised.** The instant you end such a turn — "want me to…?", "shall I proceed?", or any paraphrase — the item goes up before you go quiet; if you saw the dependency coming, post earlier. A question you ask while you keep working is prose; a question that ends your turn is a board item. If you need the answer, stop and post it — never guess and keep working to avoid the post; continuing to work claims you did not need the answer, so make that claim true. A closing question reads as conversational precisely because none of the listed triggers fired; that gap is the case this sentence exists to close. While a board is available the user watches it — a decision that lives only in the terminal is a decision they never see. One exception to "FIRST": an **advancement** approval waits behind an open question that could change it, per `skills/board/references/dashboard-protocol.md` §3.1 — everything else here posts the moment it fires.

The `dashboard` command silently no-ops when its wrapper is genuinely absent — that is the ONLY reason to skip it; run it regardless. A present wrapper that cannot reach `ai-workflow-app` reports instead of swallowing it — `item add` hands the question back (exit 3, to ask in the terminal, `--defer` included), `item flush-deferred` refuses, and, on the keyless zero-leaf path, `item list-deferred`/`item drop-deferred` refuse too (`skills/board/references/dashboard-protocol.md` §1, CLI availability). When the board is present, posting the decision is **required, not optional**.

To re-read a released decision or a rejection note on demand (e.g. a wake was missed), run `dashboard answers` (or `dashboard comments` for reviewer comments). Reading does not consume — reconcile separately with `dashboard item consume`.

**Carve-out:** this covers *decisions, approvals, and gates* — not every sentence. Trivial in-conversation clarifications stay prose, and `AskUserQuestion` is never the substitute while a board is available — it is blocked then (contract rule 3). The rule governs where a *decision the user must make* lives, not turning small talk into cards. It also does not cover the workflow outside the story you are working: a step that is wrong, a CLI that refuses what it should allow, a rule that contradicts another, a workflow defect you noticed are notes in the process improvement file, and proposing the fix is as much a note as asking about it (`skills/board/references/escalation-contract.md` §Workflow improvements are notes).

## Cross-Phase Rule: Never Parent a Ticket to a Done Epic

**Before creating any ticket whose `Parent` is an epic, read the epic's own status — a closed epic never
absorbs new work silently.** Fetch the epic with `getJiraIssue` and read
`fields.status.statusCategory.key`, whose values are the closed set `new` / `indeterminate` /
`done`. Partition on that field, never on the status *display name* — the same discipline Team
Cleanup step 1 (`skills/team-cleanup/SKILL.md`) already applies to an epic's children, now applied
to the epic itself. A fold into one of the epic's To Do children (the deferred-work rule above) runs
the same check before rewriting the target: on `done` or a failed lookup, do not fold.

- **`new` or `indeterminate`** → proceed, including the post-create `fields.parent.key` assertion
  the deferred-work rule above already requires.
- **`done`** → **do not create the ticket.** Write the epic, its status, what the work is, and the
  three ways forward (reopen the epic, parent to a different or new epic, or create it unparented —
  nothing will ever surface an unparented ticket in an epic query, so say so when you offer it) to
  `<tmpfile>` (temp file, never a shell string — why:
  `skills/board/references/dashboard-protocol.md` §2) — that prompt is the epic, its status, the
  work, and the three ways forward, nothing else: a sentence naming whose call the parent is, or
  explaining what a closed epic implies, is the padding
  `skills/board/references/escalation-contract.md` §Required question form forbids — then post a
  `dashboard item add --type question --recommend "<one line>" --stalls "<what waits|none>" --why-mine "<taste|scope|risk|teammate-unsettled|fact>" --prompt "$(cat "<tmpfile>")"`,
  then `rm -f "<tmpfile>"`, then wait. Only the user's answer to *that*
  question authorises parenting under a closed epic, and it authorises the one ticket in front of
  you, never a standing exception for the rest of the session. Whatever the answer selects — a
  reopened epic, a different epic, a new one — **re-run this check from the top against the epic you
  are actually about to parent to.** The answer names a parent; it does not vouch for its status.
- **The lookup fails, or the issue comes back with no status** → stop and surface it. Fail closed,
  exactly as the mis-parented branch does: an unverified parent is not a verified one.

**This check runs on every path that sets an epic `Parent` — including the ones the deferred-work rule
exempts.** JTBD, Architecture's story tickets, Quick Change, Systematic Debugging, Branch Setup and
Syncing Plans to Jira are exempt from *asking permission to file the ticket*, because the user's
approval of the governing doc is that authorization. That approval does not reach the epic. It
authorises creating the ticket; it never authorises re-opening a closed container to hold it.

**Never reopen an epic on your own initiative.** Reopening a Done epic is the user's call — they
either do it themselves or tell you to in so many words. Their approval of the *ticket* is never
itself permission to reopen; and if the epic is reopened, re-read its status before you create,
because a reopen you did not verify is an unverified parent. (FLOW-201.) Starting and closing an
epic are the workflow's own transitions — *Cross-Phase Rule: The Workflow Moves Its Own Tickets*
below. (FLOW-209, FLOW-424.)

## Cross-Phase Rule: The Workflow Moves Its Own Tickets

**The workflow moves the tickets it delivers through their statuses itself — the user never has to
close one by hand.** With Jira configured, a story moves at three points and its epic at two:

| When | Ticket | To | Where |
|---|---|---|---|
| Work starts | the story, and its epic when the epic is `new` | "In Progress" | `skills/team-dispatch/SKILL.md` step 2 |
| The PR leaves draft for human review | the story | a review status, when the project has one | `skills/pr-lifecycle/SKILL.md` §Moving the Ticket to Review |
| The work is done — every PR merged, or the user explicitly confirmed it complete | the story | Done | `skills/team-cleanup/SKILL.md` step 1 |
| The epic's last story is confirmed Done | the epic | Done | `skills/team-cleanup/SKILL.md` step 1 |

**Find a transition by where it leads, then confirm it landed.** Read the ticket with `getJiraIssue`
first: a ticket already at the target — for Done, a `done`-category status named "Done"; for review,
a review status — needs nothing. A ticket in any `done`-category status, "Done" included, is never
moved toward review. One in a `done`-category status other than "Done" ("Won't Do", "Cancelled",
"Closed") is never moved toward Done either: moving it would overturn an outcome someone else
recorded. Report that case, since delivered work is then sitting in a status that does not say so.
Otherwise `getTransitionsForJiraIssue` lists the transitions open from the current status, each with
its target's `to.id`, `to.statusCategory.key` and `to.name`. Several transitions can lead to one
status — a global "Done" beside the workflow's own is common — so choose a target **status**,
counting statuses by `to.id`, never transitions:

- **Done** — the status whose `to.statusCategory.key` is `done` **and** whose `to.name` is "Done",
  compared without regard to case. Only that name shows the status means the work was delivered: a
  lone done-category status named anything else — "Won't Do", "Cancelled", "Duplicate", or even
  "Closed" or "Resolved" — may record the work as not delivered, so it is never chosen. No such
  status, or more than one, → make no transition and report it. A status named "Done" in another
  category is not Done.
- **Review** — the statuses whose `to.statusCategory.key` is `indeterminate` and whose `to.name`
  contains "review", compared without regard to case ("In Review", "Ready for Review", "Code
  Review"). A review status shares that category with In Progress, so only its name tells them
  apart; the category limit is what keeps a done-category "Reviewed" from closing the ticket.
  Exactly one → that one. None → the project has no review status: make no transition and report
  nothing. Several → ambiguous: make no transition and report it.

Then choose the transition. One transition leading to the chosen status → that one. Several → they
can still differ, since two transitions into one status can set different resolutions, so take the
one whose own `name` is the chosen status's `to.name` ("Done" for Done, "In Review" for an "In
Review" status), compared without regard to case; with no such transition, or more than one, make
no transition and report it. Apply the chosen transition with `transitionJiraIssue`, then re-read
the ticket with `getJiraIssue` and confirm `fields.status.id` is the chosen status's `to.id`.

**Report every failure; never read one as an answer, and never walk the workflow.** A failed or
partial read — of the ticket, or of its transition list — is unknown, never "no such transition":
report it, and never take it to mean the project has no review status. For Done, no done-category
target from the current status means no direct transition: leave the ticket where it is rather than
stepping it through intermediate statuses, and report it. A failed transition, an ambiguous choice,
or a re-read that does not show the target is reported the same way. To report is to say so
in-session — the ticket, its current status, and what failed — and to post the same as an info note
(`skills/board/references/dashboard-protocol.md` §8): a ticket the workflow meant to move and left
where it was is what the user would otherwise lose in the thread. A report never holds up the step
it runs in.

**Only forward, and only the workflow's own work.** Never move a ticket out of `done` — reopening a
story or an epic is the user's call, made by them or on their instruction in so many words. Never
close a ticket the workflow did not deliver: a dropped, won't-do or duplicate ticket stays open
until the user says otherwise, and an explicit "close it" from the user on a specific ticket is
that instruction. With no Jira configured, none of this runs (*Cross-Phase Rule: No Jira, No
Ticket* below). (FLOW-424.)

## Cross-Phase Rule: No Jira, No Ticket

**Jira is used only when it is configured.** `check-tools` reports `jira` `unconfigured` when no
`JIRA_*` or `ATLASSIAN_*` variable is set. That is not a stop: the work runs with no ticket, from the
front door to the merged pull request. `failed` still stops, and a configured Jira that does not
answer still stops, as before.

With no ticket:

- **The branch name stands in for `<TICKET-ID>` wherever it is a key.** Every ledger's `--ticket`,
  `workflow-state record-entry --key` and `dashboard session key --ticket` accept any non-blank
  string. A file name, a directory name or a prefix match built from it uses `<branch-key>`, the
  branch name with each `/` replaced by `-`, so the path stays flat: the notes and proofs files and
  the worktree directories. Where the branch itself is needed — `git branch`, `-b`, the pull request
  head — it stays `<branch-name>`. Pick a branch whose `<branch-key>` no other local branch shares,
  since `fix/login` and `fix-login` would otherwise share notes, proofs and worktree names. The
  check runs in `skills/git-worktrees/SKILL.md` §2 Create, before its `-b`, and Branch Setup §4
  reaches it before its own `-b`. A checkout of a branch someone else named picks nothing: if its
  `<branch-key>` equals another local branch's key, stop and post a board question, at
  `skills/git-worktrees/SKILL.md` §Naming's checkout row and Branch Setup §4 Checkout. Never proceed
  on a shared key.
- **Before the branch exists** — a front door's dashboard lookup runs before Branch Setup — use the
  slug the branch will take. No node carries that key yet, so `dashboard session key --ticket`
  prints nothing and exits 0, which every block reads as the root.
- **A commit subject or pull request title drops the `[<TICKET-ID>] ` part** rather than carrying the
  branch name: `hooks/conventional-commit.sh` and `hooks/pr-title-guard.sh` accept a subject with no
  ticket and reject a bracketed branch name. The pull request body leaves out its Ticket section.
- **Every step that reads or writes Jira is skipped**: creating, transitioning or assigning a ticket,
  `dashboard link add --kind ticket`, the task checklist sync, and the epic's remaining-story search.
  Skipped means not run and not replaced, and the run goes on to the next step.
- **An epic has no story tickets and no epic ID.** The architecture doc's story list is the plan, and
  its topic slug (the `<topic>` of `YYYY-MM-DD-<topic>-2-arch.md`) stands
  in for the epic ID wherever that is a key or a file name: the one epic-level notes file every story
  appends to is keyed by it. Team Dispatch runs one story, and Team Cleanup reports the
  remaining stories as not started or not confirmed delivered rather than searching for the next one
  (`skills/team-cleanup/SKILL.md` §1).
- **Discovered work the user approves through the deferral gate has nowhere to be filed.** Report it
  to the user in-session as approved and untracked, rather than creating anything.

## Cross-Phase Rule: Jira Is the Ticket, Not the Working Record

**A Jira ticket says what the work is and which of its tasks are done — never how the work went.**
The working record stays local: the design doc and implementation plan under `docs/plans/`, the
process-improvement notes, the board, and the PR body. None of it is copied to Jira. These are the
only Jira writes any phase makes:

- **Create a ticket** with a summary and a brief problem statement or acceptance criteria. No
  provenance (who decided it, which board item, which story found it), evidence, sweep results or
  history.
- **Link its design docs** on the description's first line — `[PRD](<url>) | [Architecture](<url>)`,
  `[Bug Summary](<url>)`, `[Change Summary](<url>)` — hosted pages only, never a local path. No
  hosted page means no link line, not a summary in its place.
- **Keep the task checklist** — add it (`workflow:syncing-plans-to-jira`) and check items off
  as tasks complete (`skills/team-dispatch/SKILL.md` step 16).
- **Set fields** — assignee, the transition to In Progress, parent, and blocked-by links.
- **Correct the description in place** — rewrite the problem statement when the ticket's scope
  changes, or fix a defect a review note names. The corrected text replaces the old; nothing is
  appended explaining the change.
- **Post one closing comment** when a ticket is closed or dropped without shipping — obsolete,
  superseded, a duplicate, won't do, or no code change needed. One or two sentences giving the
  reason, naming the superseding ticket or PR where there is one: "Superseded by FLOW-287 (PR #345),
  which removed proof-ledger's audit command." No evidence, greps or commit trail.

Nothing else is written to Jira: no other comment, and no section appended to a description — not
evidence gathered mid-story, not a correction to the ticket as filed, not a decision, not a note
"recorded here so this ticket does not re-derive it". A finding worth keeping goes in the local
record.

## Important

- **Route to the right entry point.** Substantial new work starts at JTBD; small non-bug changes start at Quick Change; bugs start at Systematic Debugging. Writing or editing documentation is itself work — route it through Quick Change (or the relevant entry point); docs are not exempt. **Investigating a bug is itself work too — enter Systematic Debugging the moment you hit the bug, before you start diagnosing; reading code to understand a bug is its Phase 1, not a precursor.** Don't jump straight into coding, docs, or architecture from any of them.
- **Small ≠ skip.** Whether work goes through Quick Change or an abbreviated gate, every change still gets a ticket, an approved doc, senior review, and a PR. "Small change" is never license to edit files directly.
- **Don't announce this skill.** Just use the decision logic above and invoke the right skill. The user should see you starting with JTBD, Quick Change, or Systematic Debugging, not "I'm using the Workflow Guide."
- **Skills can self-abbreviate.** If the problem is obvious, JTBD writes a quick PRD and moves on. If the architecture is a repeat, Architecture writes a brief doc and moves on. The gates are fast when they can be.
- **Two paths use a single combined doc.** Bugs get a **bug summary doc** (Systematic Debugging) and small changes get a **change summary doc** (Quick Change) — each a PRD+arch hybrid — instead of separate PRD and architecture docs. The downstream chain (Team Dispatch, senior review, PR lifecycle, process improvement notes, cleanup) is identical to feature work.
