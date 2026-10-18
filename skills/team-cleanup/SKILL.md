---
name: Team Cleanup
description: After PR merge or user confirmation, run a process & memory review, remove worktrees, shut down team members, pull main and reinstall dependencies, and optionally start the next story. Standalone — usable outside Team Dispatch.
---

# Team Cleanup

## Overview

Clean up after a story is complete — run a process & memory review, remove worktrees, shut down the team, and reset the repo to main. If the story is part of an epic with remaining stories, automatically start the next one.

## Input

- **Worktree path(s)** and **branch name(s)** — the worktrees to remove
- **Repo root path** — the main repo directory (not a worktree)
- **Team member names/IDs** — all agents to shut down
- **Process improvement notes file path** — for the process & memory review
- **Epic context** — the epic key, if this story belongs to an epic. The remaining-stories list is **not** an input: it is derived live from Jira in step 1, so tickets created after the epic was planned are counted.
- **(Repo owner/name, PR number) pairs for the story's PR(s)** — each PR carries its own repo, never one repo assumed across all of them: a monitor's identity is `(repo, PR number)`, and a multi-repo story's PRs live in different repos. Used to stop watching the PRs before worktree removal; on a standalone run, derive each pair from the story's dashboard PR links (which carry each PR's own repo), or per repo with:

      gh pr list --repo "<owner/repo>" --head "<branch>" --state all --limit 100 --json number

  Both filters are load-bearing. `gh pr list` defaults to `--state open`, and this skill runs **after** merge — so without `--state all` the story's own PR is filtered out, the derivation yields nothing, and step 2's monitor stop is skipped with no error, leaving the PR watched past worktree removal. `gh pr list` also defaults to a 30-item page and has no exhaustive-pagination flag — `--paginate` is `gh api`-only — so `--limit` raises that ceiling without removing it.

  **A returned count equal to the `--limit` is a truncation signal, not a complete set.** Re-run with a higher limit, or stop and ask the operator to enumerate the PRs directly. Never treat a possibly-partial fetch as the whole list.

## Steps

### 1. Process & Memory Review

Run the end-of-project review **before anything is torn down**. It has two tiers; pick the tier from whether the whole unit of work is finishing.

**First, close the story in Jira** (when Jira is configured) — but only on a condition you can observe: every PR this story registered is merged (`gh pr view "<n>" --repo "<owner/repo>" --json state` reads `MERGED` for each pair in the Input above), or the user explicitly confirmed the work complete. Anything else — a PR closed without merging, a pair whose state cannot be read, a run with no PR and no such confirmation — closes nothing, and says so in-session. When the condition holds, transition the story to Done per `skills/workflow-guide/references/routing.md` §Cross-Phase Rule: The Workflow Moves Its Own Tickets, which also says how a failure is reported; a failure never holds up the rest of cleanup. The story is **confirmed closed** when that section's re-read shows `done`, or when the ticket was already `done` — the epic close below depends on it.

**Determine the tier.** `wholeUnitClosing` is true when this story is a standalone story, or when its epic has no remaining children by the derivation below.

**When Jira is configured, derive the remaining stories live from Jira — never from a passed-in list.** A ticket created mid-epic through the deferral gate (contract rule 5) is invisible to any list captured back when the epic was planned, and trusting that stale list is exactly how an epic gets declared done with work still open. Query at cleanup time using the **Epic context** epic key:

    searchJiraIssuesUsingJql: parent = <EPIC-KEY> AND statusCategory != Done

(JQL names the category; the partition below keys on the same three categories by their API values.)

**Page the query to exhaustion, and request `statusCategory` explicitly.** Jira's search API paginates — a default page is not the full child set — and a partial response is indistinguishable from a short one. Keep fetching until the result set is complete before treating it as the remaining set, and make sure each returned child carries `statusCategory`, since the partition below is keyed on it. A truncated page silently hides open children, which closes the epic early: the precise failure this derivation exists to prevent. A pagination failure part-way through is a **failed query, not a short result set** — a partial page set is not a smaller remaining set, it is an unknown one, so fail closed exactly as for a query that never returned.

The workflow closes each story it delivers when that story's cleanup runs (above), yet a returned child may still be genuinely unstarted, in flight, delivered without the workflow and not yet closed, or one whose Done transition failed. Partition on the Jira **`statusCategory`** field, whose values are the closed set `new` / `indeterminate` / `done`. Never partition on status *display names*: those are per-project, renameable and unbounded (Backlog, Selected for Development, In Review, Blocked, QA, Ready for Deploy …).

- **Category `new` (the "To Do" class)** — not started by anyone. These are the **auto-continue candidates** — the only children step 7 may start — and they are part of the remaining set defined below, not the whole of it. An approved mid-epic ticket lands here.
- **The story being closed right now** — excluded from the remaining set. It is the one ticket this run legitimately knows the state of.
- **Any child not in category `new`** — including one whose category is missing or unrecognised — **is this class.** Do **not** assume it is finished: it **blocks** whole-unit close and is **never** auto-continued into. This is a default, not a list: a status nobody anticipated falls here and fails safe, instead of vanishing from the set and closing the epic with open work.

`wholeUnitClosing` = that remaining set — both classes, minus the current story — is empty.

**When this story is an epic child, `wholeUnitClosing`, and the story is confirmed closed (above), close the epic too** — the same Done transition, applied to the epic's key, under the same rule. `wholeUnitClosing` leaves the current story out of the remaining set, so without that confirmation an epic could close over a story whose own close failed; when the story is not confirmed closed, leave the epic open and say so. It runs only on a remaining set derived successfully: a failed or partial query is never whole-unit closing (below), so it never closes an epic.

**Whenever this run ends with the epic incomplete and no further story starting, say so — the epic-incomplete report.** The trigger is not a particular shape of the remaining set; it is the invariant: **the remaining set is non-empty and step 7 will not auto-continue.** That covers every route to it — the remaining children are all non-`new` and so unconfirmable; every remaining `new` story is blocked (step 7 item 2); a story was dispatched and abandoned and now sits non-`new` forever; the Jira query failed and nothing could be derived at all; or, with no Jira, the architecture doc lists stories not yet delivered.

This matters because nothing re-checks after this run ends: if no further cleanup runs for this epic, the heavy tier is skipped permanently rather than deferred. That holds however this run ends — last story, blocked tail, stale re-validation, or a pause. Do not assume the remaining children are done — and do not stay silent either. Silence is the lossy option here, not the conservative one.

Report: state which condition stopped the run, say plainly that the epic-level consolidation has **not** run, and give the one-step recovery — once the remaining tickets are closed, the heavy tier can be run on demand, since **Memory Review** (`workflow:memory-review`, heavy mode) and **Process Improvement Notes** (`workflow:process-improvement-notes`, consolidate mode) are both standalone-invocable. When the remaining set was derived successfully, list those children with their statuses. When it could **not** be derived — the query failed — say exactly that: *the remaining children could not be determined because the Jira query failed*. Never emit an empty or absent list in that case; an empty list reads as confirmation that no work remains, which is the false all-clear this whole derivation exists to prevent.

**If Jira is unreachable or the query fails, fail closed** — scoped to the epic-level decisions this step governs: *on unverified epic state, take no expensive or irreversible epic-level action, and name the skipped check.* Concretely — treat it as **not** whole-unit closing, run only the light tier, do **not** auto-continue in step 7, and emit the epic-incomplete report above, saying the epic-completion check itself could not run. This does **not** hold up the rest of cleanup: steps 2–6 (stop watching the PRs, remove worktrees, shut down the team, pull main and reinstall dependencies, delete the branch) proceed normally, since a Jira outage is no reason to strand a worktree or leave agents running. These are consequences of a single rule, not independent defaults; never read any of them as the permissive case. Never infer "no remaining stories" from a failed query — a false whole-unit close silently ends the epic with work still open.

**With no Jira configured there is nothing to query, and that is not a failure.** The remaining set is the stories the architecture doc lists, other than this one, that are not delivered; one whose delivery cannot be confirmed counts as remaining. Step 7 does not run, since it works from Jira's children. With none remaining (or no architecture doc), `wholeUnitClosing` is true. With any remaining, `wholeUnitClosing` is false — the light tier only — and the epic-incomplete report is owed, listing those stories as not started or not confirmed delivered so the next one can be begun by hand; the query-failed wording above does not apply.

**Every story close (light tier):**

1. Invoke the **Process Improvement Notes** skill (`workflow:process-improvement-notes`) in **retrospective** mode. Pass the notes file path, ticket ID, and summary. This captures end-of-session observations.
2. Invoke the **Memory Review** skill (`workflow:memory-review`) in **light** mode. Pass the ticket ID and summary. This captures this story's durable learnings, reconciles anything it plainly made stale, and routes any review standard this story surfaced to `<launch-dir>/.claude/review-standards.md`, creating that file if it is absent.

**When `wholeUnitClosing`, additionally (heavy tier):**

3. Invoke the **Process Improvement Notes** skill (`workflow:process-improvement-notes`) in **consolidate** mode. Pass the notes file path and a summary — plus the epic ID (with no Jira, the architecture doc's topic slug) when this is an epic's last story; a standalone close has only its ticket ID. This reads the notes file's per-story observations and writes a **Consolidated Digest** into the same notes file — deduped and tightened toward the cross-org harvest's slip/harden shape, complementing (not replacing) the harvest. Run it **before** the heavy memory sweep so that sweep reads consolidated notes.
4. Invoke the **Memory Review** skill (`workflow:memory-review`) in **heavy** mode — the full cull / reconcile / promote sweep over the whole memory store, reading the project's (now consolidated) process-improvement notes as source. Heavy mode also backfills the review-standards file from review-shaped memories already in the store.

### 2. Stop Watching the PRs

Unwatch **every** PR this story registered — one per `(repo, PR number)` pair from the Input above. A watch's identity is the pair, so a multi-repo story watches a PR per repo, and stopping one leaves the rest watched. A merged or closed PR is already unwatched; the call is an idempotent unregister and reports `was not watched` for it.

```bash
pr-monitor --stop --pr "<n>" --repo "<owner/repo>"
```

Run that once per pair, and confirm each call succeeded before moving on. A pair whose stop fails is a blocker, not a warning — report it rather than continuing into worktree removal.

**An empty pair list fails closed.** Never read "the derivation returned nothing" as "this story had no PRs": both `gh pr list` defaults that produce an empty result — `--state open`, and the 30-item page — do so silently, and this skill runs after merge. Cross-check the monitor roster in the process improvement notes file, which records each monitor's PR number and repo when it starts (§4. Shut Down Team Members). If that is empty too, stop and ask the operator to enumerate the story's PRs before removing any worktree.

### 3. Remove Worktrees

First stop any playtest still running from a worktree you are about to remove. `playtest list`
prints every recorded playtest with its `dir`; for each one whose `dir` is the story worktree or
inside it, or one of the `tmp/<TICKET-ID>-*` worktrees, run `playtest stop --name "<its name>"`.
A playtest outlives its worktree otherwise, still holding its ports.

```bash
git worktree list --porcelain
git worktree remove "<path from the listing above>"
git worktree list --porcelain | grep -F "/.worktrees/tmp/<TICKET-ID>-"
```

Remove all worktrees created for this story: the story worktree at the path it actually has (not a
path rebuilt from the branch name), and each `tmp/<TICKET-ID>-*` worktree the grep lists
(`workflow:git-worktrees` §Naming; with no ticket the grep and the skip list are
`workflow:git-worktrees` §Cleanup's, keyed by `<branch-key>`, and a skipped entry is left in place
and named to the user). If a worktree has uncommitted changes, warn the user rather than
force-removing.

### 4. Shut Down Team Members

Send a shutdown request to every spawned implementer and senior engineer. (PR watches are stopped in step 2 above — not shut down here; a leaked short-lived question-answering agent is handled separately, below.) Teardown is this per-agent shutdown handshake, falling back to a `kill` of an unresponsive pane-backed teammate's process (below) when the handshake cannot complete: there is no team-level teardown, delete, or stop tool that removes the whole team in one call. Don't look for one and don't invent one — the harness reaps each pane when that agent shuts down via the request above. (The `check-refs` lint guard denies the invented team-tool names in skill text for exactly this reason.)

**A research agent — or any other short-lived question-answering agent — still running at this step is a leak, not the expected case.** Short-lived question-answering agents — researchers, the senior's review sub-agents, the implementer's consult spawns, and any future kind spawned the same way — are shut down when their answer lands, not here (`skills/workflow-guide/references/routing.md` §Research Delegation). Check by **kind of spawn, not by agent-type name** — naming types one at a time only ever covers the ones someone remembered to add. A short-lived agent spawned **named** (a researcher can be) can still show up in the team config's `members[]`; a row for one at this step is a missed teardown — shut it down with the handshake and record it in the process improvement notes so the leak stays visible instead of being absorbed by cleanup. A short-lived agent spawned **un-named** — teammates can't name sub-teammates, so this is every review sub-agent and every consult spawn — never reaches the team config at all; that check is structurally blind to it. Check it against the process-notes roster instead (below): a roster entry for this ticket, written by any session belonging to this run, with no matching teardown record is the leak, whichever un-named kind it names — stop it, the outcome `skills/workflow-guide/references/routing.md` §Research Delegation describes, and record it the same way in the process improvement notes.

Work from a **durably-tracked roster.** Maintain the list of every spawned agent (implementers, senior, and any short-lived question-answering agent still owed a teardown) and every PR monitor somewhere a re-derive can recover it after compaction — the process-notes file — not only in working memory. **Whoever spawns an agent or starts a monitor writes its roster entry at that moment** — the roster is written by the spawner about the spawned, not reconstructed later from memory or at teardown. Every roster entry records the ticket ID and the session ID **of whichever session wrote it**, plus identity fields that differ by entry kind — the agent ID and agent type for an agent, the PR number and repo owner/name for a monitor. Teardown reads back the entries for the current ticket and **any session belonging to this run** — the team lead's own plus every teammate spawned this run — since the notes file is shared across the whole epic, and an entry an implementer or the senior wrote carries *that teammate's* session ID, not the team lead's; filtering on the team lead's own session alone would silently exclude every entry a teammate wrote, which is exactly how a teammate-spawned short-lived agent (one of the senior's review sub-agents) goes untracked at teardown. A monitor is keyed that way because it has neither an agent ID nor a `SendMessage` handshake: the PR number and repo owner/name are the identity `pr-monitor --stop` (step 2 above) actually consumes. On a long job, "who did I spawn?" is exactly what a summary drops; if the roster is lost, re-derive it from the team config (`~/.claude/teams/<session-id>/config.json`) and the running background tasks before declaring teardown complete.

**Verify shutdown — don't assume it.** After sending the requests, run `mailbox teammates` — it lists every roster member except **team-lead** and any explicitly marked **in-process**, each with the pid of its running process, or `null` when none is running, plus any `orphans` (teammate processes of this team that have already left the roster). When the harness has already removed the team — it deletes the team directory once the last teammate exits, and that teammate's shutdown acknowledgment goes with it, so it is never delivered — the output carries `"dissolved": true` and lists the roster this session last saw, each member's pid still read from the live process table. Read a dissolved team's members exactly as a live team's: a `null` pid is a teammate that is gone. An in-process teammate is never listed here and has no pid of its own, so it can never be confirmed or killed this way; for one of those, the handshake's own acknowledgment or the teammate's delivered result is the only evidence its shutdown completed — if neither arrives, fall back to the board-blocker path below rather than treating silence as clean. **A non-zero exit from `mailbox teammates` means it could not check** (ps failed, no session id, or no team config and no roster saved from one — the team never existed, it dissolved before any scan, or every save failed — or a team config that is unreadable, malformed or another session's, or a saved roster that is unreadable or malformed) — never that shutdown is clean; fall back to that same ack-or-blocker path when it happens. A listed member whose pid is `null` is gone: its shutdown is complete whether or not an acknowledgment arrives, and waiting on one is waiting on a process that does not exist. **An agent that self-terminated on delivering its result cannot acknowledge** either — for one of those the delivered outcome is itself the evidence it is gone. Record the two distinctly, an acknowledgment where one was received and a delivered outcome where none could be, and never count the second as the first.

**Never end your turn waiting for a shutdown acknowledgment.** The last teammate's acknowledgment is lost whenever the team dissolves, and nothing but the dead-teammate wake, up to one wake-mod poll later, reaches a lead that has stopped to wait for it. Wait in the same turn, on the process instead: re-run `mailbox teammates` every few seconds until every listed member's pid is `null` and `orphans` is empty, for at most 60 seconds. An in-process teammate, which has no pid, counts as shut down inside that same window only if its acknowledgment or its delivered result has already arrived; if neither has when the 60 seconds end, it goes to the board-blocker path below, never to ending the turn. An acknowledgment that arrives after its teammate's process is gone needs nothing further.

**A pane-backed teammate whose process is still running when that 60-second bound expires cannot complete the handshake** — for example, it has lost API access (every turn answers `Not logged in`) or is wedged. Kill its process: `kill "<pid>"` with the pid `mailbox teammates` reported for it, then re-run `mailbox teammates` a few times over a bounded window (up to ~10s) — a process handling `SIGTERM` can still show up on the first re-scan. Only a pid still present after that window is a survivor; confirm the member's pid is `null` or the member is gone. Kill an `orphan` the same way. Only ever kill a pid `mailbox teammates` reported for this team — never a pid found any other way. An in-process teammate has no pid to kill this way; an unresponsive one that never acknowledges and never delivers a result is the board-blocker case below, not a kill. If the process survives that window, that is a blocker: post it per the PR Lifecycle skill's **Board Triggers (Unconditional)** section, writing which agent and pid survived to `<tmpfile>` (temp file, never a shell string — why: `skills/board/references/dashboard-protocol.md` §2), then `dashboard item add --type approval --approval-kind checkpoint --prompt "$(cat "<tmpfile>")"`, then `rm -f "<tmpfile>"`.

Then confirm no zombies against ground truth: the team config's `members` no longer lists the teammates, no orphaned teammate processes remain (e.g., `ps` shows none, or `kill -0 "<pid>"` fails), and the worktrees removed in step 3 are actually gone from git's own bookkeeping (`git -C "<repo-root>" worktree list` no longer lists the story worktree's path from step 3, or any of the `tmp/` entries removed there — not a blanket `.worktrees/tmp/<TICKET-ID>-` prefix match; `<branch-key>` replaces `<TICKET-ID>` when the story has no ticket). The story's board node is a separate check deferred to step 6 below — `dashboard session leave` is what ends it, and that doesn't run until step 6, so a node-ended check at this point in teardown would have nothing true to find yet. Capture these three as actual command output — run each check bare, with its output redirected to `<file>` and `rc=$?` captured on the next line, never through a pipe: `$?` immediately after a pipe reports only the last stage's exit status, so an earlier stage (e.g. the first `grep` in a `grep | grep -v` filter) can fail silently while `rc` still reads clean. If a check's output needs filtering, do that as a separate step against the captured file afterward, never fused into the piped line whose exit status gets recorded. Each of these three checks has a *passing* form that is itself a non-zero exit (`kill -0 "<pid>"` failing because the process is gone, a zero-match `grep` over the team config, or a zero-match `grep` over `git worktree list`'s output for the removed paths), so each records as `--capture sweep`, which accepts 0 or 1 (2+ still means the tool itself failed to run, not that the zombie is absent) — `proof-ledger record --ticket "<TICKET-ID>" --task team-cleanup --capture sweep --sha "$(git -C "<repo-root>" rev-parse "<abbreviated-sha-from-proofs-file>")" --command "<the exact command you ran>" --exit "$rc" --output-file "<file>" --sha-is-label`. This runs against `<repo-root>`, not against `--sha` — `kill -0` and the two greps read live process/git-bookkeeping state, never the tree at that commit — so `--sha-is-label` is only naming which commit this teardown evidence belongs to, and, for the same reason, the capture carries no `--scope`: `record` refuses one on a label sweep. Never force `--exit 0` or pipe through `|| true` to make a genuinely non-zero teardown check recordable — `record` refuses a non-zero `--exit` under any kind but `sweep` (0 or 1) or `red`, or under a task prefixed `fixture-`, exactly to keep a forced-zero from passing off as this evidence. Index each of the three under the story's proofs file — team config clean, no orphaned processes, worktree gone — not narration; branch deleted and node ended are both indexed the same way at step 6, once `git branch -D` and the closing `dashboard session leave` have actually run. `<abbreviated-sha-from-proofs-file>` is the story's own final reviewed sha as the proofs file spells it — usually abbreviated, and `proof-ledger` requires the full 40-character form. Resolve it against `<repo-root>` (the shared repository, not the removed worktree) rather than `git rev-parse HEAD`: the worktree this evidence is about is already removed by this point (step 3 ran first), so HEAD at this step no longer resolves to anything the story committed, but the commit itself is still reachable from `<repo-root>` via the branch ref — the local branch isn't deleted until step 6, after this evidence is captured. `team-cleanup` is the fixed task name for this orchestrator-level teardown evidence — it is not scoped to any implementation-plan task.

**Pane cleanup is automatic.** The harness owns teammate panes (iTerm2 or tmux, per the selected backend) and tears them down when a teammate shuts down via the request above — there is no manual `tmux kill-pane` step. If you notice an orphaned empty pane after shutdown is confirmed, mention it to the user rather than assuming a tmux command.

### 5. Pull Main and Install

```bash
cd "<repo-root>" && git checkout main && git pull
```

Then install dependencies in that same repo root, per:
`skills/workflow-guide/references/install-dependencies.md`. The merged PR may have moved the
lockfile, and without this the repo root is left holding dependencies that no longer match `main` —
the stale tooling then shows up as spurious diffs at the start of the next story. Warn and carry on
if it fails: a slow or failing install never holds up teardown.

**Important:** Run both in the repo root, not inside a worktree that's about to be (or has been)
removed.

### 6. Delete Local Branch

Capture the delete itself as the proof, rather than checking the ref afterward — a bare
`git -C "<repo-root>" rev-parse --verify --quiet "refs/heads/<branch-name>"` cannot tell *why* it
failed: a branch that was genuinely just deleted, one deleted earlier, and one that was never
created under that name (a typo) all produce the identical empty output and non-zero exit, so that
check proves nothing about which of the three happened. The delete command's own exit and text
don't have that ambiguity — run it un-piped, redirect its output to `<file>`, and capture `rc=$?`
on the next line:

```bash
git -C "<repo-root>" branch -D "<branch-name>" > "<file>" 2>&1
rc=$?
```

Use `-D` (force) because squash merges make `-d` fail — the branch won't show as fully merged. On
success this exits 0 with `Deleted branch <branch-name> (was <sha>).` in `<file>`; a typo'd or
already-deleted name exits non-zero with `error: branch '<branch-name>' not found` instead —
capturing under `--capture evidence` records only the former, since `record` refuses a non-zero
`--exit` under that kind, so a failed delete can never be filed as proof of a successful one. Index
this capture here, alongside node-ended below: `proof-ledger record --ticket "<TICKET-ID>" --task
team-cleanup --capture evidence --sha "$(git -C "<repo-root>" rev-parse
"<abbreviated-sha-from-proofs-file>")" --command "git -C \"<repo-root>\" branch -D
\"<branch-name>\"" --exit "$rc"
--output-file "<file>" --sha-is-label`.

`<abbreviated-sha-from-proofs-file>` is the story's own final reviewed sha as the proofs file
spells it — usually abbreviated, and `proof-ledger` requires the full 40-character form. Resolve it
against `<repo-root>` (the shared repository, not the removed worktree) immediately, in this same
step, before anything else runs a `git gc` there: once `git branch -D` above has run, no ref in
`<repo-root>` points at that commit any more (`git rev-list --all` no longer includes it — the
branch that reached it is exactly what was just deleted), so this `rev-parse` still succeeds only
because the now-unreferenced commit is a loose object git hasn't garbage-collected yet, not because
the commit is still reachable in the ordinary git sense. The same call starts failing (exit 128)
once something runs `git reflog expire --expire=now --all && git gc --prune=now` in
`<repo-root>` — automatically, eventually, on its own schedule — so this resolution is only safe
done here, immediately, never deferred on the assumption that it stays resolvable.

**Dashboard (required when the board is present — run it regardless; `dashboard-protocol.md` §1's CLI availability note covers which verbs report instead of silently no-opping):** Close out the current story's session — re-enter it with phase `cleanup`, flush and settle any deferred queue, then leave it. Invoke `workflow:board` for the protocol (session enter, items, reconcile).

**Enter phase `cleanup` before touching the deferred queue below** — `drop-deferred` records its `atPhase` against the node's current phase, so dropping before entering `cleanup` would attribute the drop to whatever phase preceded it. `list-deferred` only reads and records nothing; `flush-deferred` renders each entry's own defer-time phase, not the node's current one.

By default, no `--key` (a standalone story's root IS the ticket) — closing it out here means ending that root deliberately, so pass `--root` on the `leave` below:

```bash
dashboard session enter --phase cleanup
```
When this story is a child node under an epic root entered earlier this session, use this block instead — `leave --key` (no `--root`) ends this story's own leaf and pops the active pointer back to the epic:
```bash
# This story is a child node under an epic root entered earlier this session — leave --key (no
# --root) ends this story's own leaf and pops back to the epic. --key is required here, not
# optional: for a multi-PR story that already has a branch-keyed PR-level child, this story node
# has a child of its own, so registryLeaves excludes it and a BARE leave silently ends the child
# instead — the story stays live, exit 0, no warning. A bare leave is only safe when this story
# has no live children; --key makes the target explicit regardless.
STORY_NODE_KEY="$(dashboard session key --ticket "<CURRENT-STORY-ID>" --require)" || exit 1
dashboard session enter --phase cleanup --key "$STORY_NODE_KEY"
```

**Now, with phase `cleanup` entered, flush the deferred queue and wait for the flush to be answered and consumed before either `leave` call below.** `leave` withdraws any item still open on the node (`runEnd`'s auto-withdraw runs on every `leave`, not only a bare one), so a flush that is merely posted — not yet answered — is discarded by the very `leave` that follows it, the same loss an unflushed queue would suffer. Run `dashboard item list-deferred` (add `--key "$STORY_NODE_KEY"` on the child path, re-resolved fresh immediately before each invocation with `STORY_NODE_KEY="$(dashboard session key --ticket "<CURRENT-STORY-ID>" --require)" || exit 1` — a shell variable does not survive the wait for a human answer between them); drop what the work itself already answered — `dashboard item drop-deferred --id "<id>" --reason "<what answered it>"` (same `--key`) — then, if the remaining queue is non-empty, flush it — `dashboard item flush-deferred --context "<pr url>"` (same `--key`, re-resolved the same way, on the child path) — treat the posted items like any other board questions (`skills/board/references/dashboard-protocol.md` §2, §4) — it returns one `itemId` per posted question — wait for all of them to be answered and consumed (`dashboard item consume`), not just the first — then run `dashboard item list-deferred` again. A post that fails part-way leaves the rest queued, unflushed, for `leave` to silently discard. A flush can also refuse outright rather than shrink the queue at all — an approval already open on the node, or `--context` alone pushing the first entry past the composed-prompt cap — and its stderr on that refusal names the remedy (withdraw or answer the approval; shorten `--context`, or drop the offending entry with `drop-deferred` first). Repeat list-deferred/flush/wait/consume, resolving whatever a refusal's stderr names, until list-deferred reports an empty queue and no item from any flush is still open, and only then proceed to the matching `leave` below.

Standalone path — flushed and consumed per the paragraph above; leave now:
```bash
dashboard session leave --root
```
Child path (`STORY_NODE_KEY` re-resolved again — the wait for a human answer above spans separate shell invocations, and a shell variable does not survive between them, `skills/board/references/dashboard-protocol.md` §1) — flushed and consumed per the paragraph above; leave now:
```bash
STORY_NODE_KEY="$(dashboard session key --ticket "<CURRENT-STORY-ID>" --require)" || exit 1
dashboard session leave --key "$STORY_NODE_KEY"
```
`--root` is required on the standalone path above because the CLI refuses a bare `leave` at the root otherwise (the backstop for the FLOW-146 live incident, which guards against ending a root *by accident* — a deliberate story close is the case `--root` exists to allow, not the case it blocks).

**When this story is an epic child and `wholeUnitClosing`** (step 1's derivation — this is the epic's own last story, not merely this run's tier choice), the epic root itself is also done: release it right after the leaf `leave` above, so it doesn't stay live for the next unrelated unit of work to attach under (`enter.ts`'s root-reuse rule would otherwise re-enter it — the same stale-root shape `routing.md`'s *Dashboard Session Nesting* section warns against). A deferral-gate question raised during JTBD or Architecture, before any child story node existed, is queued on this root — enter the root with phase `cleanup` first, the same reason the story node above is entered before its own queue is touched (`drop-deferred` would otherwise attribute the drop to whatever phase the root was last left at):
```bash
dashboard session enter --phase cleanup
```
**These two commands are not one unit — do not run them back to back.** With phase `cleanup` now entered on the root, run the same list-deferred/flush/wait/consume loop described in the paragraph above, on the root (no `--key`), and reach an empty `list-deferred` with no item from any flush still open before the `leave --root` below — a flush that is only posted, not yet answered, is discarded by that `leave` exactly as the paragraph above warns:
```bash
dashboard session leave --root
```
Every epic-incomplete route (an unconfirmable remaining child, every remaining `new` story blocked, an unrecoverable Jira query, an undelivered architecture-doc story with no Jira) leaves `wholeUnitClosing` false, so this second release never fires while the epic still has open work — §7 continues under the still-live epic root exactly as before in that case. Run `leave` once per story close, twice (leaf, then root) only when the epic itself is also closing. (protocol: `skills/board/references/dashboard-protocol.md`)

**Verify the board node actually ended, then index that capture here** — step 4 could not: the
`dashboard session leave` above is what ends it, and step 4 runs before this step. Find **that
node's own row** in `ai-workflow-app session list` — the row whose `session.id` is the node id you
captured from `dashboard session status --json` before leaving it, or whose `session.externalId`
carries this session's raw id as its prefix — and require `lifecycle: ended` with `endedAt` set on
that row. Scanning the listing for any row reading `lifecycle: ended` proves nothing: the listing
carries every session's nodes, so an unrelated ended node satisfies an identity-free scan while
your story's node is still active. Do not test for the node being **absent** from that listing
either — the listing returns ended nodes too, so absence never arrives and the check can only be
waited on forever or waved through. "No open items" is a different field on a different object and
is NOT session-ended proof (FLOW-145 #5). This command always exits 0 regardless of the node's
state — the pass/fail lives in the `lifecycle`/`endedAt` fields you read from its output, not in
its exit code — so, like the branch-delete capture above, it records as `--capture evidence`:
`proof-ledger record --ticket "<TICKET-ID>" --task team-cleanup --capture evidence --sha "$(git -C
"<repo-root>" rev-parse "<abbreviated-sha-from-proofs-file>")" --command "<the exact command you
ran>" --exit "$rc" --output-file "<file>" --sha-is-label`. Index it under the story's proofs file
alongside branch-deleted — team config clean, no orphaned processes, and worktree gone are already
indexed at step 4.

### 7. Auto-Continue Epic (if applicable)

If the current story is part of an epic and the live remaining-stories list derived in step 1 contains at least one **`new`-category** child:

1. Choose the next story from the **`new`-category** children in the live remaining-stories list derived in step 1 — not from any list passed into this skill, and never an `indeterminate`-category child. An `indeterminate` child may already be delivered and merely not closed by the user yet; re-dispatching one would spin up a worktree, a team and a PR for finished work. **Pick the candidate that most directly moves the epic toward its North Star — not the next one in the original order.** Read the North Star from the epic's PRD's North Star block (the same one `/reload-goal` reads) and judge every unblocked `new` candidate against it afresh at each story boundary. A ticket created mid-epic and approved through the deferral gate arrives as `new` after the order was set, and is a candidate like any other: it can go first when it matters most. The architecture doc's sequencing is the starting plan and the tiebreaker, never the rule — skip a candidate because it is blocked (item 2), never because it came later in the order. If the epic has no PRD, or its PRD has no North Star block, fall back to the original sequence and say so. The choice is not a question for the user: as the next story starts, state which one you picked and, in one line, why — so a reordering is visible.
2. A blocked candidate — in the **blocked-by link** sense Architecture uses when it sequences stories (`skills/architecture/SKILL.md`), not a Jira status name — is excluded from item 1's choice. If every remaining `new` candidate is blocked, stop; this is the one valid mid-epic pause (see item 4 below). Stopping here means the epic ends this run without consolidation, so emit the **epic-incomplete report** from step 1 as you stop; do not stop silently. If the chosen story seems stale relative to the current codebase (e.g., significant changes since the architecture doc was written), go back to the Architecture skill (`workflow:architecture`) to re-validate before proceeding — and emit the **epic-incomplete report** as you do, exactly as for a blocked story: re-validation is a design loop, not a resumption, so this run ends without consolidation too
3. Once the chosen story is confirmed unblocked and current: **Dashboard (required when the board is present; silently no-ops only if the `dashboard` CLI is absent):** Before starting Team Dispatch for the next story, enter a fresh per-story session so the board never shows one session spanning the whole epic:
   ```bash
   dashboard session enter --key "<NEXT-STORY-ID>" --phase implementation --title "<next story summary>"
   dashboard link add --kind ticket --label "<NEXT-STORY-ID>" --url "<next-story-url>" --key "<NEXT-STORY-ID>"  # skipped with no ticket
   ```
   The just-completed story's session was already closed by the `leave` in step 6 above (leaf ended, active pointer popped back to the parent). This `enter` starts a fresh node keyed to the next story — parent defaults to the root (the epic), so the board shows a new per-story session nested under the epic rather than one session spanning the whole epic. Do **not** `leave` again here; the sequence is close-current-via-leave (step 6) → enter-next (here). The story node is a child of the epic root, and that nesting — not a copied link — is what keeps the epic association visible on the card; a board node carries exactly one live `kind:ticket` link, its own. `<next-story-url>` is the next story's canonical browse URL (the `webUrl` on the `getJiraIssue` response) — never constructed from a hardcoded Jira host. Then automatically start Team Dispatch (`workflow:team-dispatch`) for it — create a new worktree, write a new implementation plan, and spin up a fresh team. (protocol: `skills/board/references/dashboard-protocol.md`)
4. Do not pause at the story boundary — not by asking permission, and not by "flagging a natural break," noting it's "been a long haul," calling the next story "the biggest," or otherwise surfacing a stopping point. The epic's North Star IS the authorization: continue straight into the story item 1 chose. The only valid reasons to stop mid-epic are a hard blocker (every remaining `new` story blocked, or the chosen story stale, per item 2 above) or the user explicitly telling you to pause. **Whenever you stop mid-epic — for any reason in this list, without exception — emit the epic-incomplete report from step 1 as you stop.** The epic ends this run without consolidation regardless of which reason stopped it, and the heavy tier is then skipped permanently rather than deferred. This obligation attaches to *stopping*, not to any particular stop reason: if a future reason to stop is added here, it inherits this automatically.
5. **No user-facing observation gates between stories.** The orchestrator runs the observations itself — live-fire the new hooks, measure the artifacts, run headless routing probes — and records the evidence — the bare command's output redirected to `<file>`, `rc=$?` captured on the next line, never through a pipe (§4's evidence-capture rule above) — via `proof-ledger record --ticket "<TICKET-ID>" --task team-cleanup --capture evidence --sha "$(git rev-parse HEAD)" --command "<the exact command you ran>" --exit "$rc" --output-file "<file>"`, indexed in the story's proofs file. `git rev-parse HEAD` is accurate here, run from the repo root right after step 5's `git checkout main && git pull` — it is the sha of the just-merged main these observations are actually about. `team-cleanup` is the same fixed, non-task-scoped name step 4's teardown evidence uses. Dashboard gates exist only for decisions genuinely the user's (merge, scope, spend) and must carry the already-gathered evidence, framed for a one-click answer.

   This call has no `--sha-is-label`, unlike every other `proof-ledger record` in this skill (step
   4's, and step 6's two): its observations genuinely are about main's
   tree, so `record` requires `<repo-root>`'s working tree clean with `HEAD` exactly at `--sha`, and
   refuses (exit 6, recording nothing) otherwise. Step 5's install can leave `pnpm-lock.yaml` modified
   when the merged PR moved `package.json` without a matching lockfile update — a dirty tree here from
   that is not noise to route around; it means main's committed lockfile is already out of step with
   its own `package.json`, a real finding worth surfacing rather than recording over. This is a
   different failure than step 5's own "warn and carry on if it fails": carrying on past a failed
   install is fine, since these observations don't depend on freshly-installed dependencies to run;
   carrying on into this `record` call with a dirty tree is not, since it exits 6 here instead of
   recording anything. Resolve the dirty tree — revert the working-tree change and route the
   `package.json`/lockfile mismatch as its own reviewed change, or stop and report it — before this
   call, rather than treating step 5's "carry on" as license to also carry a dirty tree into step 7.

## Key Rules

- **Review first** — always run the process & memory review before tearing down the environment
- **Warn, don't force** — if a worktree has uncommitted changes, ask the user before removing
- **Verify shutdown** — don't leave zombie agents; verify within a bounded wait in the same turn, never by ending the turn to wait for an acknowledgment; kill an unresponsive pane-backed teammate's process, and notify the user only if it survives the kill
- **Teardown is the per-agent handshake, falling back to a kill of an unresponsive pane-backed teammate** — `shutdown_request` to every tracked agent from a durable roster; there is no one-call team-teardown tool. Verify no zombies against the team config + process list before finishing
- **Research agents should already be gone** — short-lived question-answering agents shut down when their answer lands, not at cleanup; one still listed here is a leak to shut down *and* record, not a routine teardown
- **Repo root operations** — run git checkout/pull and the dependency install in the repo root, not a worktree
- **One story per cycle** — each story gets its own cleanup; don't batch multiple stories
