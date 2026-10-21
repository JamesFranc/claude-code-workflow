#!/usr/bin/env bash
# PermissionRequest hook (FLOW-343): surface a held permission prompt as a board approval and
# hold the request while polling for the answer. Emits a decision when the board answers first;
# emits nothing on every other path, which leaves the decision to the terminal in any session that
# can display a prompt. In one that cannot, Claude Code denies a call no hook decides, and when
# that happens depends on the path: reaching the deadline defers the denial to the end of the hold,
# while the guards above abort before any hold exists and leave it immediate, as today.
#
# "Leaves the decision to the terminal" is deliberately weaker than "leaves the flow unchanged".
# Whether answering the terminal releases a hook that is still holding has never been measured:
# every pty run in the arch doc drove the hook, not the keyboard, and in each the gated call ran
# only after the hook returned. permission-clear.sh registers on four events, and three of them —
# PostToolUse, PostToolUseFailure, PermissionDenied — cannot fire until the call has resolved. The
# fourth, Stop, covers a manual terminal deny, and would end the hold within one poll interval by
# deleting the state file this loop watches. Whether Stop fires while this hook is still holding is
# the unmeasured part. Measure that direction before strengthening this sentence.
#
# The terminal prompt is NOT withheld while this runs — measured on 2.1.274, recorded in the
# architecture doc's timing table. Board and terminal race; whoever answers first wins.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DASHBOARD="${PLUGIN_ROOT}/bin/dashboard"
INPUT=$(cat)

# Under `set -e` an unguarded assignment from a missing jq
# aborts the script before the empty-check below can fail open.
if ! command -v jq >/dev/null 2>&1; then exit 0; fi

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || TOOL_NAME=""
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null) || TRANSCRIPT=""
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || CWD=""
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null) || AGENT_ID=""

# The tool's own input, for a reader deciding whether to allow it. Branches on the tool being Bash,
# not on the input merely having a `.command` field (an MCP tool's input can carry one too): the
# Bash tool_input's `.command` string goes through raw, every other tool (Edit, Write, MultiEdit,
# an MCP tool, ...) shows its whole input object, since no single field of those carries what's
# being approved.
DETAIL_FULL=$(printf '%s' "$INPUT" | jq -r --arg tool "$TOOL_NAME" '.tool_input | if $tool == "Bash" then .command else . end' 2>/dev/null) || DETAIL_FULL=""
# The permission log keeps a short excerpt, using the same selector permission-clear.sh logs
# (FLOW-378) so a requested/ran/failed sequence for one call agrees in the log. The board prompt
# further down carries the whole input via DETAIL_FULL instead.
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

log_event requested
[[ -z "$SESSION_ID" ]] && { log_event not-posted "no session_id"; exit 0; }
# SESSION_ID is interpolated into a filesystem path below without going through
# workflow-store/store.ts's storeRoot(), which owns ~/.claude/workflow-state and validates what it
# writes there. Refuse to build THAT path for anything that isn't the shape a session id takes.
# There is no path-free fallback worth keeping here: without the state
# file the clearing hook has nothing to read, so the hold could never be withdrawn.
case "$SESSION_ID" in
  *[!a-zA-Z0-9_-]*) log_event not-posted "malformed session_id"; exit 0 ;;
esac

[[ -z "$TOOL_NAME" ]] && { log_event not-posted "no tool_name"; exit 0; }

# Every dashboard call below runs without --session where resolution is ambiguous-free, and with an
# explicit node id where it is not; exporting the raw id is what makes the CLI's own registry
# lookups (loadRegistry) find this session's nodes at all — a hook gets Claude Code's process
# environment, but not session-scoped state, so nothing else carries this session's id into it.
export CLAUDE_CODE_SESSION_ID="$SESSION_ID"

STATE_DIR="${STAMP_HOME}/.claude/workflow-state/permission"
STATE_FILE="${STATE_DIR}/${SESSION_ID}"

# One poll every 3s, giving up after PERMISSION_HOLD_DEADLINE_S (default 570s). The value must sit
# inside the hook's own 600s timeout (hooks.json) so the deadline path still gets to run rather than
# being cancelled mid-write — a cancelled hook renders no decision either way, so the only thing the
# margin buys is a tidy exit. Garbage (non-digit) input falls back to the default rather than
# reaching the arithmetic below, and 600 or above falls back to the default too, so the margin
# always survives an override.
POLL_INTERVAL_S="${PERMISSION_POLL_INTERVAL_S:-3}"
HOLD_DEADLINE_S="${PERMISSION_HOLD_DEADLINE_S-570}"
[[ "$HOLD_DEADLINE_S" =~ ^[0-9]+$ ]] || HOLD_DEADLINE_S=570
(( HOLD_DEADLINE_S >= 600 )) && HOLD_DEADLINE_S=570

# A useful name for a board session this hook mints — the point is that the user can find the
# terminal from the board. The first three steps mirror bin/claude-sessions' session_title(): the
# /rename custom-title record, then a summary record, then the first non-meta user message with
# its tags stripped and whitespace collapsed. This hook deliberately diverges from that function in
# several places, stated because the comment would otherwise credit it with behaviour it does not
# have — the list below is illustrative, not exhaustive:
#   - it returns `(title, first_msg)` as two values for its caller to compose; this needs one
#     string, so the user message is a fallback rather than a parallel field.
#   - it has NO working-directory fallback — it returns empty and list_sessions skips the session.
#     A board session must still be named, so the basename below is this hook's own addition.
#   - it also carries a skip-prefix list and a `clean()` cap of 120 chars that this hook does not
#     reproduce (this hook's own cap is 80, applied below).
# The tag-stripping is not cosmetic: a first user message routinely carries <system-reminder> or
# <command-name> wrappers, and an unfiltered one names the board session after a leaked blob.
# Two passes, and the order matters. `<[^>]*>` alone removes only the delimiters, leaving the text
# BETWEEN an open and close tag — so a reminder's whole body survives into the title. (bin/
# claude-sessions' `re.sub(r"<[^>]+>", "", content)` has exactly this limitation, and is one more
# divergence from it, not a port of it.) The paired pass runs first and takes <system-reminder>
# blocks out body and all; the bare pass then clears whatever delimiters are left. jq's "m" flag
# is what lets `.` match a newline, which a multi-line reminder needs. <command-name> is
# deliberately NOT paired-stripped: its body is the slash command's name, which is informative.
# jq streams the JSONL rather than slurping it; a transcript is large.
derive_title() {
  local title=""
  if [[ -n "$TRANSCRIPT" && -f "$TRANSCRIPT" ]]; then
    title=$(jq -r 'select(.type == "custom-title") | .customTitle // empty' "$TRANSCRIPT" 2>/dev/null | tail -n 1) || title=""
    if [[ -z "$title" ]]; then
      title=$(jq -r 'select(.type == "summary") | .summary // empty' "$TRANSCRIPT" 2>/dev/null | tail -n 1) || title=""
    fi
    if [[ -z "$title" ]]; then
      title=$(jq -r 'select(.type == "user" and (.isMeta | not)) | .message.content | (if type == "string" then . else ([.[]? | select(.type == "text") | .text] | join(" ")) end) | gsub("<system-reminder>.*?</system-reminder>"; " "; "m") | gsub("<[^>]*>"; " ") | gsub("\\s+"; " ") | sub("^ +"; "") | sub(" +$"; "") | select(length >= 3)' "$TRANSCRIPT" 2>/dev/null | head -n 1) || title=""
    fi
  fi
  [[ -z "$title" ]] && title="$(basename "${CWD:-unknown}")"
  # Single line, bounded — a title is a board label, not a payload. Truncated with jq rather than
  # `cut -c`: BSD cut counts BYTES when the locale is not a UTF-8 one, and a hook inherits whatever
  # environment the harness hands it rather than a login shell's LANG. Measured with LANG/LC_ALL/
  # LC_CTYPE unset: `cut -c1-80` over a CJK title splits a character mid-sequence and emits invalid
  # UTF-8, which then reaches the board as a replacement character. jq slices by codepoint and is
  # locale-independent, and it is already a hard dependency of this hook.
  printf '%s' "${title//$'\n'/ }" | jq -Rrs '.[0:80]'
}

# A teammate is its own Claude process with its own session_id and no agent_id, so nothing above
# ties it to the lead that spawned it. Its transcript records carry teamName/agentName, and the team
# config names the lead's session id (the same path rule as mailbox/teammate-deaths.ts's
# loadTeamConfig). A teammate's board node nests under the lead's current node (FLOW-378), so its
# prompts sit under the story instead of a stray top-level session. The items stay on the teammate's
# own node: on the lead's node, the lead agent — woken by the lead's wake mod, which reads answers
# without consuming them — could consume the answer before this hook reads it.
# teammate-session-end.sh ends that node when the teammate's session ends.
TEAM_NAME=""
AGENT_NAME=""
LEAD_SESSION_ID=""
if [[ -z "$AGENT_ID" && -n "$TRANSCRIPT" && -f "$TRANSCRIPT" ]]; then
  TEAM_LINE=$(jq -rn 'first(inputs | select(type == "object" and (.teamName | type) == "string" and (.agentName | type) == "string") | "\(.teamName) \(.agentName)")' "$TRANSCRIPT" 2>/dev/null) || TEAM_LINE=""
  read -r TEAM_NAME AGENT_NAME <<< "$TEAM_LINE" || true
fi
# Both are interpolated below (a path, a title, a prompt), so both must be the shape Claude Code
# gives them.
[[ "$TEAM_NAME" =~ ^[A-Za-z0-9_-]+$ && "$AGENT_NAME" =~ ^[A-Za-z0-9_-]+$ ]] || TEAM_NAME=""
if [[ -n "$TEAM_NAME" ]]; then
  TEAM_CONFIG="${CLAUDE_CONFIG_DIR:-${STAMP_HOME}/.claude}/teams/${TEAM_NAME}/config.json"
  LEAD_SESSION_ID=$(jq -r '.leadSessionId // empty' "$TEAM_CONFIG" 2>/dev/null) || LEAD_SESSION_ID=""
  case "$LEAD_SESSION_ID" in
    "$SESSION_ID" | *[!a-zA-Z0-9_-]*) LEAD_SESSION_ID="" ;;
  esac
fi

# Which board node the item goes on. localActiveSessionId is the sole live leaf when the registry
# is unambiguous, and this prefers it. When it is not (more than one live leaf), localLeafIds is
# registry insertion order rather than recency, so the fallback below takes the OLDEST-entered
# leaf, not necessarily the one the current tool call is working on. Accepted as-is: `session
# status --json` exposes no field naming the current node in that case (localActiveSessionId is
# null there by construction), and resolveSessionId's own ambiguity fallback (session-id.ts)
# resolves against the full registry, which this hook has no CLI surface to read directly. A
# session with no live leaf at all has never entered the board, and gets one minted below: nested
# under its lead when it is a teammate and that nest succeeds, top-level otherwise — including a
# teammate whose lead has no live board node of its own.
# Re-entering an existing node is deliberately NOT done: `session enter` rewrites the node's phase,
# and a passing tool call must not move a session that is mid-review to a phase named after a
# permission prompt.
resolve_target() {
  "$DASHBOARD" session status --json 2>/dev/null | jq -r '.localActiveSessionId // .localLeafIds[0] // empty' 2>/dev/null || printf ''
}

TARGET=$(resolve_target)
if [[ -z "$TARGET" && -n "$LEAD_SESSION_ID" ]]; then
  "$DASHBOARD" session enter --phase permission --title "${AGENT_NAME} (teammate)" \
    --parent-session "$LEAD_SESSION_ID" >/dev/null 2>&1 ||
    log_event nest-failed "nested enter under lead ${LEAD_SESSION_ID} failed"
  TARGET=$(resolve_target)
fi
if [[ -z "$TARGET" ]]; then
  "$DASHBOARD" session enter --phase permission --title "$(derive_title)" >/dev/null 2>&1 ||
    { log_event not-posted "session enter failed"; exit 0; }
  TARGET=$(resolve_target)
  [[ -z "$TARGET" ]] && { log_event not-posted "no board node"; exit 0; }
fi

# The board item is what a reader approves, so it carries the whole input (FLOW-378): a command
# cut short gets rejected on sight. The one cap keeps the `item add --prompt` argument under
# Linux's 128 KiB per-argument limit (MAX_ARG_STRLEN) even at 4 bytes per character, and says so
# when it fires rather than cutting silently.
PROMPT_DETAIL_CAP=30000
PROMPT_DETAIL=$(printf '%s' "$DETAIL_FULL" | jq -Rrs --argjson cap "$PROMPT_DETAIL_CAP" \
  'if length > $cap then .[0:$cap] + "\n… [truncated, \(length - $cap) more chars]" else . end')

# A fenced block ends at the first fence at least as long as the one that opened it, so a tool
# input carrying its own ``` run would close this block early and render everything after it as
# Markdown — in the one item whose whole job is to show a reader what they are about to approve.
# Open with a fence longer than the longest backtick run inside.
FENCE_LEN=$(printf '%s' "$PROMPT_DETAIL" | awk '
  { n = 0
    for (i = 1; i <= length($0); i++)
      if (substr($0, i, 1) == "`") { n++; if (n > max) max = n } else n = 0 }
  END { print (max + 1 > 3 ? max + 1 : 3) }')
FENCE=$(printf "%${FENCE_LEN}s" '' | tr ' ' '`')

ASKER="**${TOOL_NAME}**"
[[ -n "$LEAD_SESSION_ID" ]] && ASKER="**${TOOL_NAME}** from teammate **${AGENT_NAME}**"
PROMPT=$(printf '%s\n' \
  "${ASKER} is waiting for permission in a terminal session." \
  "" \
  "$FENCE" \
  "${PROMPT_DETAIL}" \
  "$FENCE" \
  "" \
  "Approve to run it, reject to deny it. You can also answer in the terminal — whichever lands first wins.")

ITEM_ID=$("$DASHBOARD" item add --type approval --approval-kind hold --session "$TARGET" --prompt "$PROMPT" 2>/dev/null | jq -r '.itemId // empty' 2>/dev/null) || ITEM_ID=""
[[ -z "$ITEM_ID" ]] && { log_event not-posted "item add failed"; exit 0; }

finish() {
  "$DASHBOARD" item consume --item "$ITEM_ID" --session "$TARGET" >/dev/null 2>&1 || true
  rm -f "$STATE_FILE" 2>/dev/null || true
}

# Distinct from finish(): the item below was just posted and never released, so `item consume`
# refuses it (it requires state=released with readAt set) — `item withdraw` is the verb for an item
# that is still open, the same one permission-clear.sh uses for an unanswered item.
withdraw_unposted() {
  "$DASHBOARD" item withdraw --item "$ITEM_ID" --session "$TARGET" >/dev/null 2>&1 || true
  rm -f "$STATE_FILE" 2>/dev/null || true
}

# No mode at or above ~/.claude: that tree is shared with the rest of Claude Code and this hook
# does not own it. 0700 from workflow-state down, force-set on every call — `-m` only applies to a
# directory mkdir actually creates, so an existing 755 from before this hook stays 755 without the
# explicit chmod.
mkdir -p "${STAMP_HOME}/.claude" 2>/dev/null || true
mkdir -p -m 700 "${STAMP_HOME}/.claude/workflow-state" 2>/dev/null || true
mkdir -p -m 700 "$STATE_DIR" 2>/dev/null || true
chmod 700 "${STAMP_HOME}/.claude/workflow-state" "$STATE_DIR" 2>/dev/null || true
# Trailing newline is load-bearing, not cosmetic: `read` returns 1 on a final line that has none,
# even though it assigns every field, so a file written without it makes the reader's exit status
# lie. Measured: `printf '%s %s' a b > f; read -r A B < f` exits 1 with A=a and B=b.
(umask 077 && printf '%s %s\n' "$ITEM_ID" "$TARGET" > "$STATE_FILE") 2>/dev/null || true
chmod 600 "$STATE_FILE" 2>/dev/null || true
# A failed mkdir/write above (read-only or full ~/.claude) leaves no state file for the clearing
# hook to find, and the poll loop below treats a missing state file as "already cleared" without
# ever running — falling straight through to the bottom of the script and leaving the item posted
# with nothing to withdraw it. Catch that here, the same way an external clear is handled.
[[ -f "$STATE_FILE" ]] || { withdraw_unposted; log_event not-posted "state file unwritable"; exit 0; }

ITEM_HEADER="[dashboard] item ${ITEM_ID} ("
DEADLINE=$(( $(date +%s) + HOLD_DEADLINE_S ))
while [[ -f "$STATE_FILE" ]] && (( $(date +%s) < DEADLINE )); do
  sleep "$POLL_INTERVAL_S"
  # The state file is also the stop signal: the clearing hook deletes it when the terminal answered
  # first, and this re-check is what ends the poll without any pid handling (pattern-kills are
  # blocked in this repo by hooks/dangerous-command-guard.sh).
  [[ -f "$STATE_FILE" ]] || exit 0
  # -a: a rejection note can carry a NUL byte (JSON allows escaping one into a string, and
  # Node's UTF-8 encoder never strips it), and without -a that makes grep treat the line as
  # binary and print "Binary file (standard input) matches" instead of it — the case below
  # then never matches, and the hold silently rides out the deadline instead of relaying the
  # board's answer.
  # The line read is the first one that starts with this item's own header, compared literally: the
  # line after an item names its consume command, and another item's note can quote this header
  # mid-line. grep -aF only narrows the candidates; the prefix test below picks the line.
  LINE=""
  while IFS= read -r candidate; do
    if [[ "$candidate" == "$ITEM_HEADER"* ]]; then
      LINE=$candidate
      break
    fi
  done < <("$DASHBOARD" answers --session "$TARGET" 2>/dev/null | grep -aF "$ITEM_HEADER" || true)
  case "$LINE" in
    "[dashboard] item ${ITEM_ID} (approval): approved"*)
      finish
      log_event board-allow
      printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
      exit 0
      ;;
    "[dashboard] item ${ITEM_ID} (approval): rejected"*)
      NOTE=${LINE#"[dashboard] item ${ITEM_ID} (approval): rejected"}
      NOTE=${NOTE#" — "}
      [[ -z "$NOTE" ]] && NOTE="Rejected from the board"
      finish
      log_event board-deny "$NOTE"
      jq -cn --arg m "$NOTE" '{hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"deny",message:$m}}}'
      exit 0
      ;;
  esac
done

# Deadline reached with no board answer. Leave the item standing — the clearing hook withdraws it
# once the call resolves either way. Emitting nothing hands the call back undecided: where a prompt
# can be displayed it has been on screen throughout and is still answerable, so the flow is
# unchanged; where one cannot, this is the point at which the harness denies the call.
[[ -f "$STATE_FILE" ]] && log_event deadline
exit 0
