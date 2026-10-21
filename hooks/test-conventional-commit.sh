#!/bin/bash
# Test script for conventional-commit.sh
# Simulates hook input and verifies expected outcomes

set -euo pipefail

HOOK_SCRIPT="${HOOK_SCRIPT_OVERRIDE:-$(dirname "$0")/conventional-commit.sh}"
PASS=0
FAIL=0

test_case() {
  local description="$1"
  local command="$2"
  local expected_exit="$3"  # 0 = allow, 2 = block
  local expected_message="${4:-}"  # optional substring that must appear on stderr

  local input
  input=$(jq -n --arg cmd "$command" '{"tool_input": {"command": $cmd}}')

  local actual_exit=0 stderr_output
  stderr_output=$(echo "$input" | bash "$HOOK_SCRIPT" 2>&1 >/dev/null) || actual_exit=$?

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

echo "=== Conventional Commit Tests ==="
echo

# --- Should ALLOW (valid messages) ---

test_case "Double-quoted -m feat" \
  "git commit -m \"feat: add user authentication\"" \
  0

test_case "Valid type chore (-m)" \
  "git commit -m \"chore: [FLOW-349] address review round\"" \
  0

test_case "Single-quoted -m feat" \
  "git commit -m 'feat: add user authentication'" \
  0

test_case "Double-quoted -m fix with ticket" \
  "git commit -m \"fix: [FLOW-99] use portable whitespace\"" \
  0

test_case "Scope and ticket" \
  "git commit -m \"feat(api): [DEV-456] add pagination support\"" \
  0

test_case "--message= form" \
  "git commit --message=\"feat: add thing\"" \
  0

test_case "--message separate-arg form" \
  "git commit --message \"feat: add thing\"" \
  0

test_case "Heredoc body, valid fix" \
  "git commit -m \"\$(cat <<'EOF'
fix: [FLOW-99] use POSIX character class for portable whitespace
EOF
)\"" \
  0

test_case "Heredoc body, multiline (subject only validated)" \
  "git commit -m \"\$(cat <<'EOF'
feat: [FLOW-1] subject line
extended body paragraph that is not validated
EOF
)\"" \
  0

test_case "Heredoc with hyphenated delimiter, valid" \
  "git commit -m \"\$(cat <<'MSG-END'
feat: [FLOW-99] hyphenated heredoc delimiter
MSG-END
)\"" \
  0

# --- Should BLOCK (invalid messages) ---

test_case "Invalid type docs (-m)" \
  "git commit -m \"docs: update readme\"" \
  2

test_case "Missing type prefix" \
  "git commit -m \"add user authentication\"" \
  2

test_case "Bracket in description" \
  "git commit -m \"feat: add [thing]\"" \
  2

test_case "Invalid type via --message=" \
  "git commit --message=\"docs: bump dependency\"" \
  2

test_case "Heredoc body, invalid docs" \
  "git commit -m \"\$(cat <<'EOF'
docs: this must be blocked
EOF
)\"" \
  2

# --- Should ALLOW (not a validatable commit) ---

test_case "Not a git commit command" \
  "git push origin main" \
  0

test_case "Interactive amend (no message)" \
  "git commit --amend --no-edit" \
  0

test_case "Message from file (-F)" \
  "git commit -F /tmp/msg" \
  0

test_case "No command at all" \
  "echo hello" \
  0

# --- Defect 1 (FLOW-183): heredoc body containing a literal quote must not truncate/corrupt the
# extracted subject. A stray quote on the subject line, closed by a second stray quote on a later
# body line, is the shape that reproduces silent truncation without raising a shlex ValueError
# (verified empirically — see hooks/test-*-RED transcripts). The truncated fragment fails the
# conventional-commit regex, so the pre-fix hook spuriously BLOCKS a valid subject. ---

test_case "Heredoc subject containing a literal quote is not truncated/blocked" \
  "git commit -m \"\$(cat <<'EOF'
fix: [FLOW-183] handle \"quoted term
and it closes the quote here\"
EOF
)\"" \
  0

# --- Defect 1 (FLOW-183): whole-command substring matching false-fires on free text. The old
# `grep 'git[[:space:]]+commit'` prefilter matches the phrase ANYWHERE in the command, including
# inside another command's UNQUOTED heredoc body (writing a file that documents/contains an
# example git commit invocation) — the same class of bug as pr-lifecycle-guard.sh's `gh pr create`
# false-fire, and reproduced live this session (writing this very test file tripped it). A quoted
# mention collapses to a single shlex token so it can never match 'git','commit' as two separate
# tokens; segment-scoping additionally confines the match to a `git commit` segment rather than
# the whole command's free text. Known shared limitation (same as pr-lifecycle-guard.sh): a
# mention that is unquoted AND immediately follows another real command name in the SAME segment
# (e.g. `echo git commit -m nope`, no chaining operator) is not distinguished from a real
# sub-invocation — segment-scoping fixes quoted/chained free text, not this narrower shape.

test_case "False-fire avoided: git commit as free text in an unquoted heredoc body (file write)" \
  "cat > /tmp/flow183-test-scratch.txt << 'BASHEOF'
git commit -m \"explain the thing\"
BASHEOF" \
  0

test_case "Chained: unrelated command && a real git commit with a valid message is still validated" \
  'echo hello && git commit -m "fix: [FLOW-1] ok"' \
  0

test_case "Chained: unrelated command && a real git commit with an invalid message is still blocked" \
  'echo hello && git commit -m "no type prefix here"' \
  2

# --- Every git commit segment must be validated independently, not
# just the first one found. Two chained real commits both run -- a "first subject wins" check let
# the second, invalid one bypass validation entirely. Field-parity fix vs. pr-lifecycle-guard.sh,
# which already OR-accumulates across every matching segment. Pre-existing on both caaddc6 and
# cbbb759 (this PR's own first pass); see hooks/test-*-RED transcripts. ---

test_case "Two chained git commits: first valid, second invalid -- must still block" \
  'git commit -m "fix: [FLOW-1] ok" && git commit -m "nope"' \
  2

test_case "Two chained git commits, both valid -- must allow" \
  'git commit -m "fix: [FLOW-1] one" && git commit -m "fix: [FLOW-2] two"' \
  0

# --- -m combined with other short flags (-am, -vm, ...) must still
# be validated, not silently skipped. git allows -m to be clustered as long as it is last in the
# cluster; the message is still the next arg. Pre-existing on both caaddc6 and cbbb759. Taken
# deliberately as part of this PR since it lands in the function just rewritten, even though it is
# a different bug class (flag parsing, not chaining/heredocs) -- see hooks/test-*-RED transcripts. ---

test_case "-am combined short flag with an invalid message is blocked" \
  'git commit -am "nope"' \
  2

test_case "-am combined short flag with a valid message is allowed" \
  'git commit -am "fix: [FLOW-1] ok"' \
  0

# --- An explicitly-empty commit subject bypasses validation.
# A present-but-empty message value (-m "", -am "") is a real invalid subject and must block; this
# is distinct from NO message flag being present at all (interactive/editor flow), which must keep
# failing open. Pre-existing on caaddc6, cbbb759, and 40188f9 (this PR's own prior commits) -- see
# hooks/test-*-RED transcripts. ---

test_case "Present-but-empty message (--allow-empty-message -m \"\") is blocked" \
  'git commit --allow-empty-message -m ""' \
  2

test_case "Present-but-empty message via -am \"\" is blocked" \
  'git commit -am ""' \
  2

test_case "No message flag at all (editor flow) still fails open -- no regression" \
  'git commit' \
  0

test_case "Chained: one valid commit and one empty-message commit -- must still block" \
  'git commit -m "fix: [FLOW-1] ok" && git commit -m ""' \
  2

# --- Missing jq (Defect 2): the hook must fail open, not abort under set -e ---

test_missing_jq() {
  local description="jq unavailable on PATH — fails open (exit 0), not exit 127"
  local tmpbin
  tmpbin=$(mktemp -d)
  local tool src
  for tool in cat grep sed python3 bash env printf; do
    src=$(command -v "$tool" 2>/dev/null) || continue
    ln -s "$src" "$tmpbin/$tool"
  done

  local input
  input=$(jq -n --arg cmd 'git commit -m "feat: add thing"' '{"tool_input": {"command": $cmd}}')

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

test_missing_jq

# The rejection message is the one statement of the format an agent reads at the
# moment it is blocked, so it is the site where an unbounded statement does the
# most damage: it says the commit message does not follow the format, and a
# reader with no other context takes that to govern the whole message. Asserted
# on stderr and on the exit status together -- the text alone would pass if the
# hook stopped blocking, and the status alone cannot see what it said.
test_rejection_states_its_scope() {
  local input actual_exit=0 err

  input=$(jq -n --arg cmd 'git commit -m "no type here"' '{"tool_input": {"command": $cmd}}')
  err=$(echo "$input" | bash "$HOOK_SCRIPT" 2>&1 >/dev/null) || actual_exit=$?

  if [[ "$actual_exit" -eq 2 ]] && [[ "$err" == *"Only the subject line is checked."* ]]; then
    echo "PASS: the rejection message states that only the subject line is checked"
    PASS=$((PASS + 1))
  else
    echo "FAIL: the rejection message states that only the subject line is checked (exit $actual_exit)"
    FAIL=$((FAIL + 1))
  fi
}

test_rejection_states_its_scope

# The scope sentence above is only the first of the four claims the rejection message makes, and a
# substring match on it is green either side of an edit to any of the other three -- which is how the
# mechanism claim below shipped false: it asserted blindness to everything under the subject, where
# the truth is that the hook reads the whole message and validates one line of it. One check per
# claim, so reverting any one of them goes red on its own; a single check over the whole block would
# go red for all four and name none.
test_rejection_states_what_is_unvalidated() {
  local input actual_exit=0 err

  input=$(jq -n --arg cmd 'git commit -m "no type here"' '{"tool_input": {"command": $cmd}}')
  err=$(echo "$input" | bash "$HOOK_SCRIPT" 2>&1 >/dev/null) || actual_exit=$?

  if [[ "$actual_exit" -eq 2 ]] && [[ "$err" == *"Nothing below the first line is validated,"* ]]; then
    echo "PASS: the rejection message says what below the subject goes unvalidated"
    PASS=$((PASS + 1))
  else
    echo "FAIL: the rejection message says what below the subject goes unvalidated (exit $actual_exit)"
    FAIL=$((FAIL + 1))
  fi
}

test_rejection_states_what_is_unvalidated

test_rejection_states_it_does_not_rewrite() {
  local input actual_exit=0 err

  input=$(jq -n --arg cmd 'git commit -m "no type here"' '{"tool_input": {"command": $cmd}}')
  err=$(echo "$input" | bash "$HOOK_SCRIPT" 2>&1 >/dev/null) || actual_exit=$?

  if [[ "$actual_exit" -eq 2 ]] \
     && [[ "$err" == *"This hook neither rejects nor rewrites what sits below"* ]]; then
    echo "PASS: the rejection message says the hook does not rewrite below the subject"
    PASS=$((PASS + 1))
  else
    echo "FAIL: the rejection message says it does not rewrite below the subject (exit $actual_exit)"
    FAIL=$((FAIL + 1))
  fi
}

test_rejection_states_it_does_not_rewrite

# Narrower than the three around it, and named for what it asserts rather than
# for the property it serves: it forbids one two-word literal, the one that
# shipped false. The property -- that the message claims nothing about what the
# hook reads -- is semantic, and the positive half of it is carried by the check
# above. A false mechanism claim in different words passes this.
test_rejection_carries_no_unread_literal() {
  local input actual_exit=0 err

  input=$(jq -n --arg cmd 'git commit -m "no type here"' '{"tool_input": {"command": $cmd}}')
  err=$(echo "$input" | bash "$HOOK_SCRIPT" 2>&1 >/dev/null) || actual_exit=$?

  if [[ "$actual_exit" -eq 2 ]] && [[ "$err" != *"never read"* ]]; then
    echo "PASS: the rejection message drops the never-read phrasing"
    PASS=$((PASS + 1))
  else
    echo "FAIL: the rejection message drops the never-read phrasing (exit $actual_exit)"
    FAIL=$((FAIL + 1))
  fi
}

test_rejection_carries_no_unread_literal

# FLOW-315's own hole, in the one place an agent reads while being told no: a message that describes
# text it does not check, and stops there, reads as permission to change that text. This asserts the
# denial is present, not merely that the description is.
test_rejection_licenses_no_edit() {
  local input actual_exit=0 err

  input=$(jq -n --arg cmd 'git commit -m "no type here"' '{"tool_input": {"command": $cmd}}')
  err=$(echo "$input" | bash "$HOOK_SCRIPT" 2>&1 >/dev/null) || actual_exit=$?

  if [[ "$actual_exit" -eq 2 ]] \
     && [[ "$err" == *"nothing here licenses editing text it does not check."* ]]; then
    echo "PASS: the rejection message refuses any licence to edit unchecked text"
    PASS=$((PASS + 1))
  else
    echo "FAIL: the rejection message refuses any licence to edit unchecked text (exit $actual_exit)"
    FAIL=$((FAIL + 1))
  fi
}

test_rejection_licenses_no_edit

# --- FLOW-225 Shape 4 — DELIBERATE, PINNED, NOT FIXED. A property of the shared tokenizer design,
# not of anything FLOW-225 changed in THIS file (conventional-commit.sh is otherwise unmodified by
# that ticket) — recorded here because the same tokenizer shape lives in this hook too. An unquoted
# single-line mention still blocks: `echo git commit -m bad-message` matches `git`/`commit` as
# tokens in the SAME segment, indistinguishable from a real invocation, because the scan matches
# anywhere in a segment rather than requiring `git` to be at COMMAND POSITION. Fixing that would
# need position-matching plus a wrapper allowlist (sudo/env/timeout/... prefixes still need to
# count as "really is git"), which is the design `dangerous-command-guard.sh` used until FLOW-228, whose
# keyword list of ordinary English words (`do`, `then`, `else`, `time`, `command`, `env`)
# false-blocked prose -- FLOW-228. Anywhere-in-segment fails
# toward BLOCKING; command-position-plus-allowlist fails toward ALLOWING. For a guard, the fail-open
# is the worse error, so anywhere-in-segment stays. The unquoted-mention false block is this
# trade's accepted price — pin it, do not "fix" it. See
# FLOW-225.
test_case "Shape 4 PINNED: unquoted single-line mention still blocks (deliberate trade, not a bug)" \
  "echo git commit -m bad-message" \
  2

test_case "Rejection text shows the ticket as optional and used only when one exists" \
  "git commit -m \"not a conventional message\"" \
  2 \
  $'Required format: <type>[(scope)]: [TICKET-123] <description>\n(the [TICKET-123] is optional and used only when a ticket exists; otherwise omit it)'

echo
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
