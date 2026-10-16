#!/bin/bash
# Test script for teammate-session-end.sh (FLOW-385)
# Drives the hook against a copied plugin root with a stubbed bin/dashboard, mirroring
# test-permission-hold.sh's make_root pattern.

set -euo pipefail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/teammate-session-end.sh"
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

make_root() {
  local root="$1"
  mkdir -p "$root/hooks" "$root/bin/config"
  cp "$HOOK_SCRIPT" "$root/hooks/teammate-session-end.sh"
  chmod +x "$root/hooks/teammate-session-end.sh"
  cat > "$root/bin/dashboard" <<'STUB'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$DIR/config"
printf 'CLAUDE_CODE_SESSION_ID=%s %s\n' "${CLAUDE_CODE_SESSION_ID:-}" "$*" >> "$DIR/calls.log"
case "$1 $2" in
  "session status")
    N=$(( $(cat "$DIR/status-n" 2>/dev/null || echo 0) + 1 ))
    echo "$N" > "$DIR/status-n"
    if [[ -f "$CONFIG/leaves-sticky" ]]; then F="$CONFIG/leaves-sticky"
    elif [[ -f "$CONFIG/leaves-alternate-a" ]]; then
      F="$CONFIG/leaves-alternate-a"; [[ $((N % 2)) -eq 0 ]] && F="$CONFIG/leaves-alternate-b"
    elif [[ -f "$CONFIG/leaves-$N" ]]; then F="$CONFIG/leaves-$N"
    elif [[ "$N" -eq 1 && -f "$CONFIG/leaves" ]]; then F="$CONFIG/leaves"
    else F=""; fi
    if [[ -n "$F" ]]; then
      jq -Rn '{localLeafIds: [inputs | select(length > 0)]}' < "$F"
    else
      printf '{"localLeafIds":[]}\n'
    fi
    ;;
  "session end")
    [[ -f "$CONFIG/end-slow" ]] && sleep 3
    [[ -f "$CONFIG/end-fails" ]] && exit 1
    ;;
esac
exit 0
STUB
  chmod +x "$root/bin/dashboard"
  : > "$root/bin/calls.log"
}

calls_log() {
  cat "$1/bin/calls.log" 2>/dev/null || printf ''
}

# A teammate transcript and team config under $2 (a HOME). $3 team, $4 agent, $5 lead session id.
# Same shape as test-permission-hold.sh's make_team.
make_team() {
  local transcript="$1" home_dir="$2" team="$3" agent="$4" lead="$5"
  printf '%s\n' '{"type":"agent-setting","agentSetting":"workflow:implementer"}' > "$transcript"
  jq -cn --arg t "$team" --arg a "$agent" \
    '{type:"user", teamName:$t, agentName:$a, message:{content:"You are an implementer"}}' >> "$transcript"
  mkdir -p "$home_dir/.claude/teams/$team"
  jq -n --arg l "$lead" '{name:"x", leadSessionId:$l, members:[]}' > "$home_dir/.claude/teams/$team/config.json"
}

# Runs the hook with a SessionEnd payload. Sets HOOK_EXIT. $5 is an optional agent_id.
run_end_hook() {
  local root="$1" home_dir="$2" session_id="$3" transcript="$4" agent_id="${5:-}"
  local input
  input=$(jq -n --arg sid "$session_id" --arg tp "$transcript" --arg aid "$agent_id" \
    '{session_id: $sid, transcript_path: $tp, cwd: "/tmp/proj", hook_event_name: "SessionEnd",
      reason: "other"} + (if $aid == "" then {} else {agent_id: $aid} end)')
  HOOK_EXIT=0
  printf '%s' "$input" | HOME="$home_dir" CLAUDE_CONFIG_DIR="$home_dir/.claude" \
    bash "$root/hooks/teammate-session-end.sh" >/dev/null 2>&1 || HOOK_EXIT=$?
  wait_for_detached "$root"
}

# The hook hands the end loop to a detached process and exits, so a case waits (at most 20s) for
# every process still running that copy of the script.
wait_for_detached() {
  local i
  for ((i = 0; i < 200; i++)); do
    pgrep -f "$1/hooks/teammate-session-end.sh" >/dev/null || return 0
    sleep 0.1
  done
}

# Sets up case $1: a root, a HOME, and a teammate transcript whose lead is lead-$1.
setup_teammate() {
  local n="$1"
  ROOT="$TMP_ROOT/c$n"
  HOME_DIR="$TMP_ROOT/c$n-home"
  TRANSCRIPT="$TMP_ROOT/c$n-transcript.jsonl"
  make_root "$ROOT"
  mkdir -p "$HOME_DIR"
  make_team "$TRANSCRIPT" "$HOME_DIR" "team-$n" "implementer-$n" "lead-$n"
}

# --- 1: a teammate's one board node is ended by explicit id, under its own session id ------------
setup_teammate 1
printf 'leaf-1\n' > "$ROOT/bin/config/leaves"
run_end_hook "$ROOT" "$HOME_DIR" "session-1" "$TRANSCRIPT"
check "1: exit 0" "0" "$HOOK_EXIT"
check "1: status, one explicit end, then a status showing nothing left, all under the teammate's session id" \
  "CLAUDE_CODE_SESSION_ID=session-1 session status --json
CLAUDE_CODE_SESSION_ID=session-1 session end --session leaf-1
CLAUDE_CODE_SESSION_ID=session-1 session status --json" "$(calls_log "$ROOT")"

# --- 2: every live leaf the teammate owns is ended, one explicit end each --------------------------
setup_teammate 2
printf 'leaf-2a\nleaf-2b\n' > "$ROOT/bin/config/leaves"
run_end_hook "$ROOT" "$HOME_DIR" "session-2" "$TRANSCRIPT"
check "2: exit 0" "0" "$HOOK_EXIT"
check "2: both leaves ended by explicit id" \
  "session end --session leaf-2a
session end --session leaf-2b" "$(calls_log "$ROOT" | grep 'session end' | sed 's/^[^ ]* //')"

# --- 3: a teammate that never posted a permission has no leaf, so no end — never a bare end ------
setup_teammate 3
run_end_hook "$ROOT" "$HOME_DIR" "session-3" "$TRANSCRIPT"
check "3: exit 0" "0" "$HOOK_EXIT"
check "3: no session end call at all" "0" "$(calls_log "$ROOT" | grep -c 'session end' || true)"

# --- 4: the lead's own session ending touches nothing ----------------------------------------------
setup_teammate 4
printf 'leaf-4\n' > "$ROOT/bin/config/leaves"
run_end_hook "$ROOT" "$HOME_DIR" "lead-4" "$TRANSCRIPT"
check "4: exit 0" "0" "$HOOK_EXIT"
check "4: no dashboard call for the lead" "" "$(calls_log "$ROOT")"

# --- 5: a solo session (no team records in its transcript) touches nothing -------------------------
ROOT="$TMP_ROOT/c5"; HOME_DIR="$TMP_ROOT/c5-home"; TRANSCRIPT="$TMP_ROOT/c5-transcript.jsonl"
make_root "$ROOT"
mkdir -p "$HOME_DIR"
printf '%s\n' '{"type":"user","message":{"content":"hello"}}' > "$TRANSCRIPT"
printf 'leaf-5\n' > "$ROOT/bin/config/leaves"
run_end_hook "$ROOT" "$HOME_DIR" "session-5" "$TRANSCRIPT"
check "5: exit 0" "0" "$HOOK_EXIT"
check "5: no dashboard call for a solo session" "" "$(calls_log "$ROOT")"

# --- 6: an in-process subagent (agent_id set) touches nothing --------------------------------------
setup_teammate 6
printf 'leaf-6\n' > "$ROOT/bin/config/leaves"
run_end_hook "$ROOT" "$HOME_DIR" "session-6" "$TRANSCRIPT" "agent-6"
check "6: exit 0" "0" "$HOOK_EXIT"
check "6: no dashboard call for an in-process subagent" "" "$(calls_log "$ROOT")"

# --- 7: a failing end never fails the hook, and the remaining leaves are still ended ---------------
setup_teammate 7
printf 'leaf-7a\nleaf-7b\n' > "$ROOT/bin/config/leaves"
: > "$ROOT/bin/config/end-fails"
run_end_hook "$ROOT" "$HOME_DIR" "session-7" "$TRANSCRIPT"
check "7: exit 0 when session end fails" "0" "$HOOK_EXIT"
check "7: both ends still attempted" "2" "$(calls_log "$ROOT" | grep -c 'session end' || true)"

# --- 8: a malformed session id touches nothing -----------------------------------------------------
setup_teammate 8
printf 'leaf-8\n' > "$ROOT/bin/config/leaves"
run_end_hook "$ROOT" "$HOME_DIR" "../session-8" "$TRANSCRIPT"
check "8: exit 0" "0" "$HOOK_EXIT"
check "8: no dashboard call for a malformed session id" "" "$(calls_log "$ROOT")"

# --- 9: a parent+child registry — ending the child exposes the root, which is ended on pass 2 ------
setup_teammate 9
printf 'child-9\n' > "$ROOT/bin/config/leaves-1"
printf 'root-9\n' > "$ROOT/bin/config/leaves-2"
run_end_hook "$ROOT" "$HOME_DIR" "session-9" "$TRANSCRIPT"
check "9: exit 0" "0" "$HOOK_EXIT"
check "9: child then root ended, over three statuses" \
  "session status --json
session end --session child-9
session status --json
session end --session root-9
session status --json" "$(calls_log "$ROOT" | sed 's/^[^ ]* //')"

# --- 10: an end that always fails stops after one pass; a leaf that never goes away stops once status repeats ---
setup_teammate 10
printf 'leaf-10\n' > "$ROOT/bin/config/leaves-sticky"
: > "$ROOT/bin/config/end-fails"
run_end_hook "$ROOT" "$HOME_DIR" "session-10" "$TRANSCRIPT"
check "10: exit 0 with a permanently failing end" "0" "$HOOK_EXIT"
check "10: one status and one end, then stop" "1 1" \
  "$(calls_log "$ROOT" | grep -c 'session status') $(calls_log "$ROOT" | grep -c 'session end')"
setup_teammate 11
printf 'leaf-11\n' > "$ROOT/bin/config/leaves-sticky"
run_end_hook "$ROOT" "$HOME_DIR" "session-11" "$TRANSCRIPT"
check "11: exit 0 with a leaf that never leaves" "0" "$HOOK_EXIT"
check "11: second status shows the same leaf, so two statuses and one end" "2 1" \
  "$(calls_log "$ROOT" | grep -c 'session status') $(calls_log "$ROOT" | grep -c 'session end')"

# --- 12: a malformed leadSessionId in the team config touches nothing ------------------------------
setup_teammate 12
printf 'leaf-12\n' > "$ROOT/bin/config/leaves"
jq -n '{name:"x", leadSessionId:"lead/../x", members:[]}' > "$HOME_DIR/.claude/teams/team-12/config.json"
run_end_hook "$ROOT" "$HOME_DIR" "session-12" "$TRANSCRIPT"
check "12: exit 0" "0" "$HOOK_EXIT"
check "12: no dashboard call for a malformed lead session id" "" "$(calls_log "$ROOT")"

# --- 13: a chain deeper than any fixed cap — one leaf per pass, every node ended -------------------
setup_teammate 13
for i in 1 2 3 4 5 6; do printf 'node-13-%s\n' "$i" > "$ROOT/bin/config/leaves-$i"; done
run_end_hook "$ROOT" "$HOME_DIR" "session-13" "$TRANSCRIPT"
check "13: exit 0" "0" "$HOOK_EXIT"
check "13: all six nodes ended, deepest first" \
  "session end --session node-13-1
session end --session node-13-2
session end --session node-13-3
session end --session node-13-4
session end --session node-13-5
session end --session node-13-6" "$(calls_log "$ROOT" | grep 'session end' | sed 's/^[^ ]* //')"

# --- 14: the hook itself returns at once while the detached work is slow --------------------------
setup_teammate 14
printf 'leaf-14\n' > "$ROOT/bin/config/leaves"
: > "$ROOT/bin/config/end-slow"
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }
INPUT14=$(jq -n --arg sid "session-14" --arg tp "$TRANSCRIPT" \
  '{session_id: $sid, transcript_path: $tp, hook_event_name: "SessionEnd", reason: "other"}')
START14=$(now_ms)
printf '%s' "$INPUT14" | HOME="$HOME_DIR" CLAUDE_CONFIG_DIR="$HOME_DIR/.claude" \
  bash "$ROOT/hooks/teammate-session-end.sh" >/dev/null 2>&1
ELAPSED14=$(( $(now_ms) - START14 ))
check "14: hook returned in under one second although the end takes three" "yes" \
  "$([[ "$ELAPSED14" -lt 1000 ]] && echo yes || echo "no (${ELAPSED14}ms)")"
wait_for_detached "$ROOT"
check "14: the detached work still ended the leaf" "1" "$(calls_log "$ROOT" | grep -c 'session end --session leaf-14')"

# --- 15: a leaf set that alternates with every end succeeding is cut off at the pass backstop -------
setup_teammate 15
printf 'leaf-15a\n' > "$ROOT/bin/config/leaves-alternate-a"
printf 'leaf-15b\n' > "$ROOT/bin/config/leaves-alternate-b"
run_end_hook "$ROOT" "$HOME_DIR" "session-15" "$TRANSCRIPT"
RUNNING15=$(pgrep -f "$ROOT/hooks/teammate-session-end.sh" || true)
for pid in $RUNNING15; do kill "$pid" 2>/dev/null || true; done
check "15: the detached loop terminated on its own" "" "$RUNNING15"
check "15: ends equal the backstop" "50" "$(calls_log "$ROOT" | grep -c 'session end')"

echo
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
