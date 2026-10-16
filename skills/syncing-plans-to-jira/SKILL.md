---
name: syncing-plans-to-jira
description: Use after writing a plan when Jira integration is configured - syncs plan tasks to Jira as a checklist in the ticket description, handles epic detection, creates or finds appropriate tickets for the work
---

# Syncing Plans to Jira

## Overview

After writing an implementation plan, sync the tasks to Jira for tracking. Handles ticket detection, epic-to-story conversion, and adding tasks as a checklist in the ticket description.

**Core principle:** Plans live in Jira where the team can track them.

**Announce at start:** "I'm using the syncing-plans-to-jira skill to sync this plan to Jira."

## When to Use

Use this skill AFTER writing an implementation plan (e.g., in Team Dispatch step 7) when:
- Jira is configured/intended according to `check-tools --require jira`
- Work should be tracked in Jira

**Skip this skill when:**
- Jira is unconfigured according to `check-tools --require jira`
- Personal/experimental work not needing tracking
- User explicitly opts out

## Common Rationalizations (Don't Fall For These)

| Excuse | Reality |
|--------|---------|
| "Plan is done, Jira sync is optional" | Sync is part of plan completion. Untracked plans get lost. |
| "I'll sync to Jira later" | Later never comes. Do it now. |
| "User didn't ask for Jira sync" | If Jira is configured, sync by default — this skill creates the ticket if none exists yet. |
| "Checking Jira adds overhead" | 2 seconds to check tool intent. Hours saved in tracking. |
| "I'll just put tasks on the Epic" | Epics are containers. Create a proper Story/Task. |

**If Jira is configured, USE THIS SKILL — it creates the ticket if none exists yet.**

## Pre-Check: Jira Tool Intent

Run `check-tools --require jira`. Parse the JSON output.

- `check-tools` only inspects environment/configuration intent. It does not probe MCP server availability.
- `jira` is `configured` → proceed to Step 1 and attempt the Jira MCP tools directly.
- If a configured Jira MCP call fails, STOP and tell the user Jira is configured/intended but is not working. Do NOT fall back.
- `jira` is `unconfigured` → inform the user: "Jira MCP not configured. Skipping Jira sync." STOP.
- `jira` is `failed` → STOP. Print the `reason`.

**Note:** Don't call `check-mcp` or `bin/check-mcp`. Environment/configuration intent from `check-tools` is authoritative.

## The Process

### Step 1: Identify the Ticket

**Scan conversation for ticket patterns:**
- `DEV-1234`, `PROJ-567`, etc.
- Pattern: `[A-Z]+-[0-9]+`

**Decision tree:**

```
Ticket mentioned?
├── YES → Go to Step 2 (Validate Ticket)
└── NO → Create one for this plan and go to Step 2 — the approved design doc and its plan ARE
         the authorization, so never ask permission to create it. Title from the plan name,
         description from the plan goal. If you parent it to an epic, read that epic's
         `fields.status.statusCategory.key` FIRST and create nothing under a `done` one —
         the same check Step 3 runs, applied here because Step 3 is not on this path. If the
         lookup fails or comes back with no status, stop and post a board question rather than
         creating — an unverified parent is not a verified one (`routing.md`, Never Parent a
         Ticket to a Done Epic).
         The user can still opt out of the sync entirely (see "Skip this skill when" above) —
         that is their call about tracking, not a permission gate on the ticket.
```

### Step 2: Validate Ticket Type

**Fetch ticket details using Jira MCP:**

```
Is ticket an Epic?
├── YES → Go to Step 3 (Handle Epic)
└── NO → Go to Step 4 (Sync Tasks)
```

### Step 3: Handle Epic

**When the mentioned ticket is an Epic:**

1. **List child tickets** in the epic using Jira MCP
2. **Check for existing match:**
   - Look for tickets with similar title/description to the plan
   - Consider status, partitioning on `statusCategory` (prefer `new` / `indeterminate` over `done`), never on display names

```
Matching child ticket found?
├── YES → Confirm with user: "Found [TICKET-ID]: '[title]'. Use this?"
│         ├── YES → Use that ticket, go to Step 4
│         └── NO → Run the Done-epic check below, then create a new one — offer picking another
│                  ticket instead only as the adopt case, which is confirmed
└── NO → Run the Done-epic check below FIRST
         ├── Epic is Done → STOP: post a board question, create nothing
         └── Otherwise → Create new Story/Task under the Epic
                  - Title: derived from plan name
                  - Description: hosted design-doc link on the first line (only if one exists), then the plan goal
                  - Link to Epic
                  → Go to Step 4
```

**Done-epic check — before creating anything new under the epic**, read its `fields.status.statusCategory.key`. If it
is `done`, do **not** create the ticket — post a
`dashboard item add --type question --recommend "<one line>" --stalls "<what waits|none>" --why-mine "<taste|scope|risk|teammate-unsettled|fact>" --prompt "<rich markdown>"`
and wait, per
*Cross-Phase Rule: Never Parent a Ticket to a Done Epic* in
`skills/workflow-guide/references/routing.md`. Reusing an **existing** child of a Done epic is
unaffected: the prohibition is on adding new work to a closed container, not on matching work that
is already in it.

### Step 4: Sync Tasks to Jira

**Update the ticket description with a task checklist (preserving existing content):**

1. Fetch the current ticket description
2. Check if a `## Tasks` section already exists in the description:
   - **If it exists:** Replace ONLY the `## Tasks` section (from `## Tasks` to the next `##` heading or end of description) with the new task list. Preserve all other content above and below it.
   - **If it does not exist:** Append the `## Tasks` section to the end of the existing description.
3. Update the ticket using `editJiraIssue` with `contentFormat: "markdown"`

**IMPORTANT:** Make all Jira MCP calls sequentially — one at a time. Do not batch multiple `editJiraIssue` or `createJiraIssue` calls in parallel; the Jira MCP will reject parallel requests.

**IMPORTANT:** Never replace the entire ticket description — only add or update the `## Tasks` section. The rest of the description (problem statement, acceptance criteria, etc.) must be preserved.

**Checklist format (Markdown):**

```markdown
## Tasks

- [ ] Task 1.1: Import Project to Vercel
- [ ] Task 1.2: Add Environment Variables to Vercel
- [ ] Task 2.1: Enable Supabase Branching
...
```

### Step 5: Assign Ticket

After syncing tasks, assign the ticket to the current user:

1. Resolve the current user's account ID via `atlassianUserInfo` (`account_id`) — this is the authenticated Jira user. Never hardcode an account ID.
2. Assign the ticket using `editJiraIssue` with `fields.assignee.accountId`

**After sync complete:**
- Report: "Updated [TICKET-ID] with N tasks in description, assigned to [user]"
- Provide link to ticket in Jira

## Jira MCP Reference

Known gotchas when calling Jira MCP tools:

| Tool | Gotcha |
|------|--------|
| `editJiraIssue` | Parameters go inside a `fields` wrapper, not as top-level params |
| `addCommentToJiraIssue` | The comment text parameter is named `body`, not `comment` |
| All Jira MCP tools | Must be called sequentially — parallel calls will be rejected |
| `editJiraIssue` | Always include `contentFormat: "markdown"` when writing descriptions — omitting it defaults to ADF |
| `getJiraIssue` | Use `responseContentFormat: "markdown"` to read descriptions as markdown |

**Link formatting:** Use `[text](url)` markdown link syntax for clickable links. Bare URLs will NOT auto-link in Jira descriptions. Label links by document type (e.g., `[PRD](url)`, `[Architecture](url)`), not by platform.

**Checkbox formatting:** Use `- [ ]` / `- [x]` (with dash-space prefix). Bare `[ ]` without the dash gets escaped by the MCP and won't render as checkboxes.

## Error Handling

| Error | Action |
|-------|--------|
| Jira tool intent = unconfigured | Skip gracefully, inform user |
| Jira tool intent = failed | Skill already halted at the tool intent check — do not reach this row |
| Ticket not found | Ask user to verify ticket ID |
| Permission error | Report error, suggest checking Jira access |
| Epic has 50+ children | Warn user, create a new one; confirm only if adopting an existing child instead |

## Common Mistakes

**Putting tasks directly on an Epic:**
- Epics are containers, not work items
- Always create a Story/Task under the Epic — never put the task on the Epic itself
- If the epic is Done, create nothing at all — follow the **Done-epic check** in Step 3 (Handle Epic)

**Creating subtasks:**
- Don't create Jira subtasks - they add clutter
- Use a checklist in the description instead

**Creating duplicate tickets:**
- Check for existing matching tickets first

**Adopting instead of creating:**
- Adopting an existing ticket mutates a ticket that already exists — Step 4 rewrites its `## Tasks`
  section, changing work someone else owns — so confirm the adoption with the user (Step 3's match
  branch already does)

**Asking permission to create the ticket:**
- Don't. Creating the ticket for the plan you were told to sync is not gated — the approved design
  doc and its plan are the confirmation, and this skill is named in the ticket-creation exemption in
  `skills/workflow-guide/references/routing.md`. That exemption covers only the ticket for the plan
  you were told to sync — every other ticket-filing in this workflow stays under the deferral gate
  routing.md sets
- What needs the user's approval is a **scope change** — cutting scope, or splitting work off into a
  separate ticket — and what they approve is the scope change itself, not the ticket that records it
  (`skills/workflow-guide/references/routing.md`, the deferred-work rule)
- The Done-epic check in Step 3 still runs on every create. It is not a permission gate; it checks
  that the container is open

## Integration with Team Dispatch

Team Dispatch calls this skill in step 7, after writing the implementation plan and before spinning up the team. This ensures the Jira ticket has the task checklist before implementers start work.

## Example Flow

```
User: "Write a plan for implementing auth flow (DEV-123)"

[writing-plans skill completes, saves plan]

Claude: I'm using the syncing-plans-to-jira skill to sync this plan to Jira.

[Checking Jira tool intent... configured]
[Fetching DEV-123...]
[DEV-123 is an Epic: "Authentication System"]
[Found 3 child tickets:]
  - DEV-456: "Login page UI" (Done)
  - DEV-457: "OAuth integration" (In Progress)
  - DEV-458: "Session management" (Open)

None of these match "auth flow implementation".

[Done-epic check: DEV-123 statusCategory is "indeterminate" — not done, safe to create under it]

Creating new Story under DEV-123...

[Created DEV-459: "Auth Flow Implementation"]
[Updating description with task checklist...]
[Resolved current user via atlassianUserInfo]
[Assigned DEV-459 to Alex Rivera]

Updated DEV-459 with 3 tasks in description, assigned to Alex Rivera:
- [ ] Task 1: Set up auth middleware
- [ ] Task 2: Implement token validation
- [ ] Task 3: Add login endpoint

View in Jira: https://yourorg.atlassian.net/browse/DEV-459
```
