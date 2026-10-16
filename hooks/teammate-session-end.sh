#!/usr/bin/env bash
# SessionEnd hook (FLOW-385): when a teammate's process exits, end every board node it owns, so the
# permission node permission-hold.sh nested under the lead does not linger until the board's hung
# timeout. Teammates only: a lead or solo session ending (exit, /clear, logout) leaves the board
# alone, so a resumed session finds its nodes where it left them.
#
# Never a bare `dashboard session end`: with no live leaf it falls back to ending the raw session id
# itself, and with more than one it refuses (runEnd, dashboard/lifecycle.ts). Each live leaf is
# ended by its explicit id instead, and a teammate that never posted a permission makes no end call.
#
# Claude Code sets the SessionEnd budget from, in order: the CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS
# override when it is set; otherwise the largest SessionEnd `timeout` across the merged settings
# hooks and the main-thread agent's frontmatter hooks, floored at 1.5s and capped at 60s. A plugin
# hooks.json `timeout` is none of those inputs, so this hook gets 1.5s unless one of them is set.
# Each dashboard call is a node start-up, so the guards run in the hook and the end loop re-runs
# this script detached (`--end-leaves`, its own session) and the hook exits at once.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DASHBOARD="${PLUGIN_ROOT}/bin/dashboard"

if [[ "${1:-}" == "--end-leaves" ]]; then
  # A node is a leaf only while nothing names it as parent, so ending the leaves exposes their
  # parents: each pass ends the current leaves, and the next status shows what they uncovered,
  # however deep the nesting goes. The loop stops when status lists nothing, when a pass ends
  # nothing, or when status lists the same leaves as the pass before (an end that reports success
  # but leaves the node live).
  # MAX_PASSES exists because this detached process has no outer timeout; it is not a depth limit.
  MAX_PASSES=50
  PREVIOUS_LEAVES=""
  for ((pass = 0; pass < MAX_PASSES; pass++)); do
    LEAVES=$("$DASHBOARD" session status --json 2>/dev/null | jq -r '.localLeafIds[]? // empty' 2>/dev/null) || LEAVES=""
    [[ -n "$LEAVES" && "$LEAVES" != "$PREVIOUS_LEAVES" ]] || break
    PREVIOUS_LEAVES="$LEAVES"

    ended=0
    while IFS= read -r leaf; do
      [[ -n "$leaf" ]] || continue
      if "$DASHBOARD" session end --session "$leaf" >/dev/null 2>&1; then
        ended=1
      fi
    done <<< "$LEAVES"
    [[ "$ended" -eq 1 ]] || break
  done
  exit 0
fi

INPUT=$(cat)

if ! command -v jq >/dev/null 2>&1; then exit 0; fi

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null) || TRANSCRIPT=""
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null) || AGENT_ID=""

[[ -z "$SESSION_ID" ]] && exit 0
case "$SESSION_ID" in
  *[!a-zA-Z0-9_-]*) exit 0 ;;
esac

# The same teammate test permission-hold.sh applies before nesting under the lead: its own process
# (no agent_id), team records in its transcript, and a lead session id in the team config that is
# not its own.
[[ -n "$AGENT_ID" || -z "$TRANSCRIPT" || ! -f "$TRANSCRIPT" ]] && exit 0
TEAM_LINE=$(jq -rn 'first(inputs | select(type == "object" and (.teamName | type) == "string" and (.agentName | type) == "string") | "\(.teamName) \(.agentName)")' "$TRANSCRIPT" 2>/dev/null) || TEAM_LINE=""
TEAM_NAME=""
AGENT_NAME=""
read -r TEAM_NAME AGENT_NAME <<< "$TEAM_LINE" || true
[[ "$TEAM_NAME" =~ ^[A-Za-z0-9_-]+$ && "$AGENT_NAME" =~ ^[A-Za-z0-9_-]+$ ]] || exit 0

STAMP_HOME="${HOME:-${TMPDIR:-/tmp}}"
TEAM_CONFIG="${CLAUDE_CONFIG_DIR:-${STAMP_HOME}/.claude}/teams/${TEAM_NAME}/config.json"
LEAD_SESSION_ID=$(jq -r '.leadSessionId // empty' "$TEAM_CONFIG" 2>/dev/null) || LEAD_SESSION_ID=""
case "$LEAD_SESSION_ID" in
  "" | "$SESSION_ID" | *[!a-zA-Z0-9_-]*) exit 0 ;;
esac

# The teammate's nodes live in its own registry, keyed by its session id — the same export
# permission-hold.sh made when it minted them.
export CLAUDE_CODE_SESSION_ID="$SESSION_ID"
perl -e 'use POSIX; POSIX::setsid(); exec @ARGV' bash "${BASH_SOURCE[0]:-$0}" --end-leaves \
  </dev/null >/dev/null 2>&1 &
exit 0
