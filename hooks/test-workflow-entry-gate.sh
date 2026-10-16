#!/bin/bash
# Test script for workflow-entry-gate.sh
# Drives the real hook (and through it the real workflow-state CLI) against throwaway git repos.
# The session id is unique per run, so no workflow entry or bypass exists for it and the CLI
# check reports "no workflow" — the state the gate blocks on.

set -euo pipefail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/workflow-entry-gate.sh"
SESSION_ID="flow396-test-$$-${RANDOM}"
FIXTURES="$(mktemp -d)"
trap 'rm -rf "$FIXTURES"' EXIT
PASS=0
FAIL=0

PLUGIN_ROOT="$(cd "$(dirname "$HOOK_SCRIPT")/.." && pwd)"

test_case() {
  local description="$1"
  local file_path="$2"
  local expected_exit="$3"  # 0 = allow, 2 = block
  local expected_stderr_file="${4:-}"  # file holding the exact stderr; empty = stderr must be empty

  local input
  input=$(jq -n --arg sid "$SESSION_ID" --arg fp "$file_path" \
    '{"session_id": $sid, "tool_input": {"file_path": $fp}}')

  local actual_exit=0
  echo "$input" | bash "$HOOK_SCRIPT" >"$FIXTURES/stdout" 2>"$FIXTURES/stderr" || actual_exit=$?

  local stderr_ok=0
  if [[ -z "$expected_stderr_file" ]]; then
    [[ ! -s "$FIXTURES/stderr" ]] && stderr_ok=1
  else
    cmp -s "$expected_stderr_file" "$FIXTURES/stderr" && stderr_ok=1
  fi

  if [[ "$actual_exit" -ne "$expected_exit" || -s "$FIXTURES/stdout" || "$stderr_ok" -ne 1 ]]; then
    echo "FAIL: $description (expected exit $expected_exit, got $actual_exit)"
    echo "  stdout (expected empty):"
    cat "$FIXTURES/stdout"
    echo "  stderr diff (expected vs actual):"
    diff "${expected_stderr_file:-/dev/null}" "$FIXTURES/stderr" || true
    FAIL=$((FAIL + 1))
    return
  fi

  echo "PASS: $description"
  PASS=$((PASS + 1))
}

write_blocked_message() {
  cat > "$FIXTURES/expected" <<MSG
WORKFLOW ENTRY REQUIRED

You're about to edit: $1
No workflow has been entered in this session.

Enter the matching workflow first — it records the entry marker automatically:
- Quick Change (workflow:quick-change) for small, well-understood changes
- Systematic Debugging (workflow:systematic-debugging) for bugs
- JTBD (workflow:jtbd) for substantial new work

If the user has explicitly authorized working outside the workflow, record a logged exception:
  ${PLUGIN_ROOT}/bin/workflow-state bypass --reason "<why>" --session "$SESSION_ID"
MSG
}

LOCAL_REPO="$FIXTURES/local-only"
REMOTE_REPO="$FIXTURES/with-remote"
NOT_A_REPO="$FIXTURES/not-a-repo"
git init -q "$LOCAL_REPO"
git init -q "$REMOTE_REPO"
git -C "$REMOTE_REPO" remote add origin https://example.invalid/repo.git
mkdir -p "$NOT_A_REPO"

echo "=== Workflow Entry Gate Tests ==="
echo

test_case "repo with no remote allows the edit without a workflow" \
  "$LOCAL_REPO/notes.md" \
  0

test_case "Write into a new subdirectory of a repo with no remote allows" \
  "$LOCAL_REPO/new/dir/notes.md" \
  0

write_blocked_message "$REMOTE_REPO/src.ts"
test_case "repo with a remote and no workflow blocks" \
  "$REMOTE_REPO/src.ts" \
  2 \
  "$FIXTURES/expected"

test_case "file outside any git repo allows" \
  "$NOT_A_REPO/scratch.md" \
  0

echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
