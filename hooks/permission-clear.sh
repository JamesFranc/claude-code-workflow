#!/usr/bin/env bash
# PostToolUse / PostToolUseFailure / PermissionDenied / Stop hook (FLOW-343): the terminal answered
# first, so withdraw the board approval the PermissionRequest hook posted and delete the state file
# — which is also what stops that hook's poll. Each of those outcomes, and every auto-mode denial,
# is also appended to permission-log.jsonl (FLOW-375).
#
# Four events, because no single one covers every way a prompt resolves: PostToolUse covers an
# allow, PostToolUseFailure covers a call that ran and failed, PermissionDenied covers an auto-mode
# denial, and Stop covers a MANUAL terminal deny — which fires none of the other three
# (code.claude.com/docs/en/hooks.md: "Permission denials fire PreToolUse but not this event", and
# PermissionDenied "doesn't run when you manually deny a permission dialog").
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DASHBOARD="${PLUGIN_ROOT}/bin/dashboard"
INPUT=$(cat)

if ! command -v jq >/dev/null 2>&1; then exit 0; fi

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""
HOOK_EVENT=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null) || HOOK_EVENT=""
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || TOOL_NAME=""
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || CWD=""
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null) || AGENT_ID=""
# Same detail the hold hook logs. Stop carries no tool_input, which must log as empty, not "null".
DETAIL=$(printf '%s' "$INPUT" | jq -r '(.tool_input // empty) | (.command // .file_path // .path // tostring)' 2>/dev/null) || DETAIL=""
DETAIL=$(printf '%s' "$DETAIL" | jq -Rrs '.[0:600]')

STAMP_HOME="${HOME:-${TMPDIR:-/tmp}}"
PERMISSION_LOG="${STAMP_HOME}/.claude/workflow-state/permission-log.jsonl"

# One JSON line per permission event, in a log every profile shares (FLOW-375). A failed write
# never changes the decision or the exit path.
log_event() {
  local event="$1" note="${2:-}"
  mkdir -p "${STAMP_HOME}/.claude" 2>/dev/null || true
  mkdir -p -m 700 "${STAMP_HOME}/.claude/workflow-state" 2>/dev/null || true
  (umask 077 && jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg sid "$SESSION_ID" \
    --arg agent "$AGENT_ID" --arg cwd "$CWD" --arg tool "$TOOL_NAME" --arg input "$DETAIL" \
    --arg event "$event" --arg note "$note" \
    '{ts: $ts, session_id: $sid, agent_id: (if $agent == "" then null else $agent end), cwd: $cwd,
      tool: $tool, input: $input, event: $event} + (if $note == "" then {} else {note: $note} end)' \
    >> "$PERMISSION_LOG") 2>/dev/null || true
}

# PermissionDenied is logged before the state-file guard below: an auto-mode denial needs a line
# whether or not a hold exists. The note is the payload minus the fields the del() below names.
if [[ "$HOOK_EVENT" == "PermissionDenied" ]]; then
  log_event auto-denied "$(printf '%s' "$INPUT" | jq -c 'del(.session_id, .agent_id, .cwd, .tool_name, .tool_input, .hook_event_name, .transcript_path)' 2>/dev/null || printf '')"
fi

[[ -z "$SESSION_ID" ]] && exit 0
# Same path-construction refusal as permission-hold.sh — this reads the path that hook wrote, and a
# session id that could never have produced one has nothing here to read.
case "$SESSION_ID" in
  *[!a-zA-Z0-9_-]*) exit 0 ;;
esac

STATE_FILE="${STAMP_HOME}/.claude/workflow-state/permission/${SESSION_ID}"
[[ -f "$STATE_FILE" ]] || exit 0

# `|| true`, never `|| exit 0`: read's exit status is 1 for a final line with no trailing newline
# AND for a line with fewer fields than names, so it cannot distinguish "fine" from "malformed" —
# and a bare failing read would abort the script under `set -e`. The emptiness test below is the
# real check; read's status is discarded because it carries no usable information here.
read -r ITEM_ID TARGET < "$STATE_FILE" || true
[[ -z "$ITEM_ID" || -z "$TARGET" ]] && { rm -f "$STATE_FILE" 2>/dev/null || true; exit 0; }

case "$HOOK_EVENT" in
  PostToolUse) log_event ran ;;
  PostToolUseFailure) log_event failed ;;
  Stop) log_event unresolved-at-stop ;;
esac

# Delete first: this is the ask hook's stop signal, and it must land even if the withdraw below
# fails or hangs. A stale state file would otherwise hold that hook to its full deadline.
rm -f "$STATE_FILE" 2>/dev/null || true

export CLAUDE_CODE_SESSION_ID="$SESSION_ID"
"$DASHBOARD" item withdraw --item "$ITEM_ID" --session "$TARGET" >/dev/null 2>&1 || true
exit 0
