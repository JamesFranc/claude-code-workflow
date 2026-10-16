---
name: Git Worktrees
description: Use when starting feature work that needs an isolated workspace - creates git worktrees under .worktrees/ with proper setup, always branching from origin/main after fetching
---

# Git Worktrees

## Overview

Git worktrees create isolated workspaces sharing the same repository, allowing work on multiple branches simultaneously without switching.

**Core principle:** Always fetch, always branch from origin, always use `.worktrees/`.

## When to Use

- Starting feature work that needs isolation
- Working on multiple stories in parallel
- Team Dispatch setting up workspaces for implementers
- Any time you need a clean workspace without disturbing the current one

## Creation Steps

### 1. Fetch Latest

Always fetch before creating a worktree:

```bash
git fetch origin
```

### 2. Create Worktree

**Reuse before creating.** A story started before — a restart, a resumed session, a re-dispatch —
may already have its worktree. Look first:

```bash
git worktree list --porcelain | grep -i -E "^worktree .*/\.worktrees/([^/]+/)?<TICKET-ID>-" | grep -v -F "/.worktrees/tmp/"
```

That matches a worktree directly under `.worktrees/` or one directory below it (`fix/<TICKET-ID>-…`),
whatever the letter case of the ticket id, and never a `tmp/` throwaway. If it lists a worktree, it
is this story's: work in it, and do not create a second one beside it. Two worktrees for one story
split the work between them, and cleanup removes only the one it was handed. If it lists more than
one, the story is already split: do not pick one. Post a board question naming each worktree, its
branch, and its commits ahead of `origin/main`, and wait for the answer.
With no ticket there is no id to grep for: read `git worktree list` and reuse a worktree whose
branch is this work's, since a restart under a new branch name would otherwise create a second one.

Otherwise, create it. Worktrees always go under `.worktrees/` in the target repo, named by the table
in [Naming](#naming).

**With no ticket, check the key first.** List the keys of the local branches other than
`<branch-name>`; if one equals `<branch-key>`, the branch would share notes, proofs and worktree
names with that branch, so choose a different name
(`skills/workflow-guide/references/routing.md` §Cross-Phase Rule: No Jira, No Ticket):

```bash
git for-each-ref --format='%(refname:lstrip=2)' refs/heads | grep -v -x -F "<branch-name>" | tr / - | grep -x -F "<branch-key>"
```

Then create it:

```bash
git worktree add ".worktrees/<branch-key>" -b "<branch-name>" origin/main
```

**Always branch from `origin/main`**, not local `main`. This ensures the worktree starts from the latest remote state.

### 3. Verify .gitignore

**MUST verify `.worktrees/` is in .gitignore before proceeding:**

```bash
grep -q "\.worktrees" .gitignore
```

**If NOT in .gitignore:** Add `/.worktrees/` to .gitignore and commit immediately. This prevents accidentally tracking worktree contents.

### 4. Install Dependencies

```bash
cd ".worktrees/<branch-key>"
```

Then install its dependencies:
`skills/workflow-guide/references/install-dependencies.md`.

The worktree is where the symlinked `node_modules` appears.

### 5. Register Repo-Root Trust

Claude Code stops its trust ancestor-walk at the enclosing git repo root, so a trusted directory
*above* the repo does not cover the repo or its worktrees. A teammate spawned into an unregistered
worktree — or, when no worktree path is passed at spawn time, into an unregistered launch dir —
stops on the trust dialog in a pane nobody is watching. Register the root before anything is spawned
there:

```bash
workspace-trust ensure --repo "<repo-root>"
```

Run it from the directory Claude was launched in — **not** prefixed with `cd`, and not from inside
the worktree: the command reads its own working directory as the launch dir and refuses any repo
root outside it. Each exit code gets a different response:

- **Exit 0** — trusted (or already was). Nothing to do.
- **Exit 1** — refused. The command's own `reason` (on stderr and in the JSON) says why and what to
  do about it — read it rather than assuming; it is not always the same cause.
- **Exit 2** — failed: the global config couldn't be read, parsed, or the write couldn't be
  verified. This is not a scope problem — report it, don't ask the user to widen trust.

**Known limits, accepted rather than fixed — two distinct losses:**

- The command's own key can still be lost if a write lands after it has already exited and reported
  `trusted` — self-correcting on the next run, since nothing running at that point can cover it.
  Spawning a teammate immediately afterward can still hit this gap and hang on the trust dialog.
- A write landing inside the command's own read-then-write window used to be silently overwritten by
  its stale snapshot — undetectable by its verification, which only confirms its own key survived,
  never anyone else's data. The command now detects this before writing and retries onto fresh data,
  which narrows this window to the small gap right before the write — it does not close it.

**This step passes when the command exits 0, or when it is not installed. Any other outcome stops
progress — the worktree is not ready.**

### 6. Report Ready

```
Worktree ready at .worktrees/<branch-key>
```

## Naming

Name each worktree by this table:

| Worktree | Path | Branch |
|---|---|---|
| The story's own worktree | `.worktrees/<TICKET-ID>-<slug>` | `<TICKET-ID>-<slug>`, the same as the directory |
| Any other worktree the story needs: a RED baseline, a capture, a review of an older sha, scratch testing | `.worktrees/tmp/<TICKET-ID>-<purpose>` | detached (`git worktree add --detach`) |
| A checkout of a branch someone else named, such as `renovate/foo-1.2` | `.worktrees/<branch-key>` — with no ticket, run §2's key check first, and if it prints a key, stop and post a board question | that branch, unchanged |

- **Real worktrees are flat.** A story worktree or a checkout of someone else's branch sits
  directly under `.worktrees/`, never in a subdirectory. A branch name the workflow picks carries no
  `<type>/` prefix (`feat/`, `fix/`) — Branch Setup's naming rule — so the directory never gains
  one either.
- **Throwaway worktrees go in `tmp/`**, never beside the real ones.
- **Nothing but worktrees.** `.worktrees/` holds worktrees and the one `tmp/` directory. A capture
  file, an output log or any other loose file goes to the session scratchpad instead.
- **No ticket.** The story worktree is `.worktrees/<branch-key>` on branch `<branch-name>`, and a
  throwaway one is `.worktrees/tmp/<branch-key>-<purpose>` (`<branch-key>`:
  `skills/workflow-guide/references/routing.md` §Cross-Phase Rule: No Jira, No Ticket).
- **Remove at the actual path.** A worktree whose path does not match this table (such as
  `.worktrees/feat/<TICKET-ID>-<slug>`) is removed at the path `git worktree list` reports, not a
  path rebuilt from the table.

## Multi-Repo Workspaces

When working from a parent directory with multiple repo subdirectories:

- Worktrees go inside the **target repo**, not the parent
- `cd` into the repo first, then create the worktree
- Each repo gets its own `.worktrees/` directory
- With no ticket, run §2's key check in each repo before its `-b`

```bash
# CORRECT
cd my-repo && git worktree add .worktrees/feature-x -b feature-x origin/main

# WRONG - creating worktree from parent
git worktree add .worktrees/feature-x ...
```

## Cleanup

When work is complete (PR merged, branch deleted), remove the story or checkout worktree at the path
`git worktree list` reports for it, not a path rebuilt from the branch name:

```bash
git worktree list --porcelain
git worktree remove "<path from the listing above>"
git worktree list --porcelain | grep -F "/.worktrees/tmp/<TICKET-ID>-"
```

Remove each `tmp/` worktree the grep lists with `git worktree remove "<path>"`, too. With no ticket,
the grep is `grep -F "/.worktrees/tmp/<branch-key>-"` and the listing can include another branch's
throwaway worktrees. List the other keys — every local branch's key that begins with
`<branch-key>-`:

```bash
git for-each-ref --format='%(refname:lstrip=2)' refs/heads | tr / - | awk -v k="<branch-key>-" 'index($0, k) == 1'
```

Skip any grep entry whose path contains `/.worktrees/tmp/<other-key>-` for a key that command prints
(`fix/login` and a branch `fix/login-v2` or `fix-login-v2`: `fix-login-v2-red` is skipped). Leave a
skipped entry in place and name it to the user.

If the worktree has uncommitted changes, git will refuse. Use `--force` only if you're sure the changes are not needed.

## Quick Reference

| Situation | Action |
|-----------|--------|
| Starting new feature | Reuse the story's worktree if `git worktree list` has one; else `git fetch origin && git worktree add ".worktrees/<branch-key>" -b "<branch-name>" origin/main` (with no ticket, §2's key check first) |
| Throwaway worktree (baseline, capture, review, scratch) | `git worktree add --detach "<repo-root>/.worktrees/tmp/<TICKET-ID>-<purpose>" "<sha>"` (§Naming for the path with no ticket) |
| Worktree created for a team | `workspace-trust ensure --repo "<repo-root>"` from the launch dir |
| `.worktrees/` not in .gitignore | Add it immediately and commit |
| Work complete, PR merged | Remove at the path `git worktree list` reports (not `.worktrees/<branch-key>` rebuilt by hand), then remove each `tmp/` worktree per [Cleanup](#cleanup) |
| Multiple repos | Create worktree inside each repo, not the parent |
| Worktree has uncommitted changes | Investigate before removing — don't force blindly |

## Running Commands in Worktrees

When executing commands inside a worktree, **always use `cd <worktree-path> && <command>` in a single command string**. Do NOT attempt to change the persistent working directory with a standalone `cd`. The Bash tool runs from the primary working directory each time — chaining with `&&` ensures the command runs in the right location.

```bash
# CORRECT
cd /path/to/repo/.worktrees/feature-x && pnpm build

# WRONG — cd in a separate command doesn't persist
cd /path/to/repo/.worktrees/feature-x
pnpm build  # runs in the original directory
```

## Rules

- **Always fetch first** — `git fetch origin` before any worktree operation
- **Always branch from origin/main** — not local main
- **Always use `.worktrees/`, named per [Naming](#naming)** — story worktrees flat, throwaway ones
  under `tmp/`
- **Always verify .gitignore** — prevent tracking worktree contents
- **Always register repo-root trust** — `workspace-trust ensure --repo "<repo-root>"` from the launch
  dir before anything is spawned there
- **Never force-remove** without checking for uncommitted work
