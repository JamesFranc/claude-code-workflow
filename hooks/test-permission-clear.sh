#!/bin/bash
# Test script for permission-clear.sh (FLOW-343)
# Drives the hook against a copied plugin root with a stubbed bin/dashboard.

set -euo pipefail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/permission-clear.sh"
PASS=0
FAIL=0

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

check_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    echo "  expected to contain: $needle"
    echo "  actual:               $haystack"
    FAIL=$((FAIL + 1))
  fi
}

check_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    echo "  expected NOT to contain: $needle"
    echo "  actual:                   $haystack"
    FAIL=$((FAIL + 1))
  fi
}

# $1 = root, $2 = withdraw exit code (default 0)
make_root() {
  local root="$1" withdraw_exit="${2:-0}"
  mkdir -p "$root/hooks" "$root/bin"
  cp "$HOOK_SCRIPT" "$root/hooks/permission-clear.sh"
  chmod +x "$root/hooks/permission-clear.sh"
  cat > "$root/bin/dashboard" <<STUB
#!/usr/bin/env bash
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
LOG="\$DIR/calls.log"
printf '%s\n' "\$*" >> "\$LOG"
if [[ "\$1" == "item" && "\$2" == "withdraw" ]]; then
  exit ${withdraw_exit}
fi
exit 0
STUB
  chmod +x "$root/bin/dashboard"
  : > "$root/bin/calls.log"
}

calls_log() {
  local root="$1"
  cat "$root/bin/calls.log" 2>/dev/null || printf ''
}

# The permission log's events for a HOME, space-joined; empty when there is no log.
log_events() {
  jq -r '.event' "$1/.claude/workflow-state/permission-log.jsonl" 2>/dev/null | paste -sd' ' - || printf ''
}

# One field of one log line: $1 HOME, $2 zero-based line index, $3 a jq path such as .note
log_field() {
  jq -rs --argjson i "$2" ".[\$i]$3 // empty" "$1/.claude/workflow-state/permission-log.jsonl" 2>/dev/null || printf ''
}

# Runs the hook with the given HOME and session id. With a fourth arg, the payload also carries that
# hook_event_name plus a Read tool call and a reason field. Sets HOOK_EXIT.
run_clear_hook() {
  local root="$1" home_dir="$2" session_id="$3" event="${4:-}"
  local input
  input=$(jq -n --arg sid "$session_id" --arg ev "$event" '{session_id: $sid}
    + (if $ev == "" then {} else {hook_event_name: $ev, tool_name: "Read",
       tool_input: {file_path: "/etc/hosts"}, cwd: "/tmp/proj", reason: "because"} end)')
  HOOK_EXIT=0
  printf '%s' "$input" | HOME="$home_dir" bash "$root/hooks/permission-clear.sh" >/dev/null 2>&1 ||
    HOOK_EXIT=$?
}

echo "=== permission-clear Hook Tests ==="
echo

# --- 1: state file present -> withdraw is called, state file removed ---------------------------
ROOT1="$TMP_ROOT/c1"
HOME1="$TMP_ROOT/c1-home"
make_root "$ROOT1"
STATE_DIR1="$HOME1/.claude/workflow-state/permission"
mkdir -p "$STATE_DIR1"
printf '%s %s\n' "item-1" "target-1" > "$STATE_DIR1/session-1"
run_clear_hook "$ROOT1" "$HOME1" "session-1"
check "1: exit 0 when the state file is present" "0" "$HOOK_EXIT"
check_contains "1: item withdraw is called with the stored item and target" "$(calls_log "$ROOT1")" \
  "item withdraw --item item-1 --session target-1"
check "1: the state file is removed" "false" "$([[ -f "$STATE_DIR1/session-1" ]] && echo true || echo false)"

# --- 2: no state file -> exit 0, no dashboard call at all ---------------------------------------
ROOT2="$TMP_ROOT/c2"
HOME2="$TMP_ROOT/c2-home"
make_root "$ROOT2"
mkdir -p "$HOME2"
run_clear_hook "$ROOT2" "$HOME2" "session-2"
check "2: exit 0 with no state file" "0" "$HOOK_EXIT"
check "2: no dashboard call at all with no state file" "" "$(calls_log "$ROOT2")"

# --- 3: state file malformed (one field) --------------------------------------------------------
ROOT3="$TMP_ROOT/c3"
HOME3="$TMP_ROOT/c3-home"
make_root "$ROOT3"
STATE_DIR3="$HOME3/.claude/workflow-state/permission"
mkdir -p "$STATE_DIR3"
printf '%s\n' "item-3" > "$STATE_DIR3/session-3"
run_clear_hook "$ROOT3" "$HOME3" "session-3"
check "3: exit 0 with a malformed (one-field) state file" "0" "$HOOK_EXIT"
check "3: the malformed state file is removed" "false" "$([[ -f "$STATE_DIR3/session-3" ]] && echo true || echo false)"
check "3: no withdraw call with a malformed state file" "" "$(calls_log "$ROOT3")"

# --- 6: state file has no trailing newline --------------------------------------------------------
ROOT6="$TMP_ROOT/c6"
HOME6="$TMP_ROOT/c6-home"
make_root "$ROOT6"
STATE_DIR6="$HOME6/.claude/workflow-state/permission"
mkdir -p "$STATE_DIR6"
printf '%s %s' "item-6" "target-6" > "$STATE_DIR6/session-6"
run_clear_hook "$ROOT6" "$HOME6" "session-6"
check "6: exit 0 with a state file missing its trailing newline" "0" "$HOOK_EXIT"
check_contains "6: withdraw is still called with both fields" "$(calls_log "$ROOT6")" \
  "item withdraw --item item-6 --session target-6"
check "6: the state file is removed" "false" "$([[ -f "$STATE_DIR6/session-6" ]] && echo true || echo false)"

# --- 4: withdraw fails -> hook still exits 0 and the state file is gone -------------------------
ROOT4="$TMP_ROOT/c4"
HOME4="$TMP_ROOT/c4-home"
make_root "$ROOT4" 1
STATE_DIR4="$HOME4/.claude/workflow-state/permission"
mkdir -p "$STATE_DIR4"
printf '%s %s\n' "item-4" "target-4" > "$STATE_DIR4/session-4"
run_clear_hook "$ROOT4" "$HOME4" "session-4"
check "4: exit 0 even when the withdraw call fails" "0" "$HOOK_EXIT"
check "4: the state file is gone even when the withdraw call fails" "false" \
  "$([[ -f "$STATE_DIR4/session-4" ]] && echo true || echo false)"

# --- 7: PostToolUse with a live hold -> ran, with the tool and its input
ROOT7="$TMP_ROOT/c7"
HOME7="$TMP_ROOT/c7-home"
make_root "$ROOT7"
mkdir -p "$HOME7/.claude/workflow-state/permission"
printf '%s %s\n' "item-7" "target-7" > "$HOME7/.claude/workflow-state/permission/session-7"
run_clear_hook "$ROOT7" "$HOME7" "session-7" "PostToolUse"
check "7: exit 0 on PostToolUse with a live hold" "0" "$HOOK_EXIT"
check "7: the log records ran" "ran" "$(log_events "$HOME7")"
check "7: the ran line names the tool" "Read" "$(log_field "$HOME7" 0 .tool)"
check "7: the ran line carries the input" "/etc/hosts" "$(log_field "$HOME7" 0 .input)"
check_contains "7: the item is still withdrawn" "$(calls_log "$ROOT7")" "item withdraw --item item-7 --session target-7"

# --- 8: PostToolUseFailure with a live hold -> failed
ROOT8="$TMP_ROOT/c8"
HOME8="$TMP_ROOT/c8-home"
make_root "$ROOT8"
mkdir -p "$HOME8/.claude/workflow-state/permission"
printf '%s %s\n' "item-8" "target-8" > "$HOME8/.claude/workflow-state/permission/session-8"
run_clear_hook "$ROOT8" "$HOME8" "session-8" "PostToolUseFailure"
check "8: the log records failed" "failed" "$(log_events "$HOME8")"

# --- 9: Stop with a live hold -> unresolved-at-stop
ROOT9="$TMP_ROOT/c9"
HOME9="$TMP_ROOT/c9-home"
make_root "$ROOT9"
mkdir -p "$HOME9/.claude/workflow-state/permission"
printf '%s %s\n' "item-9" "target-9" > "$HOME9/.claude/workflow-state/permission/session-9"
run_clear_hook "$ROOT9" "$HOME9" "session-9" "Stop"
check "9: the log records unresolved-at-stop" "unresolved-at-stop" "$(log_events "$HOME9")"

# --- 10: PermissionDenied with no hold -> auto-denied, carrying the payload's extra fields
ROOT10="$TMP_ROOT/c10"
HOME10="$TMP_ROOT/c10-home"
make_root "$ROOT10"
mkdir -p "$HOME10"
run_clear_hook "$ROOT10" "$HOME10" "session-10" "PermissionDenied"
check "10: exit 0 on PermissionDenied" "0" "$HOOK_EXIT"
check "10: the log records auto-denied" "auto-denied" "$(log_events "$HOME10")"
check "10: the auto-denied line is exactly the expected record" '{"ts":"T","session_id":"session-10","agent_id":null,"cwd":"/tmp/proj","tool":"Read","input":"/etc/hosts","event":"auto-denied","note":"{\"reason\":\"because\"}"}' "$(head -n1 "$HOME10/.claude/workflow-state/permission-log.jsonl" | jq -c '.ts = "T"')"
check "10: no dashboard call on an auto-denial" "" "$(calls_log "$ROOT10")"

# --- 10b: PermissionDenied carrying agent_id and transcript_path -> agent_id logged, both dropped from the note
ROOT10b="$TMP_ROOT/c10b"
HOME10b="$TMP_ROOT/c10b-home"
make_root "$ROOT10b"
mkdir -p "$HOME10b"
printf '%s' '{"session_id":"session-10b","agent_id":"agent-10b","transcript_path":"/tmp/t.jsonl","hook_event_name":"PermissionDenied","tool_name":"Read","tool_input":{"file_path":"/etc/hosts"},"cwd":"/tmp/proj","reason":"because"}' |
  HOME="$HOME10b" bash "$ROOT10b/hooks/permission-clear.sh" >/dev/null 2>&1
check "10b: the auto-denied line carries agent_id and drops transcript_path from the note" '{"ts":"T","session_id":"session-10b","agent_id":"agent-10b","cwd":"/tmp/proj","tool":"Read","input":"/etc/hosts","event":"auto-denied","note":"{\"reason\":\"because\"}"}' "$(head -n1 "$HOME10b/.claude/workflow-state/permission-log.jsonl" | jq -c '.ts = "T"')"

# --- 11: PostToolUse with no hold -> an ordinary tool call writes nothing
ROOT11="$TMP_ROOT/c11"
HOME11="$TMP_ROOT/c11-home"
make_root "$ROOT11"
mkdir -p "$HOME11"
run_clear_hook "$ROOT11" "$HOME11" "session-11" "PostToolUse"
check "11: an ordinary tool call creates no log" "false" \
  "$([[ -e "$HOME11/.claude/workflow-state/permission-log.jsonl" ]] && echo true || echo false)"

# --- 12: the log cannot be written -> the hold is still withdrawn and its state removed
ROOT12="$TMP_ROOT/c12"
HOME12="$TMP_ROOT/c12-home"
make_root "$ROOT12"
mkdir -p "$HOME12/.claude/workflow-state/permission" "$HOME12/.claude/workflow-state/permission-log.jsonl"
printf '%s %s\n' "item-12" "target-12" > "$HOME12/.claude/workflow-state/permission/session-12"
run_clear_hook "$ROOT12" "$HOME12" "session-12" "PostToolUse"
check "12: exit 0 when the log path is unwritable" "0" "$HOOK_EXIT"
check_contains "12: the item is still withdrawn" "$(calls_log "$ROOT12")" "item withdraw --item item-12 --session target-12"
check "12: the state file is still removed" "false" \
  "$([[ -f "$HOME12/.claude/workflow-state/permission/session-12" ]] && echo true || echo false)"

echo
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
