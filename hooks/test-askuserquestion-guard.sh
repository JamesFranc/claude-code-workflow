#!/bin/bash
# Test script for askuserquestion-guard.sh (FLOW-415)
# Copies the hook into a temporary plugin root with a stubbed bin/dashboard and asserts the exit
# code and stderr for each way the availability probe can answer.

set -euo pipefail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/askuserquestion-guard.sh"
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

# make_root <name> <stub-body|-> : a plugin root holding the hook and, unless the body is "-", a
# bin/dashboard stub that runs the body.
make_root() {
  local root="$TMP_ROOT/$1" stub_body="$2"
  mkdir -p "$root/hooks" "$root/bin"
  cp "$HOOK_SCRIPT" "$root/hooks/askuserquestion-guard.sh"
  chmod +x "$root/hooks/askuserquestion-guard.sh"
  if [[ "$stub_body" != "-" ]]; then
    printf '#!/usr/bin/env bash\n%s\n' "$stub_body" > "$root/bin/dashboard"
    chmod +x "$root/bin/dashboard"
  fi
  echo "$root"
}

# The message the guard must print, byte for byte, whenever it blocks.
EXPECTED_BLOCK="AskUserQuestion is disabled while a board is available.

A question for the user goes on the board, or it is not asked at all: decide it and keep working.
If it is the user's (a decision on a bright line, an unsettled teammate disagreement, or a fact only
they hold), post it first
(dashboard item add --type question --recommend \"<one line>\" --stalls \"<what waits|none>\" --why-mine \"<taste|scope|risk|teammate-unsettled|fact>\" --prompt \"...\")
— see skills/board/references/escalation-contract.md and skills/board/references/dashboard-protocol.md."

# run_case <label> <root> <expected-exit> <blocked|empty>: stdout must be empty in every case;
# stderr is compared as raw bytes from a file. The hook runs with CLAUDE_CODE_SESSION_ID unset, as
# it is in a real hook process.
run_case() {
  local label="$1" root="$2" expected_exit="$3" expected_stderr="$4"
  local payload='{"tool_name":"AskUserQuestion","session_id":"test-session"}'
  local out="$TMP_ROOT/out.txt" err="$TMP_ROOT/err.txt" want="$TMP_ROOT/want.txt" rc=0
  printf '%s' "$payload" | env -u CLAUDE_CODE_SESSION_ID "$root/hooks/askuserquestion-guard.sh" > "$out" 2> "$err" || rc=$?
  check "$label: exit code" "$expected_exit" "$rc"
  check "$label: stdout bytes" "0" "$(wc -c < "$out" | tr -d ' ')"
  if [[ "$expected_stderr" == "empty" ]]; then
    check "$label: stderr bytes" "0" "$(wc -c < "$err" | tr -d ' ')"
  else
    printf '%s\n' "$EXPECTED_BLOCK" > "$want"
    check "$label: stderr is the block message" "same" "$(cmp -s "$want" "$err" && echo same || echo different)"
  fi
}

# A stub that, like the real `session status`, refuses unless it is given a session id.
NEEDS_SESSION='case " $* " in *" --session "?*) echo "{\"dashboardAvailable\":%s}" ;; *) echo "No session id: pass --session or set CLAUDE_CODE_SESSION_ID" >&2; exit 1 ;; esac'

run_case "no board" "$(make_root a 'echo "{\"dashboardAvailable\":false}"')" 0 empty
run_case "board available" "$(make_root b 'echo "{\"dashboardAvailable\":true}"')" 2 blocked
run_case "probe exits 1 with no output" "$(make_root c 'exit 1')" 2 blocked
run_case "probe prints not json" "$(make_root d 'echo "not json"')" 2 blocked
run_case "no bin/dashboard at all" "$(make_root e -)" 2 blocked
run_case "no board, probe given a session id" "$(make_root f "${NEEDS_SESSION//%s/false}")" 0 empty
run_case "board available, probe given a session id" "$(make_root g "${NEEDS_SESSION//%s/true}")" 2 blocked

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
