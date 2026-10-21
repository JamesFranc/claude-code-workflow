import os
import re
import sys

# Usage: validate-link.py <iterm id> <claude id> <cwd>  (already URL-decoded)
# Prints the reason a link must be refused, and nothing when it is acceptable.

UUID = re.compile(r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def main() -> None:
    iterm_id, claude_id, cwd = (sys.argv[1:4] + ["", "", ""])[:3]
    for label, value in (("iTerm2 session id", iterm_id), ("Claude session id", claude_id), ("directory", cwd)):
        if CONTROL.search(value):
            print(f"the {label} contains a control character")
            return
    if not UUID.match(iterm_id):
        print("the iTerm2 session id is not a UUID")
    elif not claude_id:
        print("the link names no Claude session")
    elif not UUID.match(claude_id):
        print("the Claude session id is not a UUID")
    elif not (os.path.isabs(cwd) and os.path.isdir(cwd)):
        print("the directory is not an existing absolute path")


main()
