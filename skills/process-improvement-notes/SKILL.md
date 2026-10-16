---
name: Process Improvement Notes
description: Track process observations during any workflow — seed notes at the start, check in after milestones, run a retrospective at the end, and consolidate an epic's or standalone story's notes into a promotion-ready digest at whole-unit close. Standalone — usable outside Team Dispatch.
---

# Process Improvement Notes

## Overview

Capture process observations throughout a workflow session. This skill manages a lightweight notes file that tracks skill gaps, build/test friction, and tooling issues. It operates in four modes — seed, check-in, retrospective, and consolidate — and can be invoked by Team Dispatch or any other workflow that wants structured process feedback.

**This notes file is for *process* observations only — not a parking lot for discovered work.** A defect in the product you are working on that is *outside the current story's scope* is deferred work (a defect in the workflow itself is not; it goes here, per the next paragraph): it goes through the deferral gate (contract rule 5) the moment you notice it, not into this file — write it to `<tmpfile>` (temp file, never a shell string — why: `skills/board/references/dashboard-protocol.md` §2) — that prompt is the work you spotted and where, nothing else: `--why-mine` already carries why it is yours, and restating it in prose is the padding `skills/board/references/escalation-contract.md` §Required question form forbids — then queue a
`dashboard item add --type question --recommend "<one line>" --stalls none --why-mine scope --prompt "$(cat "<tmpfile>")" --defer`,
then `rm -f "<tmpfile>"`. With a board, `--defer` records it on the node rather than posting (with no board, `item add --defer` exits 3 and prints the question: ask it in the terminal now); with a board, the user's decision on whether to file it arrives once something flushes the queue (once there is a diff to point at, or, in a workflow with no PR, whenever the caller flushes) and the user answers the posted questions; with no board it is the terminal reply. (A defect in the work you're actively doing, a review finding on it included, is in-scope: fix it in the same cycle, don't defer it and don't park it here.) Writing a defect here and moving on is the silent-drop failure the gate exists to prevent; "I captured it in the notes" is not authorization to defer it.

**Every improvement to the workflow outside the story you are working is what this file is for, and it is the only place it goes.** A skill step that is wrong, a CLI that refuses what it should allow, a rule that contradicts another, a gate that fires when it should not, a workflow defect you noticed that did not stop you, an idea for doing it better — write it here, in check-in mode, and carry on. This holds in the workflow's own repo too: a defect in workflow code the current story does not touch is a note here, not deferred work. It is not a board question, not an approval, not an in-session "should I…?", and not a ticket you file on your own initiative, and it does not go through the deferral gate above: deferred work is work the user asked for that you are not doing, and this is the workflow rather than the work; if you cannot finish what you were asked, that is a blocker and escalates by the ordinary rules, as the stalled work, naming what stalls (`skills/board/references/escalation-contract.md` §Workflow improvements are notes).

## Input

- **Ticket ID** — Jira ticket identifier (e.g., `FLOW-30`), or the branch name when there is no ticket
- **Summary** — Brief ticket description
- **Design doc filename** — The architecture or bug-summary doc for this work, if one exists. Optional — the seed proceeds without it (quick-change / repeat-consolidation / design-skipped paths)
- **Mode** — One of: `seed`, `check-in`, `retrospective`, `consolidate`
- **Notes file path** — Default: `docs/plans/process-improvement/YYYY-MM-DD-<TICKET-ID>-notes.md` (relative to the parent workspace directory, not the worktree; with no ticket, `<branch-key>` in place of `<TICKET-ID>`: `skills/workflow-guide/references/routing.md` §Cross-Phase Rule: No Jira, No Ticket). For a multi-story epic, use one epic-level file keyed to the epic ID (`docs/plans/process-improvement/YYYY-MM-DD-<EPIC-ID>-notes.md`) shared across all its stories. With no Jira, `<EPIC-ID>` is the architecture doc's topic slug (`skills/workflow-guide/references/routing.md` §Cross-Phase Rule: No Jira, No Ticket)

## Modes

### Seed Mode

Called at the start of a workflow (e.g., beginning of Team Dispatch). Creates the notes file and seeds it with initial observations.

**This mode always fires, independent of the upstream path.** It does not depend on a PRD or architecture doc existing — seed on the design-skipped paths (quick-change, repeat consolidation, bug fixes with only a bug summary) exactly as on the full JTBD → Architecture path. For a multi-story epic, the seed targets **one epic-level notes file** (keyed to the epic ID, or with no Jira the architecture doc's topic slug) that every story appends to, rather than a new file per story. If a design doc is absent, seed from the ticket ID and summary alone.

1. Create the `docs/plans/process-improvement/` directory if it doesn't exist
2. Create the notes file with this template:

   ~~~markdown
   # Process Improvement Notes — [TICKET-ID]

   **Status:** [Phase — e.g., JTBD, Architecture, Implementation, Review, PR Feedback, Merged]
   Date: YYYY-MM-DD
   Ticket: [TICKET-ID] — [summary]
   Design doc (if any): [filename]
   PR(s):

   ## Seed Observations
   <!-- Observations from JTBD and Architecture phases -->

   ## Check-ins
   <!-- Observations captured during implementation -->

   ## Retrospective
   <!-- Final observations after PR merge -->
   ~~~

3. Seed the file with any observations from prior phases (JTBD, Architecture) that just completed. These are retrospective — reflect on what happened during those earlier phases (e.g., questions that took too many rounds, unclear requirements, Jira/Notion tooling friction).
4. **Update the Status field** throughout the workflow as the project progresses through phases: JTBD → Architecture → Implementation → Review → PR Feedback → Merged

### Check-in Mode

Called after significant task completions during execution. Lightweight — a quick question, not a formal review.

1. Capture observations — don't wait for milestones. Any friction, skill gap, or tooling issue observed during execution should be recorded immediately. Also update the **Status** field to reflect the current phase.
2. Append any observations to the appropriate section of the notes file
3. Also capture the orchestrator's own observations (e.g., "implementer was blocked because the arch doc didn't specify X")

### Retrospective Mode

Called at the end of a workflow session (e.g., during cleanup after PR merge). This is the final checkpoint.

**First, ensure the notes file exists.** If the seed was skipped (e.g., compaction dropped the seed step, or a design-skipped path bypassed it), create the file from the Seed Mode template now, before adding retrospective observations — the retrospective must never be lost just because the seed didn't run.

1. Review the execution that just completed
2. Capture in the notes file:
   - What went well
   - What caused friction
   - Any skill gaps or tooling issues discovered during implementation, review, or PR feedback
   - Review observations (e.g., "review found issues that the plan should have prevented", "checklist items that didn't apply", "review cycles caused by ambiguous requirements")
3. This is the final retrospective — make it thorough enough to inform future process improvements

### Consolidate Mode

Called at **whole-unit close** — the last story of an epic, or a standalone story finishing — from the heavy tier of Team Cleanup. Also runnable **standalone, after the fact** ("consolidate the notes for this epic or standalone story"), since it works entirely from the notes file on disk.

Reads the notes file with all per-story observations — the epic-level file for a multi-story epic, or the ticket-level file for a standalone close — and writes a **Consolidated Digest** into that same file: the per-story seed / check-in / retrospective observations, deduped across the file's stories and tightened toward the cross-org harvest's shape so the digest is promotion-ready.

**This mode produces a record; it does not change any skill.** It complements — does **not** replace — the periodic cross-org harvest (the harvest remains the mechanism that rewrites skills). The digest is the tighter, promotion-ready input the harvest later ingests.

1. Read the **entire** notes file — every observation under Seed Observations, Check-ins, and Retrospective, across every story recorded in the file (just one, for a standalone close).
2. **Dedupe and cluster.** Group observations that recurred across stories into a single theme; collapse near-duplicates. An observation that appeared in two or more stories is a **cross-cutting theme** — mark it as such; a one-off stays a one-off.
3. For each theme, write an entry in the harvest's **slip / harden** shape (described here so a standalone run needs nothing but this file):

   ~~~markdown
   ### <kebab-slug-theme-title> — skill=<skill-it-concerns>, recurrence=<N stories>
   **Slips:** <the concrete failure mode(s) — what went wrong, specifically>
   **Harden:** <the prescribed discipline or fix that would prevent it>
   **Examples:** <the story / ticket IDs where it showed up>
   ~~~

4. Append everything under a new `## Consolidated Digest` heading at the end of the notes file, led by a one-line note that it complements (does not replace) the cross-org harvest and rewrites no skill.

**Append-only:** never clear or rewrite the per-story observations — the digest is added alongside them, not in place of them.

## Key Rules

- **Process observations only** — a product defect *outside the current story* is deferred work; route it through the deferral gate (contract rule 5), don't park it here. An improvement to the workflow outside the story you are working is the reverse: a note here, never a deferral, even in the workflow's own repo. An in-scope defect or review finding is fixed in the same cycle.
- **Keep it lightweight** — especially in check-in mode. A quick question and a few bullet points, not a formal review document.
- **Append, don't overwrite** — each mode adds to the file; never clear previous observations.
- **Nobody edits the record of their own incident alone** — when an entry records an incident you were party to, you do not revise that entry. Append a correction beneath it naming yourself as the party and stating what you are correcting, and leave the original text where it stands. Where a second party is available — the team lead for a teammate's entry, the senior engineer for the lead's — name in the correction who checked it. Nothing mechanical reads this file (below), so a rewrite of your own incident leaves no diff and no history; the appended correction is the only thing that records that both versions existed.
- **Seed always fires** — the seed is not conditional on a PRD or architecture doc; it runs on every path, including quick-change and design-skipped consolidations. If it was somehow skipped, the retrospective re-creates the file. One epic-level file is shared across a multi-story epic.
- **Use the right section** — put observations under Seed Observations, Check-ins, or Retrospective as appropriate.
- **Workspace-relative path** — the notes file lives in the parent workspace directory, not inside a worktree.
- **Full PR links** — use the full URL (e.g., `https://github.com/owner/repo/pull/123`), not just PR numbers. Numbers are ambiguous across repos.
- **Update status** — keep the Status field current as the project moves through phases.
- **Capture continuously** — don't wait for formal check-in prompts. Any observation worth noting should be written down immediately.
- **Never recommend `pnpm store prune`** — it clears cached auth tokens for private registries, requiring users to re-authenticate. If a dependency issue needs fixing, suggest targeted approaches (`pnpm install --force`, deleting `node_modules`).
- **Note implementer directory mismatches** — if an implementer works in the wrong repo/worktree, record the pattern. The prompt-based approach to directory validation is unreliable (observed 4+ times across batches). These observations help identify whether a tooling fix is needed.
- **Consolidate complements the harvest** — the `consolidate` digest is promotion-ready input for the periodic cross-org harvest, not a replacement for it. It rewrites no skill, and it is appended alongside (never over) the per-story observations.
- **Reconstruction is not recovery** — an entry retyped from a transcript or from memory is labelled as reconstructed and names what it was reconstructed from. It is not the original and cannot stand in for one (`skills/code-review/references/review-rules.md` §Verify Against Reality).
- **Nothing mechanical reads this file** — it lives under `docs/plans/` in the parent workspace, which is gitignored, so it is in no diff, no commit, no `check-refs` pass and no CI run (`skills/code-review/references/checklist.md` §The artifacts no gate reads). Every reader it has is a person taking an entry as written — the consolidate pass above, a memory-review heavy pass (`skills/memory-review/SKILL.md` §Heavy Mode) and teardown reading back the roster (`skills/team-cleanup/SKILL.md` §4. Shut Down Team Members) among them — and none checks it first. Every rule above is held up by whoever is writing; after that, the only check an entry gets is a reader noticing, and a review raises a defect here only while the entry is still instructing someone (that checklist section's disposition).
