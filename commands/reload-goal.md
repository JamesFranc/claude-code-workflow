---
description: Re-anchor on the current goal — re-read the active PRD's North Star block and the in-flight implementation plan, then restate the goal and the bar in your own words. Use mid-story to recover the objective after compaction or a long stretch of work.
argument-hint: [optional PRD path or Jira ticket id]
---

# Reload Goal

Re-establish what we are really trying to accomplish and the bar the work is held to. Use this when you've been deep in a long task and need to recover the objective — especially after compaction has summarized away the original framing.

Do the following now:

1. **Resolve the active PRD**, in this order:
   - If an argument was given, use it: a file path resolves directly; a Jira ticket id (e.g. `FLOW-77`) resolves to the PRD linked from that ticket.
   - Otherwise, resolve the ticket from the current git branch (the branch name usually carries the ticket id) and use the PRD linked from it.
   - Otherwise, use the most recent `docs/plans/*-1-prd.md` (or `*-1-bug.md` / `*-1-change.md`) in the workspace.
   - If resolution is ambiguous (several recent PRDs, detached HEAD, no ticket on the branch), **say so and ask for an explicit path or ticket** rather than guessing.

2. **Re-read the North Star.** Open the resolved PRD and read its `## North Star — what we are really trying to accomplish` block. This is the durable, user-verified statement of the goal and the bar.

3. **Re-read the in-flight plan.** Open the matching implementation plan (`docs/plans/*-3-impl.md` for the same topic, or the bug/change summary doc) and re-read the current story's scope and remaining tasks.

4. **Restate.** In your own words, say (a) the North Star — the real goal and the bar — and (b) where the current work stands against it and what's left. If you'd drifted, name the correction.

## Note

This reads the goal from disk, so it survives compaction — the PRD's North Star block is the anchor. If the resolved PRD has no North Star block (older PRDs predate the convention), say so and fall back to its Problem Statement + Success Criteria.
