---
name: Quick Change
description: Use for small, well-understood changes that are not bug fixes — tweaks, small enhancements, refactors, copy or config edits that follow an existing pattern. Writes a single combined change-summary doc, gets it approved, and hands off to Team Dispatch. The lightweight sibling of JTBD then Architecture for work that does not need full problem and design exploration. Triggers on "small change", "quick change", "tweak", "minor enhancement".
---

# Quick Change

## Overview

Most work isn't a big new feature or a bug — it's a small, well-understood change. Quick Change is the lightweight path for that: one combined doc instead of separate PRD + architecture, the same ticket → approve → Team Dispatch flow, no skipped guarantees.

This is the non-bug sibling of Systematic Debugging. Where that skill produces a bug summary doc, Quick Change produces a **change summary** doc. Both collapse problem + approach into one artifact and hand off to Team Dispatch.

**Announce at start:** "I'm using the Quick Change skill — I'll write a short change summary for review, then hand off to Team Dispatch."

## When to Use

Use Quick Change when ALL of these hold:

- The change is small and well-understood — you can describe the approach in a paragraph.
- It follows existing patterns (no novel design space to explore).
- It's scoped to one logical unit of work (roughly one story / one PR).
- It is NOT a bug fix (those go to Systematic Debugging).

Examples: adjust a skill's wording, add a config flag that mirrors an existing one, rename a thing across a few files, add a small helper following an established pattern, tweak copy.

## When NOT to Use — Escalate Instead

Stop and escalate the moment any of these appear:

- **Real design decisions** — more than one reasonable approach with meaningful trade-offs → run JTBD (`workflow:jtbd`), which chains into Architecture (`workflow:architecture`).
- **Multiple stories, multi-repo runtime coupling, or new infrastructure** → JTBD → Architecture.
- **Unknowns that need validation** before you can commit to an approach → JTBD → Architecture.
- **It's broken** (bug, test failure, unexpected behavior) → Systematic Debugging (`workflow:systematic-debugging`).

It's fine to start in Quick Change and bail upward the moment scoping reveals real complexity. Better to escalate than to force big work through a small door.

## The Process

### 1. Gather Context

**Enter the dashboard session — mandatory first action, before anything else.**

Invoke `workflow:board` for the protocol (session enter, items, reconcile).
```bash
dashboard session enter --phase change --title "<short description of the change>"
```
This is the mandatory first action — full protocol: `skills/board/references/dashboard-protocol.md` (read it now if not already loaded).

Understand what's being asked and the code it touches before writing anything:

- Read the relevant files, skills, or config (delegate to the `researcher` agent if it spans more than a few files).
- Confirm it follows an existing pattern — find the prior art you'll mirror.
- If this step reveals the change is bigger than it looked, escalate (see "When NOT to Use").

**Dashboard question protocol (required when the board is present — run it regardless; `dashboard-protocol.md` §1's CLI availability note covers which verbs report instead of silently no-opping):** post to the board first, then mirror to the terminal (with no board, ask in the terminal alone) — full protocol: `skills/board/references/dashboard-protocol.md` §2.

### 2. Ensure a Jira ticket exists

**Tool intent check (do not run `check-mcp`):** Run `check-tools --require jira,notion`. Parse the JSON on stdout.

- `check-tools` only inspects environment/configuration intent. It does not probe MCP server availability.
- `configured` means the user intended that tool to be used. Attempt the listed tool path directly.
- If a configured tool attempt fails, STOP and tell the user that tool is configured/intended but is not working. Do NOT fall back.
- `unconfigured` means the user did not intend that tool to be used. Use the documented non-integration fallback for that tool.
- `failed` means the environment configuration is partial or invalid. STOP and print the reason.

**Jira gate:** If Jira is `unconfigured`, continue with no ticket (`skills/workflow-guide/references/routing.md` §Cross-Phase Rule: No Jira, No Ticket): the check above runs and stops as written, and only the ticket bullets below and the `link add` in the dashboard block are skipped.

- If the user referenced an existing ticket, use it.
- Otherwise create one: check available issue types via `getJiraProjectIssueTypesMetadata`, prefer `Story` (or `Task` for non-feature chores), fall back to `Task` if the preferred type isn't available. Use `contentFormat: "markdown"`. Summary = concise title; description = brief problem statement (the doc link is added after review).
- Assign the ticket to the current user: resolve via `atlassianUserInfo` (`account_id`) and pass `assignee_account_id` to `createJiraIssue`. Never hardcode an account ID.
- Jira project: check the conversation or CLAUDE.md for the project key; if not found, ask the user.

**Dashboard (required when the board is present; silently no-ops only if the `dashboard` CLI is absent):** Once the ticket is created, re-enter this ticket's node with the real summary and add the ticket link:
```bash
TICKET_NODE_KEY="$(dashboard session key --ticket "<TICKET-ID>")" || exit 1
TICKET_NODE=(--root); [ -n "$TICKET_NODE_KEY" ] && TICKET_NODE=(--key "$TICKET_NODE_KEY")
dashboard session enter --phase change --title "<summary>" --retitle ${TICKET_NODE_KEY:+--key "$TICKET_NODE_KEY"}
dashboard link add --kind ticket --label "<TICKET-ID>" --url "<jira-url>" "${TICKET_NODE[@]}"
```
This re-enters the node the lookup names — its own node when this ticket has one (work run as a story under an epic root), otherwise the root — updating its title to the real summary. `--retitle` is what authorises the rename — without it the CLI refuses to rename a node it already entered.

### 3. Write the Change Summary Doc

File path: `docs/plans/YYYY-MM-DD-<topic>-1-change.md`

The `1-change` prefix sorts cleanly alongside `1-prd` / `1-bug` / `2-arch` / `3-impl`.

With no ticket, omit the **Jira:** line.

Template:

~~~markdown
# [Title] — Change Summary

**Jira:** [TICKET-ID]

## Problem Statement
What needs to change and why. 1-3 sentences.

## Proposed Approach
The change at a high level — what gets added or modified, and the pattern it
follows. Interfaces and contracts, not function bodies. Name the prior art it mirrors.

## Scope
Bullet list of what the change touches.

## Out of Scope
Bullet list of what we're explicitly NOT doing.

## User Impact
Who's affected and how. 1-2 sentences.

## Risks / Open Questions
Known unknowns, regression risks, things to validate during implementation.
If there are none, say so.
~~~

**Diagrams.** None is required. When one helps, put it under the section it explains, written per
`skills/workflow-guide/references/diagrams.md`.

**No section restates another.** The overlap to watch is `Scope` against `Proposed Approach`:
Scope names what the change touches, the approach section says what it does. If one
has become a reworded copy of the other, delete the weaker rather than trimming both. Length is the
defect and repetition is its worst form.

**Brevity never costs the reader the specification.** Cut preamble, restatement and hedging. Do
**not** cut data structures, schemas, API contracts, reproduction steps, commands or error text to
make a document shorter — those are what the reader came for. A short document that omits the
contract is not concise, it is unusable.

**No people's names.** The change summary is about the change and why it is needed — no names,
usernames, or handles (`skills/workflow-guide/references/no-people-names.md`).

Skippable sections: any that don't apply (e.g., no risks). Keep it to one screen — if it's growing past that, the change may be too big for Quick Change; reconsider escalating.

Keep the doc in **problem + approach** terms, not file-level detail. Exact file paths, code, and tests belong in the Team Dispatch implementation plan.

### 4. Host and notify

Host in Notion, then notify — full protocol: `skills/workflow-guide/references/notification-protocol.md` (Change Summary row: `--kind prd`, `--label "Change Summary"`, suffix `1-change.md`).

After the user validates the doc, when there is a ticket, update the Jira ticket: add a `[Change Summary](<notion-url>)` link at the top of the description (using `editJiraIssue` with `contentFormat: "markdown"`). If no Notion page was created, add nothing — the doc stays local.

### 5. Wait for approval

Do NOT invoke Team Dispatch until the user has validated the change summary doc. Be ready to revise — re-save and re-sync after changes, exactly as PRDs, architecture docs, and bug summaries do.

**Precondition (`skills/board/references/dashboard-protocol.md` §3.1):** this is an advancement approval. If an open question could change the change summary, hold the approval — wait for the answer, then post as your next action once that question resolves. That obligation is yours, not the CLI's: the guard refuses the post when it can confirm the open question, but it fails open whenever it cannot get a trustworthy count — including when the board reads fine but reports no per-type breakdown — so a post that succeeds does not mean nothing was open (§3.1).

**Dashboard (required when the board is present — run it regardless; `dashboard-protocol.md` §1's CLI availability note covers which verbs report instead of silently no-opping):** **Flush the deferred queue first** (`skills/board/references/dashboard-protocol.md`'s three-verb protocol): `dashboard item list-deferred`, drop what the work itself already answered (`dashboard item drop-deferred --id "<id>" --reason "<what answered it>"`), then `dashboard item flush-deferred` (no `--context` — this workflow produces no PR to point at) if anything remains — it posts every queued question as its own item; wait for all of them to be answered and consumed, then confirm `list-deferred` reports `[]` (a flush that failed part-way leaves the rest queued and says so — flush again) — a queued entry refuses this approval outright (`approvalIsAllowed`, §3.1). Once no such question is open and the queue is empty, post the dashboard approval item before waiting: write `<rich markdown: change summary one-liner + doc link + "approve to proceed to Team Dispatch">` to `<tmpfile>` (temp file, never a shell string — why: `skills/board/references/dashboard-protocol.md` §2) — that prompt is the one-liner, the link, and the ask, nothing else: a sentence naming whose call the change approval is, or explaining what a validated summary implies, is the padding `skills/board/references/escalation-contract.md` §Required question form forbids — then `dashboard item add --type approval --prompt "$(cat "<tmpfile>")"` → capture `<id>`, then `rm -f "<tmpfile>"`. Reconcile per `skills/board/references/dashboard-protocol.md` §3–4.

## Handoff to Team Dispatch

Once the change summary doc is approved:

1. Invoke the **Team Dispatch** skill (`workflow:team-dispatch`). Pass it the Jira ticket ID (or, with no ticket, the branch name) and the change summary doc filename. Team Dispatch accepts a `-1-change.md` file as its design input, the same way it accepts `-2-arch.md` or `-1-bug.md`.
2. Team Dispatch runs its normal chain: implementation plan, worktree, team, execution, senior review, draft PR, PR monitor, process improvement notes, team cleanup.
3. The change summary's "Proposed Approach" section is what Team Dispatch's implementation plan expands into exact file paths, code, and tests.

**Do not stop or summarize after writing the change summary doc.** Once the user approves, invoke Team Dispatch in the same turn. The user's approval of the doc IS the signal to proceed.

## Key Principles

- **One combined doc** — Problem and approach together, never separate PRD + architecture.
- **Lightweight, not skipped** — Quick Change is fast, but it still produces a ticket, an approved doc, senior review, and a PR. "Small" is never a reason to edit files directly.
- **Escalate when it grows** — The moment real design space, multi-repo coupling, or unknowns appear, bail up to JTBD → Architecture.
- **Reuse, don't duplicate** — Delivery and approval reuse the JTBD flow by reference; implementation reuses Team Dispatch. This skill only adds the combined-doc shape and the routing.
