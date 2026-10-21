---
name: jtbd
description: Use when starting substantial new work — a feature or anything with real design space — to understand what problem needs solving before jumping to solutions. Gathers context, asks Socratic questions, outputs a PRD, and creates a Jira epic or ticket. Triggers on new features and "what should we build" conversations. For small, well-understood changes that aren't bugs, use Quick Change (`workflow:quick-change`) instead.
---

# Jobs to be Done

## Checklist (mandatory, in order)

1. **Enter the dashboard session — mandatory first action, before anything else:**

   Invoke `workflow:board` for the protocol (session enter, items, reconcile).
   ```bash
   dashboard session enter --phase prd --title "<short description of the request>"
   ```
   Full protocol: `skills/board/references/dashboard-protocol.md` (read it now if not already loaded).

2. **Tool intent check** (do not run `check-mcp`): Run `check-tools --require jira,notion`. Parse the JSON on stdout.
   - `check-tools` only inspects environment/configuration intent — it does not probe MCP server availability.
   - `configured` → attempt the tool path directly. If a configured tool attempt fails, STOP and tell the user that tool is configured/intended but is not working. Do NOT fall back.
   - `unconfigured` → use the documented non-integration fallback for that tool.
   - `failed` → STOP and print the reason.
   - **Jira gate:** if Jira is `unconfigured`, continue with no ticket (`skills/workflow-guide/references/routing.md` §Cross-Phase Rule: No Jira, No Ticket).

3. **When Jira is configured, determine ticket type and create the Jira ticket** before writing the PRD — this gives the ticket ID to embed in the PRD from the start:
   - Ticket type: Epic (multiple stories) / Story (feature, enhancement, or agent-implementable work) / Bug (broken behavior) / Task (manual human work). Recommend one and explain why; the user can override.
   - Create using `contentFormat: "markdown"`. Check available issue types via `getJiraProjectIssueTypesMetadata` first — if the desired type isn't available, fall back to Task.
   - Summary: concise title. Description: brief problem statement (the PRD link is added in a later step, if the PRD is hosted).
   - Jira project: check the conversation or CLAUDE.md for the project key; ask the user if not found. Labels: check what already exists in the Jira project and apply appropriate ones — don't invent new labels without asking.
   - **Assignee:** assign to the current user — resolve via `atlassianUserInfo` (`account_id`) and pass `assignee_account_id` to `createJiraIssue`. Never hardcode an account ID.
   - With no ticket, the PRD carries no ticket id and the work's key is the branch name.

4. **Re-enter this ticket's node** with the real ticket summary and add the ticket link:
   ```bash
   TICKET_NODE_KEY="$(dashboard session key --ticket "<TICKET-ID>")" || exit 1
   TICKET_NODE=(--root); [ -n "$TICKET_NODE_KEY" ] && TICKET_NODE=(--key "$TICKET_NODE_KEY")
   dashboard session enter --phase prd --title "<ticket summary>" --retitle ${TICKET_NODE_KEY:+--key "$TICKET_NODE_KEY"}
   dashboard link add --kind ticket --label "<TICKET-ID>" --url "<jira-url>" "${TICKET_NODE[@]}"
   ```
   This re-enters the node the lookup names — its own node when this ticket has one (work run as a story under an epic root), otherwise the root — updating its title to the real summary. `--retitle` is what authorises the rename — without it the CLI refuses to rename a node it already entered. The ticket is attached as a `kind:ticket` link — do **not** pass `--ticket`. Use the ticket's canonical browse URL (the `webUrl` field on the create/get response) — do not hardcode a Jira host. With no ticket, skip the `link add`; the lookup above still resolves the node.

5. **Write the PRD** to `docs/plans/YYYY-MM-DD-<topic>-1-prd.md`. Write the North Star first and confirm its wording with the user before passing the gate. Template and writing rules: `references/jtbd-reference.md` §Write the PRD.

6. **Host in Notion, then notify** — full protocol: `skills/workflow-guide/references/notification-protocol.md` (PRD row: `--kind prd`, `--label PRD`, suffix `1-prd.md`). This is the one doc type where every JTBD run is a new unit of work, so it starts a fresh dashboard root.

7. **Precondition (`skills/board/references/dashboard-protocol.md` §3.1):** this is an advancement approval. If an open question could change the PRD, hold the approval — wait for the answer, then post as your next action once that question resolves. That obligation is yours, not the CLI's: the guard refuses the post when it can confirm the open question, but it fails open whenever it cannot get a trustworthy count — including when the board reads fine but reports no per-type breakdown — so a post that succeeds does not mean nothing was open (§3.1). With a board, **flush the deferred queue first** (`skills/board/references/dashboard-protocol.md`'s three-verb protocol): `dashboard item list-deferred`, drop what the work itself already answered (`dashboard item drop-deferred --id "<id>" --reason "<what answered it>"`), then `dashboard item flush-deferred` (no `--context` — this workflow produces no PR to point at) if anything remains — it posts every queued question as its own item; wait for all of them to be answered and consumed, then confirm `list-deferred` reports `[]` (a flush that failed part-way leaves the rest queued and says so — flush again) — a queued entry refuses this approval outright (`approvalIsAllowed`, §3.1). **Once no such question is open and the queue is empty, post the dashboard approval item** before waiting for PRD feedback: write `<rich markdown: PRD one-liner + Notion link + "approve to proceed to Architecture">` to `<tmpfile>` (temp file, never a shell string — why: `skills/board/references/dashboard-protocol.md` §2) — that prompt is the one-liner, the link, and the ask, nothing else: a sentence naming whose call the PRD approval is, or explaining what a validated PRD implies, is the padding `skills/board/references/escalation-contract.md` §Required question form forbids — then `dashboard item add --type approval --prompt "$(cat "<tmpfile>")"` → capture `<id>`, then `rm -f "<tmpfile>"`. Reconcile per `skills/board/references/dashboard-protocol.md` §3–4.

8. **After the user validates the PRD, when there is a ticket, update the Jira ticket description to reference it:**
   - If a Notion page was created: add a `[PRD](<notion-url>)` markdown link at the top of the existing Jira description (`editJiraIssue`, `contentFormat: "markdown"`). Use the document type as the link label (e.g., "PRD"), not the hosting platform. Do NOT use bare URLs. Do NOT replace the description with the full PRD content — the Notion page is the source of truth.
   - If no Notion page: add nothing — the PRD stays local in `docs/plans/`.

9. **Invoke the Architecture skill** (`workflow:architecture`) for technical design, in the same turn — do not stop, summarize, and wait for permission. The Architecture skill self-abbreviates if the architecture is trivial.

Long-form guidance, templates, and rationale: read `references/jtbd-reference.md` — mandatory before your first run of this skill in a session.
