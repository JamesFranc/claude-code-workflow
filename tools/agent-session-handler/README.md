# Agent Session handler

A small macOS applet that opens `agent-session://` links from the board. For an `iterm` link it
focuses the iTerm2 session the link names; if that session is gone, it opens a new iTerm2 tab in the
session's launch directory and runs `claude --resume` for it.

Install (builds `~/Applications/Agent Session.app` and registers the scheme):

```bash
tools/agent-session-handler/install.sh
```

## Finding a session that has moved

An `iterm` link names an iTerm2 session id, which may change when iTerm2 restarts or the session is
resumed in another pane. When no iTerm2 session has that id, the handler looks for a live Claude Code process running the link's
Claude session, using the `sessionId` and `pid` in `~/.claude/sessions/<pid>.json`, and focuses the
iTerm2 pane on that process's tty. A process counts as live only if it exists and, when the file
records `procStart`, started at that time. If a live process has no iTerm2 pane (another terminal, or
no terminal at all), the handler says so and does not resume. Only when no live process is found, and
the link's directory is one the session can be resumed from (see Resume command), does it
open a new tab and resume.

Those files are Claude Code's own and undocumented. A sessions folder that does not exist counts as
"not found", and so does a file that is valid JSON but names another session or none, or that
disappears before it is read. The check cannot say whether a session is running, and the handler asks
"Resume anyway" or "Cancel" (Cancel is the default) rather than assuming nothing is running, when:

- the folder cannot be listed, or a file that exists cannot be read or is not valid JSON;
- a file names the session without a usable pid;
- `ps` cannot run, or fails with output or an exit status other than 1 (`ps -p` exits 1 with no output
  for a pid that does not exist, so a process that exited just after it was found counts as not live);
- the helper fails or prints something unrecognised.

## Resume command

When a link needs a new tab, the handler types a resume command into it. The default is:

```
cd {cwd} && claude --resume {claude}
```

To change it, put a one-line template in `~/.config/agent-session/resume-command`. `{cwd}` and
`{claude}` are replaced with shell-quoted values; the line is otherwise typed as written. A missing or
blank file means the default. For example, to load `.env.local` before resuming:

```
cd {cwd} && { [ ! -f .env.local ] || source .env.local; } && claude --resume {claude}
```

The resume command runs only in a directory whose encoded name is a folder under
`~/.claude/projects/` that holds the session's transcript (`<folder>/<claude session id>.jsonl`), the
folder Claude Code files that session under. The encoding replaces every character other than A-Z, a-z
and 0-9 with `-`; Claude Code does not document it. The handler resumes nothing, and says why, when no
folder holds the transcript, when the projects folder cannot be listed, when the transcript's path
cannot be looked up (a folder that cannot be searched, for example), or when no folder holding it is
named for the link's directory. It also refuses a directory with a non-ASCII character or an encoded
name longer than 200 characters, because the encoding is not evidenced there.

The encoding is lossy: any other directory of the same length that matches wherever either holds a
letter or digit encodes to the same name and is accepted too (`/a/b-c`, `/a/b/c` and `/a-b/c` match).
An attacker therefore needs the user's real session id and a directory whose path matches the
project's at every letter and digit, wherever the attacker can create one. A template that runs files
from `{cwd}`, like the `.env.local` one above, trusts the contents of that directory.

## What a link may contain

The handler refuses, with a dialog and no other action, any link whose decoded values hold a control
character (below 0x20, or DEL), whose iTerm2 or Claude session id is missing or not a UUID, or whose
directory is missing or not an existing absolute path.
