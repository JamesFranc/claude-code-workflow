# PR Lifecycle — Reference

Long-form guidance and event-handler rationale for the PR Lifecycle skill. Read this once before your first run of the skill in a session — the numbered checklist in `SKILL.md` is what you execute against.

## Overview / Input

Manage the full lifecycle of a draft PR — from final gate verification through merge detection. This skill is invoked after the senior engineer approves the implementation. It handles pushing, PR creation, monitoring, feedback loops, and waiting for the user.

**Announce at start:** "Opening draft PR and watching it."

**Input:**
- **Branch name** and **worktree path**
- **PR title** and **body content** (including Jira ticket, architecture doc, and implementation plan references)
- **Repo owner/name** (e.g., `owner/repo`)
- **Jira ticket ID** (for updating process improvement notes with the PR URL)
- **Process improvement notes file path** (optional — if tracking process notes)
- **Dashboard ticket-node keying** — which of step 1's ticket-node blocks applies: the ticket is the dashboard root (default) or an epic story entered earlier this session — the two are mutually exclusive; a multi-PR ticket additionally runs the third, additive block on top of whichever of those two applied. Defaults to the root block when invoked standalone. The key itself is never passed in — it is resolved with `dashboard session key --ticket "<TICKET-ID>"`, because a restart recovery can have moved the node to `<TICKET-ID>-resumed` (`skills/board/references/dashboard-protocol.md` §1, *The ticket node key*).
- **Multiple PRs for this ticket?** — default no. Only a multi-PR ticket (e.g. a multi-repo story) gets a per-PR child node.

## Notification

The Graphite and GitHub links were already registered on the board in the links step (SKILL.md
step 6). The board carries them — tell the user the PR is ready for review on the dashboard and
wait. Do **NOT** open a browser tab; the workflow never opens a link for the user.

## Event Handler Rationale

Context for *why* the Handle Monitor Events checklist step branches the way it does — the checklist states the procedure; this is the reasoning behind it.

**NEW_THREADS:** Evaluate each comment on its merits — don't reflexively dismiss automated reviewers (CodeRabbit, etc.) or reflexively accept them. A CodeRabbit comment about scope or feature parity may be catching a real gap.

**CODERABBIT_RATE_LIMITED:** A rate-limit banner only exists because a review was actually attempted — CodeRabbit does not review a draft on its own (it posts "Review skipped — Draft detected" instead), so this banner means the PR was flipped to ready-for-review or the review was manually triggered. It is **never** a reason to "wait for the flip" or to hold the re-request to "save the rate-limit budget": the review has already started and been throttled; your only job is to let it finish.

**Check head-approval before every re-request, not just once.** `gh pr view --json reviews,headRefOid` first: if an APPROVED review already exists on the current head SHA, the review this banner is throttling has already completed — re-requesting would be a wasted, confusing duplicate that can reopen a settled review state. Three live reproductions (FLOW-133, FLOW-149 ×2) hit this exact ordering bug: the handler fired the re-request without checking whether the head was already approved.

Recovery is silent and has no cap. No user ping for a throttle, however many times it recurs. This pending re-request is durable: if the whole session restarts mid-cooloff, re-establish it on resume (see the `restart-jobs` command). And if a fresh `CODERABBIT_RATE_LIMITED` arrives whose `occurrence` count has **not** advanced past the one you are already handling, it is a duplicate (typically a re-read of an already-handled monitor event across a monitor restart, not a new throttle) — take no new action and do not re-narrate it.

**CODERABBIT_PAUSED:** Like a rate-limit banner, a pause banner means a review was already in motion — but **unlike** a rate limit (a fixed timer), a pause is waiting for the branch to stop changing, so here — and *only* here — it is correct to fold the re-request into a pending human gate rather than fire it on a timer. The same head-approval precondition applies here as for `CODERABBIT_RATE_LIMITED` above — check `gh pr view --json reviews,headRefOid` before folding the re-request into the pending gate's resolution too; an already-approved head means there is no review left to re-request.

**CodeRabbit throttle recovery is silent and never gives up.** A `CODERABBIT_RATE_LIMITED` cooloff-and-re-request or a `CODERABBIT_PAUSED` re-request produces no user ping, and the retry has no cap. When several PRs share CodeRabbit's hourly allowance, one PR can be throttled many times before its turn comes, and every retry sent after the wait is one that can get the review. Asking the user whether to keep going only burns the hours those reviews would have used, and the answer is always yes. The command matters as much as the timing. A PR with no CodeRabbit review gets `@coderabbitai full review`, which reviews the whole PR from scratch, rather than the incremental `@coderabbitai review`. On one PR CodeRabbit had never reviewed, every plain `@coderabbitai review` was refused as rate limited, with a note that CodeRabbit does not re-review already reviewed commits. The one `@coderabbitai full review` was also refused as rate limited, so that PR shows the incremental command's note but not yet a `full review` succeeding. Re-requesting is the only write to the PR performed on the user's behalf without an explicit approval, and it only ever posts `@coderabbitai review` or `@coderabbitai full review`.
