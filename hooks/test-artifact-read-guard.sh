#!/bin/bash
# Test script for artifact-read-guard.sh

set -euo pipefail

HOOK_SCRIPT="$(dirname "$0")/artifact-read-guard.sh"
PASS=0
FAIL=0

block_message() {
  local path="$1"
  printf 'Reading %s is blocked: an image or PDF artifact read here is re-sent on every later\nrequest in this session. Hand the path and the one question you need answered to the\nartifact-viewer agent (agents/artifact-viewer.md) and use its report instead\n(skills/workflow-guide/references/routing.md §Artifact Delegation).' "$path"
}

read_input() {
  jq -n --arg path "$1" --arg agent "${2:-}" --arg agent_id "${3:-}" \
    '{tool_name: "Read", tool_input: {file_path: $path}}
     + (if $agent == "" then {} else {agent_type: $agent} end)
     + (if $agent_id == "" then {} else {agent_id: $agent_id} end)'
}

test_case() {
  local description="$1" input="$2" expected_exit="$3" expected_stderr="$4"
  local stderr_file
  stderr_file=$(mktemp)
  local stdout_output actual_exit=0
  stdout_output=$(printf '%s' "$input" | bash "$HOOK_SCRIPT" 2>"$stderr_file") || actual_exit=$?
  local stderr_output
  stderr_output=$(cat "$stderr_file")
  rm -f "$stderr_file"

  local fail=0
  if [[ "$actual_exit" -ne "$expected_exit" ]]; then
    echo "FAIL: $description (expected exit $expected_exit, got $actual_exit)"
    fail=1
  fi
  if [[ -n "$stdout_output" ]]; then
    echo "FAIL: $description (expected empty stdout, got: $stdout_output)"
    fail=1
  fi
  if [[ "$stderr_output" != "$expected_stderr" ]]; then
    echo "FAIL: $description (stderr mismatch)"
    echo "  expected: $expected_stderr"
    echo "  actual:   $stderr_output"
    fail=1
  fi

  if [[ "$fail" -eq 1 ]]; then
    FAIL=$((FAIL + 1))
    return
  fi
  echo "PASS: $description"
  PASS=$((PASS + 1))
}

echo "=== Artifact Read Guard Tests ==="

IMG_PATH=/tmp/shot.png
PDF_PATH=/tmp/Report.PDF
TEXT_PATH=/tmp/notes.md
JPG_PATH=/tmp/shot.jpg

test_case "blocks an image read from a durable context" \
  "$(read_input "$IMG_PATH")" 2 "$(block_message "$IMG_PATH")"
test_case "blocks regardless of extension case" \
  "$(read_input "$PDF_PATH")" 2 "$(block_message "$PDF_PATH")"
test_case "allows a text file" \
  "$(read_input "$TEXT_PATH")" 0 ""
test_case "allows the viewer subagent" \
  "$(read_input "$IMG_PATH" artifact-viewer sub-1)" 0 ""
test_case "allows the plugin-namespaced viewer subagent" \
  "$(read_input "$IMG_PATH" workflow:artifact-viewer sub-2)" 0 ""
test_case "blocks any other subagent" \
  "$(read_input "$JPG_PATH" workflow:researcher sub-3)" 2 "$(block_message "$JPG_PATH")"
test_case "blocks a durable session with agent_type=artifact-viewer but no agent_id" \
  "$(read_input "$IMG_PATH" artifact-viewer)" 2 "$(block_message "$IMG_PATH")"

echo
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
