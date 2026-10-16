#!/bin/bash
# UserPromptSubmit hook: one-line workflow status banner injected as context on every prompt.
# Continuous re-anchor — replaces "read the prose and remember" with per-prompt state (FLOW-147).

set -euo pipefail

INPUT=$(cat)
# jq failing (missing binary, non-JSON stdin) must not trip `set -e` before the empty-guard
# below gets a chance to stay silent (FLOW-147 review m6; guard structure hardened FLOW-183).
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""
else
  SESSION_ID=""
fi

if [[ -z "$SESSION_ID" ]]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Fail open and silent: a broken CLI must never block or spam the prompt path.
BANNER=$("${PLUGIN_ROOT}/bin/workflow-state" banner --session "$SESSION_ID" 2>/dev/null) || exit 0

if [[ -n "$BANNER" ]]; then
  printf '%s\n' "$BANNER"
fi

exit 0
