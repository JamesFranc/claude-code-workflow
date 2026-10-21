#!/bin/bash
# Test script for pr-title-guard.sh
# Simulates hook input and verifies expected outcomes

set -euo pipefail

HOOK_SCRIPT="$(dirname "$0")/pr-title-guard.sh"
PASS=0
FAIL=0

test_case() {
  local description="$1"
  local command="$2"
  local expected_exit="$3"  # 0 = allow, 2 = block
  local expected_message="${4:-}"  # optional substring that must appear on stderr (exit code
                                    # alone can't distinguish "blocked for the right
                                    # reason" from "blocked for the wrong reason")

  # Build the JSON input that the hook expects
  local input
  input=$(jq -n --arg cmd "$command" '{"tool_input": {"command": $cmd}}')

  local actual_exit=0 stderr_output
  stderr_output=$(echo "$input" | bash "$HOOK_SCRIPT" 2>&1 1>/dev/null) || actual_exit=$?

  if [[ "$actual_exit" -ne "$expected_exit" ]]; then
    echo "FAIL: $description (expected exit $expected_exit, got $actual_exit)"
    FAIL=$((FAIL + 1))
    return
  fi

  if [[ -n "$expected_message" ]] && [[ "$stderr_output" != *"$expected_message"* ]]; then
    echo "FAIL: $description (exit $actual_exit matched, but stderr did not contain '$expected_message': $stderr_output)"
    FAIL=$((FAIL + 1))
    return
  fi

  echo "PASS: $description"
  PASS=$((PASS + 1))
}

echo "=== PR Title Guard Tests ==="
echo

# --- Should ALLOW (valid titles) ---

test_case "Double-quoted title with bracket ticket" \
  "gh pr create --draft --title \"feat: [FLOW-37] add attribution to PR replies\" --body \"body text\"" \
  0

test_case "Single-quoted title with bracket ticket" \
  "gh pr create --draft --title 'feat: [FLOW-41] add merge conflict detection' --body 'body'" \
  0

test_case "Title with heredoc body before it" \
  "gh pr create --draft --body \"\$(cat <<'EOF'
## Summary
Some body text
EOF
)\" --title \"feat: [FLOW-40] add merge-readiness detection\"" \
  0

test_case "Title with equals form double-quoted" \
  "gh pr create --draft --title=\"fix: [DEV-3179] split archive write path\"" \
  0

test_case "Title with equals form single-quoted" \
  "gh pr create --draft --title='fix: [DEV-3190] fix truncation bug'" \
  0

test_case "Title with scope and ticket" \
  "gh pr create --draft --title \"feat(api): [DEV-456] add pagination support\"" \
  0

test_case "Title without ticket" \
  "gh pr create --draft --title \"feat: add user authentication\"" \
  0

test_case "Title with multiple digits in ticket" \
  "gh pr create --draft --title \"fix: [BANK-17] fix notification URLs\"" \
  0

test_case "PR_LIFECYCLE_ACTIVE bypass" \
  "PR_LIFECYCLE_ACTIVE=1 gh pr create --draft --title \"feat: [FLOW-43] fix hook\"" \
  0

# --- Should BLOCK (invalid titles) ---

test_case "Missing type prefix" \
  "gh pr create --draft --title \"add user authentication\"" \
  2

test_case "Invalid type" \
  "gh pr create --draft --title \"chore: update dependencies\"" \
  2

test_case "No description after ticket" \
  "gh pr create --draft --title \"feat: [DEV-123]\"" \
  2

# --- Should ALLOW (not a PR creation command) ---

test_case "Not a gh pr create command" \
  "gh pr view 123" \
  0

test_case "No command at all" \
  "echo hello" \
  0

# --- FLOW-225: a mention is not an invocation (all previously exit 2, false blocks) ---

test_case "Mention inside a quoted echo, unrelated --title" \
  'dashboard session enter --phase debugging --title "PR Lifecycle ships three commands" && echo "next: gh pr create"' \
  0

test_case "Mention inside a heredoc body, unrelated --title" \
  'cat <<EOF
run gh pr create later
EOF
dashboard item add --title "some node title"' \
  0

test_case "Mention in a trailing comment, unrelated --title" \
  'dashboard session enter --title "a node title"  # like gh pr create does' \
  0

test_case "Equals form, unrelated --title=, mention in echo" \
  'dashboard session enter --title="a plain node title" && echo "gh pr create"' \
  0

# --- FLOW-225: the FAIL-OPEN cases — pre-fix these exit 0 because the extractor took the FIRST
# --title anywhere on the line (valid) and never saw the real, later, invalid one. ---

test_case "FAIL-OPEN: valid unrelated --title first, then real bad PR title" \
  'dashboard session enter --title "fix: [FLOW-1] ok" && gh pr create --title "totally bad title"' \
  2 \
  'Your title: "totally bad title"'

test_case "Two real invocations, the second one bad" \
  'gh pr create --title "fix: [FLOW-225] good" ; gh pr create --title "bad one"' \
  2 \
  'Your title: "bad one"'

# --- Anti-vacuity controls: these ALREADY PASS on the unmodified hook (base already blocks them,
# not a fix-induced flip). They exist so that a hook rewritten to always `exit 0` — which would
# satisfy every false-block test above — fails here instead of shipping green. ---

test_case "CONTROL real invocation, bad title, must still block" \
  'gh pr create --title "bad title" --body-file /tmp/b' \
  2

test_case "CONTROL real invocation, good title, must still allow" \
  'gh pr create --title "fix: [FLOW-225] scope the guard" --body-file /tmp/b' \
  0

test_case "CONTROL: real invocation second in the line, first segment unrelated" \
  'echo "starting" && gh pr create --title "not conventional"' \
  2

test_case "CONTROL: env-var prefix before a real invocation still checked" \
  'PR_LIFECYCLE_ACTIVE=1 gh pr create --title "not conventional"' \
  2

# --- FLOW-225 blind spot A, FIXED: previously the tokenizer had no concept of heredoc syntax, so a
# heredoc BODY line was just more newline-delimited text to it — indistinguishable from a real
# segment. When the invocation AND a bad title both sat on one heredoc body line, this false-
# blocked (this exact case was a KNOWN GAP, pinned rather than fixed, until the user chose to close
# it — see FLOW-225). strip_heredocs() now removes the
# heredoc body before tokenizing, so the "invocation" inside it is never seen at all.
test_case "Blind spot A FIXED: heredoc body carrying BOTH the invocation and a bad title is not seen" \
  'cat <<EOF
gh pr create --title "bad title"
EOF' \
  0

# --- FLOW-225: fail-open regressions introduced by segment scoping itself. A leading
# subshell/negation/substitution operator ('(', '$(', backtick, '!') is not in punctuation_chars,
# so it fuses onto 'gh' instead of becoming its own token — '(gh' / '$(gh' never equalled 'gh' by
# exact comparison, and a path prefix ('/usr/bin/gh') never equalled the bare name either. Base
# (substring matching) blocked all four of these; segment matching silently let them through. ---

test_case "F1: gh pr create via absolute path" \
  '/usr/bin/gh pr create --title "bad title"' \
  2

test_case "F1: gh pr create inside subshell parens" \
  '(gh pr create --title "bad title")' \
  2

test_case "F1: env prefix + absolute path to gh" \
  'FOO=1 /usr/local/bin/gh pr create --title "bad title"' \
  2

test_case "F1: gh pr create inside command substitution" \
  'echo $(gh pr create --title "bad title")' \
  2

# --- FLOW-225 Shape 4 — DELIBERATE, PINNED, NOT FIXED. An unquoted single-line mention still
# blocks: `echo gh pr create --title bad` matches `gh`/`pr`/`create`/`--title` as tokens in the SAME
# segment, indistinguishable from a real invocation, because the scan matches anywhere in a segment
# rather than requiring `gh` to be at COMMAND POSITION. Fixing that would need position-matching
# plus a wrapper allowlist (sudo/env/timeout/... prefixes still need to count as "really is gh"),
# which is the design `dangerous-command-guard.sh` used until FLOW-228, whose keyword list of ordinary
# English words (`do`, `then`, `else`, `time`, `command`, `env`) false-blocked prose --
# FLOW-228. Anywhere-in-segment fails toward BLOCKING;
# command-position-plus-allowlist fails toward ALLOWING. For a guard, the fail-open is the worse
# error, so anywhere-in-segment stays. The
# unquoted-mention false block is this trade's accepted price — pin it, do not "fix" it. See
# FLOW-225.
test_case "Shape 4 PINNED: unquoted single-line mention still blocks (deliberate trade, not a bug)" \
  'echo gh pr create --title bad' \
  2

# --- strip_heredocs() previously treated every
# heredoc body as DATA, but a heredoc that feeds an INTERPRETER (bash, sh, eval, or is piped to
# one) actually executes its body — stripping it let the real invocation inside walk straight
# through the guard. line_has_interpreter() now refuses to strip when the opener line names one.
# RED-verified against 8311ddf (all six forms exit=0 there); must be exit=2 here. ---

test_case "R1 FIXED: bash <<EOF feeds an interpreter, body must not be stripped" \
  'bash <<EOF
gh pr create --title "bad title"
EOF' \
  2

test_case "R1 FIXED: sh <<EOF feeds an interpreter" \
  'sh <<EOF
gh pr create --title "bad title"
EOF' \
  2

test_case "R1 FIXED: bash -s with a quoted heredoc delimiter still recognized as interpreter-fed" \
  "bash -s <<'EOF'
gh pr create --title \"bad title\"
EOF" \
  2

test_case "R1 FIXED: bash <<-EOF (dash form) still recognized as interpreter-fed" \
  'bash <<-EOF
gh pr create --title "bad title"
EOF' \
  2

test_case "R1 FIXED: eval <<EOF feeds an interpreter" \
  'eval <<EOF
gh pr create --title "bad title"
EOF' \
  2

test_case "R1 FIXED: cat <<EOF | bash pipes an interpreter-fed heredoc" \
  'cat <<EOF | bash
gh pr create --title "bad title"
EOF' \
  2

# --- A '<<' inside a QUOTED string on the opener
# line was misread as a real heredoc opener, and the real invocation on the next line got deleted
# as "body" before an unrelated later line that happened to equal the fake delimiter.
# is_outside_quotes() now refuses to treat a quoted '<<' as an opener at all. RED-verified against
# 8311ddf (exit=0 there, the real invocation was silently deleted); must be exit=2 here. ---

test_case "R2 FIXED: quoted << on the opener line is not a real heredoc, real invocation stays visible" \
  'echo "docs say <<EOF"
gh pr create --title "bad title"
EOF' \
  2

# --- line_has_interpreter() alone was a BLOCKLIST, so
# its failure axis was membership -- a consumer name absent from the set (an env-var interpreter,
# or an interpreter the list never named) read as "not an interpreter" and got stripped, executing
# right through the guard. Fixed by inverting to a DATA-SINK allowlist (line_has_data_sink(),
# {'cat'} — the only data-sink observed feeding a heredoc anywhere in this repo) ANDed with the
# existing interpreter check. RED-verified against 7e85d8f (all eleven forms exit=0 there); must
# be exit=2 here. Tier A ($SHELL/${INTERP}) is directly exploitable; tier B (node, deno, bun, awk,
# php, lua, tclsh) is every interpreter name the old blocklist never had; tier C (ssh) confirms the
# fix isn't just "consumer is the first word on the line" — 'host' sits between 'ssh' and '<<EOF'
# and neither is a data sink. ---

test_case "A1 FIXED tier A: \$SHELL <<EOF" \
  '$SHELL <<EOF
gh pr create --title "bad title"
EOF' \
  2

test_case 'A1 FIXED tier A: ${INTERP} <<EOF' \
  '${INTERP} <<EOF
gh pr create --title "bad title"
EOF' \
  2

test_case 'A1 FIXED tier A: "$SHELL" <<EOF (quoted)' \
  '"$SHELL" <<EOF
gh pr create --title "bad title"
EOF' \
  2

test_case "A1 FIXED tier B: node <<EOF" \
  'node <<EOF
gh pr create --title "bad title"
EOF' \
  2

test_case "A1 FIXED tier B: deno <<EOF" \
  'deno <<EOF
gh pr create --title "bad title"
EOF' \
  2

test_case "A1 FIXED tier B: bun <<EOF" \
  'bun <<EOF
gh pr create --title "bad title"
EOF' \
  2

test_case "A1 FIXED tier B: awk <<EOF" \
  'awk <<EOF
gh pr create --title "bad title"
EOF' \
  2

test_case "A1 FIXED tier B: php <<EOF" \
  'php <<EOF
gh pr create --title "bad title"
EOF' \
  2

test_case "A1 FIXED tier B: lua <<EOF" \
  'lua <<EOF
gh pr create --title "bad title"
EOF' \
  2

test_case "A1 FIXED tier B: tclsh <<EOF" \
  'tclsh <<EOF
gh pr create --title "bad title"
EOF' \
  2

test_case "A1 FIXED tier C: ssh host <<EOF" \
  'ssh host <<EOF
gh pr create --title "bad title"
EOF' \
  2

# --- HEREDOC_RE matched a '<<<' here-string as if it were
# a real heredoc opener -- for 'cat <<<EOF', finditer matched '<<EOF' starting at the SECOND '<',
# found delimiter 'EOF', and strip_heredocs() deleted everything up to a later bare 'EOF' line,
# hiding a real invocation between them. Same shape as the quoted-<< case above: the pre-pass stripping when it should
# not. Fixed with a negative lookbehind so '<<' immediately preceded by another '<' is never
# treated as an opener. RED-verified against 336b367 (exit=0 there); must be exit=2 here. ---

test_case "CodeRabbit (1) FIXED: <<< here-string is not a heredoc opener" \
  'cat <<<EOF
gh pr create --title "bad title"
EOF' \
  2

# --- Pre-existing (not a FLOW-225 regression -- base behaves identically),
# fixed anyway while in this file: an empty '--title ""' printed as empty output, and bash's
# $(...) strips ALL trailing newlines from command substitution, so a present-but-invalid empty
# title became indistinguishable from "no invalid title found" and the hook allowed it. Fixed with
# an 'INVALID:' prefix marker (same technique as conventional-commit.sh's 'SUBJECT:' prefix)
# so a blocked line stays non-blank regardless of the title's own content.
# RED-verified against 336b367 (exit=0 there); must be exit=2 here. ---

test_case "CodeRabbit (4) FIXED: empty --title \"\" no longer fails open" \
  'gh pr create --title ""' \
  2

# --- KNOWN GAP, NOT FIXED: a title whose ENTIRE content is composed
# solely of the tokenizer's punctuation_chars ('&', '|', ';', or a raw newline, in any
# combination) is invisible to is_boundary() -- it cannot distinguish a legitimately QUOTED token
# that happens to consist only of those characters from a genuine UNQUOTED segment boundary, so
# the segment splits before title_of() ever sees the value and title_of() returns None (title
# ABSENT) rather than an invalid string. This is a different, deeper defect than the bash-side
# stripping fixed above -- the 'INVALID:' marker cannot reach a value the python code never
# extracts in the first place. Confirmed pre-existing (untouched by any FLOW-225 change; the same
# is_boundary() has been shared and duplicated since the original tokenizer). Pinning today's
# actual behavior. ---

test_case "CodeRabbit (4) KNOWN GAP: a title that is ONLY punctuation_chars is invisible to the tokenizer" \
  "gh pr create --title ';'" \
  0

# --- FLOW-228: '#' comment-boundary fail-open in the shared analyzer, GENUINELY RED at the
# pre-fix hook -- shlex's default `commenters` stripped '#' to end of line from ANYWHERE inside a
# word, not just where bash itself treats '#' as starting a comment (start of line or after
# whitespace). A mid-word '#' (e.g. a URL fragment) silently discarded the real invocation that
# followed on the same line before the segment scan ever ran. Measured against the pre-fix hook:
# exit=0 there (should be 2). ---

test_case "'#' fail-open FIXED: mid-word '#' no longer hides the real invocation" \
  'echo url#frag; gh pr create --draft --title "add user authentication"' \
  2 \
  'PR TITLE MUST FOLLOW CONVENTIONAL COMMIT FORMAT'

# CONTROLS, paired with the case above: pinning the fail-open fix must not become an always-block
# or always-allow rewrite.
test_case "CONTROL: genuine comment still hides the invocation (allowed, matches real bash)" \
  'echo #frag gh pr create --draft --title "add user authentication"' \
  0

test_case "CONTROL: real invocation with no '#' anywhere still blocks" \
  'gh pr create --draft --title "add user authentication"' \
  2 \
  'PR TITLE MUST FOLLOW CONVENTIONAL COMMIT FORMAT'

# --- strip_comments() called is_outside_quotes() PER LINE, which builds a fresh quote stack every
# call -- a quote opened on an earlier physical line was invisible when checking a later one, so a
# '#' inside a multi-line quoted string read as a real (unquoted) comment starter and discarded a
# genuine invocation that followed once the string closed. No earlier test constructed a quoted
# string spanning a newline, so this shipped underneath green pins. Fixed by evaluating quote
# state across the WHOLE command with an absolute index instead of splitting into lines first.
#
# Prove independently, against REAL bash, that the payload
# below is a genuine live-fire shape -- not just trust the hook's own exit code. The marker is
# substituted for the real command AT THE SAME POSITION, not appended as a separate trailing line,
# since a trailing line always runs regardless of what happened earlier and would prove nothing.
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
line2 with # here"; gh pr create --draft --title "add user authentication"' \
  2 \
  'PR TITLE MUST FOLLOW CONVENTIONAL COMMIT FORMAT'

test_case "'#' fail-open FIXED (round 8): multi-line single-quoted string, killer after close" \
  'echo '"'"'line1
line2 with # here'"'"'; gh pr create --draft --title "add user authentication"' \
  2 \
  'PR TITLE MUST FOLLOW CONVENTIONAL COMMIT FORMAT'

# --- strip_comments() called is_outside_quotes() against the ORIGINAL
# command, so a quote character INSIDE a comment that gets stripped still counted toward quote
# state at a LATER '#' -- bash never lets a stripped comment affect quoting, but this code did.
# Fixed by evaluating quote state over the ACCUMULATED OUTPUT kept so far, not the original
# command, so a stripped comment's own characters can never poison a later check.
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
gh pr create --draft --title \"add user authentication\"" \
  2 \
  'PR TITLE MUST FOLLOW CONVENTIONAL COMMIT FORMAT'

# --- FLOW-228: an interpreter-fed heredoc whose body
# contains an unbalanced quote made the WHOLE command unparseable by shlex, and the pre-existing
# fail-open unconditionally allowed -- but bash itself parses and RUNS this shape (the heredoc
# body is data to bash's own parser, apostrophe and all), so the real invocation on the line after
# genuinely executed. Fixed by applying this hook's own bare-word check to the raw
# command whenever shlex fails to tokenize -- unconditionally (an earlier
# `bash -n` gate here was tried and removed once its premise was found broken by bash being
# a streaming parser; see dangerous-command-guard.sh's `except ValueError:` comment for the full story) -- blocking on gh/pr/create shape alone here,
# since title validity cannot be checked in unparseable text. Measured against the hook before
# this fix: exit=0 there (should be 2).
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
  'bash <<EOF
don'"'"'t
EOF
gh pr create --draft --title "add user authentication"' \
  2 \
  'PR TITLE MUST FOLLOW CONVENTIONAL COMMIT FORMAT'

test_case "Finding B: parse-failure fallback with no guarded token present stays allowed" \
  'bash <<EOF
don'"'"'t
EOF
gh pr list' \
  0

# Partial execution -- the exact shape that falsified the earlier `bash -n`
# gate (removed; see dangerous-command-guard.sh's `except ValueError:` comment for the full story). bash is
# a STREAMING parser: it executes each complete command as it reads the input, so a real
# invocation on an early line runs even though a later, unrelated syntax error makes the WHOLE
# command unparseable by both shlex and `bash -n`. Measured against the hook before this fix
# (8b06cb7, still carrying the gate): exit=0 there (should be 2).
test_bash_ground_truth_partial_execution() {
  local description="bash ground truth: a real command on an early line executes even though a later line has an unrelated syntax error"
  local output
  output=$(bash -c 'echo REAL_MARKER
echo ok
echo "unterminated' 2>&1) || true
  if [[ "$output" == *"REAL_MARKER"* ]]; then
    echo "PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description (bash did NOT run the early line -- the regression case below may not be a live shape; investigate before trusting it)"
    FAIL=$((FAIL + 1))
  fi
}
test_bash_ground_truth_partial_execution

test_case "Finding B round-12 FIXED: real invocation line 1, syntax error line 2" \
  'gh pr create --draft --title "add user authentication"
echo "unterminated' \
  2 \
  'PR TITLE MUST FOLLOW CONVENTIONAL COMMIT FORMAT'

test_case "Finding B round-12 CONTROL: no signature, syntax error present, still allowed" \
  'echo ok
echo "unterminated' \
  0

# See test-dashboard-enter-guard.sh for the full bash-ground-truth story.
# Measured against 6a556a8: exit=2 there (should be 0).
test_case "CodeRabbit finding 4 FIXED: a real bash comment right after ';' no longer misreads as a real gh pr create" \
  'echo ok;#comment: gh pr create --title "bad title"
echo done' \
  0

# See test-no-verify-guard.sh for the full escape-blindness story. Measured against
# 4d06be0: exit=0 (fail-open) there; must be exit=2 here.
test_case "Round 15 FIXED: escaped semicolon before '#' does not hide a real gh pr create" \
  'echo a \;#c ; gh pr create --draft --title "add user authentication"
echo REAL_DONE' \
  2 \
  'PR TITLE MUST FOLLOW CONVENTIONAL COMMIT FORMAT'

# See test-dangerous-command-guard.sh for the full escaped-heredoc-opener story.
# Measured against 6d902e1: exit=0 (fail-open) there; must be exit=2 here.
test_case "Round 16 FIXED: escaped '<' before '<<' no longer hides a real invocation" \
  'cat \<<EOF
gh pr create --draft --title "add user authentication"
EOF' \
  2 \
  'PR TITLE MUST FOLLOW CONVENTIONAL COMMIT FORMAT'

# See test-dangerous-command-guard.sh for the full backslash/quote-split-interpreter story.
# Measured against b14731c: exit=0 (fail-open) there; must be exit=2 here.
test_case "Round 17 FIXED: a backslash-split interpreter name no longer hides a real invocation" \
  'cat <<EOF | b\ash
gh pr create --draft --title "add user authentication"
EOF' \
  2 \
  'PR TITLE MUST FOLLOW CONVENTIONAL COMMIT FORMAT'

test_case "Rejection text shows the ticket as optional and used only when one exists" \
  'gh pr create --title "add user authentication"' \
  2 \
  $'Required format: <type>[(scope)]: [TICKET-123] <description>\n(the [TICKET-123] is optional and used only when a ticket exists; otherwise omit it)'

echo
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
