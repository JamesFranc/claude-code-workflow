# Background Watchers — Starting Them So They Stay Up

A **long-running watcher** is a command the workflow starts in the background and expects to keep
running until its own condition fires: `gh pr checks … --watch` and
`renovate-pr-monitor`. `pr-monitor` is not one: it registers the PR and returns at once, and the
wake mod's check polls it. Builds, test runs and other commands that finish on their own are not
watchers, and nothing here applies to them.

PR changes reach the session through the wake mod, as board answers do, and the mod runs only in
an interactive session while it is idle. A non-interactive session (`-p`, the Agent SDK, CI, cloud)
gets no `[pr-monitor]` entry.

## Start every watcher with the longest timeout

Start a watcher with the Bash tool using `run_in_background: true` **and** `timeout: 2147483647`,
in every session. The time limit below does not apply in every session, and passing the `timeout`
costs nothing where it does not.

Since Claude Code v2.1.288, the limit applies only to non-interactive sessions, such as `-p`, the
Agent SDK, CI and cloud runs. Interactive terminal, desktop-app and VS Code sessions have no
background time limit. In v2.1.285 through v2.1.287 it applied in every session.

Where it applies, Claude Code stops a background command when its time limit runs out. The limit is
the `timeout` passed with `run_in_background` or, without one, 30 minutes (or
`BASH_DEFAULT_TIMEOUT_MS`, if that is set higher). Either way it is capped at a ceiling: 2 hours, or
`BASH_MAX_TIMEOUT_MS` or `BASH_DEFAULT_TIMEOUT_MS` if either is set higher, and never above
`2147483647` ms. A larger value is cut down to the ceiling, not refused. So a watcher started
without a `timeout` usually stops after 30 minutes, and passing `2147483647` always asks for the
longest limit the user's settings allow, whatever that limit is.

## Raising the ceiling

Where the limit applies, unless `BASH_MAX_TIMEOUT_MS` or `BASH_DEFAULT_TIMEOUT_MS` is set higher,
that ceiling is 2 hours, and a watcher still stops every 2 hours. To raise it, set
`BASH_MAX_TIMEOUT_MS` in the `env` block of the user's Claude Code `settings.json`, in milliseconds:
`"86400000"` is one day. Do not raise `BASH_DEFAULT_TIMEOUT_MS` for this, because it also lengthens
every ordinary command's timeout. No setting turns the limit off.

## When the limit stops a watcher

A watcher stopped at its limit ends with the notice `stopped after reaching its background time
limit`. The notice's own advice, not to restart a command that already had the longest `timeout`
allowed, does not apply to a watcher. The watcher was doing its job, not failing at it. Restart it
the same way it was started, with `timeout: 2147483647`. The restarted one resumes from whatever
state the stopped one persisted, and nothing more.
