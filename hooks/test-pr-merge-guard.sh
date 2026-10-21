#!/bin/bash
# Test script for pr-merge-guard.sh
# Simulates hook input and verifies expected outcomes.
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
#
# All cases here feed stdin JSON (the repo convention) rather than $CLAUDE_TOOL_INPUT_command /
# $CLAUDE_TOOL_NAME — before FLOW-225's T3 fix, this hook could not read stdin at all and exited 0
# on every command, so these are live reproductions of "the guard never fired," not inspections.
#
# The review-count cases would call `gh` over the network, so the suite stubs `gh` on PATH and
# only covers paths that decide BEFORE that call: admin blocking, mention-vs-invocation, and
# PR-ref extraction. No case asserts against a live PR.

set -euo pipefail

HOOK_SCRIPT="$(dirname "$0")/pr-merge-guard.sh"
PASS=0
FAIL=0

# FLOW-225 (broadened): no plain test_case may reach a real `gh` call — that would assert a
# network/environment outcome, not the hook's scoping decision, and would only fail loudly once
# something about the network or this repo's PR state changed. Rather than audit each case by
# hand (which missed this once already), make it structurally impossible: every test_case runs
# with a POISON `gh` on PATH ahead of the real one. A case that needs `gh` to actually be called
# must stub it itself (assert_pr_ref and the dedicated *_test functions below do exactly that).
POISON_DIR=$(mktemp -d)
POISON_LOG=$(mktemp)
cat > "$POISON_DIR/gh" <<POISON
#!/bin/bash
echo "POISON: plain test_case reached a real gh call: \$@" >> "$POISON_LOG"
exit 1
POISON
chmod +x "$POISON_DIR/gh"
trap 'rm -rf "$POISON_DIR" "$POISON_LOG"' EXIT

test_case() {
  local description="$1"
  local command="$2"
  local expected_exit="$3"  # 0 = allow, 2 = block
  local expected_message="${4:-}"  # optional substring that must appear in the hook's output
                                    # (exit code alone can't distinguish "blocked for
                                    # the right reason" from "blocked for the wrong reason").
                                    # pr-merge-guard.sh writes its BLOCKED messages to stdout, not
                                    # stderr (unlike pr-title-guard.sh), so combine both streams.

  local input
  input=$(jq -n --arg cmd "$command" '{"tool_name": "Bash", "tool_input": {"command": $cmd}}')

  : > "$POISON_LOG"
  local actual_exit=0 combined_output
  combined_output=$(echo "$input" | PATH="$POISON_DIR:$PATH" timeout 15 bash "$HOOK_SCRIPT" 2>&1) || actual_exit=$?

  if [[ -s "$POISON_LOG" ]]; then
    echo "FAIL: $description (reached a real gh call — this case needs a stub, not plain test_case: $(cat "$POISON_LOG"))"
    FAIL=$((FAIL + 1))
    return
  fi

  if [[ "$actual_exit" -ne "$expected_exit" ]]; then
    echo "FAIL: $description (expected exit $expected_exit, got $actual_exit)"
    FAIL=$((FAIL + 1))
    return
  fi

  if [[ -n "$expected_message" ]] && [[ "$combined_output" != *"$expected_message"* ]]; then
    echo "FAIL: $description (exit $actual_exit matched, but output did not contain '$expected_message': $combined_output)"
    FAIL=$((FAIL + 1))
    return
  fi

  echo "PASS: $description"
  PASS=$((PASS + 1))
}

# Asserts the ref pr-merge-guard.sh actually derives, by shimming `gh` on PATH with a stub that
# records its argv and returns the bare integer the real `gh --jq '... | length'` produces — so a
# case that reaches the review-count check still terminates without touching the network.
assert_pr_ref() {
  local description="$1"
  local command="$2"
  local expected_ref="$3"  # empty string means "no ref operand at all"

  local stub_dir
  stub_dir=$(mktemp -d)
  local stub_log
  stub_log=$(mktemp)
  cat > "$stub_dir/gh" <<STUB
#!/bin/bash
echo "\$@" >> "$stub_log"
echo 1
STUB
  chmod +x "$stub_dir/gh"

  local input
  input=$(jq -n --arg cmd "$command" '{"tool_name": "Bash", "tool_input": {"command": $cmd}}')
  local actual_exit=0
  printf '%s' "$input" | PATH="$stub_dir:$PATH" timeout 15 bash "$HOOK_SCRIPT" >/dev/null 2>/dev/null || actual_exit=$?

  local recorded_args
  recorded_args=$(cat "$stub_log" 2>/dev/null || echo "")
  rm -rf "$stub_dir" "$stub_log"

  # The stub's argv-then-`echo 1` shape (matching assert_gh_repo's own stub) is what makes exit 0
  # the correct expectation here: `echo '[]'` is not a valid REVIEW_COUNT, so the guard's own
  # numeric-output check would BLOCK every case regardless of the argv this function exists to
  # assert on -- an exit code this function never checked, so the block went unnoticed.
  if [[ "$actual_exit" -ne 0 ]]; then
    echo "FAIL: $description (expected exit 0 with a real approval count, got $actual_exit; recorded: '$recorded_args')"
    FAIL=$((FAIL + 1))
    return
  fi

  # FLOW-225: an empty actual_ref is ambiguous by itself — it means "no ref operand" both when
  # the hook correctly passed none AND when the hook never called `gh` at all (e.g. it silently
  # allowed instead of reaching the review-count check). Require the call to have actually
  # happened, with the right shape, before trusting the ref parsed out of it.
  if [[ ! "$recorded_args" =~ ^pr\ view\ (--json|[0-9]+|https://) ]]; then
    echo "FAIL: $description (gh was never invoked with 'pr view ...'; recorded: '$recorded_args')"
    FAIL=$((FAIL + 1))
    return
  fi

  local actual_ref=""
  if [[ "$recorded_args" =~ ^pr\ view\ ([0-9]+|https://[^[:space:]]+/pull/[0-9]+)\  ]]; then
    actual_ref="${BASH_REMATCH[1]}"
  fi

  if [[ "$actual_ref" == "$expected_ref" ]]; then
    echo "PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description (expected ref '$expected_ref', got '$actual_ref'; gh invoked with: $recorded_args)"
    FAIL=$((FAIL + 1))
  fi
}

# Asserts the --repo the merge command carried is passed through to the review lookup, by shimming
# `gh` on PATH with a stub that records its argv and returns the bare integer the real `gh --jq
# '... | length'` produces — same stub-on-PATH pattern as assert_pr_ref, so this never reaches the
# network either.
assert_gh_repo() {
  local description="$1"
  local command="$2"
  local expect_present="$3"  # substring that must appear in the recorded argv
  local expect_absent="${4:-}"  # optional substring that must NOT appear in the recorded argv

  local stub_dir
  stub_dir=$(mktemp -d)
  local stub_log
  stub_log=$(mktemp)
  cat > "$stub_dir/gh" <<STUB
#!/bin/bash
echo "\$@" >> "$stub_log"
echo 1
STUB
  chmod +x "$stub_dir/gh"

  local input
  input=$(jq -n --arg cmd "$command" '{"tool_name": "Bash", "tool_input": {"command": $cmd}}')
  local actual_exit=0
  printf '%s' "$input" | PATH="$stub_dir:$PATH" timeout 15 bash "$HOOK_SCRIPT" >/dev/null 2>/dev/null || actual_exit=$?

  local recorded_args
  recorded_args=$(cat "$stub_log" 2>/dev/null || echo "")
  rm -rf "$stub_dir" "$stub_log"

  if [[ "$actual_exit" -ne 0 ]]; then
    echo "FAIL: $description (expected exit 0 with a real approval count, got $actual_exit)"
    FAIL=$((FAIL + 1))
    return
  fi

  if [[ "$recorded_args" != *"$expect_present"* ]]; then
    echo "FAIL: $description (expected argv to contain '$expect_present'; recorded: '$recorded_args')"
    FAIL=$((FAIL + 1))
    return
  fi

  if [[ -n "$expect_absent" ]] && [[ "$recorded_args" == *"$expect_absent"* ]]; then
    echo "FAIL: $description (expected argv NOT to contain '$expect_absent'; recorded: '$recorded_args')"
    FAIL=$((FAIL + 1))
    return
  fi

  echo "PASS: $description"
  PASS=$((PASS + 1))
}

echo "=== PR Merge Guard Tests ==="
echo

# --- Should BLOCK ---

test_case "Admin flag, real invocation" \
  'gh pr merge 295 --admin' \
  2 \
  'BLOCKED: Never use --admin flag'

# --- Should ALLOW (FLOW-225: a mention is not an invocation) ---

test_case "Admin mentioned in prose only, unrelated gh command" \
  'echo "never pass --admin" && gh pr list' \
  0

test_case "Mention of merge in an echo, not an invocation" \
  'echo "then gh pr merge it"' \
  0

# --- FLOW-225 blind spot A, FIXED: previously the tokenizer had no concept of heredoc syntax, so a
# heredoc BODY line was just more newline-delimited text — indistinguishable from a real segment
# (the team lead independently reproduced the same gap in pr-lifecycle-guard.sh with controls both
# ways). strip_heredocs() now removes the heredoc body before tokenizing, so the "invocation"
# inside it is never seen — this uses plain test_case, whose built-in POISON gh (see above) proves
# gh is never called at all, not just that the exit code happens to be 0. See
# FLOW-225.
test_case "Blind spot A FIXED: mention inside a heredoc body is not seen (gh never called)" \
  'cat <<EOF
run gh pr merge later
EOF' \
  0

# --- PR-ref extraction: the ref must come from the merge segment's own operands, never the first
# number on the whole line ---

assert_pr_ref "PR ref not the first number (sleep 5 before the real merge)" \
  'sleep 5 && gh pr merge 295 --squash' \
  '295'

assert_pr_ref "PR ref absent -> current branch (no operand expected)" \
  'gh pr merge --squash' \
  ''

# --- FLOW-225 F11 KNOWN LIMIT (not a regression — base has the same gap): `gh pr merge` accepts
# <number> | <url> | <branch> as its ref operand, but the ref extractor only recognizes digits and
# /pull/ URLs. A branch-name operand is neither, so it's silently dropped and the guard falls back
# to checking the CURRENT branch's PR instead of the named branch's — a different PR's approval
# count decides. Pinning today's actual behavior (empty ref) rather than fixing it here; see
# FLOW-225. ---

assert_pr_ref "KNOWN LIMIT: branch-name ref operand is not recognized, falls back to current branch" \
  'gh pr merge some-other-branch --squash' \
  ''

# --- FLOW-260 carry-in: the merge command's own --repo must reach the review lookup. The rows below
# cover --repo (space), --repo= (equals), -R (space), -R (attached), no flag, ref-before-flag,
# branch-name ref with --repo, -R reached through a clustered boolean flag, an attached short-flag
# value not misread as -R, and a cluster whose remainder becomes the PRECEDING flag's value rather
# than -R's ---

assert_gh_repo "--repo space form is carried through" \
  'gh pr merge 336 --repo acme/widgets --squash' \
  '--repo acme/widgets'

assert_gh_repo "--repo= equals form is carried through" \
  'gh pr merge 336 --repo=acme/widgets --squash' \
  '--repo acme/widgets'

assert_gh_repo "-R short form is carried through" \
  'gh pr merge 336 -R acme/widgets --squash' \
  '--repo acme/widgets'

assert_gh_repo "-R attached short form is carried through" \
  'gh pr merge 336 -Racme/widgets --squash' \
  '--repo acme/widgets'

assert_gh_repo "no repo flag means no --repo in the lookup" \
  'gh pr merge 336 --squash' \
  'pr view 336' \
  '--repo'

assert_gh_repo "the ref still wins when it precedes --repo" \
  'gh pr merge 336 --repo acme/widgets' \
  'pr view 336'

assert_gh_repo "branch-name ref with --repo is still carried through (field-collapse regression)" \
  'gh pr merge some-branch --repo acme/widgets --squash' \
  '--repo acme/widgets'

assert_gh_repo "-R reached through a clustered boolean flag is carried through (e.g. -sR owner/repo)" \
  'gh pr merge 336 -sR acme/widgets' \
  '--repo acme/widgets'

# An 'R' appearing anywhere in a clustered short-flag token is not the same as
# an R reached in flag position -- '-tRelease-v2' is -t (subject) taking "Release-v2" as its value,
# not -R. A naive substring test on the raw token wrongly split this into a --repo value.
assert_gh_repo "-t's value containing a capital R is not misread as -R (over-match regression)" \
  'gh pr merge 336 --squash -tRelease-v2' \
  'pr view 336' \
  '--repo'

assert_gh_repo "-b's attached value is not misread as -R (over-match regression)" \
  'gh pr merge 336 --squash -bReviewed-note' \
  'pr view 336' \
  '--repo'

assert_gh_repo "-tR's remainder becomes -t's value; the following token stays the ref, not swallowed as --repo (worst-case over-match regression)" \
  'gh pr merge --squash -tR 336' \
  'pr view 336' \
  '--repo'

# --- FLOW-280: a value-taking flag's separate-token value is the flag's, never the PR ref. Before the
# fix, '-b <url of another PR>' made the guard check THAT PR's approvals — the guard failed open. ---

assert_pr_ref "-b's separate-token value is not read as the ref (fail-open regression)" \
  'gh pr merge --squash -b https://github.com/o/r/pull/295' \
  ''

assert_pr_ref "--body's separate-token value is not read as the ref (fail-open regression)" \
  'gh pr merge --squash --body https://github.com/o/r/pull/295' \
  ''

assert_pr_ref "-t's separate-token numeric value is not read as the ref" \
  'gh pr merge --squash -t 295' \
  ''

assert_pr_ref "--subject's separate-token numeric value is not read as the ref" \
  'gh pr merge --squash --subject 295' \
  ''

assert_pr_ref "-F's separate-token value is not read as the ref" \
  'gh pr merge --squash -F 295' \
  ''

assert_pr_ref "--body-file's separate-token value is not read as the ref" \
  'gh pr merge --squash --body-file 295' \
  ''

assert_pr_ref "-A's separate-token value is not read as the ref" \
  'gh pr merge --squash -A 295' \
  ''

assert_pr_ref "--author-email's separate-token value is not read as the ref" \
  'gh pr merge --squash --author-email 295' \
  ''

assert_pr_ref "--match-head-commit's separate-token value is not read as the ref" \
  'gh pr merge --squash --match-head-commit 1234567' \
  ''

assert_pr_ref "-sb clustered value flag consumes the next token, not the ref slot" \
  'gh pr merge -sb https://github.com/o/r/pull/295' \
  ''

assert_pr_ref "a real ref after a consumed flag value is still found" \
  'gh pr merge -b https://github.com/o/r/pull/295 336 --squash' \
  '336'

assert_pr_ref "--body= equals form never consumed the next token (control on the = form)" \
  'gh pr merge --squash --body=https://github.com/o/r/pull/295 336' \
  '336'

assert_gh_repo "-sR= strips the = from the attached repo value" \
  'gh pr merge 336 -sR=acme/widgets' \
  '--repo acme/widgets' \
  '--repo ='

# --- FLOW-225 Shape 4 — DELIBERATE, PINNED, NOT FIXED. An unquoted single-line mention still
# blocks: `echo gh pr merge 295` matches `gh`/`pr`/`merge` as tokens in the SAME segment,
# indistinguishable from a real invocation, because the scan matches anywhere in a segment rather
# than requiring `gh` to be at COMMAND POSITION. Fixing that would need position-matching plus a
# wrapper allowlist (sudo/env/timeout/... prefixes still need to count as "really is gh"), which is
# the design `dangerous-command-guard.sh` used until FLOW-228, whose keyword list of ordinary English
# words (`do`, `then`, `else`, `time`, `command`, `env`) false-blocked prose --
# FLOW-228.
# Anywhere-in-segment fails toward BLOCKING; command-position-plus-allowlist fails toward ALLOWING.
# For a guard, the fail-open is the worse error, so anywhere-in-segment stays. The unquoted-mention
# false block is this trade's accepted price — pin it, do not "fix" it. See
# FLOW-225.
#
# Uses its own gh stub (0 approvals, deterministic) rather than plain test_case, since the mention
# IS treated as a real merge segment here and does reach the review-count check — matching the
# stub-gh rule above ("stub gh whenever a case can reach that call").
shape4_pinned_test() {
  local description="Shape 4 PINNED: unquoted single-line mention still blocks (deliberate trade, not a bug)"
  local stub_dir
  stub_dir=$(mktemp -d)
  cat > "$stub_dir/gh" <<'STUB'
#!/bin/bash
echo "0"
STUB
  chmod +x "$stub_dir/gh"

  local input
  input=$(jq -n --arg cmd 'echo gh pr merge 295' '{"tool_name": "Bash", "tool_input": {"command": $cmd}}')
  local actual_exit=0
  printf '%s' "$input" | PATH="$stub_dir:$PATH" timeout 15 bash "$HOOK_SCRIPT" >/dev/null 2>/dev/null || actual_exit=$?
  rm -rf "$stub_dir"

  if [[ "$actual_exit" -eq 2 ]]; then
    echo "PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description (expected exit 2, got $actual_exit)"
    FAIL=$((FAIL + 1))
  fi
}
shape4_pinned_test

# --- FLOW-260: a `gh` invocation that succeeds (exit 0) but emits something other than a bare
# integer must fail CLOSED, not silently allow. `[[ "$REVIEW_COUNT" -lt 1 ]]` on non-numeric input
# is a bash arithmetic error, and with the review-count check's own `2>/dev/null` in front of it
# that error is swallowed, evaluates false, and the merge proceeds unreviewed — the opposite of the
# comment's claim that this path "already fails closed on any gh failure by design."
non_numeric_review_count_test() {
  local description="Non-numeric gh output (e.g. malformed --jq shape) blocks, does not silently allow"
  local stub_dir
  stub_dir=$(mktemp -d)
  cat > "$stub_dir/gh" <<'STUB'
#!/bin/bash
echo '[]'
STUB
  chmod +x "$stub_dir/gh"

  local input
  input=$(jq -n --arg cmd 'gh pr merge 336 --squash' '{"tool_name": "Bash", "tool_input": {"command": $cmd}}')
  local actual_exit=0 combined_output
  combined_output=$(printf '%s' "$input" | PATH="$stub_dir:$PATH" timeout 15 bash "$HOOK_SCRIPT" 2>&1) || actual_exit=$?
  rm -rf "$stub_dir"

  if [[ "$actual_exit" -ne 2 ]]; then
    echo "FAIL: $description (expected exit 2, got $actual_exit)"
    FAIL=$((FAIL + 1))
    return
  fi

  if [[ "$combined_output" != *"Could not parse PR review count"* ]]; then
    echo "FAIL: $description (exit 2 matched, but message did not name the parse failure: $combined_output)"
    FAIL=$((FAIL + 1))
    return
  fi

  echo "PASS: $description"
  PASS=$((PASS + 1))
}
non_numeric_review_count_test

# --- FLOW-225: check EVERY merge segment, not just the first. A stub that approves PR #1 but not
# PR #2 — if the hook stopped at the first segment (the pre-fix defect), this would incorrectly
# allow; only a hook that keeps checking after a passing segment catches the second, unapproved one.
two_merge_segments_test() {
  local description="Two merge segments: first approved, second is not — must still block"
  local stub_dir
  stub_dir=$(mktemp -d)
  cat > "$stub_dir/gh" <<'STUB'
#!/bin/bash
# args: pr view [<ref>] --json reviews --jq '...'
if [[ "$3" == "--json" ]]; then
  ref=""
else
  ref="$3"
fi
if [[ "$ref" == "1" ]]; then
  echo "2"   # PR #1: 2 approvals
else
  echo "0"   # PR #2 (or current branch): 0 approvals
fi
STUB
  chmod +x "$stub_dir/gh"

  local input
  input=$(jq -n --arg cmd 'gh pr merge 1 --squash ; gh pr merge 2 --squash' \
    '{"tool_name": "Bash", "tool_input": {"command": $cmd}}')
  local actual_exit=0
  local output
  output=$(printf '%s' "$input" | PATH="$stub_dir:$PATH" timeout 15 bash "$HOOK_SCRIPT" 2>/dev/null) || actual_exit=$?
  rm -rf "$stub_dir"

  if [[ "$actual_exit" -eq 2 && "$output" == *"BLOCKED: PR has no approvals"* ]]; then
    echo "PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description (expected exit 2 with 'PR has no approvals', got $actual_exit: $output)"
    FAIL=$((FAIL + 1))
  fi
}
two_merge_segments_test

# --- FLOW-225 blind spot B (the same fix generalised to this hook): a leading subshell/negation/substitution
# operator ('(', '$(', backtick, '!') is not in punctuation_chars, so it fuses onto 'gh' instead of
# becoming its own token — '(gh' / '$(gh' never equalled 'gh' by exact comparison, and a path
# prefix ('/usr/bin/gh') never equalled the bare name either, so --admin silently stopped being
# caught under either shape. Fixed via normalize_bin()/strip_shell_meta(), same as
# pr-title-guard.sh and no-verify-guard.sh. ---

test_case "Blind spot B: --admin via absolute path to gh" \
  '/usr/bin/gh pr merge 295 --admin' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "Blind spot B: --admin inside subshell parens" \
  '(gh pr merge 295 --admin)' \
  2 \
  'BLOCKED: Never use --admin flag'

# --- Anti-vacuity control (T3): this is RED before T3 — under stdin, the unmodified hook read
# $CLAUDE_TOOL_INPUT_command only, which is empty here, so it exited 0 on every command including
# this one. Without this control, "the hook reads stdin now" is unproven. ---

test_case "CONTROL: fires at all under stdin (RED pre-T3, confirms the input-contract fix)" \
  'gh pr merge 295 --admin' \
  2 \
  'BLOCKED: Never use --admin flag'

# --- strip_heredocs() previously treated every
# heredoc body as DATA, but a heredoc that feeds an INTERPRETER (bash, sh, eval, or is piped to
# one) actually executes its body — stripping it let the real --admin invocation inside walk
# straight through the guard. line_has_interpreter() now refuses to strip when the opener line
# names one. All six forms use --admin, which short-circuits before any gh call, so plain
# test_case (with its POISON gh) is safe here. RED-verified against 8311ddf (all six exit=0
# there); must be exit=2 here. ---

test_case "R1 FIXED: bash <<EOF feeds an interpreter, body must not be stripped" \
  'bash <<EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "R1 FIXED: sh <<EOF feeds an interpreter" \
  'sh <<EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "R1 FIXED: bash -s with a quoted heredoc delimiter still recognized as interpreter-fed" \
  "bash -s <<'EOF'
gh pr merge 295 --admin
EOF" \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "R1 FIXED: bash <<-EOF (dash form) still recognized as interpreter-fed" \
  'bash <<-EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "R1 FIXED: eval <<EOF feeds an interpreter" \
  'eval <<EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "R1 FIXED: cat <<EOF | bash pipes an interpreter-fed heredoc" \
  'cat <<EOF | bash
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

# --- A '<<' inside a QUOTED string on the opener
# line was misread as a real heredoc opener, and the real invocation on the next line got deleted
# as "body" before an unrelated later line that happened to equal the fake delimiter.
# is_outside_quotes() now refuses to treat a quoted '<<' as an opener at all. RED-verified against
# 8311ddf (exit=0 there, the real invocation was silently deleted); must be exit=2 here. ---

test_case "R2 FIXED: quoted << on the opener line is not a real heredoc, real invocation stays visible" \
  'echo "docs say <<EOF"
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

# --- line_has_interpreter() alone was a BLOCKLIST, so
# its failure axis was membership -- a consumer name absent from the set (an env-var interpreter,
# or an interpreter the list never named) read as "not an interpreter" and got stripped, executing
# right through the guard. Fixed by inverting to a DATA-SINK allowlist (line_has_data_sink(),
# {'cat'} — the only data-sink observed feeding a heredoc anywhere in this repo) ANDed with the
# existing interpreter check. RED-verified against 7e85d8f (all eleven forms exit=0 there); must
# be exit=2 here. All eleven use --admin, which short-circuits before any gh call, so plain
# test_case (with its POISON gh) is safe. Tier A ($SHELL/${INTERP}) is directly exploitable; tier B
# (node, deno, bun, awk, php, lua, tclsh) is every interpreter name the old blocklist never had;
# tier C (ssh) confirms the fix isn't just "consumer is the first word on the line" — 'host' sits
# between 'ssh' and '<<EOF' and neither is a data sink. ---

test_case "A1 FIXED tier A: \$SHELL <<EOF" \
  '$SHELL <<EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case 'A1 FIXED tier A: ${INTERP} <<EOF' \
  '${INTERP} <<EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case 'A1 FIXED tier A: "$SHELL" <<EOF (quoted)' \
  '"$SHELL" <<EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "A1 FIXED tier B: node <<EOF" \
  'node <<EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "A1 FIXED tier B: deno <<EOF" \
  'deno <<EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "A1 FIXED tier B: bun <<EOF" \
  'bun <<EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "A1 FIXED tier B: awk <<EOF" \
  'awk <<EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "A1 FIXED tier B: php <<EOF" \
  'php <<EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "A1 FIXED tier B: lua <<EOF" \
  'lua <<EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "A1 FIXED tier B: tclsh <<EOF" \
  'tclsh <<EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "A1 FIXED tier C: ssh host <<EOF" \
  'ssh host <<EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

# --- HEREDOC_RE matched a '<<<' here-string as if it were
# a real heredoc opener -- for 'cat <<<EOF', finditer matched '<<EOF' starting at the SECOND '<',
# found delimiter 'EOF', and strip_heredocs() deleted everything up to a later bare 'EOF' line,
# hiding a real invocation between them. Same shape as the quoted-<< case above: the pre-pass stripping when it should
# not. Fixed with a negative lookbehind so '<<' immediately preceded by another '<' is never
# treated as an opener. RED-verified against 336b367 (exit=0 there); must be exit=2 here. ---

test_case "CodeRabbit (1) FIXED: <<< here-string is not a heredoc opener" \
  'cat <<<EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

# --- has_admin() only matched the bare '--admin' flag, so
# '--admin=true' walked straight through the admin-bypass block. Judgment call, made explicitly at
# the code site: also blocks '--admin=false', since a guard fails toward blocking and the recovery
# is to drop the flag entirely. RED-verified against 336b367 (exit=0 there); must be exit=2 here. ---

test_case "CodeRabbit (2) FIXED: --admin=true (assignment form) is caught" \
  'gh pr merge 295 --admin=true' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "CodeRabbit (2) FIXED: --admin=false is also blocked (deliberate, see code comment)" \
  'gh pr merge 295 --admin=false' \
  2 \
  'BLOCKED: Never use --admin flag'

# --- The gh pr view call had no timeout (a network call
# on the PreToolUse path could hang the tool invocation indefinitely) and inherited the loop's
# '<<<' here-string as its own stdin, so the FIRST call's `gh` could consume a LATER iteration's
# MERGE line before the loop's own `read` ever got to it. Reproducing this needs TWO merge
# segments with the first one passing (so the loop actually reaches the second `read`) -- with only
# one segment, or with the first call blocking outright, there is nothing left in the here-string
# to leak, which is why an earlier version of this test passed for the wrong reason (single segment,
# no leftover data) and had to be redone. `read -t 1` (not a short timeout): the leaked data reaches
# a newly-exec'd external process, and a race against process-startup scheduling reports CLEAN by
# accident when the deadline is too tight -- caught by first testing this against 336b367, where a
# 0.2s deadline gave a false CLEAN and a 1s deadline correctly showed the leak. Fixed with
# `timeout 15 ... </dev/null`, with `timeout` itself guarded so its absence (not every environment
# ships GNU coreutils) can't turn every legitimate merge into a block -- this path already fails
# closed on any `gh` failure by design.
cr3_stdin_isolation_test() {
  local description="CodeRabbit (3) FIXED: gh does not inherit the loop's here-string as stdin"
  local stub_dir
  stub_dir=$(mktemp -d)
  local stub_log
  stub_log=$(mktemp)
  cat > "$stub_dir/gh" <<STUB
#!/bin/bash
if read -t 1 -r line 2>/dev/null; then
  echo "LEAKED:\$line" >> "$stub_log"
else
  echo "CLEAN" >> "$stub_log"
fi
echo "5"
STUB
  chmod +x "$stub_dir/gh"

  local input
  input=$(jq -n --arg cmd 'gh pr merge 1 --squash ; gh pr merge 2 --squash' '{"tool_name": "Bash", "tool_input": {"command": $cmd}}')
  printf '%s' "$input" | PATH="$stub_dir:$PATH" timeout 15 bash "$HOOK_SCRIPT" >/dev/null 2>/dev/null || true

  local stub_result
  stub_result=$(cat "$stub_log" 2>/dev/null || echo "")
  rm -rf "$stub_dir" "$stub_log"

  if [[ "$stub_result" == $'CLEAN\nCLEAN' ]]; then
    echo "PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description (gh's stdin was not clean on both calls: $stub_result)"
    FAIL=$((FAIL + 1))
  fi
}
cr3_stdin_isolation_test

# --- FLOW-228: '#' comment-boundary fail-open in the shared analyzer, GENUINELY RED at the
# pre-fix hook -- shlex's default `commenters` stripped '#' to end of line from ANYWHERE inside a
# word, not just where bash itself treats '#' as starting a comment (start of line or after
# whitespace). A mid-word '#' (e.g. a URL fragment) silently discarded the real invocation that
# followed on the same line before the segment scan ever ran. Measured against the pre-fix hook:
# exit=0 there (should be 2). The --admin decision is made before any real `gh` call, so this is
# safe under plain test_case (POISON_DIR still guards it). ---

test_case "'#' fail-open FIXED: mid-word '#' no longer hides the real invocation" \
  'echo url#frag; gh pr merge 295 --admin' \
  2 \
  'BLOCKED: Never use --admin flag'

# CONTROLS, paired with the case above: pinning the fail-open fix must not become an always-block
# or always-allow rewrite.
test_case "CONTROL: genuine comment still hides the invocation (allowed, matches real bash)" \
  'echo #frag gh pr merge 295 --admin' \
  0

test_case "CONTROL: real invocation with no '#' anywhere still blocks" \
  'gh pr merge 295 --admin' \
  2 \
  'BLOCKED: Never use --admin flag'

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
# The --admin decision is made before any real `gh` call, so this is safe under plain test_case
# (POISON_DIR still guards it).
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
line2 with # here"; gh pr merge 295 --admin' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "'#' fail-open FIXED (round 8): multi-line single-quoted string, killer after close" \
  'echo '"'"'line1
line2 with # here'"'"'; gh pr merge 295 --admin' \
  2 \
  'BLOCKED: Never use --admin flag'

# --- strip_comments() called is_outside_quotes() against the ORIGINAL
# command, so a quote character INSIDE a comment that gets stripped still counted toward quote
# state at a LATER '#' -- bash never lets a stripped comment affect quoting, but this code did.
# Fixed by evaluating quote state over the ACCUMULATED OUTPUT kept so far, not the original
# command, so a stripped comment's own characters can never poison a later check. The --admin
# decision is made before any real `gh` call, so this is safe under plain test_case (POISON_DIR
# still guards it).
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
gh pr merge 295 --admin" \
  2 \
  'BLOCKED: Never use --admin flag'

# --- FLOW-228: an interpreter-fed heredoc whose body
# contains an unbalanced quote made the WHOLE command unparseable by shlex, and the pre-existing
# fail-open unconditionally allowed -- but bash itself parses and RUNS this shape (the heredoc
# body is data to bash's own parser, apostrophe and all), so the real invocation on the line after
# genuinely executed. Fixed by applying this hook's own bare-word check to the raw
# command whenever shlex fails to tokenize -- unconditionally (an earlier
# `bash -n` gate here was tried and removed once its premise was found broken by bash being
# a streaming parser; see dangerous-command-guard.sh's `except ValueError:` comment for the full story). The fallback signals ADMIN (not MERGE) so it
# never reaches a real `gh` call -- safe under plain test_case, POISON_DIR still guards it.
# Measured against the hook before this fix: exit=0 there (should be 2).
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

# This command carries no --admin flag at all -- the parse-failure fallback
# was signaling ADMIN (and this test was asserting the ADMIN message) for ANY gh/pr/merge match,
# regardless of --admin. The SIGNAL was wrong, not this test's shape; fixed by splitting the
# fallback into a distinct UNPARSEABLE_MERGE signal with its own accurate message, and updating
# this test's expected message to match (it still expects exit 2 -- blocking here was always
# correct, only the claimed reason was wrong).
test_case "Finding B FIXED: heredoc body with an apostrophe no longer hides the real invocation" \
  'bash <<EOF
don'"'"'t
EOF
gh pr merge 295' \
  2 \
  "BLOCKED: could not safely parse this command"

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
  'gh pr merge 295 --admin
echo "unterminated' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "Finding B round-12 CONTROL: no signature, syntax error present, still allowed" \
  'echo ok
echo "unterminated' \
  0

# The parse-failure fallback's --admin regex only anchored on
# whitespace/string-edges, so a QUOTED --admin was invisible to it and fell through to the
# fail-open default. Fixed by adding quote characters to both boundary character classes (same
# fix as no-verify-guard.sh's --no-verify check). Measured against the pre-fix hook (6a556a8):
# exit=0 there (should be 2).
test_case "CodeRabbit finding 1 FIXED: quoted --admin flag alone still blocks on parse failure" \
  'somecmd "--admin"
echo "unterminated' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "CodeRabbit finding 1 FIXED: quoted --admin flag on a gh pr merge line still blocks on parse failure" \
  'gh pr merge 295 "--admin"
echo "unterminated' \
  2 \
  'BLOCKED: Never use --admin flag'

# The new UNPARSEABLE_MERGE signal, exercised directly (not via a heredoc)
# -- a parse failure whose raw text carries a gh/pr/merge signature but no --admin match.
test_case "CodeRabbit finding 2 FIXED: gh/pr/merge signature with no --admin gets the accurate message" \
  'gh pr merge 295
echo "unterminated' \
  2 \
  "BLOCKED: could not safely parse this command"

test_case "CodeRabbit finding 2 CONTROL: --admin present takes priority over the gh/pr/merge signature" \
  'gh pr merge 295 --admin
echo "unterminated' \
  2 \
  'BLOCKED: Never use --admin flag'

# See test-dangerous-command-guard.sh for the full escaped-heredoc-opener story.
# Measured against 6d902e1: exit=0 (fail-open) there; must be exit=2 here.
test_case "Round 16 FIXED: escaped '<' before '<<' no longer hides a real invocation" \
  'cat \<<EOF
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

# See test-dangerous-command-guard.sh for the full backslash/quote-split-interpreter story.
# Measured against b14731c: exit=0 (fail-open) there; must be exit=2 here.
test_case "Round 17 FIXED: a backslash-split interpreter name no longer hides a real invocation" \
  'cat <<EOF | b\ash
gh pr merge 295 --admin
EOF' \
  2 \
  'BLOCKED: Never use --admin flag'

# See test-no-verify-guard.sh for the full command-substitution story. Measured against
# b14731c: exit=0 (fail-open) there; must be exit=2 here.
test_case "Round 18 FIXED: --admin inside a DOUBLE-quoted backtick span is a real substitution, must block" \
  'echo "docs: `gh pr merge 295 --admin`"' \
  2 \
  'BLOCKED: Never use --admin flag'

test_case "Round 18 CONTROL: --admin inside a SINGLE-quoted backtick span is a literal mention, must allow" \
  "echo 'docs: \`gh pr merge 295 --admin\`'" \
  0


# See test-dashboard-enter-guard.sh for the full bash-ground-truth story.
# Measured against 6a556a8: exit=2 there (should be 0).
test_case "CodeRabbit finding 4 FIXED: a real bash comment right after ';' no longer misreads as a real gh pr merge" \
  'echo ok;#comment: gh pr merge 295 --admin
echo done' \
  0

# See test-no-verify-guard.sh for the full escape-blindness story. Measured against
# 4d06be0: exit=0 (fail-open) there; must be exit=2 here.
test_case "Round 15 FIXED: escaped semicolon before '#' does not hide a real gh pr merge --admin" \
  'echo a \;#c ; gh pr merge 295 --admin
echo REAL_DONE' \
  2 \
  'BLOCKED: Never use --admin flag'


# See test-dangerous-command-guard.sh for the full accepted-over-block story.
test_case "Round 20 ACCEPTED OVER-BLOCK: the admin flag mentioned inside a substitution's searched data, never executed" \
  'echo "$(grep --admin README.md)"' \
  2 \
  'BLOCKED: Never use --admin flag'

echo
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
