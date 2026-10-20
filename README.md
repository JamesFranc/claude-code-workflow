# Claude Code Workflow

A Claude Code plugin that runs software work as a workflow: it shapes a request into a design, plans
it, dispatches a team of implementer and reviewer agents, opens the pull request, answers review
feedback, and cleans up after the merge. It ships as skills, hooks, agents, slash commands, and the
TypeScript CLI tools those use.

This repository is a published snapshot. Development happens elsewhere, and each release lands here
as a single commit. It does not take issues or pull requests.

## Requirements

Everything below is needed for a run with no optional integration configured:

- **Claude Code 2.1.290 or newer.**
- **Agent teams turned on.** Set `"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"` in the `env` block
  of `~/.claude/settings.json`.
- **tmux or iTerm2.** Each teammate runs in its own pane. Team dispatch stops rather than run a
  team you can't see.
- **Node.js 22.22.2 or a later 22.x, 24.15 or a later 24.x, or 26 or newer**, on `PATH`. The CLI tools run as `node --experimental-transform-types`, and their dependencies support only those versions.
- **npm.** The plugin installs its CLI dependencies with it on first use.
- **git** and the **GitHub CLI (`gh`)**, signed in. The pull request steps use `gh`.
- **jq.** The hooks use it to read their input.
- **Python 3** (`python3`). The command-guard hooks use it to parse shell commands, and without it they let every command through. `bin/claude-sessions` is a Python script.
- **ffmpeg** on `PATH`, and network access the first time a walkthrough video renders. Each architecture doc gets a walkthrough video, rendered with HyperFrames: `npx` fetches it, and it uses an installed Chrome or downloads one.

## Installation

### 1. Add the marketplace

```bash
claude plugin marketplace add https://github.com/denormans/claude-code-workflow.git
```

### 2. Install the plugin

```bash
claude plugin install workflow@denormans-workflow
```

### 3. Restart Claude Code

The plugin takes effect on the next session.

## Updating

```bash
claude plugin update workflow@denormans-workflow
```

Restart Claude Code after updating.

## Optional integrations

None of these is required. Each one changes what the workflow does when it is present:

| Integration | When it's configured | Without it |
|---|---|---|
| Jira (an Atlassian MCP server, plus any `JIRA_*` or `ATLASSIAN_*` variable) | Work is tracked on a ticket, and branches are named after it | No ticket; branches are named from a short description |
| Notion (a Notion MCP server, plus `NOTION_PAGE_URL`) | Design docs are published to Notion | Design docs stay as local files |
| ElevenLabs (`ELEVEN_LABS_API_KEY`) | Each architecture doc's walkthrough video is narrated | A macOS voice narrates when set, else the video is silent, with the narration as subtitles |
| Kokoro (`WALKTHROUGH_VOICE=kokoro`, needs `uv`) | Each architecture doc's walkthrough video is narrated locally, and takes precedence over ElevenLabs and a macOS voice | ElevenLabs narrates when configured, else a macOS voice, else the video is silent, with the narration as subtitles |
| A macOS voice (`WALKTHROUGH_MAC_VOICE`) | The walkthrough video is narrated by that voice, when neither Kokoro nor ElevenLabs is configured | With `ELEVEN_LABS_API_KEY` also unset, the video is silent, with the narration as subtitles |
| The board (`ai-workflow-app`) | Questions and approvals go to the board | The workflow asks in the terminal |
| CodeRabbit | Its review is part of the pull request loop | Only the agent review runs |

The board is a separate application and is not published. Every variable the plugin reads is listed
under [Environment variables](#environment-variables) below.

## Environment variables

Set these in the `env` block of a Claude Code settings file: your project's
`.claude/settings.local.json` for a setting that belongs to one project, or `~/.claude/settings.json`
for every project. Only `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is required. Leave the others unset
unless you want what they do.

### Claude Code

These are Claude Code's own settings. The workflow depends on what they do.

| Variable | What it does |
|---|---|
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | Set to `1` to turn on agent teams. Required. |
| `BASH_MAX_TIMEOUT_MS` | Controls the ceiling on how long Claude Code lets a command run when Claude asks for longer than the default. For a foreground command the ceiling is the larger of this and `BASH_DEFAULT_TIMEOUT_MS`, and 10 minutes out of the box, so a value under 10 minutes can lower it. In a session that limits background commands, a value above 2 hours raises their 2-hour maximum, and a lower value leaves that maximum in place. See [Long-running sessions](#long-running-sessions). |
| `BASH_DEFAULT_TIMEOUT_MS` | Claude Code's timeout for a foreground command started without one: 2 minutes out of the box. The foreground ceiling is the larger of this and `BASH_MAX_TIMEOUT_MS`, so a value above 10 minutes can raise that ceiling too. In a session that limits background commands, it also replaces their default when set higher than it: 30 minutes, or 10 minutes in a `-p` run whose prompt is passed as text. Set above 2 hours, it raises the background maximum too. Prefer `BASH_MAX_TIMEOUT_MS` for long-running sessions. Claude Code's [tools reference](https://code.claude.com/docs/en/tools-reference) has the details. |
| `CLAUDE_CONFIG_DIR` | Claude Code's configuration directory. Default: `~/.claude`. The plugin reads team state from the same directory, so set it only if you have moved Claude Code's. |

### Integrations

| Variable | What it does |
|---|---|
| `JIRA_*`, `ATLASSIAN_*` | Any variable whose name starts with either prefix and whose value is not blank turns Jira on. What the value says doesn't matter. Unset: no tickets. |
| `NOTION_PAGE_URL` | The Notion page design docs are published under. Unset: design docs stay as local files. |
| `ELEVEN_LABS_API_KEY` | ElevenLabs API key used to narrate an architecture doc's walkthrough video. Unset: a macOS voice narrates it if `WALKTHROUGH_MAC_VOICE` is set; otherwise the video is silent, with the narration as subtitles. |
| `ELEVEN_LABS_VOICE_ID` | The ElevenLabs voice for that narration. Default: the voice the CLI pins. |
| `WALKTHROUGH_VOICE` | `kokoro` narrates walkthrough videos locally with Kokoro through `uv`, ahead of ElevenLabs and a macOS voice. Any other non-empty value fails the render. Unset: ElevenLabs when its key is set, else a macOS voice when `WALKTHROUGH_MAC_VOICE` is set, else silent. |
| `KOKORO_VOICE` | The Kokoro voice for that narration. It must be an American or British English voice (prefix `a` or `b`). Default: `af_heart`. |
| `WALKTHROUGH_MAC_VOICE` | A macOS voice, named as `say -v '?'` lists it, that narrates the walkthrough video when `ELEVEN_LABS_API_KEY` is unset and Kokoro is not selected. Unset (and `ELEVEN_LABS_API_KEY` unset too): the video is silent, with the narration as subtitles. Premium voices (System Settings → Accessibility → Read & Speak → System voice → Manage Voices…; Spoken Content before macOS 26) sound far better than the built-in ones. |
| `AI_WORKFLOW_APP_BIN` | Path to the board's `ai-workflow-app` binary. Default: `ai-workflow-app` found on `PATH`. If the path you give does not exist, the board is treated as absent; `PATH` is not searched instead. |
| `PERMISSION_HOLD_DEADLINE_S` | When a tool call needs permission, the prompt is also posted to the board, and whichever answer comes first wins. This is how many seconds the board side waits. Default: `570`. A value that is not a whole number below `600` uses the default. |
| `PERMISSION_POLL_INTERVAL_S` | Seconds between checks for the board's answer to that prompt. Default: `3`. |

### Test lock

Agents run their tests through `test-lock` (`bin/test-lock`), so that one user's agents on a machine
take turns running tests. It reads these:

| Variable | What it does |
|---|---|
| `TEST_LOCK_ROOT` | The directory the lock is kept under, in a subdirectory private to you. Default: `/tmp`. |
| `TEST_LOCK_BEAT_SECONDS` | Seconds between the heartbeats it sends the board for the agent's session (and a teammate's lead's) while its tests wait or run. Default: `300`. |
| `TEST_LOCK_DASHBOARD` | The `dashboard` command it sends those heartbeats with. Default: the plugin's own `bin/dashboard`. |
| `TEST_LOCK_HELD` | `test-lock` sets it to `1` for the command it runs, so a `test-lock` inside that command does not wait on itself. Any non-empty value, even one that is only spaces, skips the lock, so leave it unset. |

### Renovate monitor

The Renovate monitor (the `renovate-prs` skill) merges Renovate's dependency-update pull requests once
their CI passes. Major version bumps are never merged; it reports them to you instead. It reads these, and only `RENOVATE_MONITOR_SCOPE` is required to run it. The full
behaviour is in `skills/renovate-prs/references/monitor-runbook.md`.

| Variable | What it does |
|---|---|
| `RENOVATE_MONITOR_SCOPE` | Which repositories to watch: a space- or comma-separated list of `owner/*` or `owner/repo`. Required; the monitor stops with an error without it. |
| `RENOVATE_MONITOR_EXCLUDE` | Repositories inside the scope to skip, in the same list form; `owner/prefix-*` also works. Default: none. |
| `RENOVATE_MONITOR_AUTHOR` | The pull request author to watch. Default: `app/renovate`. |
| `RENOVATE_MONITOR_BOT_AUTHORS` | More logins to treat as bots, as a space- or comma-separated list. Bots are detected without it; this is a fallback. Default: none. |
| `RENOVATE_MONITOR_POLL_SECONDS` | Seconds between polls. Default: `900`. |
| `RENOVATE_MONITOR_MAX_CI_RETRIES` | How many times to retry CI that looks flaky before reporting the pull request to you. Default: `2`. |
| `RENOVATE_MONITOR_MERGE_DELAY_SECONDS` | Minimum seconds between two merges. Default: `120`; `0` turns the delay off. |
| `RENOVATE_MONITOR_HOLD_FOR_HUMAN_PRS` | Set to `1`, `true`, `yes` or `on` to hold merges in a repository while a person has an open, non-draft pull request there. Default: off. |
| `RENOVATE_MONITOR_HOLD_RELAX_HOURS` | Hours when that hold is lifted, as `START-END` on a 24-hour clock, e.g. `0-8`. Default: the hold always applies. |
| `RENOVATE_MONITOR_HOLD_RELAX_TZ` | Time zone for those hours, as an IANA name such as `America/Chicago`. Default: the machine's local time zone. |
| `RENOVATE_MONITOR_STATE_FILE` | Where the monitor keeps its state. Default: a file in the session's own store. |

### Working on the plugin

Only someone running the plugin's own test suite needs these.

| Variable | What it does |
|---|---|
| `TEST_CONCURRENCY` | How many test workers `pnpm test` runs at once. Default: a cap of at most 4, worked out from the machine's size. An explicit value is used as given. |
| `DASHBOARD_INVOKE_TIMEOUT_MS` | Milliseconds each call to the board binary may take. Default: `5000`; the test script sets `30000`. |
| `MAILBOX_CHECK_BUDGET_MS` | Replaces the session check's 100-second time budget. Used by tests only. |

## Long-running sessions

A hooks module in the plugin (`hooks/wake.ts`) wakes a waiting session: it checks the watched PRs
and the board every few minutes while the session is idle. The Renovate monitor and `gh pr checks
--watch` still run as background commands. In non-interactive sessions (and in every session in
v2.1.285 through v2.1.287), Claude Code stops a background command after at most 2 hours by default;
setting `BASH_MAX_TIMEOUT_MS` above 2 hours raises that ceiling. Set it in the `env` block of
`~/.claude/settings.json`, e.g. `"BASH_MAX_TIMEOUT_MS": "86400000"` for one day. Claude Code's
[tools reference](https://code.claude.com/docs/en/tools-reference#time-limit-for-background-commands)
has the details.

## Working from a clone

```bash
pnpm install
claude --plugin-dir /path/to/your/clone
```

`--plugin-dir` loads the plugin from your clone for that session only.

| Directory | Contents |
|-----------|----------|
| `skills/` | Markdown skill files |
| `hooks/` | Claude Code hooks |
| `agents/` | Agent definitions |
| `commands/` | Slash commands |
| `tools/` | TypeScript CLI tool packages (pnpm workspace) |
| `bin/` | Shell wrappers for CLI tools |
| `scripts/` | Standalone scripts too large to be a `bin/` wrapper (launched through one) |

`pnpm typecheck`, `pnpm lint` and `pnpm test` are the checks. `CLAUDE.md` has the conventions.

## License

Copyright (C) 2026 Michael D. Norman

This program is free software: you can redistribute it and/or modify it under the terms of the GNU
General Public License as published by the Free Software Foundation, either version 3 of the License,
or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even
the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General
Public License for more details.

The full licence text is in [`LICENSE`](LICENSE). Third-party material, and the licences of the
packages this project depends on, are listed in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
