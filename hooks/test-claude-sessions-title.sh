#!/bin/bash
# Test script for bin/claude-sessions' session_title()
# Builds fixture transcripts and verifies which record supplies the title.

set -euo pipefail

SCRIPT="${CLAUDE_SESSIONS_OVERRIDE:-$(dirname "$0")/../bin/claude-sessions}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0
FAIL=0

# session_title lives in a script with no .py extension, so it is loaded by path rather than
# imported. The helper prints only the title, so a fixture's expected value is compared as a
# whole string rather than matched loosely.
title_of() {
  local transcript="$1"
  python3 - "$SCRIPT" "$transcript" <<'PY'
import importlib.machinery, importlib.util, sys
# Loading by path would drop a __pycache__ beside the script it reads, inside the repo.
sys.dont_write_bytecode = True
loader = importlib.machinery.SourceFileLoader("cs", sys.argv[1])
spec = importlib.util.spec_from_loader("cs", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)
title, _first_msg = mod.session_title(sys.argv[2])
print(title)
PY
}

test_case() {
  local description="$1" transcript="$2" expected="$3"

  local actual
  actual="$(title_of "$transcript")"

  if [[ "$actual" == "$expected" ]]; then
    echo "PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description (expected '$expected', got '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

USER_RECORD='{"type":"user","message":{"content":"hello this is the first real user message"}}'

# A /rename appends a new custom-title record rather than rewriting the old one, so the most
# recent record is the session's current name. This is the case FLOW-343 found: the terminal
# showed the new name while claude-sessions listed the original.
printf '%s\n' \
  '{"type":"custom-title","customTitle":"original name"}' \
  "$USER_RECORD" \
  '{"type":"custom-title","customTitle":"renamed once"}' \
  '{"type":"custom-title","customTitle":"renamed twice"}' \
  > "$WORK/renamed.jsonl"
test_case "the last custom-title wins, not the first" "$WORK/renamed.jsonl" "renamed twice"

# The rename record sits after the first user message, which is what made the early loop exit
# wrong: title and first_msg were both set before the rename was ever read.
printf '%s\n' \
  '{"type":"custom-title","customTitle":"original name"}' \
  "$USER_RECORD" \
  '{"type":"custom-title","customTitle":"renamed after the message"}' \
  > "$WORK/late-rename.jsonl"
test_case "a rename after the first user message is still read" \
  "$WORK/late-rename.jsonl" "renamed after the message"

printf '%s\n' \
  '{"type":"summary","summary":"a generated summary"}' \
  "$USER_RECORD" \
  '{"type":"custom-title","customTitle":"a real title"}' \
  > "$WORK/summary-first.jsonl"
test_case "a custom title overrides an earlier summary" "$WORK/summary-first.jsonl" "a real title"

# The guard on the summary branch is what keeps this direction one-way.
printf '%s\n' \
  '{"type":"custom-title","customTitle":"a real title"}' \
  "$USER_RECORD" \
  '{"type":"summary","summary":"a generated summary"}' \
  > "$WORK/summary-last.jsonl"
test_case "a later summary does not overwrite a custom title" "$WORK/summary-last.jsonl" "a real title"

printf '%s\n' \
  '{"type":"custom-title","customTitle":"a real title"}' \
  "$USER_RECORD" \
  '{"type":"custom-title","customTitle":""}' \
  > "$WORK/empty-rename.jsonl"
test_case "an empty custom title leaves the previous one standing" \
  "$WORK/empty-rename.jsonl" "a real title"

printf '%s\n' \
  '{"type":"summary","summary":"a generated summary"}' \
  "$USER_RECORD" \
  > "$WORK/summary-only.jsonl"
test_case "a summary is used when no custom title exists" "$WORK/summary-only.jsonl" "a generated summary"

echo
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
