#!/bin/bash
# Test script for session-return.sh
# Drives the hook against a PLUGIN_ROOT whose bin/dashboard is a stub that logs its argv and writes to
# both stdout and stderr; the hook must exit 0 and print nothing on either stream in every case.

set -uo pipefail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/session-return.sh"
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

# $1 = root path, $2 = stub exit code
make_root() {
  local root="$1" stub_exit="${2:-0}"
  mkdir -p "$root/hooks" "$root/bin"
  cp "$HOOK_SCRIPT" "$root/hooks/session-return.sh"
  chmod +x "$root/hooks/session-return.sh"
  printf '#!/bin/bash\necho "$@" >> "%s/calls.log"\necho stub-stdout\necho stub-stderr >&2\nexit %s\n' "$root" "$stub_exit" > "$root/bin/dashboard"
  chmod +x "$root/bin/dashboard"
}

OUT="$TMP_ROOT/hook.out"
ERR="$TMP_ROOT/hook.err"

# $1 = root, $2 = stdin JSON, rest = `env` arguments; leaves the hook's exit status in RC.
run_hook() {
  local root="$1" json="$2"
  shift 2
  printf '%s\n' "$json" | env "$@" "$root/hooks/session-return.sh" >"$OUT" 2>"$ERR"
  RC=$?
}

# $1 = label prefix: exit 0, nothing on stdout, nothing on stderr.
check_quiet() {
  check "$1: exits 0" "0" "$RC"
  [ ! -s "$OUT" ]
  check "$1: stdout is empty" "0" "$?"
  [ ! -s "$ERR" ]
  check "$1: stderr is empty" "0" "$?"
}

calls() {
  cat "$1/calls.log" 2>/dev/null || true
}

# --- Case 1: all three inputs present -> refresh-return invoked --------------
ROOT1="$TMP_ROOT/all"
make_root "$ROOT1"
run_hook "$ROOT1" '{"session_id":"S1"}' ITERM_SESSION_ID="w0t0p0:ABC" CLAUDE_PROJECT_DIR="/launch/dir"
check_quiet "all inputs"
check "all inputs: invokes refresh-return with session and cwd" \
  "session refresh-return --session S1 --cwd /launch/dir" "$(calls "$ROOT1")"

# --- Case 2: any one input missing -> not invoked ----------------------------
ROOT2="$TMP_ROOT/missing"
make_root "$ROOT2"
run_hook "$ROOT2" '{}' ITERM_SESSION_ID="w0t0p0:ABC" CLAUDE_PROJECT_DIR="/d"
check_quiet "no session id"
run_hook "$ROOT2" '{"session_id":"S1"}' -u ITERM_SESSION_ID CLAUDE_PROJECT_DIR="/d"
check_quiet "no iTerm id"
run_hook "$ROOT2" '{"session_id":"S1"}' -u CLAUDE_PROJECT_DIR ITERM_SESSION_ID="w0t0p0:ABC"
check_quiet "no project dir"
check "missing session id, iTerm id or project dir: never invoked" "" "$(calls "$ROOT2")"

# --- Case 3: failing stub still exits 0 and stays silent ---------------------
ROOT3="$TMP_ROOT/failing"
make_root "$ROOT3" 7
run_hook "$ROOT3" '{"session_id":"S1"}' ITERM_SESSION_ID="w0t0p0:ABC" CLAUDE_PROJECT_DIR="/d"
check_quiet "failing dashboard"
check "failing dashboard: the stub was invoked" "session refresh-return --session S1 --cwd /d" "$(calls "$ROOT3")"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
