---
name: Systematic Debugging
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes. Investigates root cause, decides whether a code change is needed, writes a bug summary doc, and hands off to Team Dispatch for implementation, review, PR lifecycle, and cleanup.
---

# Systematic Debugging

## Checklist (mandatory, in order)

1. **Enter the dashboard session — mandatory first action, before anything else:**

   Invoke `workflow:board` for the protocol (session enter, items, reconcile).
   ```bash
   dashboard session enter --phase debugging --title "<short description of the bug>"
   ```
   Full protocol: `skills/board/references/dashboard-protocol.md` (read it now if not already loaded). **Dashboard question protocol** (required when the board is present — run it regardless; `dashboard-protocol.md` §1's CLI availability note covers which verbs report instead of silently no-opping): post to the board first, then mirror to the terminal (with no board, ask in the terminal alone) — same protocol §2.

2. **Work through the investigation, in order** — full technique detail: `references/systematic-debugging-reference.md` §Root Cause Investigation Technique:
   1. Read Error Messages Carefully
   2. Reproduce Consistently
   3. Check Recent Changes
   4. Gather Evidence in Multi-Component Systems
   5. Trace Data Flow
   6. Find Working Examples
   7. Form a Hypothesis — **the gate:** if you cannot name a specific root cause backed by evidence, you have not finished this step. Do NOT proceed to the Decision Point with "it's probably X" — keep investigating.

3. **Decision Point: chain or exit.** Once root cause is identified, decide whether a code change is required.
   - **No code change required** (configuration, environment, operator error, already-fixed upstream, expected behavior, or duplicate of another ticket): do NOT write a bug summary doc or invoke Team Dispatch. Instead: document findings inline in the conversation (root cause, why no fix is needed, what the user should do if anything); if a Jira ticket exists, post one closing comment of one or two sentences giving the reason — naming the ticket or PR that already fixed it, where there is one — with no evidence or investigation (`skills/workflow-guide/references/routing.md` §Cross-Phase Rule: Jira Is the Ticket, Not the Working Record), and leave the ticket status for the user to close; exit.
   - **Code change required:** continue to the next checklist steps, then hand off to Team Dispatch. **Do NOT attempt the fix directly in this skill.** The fix happens inside Team Dispatch, which provides the implementation plan, senior review, draft PR, monitoring, and cleanup. Bypassing Team Dispatch bypasses all of those guarantees.

4. **Governing-doc check** (before creating the ticket): if this bug was found while working a ticket governed by a PRD, architecture doc, or another bug summary, read that doc's **Out of Scope** and **Risks** sections first. State in the bug summary whether the fix touches anything the governing doc marked frozen. If it does, the output is NOT a ticket — it is a one-sentence request to the user to reopen the governing PRD.

5. **Tool intent check** (do not run `check-mcp`): Run `check-tools --require jira`. Parse the JSON on stdout.
   - `check-tools` only inspects environment/configuration intent — it does not probe MCP server availability.
   - `jira` is `configured` → attempt the Jira MCP tools directly. If a configured call fails, STOP and tell the user Jira is configured/intended but is not working. Do NOT fall back.
   - `jira` is `unconfigured` → continue with no ticket (`skills/workflow-guide/references/routing.md` §Cross-Phase Rule: No Jira, No Ticket).
   - `jira` is `failed` → STOP. Print the `reason`.

6. **When Jira is configured, ensure a Jira Bug ticket exists.** If the user referenced an existing ticket, use it. Otherwise create one following JTBD's pattern: check available issue types via `getJiraProjectIssueTypesMetadata`, prefer `Bug`, fall back to `Task` if unavailable. Use `contentFormat: "markdown"` — Summary = concise title, description = brief problem statement (the bug summary doc link is added after review). Assign to the current user: resolve via `atlassianUserInfo` (`account_id`), pass `assignee_account_id`. Never hardcode an account ID. With no ticket, skip this step.

7. **Re-enter this ticket's node** with the real summary and add the ticket link:
   ```bash
   TICKET_NODE_KEY="$(dashboard session key --ticket "<TICKET-ID>")" || exit 1
   TICKET_NODE=(--root); [ -n "$TICKET_NODE_KEY" ] && TICKET_NODE=(--key "$TICKET_NODE_KEY")
   dashboard session enter --phase debugging --title "<summary>" --retitle ${TICKET_NODE_KEY:+--key "$TICKET_NODE_KEY"}
   dashboard link add --kind ticket --label "<TICKET-ID>" --url "<jira-url>" "${TICKET_NODE[@]}"
   ```
   This re-enters the node the lookup names — its own node when this ticket has one (work run as a story under an epic root), otherwise the root — updating its title to the real summary. `--retitle` is what authorises the rename — without it the CLI refuses to rename a node it already entered. With no ticket, skip the `link add`; the lookup above still resolves the node.

8. **Write the bug summary doc** to `docs/plans/YYYY-MM-DD-<topic>-1-bug.md` (the `1-bug` prefix sorts cleanly alongside `1-prd` / `2-arch` / `3-impl`). Template: `references/systematic-debugging-reference.md` §Bug Summary Doc Template.

9. **Host in Notion, then notify** — full protocol: `skills/workflow-guide/references/notification-protocol.md` (Bug Summary row: `--kind architecture`, `--label "Bug Summary"`, suffix `1-bug.md`).

10. **After the user validates the doc, when there is a ticket, update the Jira ticket:** add a `[Bug Summary](<notion-url>)` link at the top of the description (`editJiraIssue`, `contentFormat: "markdown"`). If no Notion page was created, add nothing — the doc stays local.

11. **Wait for approval.** Do NOT invoke Team Dispatch until the user has validated the bug summary doc. Be ready to revise — re-save and re-sync after changes, exactly as PRDs and architecture docs do. **Precondition (`skills/board/references/dashboard-protocol.md` §3.1):** this is an advancement approval. If an open question could change the bug summary, hold the approval — wait for the answer, then post as your next action once that question resolves. That obligation is yours, not the CLI's: the guard refuses the post when it can confirm the open question, but it fails open whenever it cannot get a trustworthy count — including when the board reads fine but reports no per-type breakdown — so a post that succeeds does not mean nothing was open (§3.1). With a board, **flush the deferred queue first** (`skills/board/references/dashboard-protocol.md`'s three-verb protocol): `dashboard item list-deferred`, drop what the work itself already answered (`dashboard item drop-deferred --id "<id>" --reason "<what answered it>"`), then `dashboard item flush-deferred` (no `--context` — this workflow produces no PR to point at) if anything remains — it posts every queued question as its own item; wait for all of them to be answered and consumed, then confirm `list-deferred` reports `[]` (a flush that failed part-way leaves the rest queued and says so — flush again) — a queued entry refuses this approval outright (`approvalIsAllowed`, §3.1). Once no such question is open and the queue is empty, post the dashboard approval item before waiting: write `<rich markdown: bug summary one-liner + doc link + "approve to proceed to Team Dispatch">` to `<tmpfile>` (temp file, never a shell string — why: `skills/board/references/dashboard-protocol.md` §2) — that prompt is the one-liner, the link, and the ask, nothing else: a sentence naming whose call the fix approval is, or explaining what a validated bug summary implies, is the padding `skills/board/references/escalation-contract.md` §Required question form forbids — then `dashboard item add --type approval --prompt "$(cat "<tmpfile>")"` → capture `<id>`, then `rm -f "<tmpfile>"`. Reconcile per `skills/board/references/dashboard-protocol.md` §3–4.

12. **Handoff to Team Dispatch, in the same turn as approval — do not stop or summarize.** Invoke the **Team Dispatch** skill (`workflow:team-dispatch`), passing the Jira ticket ID, or the branch name when there is no ticket, and the bug summary doc filename (Team Dispatch accepts either a `-2-arch.md` or a `-1-bug.md` file as its design input). Team Dispatch runs its normal chain: implementation plan, worktree, team, execution, senior review, draft PR, PR monitor, process improvement notes, team cleanup. The bug summary doc's "Proposed Fix" section is what the implementation plan expands into exact file paths, code, and tests.

13. **3-failure STOP rule:** if Team Dispatch's implementation loop reveals that 3+ fix attempts have failed, STOP and question the bug summary doc itself — the proposed fix may be wrong, or the root cause may have been misidentified. Pattern indicating a wrong bug summary: each fix reveals new shared state/coupling/problems elsewhere, fixes require "massive refactoring," each fix creates new symptoms. STOP and ask: was the root cause right? Is the proposed fix fundamentally sound? Are we "sticking with it through sheer inertia"? **Discuss with the user before attempting more fixes.** Return to step 2 with new evidence, rewrite the bug summary doc, and re-enter the flow. This is NOT a failed hypothesis — this is a wrong understanding.

Long-form guidance, red flags, rationalizations, and templates: read `references/systematic-debugging-reference.md` — mandatory before your first run of this skill in a session.
