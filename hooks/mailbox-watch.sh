#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INPUT=$(cat)
# Guarded (FLOW-183): under `set -e`, an unguarded assignment from a failing/missing jq would
# abort the script before the empty-guard below gets a chance to fail open.
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""
  STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null) || STOP_ACTIVE="false"
else
  SESSION_ID=""
  STOP_ACTIVE="false"
fi

# Loop guard: if we're already resuming from a Stop hook, let the session stop.
[[ "$STOP_ACTIVE" == "true" ]] && exit 0
[[ -z "$SESSION_ID" ]] && exit 0

if ! GATE=$("${PLUGIN_ROOT}/bin/mailbox" stop-gate --session "$SESSION_ID" 2>/dev/null); then
  GATE='allow'
fi
DECISION=${GATE%%$'\n'*}
[[ "$DECISION" != "block" ]] && exit 0
REASON=${GATE#*$'\n'}

jq -n --arg r "$REASON" '{decision:"block", reason:$r}'
exit 0
