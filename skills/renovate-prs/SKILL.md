---
name: renovate-prs
description: Use when the user mentions the Renovate PR monitor, Renovate dependency-update PRs, or auto-merging Renovate bot PRs — or when a background process exits with a JSON event containing `"event"` referencing a Renovate PR (per-PR escalations `ci-failed`, `rebase-conflict`, `unknown`; the `majors-for-review` event, which carries a `majors` array of major version bumps that are never auto-merged; and the session-summary event `all-done`, which carries a `summary` object instead of a `pr` object). Also use when the user asks to start, stop, or check on the renovate-pr-monitor. Triggers on phrases like "renovate prs", "renovate monitor", "renovate-pr-monitor", "renovate bot PRs", "dependency update PRs".
---

# Renovate PR Monitor

`renovate-pr-monitor` watches open Renovate PRs across a configurable set of orgs/repos (set via
`RENOVATE_MONITOR_SCOPE`) and auto-merges the safe ones (approve first, then merge). It is a
**generic** tool: it carries no repo- or org-specific knowledge, only performs mechanical git/gh
operations, and escalates anything that needs a code change.

The monitor runs as a background process and costs zero Claude tokens while idle. Claude
is only involved when the monitor exits with a JSON event on stdout. You handle remediation, then
restart the monitor.

**Everything you need is in the runbook, `references/monitor-runbook.md`.** Read it and follow it. It
covers:

- Configuration (`RENOVATE_MONITOR_SCOPE` and optional overrides)
- Starting the monitor (`Bash(... run_in_background=true, timeout=2147483647)`)
- Single-tick debug mode (`--once`, `--dry-run`, `--verbose`)
- Configuration including `RENOVATE_MONITOR_EXCLUDE` (repos to skip), `RENOVATE_MONITOR_MERGE_DELAY_SECONDS` (inter-merge spacing), `RENOVATE_MONITOR_HOLD_FOR_HUMAN_PRS` (opt-in, off by default — hold merges while a human PR is open in the repo; bots incl. `*[bot]` like release-please are auto-excluded), `RENOVATE_MONITOR_HOLD_RELAX_HOURS`/`_TZ` (quiet window that suspends that hold, e.g. `0-8` `America/Chicago`), and `RENOVATE_MONITOR_BOT_AUTHORS` (rare fallback list for bots run under a plain user account)
- The board: one node per monitor session, a board question at every stop, a node retitle for outcomes that decide nothing, and an info note for the `all-done` summary (invoke `workflow:board` for the protocol)
- The per-PR escalation events (`ci-failed`, `rebase-conflict`, `unknown`) and per-event remediation steps
- How code-changing fixes (`ci-failed`, `rebase-conflict`) are handled: you diagnose the failure and write the fix plan, then a spawned teammate subagent (`workflow:implementer`) implements that plan and pushes it onto the Renovate branch
- The `majors-for-review` event — major version bumps are never auto-merged; ask on the board, mark them notified, and restart
- The session-summary event `all-done` — fires when routine work settled cleanly; retitle the node with the summary, post the summary as an info note, and restart the monitor
- The growable **Mechanical fixes** section — add reusable repo-agnostic recipes there over time
- State-file conventions
- Restarting the monitor after handling an event

## When this skill fires

- User asks about Renovate PRs or the Renovate PR monitor by name.
- User wants to start or stop the monitor.
- A background process (typically `renovate-pr-monitor`) exits and the stdout contains a JSON
  line with an `"event"` key referencing a PR — parse the JSON, then follow the matching section of
  the runbook.
- User asks to look at the queue of Renovate PRs across their configured scope.

## What to do first

1. Read the runbook, `references/monitor-runbook.md`.
2. If a monitor event just fired, parse the JSON on stdout and jump to the matching event section.
3. If the user just asked to start the monitor, confirm `RENOVATE_MONITOR_SCOPE` is set, enter the
   board node (runbook, "The board"), then launch `renovate-pr-monitor` via `Bash` with
   `run_in_background=true` and `timeout=2147483647` (`skills/workflow-guide/references/background-watchers.md`), and idle until it exits.
4. Follow the runbook's remediation steps. Restart the monitor after any remediation.
