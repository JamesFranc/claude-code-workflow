#!/bin/bash
# Pre-commit hook: Ensures commit messages follow conventional commit format
#
# Format: <type>[(scope)]: [TICKET-123] <description>
# Types: feat, fix, chore. feat and fix are the release-please types a PR's first commit uses;
# chore is for the one commit each later push adds (agents/implementer.md §Commit Format).
# Scope: optional, kebab-case section of code affected (e.g., api, auth-service)
# Ticket: optional, Jira ticket in brackets after colon (e.g., [DEV-123])
# Reach: the subject line only. This hook validates the subject line and nothing below it — it
# reads the whole message (extract_subject takes the first line of it, and the heredoc path needs the
# untruncated body to do so) and then checks only that first line, so trailers and body content pass
# through unexamined rather than unseen. That is the definition of the rule, not an implementation
# detail: agents/implementer.md §Commit Format states it in those terms.

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Extract the bash command. Guarded (FLOW-183): under `set -e`, an unguarded assignment from a
# failing/missing jq would abort the script before any of its intentional fail-open paths — same
# pattern as the `command -v python3` check below.
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || COMMAND=""
else
  COMMAND=""
fi

if [[ -z "$COMMAND" ]]; then
  exit 0  # No command, allow
fi

# Cheap match on the command string before spawning python3 — this hook fires on every Bash call.
if ! echo "$COMMAND" | grep -qE 'git[[:space:]]+commit'; then
  exit 0  # Not a git commit, allow
fi

# Extract the commit subject using Python's shlex for proper shell argument parsing (mirrors
# pr-title-guard.sh). This robustly handles every quoting form:
#   git commit -m "message"            git commit -m 'message'
#   git commit --message="message"     git commit --message "message"
#   git commit -m "$(cat <<'EOF' ... EOF)"   (heredoc — subject is first body line)
# Bare grep/sed could not parse these portably; the previous \s-based approach silently failed on
# BSD/macOS (FLOW-99).
#
# Segment-scoped (FLOW-183): the cheap grep above matches free text ANYWHERE in the command (e.g.
# `echo "git commit -m nope"`), so it is only a prefilter. Tokenize into segments the same way
# dashboard-enter-guard.sh does (shlex.shlex in punctuation_chars mode, splitting on unquoted
# &&/||/;/|/bare &/newlines) and only treat a segment as a real invocation when `git commit` are
# its LEADING tokens — never free text inside a quoted arg, which collapses to a single token.
#
# Heredoc quote-immunity (FLOW-183): the OLD code ran `shlex.split` over the whole command, so a
# `"` inside a heredoc body closed the `-m "…"` quote early and silently truncated the captured
# message (reproduced live — see hooks/test-conventional-commit.sh). shlex does the same
# character-level quote matching whether it sees the whole command or just this segment, so
# segment-scoping alone does not fix that half of the defect. Fix: find every heredoc block in the
# RAW command text FIRST via regex (immune to embedded quotes — it anchors on the `<<'DELIM' …
# DELIM` structure, not char-by-char quote state) and swap each body for a safe placeholder before
# ever handing the text to shlex. Segment/flag parsing then runs on the sanitized text; if the
# extracted `-m` value turns out to be a placeholder, the REAL (untruncated) body captured up
# front is used, and its first line becomes the subject — otherwise the extracted value is used
# directly, unchanged from the plain-string behavior.
if command -v python3 >/dev/null 2>&1; then
  RESULT=$(python3 - "$COMMAND" 2>/dev/null <<'PY'
import shlex, sys, re

cmd = sys.argv[1]

HEREDOC_RE = re.compile(r"<<-?[ \t]*([\x27\"]?)([\w-]+)\1[ \t]*\r?\n(.*?)\r?\n[ \t]*\2", re.S)

heredocs = []

def stash(m):
    idx = len(heredocs)
    placeholder = f'FLOW183HEREDOC{idx}PLACEHOLDER'
    heredocs.append(m.group(3))
    return f'<<{m.group(1)}{m.group(2)}{m.group(1)}\n{placeholder}\n{m.group(2)}'

sanitized = HEREDOC_RE.sub(stash, cmd)

try:
    lex = shlex.shlex(sanitized, posix=True, punctuation_chars='&|;\n')
    lex.whitespace_split = True
    lex.whitespace = lex.whitespace.replace('\n', '')
    tokens = list(lex)
except ValueError:
    sys.exit(0)  # unparseable command — allow through (fail open)

OPERATORS = {'&&', '||', ';', '|', '&'}

def is_boundary(tok):
    core = tok.replace('\n', '')
    return tok != '' and (core == '' or core in OPERATORS)

segments = [[]]
for tok in tokens:
    if is_boundary(tok):
        segments.append([])
    else:
        segments[-1].append(tok)

def resolve(value):
    for idx, body in enumerate(heredocs):
        placeholder = f'FLOW183HEREDOC{idx}PLACEHOLDER'
        if placeholder in value:
            return body
    return value

def extract_subject(seg):
    args = seg[2:]  # tokens after the git/commit pair
    i = 0
    msg = None
    while i < len(args):
        a = args[i]
        if a in ('-m', '--message') and i + 1 < len(args):
            msg = args[i + 1]; break
        if a.startswith('--message='):
            msg = a[len('--message='):]; break
        # Combined short flags: -am, -vm, etc. -- git allows -m to be
        # clustered with other single-char flags as long as it is last in the cluster, and the
        # message is still the NEXT arg. Excludes long flags (e.g. --amend) via the double-dash
        # check.
        if a.startswith('-') and not a.startswith('--') and len(a) > 1 and a[-1] == 'm' and i + 1 < len(args):
            msg = args[i + 1]; break
        i += 1
    if msg is None:
        return None
    msg = resolve(msg)
    lines = msg.splitlines()
    return lines[0].strip() if lines else msg.strip()

# Validate EVERY git commit segment independently: a single bash command can
# chain more than one git commit invocation, and each one actually runs. Collapsing to a single
# first-subject-wins check let a valid commit chained with an invalid one bypass validation on the
# second, real commit -- the exact chaining-bypass class this ticket hardens against, and a
# divergence from pr-lifecycle-guard.sh's own every-segment accumulation.
found_any = False
subjects = []
for seg in segments:
    for i in range(len(seg) - 1):
        if seg[i] == 'git' and seg[i + 1] == 'commit':
            found_any = True
            s = extract_subject(seg[i:])
            if s is not None:
                subjects.append(s)
            break  # one git/commit pair per segment

if not found_any:
    sys.exit(0)  # no git commit segment anywhere in this command — allow

if not subjects:
    sys.exit(0)  # no message flag in any git commit segment (interactive, --amend, -F, ...) — allow

for s in subjects:
    # Prefixed: a present-but-empty message value (e.g. -m with an
    # empty string) is a real, invalid subject and must still block -- but printing an empty s
    # alone, once trailing newlines are stripped by bash command substitution, is indistinguishable
    # from no output at all (the correct fail-open case: no message flag found in any segment).
    # The prefix keeps every found-subject line non-blank so it survives that stripping intact.
    print('SUBJECT:' + s)
PY
) || RESULT=""
else
  RESULT=""  # python3 unavailable — cannot parse safely, allow
fi

if [[ -z "$RESULT" ]]; then
  exit 0  # Couldn't parse a subject, allow (might be interactive or amend)
fi

# Validate conventional commit format
# Pattern: type[(scope)]: [TICKET-123] description
# - type: feat, fix or chore
# - scope: optional, kebab-case (e.g., api, auth-service)
# - ticket: optional, in brackets after colon (e.g., [DEV-123])
VALID_TYPES="feat|fix|chore"
SCOPE_PATTERN="[a-z][a-z0-9]*(-[a-z0-9]+)*"  # kebab-case
TICKET_PATTERN="\[[A-Z]+-[0-9]+\]"
PATTERN="^($VALID_TYPES)(\($SCOPE_PATTERN\))?: ($TICKET_PATTERN )?[^[]+$"

# Validate every git commit segment's subject independently — RESULT may
# carry more than one "SUBJECT:"-prefixed line, one per chained `git commit`. Block on the first
# invalid one. A line is only ever emitted for a segment where a message flag WAS found (see the
# python above), so every line here — even one whose subject is the empty string, e.g. from
# `-m ""` — must be validated, not skipped; only the true absence of ANY such line (RESULT itself
# empty, no message flag found anywhere) means fail-open.
while IFS= read -r LINE; do
  [[ -z "$LINE" ]] && continue  # blank line in the stream (not a real "SUBJECT:"-prefixed entry)
  SUBJECT="${LINE#SUBJECT:}"
  if ! echo "$SUBJECT" | grep -qE "$PATTERN"; then
    cat >&2 <<EOF
CONVENTIONAL COMMIT REQUIRED

Commit message does not follow conventional commit format.

Your message: "$SUBJECT"

Required format: <type>[(scope)]: [TICKET-123] <description>
(the [TICKET-123] is optional and used only when a ticket exists; otherwise omit it)

Only the subject line is checked. Nothing below the first line is validated,
so the body and any trailers are outside this format -- see agents/implementer.md,
section Commit Format. This hook neither rejects nor rewrites what sits below
the subject; nothing here licenses editing text it does not check.

Valid types:
  feat  - A new feature (a PR's first commit)
  fix   - A bug fix (a PR's first commit, or a later one fixing a real defect)
  chore - The one commit a later push adds to an open PR

Optional scope (in parentheses):
  - Use for section of code affected
  - Must be kebab-case (e.g., api, auth-service, file-upload)
  - Keep to 1-2 words

Optional ticket (in brackets after colon):
  - Jira ticket reference (e.g., [DEV-123])

Examples:
  feat: add user authentication
  fix: handle null response
  feat(api): [DEV-456] add pagination support
  fix(auth-service): [DEV-789] resolve token expiry bug
EOF
    exit 2  # Block the commit
  fi
done <<< "$RESULT"

# Every subject validated, allow
exit 0
