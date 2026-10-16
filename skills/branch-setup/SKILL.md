---
name: branch-setup
description: Set up a feature branch before making edits. Handles ticket detection, branch creation, multi-repo coordination, and syncing with origin/main. For local-only repos, merges to main when done.
---

# Branch Setup

Set up a properly-named feature branch before making code changes.

**Announce at start:** "I'm using the branch-setup skill to ensure we're on a proper feature branch."

## When This Runs

- Automatically triggered by pre-edit hook when on main/master
- Can be invoked manually with `/branch-setup`

## Process

### 1. Check Remote & Decide Approach

First, check if the repo has a remote:

```bash
git remote -v
```

**If no remote (local-only repo):**
- Skip fetch
- Create a feature branch in place (the hook requires it)
- Note: Will merge to main and delete branch when work is complete

**If remote exists:**
- Suggest using the **Git Worktrees** skill (`workflow:git-worktrees`) for isolation
- Worktrees keep main clean and allow parallel work
- If user prefers branching in place, continue with fetch:

```bash
git fetch origin
```

If fetch fails (network error), STOP and ask the user - something is wrong.

### 2. Detect Ticket

Scan the conversation for ticket patterns:
- `DEV-1234`, `PROJ-567`, etc.
- Pattern: `[A-Z]+-[0-9]+`

**If ticket found:** Use it automatically when Jira is configured. With no Jira the match is not a ticket (`skills/workflow-guide/references/routing.md` §Cross-Phase Rule: No Jira, No Ticket): the branch is named from the slug alone (§7 "Without ticket").

**If no ticket found:**
- If running as part of the workflow chain (JTBD → Architecture → Team Dispatch), when Jira is configured, create a ticket automatically — that's what the workflow does. With no Jira, create none: the branch is named from the slug alone (§7 "Without ticket").
- Otherwise, when Jira is configured, confirm with the user: "I'll create a Jira ticket for this, or is there an existing one?"

### 3. Determine New vs Existing Work

**Check conversation context:**
- "continue", "update the PR", "fix review comments", "address feedback" → existing work
- "implement", "add new", "create", "build" → new work

**Check for existing branches:**
```bash
git branch -a | grep -i "<ticket>"
```

With no ticket there is no name to search for: §7 "Without ticket" builds its slug fresh each
session, so a resumed session cannot rebuild an earlier one. List the branches that exist and pick
the one that is the work being resumed:

```bash
git branch -a --sort=-committerdate
```

When none can be identified for existing work, the matrix's "Existing work, no ticket" row applies:
stop and post a board question rather than create a second branch.

**Decision matrix:**

| Context | Branch Exists | Action |
|---------|--------------|--------|
| New work | No | Create fresh branch |
| New work | Yes | Ask: "Found existing branch. Continue that or start fresh?" |
| Existing work | Yes | Checkout and rebase |
| Existing work, ticketed | No | Create fresh branch (warn: "No existing branch found, creating new") |
| Existing work, no ticket | None identified | Stop and post a board question; never create a branch |

### 4. Branch Operations

**Create fresh branch (new work):** with no ticket, run the key check in `workflow:git-worktrees`
§2 Create first.
```bash
git checkout origin/main -b "<branch-name>"
```

**Checkout existing branch:** with no ticket, run the same key check first; if it prints a key, stop
and post a board question (`workflow:git-worktrees` §Naming).
```bash
git checkout "<branch-name>"
git rebase origin/main
```

If rebase has conflicts, resolve them automatically.

**If working directory is dirty:** Use the **Git Worktrees** skill (`workflow:git-worktrees`) to create an isolated workspace.

### 5. Install Dependencies (repos with remotes only)

After branch creation or checkout, install dependencies so local tooling matches what main expects.
`cd` to the repo root, then install dependencies per:
`skills/workflow-guide/references/install-dependencies.md`.

**Why:** Without this, local tooling (Prettier, ESLint, etc.) may be on older versions than main,
causing spurious formatting diffs that pollute the real changes.

### 6. Register Repo-Root Trust

```bash
workspace-trust ensure --repo "<repo-root>"
```

Claude Code's trust check stops at the repo root, so a trusted parent directory does not cover this
repo. Run the command from the directory Claude was launched in — not prefixed with `cd` — so its
launch-dir guard resolves correctly. Exit 0 means trusted (or already was) — nothing to do. Exit 1
means refused — read the command's own `reason` (stderr and JSON) for why and what to do; it is not
always a `cd` fix. Exit 2 means failed — the global config couldn't be read or the write couldn't be
verified; report it, it isn't a scope problem.

**Known limits, accepted rather than fixed — two distinct losses:**

- The command's own key can still be lost if a write lands after it has already exited and reported
  `trusted` — self-correcting on the next run, since nothing running at that point can cover it.
- A write landing inside the command's own read-then-write window used to be silently overwritten by
  its stale snapshot — undetectable by its verification, which only confirms its own key survived,
  never anyone else's data. The command now detects this before writing and retries onto fresh data,
  which narrows this window to the small gap right before the write — it does not close it.

**This step passes when the command exits 0, or when it is not installed. Any other outcome stops
progress — do not proceed past this step.**

### 7. Branch Naming

**With ticket:**
```
DEV-1234-short-description
```

**Without ticket:**
```
short-description-slug
```

Generate the description slug automatically:
- Lowercase
- Hyphenated
- 3-5 words max
- Example: "add user authentication" → `add-user-auth`

**No `<type>/` prefix.** A branch is never `feat/DEV-1234-…` or `fix/…`; worktree paths follow
`workflow:git-worktrees` §Naming.

## Multi-Repo Coordination

When work spans multiple repos, each repo that receives edits gets its own branch:

1. Use the same branch name across all repos
2. Set up each repo independently when first editing a file in it
3. Track which repos have been set up to avoid re-prompting

## Example Flow

```
User: "Implement the new auth flow for DEV-1234"

Claude: I'm using the branch-setup skill to ensure we're on a proper feature branch.

[Remote exists — suggested the Git Worktrees skill; user prefers branching in place]
[Fetching origin...]
[Detected ticket: DEV-1234]
[New work detected]
[Checked for existing branches: git branch -a | grep -i DEV-1234 — none found]
[Decision matrix: new work + no existing branch → create fresh]
[Created branch: DEV-1234-implement-auth-flow]
[pnpm-lock.yaml detected — running pnpm install]
[Registered repo-root trust]

Ready to start implementation.
```

## Completing Work

### Local-only repos (no remote)

When work is complete in a local-only repo:

```bash
git checkout main
git merge "<branch-name>"
git branch -d "<branch-name>"
```

This keeps history clean since there's no PR workflow for local repos.

Then install dependencies in the repo root, per:
`skills/workflow-guide/references/install-dependencies.md`. A local-only repo never runs the
`Install Dependencies` step above — that step is scoped to repos with remotes — and stories merge
into one main in sequence, so this checkout can inherit an earlier story's lockfile bump into a tree
that never installed it. Warn and carry on if it fails.

### Repos with remotes

Follow normal PR workflow - don't merge locally.

## Error Handling

| Error | Action |
|-------|--------|
| Network failure on fetch | STOP and ask user |
| Rebase conflicts | Resolve automatically |
| Dirty working directory | Use Git Worktrees skill (`workflow:git-worktrees`) |
| Can't determine repo | Allow edit (not in git repo) |
| No remote configured | Local-only mode (see above) |
| `workspace-trust ensure` not installed | Passes — the step no-ops, proceed |
| `workspace-trust ensure` refused (exit 1) | Read the command's own `reason` (stderr/JSON) — it names the cause and the right response |
| `workspace-trust ensure` failed (exit 2) | Not a scope problem — report it; don't retry blindly or ask to widen trust |
