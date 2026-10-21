import os
import re
import stat
import sys

# Usage: check-resume-dir.py <claude session id> <directory>
# Prints the reason a session may not be resumed in <directory>, and nothing when it may.
# The directory is accepted only when its encoded name is a folder under ~/.claude/projects that holds
# <claude session id>.jsonl: the folder Claude Code files the session's transcript under for a session
# started in that directory.
# The encoding replaces every character other than A-Z, a-z, 0-9 with "-". It matched every
# transcript-holding folder in the author's ~/.claude/projects when this was written, and it is Claude
# Code's own and undocumented. It is lossy: any other directory of the same length that is identical
# wherever either holds a letter or digit encodes to the same name and is accepted too.
# The routine in Claude Code 2.1.304 is not evidenced beyond ASCII and 200 characters: it works on UTF-16
# code units and, past 200 characters, cuts the name and appends a hash this script cannot compute.
# A directory with a non-ASCII character, or an encoded name past 200 characters, is therefore refused.
# A folder that cannot be searched, or a projects folder that cannot be listed, is reported as a read
# failure and never as "no transcript".

MAX_ENCODED_LENGTH = 200
ENCODE_PATTERN = re.compile(r"[^A-Za-z0-9]")


def main() -> None:
    claude_id, directory = (sys.argv[1:3] + ["", ""])[:2]
    projects_dir = os.environ.get("AGENT_SESSION_PROJECTS_DIR") or os.path.expanduser("~/.claude/projects")
    if not directory.isascii():
        print("the directory has a non-ASCII character, so its project folder name is not known")
        return
    encoded = ENCODE_PATTERN.sub("-", directory)
    if len(encoded) > MAX_ENCODED_LENGTH:
        print(f"the directory's project folder name is longer than {MAX_ENCODED_LENGTH} characters, so it is not known")
        return
    try:
        projects = sorted(os.listdir(projects_dir))
    except OSError as error:
        print(f"cannot read {projects_dir}: {error.strerror}")
        return
    holders = []
    for project in projects:
        transcript = os.path.join(projects_dir, project, f"{claude_id}.jsonl")
        try:
            if stat.S_ISREG(os.stat(transcript).st_mode):
                holders.append(project)
        except (FileNotFoundError, NotADirectoryError):
            continue
        except OSError as error:
            print(f"cannot read {transcript}: {error.strerror}")
            return
    if not holders:
        print("no transcript was found for that session")
    elif encoded not in holders:
        print("the session's transcript is not filed under that directory")


main()
