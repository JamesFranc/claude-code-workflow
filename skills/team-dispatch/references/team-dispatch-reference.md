# Team Dispatch — Reference

Long-form guidance and rationale for the Team Dispatch skill. Read this once before your first run of the skill in a session — the numbered checklist in `SKILL.md` is what you execute against.

## Overview / Input

Plan and execute the implementation for a single story. This is the third gate in the skill chain — it writes the implementation plan, spins up a team, executes, gets senior review, opens a draft PR, and then waits for the user's feedback before shutting down. The user watches the teammates' panes but doesn't need to intervene unless something goes wrong.

**Announce at start:** "I'm using the Team Dispatch skill to implement [TICKET-ID] [story title]."

**Input:**
- A ticket from Jira (Story from Architecture, or Bug from Systematic Debugging), when Jira is configured
- A design doc in `docs/plans/` — an architecture doc (`-2-arch.md`) for feature work, a bug summary doc (`-1-bug.md`) for bug fixes, or a change summary doc (`-1-change.md`) for small changes. All three serve the same role as input: they define the scope, proposed approach, and context that the implementation plan expands into.

If no design doc exists, run the Architecture skill (`workflow:architecture`) for features, the Systematic Debugging skill (`workflow:systematic-debugging`) for bugs, or the Quick Change skill (`workflow:quick-change`) for small changes first.

## Process Compliance

**NEVER skip Team Dispatch.** Common rationalizations that are WRONG:
- "This is too small for the full process" — The process self-abbreviates. A one-file fix still gets a plan, a team, a review, and a PR.
- "I already know how to fix this" — Great. Write it in the plan. The senior engineer still reviews.
- "The user just wants a quick fix" — Quick fixes still need review. The process IS quick when the change is small.

**NEVER interpret silence as agreement.** At decision points (proceeding to next phase, choosing between options, making architectural changes), require explicit user confirmation. Silence means "I haven't responded yet," not "yes."

**NEVER make unilateral architectural decisions.** If the implementation reveals that the architecture needs to change (e.g., removing a dependency, changing an API contract, switching an approach), present the options to the user and let them choose. Do NOT execute architectural changes silently.

## Implementation Plan Completeness Checks

- **Audit helper functions** that depend on modified state — when adding new fields or changing behavior, check all existing helpers that read the same state and verify they handle the new data correctly
- **State file backwards compatibility** — when adding fields to persisted state (JSON files, localStorage, etc.), ensure code handles state files written by the previous version (missing fields should have safe defaults)
- **Test impact analysis** — when refactoring changes return types, function signatures, or removes imports, enumerate the test files that exercise those code paths and include updating their assertions in the plan
- **Infrastructure/CDK section** — when adding new service clients or external dependencies, enumerate: env vars for all handlers, IAM policies for all handlers, config entries (workflow config, feature flags). Three separate runtime failures from missing infra is three too many.
- **React render stability** — for UI changes involving hooks, check for unstable references (inline objects/arrays in useMemo deps, recreated callbacks) and remove dead query fields that were part of a removed feature
- **Multi-repo merge order** — when changes span repos with runtime dependencies, define the merge/deploy sequence in both the plan and PR bodies
- **Verify referenced scripts exist** — before specifying `pnpm`/`npm` scripts in build verification or task steps, check the target repo's `package.json`. If you can't verify, use a portable instruction ("run the repo's format check") instead of a hardcoded script name
- **Tool allowlist completeness** — when a plan specifies a tool allowlist for a new agent, grep the architecture doc for every tool name and verify each negative mention (including narrative phrasing like "must not have Agent") is captured. Do not translate only the list-form negatives
- **Module-load-time top-down caveat** — the user's "top-down call order" convention has an exception: when a module-top expression (e.g., `buildCommand({...})`) references arrow-function `const` helpers, those helpers must be declared above the expression. Note this in the plan when relevant to the changed file
- **Single source of truth for cross-section decisions** — when an architectural detail (node-tree shape, coord-system math, build sequence) is described in both a Design Decisions section and a Task Breakdown step, drift happens. Write it once in the design section and have the task list reference it
- **Coord-system rung discipline** — when a plan multiplies tile/chunk/pixel coordinates (or any layered coordinate system), document which space each constant lives in. Three rungs: world-pixel = world-tile × tile-size, world-tile = chunk-coord × chunk-size + intra-chunk-local
- **Verify technical assumptions by symbol** — every claim the plan makes about existing code (a signature, a call site, a config value, that a path exists) cites the symbol or quoted literal you read, not memory; a line number may ride along as a hint but never carries the citation alone, because the plan outlives the lines and the change's own edits shift them (`skills/workflow-guide/references/durable-references.md`). An unverified assumption is a task ("confirm X"), never a stated fact. This is the architecture skill's verify-don't-assert rule applied at the plan level.
- **Plan snippets are literal, not illustrative** — code and text the plan shows is written verbatim by the implementer, so it must already be correct: lint/format/typecheck-clean, convention-following (top-down order, no `as`/`any`, names describe shape), matching the user's style rules. If a snippet is a sketch, label it explicitly as pseudocode; otherwise it is a contract. (This is what "complete, not pseudocode" means — complete *and* literal.)
- **"Only X is affected" is a grep result, not a guess** — every scoping claim in the plan ("this is the only caller", "nothing else reads this field", "only these files change") is the output of an exhaustive search; state the pattern you grepped so it's reproducible. A scope you didn't search is an assumption, not a boundary. When the claim is one of a task's named defect classes, this is the acceptance contract's **Sweep** field, not a separate statement of the rule — a behavioural key, a pattern derived from it, a scope, a stated blind spot, and a found list giving a disposition for every matched path (the per-task acceptance contract at `skills/team-dispatch/SKILL.md` §6, "Write the implementation plan"). The Sweep reports what it found and what its pattern cannot see; it does not certify the class closed, and a scoping claim in the plan is read the same way.
- **Enumerate mirror/template copies and superseded-file deletions as explicit tasks** — when a change is mirrored (a test fixture copied across packages, a snapshot, a duplicated config) each copy is its own task; when a change supersedes an old file (rename, replacement, removed shim) the deletion of the old file is its own task. Copies and deletions are planned work items, not afterthoughts the implementer discovers mid-stream.
- **Quote every Out-of-Scope constraint verbatim** — every constraint the design doc marks Out of Scope must be quoted verbatim in the implementation plan, with a line saying how the plan honours it. Paraphrasing lets a constraint quietly erode; the exact wording is the check.

## Team Composition

- **1 implementer** — Simple story, sequential tasks, one repo
- **2-3 implementers** — Multi-component work, parallelizable tasks, multiple repos

The user does NOT need to review this plan. It's consumed by the team.

## Execute — Detail

**Implementers work through the plan:** follow TDD where the plan specifies it; make frequent, small commits using the format `<type>: [<TICKET-ID>] <description>` (with no ticket, `<type>: <description>`) (commit body guidance: `agents/implementer.md` §Commit Format).

**CI environment readiness (before the first push):** before the team lead's first push on a new branch, the code must be verified to work in CI — not just locally. The implementer surfaces any of these the plan didn't cover so they're resolved before handoff:
- Check the project's CI Node version against local (e.g., `.nvmrc`, `engines` in `package.json`, CI workflow files)
- Check for native bindings or platform-specific dependencies that may not exist in CI
- Check for environment variables or secrets that CI needs but aren't configured
- Check for generated files (types, schemas) that CI must generate before build

This prevents the common pattern of 3-4 CI failures on first push, each requiring a push-wait-fail-fix cycle.

**PR monitor:** the PR is registered for watching later in the PR Lifecycle skill, after the draft PR is created; the wake mod then reports changes to the session.

**Sync Jira task list (exact procedure):** skipped with no Jira. When a task is completed, update the corresponding checkbox in the Jira ticket description:
1. **Read first:** Fetch the current description via `getJiraIssue` with `responseContentFormat: "markdown"`
2. **Update the checkbox:** Find the exact `- [ ]` line matching the completed task and change it to `- [x]`. Checkboxes MUST use `- [ ]` / `- [x]` format (with dash-space prefix) — bare `[ ]` without the dash gets escaped and won't render as checkboxes.
3. **Write back the full description** via `editJiraIssue` with `contentFormat: "markdown"`. Always include `contentFormat: "markdown"` — omitting it defaults to ADF which will corrupt the markdown content.
4. **Verify:** Re-read the ticket to confirm the checkbox actually changed. If it didn't, retry once.

**IMPORTANT:** Make Jira MCP calls sequentially — one at a time. Do not batch multiple `editJiraIssue` calls in parallel; the Jira MCP will reject parallel requests.

The team lead (main thread) monitors progress and unblocks issues.

**Process improvement check-ins:** after an implementer completes a significant task (or group of tasks), invoke the Process Improvement Notes skill (`workflow:process-improvement-notes`) in **check-in** mode.

## Senior Engineer Review — Detail

When all implementation tasks are complete, the team lead re-enters the dashboard and begins review (see the checklist's senior-review-trigger step for the exact commands and the pin-to-a-SHA rule).

## Operational Rules for Team Lead

- **Always include a `summary` on string messages** — every `SendMessage` whose `message` is a plain string MUST also set `summary` (a 5–10 word UI preview); the tool rejects a bare string with `Error: summary is required when message is a string`. Only structured protocol messages (`shutdown_request` / `shutdown_response` / `plan_approval_response`) may omit `summary`.
- **Batch implementer instructions** — send all information (ARNs, config values, context) in one message before the implementer starts. Don't send critical info reactively after they report being blocked.
- **Reload workflow skills** at the start of each story to pick up the latest instructions (PR feedback attribution, etc.)
- **Verify explore agent negative claims** — when an explore agent says "X doesn't exist," require it to show what it searched for. "No match found in outbox.ts" is not the same as "no outbox exists" — check non-standard directories, relative imports, and exported symbol names.
- **Verify against reality, don't trust the report** — when an implementer reports "done / committed / all gates green," reproduce the cheap, no-mutation half on disk before accepting it: re-read the actual changed files, `git log origin/main..HEAD` to confirm the commit actually landed (a cached worktree status is not proof), and — once you've pushed — `git fetch` + `git log "origin/<branch>..HEAD"` (empty = actually pushed); `gh pr view --json headRefOid,state,mergeStateStatus` for real PR/merge state. For the gates themselves, check the implementer's saved record instead of re-running it — same rule, same exceptions, as `skills/team-dispatch/SKILL.md` step 18 ("The team lead checks a teammate's proof rather than re-deriving it."): an incomplete record goes back to the implementer per that step's incomplete-record rule, and that step's three triggers (inconsistent / contradicted / superseded) are the only licence available to *you* for a re-run — name every one that fired. That same step also states the one case this doesn't touch: the **pre-push gate**, which the lead always runs itself once at the SHA being pushed, regardless of what any record says — that's a separate, later step, not this one. The implementer runs the red/green capture and every gate declared `owner: implementer`, and records each as a capture; `owner: team-lead` gates are the lead's (`skills/team-dispatch/SKILL.md` step 13). The **senior reviews those captures and runs nothing**. Do not delegate any test/gate *running* to the senior.
- **Reproduce a bot/monitor signal before acting on it** — a `[MERGED]`/`MERGE_READY` event from the PR monitor, or a CodeRabbit finding, is confirmed against reality first (`gh pr view`, re-run the check) — never acted on from the signal alone. The running monitor may be an older pinned build with known false-signal bugs. The mirror case is the signal that never fired: a required check can render `pass` for having been *skipped*, which the conclusion field cannot distinguish from a real pass. Read the check's detail text rather than its conclusion — `gh pr checks "<pr>"` prints the reason — and treat a skipped check as **absent**, not green, say so wherever you cite the gate, and name what would make it run. `skills/code-review/references/review-rules.md` §Verify Against Reality enumerates the states that produce this.
- **Never recommend `pnpm store prune`** — it clears all cached @scoped packages, requiring re-authentication with private registries.
- **Dispatch on user-decision relay** — when the team is blocked on a user decision, the orchestrator's response to the user's answer must produce both a user-facing reply AND a `SendMessage` to the relevant team member in the same turn. Never relay a decision to the user without also unblocking the team
- **Don't race the in-flight turn** — when a teammate is mid-turn (still working, its message not yet landed), wait for the turn to actually land — the message, commit, or task-update appearing — before acting on its state. Reading a worker's state while it is mid-write is a torn read; acting on it (declaring it done, starting review, tearing the team down) is how the gate slips. This is the team-coordination face of *verify against reality*. **Before reporting a discrepancy in a teammate's repo state, declaring it done, starting review, or tearing the team down, date the last HEAD movement in the worktree that teammate commits to: `git reflog --date=iso` — an entry inside the last few minutes means wait. It is worktree-scoped, not agent-scoped: with 2–3 implementers sharing a worktree a recent entry may be another agent's, so it can raise suspicion and never settle it. An older entry is NOT evidence the teammate is idle: the reflog records HEAD movements and cannot see uncommitted edits, so absence of recent activity never licenses acting — confirm the turn landed instead: the message, commit, or task-update appearing. Agents that write no repo state — a researcher, one of the senior's review sub-agents — are outside this rule and shut down when their answer lands.** A dirty tree plus a stale HEAD is indistinguishable, at a single instant, from a fix committed ninety seconds later — which is why the reflog is corroboration after the fact and never a green light in the moment: on FLOW-214 it dated the amends only once they had already landed.
- **Never bypass the review gate — push only after senior review, every round.** There is no path to the remote that skips senior review, no matter how small or urgent the change looks. Implementers **commit but never push**; the team lead is the only one who pushes, and only after the senior has reviewed (first push) or re-reviewed (every update round after the branch is already pushed). The team lead never hand-rolls a fix and pushes it to "save a round" — that bypasses the implementer AND the review. Every change reaches the remote through implementer commit → senior approval → team-lead push. (See "the team lead NEVER implements code directly" and the *Senior engineer is mandatory* principle.)
- **Re-derive work state from git + Jira (when configured) across compaction** — on a long, multi-story job, context gets summarized and details drop. Recover durable work state — which stories are done, which branches and PRs exist, what is merged, which tickets are In Progress — from the durable sources (`git log`, `git branch`, `gh pr list`/`gh pr view`, Jira ticket status), not from memory a summary may have erased. The roster of spawned agents and PR monitors needed for teardown is part of this durable state: keep it somewhere a re-derive can recover it (the process-notes file), not only in working memory, and write each entry when its agent or monitor starts (`skills/team-cleanup/SKILL.md` §4. Shut Down Team Members). Every roster entry records the ticket ID and the session ID, plus identity fields that differ by entry kind — the agent ID and agent type for an agent, the PR number and repo owner/name for a monitor — and teardown reads back only the entries for the current ticket and session, since the notes file is shared across the whole epic.
- **Posting to the board on a blocker is unconditional** — the moment the team is blocked on a human decision, a credential/auth/env ask, or any open question you cannot proceed past, post it to the dashboard immediately; the board is the channel, not a side notification. Don't wait to "see if it resolves." The enumerated trigger list and exact invocation live in the PR Lifecycle skill's **Board Triggers (Unconditional)** section (`workflow:pr-lifecycle`), which also states the board-first requirement — it applies during implementation too, not only the PR phase.

## Error Handling

| Situation | Action |
|-----------|--------|
| A spawned teammate landed in-process (no pane) | This session can't show panes right now — don't guess why. STOP and tell the user to re-run from a fresh top-level `claude` session (a new terminal). Never run an invisible team silently. (Check the spawned teammate rows, not the `team-lead` row, which is always `in-process` by design.) |
| Implementer is stuck | Message team lead; team lead unblocks or reassigns |
| Tests fail after implementation | Implementer fixes; do not proceed until green |
| Senior engineer finds critical issues | Implementers fix before PR is opened |
| Senior engineer is unresponsive (crashed, zombie, or no reply to a direct message) | Team lead takes over review or notifies user |
| `[team] dead-teammate <name>` wake from the wake mod | The teammate has no process — it never started (usually a client update pruned the binary the lead spawns from) or it exited. If you were waiting on its shutdown ack, the shutdown is complete — nothing else needed. Otherwise, if its work is unfinished, respawn it once with the same instructions; if the respawn is reported dead too, post a board blocker asking the user to restart the client. |
| Branch push fails | Find out what moved the remote. The team's own branch diverged by the workflow's own rebase → push it per `skills/pr-lifecycle/SKILL.md` §Force-Pushing the Team's Own Branch — force-pushing only when that section's checks say so — no board item unless that section's check 1 both exits `0` and finds a non-empty `<file>`. Anything else → understand it before pushing again. |
| Jira tool intent = unconfigured | Continue with no ticket per `skills/workflow-guide/references/routing.md` §Cross-Phase Rule: No Jira, No Ticket; say once in the conversation that Jira steps are skipped |
| Jira tool intent = failed | Skill already halted at the tool intent check — do not reach this row |

## Key Principles

- **Blocked on a decision → post to the board** — See the cross-phase rule in `skills/workflow-guide/references/routing.md`.
- **Plan is durable** — Written to file, not just context. Implementers and reviewer reference it.
- **Team is visible — verified, not assumed** — teammates run in panes (iTerm2 or tmux) the user can watch. After the first spawn, verify the teammate row's `backendType` is `iterm2`/`tmux`, not `in-process` (ignore `team-lead`, which is always `in-process` by design). Don't predict visibility from env vars or session type — check the actual pane. If a teammate can't be made visible, STOP and tell the user rather than going invisible
- **Senior engineer is mandatory; push waits for review** — No PR without review, and no bypass for small or urgent changes. Implementers commit but never push; the team lead pushes only after senior approval — on the first push and on every update round. The team lead coordinating a fix is never a license to write or push it directly (see *Never bypass the review gate* in the operational rules)
- **Durable state over remembered state** — across a long job, re-derive which stories/branches/PRs exist and which agents are still live from git + Jira + the process-notes file, not from working memory that compaction can erase
- **Fix before shipping** — Issues found in review get fixed in the same cycle, not deferred
- **Draft PR only** — The user publishes when ready
