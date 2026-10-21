#!/bin/bash
# SessionStart hook: re-point this session's board return link at the iTerm2 session it now runs in.
# iTerm2 session ids are not guaranteed to survive an iTerm2 restart or a `claude --resume` in a new tab (FLOW-433).
# Fail open and silent: this must never block or spam session start.

set -uo pipefail

INPUT=$(cat)
if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""
else
  SESSION_ID=""
fi

if [[ -z "$SESSION_ID" || -z "${ITERM_SESSION_ID:-}" || -z "${CLAUDE_PROJECT_DIR:-}" ]]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

"${PLUGIN_ROOT}/bin/dashboard" session refresh-return --session "$SESSION_ID" --cwd "$CLAUDE_PROJECT_DIR" >/dev/null 2>&1 || true
exit 0
