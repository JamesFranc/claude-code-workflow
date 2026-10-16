---
description: Re-pull the current pinned workflow skills into context — re-emit the workflow decision logic and re-read the active skills' SKILL.md text. Use mid-session to refresh the rudder after a long stretch of work or when you suspect process drift. Does not upgrade the plugin version.
---

# Reload Skills

Refresh this session's view of the workflow skills by re-reading their current text from the pinned plugin version. Use this when you've been deep in a long job and want to re-ground in the current process, or when skills may have been edited since the session started.

Do the following now:

1. **Re-emit the workflow decision logic.** Invoke `workflow:workflow-guide` and re-read its skill-chain table and decision logic. This restores the routing rules that may have scrolled out of context.

2. **Re-read the skills active in the current work.** Identify which workflow skills are in play right now — for example `workflow:team-dispatch` if you're executing a story, `workflow:code-review` if you're reviewing, `workflow:pr-feedback` if you're addressing review comments, `workflow:architecture` if you're designing. Re-invoke each so its current `SKILL.md` text is pulled fresh into context. If you're unsure which are active, at minimum re-read `workflow:workflow-guide` and the skill named by the current phase of work.

3. **Reconcile.** If the refreshed skill text differs from how you've been behaving, correct course now and say plainly what changed.

## What this does and does not do

- **This re-pulls the _pinned_ skill text — the version this session started with.** `SKILL.md` is re-read fresh on every skill invocation, so re-invoking a skill always reflects the latest text _in the pinned version directory_.
- **This does NOT upgrade the plugin to a newer release.** A running session is pinned to the plugin version it started with. The expected behavior is that in-process reloads (including `/reload-plugins`) re-read that pinned version rather than hot-swapping the live process onto a newer one — but only the pin and the fresh-read are empirically confirmed here (via `installed_plugins.json`); the exact reach of `/reload-plugins` is operator-confirmable, not exercised in this session. **To pick up a newly-installed release, exit and run `claude --resume`** — a fresh process re-reads the installed-plugins manifest at startup and loads whatever version is installed there, while restoring this session's context. (Resume re-reads the manifest; it does not itself fetch or install a release — if the newer version isn't installed locally yet, resume reloads the same pinned version.) Resume ≈ restart for plugin purposes.
