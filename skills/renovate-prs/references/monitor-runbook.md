# Renovate PR Monitor — Runbook

`renovate-pr-monitor` watches open Renovate PRs across a
configurable set of orgs/repos and auto-merges the safe ones. Routine work
(approve + merge, rebase, flaky-CI retry) is silent. When a PR needs code
changes or operator judgment, the script exits with a JSON event on stdout and
this runbook tells Claude how to handle it.

This is a **generic** tool. It carries no repo- or org-specific remediation
knowledge — the script only performs mechanical git/gh operations. Everything
that requires understanding a specific codebase (a dependency bump that broke a
build, test, or type) is escalated to the main Claude session, which **diagnoses
the failure and writes the fix plan**, then **dispatches a teammate subagent to
implement and push it** (see "Fixing a PR — you diagnose, a teammate
implements"). Recipes that prove reusable get added to the **Mechanical fixes**
section below so they accumulate over time.

No Claude tokens are consumed while the monitor is idle — the script polls over
the operator's `gh` CLI auth in a TypeScript command's poll loop. Claude is only
invoked when an event fires.

## Configuration

Scope is **required** and set via environment variable:

```bash
# Space/comma-separated list of patterns. Each is "owner/*" (all repos in an
# org or user) or "owner/repo" (one repo).
export RENOVATE_MONITOR_SCOPE="acme/*  myuser/some-repo"
```

Optional overrides (all have sensible defaults):

| Var | Default | Meaning |
|---|---|---|
| `RENOVATE_MONITOR_AUTHOR` | `app/renovate` | PR author to watch (Mend-hosted Renovate app). Override for a self-hosted bot. |
| `RENOVATE_MONITOR_POLL_SECONDS` | `900` | Poll interval in loop mode. Whole seconds only. |
| `RENOVATE_MONITOR_MAX_CI_RETRIES` | `2` | Flaky-CI retry cap before escalating. A whole number. |
| `RENOVATE_MONITOR_MERGE_DELAY_SECONDS` | `120` | Minimum gap between consecutive merges, so draining a backlog doesn't fire a burst of simultaneous deploys. Set `0` to disable. Whole seconds only. |
| `RENOVATE_MONITOR_EXCLUDE` | _(empty)_ | Repos to skip even if in scope (see below). |
| `RENOVATE_MONITOR_HOLD_FOR_HUMAN_PRS` | `false` | **Opt-in.** Hold off merging Renovate PRs in a repo while a human has an open, non-draft PR there (see below). Off unless set to `1`/`true`/`yes`/`on`. |
| `RENOVATE_MONITOR_HOLD_RELAX_HOURS` | _(empty)_ | Quiet window that **suspends** the hold, `START-END` on a 24h clock, e.g. `0-8` (midnight–8am). During it, otherwise-held repos are fair game. `start > end` wraps midnight. Empty = always hold when enabled. |
| `RENOVATE_MONITOR_HOLD_RELAX_TZ` | _(local)_ | Timezone for `HOLD_RELAX_HOURS`, e.g. `America/Chicago`. Defaults to the machine's local time. |
| `RENOVATE_MONITOR_BOT_AUTHORS` | _(empty)_ | **Rare fallback.** Bots are auto-detected (`is_bot` or a `[bot]` login); only list logins here for automation run under a *plain user account* with no `[bot]` suffix (see below). Space/comma-separated, case-insensitive. |
| `RENOVATE_MONITOR_STATE_FILE` | _(session store)_ | State file path. Defaults to a path inside the session's own store, so concurrent sessions keep separate PR state; find the exact path on the monitor's `[monitor] state=` startup line. |

Set these in `~/.claude/settings.json` under `env`, or export them in the shell
that launches the monitor.

### Excluding repos

`RENOVATE_MONITOR_EXCLUDE` skips specific repos that are otherwise in scope —
e.g. a repo whose Renovate PRs you always want to review by hand:

```bash
# Space/comma-separated. "owner/repo" excludes one repo; "owner/*" excludes a
# whole org. An optional leading "-" is tolerated, so either form works:
export RENOVATE_MONITOR_EXCLUDE="acme/elements  -acme/sandbox-*"
```

Matching is case-insensitive. **Archived repos are always skipped** regardless of
this list — you don't need to add them.

### Holding merges while a human PR is open

**Opt-in** (`RENOVATE_MONITOR_HOLD_FOR_HUMAN_PRS=1`). When enabled, the monitor
**will not auto-merge a Renovate PR in a repo that has an open, non-draft PR
authored by a human.** This stops the bot's merges from constantly moving the
base branch out from under your in-flight work — every bot merge forces your PR
to rebase, and draining a backlog can do that repeatedly. It's off by default so
it isn't silently active across every scope you monitor.

- "Human" means an open PR that is **not a draft** and whose author is not a bot.
  Bots are detected **automatically, no configuration**, by any of:
  - GitHub's bot author flag (`is_bot=true`), and
  - a login ending in **`[bot]`** — GitHub reserves that suffix for bot/App
    accounts (a human login can't contain `[` or `]`), so this catches
    `github-actions[bot]` (release-please's default), `renovate[bot]`,
    `dependabot[bot]`, etc. It's belt-and-suspenders with `is_bot` because `gh`
    renders the same actor differently across subcommands (one reports
    `is_bot=true`, the other `is_bot=false` with the `[bot]` login).
- **Rare fallback — `RENOVATE_MONITOR_BOT_AUTHORS`.** Only needed for automation
  run under a *plain user account* (no `[bot]` suffix, `is_bot=false`) — e.g.
  release-please driven by a personal-access-token user rather than the default
  `github-actions[bot]`. List those logins (space/comma-separated,
  case-insensitive) so they don't hold the repo:

  ```bash
  export RENOVATE_MONITOR_BOT_AUTHORS="ci-deploy-bot  my-release-user"
  ```

  Most setups never need this. The monitored `RENOVATE_MONITOR_AUTHOR` is always
  included automatically (so the monitored bot run as a user account can't hold
  its own PRs — a repo-wide deadlock).
- The check is **repo-wide** — any open non-draft human PR in the repo holds *all*
  Renovate merges there, regardless of base branch. (If you later want it scoped
  to only PRs sharing the Renovate PR's base branch, that's a small refinement —
  ask.)
- Only the **merge** is held. Rebases, CI retries, and major-bump escalation
  still happen, so the Renovate PRs stay fresh and **drain automatically once your
  PR merges or closes**.
- A held PR is a quiet no-op, not an escalation — the monitor logs `merge held`
  and moves on. **It fires no event of its own**, but it's listed in the `held`
  array of the next `all-done` summary the monitor emits, so a stop tells you
  what's being held and why. You never have to *act* on a hold.
- **Quiet window (`RENOVATE_MONITOR_HOLD_RELAX_HOURS`).** Overnight, nobody's
  pushing to those human PRs, so a bot merge won't rebase out from under anyone.
  Set a window to suspend the hold during those hours — held repos become fair
  game and drain:

  ```bash
  export RENOVATE_MONITOR_HOLD_RELAX_HOURS="0-8"            # midnight–8am
  export RENOVATE_MONITOR_HOLD_RELAX_TZ="America/Chicago"   # default: local time
  ```

  `START-END` on a 24h clock; `start > end` wraps midnight (`22-6`). During the
  window the monitor skips the hold check entirely (no extra API calls) and merges
  normally — the inter-merge delay still spaces the drain out.

Note: a long-lived open human PR will hold that repo's Renovate merges (outside
any quiet window) for as long as it stays open. That's intended — but if a PR is
parked indefinitely, either convert it to a draft or close it so Renovate can
drain.

### Major version bumps are never auto-merged

Major bumps (e.g. `v5 → v6`) are detected from Renovate's own conventions (the
`(major)` title suffix, a `renovate/major-*` branch, or a major update-type /
version increase in the PR body table) and are **never** auto-merged. They are
escalated to you via the `majors-for-review` event so you decide. This is not
configurable — it's a safety rail.

## The board

Every point in this runbook where the monitor stops for a human is a board item. Invoke
`workflow:board` for the protocol: questions, reconcile, and consume-what-you-read.

**One node per monitor session.** Run the monitor in its own Claude session, never inside a story's
session. A keyless `enter` attaches to whatever live root the session already has, so handling an
event inside a story session files the escalation under that story. Enter the node before the first
launch:

```bash
dashboard session enter --phase renovate --title "renovate: <scope>"
```

It is a root with no `--key` and no ticket link, since there is no Jira ticket. Every escalation
below posts against it, and there are no per-PR child nodes.

**Asking.** Every stop below is a plain question. Nothing in this runbook uses `--approval-kind`:
an escalation asks the user to decide, never to bless something as finished. Write the prompt to a
temp file, never a shell string (`skills/board/references/dashboard-protocol.md` §2):

```bash
ADD_OUT="$(mktemp)"
dashboard item add --type question --recommend "<one line>" --stalls "<what waits|none>" \
  --why-mine risk --prompt "$(cat "<tmpfile>")" > "$ADD_OUT"
rc_add=$?
if [ "$rc_add" -eq 0 ]; then
  echo "itemId=$(jq -r .itemId "$ADD_OUT")"
else
  echo "rc_add=$rc_add"
  cat "$ADD_OUT"
fi
rm -f "$ADD_OUT"
```

With a board the call prints `itemId=<id>`; note that id, since the steps below take it as `<item-id>`
and `<id>`. With no board `item add` exits 3 and the call prints `rc_add=3`, the composed question
and "Ask the user this in the terminal and wait for the reply" instead of an id: ask that question in
the terminal, wait for the reply, and act on it as "On the answer" describes for a terminal answer,
skipping every id-based step below (recording the id, `consume --item`, `item show`) for this PR.
Leave `agentBusy` set while you wait, as for a posted question. Any other non-zero `rc_add` prints
the same way: it is a failed post, not a hand-back.

The prompt carries the PR link, preferring the Graphite URL (`app.graphite.com/github/pr/...`), and
the evidence the user needs to decide. `link add --kind pr` is only for a PR the user is being asked
about. A monitor node lives for days, and registering every merged PR would bury the ones that
matter.

With a board, record the printed `itemId` against the PR key (stop the monitor first, see "State file" — "Stop before
writing"; recipe at "State file" — "Recording a PR's board item"), so a later re-emit can still find
it once the answer is consumed.

Every stop in this runbook posts, captures, and (with a board) records exactly this way before leaving
`agentBusy` set: the autonomy-rail STOP, the implementer reporting its plan didn't work, both rebase-conflict
STOPs, and the `unknown` event. Once the user answers, see "On the answer".

**On the answer.** What happens next depends on how the user answered. With no board there is no
`<id>`: the terminal reply is the answer, the `consume` steps below do not apply, and the `outcome` is
still merged into the PR's record (creating it with no `item`) so a `leave` holds:

- **Go-ahead with a plan** → merge `outcome: "dispatch"` into the PR's board-item record (stop the
  monitor first, see "State file" — "Stop before writing"), **then** `dashboard item consume --item
  "<id>"` — in that order, so a crash between the two leaves a recorded outcome, not a consumed item
  with none. Dispatch per "After dispatch" (below); `agentBusy` stays set until the teammate
  returns, exactly as written there.
- **User takes the PR themselves, or says to leave it alone** → merge `outcome: "leave"` into the
  same record (stop the monitor first, see "State file" — "Stop before writing"), **then**
  `dashboard item consume --item "<id>"`, in that order for the same reason. Leave `agentBusy` set
  and restart the monitor.
- **The PR re-emits later** — `agentBusy` stopped being set. Either it was cleared directly (the
  "Pushed the fix" step under "After dispatch", below, or "State file" — "Clearing agentBusy after
  remediation", the recipe) and a pushed fix then failed CI with no timeout involved, or its 2h
  `agentBusy` timeout expired instead; either way `classify` no longer treats it as busy. On a
  complete search after a timeout expiry, `prunePrState`
  also clears just the `agentBusy`/`agentStartedAt` markers on its still-open `.prs` entry
  (`ciRetries`, `blockedSince`, and the rest of the entry survive; `boardItems` is a separate top-level
  key and was never pruned) — but `prunePrState` only runs when the search came back complete; on an
  incomplete search it doesn't run at all, and it's `classify`'s own timeout check against the stale
  `agentStartedAt` that lets the PR re-emit anyway. An `outcome: "leave"` PR never reaches this path —
  `classify` returns `left-alone` for it on every tick regardless of `agentBusy`, so it's only ever
  listed in `held` and doesn't re-emit at all. Before posting, read the PR's board-item record (see
  "State file") and pull its item id:

  ```bash
  STATE_FILE="<path from the [monitor] state= line>"
  ITEM_ID="$(jq -r --arg k "<owner>/<repo>#<number>" '.boardItems[$k].item // empty' "$STATE_FILE")"
  ```

  - No record at all → post as usual (see "Asking").
  - No `outcome` yet, and `dashboard item show --item "$ITEM_ID"` reports the item still `open` → the
    question is still waiting on an answer. Don't post, restart.
  - No `outcome` yet, and the item is `released` → the user already answered and the outcome was
    never merged, but this session never saw that answer, and `dashboard item show` never returns
    one. Read `dashboard answers` — it only lists items released to the current session:

    - **`$ITEM_ID` isn't in that list** (posted by an earlier or different session) → don't try to
      consume an answer nothing here has read. Leave it as it is and post a new question as usual,
      overwriting the record. The old item stays `released` on the board — this session
      can't read it back (`dashboard answers` is session-scoped) — and the fresh question
      supersedes it, so nothing further needs to happen.
    - **`$ITEM_ID` is in that list** → its line's exact shape is `[dashboard] item <id> (<type>):
      <response>` (`formatReleasedItem`), but `response` is printed verbatim and can itself contain
      newlines, so a plain `command grep -F "item $ITEM_ID ("` only recovers the answer's first line.
      Extract the whole block instead, from the matching header line up to (not including) the next
      one:

      ```bash
      dashboard answers | awk -v id="$ITEM_ID" '
        $0 ~ ("^\\[dashboard\\] item " id " \\(") { printing = 1 }
        $0 !~ ("^\\[dashboard\\] item " id " \\(") && /^\[dashboard\] item / { if (printing) exit }
        printing
      '
      ```

      Don't re-post — follow "On the answer" above for that answer.
  - Anything else — `outcome` is `"dispatch"` (a go-ahead whose dispatch later failed), or the item
    is `consumed`/`withdrawn` with no `outcome` recorded — post a new question as usual, overwriting
    the record.

  The script re-marks `agentBusy` itself on every re-emit path — each one calls `mark_agent_busy`
  immediately before emitting the event — so nothing here needs to.

**Informing.** Outcomes that decide nothing post no item. Retitle the node instead (the one
exception is the `all-done` summary, which also posts an info note — see `event = "all-done"`):

```bash
dashboard session enter --phase renovate --title "renovate: <one-liner>" --retitle
```

For example, `renovate: drained 4 · holding 1`.

## Starting the monitor

In any Claude session, start the monitor in the background:

```
Bash(
  command="renovate-pr-monitor",
  run_in_background=true,
  timeout=2147483647
)
```

Keep the task id this returns. A restart replaces it with a new one (see "Restarting the monitor")
— the id that matters for a stop (see "State file" — "Stop before writing") is always the one from
the most recent start or restart; the loop lock's recorded pid is for dead-monitor detection only,
not a stop handle.

For a one-off manual tick (e.g. after replaying state by hand):

```
renovate-pr-monitor --once
```

For a classification-only pass that changes nothing (useful when debugging the
classifier against a live queue):

```
renovate-pr-monitor --once --verbose --dry-run
```

`--verbose` prints every PR's classification (including `skip` and
`ci-pending`), not just ones that drive an action.

## When the monitor exits

In loop mode the script only exits on one of:

- an operator-sent signal (SIGINT/SIGTERM),
- an unrecoverable crash,
- a classified **escalation** event (a specific PR needs human/agent action),
- a **majors-for-review** event — one or more major version bumps were found
  this tick (never auto-merged; handed to you), or
- an **all-done** event — the session did some routine work and the current
  tick settled with nothing actionable and nothing in flight.

A fresh monitor that never finds anything to do does **not** exit on calm ticks
— it keeps polling. The all-done event is only emitted after the session has
produced at least one routine action.

On either event, the last line of stdout before exit is a JSON event:

```json
{
  "event": "ci-failed",
  "pr": {
    "owner": "acme",
    "repo": "some-service",
    "number": 412,
    "url": "https://github.com/acme/some-service/pull/412",
    "title": "chore(deps): update dependency foo to v5",
    "headBranch": "renovate/foo-5.x",
    "headSha": "811ed2134c5da961150e4a84b253bbe4484e3844",
    "baseBranch": "main"
  },
  "context": { "ciRetries": 2, "failingJobs": ["typecheck", "build"] }
}
```

Parse the last JSON object on stdout, dispatch on `event`, then follow the
matching section below.

The script marks the PR's `agentBusy=true` in the state file before exiting, so
when you restart the monitor immediately (while the implementer teammate is still
working), it skips this PR for up to 2 hours rather than racing the teammate. If
the fix is abandoned without completing, clear the flag (see "State file") so the
next session can retry.

---

## Fixing a PR — you diagnose, a teammate implements

Two events — `ci-failed` and `rebase-conflict` — need real code changes in a
specific repo. The work splits in two:

- **You (the main Claude session) diagnose.** Investigate the failure, find the
  root cause, decide what the fix is, and apply the autonomy rail. This is the
  judgment, and it stays with you. The output of diagnosis is a concrete
  **implementation plan** — the exact files and changes (a sentence for a
  one-liner; spelled out per-file for anything larger).
- **A teammate implements.** You spawn a `workflow:implementer` subagent and hand
  it that plan. It makes exactly those changes, verifies, and pushes onto the
  Renovate branch. It does **not** diagnose or make design decisions — if the
  plan doesn't work as written, it reports back to you (standard implementer
  behavior) rather than improvising.

This is **not** full Team Dispatch — no Jira ticket, no design doc on disk, no
draft PR, no senior-review ceremony. The fix is a commit pushed onto the Renovate
branch; CI re-running is the gate.

### Diagnose (you)

1. **Investigate.** Pull the failing CI logs
   (`gh run view "<run-id>" --repo "<owner>/<repo>" --log-failed`) and read the
   changed dependency and the code at the failing call sites. Reproduce locally
   only if you can't establish root cause from the logs and code — in a worktree
   **inside the target repo**, at `.worktrees/<headBranch with every / replaced by ->`, off
   `pr.headBranch` (`workflow:git-worktrees` §Naming). Read the repo's `CLAUDE.md` and
   `package.json`/`Makefile` for the install / typecheck / lint / test commands.
2. **Check the Mechanical fixes section below.** If the failure matches a known
   recipe, the plan is already written — use it.
3. **Apply the autonomy rail.** The bar for an autonomous fix is **narrow**,
   because this is a generic tool with no built-in knowledge of any repo:
   - **In the narrow lane → write the plan and dispatch:** small, local,
     mechanical adaptations confined to a file or a tight handful —
     null/optional narrowing at the exact call site a bump changed, a pure
     type/import rename, a lockfile regeneration when the package manager reports
     the lock is stale.
   - **Outside it → STOP, do not dispatch:** anything that changes behavior,
     cascades across multiple files, touches public API/contracts, requires
     choosing between plausible designs, or that you don't fully understand.
     Post a board question with your diagnosis (see "The board" — "Asking"), leave `agentBusy` set,
     and do not merge. When in doubt, stop. **No code change ships without either fitting the
     narrow lane or a human deciding.** On the answer, see "The board" — "On the answer".

### Dispatch the implementer (teammate)

Spawn a `workflow:implementer` teammate in the background: it works in a worktree inside the target
repo, and you restart the monitor immediately while it works — the rest of the queue keeps draining.
The PR is already marked `agentBusy=true` (the monitor set it before emitting the event), so the
restarted monitor skips it for up to 2h.

The dispatch prompt is the teammate's brief. Include:

- **The implementation plan** from diagnosis — the exact changes to make. The
  implementer follows it and reports back if it doesn't work; it does not
  re-diagnose or improvise.
- PR identity (`owner/repo`, `number`, `url`), `headBranch`, `baseBranch`.
- The worktree to use: if you created one while diagnosing, pass its path so the
  teammate reuses it; otherwise tell it to create one off `headBranch` at
  `.worktrees/<headBranch with every / replaced by ->` inside the target repo — the worktree must
  branch the target repo, never this workflows repo.
- Repo conventions: the conventional-commit format and the verify commands
  (typecheck, lint, the previously-failing jobs) from the repo's `CLAUDE.md` /
  `package.json`.
- **Push the fix as a commit onto `headBranch` — never a standalone PR.** Verify
  locally before pushing; Renovate then picks it up and CI reruns.

### After dispatch

1. **Restart the monitor** immediately (see "Restarting"). The background
   teammate keeps working; `agentBusy` protects this PR.
2. **When the teammate reports back:**
   - **Pushed the fix** → clear `agentBusy` (stop the monitor first, see "State file" — "Stop
     before writing") and retitle the node to say code changed (see "The board" — this informs, it
     asks nothing). The running monitor re-classifies the PR next tick once CI reruns.
   - **Reported the plan didn't work** → re-diagnose with its findings and re-dispatch a corrected
     plan, or, if it now needs judgment, post a board question with the teammate's findings, leave
     `agentBusy` set (see "The board" — "Asking"), and act on the answer (see "The board" — "On the
     answer").

---

### `event = "ci-failed"`

CI failed after the monitor already auto-retried up to
`RENOVATE_MONITOR_MAX_CI_RETRIES` times (default 2). A failure with no
workflow run behind it, such as a failing `renovate/artifacts` commit
status, escalates at once, because there is nothing to rerun.
`context.failingJobs` names the checks that failed on the latest head. This
is the common case: a dependency bump broke a build, test, or typecheck.

1. **Try rebasing first** before diagnosing — the failing run may have been
   against a stale base. Run
   `gh pr update-branch "<pr.number>" --repo "<owner>/<repo>"`.
   - `✓ PR branch updated` → the rebase landed; CI re-runs on the new head.
     Restart the monitor and let it re-classify next tick. **No fix needed.**
   - `✓ PR branch already up-to-date` → the head is current and the failure is
     real — proceed.
   - conflict → treat as `rebase-conflict` (below).
2. **Diagnose, then dispatch an implementer** per "Fixing a PR — you diagnose, a
   teammate implements." `context.failingJobs` names the checks to investigate
   (and reproduce, if needed). That section covers the autonomy rail, the
   dispatch, the immediate monitor restart, and how to handle the teammate's
   return.

### `event = "rebase-conflict"`

`mergeStateStatus = DIRTY` — the PR branch cannot be merged without resolving
conflicts. Diagnose the conflict yourself, then hand the resolution to an
implementer per "Fixing a PR — you diagnose, a teammate implements."

1. **Diagnose (you).** Determine what's conflicting — Renovate conflicts are
   almost always in the lockfile and/or manifest (`package.json` or the language
   equivalent). The safe resolution is to merge `origin/<pr.baseBranch>` (or
   rebase if the repo prefers it — `gh repo view --json rebaseMergeAllowed`),
   take the base side of the lock, and **regenerate** it with the repo's package
   manager, then re-resolve the manifest. Apply the autonomy rail: if the
   conflict is anything beyond a routine lockfile/manifest regen and needs real
   judgment, **STOP** — post a board question with your diagnosis (see "The board" — "Asking"),
   leave `agentBusy` set, don't dispatch (on the answer, see "The board" — "On the answer").
2. **Dispatch an implementer** with that resolution as the plan: merge/regen,
   commit, and push to `pr.headBranch`. Restart the monitor immediately.
3. **On the teammate's return:**
   - **Resolved cleanly** → clear `agentBusy` (stop the monitor first, see "State file" — "Stop
     before writing"). This is **silent** — no notification needed (see "Notifications").
   - **Reported the resolution didn't apply cleanly** → re-diagnose, or, if it now needs judgment,
     post a board question with the teammate's findings, leave `agentBusy` set (see "The board" —
     "Asking"), and act on the answer (see "The board" — "On the answer").

### `event = "majors-for-review"`

One or more **major** version bumps were found this tick. The monitor never
auto-merges majors — it hands them to you. The `majors` array lists each one:

```json
{
  "event": "majors-for-review",
  "majors": [
    {
      "key": "acme/some-service#412",
      "url": "https://github.com/acme/some-service/pull/412",
      "title": "chore(deps): update dependency foo to v6 (major)"
    }
  ]
}
```

1. **Ask on the board** — one question listing each major PR with its link, so the user can review
   and merge (or close) it by hand (see "The board"; `--stalls none`, since the rest of the queue
   keeps draining). This is a question, not a silent event.
2. **Mark each major notified** in the state file (stop the monitor first, see "State file" — "Stop
   before writing"), so the monitor reports it **once** and then leaves it alone (reclassifies as
   `major-skip`) on the next run instead of re-escalating a PR you already know about. Do this **after**
   the board item is posted — at-least-once delivery means a duplicate item
   (if you mark, then the next run re-finds it) is harmless, but
   marking before posting risks a major that's marked-done yet never
   surfaced:

   ```bash
   STATE_FILE="<path from the [monitor] state= line>"
   for key in "acme/some-service#412"; do   # one per .majors[].key
     jq --arg k "$key" '.prs[$k] = ((.prs[$k] // {}) + {majorNotified: true})' \
       "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
   done
   ```

3. **Do not** merge, rebase, or touch the PR branch — majors are the user's call.
4. **Restart the monitor.** The remaining queue keeps draining; the marked
   majors won't re-escalate.

If the user later decides to take a major, they merge it themselves (or tell you
to). To make the monitor surface a major again, delete its `majorNotified` flag
(or its whole state entry) — stop the monitor first, see "State file" — "Stop before writing".

### `event = "all-done"`

The monitor finished processing every actionable PR in this session and the
current tick settled with nothing pending. The `summary` object enumerates
every routine action taken across the whole session, plus any PRs currently
**held** — a human PR open in their repo, an agent escalation still waiting on
you or a teammate, or a PR the board was told to leave alone:

```json
{
  "event": "all-done",
  "summary": {
    "merged":       ["acme/some-service#412", "myuser/some-repo#88"],
    "rebased":      ["acme/another#21"],
    "ciRetried":    [],
    "held":         ["acme/some-service#420"],
    "totalActions": 3
  }
}
```

`held` lists PRs the monitor is deliberately not touching this settling tick, for any of three
reasons: a human-PR merge hold (see "Holding merges while a human PR is open"), a PR still
`agent-busy` (escalated and waiting on you or a teammate — see "Fixing a PR — you diagnose, a
teammate implements"), or a PR classified `left-alone` because the board answer was to leave it
(see "The board" — "On the answer"). The array doesn't say which reason applies to which key —
check the PR's own state/board-item record if it's not obvious. `held` is **not** counted in
`totalActions` (a hold is a non-action) and it reflects what's held *right now*, not a session-long
history.

1. **Retitle the node** with a summary of what shipped (see "The board" — "Informing"). Skip empty
   categories. If `held` is non-empty, include a count, e.g. `renovate: merged 3 ·
   holding 2`, so the user can see something's on hold. Held PRs need no action: a human-PR hold
   drains once that PR merges or closes, an agent-busy hold drains once the fix lands or the 2h
   timeout passes, and a `left-alone` PR stays held until the board is told otherwise.
2. **Post the summary as an info note** (`skills/board/references/dashboard-protocol.md` §8). Write
   the prompt to a temp file, never a shell string (see "The board"). The first line is the lede,
   `renovate: done · merged N · rebased N · CI retried N · holding N`, skipping empty categories.
   Below it goes one line per non-empty category, listing its PR keys, e.g.
   `merged: acme/some-service#412, myuser/some-repo#88`. The whole prompt is capped at 1500
   characters: if a list would overflow, end it with `+N more`. Post it keyless, so it lands on this
   session's node:

   ```bash
   dashboard item add --type info --prompt "$(cat "<tmpfile>")"
   rm -f "<tmpfile>"
   ```

   A note is not a wait. Don't record its id and don't wait for it. Go straight to the restart.
3. **Restart the monitor** in the background with `timeout=2147483647`. The new session starts with empty
   accumulators.

No code changes, no worktree, no state-file edits.

Note: holds never trigger `all-done` on their own — they ride whatever summary
the next stop produces. A session whose *only* activity is holding (nothing
merged/rebased/retried) stays silent until something else happens, by design.

### `event = "unknown"`

Mostly a defensive bucket — the monitor saw a state it wasn't built to resolve
(unexpected `gh` failure, a new `mergeStateStatus` GitHub introduced, a merge
that failed for a reason it couldn't classify, etc.). `context.rawState` has
whatever signal the classifier had. When `gh` refuses a CI retry, `rawState`
is `gh`'s own error text, prefixed `CI retry failed:`.

One case here is deliberate, not defensive: a `blocked-stuck` PR also emits through this bucket,
with `rawState` prefixed `blocked:` followed by the PR's `reviewDecision`. `blocked:
CHANGES_REQUESTED` means a reviewer requested changes; any other suffix — `APPROVED`,
`REVIEW_REQUIRED`, or empty when `gh` reports no decision — means the PR instead sat `BLOCKED` past
`BLOCKED_ESCALATE_SECONDS` (2h) on the same head (see the classification cheat sheet); the fixture
`blocked-at-threshold-escalates` emits `blocked: APPROVED`. The classifier knows exactly what it's
looking at there; it still needs your judgment on what to do about it.

1. **Do not take automated code action.** For the defensive cases, the classifier doesn't know what
   it's looking at; the deliberate `blocked-stuck` case above is the one exception, and needs your
   judgment for a different reason.
2. Post a board question with the PR link and `context.rawState` (see "The board" — "Asking").
3. Leave `agentBusy` set.
4. Restart the monitor. On the answer, see "The board" — "On the answer".

---

## Mechanical fixes

Reusable, repo-agnostic remediation recipes accumulate here over time. When you
fix a `ci-failed` escalation and the fix generalizes, add it as a short entry:
the symptom (failing job + error signature) and the mechanical fix. Keep each
entry generic — anything truly repo-specific belongs in that repo's `CLAUDE.md`,
not here.

### Duplicate copies of a package after a peer-only bump

- **Detected by:** typecheck failing with `Two different types with this name
  exist, but they are unrelated` (TS2322/TS2345), on a PR whose only changed
  file is the lockfile.
- **Fix:** the bumped package requires a newer version of a sibling than the
  manifest pins, so the resolver keeps the old copy for the app and installs a
  second nested copy for the bumped package. Raise the sibling's pin in the
  manifest to the required range, regenerate the lock, and confirm the lock
  holds exactly one entry for it. Then run the repo's full check script — a
  major-ish sibling bump often has its own API changes hiding behind the
  duplicate-type errors, and those are yours to migrate too.
- **Safe because:** it removes a duplicate rather than changing behavior; the
  single surviving version is the one the bumped package already demanded.
- **When migrating an API the bump changed:** derive the replacement from the
  library's own internals (read how the package builds that value itself)
  instead of inventing values, so rendered output and semantics stay identical.
  Watch for test doubles that encoded the old behavior — a library switching
  from `x = v` to `x ??= v` silently breaks any fake that pre-initializes `x`.

### Stale PR whose CI run is too old to rerun

- **Detected by:** `unknown` event whose `context.rawState` reads
  `CI retry failed: gh run rerun <id> failed: run <id> cannot be rerun;
  Unable to retry this workflow run because it was created over a month ago`
  (the monitor's `[routine_ci_retry]` log line carries the same `gh run rerun` text).
  Confirming signs: `gh run view "<id>" --log-failed` returns **HTTP 410**
  (logs expired) and the PR's `updatedAt` is months old.
- **Fix:** don't diagnose — there is nothing to read. Force **Renovate** to
  refresh the branch, which produces a new head SHA, a fresh CI run, and
  readable logs. Prefer Renovate's own controls over `gh pr update-branch` so
  the bot stays the owner of its branch:
  1. **Regular update PR** → check the rebase box in the PR body
     (`- [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check
     this box`) via `gh pr edit --body`.
  2. **Onboarding PR** (`chore: Configure Renovate`) → it has **no** rebase
     checkbox. Use Renovate's `rebaseLabel` instead — add the `rebase` label
     (create it first if the repo lacks it):
     ```bash
     gh label create rebase --repo "<owner>/<repo>" \
       --description "Renovate: force rebase of this PR on next run" --color 0e8a16
     gh pr edit "<n>" --repo "<owner>/<repo>" --add-label rebase
     ```
  Then **leave `agentBusy` set** and restart the monitor. Clearing it makes the
  monitor re-classify before Renovate has rebased and re-emit the same `unknown`
  every tick, stalling the queue. The 2h timeout expires after Renovate's next
  run, and the PR re-enters as `ci-pending` on the new SHA.
- **Safe because:** it changes no code — only a label/checkbox that asks
  Renovate to regenerate its own branch. If CI still fails on the fresh run,
  the normal `ci-failed` path takes over with logs you can actually read.
- **Expect repeats:** long-neglected repos have many months-old Renovate PRs, so
  this recipe fires across a scope in batches, not once.

### Stale npm lockfile after a version bump

- **Detected by:** `npm ci` failing in the `build`/`pr` job with `npm error
  Invalid: lock file's <pkg>@<old> does not satisfy <pkg>@<new>` — the
  `renovate/artifacts` check is also red, confirming Renovate itself couldn't
  regenerate the lockfile for this bump. Read Renovate's "Artifact update
  problem" PR comment for the reason; `npm error code EALLOWREMOTE` /
  `Refusing to fetch "<registry tarball URL>"` is one seen signature, and it
  fires per-tarball — the same repo's other Renovate PRs can update their
  lockfiles fine on the same day, so a green sibling PR is not evidence this
  one will recover.
- **Don't reach for the rebase checkbox first.** Renovate's comment invites a
  rebase/retry, but that only re-runs the same artifact step in the same
  sandbox: an `EALLOWREMOTE` retry reproduced the identical error verbatim.
  One retry is cheap enough to be worth a try; a second is not — if the retry
  fails the same way, fix the lockfile yourself. The PR's changed-file list is
  the tell: `package.json` alone (no `package-lock.json`) means the artifact
  step never produced anything.
- **Fix:** in a worktree off the PR's `headBranch`, run `npm install` (not
  `npm ci`) to regenerate `package-lock.json` against the already-bumped
  `package.json`, verify with a fresh `npm ci`, commit only the lockfile with
  `fix: regenerate lockfile for <dep> <version> bump`, push onto the branch.
  `npm install --package-lock-only` does the same without installing, which is
  faster; either way, read the resulting diff — entries nested under
  `node_modules/<bumped-pkg>/node_modules/` moving is the bump's own tree, not
  unrelated drift.
- **Renovate's red `renovate/artifacts` status does not follow your push.** It
  is a commit status bound to the SHA it was posted against, so the new head
  carries only the repo's own checks and the PR unblocks once they pass.
- **Safe because:** it only re-derives the lock from the manifest Renovate
  already wrote; no version pins change.
- **Expect repeats:** a grouped/monorepo bump (e.g. `aws-cdk-lib` bumped via a
  shared `renovate/aws-cdk-monorepo` branch name) opens the identical PR
  independently in every repo that depends on it, so this recipe fires once
  per repo, not once per bump.
- **Caution:** if you later use the rebase-checkbox recipe above on this same
  PR, Renovate force-pushes a fresh branch from `main` and silently drops this
  manual lockfile commit (it isn't a Renovate commit, so Renovate doesn't
  preserve it) — the exact same `npm ci` failure comes back on the new SHA.
  Prefer re-applying this recipe directly on the new head instead of
  rebase-checkbox-ing a PR you've already lockfile-fixed.

### Red `renovate/artifacts` that means the bump is genuinely incompatible

- **Read the artifact error before assuming the recipe above applies.** A red
  `renovate/artifacts` plus a `package.json`-only diff has two completely
  different causes, and they take opposite remediations:
  - `EALLOWREMOTE` / `Refusing to fetch <tarball>` → Renovate's sandbox
    couldn't download a package it was otherwise happy with. The lockfile is
    merely missing. **Regenerate it** (recipe above).
  - `ERESOLVE unable to resolve dependency tree` → npm refused because the new
    version's peer range conflicts with something the repo already pins. The
    lockfile is missing *because the bump is unmergeable*. **Do not
    regenerate.**
- **Detected by:** the artifact comment naming the conflict explicitly, e.g.
  `Found: prettier@3.9.6` / `Could not resolve dependency: peer
  prettier@"^2.0.0" from pretty-quick@3.3.1`.
- **Fix:** close the PR and take the next major instead, where the peer range
  was widened again. Renovate's dependency dashboard usually already lists that
  major under a rate-limited section — tick its
  `<!-- unlimit-branch=renovate/<dep>-<major>.x -->` checkbox plus
  `<!-- manual job -->` to make it open the PR now. Leave a PR comment quoting
  the ERESOLVE output so the close is self-explaining.
- **Never** reach for `--force` or `--legacy-peer-deps` to make the lockfile
  generate. That buries a real incompatibility in the lockfile and the failure
  resurfaces at runtime instead of at install time.
- **A minor version can do this.** A tightened peer range is a compatibility
  regression that arrives looking like a routine patch/minor — judge by the
  peer range, not the version delta.
- **Expect repeats:** the same dependency pair recurs across every repo on the
  same toolchain, so this fires once per repo. Once the first one is decided,
  the rest follow the same call rather than being re-escalated.
- **Two ERESOLVE shapes — check which one you have before promising a fix:**
  - *The bumped package tightened its own peer range.* A newer major has
    usually widened it again; take that instead (the `unlimit-branch` recipe
    above).
  - *A third-party consumer pins the old range.* The bumped package is fine;
    something else in the tree peers `^<old>` and has never moved. Check
    **every** published version of that consumer, prereleases included, before
    concluding — if even the newest build still pins the old range, there is no
    successor to take and the bump stays closed until upstream moves. Say so
    explicitly in the close comment; "take the next major" is wrong advice here
    and will send the next reader looking for a version that does not exist.
- **This one comes back.** Closing skips that exact version only, so the next
  patch on the blocked line opens a fresh PR with the identical failure. That is
  expected, not a regression — re-close it against the same reasoning rather
  than re-diagnosing from scratch.

### CI keeps failing after a fix even though the underlying cause is fixed

- **Detected by:** `ci-failed` persists (fresh `ciRetries`, fresh escalation)
  referencing an error you already fixed elsewhere — e.g. a shared reusable
  workflow (`uses: org/infra-workflows/.github/workflows/x.yaml@main`) whose
  bug you patched and merged to its `main`, but the PR's job step still prints
  the *old* `run:` content verbatim in the logs.
- **Fix:** a GitHub Actions **rerun** (`gh run rerun --failed`, or the
  monitor's own mechanical CI retry) replays the reusable-workflow snapshot
  that was resolved when the run was *first* triggered — it does not
  re-resolve `@main` to what's on it now. Only a genuinely new run (new head
  SHA) re-resolves the ref. Force one with the rebase-checkbox recipe above
  (or `gh pr update-branch` if the PR is actually behind `main`).
- **Safe because:** it changes no code in the consuming repo — only forces a
  fresh trigger so the already-merged fix in the reusable workflow actually
  gets picked up.
- **Expect repeats:** every open PR across the org that calls the same
  reusable workflow hit the pre-fix snapshot and needs the same nudge, not
  just the one that first surfaced it.

Template for new entries:

```
### <short symptom name>
- **Detected by:** <failing job(s) + the error string to grep for>
- **Fix:** <the exact mechanical steps>
- **Safe because:** <why this never changes behavior>
```

---

## Restarting the monitor

**Restarting always means stopping it first if it's still running, then starting it.** The loop
takes a session-scoped lock before its first tick and holds it, heartbeating, until it exits, so
relaunching on top of one that's still up refuses to start a second loop rather than running two at
once. `--once` diagnostics never take this lock, so a one-off tick is safe to run beside a live
loop.

Keep the task id this restart returns — it replaces whichever one you were holding, and the next
stop-before-write (see "State file" — "Stop before writing") uses this newer one.

Every event handler ends with restarting the monitor so the remaining queue
keeps draining:

```
Bash(
  command="renovate-pr-monitor",
  run_in_background=true,
  timeout=2147483647
)
```

If you're handling several events in one session, wait until all are resolved
before restarting — the monitor would immediately re-exit on the next
unresolved one otherwise.

## Dead-monitor wake

If the loop is killed, crashes, or is lost to a session restart without exiting cleanly, it cannot
emit its own event — instead the wake mod's check notices the abandoned loop lock and wakes the session
with a line:

```
[renovate-pr-monitor] dead-monitor — the monitor loop (pid <pid>) exited without emitting an event;
last heartbeat <heartbeatAt>. No further event can arrive. Restart it: renovate-pr-monitor
```

This is not a monitor event — no PR classification changed, it's news that the observer itself died.
Restart the monitor as usual (see "Restarting the monitor"); that restart is this event's handling.

## Notifications

The script itself never notifies. It only emits the event, and the session turns it into board
activity (see "The board"):

- **Silent** — routine merge, clean rebase, flaky-CI retry, mechanical rebase-conflict or
  lockfile-regen resolution.
- **Retitle, no item** — the agent modified code (`ci-failed` with a real fix). Nothing is being
  decided.
- **Retitle and info note** — the `all-done` session summary.
- **Board question** — the autonomy-rail STOP, the implementer reporting its plan didn't work, both
  rebase-conflict STOPs (the initial STOP and the resolution reported as not applying cleanly), an
  `unknown` escalation, and `majors-for-review`.

## State file

Location (default): a path inside the session's own store, so concurrent sessions keep separate PR
state. The monitor prints the exact path on its `[monitor] state=` startup line — read it from there
before running any hand-edit snippet below. Override with `RENOVATE_MONITOR_STATE_FILE` for an
absolute path.

Shape:

```jsonc
{
  "prs": {
    "acme/some-service#412": {
      "headSha": "abc123",
      "ciRetries": 1,
      "agentBusy": false,
      "agentStartedAt": null,
      "majorNotified": false,  // set true after a majors-for-review notify
      "lastSeenAt": "2026-06-08T15:00:00Z",
      "blockedSince": null  // set when BLOCKED starts on this head; cleared once a tick classifies the PR as anything but blocked/blocked-stuck (a head change also clears it), so a later BLOCKED tick on the same head starts a fresh timer
    }
  },
  "boardItems": {
    "acme/some-service#412": {
      "item": "<item-id>",
      "outcome": "dispatch"  // "dispatch" | "leave", absent until the answer is acted on
    }
  }
}
```

The monitor owns this file — safe to hand-edit while the loop is stopped, unsafe
while it's running.

### Stop before writing

`tick` rewrites the whole file through the shared `$STATE_FILE.tmp` on every PR it processes, so a
write made anywhere in this runbook can be lost if the monitor is still running underneath it. Every
recipe below assumes this order:

1. **Stop it, if it's still running** — `TaskStop` on the task id from the most recent start or
   restart (see "Starting the monitor", "Restarting the monitor"). The loop lock's recorded pid is
   for dead-monitor detection only, not a stop handle; that task id is the only way to stop it, so
   don't invent another one.
2. **Write.**
3. **Restart** (see "Restarting the monitor").

### Clearing `agentBusy` after remediation

```bash
STATE_FILE="<path from the [monitor] state= line>"
jq --arg k "<owner>/<repo>#<number>" \
  '.prs[$k].agentBusy = false | .prs[$k].agentStartedAt = null' \
  "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
```

The 2h `agentBusy` timeout recovers from crashed sessions automatically, so
clearing is technically optional — but doing it shortens the next poll's blind
spot.

### Recording a PR's board item

With a board, right after posting a stop question (see "The board" — "Asking"), record its id against
the PR key (with no board there is no id and nothing to record here):

```bash
STATE_FILE="<path from the [monitor] state= line>"
jq --arg k "<owner>/<repo>#<number>" --arg id "<item-id>" \
  '.boardItems[$k] = {"item": $id}' \
  "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
```

When the answer is acted on (see "The board" — "On the answer"), merge in what happened —
`"dispatch"` for a go-ahead, `"leave"` when the user keeps the PR:

```bash
STATE_FILE="<path from the [monitor] state= line>"
jq --arg k "<owner>/<repo>#<number>" --arg outcome "<dispatch|leave>" \
  '.boardItems[$k].outcome = $outcome' \
  "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
```

On a re-emit, read the record back before deciding whether to post:

```bash
STATE_FILE="<path from the [monitor] state= line>"
jq --arg k "<owner>/<repo>#<number>" '.boardItems[$k] // empty' "$STATE_FILE"
```

`boardItems` is never pruned — entries for merged or closed PRs are left behind — but every key is
PR-unique, so a stale one is dead weight, not a wrong answer.

### Resetting the state entirely

```bash
rm "<path from the [monitor] state= line>"
```

The monitor recreates it on next start and resets all retry counters.

## Classification cheat sheet

The script classifies each open Renovate PR into exactly one bucket each tick.
From most-specific to least:

| Classification | Trigger | Handler |
|---|---|---|
| `left-alone` | the board answer for this PR was to leave it (`boardItems[key].outcome = "leave"`) | skip; listed in `held` |
| `agent-busy` | an agent marker is set within 2h | skip; listed in `held` |
| `major` | a major version bump (title/branch/body signal) | escalate via `majors-for-review` (never merged) |
| `major-skip` | a major already reported (`majorNotified`) | skip (no-op) |
| `rebase-conflict` | `mergeStateStatus = DIRTY` | emit |
| `needs-rebase` | `mergeStateStatus = BEHIND` | `gh pr update-branch` |
| `skip` | `mergeStateStatus = UNKNOWN` | skip (GitHub still computing) |
| `ci-pending` | any check not yet COMPLETED | skip |
| `ci-failed` | a completed check failed/cancelled/timed-out | retry or emit |
| `needs-approval` | `BLOCKED` + `reviewDecision = REVIEW_REQUIRED` + `mergeable = MERGEABLE` + green | approve + merge (same tick) † |
| `mergeable` | `CLEAN`/`HAS_HOOKS` + green | approve + merge (same tick) † |
| `blocked` | `BLOCKED` for any other reason (required checks, protection rules, still waiting on review) | skip; tracks how long via `blockedSince` (resets if a tick in between classifies the PR as anything but blocked/blocked-stuck) |
| `blocked-stuck` | `BLOCKED` + `reviewDecision = CHANGES_REQUESTED`, or `blocked` past `BLOCKED_ESCALATE_SECONDS` (2h) on the same head | emit (as `unknown`) |
| `unknown` | anything else | emit |

† **Held if the hold is enabled and a human PR is open in the repo.** Only when
`RENOVATE_MONITOR_HOLD_FOR_HUMAN_PRS=1` (opt-in, off by default): before approving
or merging a `needs-approval`/`mergeable` PR, the monitor checks for an open
non-draft human-authored PR in the same repo (see "Holding merges while a human PR
is open"). If one exists — and the current time is outside any
`RENOVATE_MONITOR_HOLD_RELAX_HOURS` quiet window — it logs `merge held` and takes
no action (a quiet no-op, not an escalation). The check runs before the approve
specifically so a Renovate `automerge: true` PR isn't merged by GitHub's native
auto-merge the instant we approve.

The monitor takes at most one state-changing action per PR per tick. A rebase at
tick N shows up as `ci-pending` at tick N+1 while CI re-runs, then
`needs-approval`/`mergeable` at tick N+2 once CI lands green.

At the **session** level: once the session has produced work AND a tick settles
with no actions and nothing pending, it emits `all-done` with a summary and
exits. A session that never finds work does not emit `all-done` — it keeps
polling silently. A held PR (`agent-busy`, `left-alone`, or a human-PR merge
hold) never counts as pending, so `all-done` fires even while PRs stay held
(see the `all-done` summary below). Anything that keeps the tick from having
fully seen the scope counts as pending instead: a search that came back
**incomplete** (a scope failed or hit its cap, but still returned parseable
PRs), a search that **failed outright** (every scope's stdout was
unparseable, so the tick skips without a PR list at all), and a single PR
whose `gh pr view` failed and was skipped rather than classified. `all-done`
never fires on a tick carrying any of these, even if every PR it did
classify is settled.

Unlike the GraphQL schema monitor, there is **no `(N issues)` gate** — a green,
mergeable, non-major Renovate PR is auto-merged on sight (approve first, then
merge). Consecutive merges are spaced out by `RENOVATE_MONITOR_MERGE_DELAY_SECONDS`
(default 120s) so a backlog drain doesn't burst-trigger deploys. Archived repos,
repos in `RENOVATE_MONITOR_EXCLUDE`, and major version bumps are never merged.
