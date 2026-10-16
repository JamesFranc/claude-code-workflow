---
description: Refresh your rudder — re-pull the current pinned workflow skills, re-read the active goal/North Star, AND restart any background jobs a restart may have dropped, in one step. Use periodically during long jobs to stay on-process and on-goal.
argument-hint: [optional PRD path or Jira ticket id]
---

# Re-anchor

The one command for "refresh your rudder" during a long job. It re-grounds you on the _process_ (the current skills), the _goal_ (the North Star + the in-flight plan), and your _footing_ (the background jobs and team a restart may have dropped).

Do all three, in order:

1. **Reload skills** — perform the steps of `/reload-skills`: re-emit the workflow decision logic (`workflow:workflow-guide`) and re-read the active skills' current pinned `SKILL.md` text.

2. **Reload goal** — perform the steps of `/reload-goal`, passing along any argument given to this command: resolve the active PRD, re-read its North Star block and the in-flight implementation plan.

3. **Restart jobs** — perform the steps of `/restart-jobs`: if the session restarted, relaunch the background jobs you had running (the Renovate monitor, anything else) and re-establish the team if a story is in flight. If nothing was dropped, confirm that and move on.

Then give a one-paragraph re-anchoring summary: the goal, the bar, the process you're following right now, the status of your background jobs and team, and any course-correction you're making.

## Note

This is a _rudder-refresh_, not a version upgrade. It re-pulls the skills this session is pinned to; it does not pull a newer plugin release. To pick up a newly-installed release, exit and run `claude --resume`.
