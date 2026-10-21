import json
import os
import subprocess
import sys

# Prints "<pid>\t<tty>" for a live Claude Code process running the given session id. A scan that completes
# without finding one prints nothing and exits 0, as does a sessions dir that does not exist.
# Any lookup that cannot complete writes the reason to stderr and exits non-zero, and the caller must treat
# that as "unknown", never as "not found". That covers a sessions dir that cannot be listed, a session file
# that exists but cannot be read or is not valid JSON, a file naming the session without a usable pid, and
# a ps that cannot run or fails with output or an exit status other than 1.
# A session file that is valid JSON but names another session, or has no sessionId, is not a record of
# this session and is skipped, as is a file that disappears between the directory listing and the read.
# The tty column is "??" or empty when the process has no controlling terminal.
# Reads Claude Code's own ~/.claude/sessions/<pid>.json files, a format it does not document.
# A pid counts as live only when the process exists and, if the file records procStart, started at that time.
# `ps -p` exits 1 with no output for a pid that does not exist, so a process that exited between the kill
# check and ps is not live and the scan goes on.


def main() -> None:
    claude_id = sys.argv[1] if len(sys.argv) > 1 else ""
    sessions_dir = os.environ.get("AGENT_SESSION_SESSIONS_DIR") or os.path.expanduser("~/.claude/sessions")
    if not claude_id:
        return
    try:
        names = sorted(os.listdir(sessions_dir))
    except FileNotFoundError:
        return
    except OSError as error:
        raise RuntimeError(f"cannot list {sessions_dir}: {error.strerror}")
    for name in names:
        if not name.endswith(".json"):
            continue
        found = live_session(os.path.join(sessions_dir, name), claude_id)
        if found is not None:
            print(f"{found[0]}\t{found[1]}")
            return


def live_session(path: str, claude_id: str):
    try:
        with open(path) as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise RuntimeError(f"cannot read {path}: {error.strerror}")
    except ValueError:
        raise RuntimeError(f"{path} is not valid JSON")
    if not isinstance(data, dict) or data.get("sessionId") != claude_id:
        return None
    pid = data.get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int):
        raise RuntimeError(f"{path} names the session without a usable pid")
    try:
        os.kill(pid, 0)
    except PermissionError:
        pass
    except OSError:
        return None
    proc_start = data.get("procStart")
    if isinstance(proc_start, str):
        started = ps_field("lstart", pid, utc=True)
        if started is None or normalize(proc_start) != normalize(started):
            return None
    tty = ps_field("tty", pid)
    if tty is None:
        return None
    return pid, tty


def ps_field(field: str, pid: int, utc: bool = False):
    env = {**os.environ, "LC_ALL": "C", "TZ": "UTC"} if utc else None
    try:
        result = subprocess.run(["ps", "-o", f"{field}=", "-p", str(pid)], capture_output=True, text=True, env=env)
    except OSError as error:
        raise RuntimeError(f"cannot run ps: {error.strerror}")
    if result.returncode == 1 and not result.stdout.strip() and not result.stderr.strip():
        return None
    if result.returncode != 0 or result.stderr.strip():
        raise RuntimeError(f"ps failed for pid {pid} (exit {result.returncode}): {result.stderr.strip()}")
    return result.stdout.strip()


def normalize(text: str) -> str:
    return " ".join(text.split())


try:
    main()
except Exception as error:
    print(str(error) or type(error).__name__, file=sys.stderr)
    sys.exit(2)
