#!/bin/bash
# Test script for dangerous-command-guard.sh
# Simulates hook input and verifies expected outcomes
#
# PIN-LABELING CONVENTION for this file's bash-execution audit: every test_case() row
# asserting exit 0 (allow) on a shape where real bash genuinely
# executes the guarded command must carry KNOWN FAIL-OPEN in its description; every row asserting
# exit 2 (block) on a shape where bash does NOT execute it, chosen deliberately rather than by
# coincidence, must carry ACCEPTED OVER-BLOCK. An automated audit that actually runs each payload
# through bash and checks whether the guarded command fires cross-checks its findings against
# these labels, not against a raw count: any finding whose row is not so labelled is a NEW defect;
# any labelled row the audit does NOT find has been fixed and the label is stale and should be
# removed. A correspondence check (does this SPECIFIC row's label match this SPECIFIC row's
# measured behavior) is stronger than a value check (does the total count match an expected
# number) -- a broken audit harness can report the right total from the wrong rows, and a reviewer
# comparing two counts would not catch it; comparing labelled rows to findings would.
#
# The audit MUST run with the INHERITED environment, not a synthetic one built for convenience.
# A prior audit run exported CMD=/bin/bash before executing payloads and reported a KNOWN
# FAIL-OPEN finding for a row whose payload referenced $CMD -- populating the very variable the
# payload depended on, so it "confirmed" a fail-open that is inert in essentially every real
# environment ($CMD is not a variable bash or any common tool sets). The audit answered a question
# about a world that does not exist. Payloads in this file were corrected to use $SHELL instead,
# which bash itself populates whenever it is not already inherited (confirmed live under a bare
# `env -i`), so the audit's answer no longer depends on which extra variables its own harness
# happens to export.

set -euo pipefail

HOOK_SCRIPT="$(dirname "$0")/dangerous-command-guard.sh"
PASS=0
FAIL=0
MATCHED=0
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# Every row pins all three channels: the exit status, stdout empty, and stderr equal to the whole
# expected text. A row that blocks without naming a message expects the pattern-kill one, and a
# row that allows expects empty stderr.
test_case() {
  local description="$1"
  local command="$2"
  local expected_exit="$3"  # 0 = allow, 2 = block
  local expected_stderr="${4-}"
  if [[ -z "$expected_stderr" && "$expected_exit" -eq 2 ]]; then
    expected_stderr="$KILL"
  fi

  # ONLY="<text>" runs just the rows whose description contains it; the bash ground-truth
  # checks below are not rows and always run.
  if [[ -n "${ONLY:-}" && "$description" != *"$ONLY"* ]]; then
    return
  fi
  MATCHED=$((MATCHED + 1))

  # Build the JSON input that the hook expects
  local input
  input=$(jq -n --arg cmd "$command" '{"tool_input": {"command": $cmd}}')

  local actual_exit=0
  echo "$input" | bash "$HOOK_SCRIPT" >"$WORK_DIR/stdout" 2>"$WORK_DIR/stderr" || actual_exit=$?
  local actual_stderr
  actual_stderr=$(cat "$WORK_DIR/stderr"; printf x)
  actual_stderr=${actual_stderr%x}

  if [[ "$actual_exit" -eq "$expected_exit" && ! -s "$WORK_DIR/stdout" && "$actual_stderr" == "$expected_stderr" ]]; then
    echo "PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description (expected exit $expected_exit with stdout empty and stderr ${expected_stderr:0:60}..., got exit $actual_exit, stdout $(wc -c < "$WORK_DIR/stdout") bytes, stderr ${actual_stderr:0:60}...)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Dangerous Command Guard Tests ==="
echo

CLOSING="Do not re-issue, split, or script around this block; use the alternative, or ask on the board."

# Each message is the hook's complete stderr: the class text, a blank line, the closing line.
IFS= read -r -d '' KILL_TEXT <<'EOF' || true
BLOCKED: blind pattern-kill (pkill / killall) is not allowed

Pattern kills match processes by name or command line, so they over-match:
they can reap another session's processes or unrelated tools, and they destroy
the evidence you need to find the real problem.

Do this instead:
  1. Enumerate — `ps`, `jobs`, or the tool's own status command.
  2. Identify each PID and confirm what it is and who owns it.
  3. Kill only the confirmed-redundant PIDs by number:
       kill <pid>     (or kill -TERM <pid>)

Kill one verified PID at a time. Targeted `kill <pid>` is allowed.
EOF
IFS= read -r -d '' HEREDOC_INTERPRETER_TEXT <<'EOF' || true
BLOCKED: a heredoc fed to an interpreter

A script piped into python, node, bash or another interpreter through a heredoc
is code nobody can read before it runs, and the harness stops to ask about it
even in bypass mode. A bare variable word such as `cd "$DIR" && git commit ...`
in the same command counts too.

Do this instead: write the script to a file in your scratchpad with the Write
tool, then run it by path, e.g. `python3 /path/to/script.py`. To commit with a
message body, use `git -C "<dir>" commit -F - <<'EOF'` instead of `cd`.
EOF
IFS= read -r -d '' HEREDOC_FILE_TEXT <<'EOF' || true
BLOCKED: a heredoc written to a file

`cat <<EOF > file`, `cat >> file <<EOF` and `tee` write a file the harness
cannot show as a change, and it stops to ask about them even in bypass mode.

Do this instead: create the file with the Write tool, or change it with Edit.
Still allowed: `cat >&2 <<EOF`, `--body-file -`, and
`git commit -m "$(cat <<'EOF' … EOF)"`.
EOF
IFS= read -r -d '' DELETION_TEXT <<'EOF' || true
BLOCKED: a deletion whose target is only known when it runs

This rm or rmdir names its target through a variable, a glob, a command
substitution or a critical path (/ ~ . ..), or runs inside bash -c, xargs or
find. The harness cannot tell what it will delete, so it stops to ask even in
bypass mode.

Do this instead: name the path literally, as one absolute or worktree-relative
path per operand, in a call of its own:
  rm -rf /absolute/path/to/dir
A literal-path delete of a file or directory you own is allowed.
EOF
KILL="$KILL_TEXT"$'\n'"$CLOSING"$'\n'
HEREDOC_INTERPRETER="$HEREDOC_INTERPRETER_TEXT"$'\n'"$CLOSING"$'\n'
HEREDOC_FILE="$HEREDOC_FILE_TEXT"$'\n'"$CLOSING"$'\n'
DELETION="$DELETION_TEXT"$'\n'"$CLOSING"$'\n'

# The hook's shebang is #!/bin/bash, which is bash 3.2 on macOS, while the rows below run the hook
# under whichever bash is first on PATH. A syntax bash 3.2 rejects would crash the hook there
# with no BLOCKED message, so parse it with the shebang's own interpreter.
test_hook_parses_under_shebang_bash() {
  local description="bash ground truth: the hook parses under /bin/bash, the interpreter on its shebang"
  if [[ ! -x /bin/bash ]]; then
    return
  fi
  local output
  if output=$(/bin/bash -n "$HOOK_SCRIPT" 2>&1); then
    echo "PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description (${output%%$'\n'*})"
    FAIL=$((FAIL + 1))
  fi
}
test_hook_parses_under_shebang_bash

# --- Should BLOCK (pattern-kill invocations) ---

test_case "pkill -f full-command match"      "pkill -f watcher"                 2
test_case "pkill by name"                    "pkill watcher"                    2
test_case "pkill with signal then -f"        "pkill -9 -f mailbox"              2
test_case "killall by name"                  "killall node"                     2
test_case "killall with signal"              "killall -9 node"                  2
test_case "sudo pkill"                        "sudo pkill -f foo"                2
test_case "pkill via xargs pipe"             "pgrep -f foo | xargs pkill"       2
test_case "pkill after && operator"          "echo done && pkill bar"           2
test_case "pkill after semicolon"            "cd /tmp; pkill baz"               2
test_case "absolute-path pkill"              "/usr/bin/pkill -f foo"            2
test_case "env-assignment then pkill"        "FOO=bar pkill baz"                2
test_case "pkill in command substitution"    "echo \$(pkill -f foo)"           2
test_case "xargs -r pkill after pipe"        "pgrep -f foo | xargs -r pkill"    2
test_case "xargs -n1 pkill"                  "pgrep -f foo | xargs -n1 pkill"   2
test_case "sudo -u user then pkill"          "sudo -u root pkill -f foo"        2
test_case "timeout wrapper then pkill"       "timeout 5 pkill -f foo"           2
test_case "nice wrapper then pkill"          "nice pkill foo"                   2
test_case "setsid wrapper then pkill"        "setsid pkill foo"                 2
test_case "doas wrapper then pkill"          "doas pkill -f foo"                2
test_case "then-keyword pkill"               "if pgrep foo; then pkill foo; fi" 2
test_case "do-keyword pkill"                 "for i in 1; do pkill foo; done"   2
test_case "exec wrapper then pkill"          "exec pkill -f foo"                2
test_case "eval wrapper then pkill"          "eval pkill -f foo"                2

# Documented, intentional over-block: FLOW-228 matches pkill/killall as a bare token ANYWHERE in
# a segment, so a mention after a wrapper blocks for the same reason an un-wrapped mention now
# does too (see the two flipped mention tests below) -- the wrapper here doesn't change the
# outcome.
test_case "documented over-block: bare mention still blocks, wrapper or not" "sudo grep pkill /var/log/syslog"  2

# FLOW-228, GENUINELY RED at base: these two flip from 0 to 2, deliberately. Anywhere-in-segment
# matching fails toward BLOCKING; the old command-position-plus-wrapper-list design failed toward
# ALLOWING, and its incomplete enumeration (>/dev/null, if, while, !) produced five fail-opens (see
# the segmentation bug summary). The accepted price is an unquoted mention now reads the same as a
# real invocation. User approved this trade explicitly. Measured at base (84b7d27): both exit=0
# there (should be 2) -- genuinely RED. Kept in the BLOCK section, not ALLOW, since that's what
# they assert now.
test_case "pkill as echo argument"           "echo pkill this is fine"          2
test_case "killall inside grep pattern"      "grep killall /var/log/foo.log"    2

# --- Should ALLOW (targeted kill / non-invocations) ---

test_case "targeted kill by pid"             "kill 12345"                       0
test_case "targeted kill -TERM by pid"       "kill -TERM 12345"                 0
test_case "targeted kill -9 by pid"          "kill -9 12345"                    0
test_case "pkill as substring of longer cmd" "mypkill --help"                   0
test_case "pkill inside quoted string"       "echo \"run pkill later\""         0
test_case "ps grep pipeline"                 "ps aux | grep watcher"            0
test_case "jobs listing"                     "jobs"                             0
test_case "no kill at all"                   "echo hello"                       0
test_case "sudo non-kill command"            "sudo systemctl restart nginx"     0
test_case "xargs non-kill command"           "xargs -r echo hello"              0
test_case "time non-kill command"            "time ls -la"                      0
test_case "exec non-kill command"            "exec node server.js"              0
test_case "eval non-kill command"            "eval echo hi"                     0

# --- FLOW-228: segment-scoped killer-token matching (port from the shared analyzer) ---
# Every row below was measured against the unmodified hook at 84b7d27 before this port landed, but
# NOT every row was RED there -- three classes, labelled per group as each appears:
#   GENUINELY RED    -- wrong at base (the exit code differs from what's asserted here); the port
#                        fixes it. This is the evidence the port works.
#   REGRESSION GUARD -- already correct at base for an unrelated reason (the old tr split or its
#                        regex happened to catch this shape too); pinned so the port doesn't
#                        regress it. Not evidence of a fix.
#   ANTI-VACUITY CONTROL -- already correct at base; catches an always-allow/always-block rewrite
#                        of the port itself, not a claim about what changed.
# See the FLOW-228 segmentation bug summary for the measured baseline this fixes.

# ANTI-VACUITY CONTROLS, already correct at base -- catch an always-allow or always-block rewrite
# of the port.
test_case "CONTROL: real pkill invocation still blocks"     "pkill -f node"                    2
test_case "CONTROL: targeted kill still allowed"             "kill 12345"                       0
test_case "CONTROL: ordinary command still allowed"          "ls -la"                           0

# GENUINELY RED at base, FIXED: the old split (`tr $';&|(){}\140' $'\n'`) was quote-blind on all
# EIGHT of its own characters -- ';', '&', '|', '(', ')', '{', '}', and backtick (octal \140) --
# so any one of them inside quoted prose tore it into synthetic "command lines" that were never
# commands, regardless of quoting. shlex resolves quotes before segmenting, so quoted text stays
# one token no matter which of the eight appears inside it. The matrix is derived from that
# character SET, not from which shapes happened to get reported -- deriving it from a bug report's
# examples instead of the deleted mechanism's own constants is what left this class half-pinned.
# All eight are independently verified RED at base; each is covered exactly
# once below or in the group that follows:
#   ';'       -- the two semicolon cases directly below
#   '(' / ')' -- the parens case directly below (one row covers both)
#   '|'       -- the three pipe cases below that (from a live repro)
#   '&', '`', '{', '}' -- the four cases in the group after that
# Measured at base: all seven below exit=2 there (should be 0) -- genuinely RED.
test_case "quote-blind split FIXED: semicolon inside a quoted string" \
  'echo "first do X; pkill -f node"' \
  0

test_case "quote-blind split FIXED: parens inside a quoted string" \
  'echo "see fn(x) pkill y"' \
  0

test_case "quote-blind split FIXED: semicolon in a commit message" \
  'git commit -m "docs: stop it; pkill is banned"' \
  0

test_case "quote-blind split FIXED: mention inside a data-sink heredoc body" \
  'cat <<EOF
do not pkill anything
EOF' \
  0

# Searching for these two test-case names with a quoted
# alternation was itself blocked by the installed guard -- the '|' inside the quotes split it into
# a synthetic line starting with `killall`. Same defect class as the ';'/'(' cases above, different
# split character; added because no existing case exercised '|' specifically.
test_case "quote-blind split FIXED: pipe inside a quoted grep alternation" \
  "grep -n 'pkill as echo arg\\|killall in grep' f.sh" \
  0

test_case "quote-blind split FIXED: pipe inside a quoted echo string" \
  'echo "a|pkill b"' \
  0

test_case "quote-blind split FIXED: pipe in a quoted commit message" \
  'git commit -m "docs: a|pkill b"' \
  0

# CONTROL, paired with the three '|' cases above: pinning the quoted-pipe fix must not mask a
# REAL pipe into the killer -- an unquoted '|' is still a segment boundary, and the killer still
# starts its own segment. (The suite already has three more real-pipe rows in the BLOCK section
# above -- "pkill via xargs pipe" and its xargs-flag variants -- confirmed still 2 here too.)
test_case "CONTROL: real pipe into pkill still blocks" \
  'ps aux | pkill -f node' \
  2

# GENUINELY RED at base, FIXED: the remaining four members of the tr split set (see the group
# comment above) -- '&', backtick, '{', '}' -- each verified in isolation, one character per row.
# Measured at base: all four below exit=2 there (should be 0) -- genuinely RED.
test_case "quote-blind split FIXED: ampersand inside a quoted string" \
  'echo "run job & pkill next"' \
  0

test_case "quote-blind split FIXED: backtick inside a SINGLE-quoted string (literal mention, no substitution)" \
  'git commit -m '"'"'docs: `pkill` is banned'"'"'' \
  0

# The row above's PAYLOAD used to be double-quoted -- a real command substitution
# in real bash, not a mention -- while its NAME described the single-quoted (literal) case. A pin
# certifying ALLOW on a command bash actually executes is a regression against base (which
# correctly blocked this at exit=2) AND a test defending that regression. Verified against real
# bash with a stubbed pkill: the double-quoted form genuinely runs pkill via command substitution
# (bash: `git commit -m "docs: $(pkill)..."` -- backtick and $(...) are equivalent here). Measured
# against 84b7d27 (base): exit=2 there (correct); 4d06be0/6d902e1: exit=0 (regression, silently
# shipped and defended by the row above until this fix). Fixed here, not by widening the escape-
# parity rule (a different mechanism -- shlex has no notion of command substitution at all, quoted
# or not) but by scanning each token's embedded $(...)/backtick spans with the same bare-word
# regex the PARSE_FAILED fallback already uses (see substitution_spans() in the shared analyzer).
test_case "quote-blind split FIXED: backtick inside a DOUBLE-quoted string is a REAL command substitution, must block" \
  'git commit -m "docs: `pkill` is banned"' \
  2

test_case "substitution_spans FIXED: \$(...) form inside a DOUBLE-quoted string is the same defect, must block" \
  'git commit -m "docs: $(pkill) is banned"' \
  2

test_case "quote-blind split FIXED: open brace inside a quoted string" \
  'echo "id=x {pkill y is fine"' \
  0

test_case "quote-blind split FIXED: close brace inside a quoted string" \
  'echo "id=x} pkill y is fine"' \
  0

# CONTROLS, paired with the four cases above: pinning the quoted-&/backtick/brace fixes must not
# mask a REAL use of any of these as an actual shell operator around the killer.
test_case "CONTROL: real single & background operator into pkill" \
  'echo x & pkill node' \
  2

test_case "CONTROL: real backtick command substitution" \
  '`pkill node`' \
  2

test_case "CONTROL: real brace group" \
  '{ pkill node; }' \
  2

# GENUINELY RED at base, FIXED: the old wrapper-word enumeration missed these command-position
# prefixes. Anywhere-in-segment matching needs no enumeration, so all of these are caught the same
# way a bare invocation is. Measured at base: all five below exit=0 there (should be 2) --
# genuinely RED.
test_case "wrapper enumeration gap FIXED: redirection before the command"          ">/dev/null pkill node"              2
test_case "wrapper enumeration gap FIXED: numbered redirection before the command" "2>/dev/null pkill node"             2
test_case "wrapper enumeration gap FIXED: if keyword"                              "if pkill node; then echo x; fi"     2
test_case "wrapper enumeration gap FIXED: while keyword"                           "while pkill node; do sleep 1; done" 2
test_case "wrapper enumeration gap FIXED: pipeline negation"                       "! pkill node"                       2

# REGRESSION GUARDS, not new fixes: binary identity and subshell/substitution fusing were already
# correct at base -- the regex's '/path/' prefix caught the absolute-path case, and the old tr
# split on '(' caught the two parenthesized cases, incidentally. Measured at base: all three below
# already exit=2 there, same as after the port -- not RED, and not evidence the port works. Pinned
# here so the port doesn't regress them.
test_case "inherited: absolute path to the binary"          "/usr/bin/pkill node"               2
test_case "inherited: killer inside subshell parens"        "(pkill node)"                       2
test_case "inherited: killer inside command substitution"   '$(pkill node)'                      2

# Also a REGRESSION GUARD, not a new fix: the old line-blind regex ran against every line of a
# multi-line command, so a heredoc body shaped like a real invocation ("pkill node") matched at
# base too -- for the wrong reason (line-splitting, not understanding it's an interpreter), but
# the outcome was already correct. Measured at base: still exit=2 there -- not RED.
test_case "inherited: interpreter-fed heredoc body is not stripped" \
  'bash <<EOF
pkill node
EOF' \
  2

# NOT a regression guard -- GENUINELY RED at base, FIXED: the same line-blind regex matched
# "pkill node" as its own command line inside this cat heredoc too, false-blocking data that was
# never going to execute. strip_heredocs() now recognizes cat as a data sink with no interpreter
# on the opener line and removes the body before tokenizing. Measured at base: exit=2 there
# (should be 0) -- genuinely RED, unlike the two REGRESSION GUARD heredoc/subshell groups above.
test_case "data-sink heredoc stripping FIXED: body shaped like a real invocation is still just data" \
  'cat <<EOF
pkill node
EOF' \
  0

# Malformed JSON must fail OPEN (allow, exit 0), not hard-exit
malformed_exit=0
echo 'this is not json' | bash "$HOOK_SCRIPT" >/dev/null 2>&1 || malformed_exit=$?
if [[ "$malformed_exit" -eq 0 ]]; then
  echo "PASS: malformed JSON fails open (exit 0)"; PASS=$((PASS + 1))
else
  echo "FAIL: malformed JSON (expected exit 0, got $malformed_exit)"; FAIL=$((FAIL + 1))
fi

# Nothing in the suite pinned the python3 script's fail-open
# posture directly. Two independent mutants, verified one at a time -- each case below is a
# detector for a different defect, not a pair that both catch the same thing:
#   - strip `|| RESULT=""` from the RESULT assignment and remove the `except ValueError:
#     sys.exit(0)` handler: an unparseable command makes the hook exit 1 under `set -e` instead of
#     the intentional decision below. Caught ONLY by the unparseable-command case directly below --
#     exactly one failure, that case alone.
#   - change the python3-absent branch from `RESULT=""` to `RESULT="BLOCK"`, i.e. fail CLOSED
#     instead of open when python3 is missing. Caught ONLY by the missing-python3 case further
#     below -- exactly one failure, that case alone; the unparseable-command case never touches
#     this branch and stays green under this mutant.
#
# This case FLIPS from 0 to 2. The earlier `bash -n` gate
# treated "bash cannot parse the whole command" as "nothing in it can execute" -- false, since
# bash is a streaming parser and runs each complete command as it reads the input; a killer
# followed by an unrelated syntax error genuinely executes. The gate is removed, and the bare-word
# check now applies unconditionally whenever shlex fails to tokenize, so a command that merely
# MENTIONS the word and genuinely cannot run at all (this one -- a bare unterminated quote with
# nothing before it) now blocks too -- the same accepted trade already made for the earlier
# bare-mention cases. Anywhere-in-text fails toward BLOCKING, the accepted price already paid
# throughout this file.
test_case "unparseable command (unbalanced quote) now blocks -- bare word present" \
  "echo 'pkill node" \
  2

# Missing python3 (same shape as the jq-unavailable regression guard in test-dashboard-enter-guard.sh):
# the hook must fail open, not abort under `set -e` or exit 127.
test_missing_python3() {
  local description="python3 unavailable on PATH — fails open (exit 0), not exit 127"
  local tmpbin
  tmpbin=$(mktemp -d)
  local tool src
  for tool in cat grep sed jq bash env printf; do
    src=$(command -v "$tool" 2>/dev/null) || continue
    ln -s "$src" "$tmpbin/$tool"
  done

  # Build the hook's JSON input with the REAL jq (still on this test script's own PATH) -- only the
  # HOOK invocation below runs under the restricted, python3-less PATH.
  local input
  input=$(jq -n --arg cmd "pkill node" '{"tool_input": {"command": $cmd}}')

  local actual_exit=0
  echo "$input" | env -i PATH="$tmpbin" "$tmpbin/bash" "$HOOK_SCRIPT" >/dev/null 2>/dev/null ||
    actual_exit=$?
  rm -rf "$tmpbin"

  if [[ "$actual_exit" -eq 0 ]]; then
    echo "PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description (expected exit 0, got $actual_exit)"
    FAIL=$((FAIL + 1))
  fi
}

# --- FLOW-228: '#' comment-boundary fail-open in the shared
# analyzer, GENUINELY RED at the pre-fix hook -- shlex's default `commenters` stripped '#' to end
# of line from ANYWHERE inside a word, not just where bash itself treats '#' as starting a comment
# (start of line or after whitespace). A mid-word '#' (a URL fragment, a git --grep pattern, any
# prose containing one) silently discarded the real invocation that followed on the same line
# before the segment scan ever ran. Measured against the pre-fix hook (efe2001): exit=0 there
# (should be 2). ---

test_case "'#' fail-open FIXED: URL fragment before the real invocation" \
  "curl http://x#frag; pkill node" \
  2

test_case "'#' fail-open FIXED: mid-word '#' in prose" \
  "echo a#b; pkill node" \
  2

test_case "'#' fail-open FIXED: git --grep pattern containing '#'" \
  "git log --grep=#12; pkill node" \
  2

# CONTROLS, paired with the three cases above: pinning the fail-open fix must not become an
# always-block or always-allow rewrite, and quoting/ordering must stay unaffected.
test_case "CONTROL: quoted '#' unaffected (already correct pre-fix too)" \
  'echo "a#b"; pkill node' \
  2

test_case "CONTROL: killer before the '#' unaffected (already correct pre-fix too)" \
  "pkill node; echo a#b" \
  2

test_case "CONTROL: genuine word-start comment still hides the invocation (matches real bash)" \
  "echo #fff; pkill node" \
  0

# The '#' fix reaches inside an interpreter-fed heredoc body too, not just top-level command text
# -- the pre-pass runs on the heredoc body before tokenizing, same as any other segment. Measured
# against the pre-fix hook: exit=0 there (should be 2).
test_case "'#' fail-open FIXED: mid-word '#' inside an interpreter-fed heredoc body" \
  'bash <<EOF
echo x#frag; pkill node
EOF' \
  2

# --- strip_comments() called is_outside_quotes() PER LINE, which builds a fresh quote stack every
# call -- a quote opened on an earlier physical line was invisible when checking a later one, so a
# '#' inside a multi-line quoted string read as a real (unquoted) comment starter and discarded a
# genuine invocation that followed once the string closed. The earlier '#' cases went green
# while this shipped underneath them, because none of them constructed a quoted string spanning
# a newline. Fixed by evaluating quote state across the WHOLE command with an absolute index
# instead of splitting into lines first.
#
# Prove independently, against REAL bash, that the payload
# below is a genuine live-fire shape -- not just trust the hook's own exit code. The marker is
# substituted for the real (and here, actually dangerous) killer command AT THE SAME POSITION, not
# appended as a separate trailing line, since a trailing line always runs regardless of what
# happened earlier and would prove nothing.
test_bash_ground_truth_multiline_quote() {
  local description="bash ground truth: real bash runs code after a multi-line quoted string closes"
  local output
  output=$(bash -c 'echo "line1
line2 with # here"; echo REAL_MARKER' 2>&1)
  if [[ "$output" == *"REAL_MARKER"* ]]; then
    echo "PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description (bash did NOT run the tail -- the regression cases below may not be live shapes; investigate before trusting them)"
    FAIL=$((FAIL + 1))
  fi
}
test_bash_ground_truth_multiline_quote

test_case "'#' fail-open FIXED (round 8): multi-line double-quoted string, killer after close" \
  'echo "line1
line2 with # here"; pkill node' \
  2

test_case "'#' fail-open FIXED (round 8): multi-line single-quoted string, killer after close" \
  "echo 'line1
line2 with # here'; pkill node" \
  2

test_case "'#' fail-open FIXED (round 8): quote spans lines, '#' and close share the killer's line" \
  'echo "line1
line2 # here" ; pkill node' \
  2

# --- strip_comments() called is_outside_quotes() against the ORIGINAL
# command, so a quote character INSIDE a comment that gets stripped still counted toward quote
# state at a LATER '#' -- bash never lets a stripped comment affect quoting, but this code did.
# `echo a # don't` strips cleanly, but its apostrophe opened a quote for the state computation at
# the second '#'; `# it's` was then NOT stripped (looked "inside quotes"), leaving an unbalanced
# apostrophe that made shlex raise ValueError, and the documented fail-open swallowed the real
# invocation that followed. Fixed by evaluating quote state over the ACCUMULATED OUTPUT kept so
# far, not the original command, so a stripped comment's own characters can never poison a later
# check. The earlier per-line evaluation got this specific shape right by accident; worth recording
# since it means the current code's own accidental correctness is not something to assume away
# next time either.
test_bash_ground_truth_apostrophe_in_comment() {
  local description="bash ground truth: an apostrophe inside a stripped comment does not affect a later comment or the code that follows"
  local output
  output=$(bash -c "echo a # don't
echo b # it's
echo REAL_MARKER" 2>&1)
  if [[ "$output" == *"REAL_MARKER"* ]]; then
    echo "PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description (bash did NOT run the tail -- the regression case below may not be a live shape; investigate before trusting it)"
    FAIL=$((FAIL + 1))
  fi
}
test_bash_ground_truth_apostrophe_in_comment

test_case "'#' fail-open FIXED (round 9): apostrophe inside an earlier stripped comment" \
  "echo a # don't
echo b # it's
pkill node" \
  2

test_missing_python3

# --- FLOW-228: an interpreter-fed heredoc whose body
# contains an unbalanced quote made the WHOLE command unparseable by shlex, and the pre-existing
# fail-open unconditionally allowed -- but bash itself parses and RUNS this shape (the heredoc
# body is data to bash's own parser, apostrophe and all), so the real invocation on the line after
# genuinely executed. Fixed by applying this hook's own bare-word check to the raw
# command whenever shlex fails to tokenize -- unconditionally (an earlier
# `bash -n` gate here was tried and removed once its premise was found broken by bash being
# a streaming parser; see `test_bash_ground_truth_partial_execution` for the full story). Measured against the hook before this fix: exit=0
# there (should be 2).
#
# Bash-ground-truth self-check, same pattern as the '#' rounds: the real killer is substituted for
# a harmless marker AT THE SAME POSITION, not appended as a trailing line, and run through REAL
# bash to prove the payload is genuinely live-fire before any hook-exit-code assertion is trusted.
test_bash_ground_truth_heredoc_apostrophe() {
  local description="bash ground truth: a heredoc body containing an apostrophe does not prevent the line after it from running"
  local output
  output=$(bash -c "bash <<EOF
don't
EOF
echo REAL_MARKER" 2>&1)
  if [[ "$output" == *"REAL_MARKER"* ]]; then
    echo "PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description (bash did NOT run the line after the heredoc -- the regression case below may not be a live shape; investigate before trusting it)"
    FAIL=$((FAIL + 1))
  fi
}
test_bash_ground_truth_heredoc_apostrophe

test_case "Finding B FIXED: heredoc body with an apostrophe no longer hides the real invocation" \
  "bash <<EOF
don't
EOF
pkill node" \
  2

test_case "Finding B: parse-failure fallback with no guarded token present stays allowed" \
  "wc -l <<EOF
don't
EOF
echo hi" \
  0

# This case FLIPS from 0 to 2, same reason and same
# command as the mutant-detector case near the top of this file -- the earlier `bash -n` gate is
# removed (its premise was wrong: bash is a streaming parser, so "cannot parse the whole thing"
# does not mean "nothing in it can execute"), and the bare-word check now applies unconditionally
# on any parse failure. A command that only MENTIONS the word and genuinely cannot run at all now
# blocks too, the same accepted trade already made for the earlier bare-mention cases.
test_case "Finding B round-12 correction: the old pin now blocks -- bare word present" \
  "echo 'pkill node" \
  2

# Partial execution -- the exact shape that falsified the earlier `bash -n`
# gate. bash is a STREAMING parser: it executes each complete command as it reads the input, so a
# real invocation on an early line runs even though a later, unrelated syntax error makes the
# WHOLE command unparseable by both shlex and `bash -n`. Measured against the hook before this fix
# (8b06cb7, still carrying the `bash -n` gate): exit=0 there (should be 2) -- the gate saw
# "unparseable" and allowed, while bash itself already ran the killer.
test_bash_ground_truth_partial_execution() {
  local description="bash ground truth: a real command on an early line executes even though a later line has an unrelated syntax error"
  local output
  # The inner bash -c intentionally hits a syntax error (that's the point -- proving bash still
  # ran the line before it) and so exits non-zero; `|| true` keeps that from tripping `set -e` in
  # this test script itself.
  output=$(bash -c 'echo REAL_MARKER
echo ok
echo "unterminated' 2>&1) || true
  if [[ "$output" == *"REAL_MARKER"* ]]; then
    echo "PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description (bash did NOT run the early line -- the regression cases below may not be live shapes; investigate before trusting them)"
    FAIL=$((FAIL + 1))
  fi
}
test_bash_ground_truth_partial_execution

test_case "Finding B round-12 FIXED: killer on line 1, syntax error on line 2" \
  "pkill node
echo \"unterminated" \
  2

test_case "Finding B round-12 FIXED: killer on line 1, syntax error further down" \
  "pkill node
echo ok
echo \"unterminated" \
  2

test_case "Finding B round-12 CONTROL: no killer anywhere, syntax error present, still allowed" \
  "echo ok
echo \"unterminated" \
  0

# See test-dashboard-enter-guard.sh for the full bash-ground-truth story.
# Measured against 6a556a8: exit=2 there (should be 0).
test_case "CodeRabbit finding 4 FIXED: a real bash comment right after ';' no longer misreads as a real pkill" \
  "echo ok;#comment: pkill node
echo done" \
  0

# See test-no-verify-guard.sh for the full escape-blindness story. Measured against
# 4d06be0: exit=0 (fail-open) there; must be exit=2 here.
test_case "Round 15 FIXED: escaped semicolon before '#' does not hide a real pkill" \
  "echo a \\;#c ; pkill node
echo REAL_DONE" \
  2

# A third escape-blind site, independent of the two escape-blind sites already fixed. An escaped
# '<' right before '<<' ('\<<EOF') is a literal
# character in real bash, not a heredoc opener at all -- confirmed against real bash for
# backslash counts 0-4 -- so the lines that follow are never absorbed as a heredoc body; they run
# as ordinary, separate commands. is_outside_quotes() answers a DIFFERENT question (is this
# position inside a quote) and correctly says "outside" here, since there is no quoting in play at
# all -- escaping the '<<' operator itself is a separate axis strip_heredocs() was not checking,
# so it read the escaped opener as a live heredoc and DELETED the real invocation that followed,
# before the tokenizer ever ran. No parse failure, no fallback -- nothing reaches the token stream
# at all. Measured against 6d902e1 (the HEAD right after the earlier escape-blindness fix, not an
# older commit -- this defect survives that fix entirely): exit=0 (fail-open) there; must be exit=2 here.
test_case "Round 16 FIXED: escaped '<' before '<<' no longer misreads as a real heredoc opener, killer stays visible" \
  "cat \\<<EOF
pkill -f node
EOF" \
  2

test_case "Round 16 CONTROL: an EVEN (2) backslash run before '<<' is a real (unescaped) heredoc opener, body still stripped" \
  "cat \\\\<<EOF
pkill -f node
EOF" \
  0

test_case "Round 16 FIXED: an ODD (3) backslash run before '<<' is still escaped, killer stays visible" \
  "cat \\\\\\<<EOF
pkill -f node
EOF" \
  2

test_case "Round 16 CONTROL: a real (unquoted, unescaped) heredoc still strips its body, no killer inside" \
  "cat <<EOF
echo hi
EOF" \
  0

# A fifth escape-blind site, independent of the four already closed. line_fragments() split the raw opener line on anything
# outside [A-Za-z0-9_./], quote- and escape-blind by construction -- an interpreter name broken by
# a backslash ('b\ash') or a quote ('"b"ash') disintegrated into fragments matching nothing in
# INTERPRETERS, so line_has_interpreter() read the opener line as consumer-free and
# strip_heredocs() deleted the body as inert data while bash pipes that same body to a real
# interpreter that runs it. Confirmed against real bash for both shapes. Measured against b14731c
# (the prior HEAD before this fix, not an older commit -- this defect survives every fix so far):
# exit=0 (fail-open) there; must be exit=2 here.
test_case "Round 17 FIXED: a backslash-split interpreter name no longer hides a real invocation" \
  "cat <<EOF | b\\ash
pkill -f node
EOF" \
  2

test_case "Round 17 FIXED: a quote-split interpreter name no longer hides a real invocation" \
  'cat <<EOF | "b"ash
pkill -f node
EOF' \
  2

test_case "Round 17 CONTROL: 'cat' inside \$(...) is still recognized as a data sink through the structured (non-fallback) path even though the opener line's own dquote never closes on that line -- the documented, still-legitimate multi-line-construct trade-off, unbroken by this round's fix" \
  'echo "$(cat <<EOF
pkill -f node
EOF
)"' \
  0

test_case "Round 17 CONTROL: a plain, unsplit interpreter name still catches its heredoc body" \
  "cat <<EOF | bash
pkill -f node
EOF" \
  2


# INTERPRETERS is a fixed enumeration and cannot be
# completed against a value only known at runtime. $SHELL / ${CMD} / a substitution used as the
# heredoc consumer or pipeline target reads as "not a known interpreter" and the body was stripped
# as inert data, even though bash resolves it to a real interpreter and executes the body for
# real. Confirmed against real bash for all nine forms below (backslash counts and quote forms
# don't apply here -- this is about the WORD being opaque, not escaped). Measured against b14731c:
# exit=0 (fail-open) for every Corpus A row; must be exit=2 here.

test_case "Round 19 FIXED: \$SHELL as pipeline target" \
  "cat <<EOF | \$SHELL
pkill -f node
EOF" \
  2

test_case "Round 19 FIXED: \${SHELL} as pipeline target" \
  'cat <<EOF | ${SHELL}
pkill -f node
EOF' \
  2

test_case "Round 19 FIXED: quoted \"\$SHELL\" as pipeline target" \
  'cat <<EOF | "$SHELL"
pkill -f node
EOF' \
  2

test_case "Round 19 FIXED: \$CMD (arbitrary variable) as pipeline target" \
  'cat <<EOF | $CMD
pkill -f node
EOF' \
  2

test_case "Round 19 FIXED: \$CMD with an argument as pipeline target" \
  'cat <<EOF | $CMD -s
pkill -f node
EOF' \
  2

test_case "Round 19 FIXED: \$X (short variable name) as pipeline target" \
  'cat <<EOF | $X
pkill -f node
EOF' \
  2

test_case "Round 19 FIXED: \${X} as pipeline target" \
  'cat <<EOF | ${X}
pkill -f node
EOF' \
  2

test_case "Round 19 FIXED: \$(...) substitution as pipeline target" \
  'cat <<EOF | $(get_shell)
pkill -f node
EOF' \
  2

test_case "Round 19 FIXED: backtick substitution as pipeline target" \
  'cat <<EOF | `get_shell`
pkill -f node
EOF' \
  2

# Corpus B: seven legitimate cat-heredoc shapes that carry an expansion OUTSIDE consumer position
# (a redirect target or path, or a leading VAR=value assignment before the real consumer). None
# has an expansion in consumer position, so line_has_interpreter()'s opaque-expansion check must never
# read one of these as a kill -- measured against real bash directly before writing this suite, not
# reasoned from the mechanism alone; a first, unproven, wider version of this fix (keying on "any
# unresolvable expansion anywhere on the opener line") would have false-blocked all seven. The six
# that redirect into a file are now blocked as heredocs written to a file, so each asserts that
# message, which only prints when the kill check passed.

test_case "Round 19 CONTROL: expansion in a double-quoted redirect target, not consumer position" \
  'cat <<EOF > "$FILE"
echo hi
EOF' \
  2 "$HEREDOC_FILE"

test_case "Round 19 CONTROL: expansion in an append-redirect target" \
  'cat <<EOF >> $LOG
echo hi
EOF' \
  2 "$HEREDOC_FILE"

test_case "Round 19 CONTROL: braced expansion in a redirect target" \
  'cat <<EOF > ${DIR}/f
echo hi
EOF' \
  2 "$HEREDOC_FILE"

test_case "Round 19 CONTROL: substitution inside a redirect target filename" \
  'cat <<EOF > out-$(date +%s).txt
echo hi
EOF' \
  2 "$HEREDOC_FILE"

test_case "Round 19 CONTROL: expansion mid-path in a redirect target" \
  'cat <<EOF > /tmp/$USER.txt
echo hi
EOF' \
  2 "$HEREDOC_FILE"

test_case "Round 19 CONTROL: expansion in a leading VAR=value assignment before the real consumer" \
  'EDITOR=$CMD cat <<EOF > f
echo hi
EOF' \
  2 "$HEREDOC_FILE"

test_case "Round 19 CONTROL: no expansion anywhere, baseline" \
  'cat <<EOF
echo hi
EOF' \
  0

# Three rows that already blocked before this fix, for a DIFFERENT and unrelated reason -- kept
# separate from the evidence above and pinned with the reason stated, not counted as coverage of
# the opaque-expansion check.
test_case "Round 19 NOTE: \$(command -v bash) already blocked pre-round-19 because its literal TEXT contains \"bash\" -- also now caught by the round-19 mechanism (consumer position is opaque), but this row does not prove the mechanism alone" \
  'cat <<EOF | $(command -v bash)
pkill -f node
EOF' \
  2

test_case "Round 19 NOTE: \$SHELL <<EOF with no data-sink on the line already declined to strip pre-round-19 (line_has_data_sink is False, so strip_heredocs never reaches the interpreter check) -- unrelated to the round-19 mechanism" \
  '$SHELL <<EOF
pkill -f node
EOF' \
  2


# raw_substitution_spans()'s ACCEPTED OVER-BLOCK, measured and pinned
# rather than left implicit -- see its own comment for the full trade and the rejected recursive
# alternative. A substitution that only MENTIONS the guarded word in data it reads/searches, never
# executes it, now blocks the same as a real invocation. Deliberate; pinned so a later reader sees
# it was chosen, not missed.

test_case "Round 20 ACCEPTED OVER-BLOCK: a filename mentioning the guarded word inside a substitution, never executed" \
  'echo "$(cat /tmp/pkill-notes.txt)"' \
  2

test_case "Round 20 ACCEPTED OVER-BLOCK: a grep pattern mentioning the guarded word inside a substitution, never executed" \
  'echo "$(grep pkill /var/log/x.log)"' \
  2

test_case "Round 20 ACCEPTED OVER-BLOCK: a git log --grep search mentioning the guarded word inside a substitution, never executed" \
  'echo "$(git log --grep=pkill)"' \
  2

test_case "Round 20 CONTROL: substitution genuinely executing the guarded word still blocks" \
  'echo "$(pkill -f node)"' \
  2

test_case "Round 20 CONTROL: substitution with no guarded word anywhere still allows" \
  'echo "$(cat /tmp/notes.txt)"' \
  0


# consumer_words()'s WRAPPER skip. A NAMED interpreter is caught
# anywhere on the opener line, but the earlier opaque-consumer check looked only at the FIRST word
# of each pipeline stage -- 'env' is neither a known interpreter nor itself opaque, so
# 'cat <<EOF | env $CMD' walked straight through without ever inspecting '$CMD'. Same interpreter,
# same pipeline stage, opposite verdict from 'cat <<EOF | env bash', decided only by whether the
# name happened to be spelled out. Confirmed against real bash. Measured against 3908cdc (the HEAD
# right after the earlier opaque-consumer fix): exit=0 (fail-open) for the two FIXED rows; must be exit=2 here.

test_case "Round 21 FIXED: env wrapping an opaque variable as pipeline target" \
  "cat <<EOF | env \$CMD
pkill -f node
EOF" \
  2

test_case "Round 21 FIXED: nohup wrapping an opaque variable as pipeline target" \
  "cat <<EOF | nohup \$CMD
pkill -f node
EOF" \
  2

test_case "Round 21 CONTROL: xargs was already correct pre-round-21 (xargs is itself a named interpreter)" \
  "cat <<EOF | xargs \$CMD
pkill -f node
EOF" \
  2

test_case "Round 21 CONTROL: env wrapping a NAMED interpreter was already correct pre-round-21" \
  "cat <<EOF | env bash
pkill -f node
EOF" \
  2

# $SHELL is populated in every environment, including a bare `env -i`, so this payload really runs
# the killer; $CMD is unset in nearly every environment and would leave `timeout 5` with no command.
test_case "Round 21 a wrapper's own argument (timeout's duration) does not hide the opaque consumer behind it" \
  "cat <<EOF | timeout 5 \$SHELL
pkill -f node
EOF" \
  2 "$HEREDOC_INTERPRETER"

# --- Unresolvable deletions, heredocs, and what stays allowed ---
#
# Each row tags its class in brackets so one class runs alone: ONLY="[heredoc-file]" bash <this file>.
# A block row passes its class's BLOCKED: line as the fourth argument, so a row blocked for the
# wrong reason fails.

test_case "[deletion-operand] quoted variable target" 'rm -rf "$DIR"' 2 "$DELETION"
test_case "[deletion-operand] variable path prefix, logged shape" 'rm -f $S/sw15-ids.txt' 2 "$DELETION"
test_case "[deletion-operand] cd then bare glob, logged shape" 'mkdir -p $SP/p && cd $SP/p && rm -rf * && unzip -q x.zip' 2 "$DELETION"
test_case "[deletion-operand] relative glob, logged shape" 'cd /tmp/run2 && rm -f ./*' 2 "$DELETION"
test_case "[deletion-operand] braced variable" 'rm -rf ${HOME}/x' 2 "$DELETION"
test_case "[deletion-operand] quoted command substitution as the target" 'rm -rf "$(mktemp -d)"' 2 "$DELETION"
test_case "[deletion-operand] backtick substitution in the target" 'rm -rf `pwd`/x' 2 "$DELETION"
test_case "[deletion-operand] root" 'rm -rf /' 2 "$DELETION"
test_case "[deletion-operand] bare home" 'rm -rf ~' 2 "$DELETION"
test_case "[deletion-operand] current directory with a trailing slash" 'rm -rf ./' 2 "$DELETION"
test_case "[deletion-operand] parent directory" 'rm -rf ..' 2 "$DELETION"
test_case "[deletion-operand] behind sudo" 'sudo rm -rf $X' 2 "$DELETION"
test_case "[deletion-operand] inside an if" 'if true; then rm -f $X; fi' 2 "$DELETION"
test_case "[deletion-operand] inside a subshell" '(rm -f $X)' 2 "$DELETION"
test_case "[deletion-operand] after a leading redirect" '2>/dev/null rm -f $X' 2 "$DELETION"
test_case "[deletion-operand] by absolute binary path" '/bin/rm -f $X' 2 "$DELETION"
test_case "[deletion-operand] rmdir in a loop, logged shape" 'for r in a b; do rmdir -p $r/x; done' 2 "$DELETION"
test_case "[deletion-parse-failure] an rm in a command shlex cannot split still blocks" 'rm -f $X "unterminated' 2 "$DELETION"
test_case "[deletion-substitution] rm inside \$(...)" 'echo $(rm -f /tmp/a)' 2 "$DELETION"
test_case "[deletion-substitution] rm inside backticks" 'x=`rm /tmp/a`' 2 "$DELETION"
test_case "[deletion-substitution] unquoted-delimiter heredoc body still runs its substitution" "cat <<EOF
\$(rm -f /tmp/a)
EOF" 2 "$DELETION"
test_case "[deletion-proxy] rm in a bash -c script" "bash -c 'rm -rf /tmp/a'" 2 "$DELETION"
test_case "[deletion-proxy] rm in an sh -lc script" 'sh -lc "rm /tmp/a"' 2 "$DELETION"
test_case "[deletion-proxy] xargs rm" "find . -name '*.pyc' | xargs rm -f" 2 "$DELETION"
test_case "[deletion-proxy] find -exec rm" 'find . -name x -exec rm {} +' 2 "$DELETION"
test_case "[deletion-proxy] find -delete" 'find /tmp/x -type f -delete' 2 "$DELETION"

test_case "[heredoc-file] cat into a variable path, logged shape" "cat > \$S/pairs.txt <<'EOF'
a b
EOF" 2 "$HEREDOC_FILE"
test_case "[heredoc-file] cat appending to a file, logged shape" "cat >> /tmp/notes.md <<'EOF'
x
EOF" 2 "$HEREDOC_FILE"
test_case "[heredoc-file] redirect after the opener" 'cat <<EOF > out.txt
x
EOF' 2 "$HEREDOC_FILE"
test_case "[heredoc-file] tee with a heredoc" 'tee /tmp/x <<EOF
y
EOF' 2 "$HEREDOC_FILE"
test_case "[heredoc-file] cat heredoc piped to tee" 'cat <<EOF | tee -a f
y
EOF' 2 "$HEREDOC_FILE"

test_case "[heredoc-interpreter] python3 stdin script, logged shape" "python3 - <<'EOF'
import re
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[heredoc-interpreter] python3 after a cd, logged shape" "cd \$D && python3 - <<'EOF'
p=1
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[heredoc-interpreter] node" "node <<'EOF'
console.log(1)
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[heredoc-interpreter] bash, ahead of the deletion in its body" 'bash <<EOF
rm -rf $X
EOF' 2 "$HEREDOC_INTERPRETER"
test_case "[heredoc-interpreter] cat heredoc piped to bash" 'cat <<EOF | bash
ls
EOF' 2 "$HEREDOC_INTERPRETER"

test_case "[closing-line] a block ends by naming what not to do" 'rm -rf "$DIR"' 2 "$DELETION"
test_case "[allowed-delete] literal absolute directory" 'rm -rf /srv/work/x/.worktrees/tmp/FLOW-359-red' 0
test_case "[allowed-delete] literal relative file" 'rm -f build/out.txt' 0
test_case "[allowed-delete] literal dot-relative directory" 'rm -rf ./build' 0
test_case "[allowed-delete] operand after --" 'rm -- -weird-name' 0
test_case "[allowed-delete] redirect targets are not operands" 'rm -f a.txt > /dev/null 2>&1' 0
test_case "[allowed-other] git rm with a variable" 'git rm --cached $f' 0
test_case "[allowed-other] git worktree remove" 'git worktree remove .worktrees/tmp/x' 0
test_case "[allowed-other] git rm inside a substitution" 'echo $(git rm --cached a)' 0
test_case "[allowed-other] docker --rm is not rm" 'docker run --rm image' 0
test_case "[allowed-other] rm as a grep pattern is not at command position" 'grep -rn rm src/' 0
test_case "[allowed-other] quoted mention" 'echo "rm -rf $X is bad"' 0
test_case "[allowed-other] find without -delete" "find . -name '*.md'" 0
test_case "[allowed-heredoc] commit idiom whose body names every blocked shape" "git commit -m \"\$(cat <<'EOF'
feat: [FLOW-359] block \`rm -rf \$X\` and cat <<EOF > f

Also python3 - <<EOF (with parens) and \$(rm x).
EOF
)\"" 0
test_case "[allowed-heredoc] heredoc PR body piped to --body-file -" "cat <<'EOF' | gh pr create --title t --body-file -
Use \`rm -rf \$DIR\` never; \$(rm x)
EOF" 0
test_case "[allowed-other] heredoc to stderr" 'cat >&2 <<EOF
hello
EOF' 0
test_case "[allowed-other] quoted heredoc mention" "echo 'cat <<EOF > f'" 0
test_case "[allowed-other] heredoc in a comment" '# cat <<EOF > f
ls' 0
test_case "[allowed-other] printf appending to a file is not a heredoc" "printf '%s' hi >> \$D/pr-body.md" 0
test_case "[allowed-other] targeted kill" 'kill 55093' 0

test_case "[allowed-substitution] unquoted commit idiom whose prose says rm" "git commit -m \"\$(cat <<EOF
chore: rm dead code
EOF
)\"" 0
test_case "[allowed-substitution] a subcommand named rm after git -C" 'echo $(git -C repo rm --cached a)' 0
test_case "[allowed-substitution] a package manager subcommand named rm" 'x=$(pnpm rm left-pad)' 0

test_case "[allowed-quoted-body] backticked heredoc mention in a gh body" "gh issue create --body-file - <<'EOF'
Use \`cat <<EOF > f\` never
EOF" 0
test_case "[allowed-quoted-body] rm in the prose of a gh body" "gh issue create --body-file - <<'EOF'
rm -rf \$X is what we block
EOF" 0
test_case "[allowed-quoted-body] an apostrophe in the body of git commit -F -" "git commit -F - <<'EOF'
Don't rm the file
it's rm time
EOF" 0

test_case "[allowed-downstream-redirect] capture on a later pipeline stage" "cat <<'EOF' | gh api repos/o/r/issues --input - > \"\$OUT\" 2>&1; rc=\$?
{}
EOF" 0
test_case "[allowed-downstream-redirect] capture of gh issue create" "cat <<'EOF' | gh issue create --body-file - > /tmp/out.txt 2>&1
body
EOF" 0

test_case "[allowed-quoted-arg] an interpreter name inside a quoted title" "cat <<'EOF' | gh issue create --title \"python3 support\" --body-file -
body
EOF" 0

test_case "[wrapper-consumer] timeout duration before bash" "timeout 10 bash <<'EOF'
rm -rf \"\$X\"
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[wrapper-consumer] sudo -u user before python3" "sudo -u root python3 <<'EOF'
print(1)
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[wrapper-consumer] nice -n before bash" "nice -n 5 bash <<'EOF'
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[wrapper-consumer] cat heredoc piped to timeout sh" "cat <<'EOF' | timeout 5 sh
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[wrapper-consumer] cat heredoc piped to sudo -u tee" "cat <<'EOF' | sudo -u x tee /etc/f
y
EOF" 2 "$HEREDOC_FILE"
test_case "[wrapper-consumer] bash after then" "if true; then bash <<'EOF'
ls
EOF
fi" 2 "$HEREDOC_INTERPRETER"
test_case "[wrapper-consumer] bash after a negation" "! bash <<'EOF'
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[wrapper-consumer] bash inside a group fed the heredoc" "{ bash; } <<'EOF'
ls
EOF" 2 "$HEREDOC_INTERPRETER"

test_case "[substitution-heredoc] python3 heredoc inside a commit body substitution" "git commit -F - <<EOF
\$(python3 <<'IN'
print(1)
IN
)
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[substitution-heredoc] python3 heredoc inside a cat body substitution" "cat <<EOF
\$(python3 <<'IN'
print(1)
IN
)
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[substitution-heredoc] file-writing heredoc inside a cat body substitution" "cat <<EOF
\$(cat <<'IN' > /tmp/f
x
IN
)
EOF" 2 "$HEREDOC_FILE"

test_case "[connected-word] caffeinate -i before bash, deletion in the body" "caffeinate -i bash <<'EOF'
rm -rf \"\$X\"
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[connected-word] arch -arm64 before bash" "arch -arm64 bash <<'EOF'
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[connected-word] xcrun before python3" "xcrun python3 <<'EOF'
print(1)
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[connected-word] taskset before bash" "taskset 1 bash <<'EOF'
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[connected-word] chrt before bash" "chrt 5 bash <<'EOF'
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[connected-word] script before bash" "script -q /dev/null bash <<'EOF'
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[connected-word] cat heredoc piped to caffeinate bash" "cat <<'EOF' | caffeinate bash
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[connected-word] cat heredoc piped to docker exec sh" "cat <<'EOF' | docker exec -i c sh
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[connected-word] cat heredoc piped to caffeinate tee" "cat <<'EOF' | caffeinate tee /tmp/f
y
EOF" 2 "$HEREDOC_FILE"
test_case "[connected-word] arch before tee" "arch -arm64 tee /tmp/f <<'EOF'
y
EOF" 2 "$HEREDOC_FILE"
test_case "[connected-word] bash in a while body, heredoc on done" "while read x; do bash; done <<'EOF'
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[connected-word] bash after a case pattern" "case x in x) bash <<'EOF'
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[connected-word] bash in a function keyword body" "function f { bash <<'EOF'
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[connected-word] coproc bash" "coproc bash <<'EOF'
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[connected-word] builtin eval" "builtin eval \"\$(cat)\" <<'EOF'
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[connected-word] a function defined to run bash, then called" "f() { bash; }; f <<'EOF'
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[connected-word] bash in a compound after a pipe" "cat <<'EOF' | if true; then bash; fi
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[connected-word] cat that is not first in the group" "{ echo hi; cat > /tmp/f; } <<'EOF'
y
EOF" 2 "$HEREDOC_FILE"
test_case "[connected-word] bash in a multi-line group" "{
bash
} <<'EOF'
ls
EOF" 2 "$HEREDOC_INTERPRETER"
test_case "[connected-word] an unquoted interpreter word as an argument fails closed" "cat <<'EOF' | gh issue create --title python3 --body-file -
body
EOF" 2 "$HEREDOC_INTERPRETER"

test_case "[connected-word] a variable in an earlier command does not change a file heredoc's class" "S=/tmp/x; mkdir -p \$S; cat > \$S/p.txt <<'EOF'
y
EOF" 2 "$HEREDOC_FILE"

test_case "[whole-command] bash -c fed by a heredoc substitution" $'bash -c "$(cat <<\'EOF\'\nrm -rf "$X"\nEOF\n)"' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] python3 -c fed by a heredoc substitution" $'python3 -c "$(cat <<\'EOF\'\nprint(1)\nEOF\n)"' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] perl -e fed by a heredoc substitution" $'perl -e "$(cat <<\'EOF\'\nprint 1\nEOF\n)"' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] node -e fed by a heredoc substitution" $'node -e "$(cat <<\'EOF\'\nconsole.log(1)\nEOF\n)"' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] eval of a heredoc substitution" $'eval "$(cat <<\'EOF\'\nrm -rf "$X"\nEOF\n)"' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] bash fed a here-string holding a heredoc substitution" $'bash <<<"$(cat <<\'EOF\'\nrm -rf "$X"\nEOF\n)"' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] a group piped to bash" $'{ cat <<\'EOF\'; } | bash\nrm -rf "$X"\nEOF' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] a subshell piped to bash" $'( cat <<\'EOF\'; ) | bash\nrm -rf "$X"\nEOF' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] an if piped to bash" $'if true; then cat <<\'EOF\'; fi | bash\nrm -rf "$X"\nEOF' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] a multi-line group piped to bash" $'{\ncat <<\'EOF\'\nrm -rf "$X"\nEOF\n} | bash' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] a pipe continued after the body" $'cat <<\'EOF\' |\nrm -rf "$X"\nEOF\nbash' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] a function piped into" $'f() { bash; }; cat <<\'EOF\' | f\nrm -rf "$X"\nEOF' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] a function called after a negation" $'f() { bash; }; ! f <<\'EOF\'\nrm -rf "$X"\nEOF' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] a function called inside the group fed the heredoc" $'f() { bash; }; { f; } <<\'EOF\'\nrm -rf "$X"\nEOF' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] a multi-line function piped into" $'f() {\n bash\n}\ncat <<\'EOF\' | f\nrm -rf "$X"\nEOF' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] a quoted variable as the consumer" $'"$SHELL" <<\'EOF\'\nrm -rf "$X"\nEOF' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] a quoted variable as the pipe target" $'cat <<\'EOF\' | "$SHELL"\nrm -rf "$X"\nEOF' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] a quoted variable after timeout" $'timeout 5 "$SHELL" <<\'EOF\'\nrm -rf "$X"\nEOF' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] a variable inside the group fed the heredoc" $'{ $SHELL; } <<\'EOF\'\nrm -rf "$X"\nEOF' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] a variable in a while body" $'while read l; do $SHELL; done <<\'EOF\'\nrm -rf "$X"\nEOF' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] a variable in a compound after a pipe" $'cat <<\'EOF\' | if true; then $SHELL; fi\nrm -rf "$X"\nEOF' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] bash inside a process substitution" $'cat <<\'EOF\' | tee >(bash)\nrm -rf "$X"\nEOF' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] source of stdin" $'source /dev/stdin <<\'EOF\'\nrm -rf "$X"\nEOF' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] dot of stdin" $'. /dev/stdin <<\'EOF\'\nrm -rf "$X"\nEOF' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] sudo -s reading a script" $'sudo -s <<\'EOF\'\nrm -rf "$X"\nEOF' 2 "$DELETION"
test_case "[whole-command] su reading a script" $'su root <<\'EOF\'\nrm -rf "$X"\nEOF' 2 "$DELETION"
test_case "[whole-command] ssh reading a script" $'ssh host <<\'EOF\'\nrm -rf "$X"\nEOF' 2 "$DELETION"
test_case "[whole-command] cd to a variable before a commit heredoc names git -C" $'cd "$WT" && git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)"' 2 "$HEREDOC_INTERPRETER"
test_case "[whole-command] an unallowlisted consumer's body is scanned" $'kubectl apply -f - <<\'EOF\'\nrm -rf "$X"\nEOF' 2 "$DELETION"
for shell_name in fish csh tcsh awk gawk php lua osascript deno bun; do
  test_case "[whole-command] $shell_name reading a heredoc" "$shell_name <<'EOF'
ls
EOF" 2 "$HEREDOC_INTERPRETER"
done

test_case "[allowed-idiom] a bare cat heredoc whose body names every blocked shape" $'cat <<\'EOF\'\nrm -rf "$X"; bash; cat <<E > f\nEOF' 0
test_case "[allowed-idiom] a cat heredoc to stderr whose body names a deletion" $'cat <<\'EOF\' >&2\nrm -rf "$X"\nEOF' 0
test_case "[allowed-idiom] gh pr create with a python title and a hostile body" $'gh pr create --title "Support python" --body-file - <<\'EOF\'\nbody\nrm -rf "$X"\nEOF' 0
test_case "[allowed-idiom] git -C a variable commit with a substituted heredoc message" $'git -C "$WT" commit -m "$(cat <<\'EOF\'\nfeat: add bash support\nEOF\n)"' 0
test_case "[allowed-idiom] git -C a variable commit -F - with a hostile body" $'git -C "$WT" commit -F - <<\'EOF\'\nrm -rf "$X"\nEOF' 0
test_case "[allowed-idiom] dashboard item add with a hostile substituted body" $'dashboard item add --body "$(cat <<\'EOF\'\nexec bash\nrm -rf "$X"\nEOF\n)"' 0
test_case "[allowed-idiom] git commit -F - with a hostile body" $'git commit -F - <<\'EOF\'\nrm -rf "$X"; bash; cat <<E > f\nEOF' 0

deep_delete='rm -f /tmp/a'
deep_heredoc=$'python3 <<\'IN\'\nprint(1)\nIN'
for level in $(seq 1100); do
  deep_delete="echo \$($deep_delete)"
  deep_heredoc=$'cat <<E'"$level"$'\n$('"$deep_heredoc"$'\n)\nE'"$level"
done
test_case "[deep-nesting] a deletion 1100 substitutions deep still blocks" "$deep_delete" 2 "$DELETION"
test_case "[deep-nesting] an interpreter heredoc 1100 substitutions deep still blocks" "$deep_heredoc" 2 "$HEREDOC_INTERPRETER"

echo
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ -n "${ONLY:-}" && "$MATCHED" -eq 0 ]]; then
  echo "No test description contains ONLY=\"$ONLY\""
  exit 1
fi

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
