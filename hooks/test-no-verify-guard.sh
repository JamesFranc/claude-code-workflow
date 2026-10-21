#!/bin/bash
# Test script for no-verify-guard.sh
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
# FAIL-OPEN finding for a row (in test-dangerous-command-guard.sh) whose payload referenced $CMD --
# populating the very variable the payload depended on, so it "confirmed" a fail-open that is
# inert in essentially every real environment ($CMD is not a variable bash or any common tool
# sets). The audit answered a question about a world that does not exist. That row's payload was
# corrected to use $SHELL instead, which bash itself populates whenever it is not already
# inherited (confirmed live under a bare `env -i`) -- this file carries no such pin itself, but
# the same MUST-use-inherited-environment rule applies here too, for the same reason.

set -euo pipefail

HOOK_SCRIPT="$(dirname "$0")/no-verify-guard.sh"
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

echo "=== No-Verify Guard Tests ==="
echo

# --- Should BLOCK (real git invocation carrying the flag) ---

test_case "git commit --no-verify -m x" \
  'git commit --no-verify -m "x"' \
  2 \
  'BLOCKED: --no-verify is not allowed'

test_case "git push --no-verify" \
  'git push --no-verify' \
  2 \
  'BLOCKED: --no-verify is not allowed'

# --- Should ALLOW (FLOW-225: a mention is not an invocation) ---

test_case "Prose mentioning the flag, no git invocation" \
  'echo "never use --no-verify"' \
  0

test_case "Dashboard prompt string mentioning the flag" \
  'dashboard item add --prompt "explains --no-verify"' \
  0

test_case "Flag inside a heredoc body" \
  'cat <<EOF
never use --no-verify
EOF' \
  0

test_case "git commit with no flag at all" \
  'git commit -m "x"' \
  0

# --- FLOW-225: fail-open regressions introduced by segment scoping itself. A leading
# subshell/negation/substitution operator ('(', '$(', backtick, '!') is not in punctuation_chars,
# so it fuses onto 'git' instead of becoming its own token, and a closing '(...)' fuses onto the
# LAST token in the segment — '--no-verify)' never equalled '--no-verify' either. Base (substring
# matching) blocked both of these; segment matching silently let them through. ---

test_case "F1: git commit --no-verify via absolute path" \
  '/usr/bin/git commit --no-verify -m "x"' \
  2 \
  'BLOCKED: --no-verify is not allowed'

test_case "F1: git commit --no-verify inside subshell parens" \
  '(git commit --no-verify)' \
  2 \
  'BLOCKED: --no-verify is not allowed'

# --- FLOW-225 F3a / blind spot A, FIXED: same residual shape as pr-title-guard.sh's was — a
# heredoc BODY line carrying a REAL git invocation AND the flag was indistinguishable from a real
# segment and still false-blocked (the committed "Flag inside a heredoc body" case above uses prose
# with no `git` token, so it never exercised this path — this is the case that actually pinned the
# gap, until the user chose to close it — see FLOW-225).
# strip_heredocs() now removes the heredoc body before tokenizing, so the "invocation" inside it is
# never seen at all. ---
test_case "F3a / blind spot A FIXED: heredoc body carrying BOTH invocation and flag is not seen" \
  'cat <<EOF
git commit --no-verify -m "x"
EOF' \
  0

# --- FLOW-225 Shape 4 — DELIBERATE, PINNED, NOT FIXED. An unquoted single-line mention still
# blocks: `echo git commit --no-verify` matches `git`/`--no-verify` as tokens in the SAME segment,
# indistinguishable from a real invocation, because the scan matches anywhere in a segment rather
# than requiring `git` to be at COMMAND POSITION. Fixing that would need position-matching plus a
# wrapper allowlist (sudo/env/timeout/... prefixes still need to count as "really is git"), which
# is the design `dangerous-command-guard.sh` used until FLOW-228, whose keyword list of ordinary
# English words (`do`, `then`, `else`, `time`, `command`, `env`) false-blocked prose --
# FLOW-228.
# Anywhere-in-segment fails toward BLOCKING; command-position-plus-allowlist fails toward ALLOWING.
# For a guard, the fail-open is the worse error, so anywhere-in-segment stays. The unquoted-mention
# false block is this trade's accepted price — pin it, do not "fix" it. See
# FLOW-225.
test_case "Shape 4 PINNED: unquoted single-line mention still blocks (deliberate trade, not a bug)" \
  'echo git commit --no-verify' \
  2 \
  'BLOCKED: --no-verify is not allowed'

# --- strip_heredocs() previously treated every
# heredoc body as DATA, but a heredoc that feeds an INTERPRETER (bash, sh, eval, or is piped to
# one) actually executes its body — stripping it let the real invocation inside walk straight
# through the guard. line_has_interpreter() now refuses to strip when the opener line names one.
# RED-verified against 8311ddf (all six forms exit=0 there); must be exit=2 here. ---

test_case "R1 FIXED: bash <<EOF feeds an interpreter, body must not be stripped" \
  'bash <<EOF
git commit --no-verify -m "x"
EOF' \
  2 \
  'BLOCKED: --no-verify is not allowed'

test_case "R1 FIXED: sh <<EOF feeds an interpreter" \
  'sh <<EOF
git commit --no-verify -m "x"
EOF' \
  2

test_case "R1 FIXED: bash -s with a quoted heredoc delimiter still recognized as interpreter-fed" \
  "bash -s <<'EOF'
git commit --no-verify -m \"x\"
EOF" \
  2

test_case "R1 FIXED: bash <<-EOF (dash form) still recognized as interpreter-fed" \
  'bash <<-EOF
git commit --no-verify -m "x"
EOF' \
  2

test_case "R1 FIXED: eval <<EOF feeds an interpreter" \
  'eval <<EOF
git commit --no-verify -m "x"
EOF' \
  2

test_case "R1 FIXED: cat <<EOF | bash pipes an interpreter-fed heredoc" \
  'cat <<EOF | bash
git commit --no-verify -m "x"
EOF' \
  2

# --- A '<<' inside a QUOTED string on the opener
# line was misread as a real heredoc opener, and the real invocation on the next line got deleted
# as "body" before an unrelated later line that happened to equal the fake delimiter.
# is_outside_quotes() now refuses to treat a quoted '<<' as an opener at all. RED-verified against
# 8311ddf (exit=0 there, the real invocation was silently deleted); must be exit=2 here. ---

test_case "R2 FIXED: quoted << on the opener line is not a real heredoc, real invocation stays visible" \
  'echo "docs say <<EOF"
git commit --no-verify -m "x"
EOF' \
  2 \
  'BLOCKED: --no-verify is not allowed'

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
git commit --no-verify -m "x"
EOF' \
  2 \
  'BLOCKED: --no-verify is not allowed'

test_case 'A1 FIXED tier A: ${INTERP} <<EOF' \
  '${INTERP} <<EOF
git commit --no-verify -m "x"
EOF' \
  2

test_case 'A1 FIXED tier A: "$SHELL" <<EOF (quoted)' \
  '"$SHELL" <<EOF
git commit --no-verify -m "x"
EOF' \
  2

test_case "A1 FIXED tier B: node <<EOF" \
  'node <<EOF
git commit --no-verify -m "x"
EOF' \
  2

test_case "A1 FIXED tier B: deno <<EOF" \
  'deno <<EOF
git commit --no-verify -m "x"
EOF' \
  2

test_case "A1 FIXED tier B: bun <<EOF" \
  'bun <<EOF
git commit --no-verify -m "x"
EOF' \
  2

test_case "A1 FIXED tier B: awk <<EOF" \
  'awk <<EOF
git commit --no-verify -m "x"
EOF' \
  2

test_case "A1 FIXED tier B: php <<EOF" \
  'php <<EOF
git commit --no-verify -m "x"
EOF' \
  2

test_case "A1 FIXED tier B: lua <<EOF" \
  'lua <<EOF
git commit --no-verify -m "x"
EOF' \
  2

test_case "A1 FIXED tier B: tclsh <<EOF" \
  'tclsh <<EOF
git commit --no-verify -m "x"
EOF' \
  2

test_case "A1 FIXED tier C: ssh host <<EOF" \
  'ssh host <<EOF
git commit --no-verify -m "x"
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
git commit --no-verify -m "x"
EOF' \
  2

# --- FLOW-228: '#' comment-boundary fail-open in the shared analyzer, GENUINELY RED at the
# pre-fix hook -- shlex's default `commenters` stripped '#' to end of line from ANYWHERE inside a
# word, not just where bash itself treats '#' as starting a comment (start of line or after
# whitespace). A mid-word '#' (e.g. a URL fragment) silently discarded the real invocation that
# followed on the same line before the segment scan ever ran. Measured against the pre-fix hook:
# exit=0 there (should be 2). ---

test_case "'#' fail-open FIXED: mid-word '#' no longer hides the real invocation" \
  'echo url#frag; git commit --no-verify -m "x"' \
  2 \
  'BLOCKED: --no-verify is not allowed'

# CONTROLS, paired with the case above: pinning the fail-open fix must not become an always-block
# or always-allow rewrite.
test_case "CONTROL: genuine comment still hides the invocation (allowed, matches real bash)" \
  'echo #frag git commit --no-verify -m "x"' \
  0

test_case "CONTROL: real invocation with no '#' anywhere still blocks" \
  'git commit --no-verify -m "x"' \
  2 \
  'BLOCKED: --no-verify is not allowed'

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
line2 with # here"; git commit --no-verify -m "x"' \
  2 \
  'BLOCKED: --no-verify is not allowed'

test_case "'#' fail-open FIXED (round 8): multi-line single-quoted string, killer after close" \
  'echo '"'"'line1
line2 with # here'"'"'; git commit --no-verify -m "x"' \
  2 \
  'BLOCKED: --no-verify is not allowed'

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
git commit --no-verify -m \"x\"" \
  2 \
  'BLOCKED: --no-verify is not allowed'

# --- FLOW-228: an interpreter-fed heredoc whose body
# contains an unbalanced quote made the WHOLE command unparseable by shlex, and the pre-existing
# fail-open unconditionally allowed -- but bash itself parses and RUNS this shape (the heredoc
# body is data to bash's own parser, apostrophe and all), so the real invocation on the line after
# genuinely executed. Fixed by applying this hook's own bare-word check to the raw
# command whenever shlex fails to tokenize -- unconditionally (an earlier
# `bash -n` gate here was tried and removed once its premise was found broken by bash being
# a streaming parser; see dangerous-command-guard.sh's `except ValueError:` comment for the full story). Measured against the hook before this fix: exit=0
# there (should be 2).
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
git commit --no-verify -m "x"' \
  2 \
  'BLOCKED: --no-verify is not allowed'

test_case "Finding B: parse-failure fallback with no guarded token present stays allowed" \
  'bash <<EOF
don'"'"'t
EOF
git commit -m "x"' \
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
  'git commit --no-verify -m "x"
echo "unterminated' \
  2 \
  'BLOCKED: --no-verify is not allowed'

test_case "Finding B round-12 CONTROL: no signature, syntax error present, still allowed" \
  'echo ok
echo "unterminated' \
  0

# The parse-failure fallback's bare-word regex for --no-verify only
# anchored on whitespace/string-edges, so a QUOTED flag was invisible to it and fell through
# to the fail-open default. Fixed by adding quote characters to both boundary character classes.
# Measured against the pre-fix hook (6a556a8): exit=0 there (should be 2).
test_case "CodeRabbit finding 1 FIXED: quoted --no-verify flag still blocks on parse failure" \
  'git commit "--no-verify" -m "x"
echo "unterminated' \
  2 \
  'BLOCKED: --no-verify is not allowed'

test_case "CodeRabbit finding 1 FIXED: single-quoted --no-verify flag still blocks on parse failure" \
  "git commit '--no-verify' -m x
echo \"unterminated" \
  2 \
  'BLOCKED: --no-verify is not allowed'

test_case "CodeRabbit finding 1 CONTROL: a longer flag name containing --no-verify as a prefix does not false-positive" \
  'git commit --no-verify-and-then-some -m "x"
echo "unterminated' \
  0


# See test-dashboard-enter-guard.sh for the full bash-ground-truth story on
# why '#' right after a control operator (';', '|', '&') needed to join the comment-boundary set.
# Measured against 6a556a8: exit=2 there (should be 0).
test_case "CodeRabbit finding 4 FIXED: a real bash comment right after ';' no longer misreads as a real --no-verify" \
  'git commit -m x;#comment: git commit --no-verify -m y
echo done' \
  0

# Escape-blindness. The fix above (recognizing ';',
# '|', '&' as comment boundaries) and the PRE-EXISTING squote/dquote-open checks both inspected a
# raw neighbouring character with no notion of backslash-escaping. An ESCAPED trigger character
# ('\;', '\|', '\&', '\ ') is a literal character in real bash, not an operator -- the '#'
# right after it starts no comment, and the real invocation that follows genuinely runs. An
# ESCAPED quote outside any quoting ('\'' or '\"') is a literal quote character in real bash,
# not a real quote-open -- treating it as one desyncs our tracked quote nesting from bash's real
# one by exactly one transition, which silently erased a real invocation from the token stream
# with no parse failure to trip the fallback (confirmed exploitable end to end before this fix).
# Fixed by tracking backslash-escape parity incrementally in the same single pass: an ODD run of
# backslashes immediately before a trigger/quote character means it is escaped (literal); EVEN
# (including zero) means it is the real thing. Measured against 4d06be0 (the HEAD right before this
# fix): exit=0 (fail-open) on every BLOCKED row below; must be exit=2 here.

test_case "Round 15 FIXED: escaped semicolon before '#' does not hide the real invocation" \
  'echo a \;#c ; git commit --no-verify -m x
echo REAL_DONE' \
  2 \
  'BLOCKED: --no-verify is not allowed'

test_case "Round 15 FIXED: escaped pipe before '#' does not hide the real invocation" \
  'true \|#c ; git commit --no-verify -m x
echo REAL_DONE' \
  2 \
  'BLOCKED: --no-verify is not allowed'

test_case "Round 15 FIXED: escaped ampersand before '#' does not hide the real invocation" \
  'echo a \&#c ; git commit --no-verify -m x
echo REAL_DONE' \
  2 \
  'BLOCKED: --no-verify is not allowed'

test_case "Round 15 FIXED: escaped space before '#' does not hide the real invocation" \
  'echo a\ #c ; git commit --no-verify -m x
echo REAL_DONE' \
  2 \
  'BLOCKED: --no-verify is not allowed'

test_case "Round 15 CONTROL: an EVEN (2) backslash run before ';' is a real (unescaped) operator, still a real comment" \
  'echo a \\;#c ; git commit --no-verify -m x
echo REAL_DONE' \
  0

test_case "Round 15 FIXED: an ODD (3) backslash run before ';' is still escaped, real invocation stays visible" \
  'echo a \\\;#c ; git commit --no-verify -m x
echo REAL_DONE' \
  2 \
  'BLOCKED: --no-verify is not allowed'

test_case "Round 15 CONTROL: an EVEN (2) backslash run before a space is a real (unescaped) boundary, still a real comment" \
  'echo a\\ #c ; git commit --no-verify -m x
echo REAL_DONE' \
  0

test_case "Round 15 CONTROL: CR#4's true-comment fix stays correct (0 backslashes, real comment, allowed)" \
  'echo a ;#c ; git commit --no-verify -m x
echo REAL_DONE' \
  0

test_case "Round 15 FIXED: escaped dquote followed by a real dquote no longer hides an invocation inside the real string's tail" \
  'echo \"a" #x" ; git commit --no-verify -m x
echo "balance' \
  2

test_case "Round 15 FIXED: escaped squote followed by a real squote no longer hides an invocation inside the real string's tail" \
  "echo \\'a' #x' ; git commit --no-verify -m x
echo 'balance" \
  2

# See test-dangerous-command-guard.sh for the full escaped-heredoc-opener story.
# Measured against 6d902e1: exit=0 (fail-open) there; must be exit=2 here.
test_case "Round 16 FIXED: escaped '<' before '<<' no longer hides a real invocation" \
  'cat \<<EOF
git commit --no-verify -m x
EOF' \
  2 \
  'BLOCKED: --no-verify is not allowed'

# See test-dangerous-command-guard.sh for the full backslash/quote-split-interpreter story.
# Measured against b14731c: exit=0 (fail-open) there; must be exit=2 here.
test_case "Round 17 FIXED: a backslash-split interpreter name no longer hides a real invocation" \
  'cat <<EOF | b\ash
git commit --no-verify -m x
EOF' \
  2 \
  'BLOCKED: --no-verify is not allowed'

# shlex has no notion of command substitution. A backtick or $(...)
# span embedded inside a DOUBLE-quoted token is inert text to shlex -- the whole quoted string
# becomes one opaque token that matches nothing in the git/flag checks, even though bash actually
# EXECUTES the span's content. The SAME span inside a SINGLE-quoted token is genuinely inert (bash
# suppresses all substitution inside single quotes) -- these two must be told apart, which shlex's
# own post-tokenization output cannot do (both de-quote to identical text). Fixed by scanning the
# RAW command text directly (raw_substitution_spans(), see its own comment for the full mechanism
# and why an earlier per-token attempt was wrong) rather than shlex tokens. Measured against
# b14731c: exit=0 (fail-open) there; must be exit=2 here.
test_case "Round 18 FIXED: git+--no-verify inside a DOUBLE-quoted backtick span is a real substitution, must block" \
  'echo "docs: `git commit --no-verify -m x`"' \
  2 \
  'BLOCKED: --no-verify is not allowed'

test_case "Round 18 CONTROL: git+--no-verify inside a SINGLE-quoted backtick span is a literal mention, must allow" \
  "echo 'docs: \`git commit --no-verify -m x\`'" \
  0


# See test-dangerous-command-guard.sh for the full accepted-over-block story.
test_case "Round 20 ACCEPTED OVER-BLOCK: git and the flag both mentioned inside a substitution's searched data, never executed" \
  'echo "$(grep -l --no-verify README.md; echo git)"' \
  2 \
  'BLOCKED: --no-verify is not allowed'

echo
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
