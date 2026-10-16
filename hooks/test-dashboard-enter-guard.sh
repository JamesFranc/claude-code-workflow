#!/bin/bash
# Test script for dashboard-enter-guard.sh
# Simulates hook input and verifies expected outcomes

set -euo pipefail

HOOK_SCRIPT="$(dirname "$0")/dashboard-enter-guard.sh"
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

echo "=== Dashboard Enter Guard Tests ==="
echo

# --- Should ALLOW (the eight legitimate template invocations) ---

# FLOW-205 deprecation window: --level is still an accepted (ignored) flag, and a real agent running
# the shipped plugin cache still passes it. This fixture keeps that argv shape covered — the guard
# scans for --title/--key/--retitle/--phase and must stay indifferent to an extra inert flag.
test_case "FLOW-205 deprecation window — an enter still passing the inert --level" \
  'dashboard session enter --level epic --phase prd --title "<epic>"' \
  0

test_case "jtbd:32 — retitle, no --key, --phase prd, --title --retitle" \
  'dashboard session enter --phase prd --title "<ticket summary>" --retitle' \
  0

test_case "systematic-debugging:12 — first enter, no --key, --phase debugging, --title" \
  'dashboard session enter --phase debugging --title "<bug>"' \
  0

test_case "systematic-debugging:41 — retitle, no --key, --phase debugging, --title --retitle" \
  'dashboard session enter --phase debugging --title "<summary>" --retitle' \
  0

test_case "quick-change:44 — first enter, no --key, --phase change, --title" \
  'dashboard session enter --phase change --title "<change>"' \
  0

test_case "quick-change:75 — retitle, no --key, --phase change, --title --retitle" \
  'dashboard session enter --phase change --title "<summary>" --retitle' \
  0

test_case "team-cleanup:122 — first enter of a new keyed node, --key present" \
  'dashboard session enter --key FLOW-1 --phase implementation --title "<title>"' \
  0

test_case "team-dispatch (block 4, entry point) — first enter, no --key, --phase dispatch, --title" \
  'dashboard session enter --phase dispatch --title "<ticket summary>"' \
  0

# --- Should BLOCK (the four observed bad forms) ---

test_case "Observed defect: --phase implementation --title, no --key" \
  'dashboard session enter --phase implementation --title "Session reads full-scan the workspace on every call"' \
  2 \
  'DASHBOARD SESSION ENTER: REFUSING A LIKELY ROOTWARD RETITLE'

test_case "Observed defect: --phase review --title, no --key" \
  'dashboard session enter --phase review --title "Replace the undo countdown with unrelease-until-read"' \
  2

test_case "Per-round review phase: --phase review-round-3 --title, no --key" \
  'dashboard session enter --phase review-round-3 --title "some ticket"' \
  2 \
  'DASHBOARD SESSION ENTER: REFUSING A LIKELY ROOTWARD RETITLE'

test_case "Per-round review phase without --title is allowed (the step 20 re-enter)" \
  'dashboard session enter --phase review-round-3' \
  0

test_case "A phase that only starts like review-round is not blocked" \
  'dashboard session enter --phase review-round-x --title "some ticket"' \
  0

test_case "Observed defect: --phase pr --title, no --key" \
  'dashboard session enter --phase pr --title "some ticket"' \
  2

test_case "Observed defect: --phase cleanup --title, no --key" \
  'dashboard session enter --phase cleanup --title "some ticket"' \
  2

# --- Additional carve-outs ---

test_case "Deliberate retitle in a blocked phase is allowed (--retitle present)" \
  'dashboard session enter --phase implementation --title "some title" --retitle' \
  0

test_case "A keyed enter in a blocked phase is allowed (--key present)" \
  'dashboard session enter --key FLOW-1 --phase implementation --title "some title"' \
  0

# --- Compound commands: flags must be scoped to the enter segment ---

test_case "False-block avoided: an unrelated --title after && on a different command must not count" \
  'dashboard session enter --phase pr && gh pr create --title "some pr title" --draft' \
  0

test_case "False-allow avoided: a --key on a LATER chained command must not exempt the enter segment's own defect shape" \
  'dashboard session enter --phase pr --title "some title" && dashboard link add --key FLOW-1 --kind ticket --label x --url y' \
  2

test_case "m10: a bare & (backgrounding) must scope flags exactly like && does" \
  'dashboard session enter --phase pr --title "some title" & dashboard link add --key FLOW-1 --kind ticket --label x --url y' \
  2

# --- Multi-line commands: a NEWLINE must scope flags exactly
# like &&/||/;/| does. This is the repo's own house style -- every skill template issues `enter`
# followed by a `link add` as a two-line fenced block -- so this is the LIKELY shape, not an edge
# case. $'...' below embeds a literal newline in the test command string. ---

test_case "Newline false-block avoided: an unrelated --title on the SECOND line must not count" \
  $'dashboard session enter --phase pr\nsomecmd --title "x" --draft' \
  0

test_case "Newline false-allow avoided: a --key on the SECOND line must not exempt the first line's own defect shape" \
  $'dashboard session enter --phase pr --title "some title"\ndashboard link add --kind ticket --label X --url Y --key FLOW-1' \
  2

# --- Multiple enter invocations in one command: every dashboard
# session enter segment must be checked, not just the first one found. ---

test_case "m5: a clean first enter followed by a defect-shaped second enter must still block" \
  'dashboard session enter --phase change --title "First title" && dashboard session enter --phase implementation --title "Some other epic title"' \
  2

test_case "m5: a defect-shaped first enter followed by a clean second enter must still block" \
  'dashboard session enter --phase implementation --title "Some other epic title" && dashboard session enter --key FLOW-1 --phase implementation --title "First title"' \
  2

# --- Should ALLOW (not a dashboard session enter command) ---

test_case "Not a dashboard session enter command" \
  "dashboard session leave" \
  0

test_case "No command at all" \
  "echo hello" \
  0

# --- FLOW-225 blind spot A, FIXED: the tokenizer had no concept of
# heredoc syntax, so a heredoc BODY line was just more newline-delimited text — a mere MENTION of
# the defect shape inside a heredoc body read as a real segment and false-blocked. RED-verified at
# base (7d933a1): exit=2. strip_heredocs() now removes the heredoc body before tokenizing. See
# FLOW-225. ---

test_case "Blind spot A FIXED: defect shape inside a heredoc body is not seen" \
  'cat <<EOF
dashboard session enter --phase implementation --title "Session reads full-scan the workspace"
EOF' \
  0

# --- FLOW-225 blind spot B, FIXED (the same fix generalised to this hook): a leading subshell/negation/
# substitution operator ('(', '$(', backtick, '!') is not in punctuation_chars, so it fuses onto
# 'dashboard' instead of becoming its own token, and a path prefix ('/usr/bin/dashboard') never
# equalled the bare name either — both shapes silently failed open on the defect shape.
# RED-verified at base (7d933a1): both exit=0. Fixed via normalize_bin()/strip_shell_meta(), same
# as pr-title-guard.sh and no-verify-guard.sh. ---

test_case "Blind spot B FIXED: defect shape via absolute path to dashboard is still blocked" \
  '/usr/bin/dashboard session enter --phase implementation --title "Session reads full-scan the workspace"' \
  2 \
  'DASHBOARD SESSION ENTER: REFUSING A LIKELY ROOTWARD RETITLE'

test_case "Blind spot B FIXED: defect shape inside subshell parens is still blocked" \
  '(dashboard session enter --phase implementation --title "Session reads full-scan the workspace")' \
  2

# --- FLOW-225 Shape 4 — DELIBERATE, PINNED, NOT FIXED. An unquoted single-line mention still
# blocks: `echo dashboard session enter --phase implementation --title x` matches
# `dashboard`/`session`/`enter` as tokens in the SAME segment, indistinguishable from a real
# invocation, because the scan matches anywhere in a segment rather than requiring `dashboard` to
# be at COMMAND POSITION. Fixing that would need position-matching plus a wrapper allowlist
# (sudo/env/timeout/... prefixes still need to count as "really is dashboard"), which is the
# design `process-kill-guard.sh` used until FLOW-228, whose keyword list of ordinary English words
# (`do`, `then`, `else`, `time`, `command`, `env`) false-blocked prose --
# FLOW-228.
# Anywhere-in-segment fails toward BLOCKING; command-position-plus-allowlist fails toward ALLOWING.
# For a guard, the fail-open is the worse error, so anywhere-in-segment stays. The unquoted-mention
# false block is this trade's accepted price — pin it, do not "fix" it. See
# FLOW-225. This hook joined the tokenizer closure late
# (scope expanded here after measuring identical behavior); pinning now for
# consistency with the other rewritten hooks. ---

test_case "Shape 4 PINNED: unquoted single-line mention still blocks (deliberate trade, not a bug)" \
  'echo dashboard session enter --phase implementation --title x' \
  2

# --- strip_heredocs() previously treated every
# heredoc body as DATA, but a heredoc that feeds an INTERPRETER (bash, sh, eval, or is piped to
# one) actually executes its body — stripping it let the real defect shape inside walk straight
# through the guard. line_has_interpreter() now refuses to strip when the opener line names one.
# RED-verified against 8311ddf (all six forms exit=0 there); must be exit=2 here. ---

test_case "R1 FIXED: bash <<EOF feeds an interpreter, body must not be stripped" \
  'bash <<EOF
dashboard session enter --phase implementation --title "x"
EOF' \
  2 \
  'DASHBOARD SESSION ENTER: REFUSING A LIKELY ROOTWARD RETITLE'

test_case "R1 FIXED: sh <<EOF feeds an interpreter" \
  'sh <<EOF
dashboard session enter --phase implementation --title "x"
EOF' \
  2

test_case "R1 FIXED: bash -s with a quoted heredoc delimiter still recognized as interpreter-fed" \
  "bash -s <<'EOF'
dashboard session enter --phase implementation --title \"x\"
EOF" \
  2

test_case "R1 FIXED: bash <<-EOF (dash form) still recognized as interpreter-fed" \
  'bash <<-EOF
dashboard session enter --phase implementation --title "x"
EOF' \
  2

test_case "R1 FIXED: eval <<EOF feeds an interpreter" \
  'eval <<EOF
dashboard session enter --phase implementation --title "x"
EOF' \
  2

test_case "R1 FIXED: cat <<EOF | bash pipes an interpreter-fed heredoc" \
  'cat <<EOF | bash
dashboard session enter --phase implementation --title "x"
EOF' \
  2

# --- A '<<' inside a QUOTED string on the opener
# line was misread as a real heredoc opener, and the real invocation on the next line got deleted
# as "body" before an unrelated later line that happened to equal the fake delimiter.
# is_outside_quotes() now refuses to treat a quoted '<<' as an opener at all. RED-verified against
# 8311ddf (exit=0 there, the real invocation was silently deleted); must be exit=2 here. ---

test_case "R2 FIXED: quoted << on the opener line is not a real heredoc, real invocation stays visible" \
  'echo "docs say <<EOF"
dashboard session enter --phase implementation --title "x"
EOF' \
  2 \
  'DASHBOARD SESSION ENTER: REFUSING A LIKELY ROOTWARD RETITLE'

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
dashboard session enter --phase implementation --title "x"
EOF' \
  2

test_case 'A1 FIXED tier A: ${INTERP} <<EOF' \
  '${INTERP} <<EOF
dashboard session enter --phase implementation --title "x"
EOF' \
  2

test_case 'A1 FIXED tier A: "$SHELL" <<EOF (quoted)' \
  '"$SHELL" <<EOF
dashboard session enter --phase implementation --title "x"
EOF' \
  2

test_case "A1 FIXED tier B: node <<EOF" \
  'node <<EOF
dashboard session enter --phase implementation --title "x"
EOF' \
  2

test_case "A1 FIXED tier B: deno <<EOF" \
  'deno <<EOF
dashboard session enter --phase implementation --title "x"
EOF' \
  2

test_case "A1 FIXED tier B: bun <<EOF" \
  'bun <<EOF
dashboard session enter --phase implementation --title "x"
EOF' \
  2

test_case "A1 FIXED tier B: awk <<EOF" \
  'awk <<EOF
dashboard session enter --phase implementation --title "x"
EOF' \
  2

test_case "A1 FIXED tier B: php <<EOF" \
  'php <<EOF
dashboard session enter --phase implementation --title "x"
EOF' \
  2

test_case "A1 FIXED tier B: lua <<EOF" \
  'lua <<EOF
dashboard session enter --phase implementation --title "x"
EOF' \
  2

test_case "A1 FIXED tier B: tclsh <<EOF" \
  'tclsh <<EOF
dashboard session enter --phase implementation --title "x"
EOF' \
  2

test_case "A1 FIXED tier C: ssh host <<EOF" \
  'ssh host <<EOF
dashboard session enter --phase implementation --title "x"
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
dashboard session enter --phase implementation --title "x"
EOF' \
  2

# --- Missing jq: the hook must fail open, not abort under set -e ---

test_missing_jq() {
  local description="jq unavailable on PATH — fails open (exit 0), not exit 127"
  local tmpbin
  tmpbin=$(mktemp -d)
  local tool src
  for tool in cat grep sed python3 bash env printf; do
    src=$(command -v "$tool" 2>/dev/null) || continue
    ln -s "$src" "$tmpbin/$tool"
  done

  # Build the hook's JSON input with the REAL jq (still on this test script's own PATH) — only the
  # HOOK invocation below runs under the restricted, jq-less PATH.
  local input
  input=$(jq -n --arg cmd 'dashboard session enter --phase pr --title "x"' \
    '{"tool_input": {"command": $cmd}}')

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

# --- FLOW-228: '#' comment-boundary fail-open in the shared analyzer, GENUINELY RED at the
# pre-fix hook -- shlex's default `commenters` stripped '#' to end of line from ANYWHERE inside a
# word, not just where bash itself treats '#' as starting a comment (start of line or after
# whitespace). A mid-word '#' (e.g. a URL fragment) silently discarded the real invocation that
# followed on the same line before the segment scan ever ran. Measured against the pre-fix hook:
# exit=0 there (should be 2). ---

test_case "'#' fail-open FIXED: mid-word '#' no longer hides the real invocation" \
  'echo url#frag; dashboard session enter --phase implementation --title "Session reads full-scan the workspace"' \
  2 \
  'DASHBOARD SESSION ENTER: REFUSING A LIKELY ROOTWARD RETITLE'

# CONTROLS, paired with the case above: pinning the fail-open fix must not become an always-block
# or always-allow rewrite.
test_case "CONTROL: genuine comment still hides the invocation (allowed, matches real bash)" \
  'echo #frag dashboard session enter --phase implementation --title "x"' \
  0

test_case "CONTROL: real invocation with no '#' anywhere still blocks" \
  'dashboard session enter --phase implementation --title "Session reads full-scan the workspace"' \
  2 \
  'DASHBOARD SESSION ENTER: REFUSING A LIKELY ROOTWARD RETITLE'

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
line2 with # here"; dashboard session enter --phase implementation --title "x"' \
  2

test_case "'#' fail-open FIXED (round 8): multi-line single-quoted string, killer after close" \
  'echo '"'"'line1
line2 with # here'"'"'; dashboard session enter --phase implementation --title "x"' \
  2

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
dashboard session enter --phase implementation --title \"x\"" \
  2

test_missing_jq

# --- FLOW-228: an interpreter-fed heredoc whose body
# contains an unbalanced quote made the WHOLE command unparseable by shlex, and the pre-existing
# fail-open unconditionally allowed -- but bash itself parses and RUNS this shape (the heredoc
# body is data to bash's own parser, apostrophe and all), so the real invocation on the line after
# genuinely executed. Fixed by applying this hook's own bare-word check to the raw
# command whenever shlex fails to tokenize -- unconditionally (an earlier
# `bash -n` gate here was tried and removed once its premise was found broken by bash being
# a streaming parser; see process-kill-guard.sh's `except ValueError:` comment for the full story). Measured against the hook before this fix: exit=0
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
dashboard session enter --phase implementation --title "x"' \
  2

test_case "Finding B: parse-failure fallback with no guarded token present stays allowed" \
  'bash <<EOF
don'"'"'t
EOF
dashboard item add' \
  0

# Partial execution -- the exact shape that falsified the earlier `bash -n`
# gate (removed; see process-kill-guard.sh's `except ValueError:` comment for the full story). bash is
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
  'dashboard session enter --phase implementation --title "x"
echo "unterminated' \
  2

test_case "Finding B round-12 CONTROL: no signature, syntax error present, still allowed" \
  'echo ok
echo "unterminated' \
  0

# Real bash treats '#' right after a control operator (';', '|', '&', and
# their doubled forms '&&'/'||') as a comment start even with no whitespace before it -- confirmed
# against real bash (a marker before the operator runs; nothing after the '#' does). The shared
# analyzer's strip_comments() only recognized space/tab/newline as comment-starting boundaries, so
# a real bash comment landing right after one of these operators was left un-stripped and read as
# literal command text -- a false BLOCK on a command bash would never actually run through the
# guarded path. Fixed by adding ';', '|', '&' to the boundary character set (each doubled operator
# is covered too, since its second character is itself ';'/'|'/'&'). Measured against 6a556a8:
# exit=2 there (should be 0).
test_case "CodeRabbit finding 4 FIXED: a real bash comment right after ';' no longer misreads as a real dashboard session enter" \
  'echo ok;#comment: dashboard session enter --phase implementation --title "x"
echo done' \
  0

# See test-no-verify-guard.sh for the full escape-blindness story. Measured against
# 4d06be0: exit=0 (fail-open) there; must be exit=2 here.
test_case "Round 15 FIXED: escaped semicolon before '#' does not hide a real dashboard session enter" \
  'echo a \;#c ; dashboard session enter --phase implementation --title "x"
echo REAL_DONE' \
  2

# See test-process-kill-guard.sh for the full escaped-heredoc-opener story.
# Measured against 6d902e1: exit=0 (fail-open) there; must be exit=2 here.
test_case "Round 16 FIXED: escaped '<' before '<<' no longer hides a real invocation" \
  'cat \<<EOF
dashboard session enter --phase implementation --title "x"
EOF' \
  2

# See test-process-kill-guard.sh for the full backslash/quote-split-interpreter story.
# Measured against b14731c: exit=0 (fail-open) there; must be exit=2 here.
test_case "Round 17 FIXED: a backslash-split interpreter name no longer hides a real invocation" \
  'cat <<EOF | b\ash
dashboard session enter --phase implementation --title "x"
EOF' \
  2

echo
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
