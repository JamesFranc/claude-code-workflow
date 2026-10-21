---
name: architecture
description: Use after JTBD/PRD is complete — designs the technical solution at a high level. Identifies repos, data structures, API contracts, diagrams, and breaks work into story tickets. Triggers after a PRD is validated or when the user wants to design how something should be built.
---

# Architecture

## Checklist (mandatory, in order)

1. **Re-enter the dashboard root session with the new phase — mandatory first action:**

   Invoke `workflow:board` for the protocol (session enter, items, reconcile).
   ```bash
   dashboard session enter --phase architecture
   ```
   No `--key` — this re-enters the same root node JTBD entered, just updating the phase. Full protocol: `skills/board/references/dashboard-protocol.md`.

2. **Tool intent check** (do not run `check-mcp`): Run `check-tools --require jira,notion`. Parse the JSON on stdout.
   - `check-tools` only inspects environment/configuration intent — it does not probe MCP server availability.
   - `configured` → attempt the tool path directly. If a configured tool attempt fails, STOP and tell the user that tool is configured/intended but is not working. Do NOT fall back.
   - `unconfigured` → use the documented non-integration fallback for that tool.
   - `failed` → STOP and print the reason.
   - **Jira gate:** if Jira is `unconfigured`, continue with no tickets: the architecture doc's story list is the plan (`skills/workflow-guide/references/routing.md` §Cross-Phase Rule: No Jira, No Ticket).

3. **Write the architecture doc** using placeholder story names (e.g., "Story 1: ...") — do NOT create story tickets before the user has reviewed and approved the doc. File: `docs/plans/YYYY-MM-DD-<topic>-2-arch.md`. Template: `references/architecture-reference.md` §Architecture Doc Template. Then write and render its walkthrough video: `references/walkthrough.md`.

4. **Host in Notion, then notify** — full protocol: `skills/workflow-guide/references/notification-protocol.md` (Architecture row: `--kind architecture`, `--label Architecture`, suffix `2-arch.md`). Once the architecture page exists, host the walkthrough script as its child page: `references/walkthrough.md` §Host the script.

5. **Precondition (`skills/board/references/dashboard-protocol.md` §3.1):** this is an advancement approval. If an open question could change the architecture doc, hold the approval — wait for the answer, then post as your next action once that question resolves. That obligation is yours, not the CLI's: the guard refuses the post when it can confirm the open question, but it fails open whenever it cannot get a trustworthy count — including when the board reads fine but reports no per-type breakdown — so a post that succeeds does not mean nothing was open (§3.1). With a board, **flush the deferred queue first** (`skills/board/references/dashboard-protocol.md`'s three-verb protocol): `dashboard item list-deferred`, drop what the work itself already answered (`dashboard item drop-deferred --id "<id>" --reason "<what answered it>"`), then `dashboard item flush-deferred` (no `--context` — this workflow produces no PR to point at) if anything remains — it posts every queued question as its own item; wait for all of them to be answered and consumed, then confirm `list-deferred` reports `[]` (a flush that failed part-way leaves the rest queued and says so — flush again) — a queued entry refuses this approval outright (`approvalIsAllowed`, §3.1). **Once no such question is open and the queue is empty, post the dashboard approval item** before waiting: write `<rich markdown: architecture doc one-liner + Notion link + "approve to proceed to Team Dispatch">` to `<tmpfile>` (temp file, never a shell string — why: `skills/board/references/dashboard-protocol.md` §2) — that prompt is the one-liner, the link, and the ask, nothing else: a sentence naming whose call the design approval is, or explaining what a validated architecture implies, is the padding `skills/board/references/escalation-contract.md` §Required question form forbids — then `dashboard item add --type approval --prompt "$(cat "<tmpfile>")"` → capture `<id>`, then `rm -f "<tmpfile>"`. Reconcile per `skills/board/references/dashboard-protocol.md` §3–4.

6. **After user approval — single-story/task vs. epic branch:**
   - **If JTBD created a single story/task:** do NOT create sub-stories or add task lists to the ticket description — the syncing-plans-to-jira skill (`workflow:syncing-plans-to-jira`) adds the task list during Team Dispatch.
   - **If JTBD created an epic, when Jira is configured:** create Story-type tickets for each story in the architecture doc — Summary: story title; Description: the hosted design-doc link line first, only when the docs are hosted (`[PRD](<url>) | [Architecture](<url>)`), then what the story delivers and its acceptance criteria (from PRD success criteria) — no architecture discussion, and no task lists, which come later; Parent: the epic — confirm the epic's `statusCategory` is not `done` before creating anything under it (*Cross-Phase Rule: Never Parent a Ticket to a Done Epic* in `skills/workflow-guide/references/routing.md`); sequencing as blocked-by links; same project/labels as the epic. Assign each to the current user (`atlassianUserInfo` → `assignee_account_id`; never hardcode). Check available issue types via `getJiraProjectIssueTypesMetadata` first — fall back to Task if Story isn't available. Make Jira MCP calls sequentially — one `createJiraIssue` at a time, never batched. **Assess complexity:** if stories are individually complex, recommend running JTBD at the story level first instead of going straight to Team Dispatch.
   - **With no Jira:** no story tickets are created; each story is named by its title and later its branch.

7. **Update the epic or parent ticket, when there is one:** if a Notion page was created, add an `[Architecture](<notion-url>)` markdown link to the first line of the Jira description (`editJiraIssue`, `contentFormat: "markdown"`) — append with a pipe separator if a PRD link already exists there (`[PRD](<url>) | [Architecture](<url>)`). Use the document type as the link label, not the hosting platform. Do NOT use bare URLs. Do NOT link to local files. With no Notion page, add nothing — the doc stays local (`skills/workflow-guide/references/routing.md` §Cross-Phase Rule: Jira Is the Ticket, Not the Working Record).

8. **Then proceed to Team Dispatch immediately, in the same turn — this is the highest-value line in this skill, keep it forceful** (unless step 6 chose story-level JTBD — then pause this handoff). Do not stop. Do not summarize and wait. Do not ask "Ready to proceed?" or "Shall I start implementation?" The user's approval of the architecture IS the signal to proceed — invoke Team Dispatch (`workflow:team-dispatch`) now. **Common failure mode:** the skill completes, summarizes the architecture, and then stops waiting for the user to explicitly ask for implementation. This is WRONG. If multiple stories exist, execute them **serially**, starting with the first in the sequencing order defined in the architecture doc — or, when this run is re-validating a stale story Team Cleanup chose, with that story; at each story boundary Team Cleanup re-picks the next story by the epic's North Star, with that order as the tiebreaker (`skills/team-cleanup/SKILL.md` §7. Auto-Continue Epic (if applicable)) — each story gets its own implementation plan, worktree, team, and PR; complete one story through PR merge before starting the next. With no Jira, Team Cleanup does not re-pick: after each story it reports the architecture doc's remaining stories as not started or not confirmed delivered (`skills/team-cleanup/SKILL.md` §1), and the next is begun by hand.

Long-form guidance, templates, and rationale: read `references/architecture-reference.md` — mandatory before your first run of this skill in a session.
