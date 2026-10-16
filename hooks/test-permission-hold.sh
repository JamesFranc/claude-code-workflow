#!/bin/bash
# Test script for permission-hold.sh (FLOW-343)
# Drives the hook against a copied plugin root with a stubbed bin/dashboard whose behaviour is
# steered by small config files under bin/config/.

set -euo pipefail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/permission-hold.sh"
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

check_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    echo "  expected to contain: $needle"
    echo "  actual:               $haystack"
    FAIL=$((FAIL + 1))
  fi
}

check_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label"
    echo "  expected NOT to contain: $needle"
    echo "  actual:                   $haystack"
    FAIL=$((FAIL + 1))
  fi
}

# Build a plugin root containing a copy of the hook plus a stubbed bin/dashboard whose behaviour
# is read from bin/config/* files written by each case below.
make_root() {
  local root="$1"
  mkdir -p "$root/hooks" "$root/bin/config"
  cp "$HOOK_SCRIPT" "$root/hooks/permission-hold.sh"
  chmod +x "$root/hooks/permission-hold.sh"
  cat > "$root/bin/dashboard" <<'STUB'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$DIR/config"
LOG="$DIR/calls.log"

case "$1" in
  item)
    case "$2" in
      add)
        ARGS=("$@")
        PROMPT_VALUE=""
        REDACTED=()
        i=0
        while [[ $i -lt ${#ARGS[@]} ]]; do
          if [[ "${ARGS[$i]}" == "--prompt" ]]; then
            PROMPT_VALUE="${ARGS[$((i + 1))]}"
            REDACTED+=("--prompt" "<REDACTED>")
            i=$((i + 2))
            continue
          fi
          REDACTED+=("${ARGS[$i]}")
          i=$((i + 1))
        done
        printf '%s\n' "${REDACTED[*]}" >> "$LOG"
        printf '%s' "$PROMPT_VALUE" > "$DIR/last-prompt.txt"
        if [[ -f "$CONFIG/item-id" ]]; then
          printf '{"itemId":"%s"}\n' "$(cat "$CONFIG/item-id")"
        else
          printf '{}\n'
        fi
        ;;
      consume)
        printf '%s\n' "$*" >> "$LOG"
        ;;
      withdraw)
        printf '%s\n' "$*" >> "$LOG"
        ;;
    esac
    ;;
  session)
    case "$2" in
      status)
        printf '%s\n' "$*" >> "$LOG"
        if [[ -f "$CONFIG/leaf" ]]; then
          printf '{"localLeafIds":["%s"]}\n' "$(cat "$CONFIG/leaf")"
        else
          printf '{"localLeafIds":[]}\n'
        fi
        ;;
      enter)
        printf '%s\n' "$*" >> "$LOG"
        [[ -f "$CONFIG/enter-fails" ]] && exit 1
        [[ -f "$CONFIG/parent-enter-fails" && " $* " == *" --parent-session "* ]] && exit 1
        if [[ -f "$CONFIG/leaf-after-enter" ]]; then
          cp "$CONFIG/leaf-after-enter" "$CONFIG/leaf"
        fi
        ;;
    esac
    ;;
  answers)
    printf '%s\n' "$*" >> "$LOG"
    if [[ -f "$CONFIG/capture-state-file" && ! -f "$CONFIG/captured-once" ]]; then
      cp "$(cat "$CONFIG/capture-state-file")" "$DIR/captured-state.raw" 2>/dev/null || true
      touch "$CONFIG/captured-once"
    fi
    if [[ -f "$CONFIG/delete-state-file" && ! -f "$CONFIG/deleted-once" ]]; then
      rm -f "$(cat "$CONFIG/delete-state-file")"
      touch "$CONFIG/deleted-once"
    fi
    if [[ -f "$CONFIG/answers-line" ]]; then
      cat "$CONFIG/answers-line"
    fi
    ;;
esac
exit 0
STUB
  chmod +x "$root/bin/dashboard"
  : > "$root/bin/calls.log"
}

# Returns the contents of the first fenced block in a prompt, applying CommonMark's closing rule:
# a closer is a run of backticks at least as long as the opener. Both fence cases read the block
# back through this, so neither can pass by assuming a width.
fenced_block() {
  printf '%s' "$1" | python3 -c '
import sys
lines = sys.stdin.read().split("\n")
opener = next((i for i, l in enumerate(lines) if l and set(l) == {"`"}), None)
if opener is None:
    sys.exit(0)
width = len(lines[opener])
for j in range(opener + 1, len(lines)):
    stripped = lines[j].strip()
    if stripped and set(stripped) == {"`"} and len(stripped) >= width:
        print("\n".join(lines[opener + 1:j]))
        break
'
}

set_config() {
  local root="$1" key="$2" value="$3"
  printf '%s' "$value" > "$root/bin/config/$key"
}

calls_log() {
  local root="$1"
  cat "$root/bin/calls.log" 2>/dev/null || printf ''
}

# The permission log's events for a HOME, space-joined; empty when there is no log.
log_events() {
  jq -r '.event' "$1/.claude/workflow-state/permission-log.jsonl" 2>/dev/null | paste -sd' ' - || printf ''
}

# One field of one log line: $1 HOME, $2 zero-based line index, $3 a jq path such as .note
log_field() {
  jq -rs --argjson i "$2" ".[\$i]$3 // empty" "$1/.claude/workflow-state/permission-log.jsonl" 2>/dev/null || printf ''
}

# Portable octal file-permission bits.
file_mode() {
  local mode
  mode=$(stat -c '%a' "$1" 2>/dev/null) && { printf '%s\n' "$mode"; return 0; }
  stat -f '%Lp' "$1"
}

# Runs the hook with a fresh HOME and a fast poll interval. Sets HOOK_EXIT and HOOK_STDOUT.
run_hold_hook() {
  local root="$1" home_dir="$2" session_id="$3" tool_name="$4" command_value="$5" transcript="$6" cwd="$7"
  local input
  input=$(jq -n --arg sid "$session_id" --arg tn "$tool_name" --arg cmd "$command_value" \
    --arg tp "$transcript" --arg cwd "$cwd" \
    '{session_id: $sid, tool_name: $tn, tool_input: {command: $cmd}, transcript_path: $tp, cwd: $cwd}')
  HOOK_EXIT=0
  HOOK_STDOUT=$(printf '%s' "$input" | HOME="$home_dir" CLAUDE_CONFIG_DIR="$home_dir/.claude" \
    PERMISSION_POLL_INTERVAL_S=0 \
    bash "$root/hooks/permission-hold.sh" 2>/dev/null) || HOOK_EXIT=$?
}

echo "=== permission-hold Hook Tests ==="
echo

# --- 1: board answers approved -----------------------------------------------------------------
ROOT1="$TMP_ROOT/c1"
HOME1="$TMP_ROOT/c1-home"
make_root "$ROOT1"
mkdir -p "$HOME1"
set_config "$ROOT1" leaf "leaf-1"
set_config "$ROOT1" item-id "item-1"
set_config "$ROOT1" answers-line "[dashboard] item item-1 (approval): approved"
run_hold_hook "$ROOT1" "$HOME1" "session-1" "Bash" "echo hi" "" "/tmp/proj"
check "1: exit 0 on approved" "0" "$HOOK_EXIT"
check "1: stdout is exactly the allow decision" \
  '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' \
  "$HOOK_STDOUT"
check "1: the log records the request and the board's allow" "requested board-allow" "$(log_events "$HOME1")"
check "1: agent_id is null when the payload has none" "null" "$(log_field "$HOME1" 0 '.agent_id | tostring')"

# --- 2: board answers rejected with a note -----------------------------------------------------
ROOT2="$TMP_ROOT/c2"
HOME2="$TMP_ROOT/c2-home"
make_root "$ROOT2"
mkdir -p "$HOME2"
set_config "$ROOT2" leaf "leaf-2"
set_config "$ROOT2" item-id "item-2"
set_config "$ROOT2" answers-line "[dashboard] item item-2 (approval): rejected — no thanks"
run_hold_hook "$ROOT2" "$HOME2" "session-2" "Bash" "rm -rf /tmp/x" "" "/tmp/proj"
check "2: exit 0 on rejected" "0" "$HOOK_EXIT"
BEHAVIOR2=$(printf '%s' "$HOOK_STDOUT" | jq -r '.hookSpecificOutput.decision.behavior' 2>/dev/null)
MESSAGE2=$(printf '%s' "$HOOK_STDOUT" | jq -r '.hookSpecificOutput.decision.message' 2>/dev/null)
check "2: decision behavior is deny" "deny" "$BEHAVIOR2"
check "2: decision message is the note after the separator" "no thanks" "$MESSAGE2"
check "2: the log records the request and the board's deny" "requested board-deny" "$(log_events "$HOME2")"
check "2: the deny line carries the reject note" "no thanks" "$(log_field "$HOME2" 1 .note)"

# --- 3: item add returns no itemId -------------------------------------------------------------
ROOT3="$TMP_ROOT/c3"
HOME3="$TMP_ROOT/c3-home"
make_root "$ROOT3"
mkdir -p "$HOME3"
set_config "$ROOT3" leaf "leaf-3"
run_hold_hook "$ROOT3" "$HOME3" "session-3" "Bash" "echo hi" "" "/tmp/proj"
check "3: exit 0 when item add returns no itemId" "0" "$HOOK_EXIT"
check "3: stdout is empty when item add returns no itemId" "" "$HOOK_STDOUT"
check_not_contains "3: no answers call is made when item add fails" "$(calls_log "$ROOT3")" "answers"
check "3: the log records that the prompt never reached the board" "requested not-posted" "$(log_events "$HOME3")"
check "3: the not-posted note names the failed item add" "item add failed" "$(log_field "$HOME3" 1 .note)"

# --- 4: no live leaf, transcript has a custom-title ---------------------------------------------
ROOT4="$TMP_ROOT/c4"
HOME4="$TMP_ROOT/c4-home"
make_root "$ROOT4"
mkdir -p "$HOME4"
TRANSCRIPT4="$TMP_ROOT/c4-transcript.jsonl"
printf '%s\n' '{"type":"custom-title","customTitle":"My Custom Title"}' > "$TRANSCRIPT4"
run_hold_hook "$ROOT4" "$HOME4" "session-4" "Bash" "echo hi" "$TRANSCRIPT4" "/tmp/proj"
check "4: exit 0 with no live leaf and a custom-title transcript" "0" "$HOOK_EXIT"
check_contains "4: session enter uses the custom-title as the title" "$(calls_log "$ROOT4")" \
  "session enter --phase permission --title My Custom Title"

# --- 5: no live leaf, transcript has only a summary record ---------------------------------------
ROOT5="$TMP_ROOT/c5"
HOME5="$TMP_ROOT/c5-home"
make_root "$ROOT5"
mkdir -p "$HOME5"
TRANSCRIPT5="$TMP_ROOT/c5-transcript.jsonl"
printf '%s\n' '{"type":"summary","summary":"Summary text here"}' > "$TRANSCRIPT5"
run_hold_hook "$ROOT5" "$HOME5" "session-5" "Bash" "echo hi" "$TRANSCRIPT5" "/tmp/proj"
check "5: exit 0 with no live leaf and a summary-only transcript" "0" "$HOOK_EXIT"
check_contains "5: session enter falls back to the summary text as the title" "$(calls_log "$ROOT5")" \
  "session enter --phase permission --title Summary text here"

# --- 6: no live leaf, no transcript file ---------------------------------------------------------
ROOT6="$TMP_ROOT/c6"
HOME6="$TMP_ROOT/c6-home"
make_root "$ROOT6"
mkdir -p "$HOME6"
run_hold_hook "$ROOT6" "$HOME6" "session-6" "Bash" "echo hi" "" "/tmp/some/project-name"
check "6: exit 0 with no live leaf and no transcript file" "0" "$HOOK_EXIT"
check_contains "6: session enter falls back to basename(cwd) as the title" "$(calls_log "$ROOT6")" \
  "session enter --phase permission --title project-name"
check "6: a session with no board node after enter logs not-posted" "requested not-posted" "$(log_events "$HOME6")"
check "6: the note names the missing board node" "no board node" "$(log_field "$HOME6" 1 .note)"

# --- 6b: first user message has a system-reminder wrapper, tag and body both stripped -----------
ROOT6B="$TMP_ROOT/c6b"
HOME6B="$TMP_ROOT/c6b-home"
make_root "$ROOT6B"
mkdir -p "$HOME6B"
TRANSCRIPT6B="$TMP_ROOT/c6b-transcript.jsonl"
jq -cn '{type:"user", message:{content:"<system-reminder>foo</system-reminder> fix the parser"}}' > "$TRANSCRIPT6B"
run_hold_hook "$ROOT6B" "$HOME6B" "session-6b" "Bash" "echo hi" "$TRANSCRIPT6B" "/tmp/other-project"
check "6b: exit 0 with a system-reminder-wrapped first user message" "0" "$HOOK_EXIT"
check_contains "6b: the reminder tag AND its body are stripped from the title" "$(calls_log "$ROOT6B")" \
  "session enter --phase permission --title fix the parser"
check_not_contains "6b: the title carries no leftover foo from the reminder body" "$(calls_log "$ROOT6B")" \
  "foo fix the parser"

# --- 6b2: a multi-line system-reminder block is stripped whole ----------------------------------
ROOT6B2="$TMP_ROOT/c6b2"
HOME6B2="$TMP_ROOT/c6b2-home"
make_root "$ROOT6B2"
mkdir -p "$HOME6B2"
TRANSCRIPT6B2="$TMP_ROOT/c6b2-transcript.jsonl"
jq -cn '{type:"user", message:{content:"fix the parser\n\n<system-reminder>\nlong blah\n</system-reminder>"}}' > "$TRANSCRIPT6B2"
run_hold_hook "$ROOT6B2" "$HOME6B2" "session-6b2" "Bash" "echo hi" "$TRANSCRIPT6B2" "/tmp/other-project"
check "6b2: exit 0 with a multi-line system-reminder block" "0" "$HOOK_EXIT"
check_contains "6b2: the whole multi-line reminder block is stripped" "$(calls_log "$ROOT6B2")" \
  "session enter --phase permission --title fix the parser"
check_not_contains "6b2: no leftover reminder body survives" "$(calls_log "$ROOT6B2")" "long blah"

# --- 6b3: content is an array of two text parts, both appear space-joined -----------------------
ROOT6B3="$TMP_ROOT/c6b3"
HOME6B3="$TMP_ROOT/c6b3-home"
make_root "$ROOT6B3"
mkdir -p "$HOME6B3"
TRANSCRIPT6B3="$TMP_ROOT/c6b3-transcript.jsonl"
jq -cn '{type:"user", message:{content:[{type:"text",text:"part one"},{type:"text",text:"part two"}]}}' > "$TRANSCRIPT6B3"
run_hold_hook "$ROOT6B3" "$HOME6B3" "session-6b3" "Bash" "echo hi" "$TRANSCRIPT6B3" "/tmp/other-project"
check "6b3: exit 0 with a two-part text array" "0" "$HOOK_EXIT"
check_contains "6b3: both text parts appear, space-joined" "$(calls_log "$ROOT6B3")" \
  "session enter --phase permission --title part one part two"

# --- 6c: no live leaf, first user message is too short after trimming --------------------------
ROOT6C="$TMP_ROOT/c6c"
HOME6C="$TMP_ROOT/c6c-home"
make_root "$ROOT6C"
mkdir -p "$HOME6C"
TRANSCRIPT6C="$TMP_ROOT/c6c-transcript.jsonl"
printf '%s\n' '{"type":"user","message":{"content":"hi"}}' > "$TRANSCRIPT6C"
run_hold_hook "$ROOT6C" "$HOME6C" "session-6c" "Bash" "echo hi" "$TRANSCRIPT6C" "/tmp/other-project"
check "6c: exit 0 with a too-short first user message" "0" "$HOOK_EXIT"
check_contains "6c: session enter falls back to basename(cwd) when the message is under 3 chars" \
  "$(calls_log "$ROOT6C")" "session enter --phase permission --title other-project"

# --- 6d: a 120-character CJK title is truncated to 80 codepoints, not 80 bytes -------------------
ROOT6D="$TMP_ROOT/c6d"
HOME6D="$TMP_ROOT/c6d-home"
make_root "$ROOT6D"
mkdir -p "$HOME6D"
TRANSCRIPT6D="$TMP_ROOT/c6d-transcript.jsonl"
CJK120=$(jq -n '[range(120)] | map("あ") | join("")')
jq -cn --arg c "$CJK120" '{type:"user", message:{content:$c}}' > "$TRANSCRIPT6D"
INPUT6D=$(jq -n --arg sid "session-6d" --arg tn "Bash" --arg cmd "echo hi" \
  --arg tp "$TRANSCRIPT6D" --arg cwd "/tmp/other-project" \
  '{session_id: $sid, tool_name: $tn, tool_input: {command: $cmd}, transcript_path: $tp, cwd: $cwd}')
HOOK_EXIT=0
printf '%s' "$INPUT6D" | env -u LANG -u LC_ALL -u LC_CTYPE HOME="$HOME6D" CLAUDE_CONFIG_DIR="$HOME6D/.claude" \
  PERMISSION_POLL_INTERVAL_S=0 \
  bash "$ROOT6D/hooks/permission-hold.sh" >/dev/null 2>/dev/null || HOOK_EXIT=$?
TITLE6D=$(calls_log "$ROOT6D" | LC_ALL=C grep -aF 'session enter' | LC_ALL=C sed 's/.*--title //')
TITLE6D_CODEPOINTS=$(printf '%s' "$TITLE6D" | jq -Rs 'length')
check "6d: exit 0 with a 120-character CJK title and no LANG/LC_ALL/LC_CTYPE" "0" "$HOOK_EXIT"
check "6d: the logged title is exactly 80 codepoints, not split mid-character" "80" "$TITLE6D_CODEPOINTS"

# --- 7: state file deleted before the first poll returns (terminal answered first) ---------------
ROOT7="$TMP_ROOT/c7"
HOME7="$TMP_ROOT/c7-home"
make_root "$ROOT7"
mkdir -p "$HOME7"
set_config "$ROOT7" leaf "leaf-7"
set_config "$ROOT7" item-id "item-7"
STATE_FILE7="$HOME7/.claude/workflow-state/permission/session-7"
cat > "$ROOT7/bin/sleep" <<SLEEPSTUB
#!/usr/bin/env bash
rm -f "$STATE_FILE7"
SLEEPSTUB
chmod +x "$ROOT7/bin/sleep"
INPUT7=$(jq -n --arg sid "session-7" --arg tn "Bash" --arg cmd "echo hi" \
  --arg tp "" --arg cwd "/tmp/proj" \
  '{session_id: $sid, tool_name: $tn, tool_input: {command: $cmd}, transcript_path: $tp, cwd: $cwd}')
HOOK_EXIT=0
HOOK_STDOUT=$(printf '%s' "$INPUT7" | PATH="$ROOT7/bin:$PATH" HOME="$HOME7" CLAUDE_CONFIG_DIR="$HOME7/.claude" \
  PERMISSION_POLL_INTERVAL_S=0 \
  bash "$ROOT7/hooks/permission-hold.sh" 2>/dev/null) || HOOK_EXIT=$?
check "7: exit 0 when the state file disappears mid-poll" "0" "$HOOK_EXIT"
check "7: stdout is empty when the state file disappears mid-poll" "" "$HOOK_STDOUT"
check_not_contains "7: no answers call once the state file vanished during the sleep" "$(calls_log "$ROOT7")" "answers"
check "7: a hold the terminal answered logs only the request" "requested" "$(log_events "$HOME7")"

# --- 8: a live leaf exists -> no session enter ----------------------------------------------------
ROOT8="$TMP_ROOT/c8"
HOME8="$TMP_ROOT/c8-home"
make_root "$ROOT8"
mkdir -p "$HOME8"
set_config "$ROOT8" leaf "leaf-8"
set_config "$ROOT8" item-id "item-8"
set_config "$ROOT8" answers-line "[dashboard] item item-8 (approval): approved"
run_hold_hook "$ROOT8" "$HOME8" "session-8" "Bash" "echo hi" "" "/tmp/proj"
check "8: exit 0 with a live leaf" "0" "$HOOK_EXIT"
check_not_contains "8: a live leaf skips session enter" "$(calls_log "$ROOT8")" "session enter"

# --- 9: tool input containing the declaration delimiter passes through unmodified ---------------
# reproducesDeclarationBlockquote only runs inside composeQuestionPrompt (item.ts), which only
# --type question posts reach; this hook posts --type approval, so a tool command that happens to
# contain " · " must reach the board exactly as the tool saw it, not neutralised.
ROOT9="$TMP_ROOT/c9"
HOME9="$TMP_ROOT/c9-home"
make_root "$ROOT9"
mkdir -p "$HOME9"
set_config "$ROOT9" leaf "leaf-9"
set_config "$ROOT9" item-id "item-9"
set_config "$ROOT9" answers-line "[dashboard] item item-9 (approval): approved"
run_hold_hook "$ROOT9" "$HOME9" "session-9" "Bash" "echo a · b" "" "/tmp/proj"
LAST_PROMPT9=$(cat "$ROOT9/bin/last-prompt.txt" 2>/dev/null || printf '')
check "9: exit 0 with a middle dot in the tool input" "0" "$HOOK_EXIT"
check_contains "9: the logged prompt carries the tool input unmodified" "$LAST_PROMPT9" "echo a · b"

# --- 10: session_id contains a path separator -----------------------------------------------------
ROOT10="$TMP_ROOT/c10"
HOME10="$TMP_ROOT/c10-home"
make_root "$ROOT10"
mkdir -p "$HOME10"
run_hold_hook "$ROOT10" "$HOME10" "abc/def" "Bash" "echo hi" "" "/tmp/proj"
check "10: exit 0 with a session_id containing a path separator" "0" "$HOOK_EXIT"
check "10: no dashboard call at all with a malformed session_id" "" "$(calls_log "$ROOT10")"
check "10: a malformed session_id is still logged as not-posted" "requested not-posted" "$(log_events "$HOME10")"
check "10: the note names the malformed session_id" "malformed session_id" "$(log_field "$HOME10" 1 .note)"

# --- 12: state file is written with a trailing newline -------------------------------------------
ROOT12="$TMP_ROOT/c12"
HOME12="$TMP_ROOT/c12-home"
make_root "$ROOT12"
mkdir -p "$HOME12"
set_config "$ROOT12" leaf "leaf-12"
set_config "$ROOT12" item-id "item-12"
set_config "$ROOT12" answers-line "[dashboard] item item-12 (approval): approved"
set_config "$ROOT12" capture-state-file "$HOME12/.claude/workflow-state/permission/session-12"
run_hold_hook "$ROOT12" "$HOME12" "session-12" "Bash" "echo hi" "" "/tmp/proj"
CAPTURED12="$ROOT12/bin/captured-state.raw"
LAST_BYTE12=$(tail -c1 "$CAPTURED12" 2>/dev/null | od -An -tx1 | tr -d ' \n')
check "12: sanity — the hold hook still exits 0 on approved" "0" "$HOOK_EXIT"
check "12: the state file's last byte is a newline" "0a" "$LAST_BYTE12"

# --- 13: a command of 1 ASCII char + 700 CJK chars exceeds 600 bytes. The board prompt carries the
# whole 701-codepoint command uncut; the permission log keeps a 600-codepoint excerpt (FLOW-378).
# Invoked via /bin/bash with no LANG/LC_ALL/LC_CTYPE, same as 6d: Apple's stock /bin/bash (3.2) only
# slices `${DETAIL:0:600}` by byte under a non-UTF-8 locale, and this case's RED depends on that
# host property.
ROOT13="$TMP_ROOT/c13"
HOME13="$TMP_ROOT/c13-home"
make_root "$ROOT13"
mkdir -p "$HOME13"
set_config "$ROOT13" leaf "leaf-13"
set_config "$ROOT13" item-id "item-13"
set_config "$ROOT13" answers-line "[dashboard] item item-13 (approval): approved"
CJK700=$(jq -rn '[range(700)] | map("あ") | join("")')
CMD13="a${CJK700}"
INPUT13=$(jq -n --arg sid "session-13" --arg tn "Bash" --arg cmd "$CMD13" \
  --arg tp "" --arg cwd "/tmp/proj" \
  '{session_id: $sid, tool_name: $tn, tool_input: {command: $cmd}, transcript_path: $tp, cwd: $cwd}')
HOOK_EXIT=0
printf '%s' "$INPUT13" | env -u LANG -u LC_ALL -u LC_CTYPE HOME="$HOME13" CLAUDE_CONFIG_DIR="$HOME13/.claude" \
  PERMISSION_POLL_INTERVAL_S=0 \
  /bin/bash "$ROOT13/hooks/permission-hold.sh" >/dev/null 2>/dev/null || HOOK_EXIT=$?
LAST_PROMPT13=$(cat "$ROOT13/bin/last-prompt.txt" 2>/dev/null || printf '')
FENCED13=$(fenced_block "$LAST_PROMPT13")
FENCED13_VALID=valid
printf '%s' "$FENCED13" | python3 -c 'import sys; sys.stdin.buffer.read().decode("utf-8")' 2>/dev/null || FENCED13_VALID=invalid
FENCED13_CODEPOINTS=$(printf '%s' "$FENCED13" | jq -Rs 'length' 2>/dev/null || printf '')
LOG13_INPUT=$(log_field "$HOME13" 0 .input)
LOG13_VALID=valid
printf '%s' "$LOG13_INPUT" | python3 -c 'import sys; sys.stdin.buffer.read().decode("utf-8")' 2>/dev/null || LOG13_VALID=invalid
LOG13_CODEPOINTS=$(printf '%s' "$LOG13_INPUT" | jq -Rs 'length' 2>/dev/null || printf '')
check "13: exit 0 with a 700-CJK-char command exceeding 600 bytes" "0" "$HOOK_EXIT"
check "13: the board prompt's fenced block is valid UTF-8" "valid" "$FENCED13_VALID"
check "13: the board prompt carries the whole 701-codepoint command uncut" "701" "$FENCED13_CODEPOINTS"
check "13: the logged detail is valid UTF-8" "valid" "$LOG13_VALID"
check "13: the logged detail is exactly 600 codepoints, not split mid-character" "600" "$LOG13_CODEPOINTS"

# --- 14: an answers line containing a NUL byte still yields the decision. Without -a, BSD grep's
# binary-file heuristic swallows the real line and prints "Binary file (standard input) matches"
# instead, which the case match below never recognizes — written straight to the config file
# (not through set_config's variable) since a shell variable cannot hold an embedded NUL.
ROOT14="$TMP_ROOT/c14"
HOME14="$TMP_ROOT/c14-home"
make_root "$ROOT14"
mkdir -p "$HOME14"
set_config "$ROOT14" leaf "leaf-14"
set_config "$ROOT14" item-id "item-14"
printf '[dashboard] item item-14 (approval): approved\x00\n' > "$ROOT14/bin/config/answers-line"
# Bounds a would-be non-isolated RED to one poll instead of the full 570s deadline: the stub
# deletes the state file as a side effect of the SAME answers call that serves the NUL-bearing
# line, so a build without the fix (which never matches that line) falls out of the while loop
# on its very next condition check instead of spinning to the timeout. With the fix, the match
# fires and the hook exits from inside the case statement before the loop is re-entered, so this
# has no effect on the passing run.
set_config "$ROOT14" delete-state-file "$HOME14/.claude/workflow-state/permission/session-14"
run_hold_hook "$ROOT14" "$HOME14" "session-14" "Bash" "echo hi" "" "/tmp/proj"
check "14: exit 0 on an approved answer line containing a NUL byte" "0" "$HOOK_EXIT"
check "14: stdout is exactly the allow decision despite the embedded NUL" \
  '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' \
  "$HOOK_STDOUT"

# --- 15: a second prompt in the same session reuses the board node this hook minted, rather
# than minting a second one. `leaf-after-enter` makes the stubbed `session status` report the
# minted leaf from the second call onward, mirroring the real board reflecting the node `session
# enter` just created.
ROOT15="$TMP_ROOT/c15"
HOME15="$TMP_ROOT/c15-home"
make_root "$ROOT15"
mkdir -p "$HOME15"
set_config "$ROOT15" item-id "item-15"
set_config "$ROOT15" leaf-after-enter "leaf-15"
set_config "$ROOT15" answers-line "[dashboard] item item-15 (approval): approved"
run_hold_hook "$ROOT15" "$HOME15" "session-15" "Bash" "echo hi" "" "/tmp/proj"
check "15: exit 0 when minting a fresh board session" "0" "$HOOK_EXIT"
check_contains "15: session enter is called when no live leaf exists" "$(calls_log "$ROOT15")" "session enter"
: > "$ROOT15/bin/calls.log"
run_hold_hook "$ROOT15" "$HOME15" "session-15" "Bash" "echo hi again" "" "/tmp/proj"
check "15: exit 0 on a second prompt in the same session" "0" "$HOOK_EXIT"
check_not_contains "15: the second prompt reuses the minted node instead of minting a new one" \
  "$(calls_log "$ROOT15")" "session enter"

# --- 17: the state directory cannot be created -> the item is withdrawn, not left dangling ---
ROOT17="$TMP_ROOT/c17"
HOME17="$TMP_ROOT/c17-home"
make_root "$ROOT17"
mkdir -p "$HOME17"
: > "$HOME17/.claude"
set_config "$ROOT17" leaf "leaf-17"
set_config "$ROOT17" item-id "item-17"
run_hold_hook "$ROOT17" "$HOME17" "session-17" "Bash" "echo hi" "" "/tmp/proj"
check "17: exit 0 when the state directory cannot be created" "0" "$HOOK_EXIT"
check_contains "17: item withdraw is called, not consume — the item was never released" \
  "$(calls_log "$ROOT17")" "item withdraw --item item-17 --session leaf-17"
check_not_contains "17: item consume is never attempted on the never-released item" \
  "$(calls_log "$ROOT17")" "item consume"
check_not_contains "17: no answers poll is attempted with no state file to watch" "$(calls_log "$ROOT17")" "answers"

# --- 18: PERMISSION_HOLD_DEADLINE_S shortens the poll loop's own deadline, not just get read -----
ROOT18="$TMP_ROOT/c18"
HOME18="$TMP_ROOT/c18-home"
make_root "$ROOT18"
mkdir -p "$HOME18"
set_config "$ROOT18" leaf "leaf-18"
set_config "$ROOT18" item-id "item-18"
START18=$(date +%s)
export PERMISSION_HOLD_DEADLINE_S="1"
run_hold_hook "$ROOT18" "$HOME18" "session-18" "Bash" "echo hi" "" "/tmp/proj"
unset PERMISSION_HOLD_DEADLINE_S
ELAPSED18=$(( $(date +%s) - START18 ))
check "18: exit 0 when the deadline is reached with no board answer" "0" "$HOOK_EXIT"
check "18: no decision is emitted when the deadline is reached" "" "$HOOK_STDOUT"
if (( ELAPSED18 <= 30 )); then
  echo "PASS: 18: a 1s override ends the hold in ~1s, not the 570s default"
  PASS=$((PASS + 1))
else
  echo "FAIL: 18: a 1s override ends the hold in ~1s, not the 570s default"
  echo "  expected: <= 30s elapsed"
  echo "  actual:   ${ELAPSED18}s elapsed"
  FAIL=$((FAIL + 1))
fi
check "18: a hold that reached its deadline logs deadline" "requested deadline" "$(log_events "$HOME18")"

# --- 19: a non-numeric PERMISSION_HOLD_DEADLINE_S falls back to the default instead of aborting --
ROOT19="$TMP_ROOT/c19"
HOME19="$TMP_ROOT/c19-home"
make_root "$ROOT19"
mkdir -p "$HOME19"
set_config "$ROOT19" leaf "leaf-19"
set_config "$ROOT19" item-id "item-19"
set_config "$ROOT19" answers-line "[dashboard] item item-19 (approval): approved"
export PERMISSION_HOLD_DEADLINE_S="abc"
run_hold_hook "$ROOT19" "$HOME19" "session-19" "Bash" "echo hi" "" "/tmp/proj"
unset PERMISSION_HOLD_DEADLINE_S
check "19: exit 0 with a non-numeric deadline override" "0" "$HOOK_EXIT"
check "19: stdout is exactly the allow decision despite the garbage override" \
  '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' \
  "$HOOK_STDOUT"

# --- 20: an empty PERMISSION_HOLD_DEADLINE_S falls back to the default instead of skipping the ---
# --- poll loop entirely (deadline == now, so the loop body never runs even once) ------------------
ROOT20="$TMP_ROOT/c20"
HOME20="$TMP_ROOT/c20-home"
make_root "$ROOT20"
mkdir -p "$HOME20"
set_config "$ROOT20" leaf "leaf-20"
set_config "$ROOT20" item-id "item-20"
set_config "$ROOT20" answers-line "[dashboard] item item-20 (approval): approved"
export PERMISSION_HOLD_DEADLINE_S=""
run_hold_hook "$ROOT20" "$HOME20" "session-20" "Bash" "echo hi" "" "/tmp/proj"
unset PERMISSION_HOLD_DEADLINE_S
check "20: exit 0 with an empty deadline override" "0" "$HOOK_EXIT"
check "20: stdout is exactly the allow decision despite the empty override" \
  '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' \
  "$HOOK_STDOUT"

# --- 21: a tool input containing its own ``` run cannot close the fence that wraps it -----------
# The detail is tool-controlled. A fixed ``` opener is closed by any ``` line inside the detail,
# so the rest of the tool's own text would render as Markdown in the very item a reader approves
# from. Assert the property rather than the fence width: the whole detail sits in one block.
ROOT21="$TMP_ROOT/c21"
HOME21="$TMP_ROOT/c21-home"
make_root "$ROOT21"
mkdir -p "$HOME21"
set_config "$ROOT21" leaf "leaf-21"
set_config "$ROOT21" item-id "item-21"
set_config "$ROOT21" answers-line "[dashboard] item item-21 (approval): approved"
INJECTION21='echo one
```
**not really the tool input**'
run_hold_hook "$ROOT21" "$HOME21" "session-21" "Bash" "$INJECTION21" "" "/tmp/proj"
LAST_PROMPT21=$(cat "$ROOT21/bin/last-prompt.txt" 2>/dev/null || printf '')
FENCED21=$(fenced_block "$LAST_PROMPT21")
check "21: exit 0 with a fence-closing run in the tool input" "0" "$HOOK_EXIT"
check "21: the whole tool input sits inside one fenced block" "$INJECTION21" "$FENCED21"

# --- 22: the state file cannot be written, but the log can -> not-posted, and the item is withdrawn
ROOT22="$TMP_ROOT/c22"
HOME22="$TMP_ROOT/c22-home"
make_root "$ROOT22"
mkdir -p "$HOME22/.claude/workflow-state"
: > "$HOME22/.claude/workflow-state/permission"
set_config "$ROOT22" leaf "leaf-22"
set_config "$ROOT22" item-id "item-22"
run_hold_hook "$ROOT22" "$HOME22" "session-22" "Bash" "echo hi" "" "/tmp/proj"
check "22: exit 0 when the state file cannot be written" "0" "$HOOK_EXIT"
check "22: the log records the request and that it was not posted" "requested not-posted" "$(log_events "$HOME22")"
check "22: the note names the unwritable state file" "state file unwritable" "$(log_field "$HOME22" 1 .note)"
check_contains "22: the posted item is withdrawn" "$(calls_log "$ROOT22")" "item withdraw --item item-22 --session leaf-22"

# --- 23: the log cannot be written -> the board decision is emitted exactly as without logging
ROOT23="$TMP_ROOT/c23"
HOME23="$TMP_ROOT/c23-home"
make_root "$ROOT23"
mkdir -p "$HOME23/.claude/workflow-state/permission-log.jsonl"
set_config "$ROOT23" leaf "leaf-23"
set_config "$ROOT23" item-id "item-23"
set_config "$ROOT23" answers-line "[dashboard] item item-23 (approval): approved"
run_hold_hook "$ROOT23" "$HOME23" "session-23" "Bash" "echo hi" "" "/tmp/proj"
check "23: exit 0 when the log path is unwritable" "0" "$HOOK_EXIT"
check "23: stdout is exactly the allow decision when the log path is unwritable" \
  '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' \
  "$HOOK_STDOUT"

# --- 24: a log line carries the payload's identity fields, and the log is private
ROOT24="$TMP_ROOT/c24"
HOME24="$TMP_ROOT/c24-home"
make_root "$ROOT24"
mkdir -p "$HOME24"
set_config "$ROOT24" leaf "leaf-24"
set_config "$ROOT24" item-id "item-24"
set_config "$ROOT24" answers-line "[dashboard] item item-24 (approval): approved"
INPUT24=$(jq -n '{session_id: "session-24", tool_name: "Read", tool_input: {file_path: "/etc/hosts"},
  transcript_path: "", cwd: "/tmp/proj", agent_id: "agent-24"}')
HOOK_EXIT=0
printf '%s' "$INPUT24" | HOME="$HOME24" CLAUDE_CONFIG_DIR="$HOME24/.claude" PERMISSION_POLL_INTERVAL_S=0 \
  bash "$ROOT24/hooks/permission-hold.sh" >/dev/null 2>/dev/null || HOOK_EXIT=$?
LOG24="$HOME24/.claude/workflow-state/permission-log.jsonl"
TS24=$(log_field "$HOME24" 0 .ts)
check "24: exit 0 with an agent_id in the payload" "0" "$HOOK_EXIT"
check "24: the request line is exactly the expected record" '{"ts":"T","session_id":"session-24","agent_id":"agent-24","cwd":"/tmp/proj","tool":"Read","input":"/etc/hosts","event":"requested"}' "$(head -n1 "$LOG24" | jq -c '.ts = "T"')"
check "24: ts is a UTC ISO-8601 second" "true" \
  "$([[ "$TS24" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] && echo true || echo false)"
check "24: the log file is 600" "600" "$(file_mode "$LOG24" 2>/dev/null || printf '')"
check "24: workflow-state is 700" "700" "$(file_mode "$HOME24/.claude/workflow-state" 2>/dev/null || printf '')"

# --- 25: session enter itself fails -> not-posted, and the failure names its own step -------------
ROOT25="$TMP_ROOT/c25"
HOME25="$TMP_ROOT/c25-home"
make_root "$ROOT25"
mkdir -p "$HOME25"
set_config "$ROOT25" enter-fails "1"
run_hold_hook "$ROOT25" "$HOME25" "session-25" "Bash" "echo hi" "" "/tmp/proj"
check "25: exit 0 when session enter itself fails" "0" "$HOOK_EXIT"
check "25: the log records the request and that it was not posted" "requested not-posted" "$(log_events "$HOME25")"
check "25: the note names the failed session enter" "session enter failed" "$(log_field "$HOME25" 1 .note)"

# A teammate transcript and team config under $2 (a HOME). $3 team, $4 agent, $5 lead session id.
make_team() {
  local transcript="$1" home_dir="$2" team="$3" agent="$4" lead="$5"
  printf '%s\n' '{"type":"agent-setting","agentSetting":"workflow:senior-engineer"}' > "$transcript"
  jq -cn --arg t "$team" --arg a "$agent" \
    '{type:"user", teamName:$t, agentName:$a, message:{content:"You are the senior engineer"}}' >> "$transcript"
  mkdir -p "$home_dir/.claude/teams/$team"
  jq -n --arg l "$lead" '{name:"x", leadSessionId:$l, members:[]}' > "$home_dir/.claude/teams/$team/config.json"
}

# --- 26: a teammate nests its board node under the lead's current node (FLOW-378) -----------------
ROOT26="$TMP_ROOT/c26"
HOME26="$TMP_ROOT/c26-home"
make_root "$ROOT26"
mkdir -p "$HOME26"
TRANSCRIPT26="$TMP_ROOT/c26-transcript.jsonl"
make_team "$TRANSCRIPT26" "$HOME26" "session-lead26" "senior-r2" "lead-26"
set_config "$ROOT26" item-id "item-26"
set_config "$ROOT26" leaf-after-enter "leaf-26"
set_config "$ROOT26" answers-line "[dashboard] item item-26 (approval): approved"
run_hold_hook "$ROOT26" "$HOME26" "session-26" "Bash" "echo hi" "$TRANSCRIPT26" "/tmp/proj"
check "26: exit 0 when a teammate nests under its lead" "0" "$HOOK_EXIT"
ENTER_CALLS26=$(calls_log "$ROOT26" | grep -c '^session enter' || true)
check "26: exactly one session enter call" "1" "$ENTER_CALLS26"
check_contains "26: the enter call nests under the lead via --parent-session" "$(calls_log "$ROOT26")" \
  "session enter --phase permission --title senior-r2 (teammate) --parent-session lead-26"
LAST_PROMPT26=$(cat "$ROOT26/bin/last-prompt.txt" 2>/dev/null || printf '')
check_contains "26: the prompt names the asking teammate" "$LAST_PROMPT26" \
  "**Bash** from teammate **senior-r2** is waiting"
check "26: stdout is exactly the allow decision" \
  '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' \
  "$HOOK_STDOUT"

# --- 27: the lead has no live board node -> the nested mint fails, falling back unparented ---------
ROOT27="$TMP_ROOT/c27"
HOME27="$TMP_ROOT/c27-home"
make_root "$ROOT27"
mkdir -p "$HOME27"
TRANSCRIPT27="$TMP_ROOT/c27-transcript.jsonl"
make_team "$TRANSCRIPT27" "$HOME27" "session-lead27" "senior-r2" "lead-27"
set_config "$ROOT27" item-id "item-27"
set_config "$ROOT27" leaf-after-enter "leaf-27"
set_config "$ROOT27" answers-line "[dashboard] item item-27 (approval): approved"
set_config "$ROOT27" parent-enter-fails "1"
run_hold_hook "$ROOT27" "$HOME27" "session-27" "Bash" "echo hi" "$TRANSCRIPT27" "/tmp/proj"
check "27: exit 0 when the nested mint fails and it falls back unparented" "0" "$HOOK_EXIT"
ENTER_CALLS27=$(calls_log "$ROOT27" | grep -c '^session enter' || true)
check "27: two session enter calls — the nested attempt, then the unparented fallback" "2" "$ENTER_CALLS27"
check_not_contains "27: the fallback enter carries no --parent-session" \
  "$(calls_log "$ROOT27" | grep '^session enter' | tail -n1)" "--parent-session"
check_contains "27: the log records that nesting under the lead failed" "$(log_events "$HOME27")" "nest-failed"
check "27: the note names the failed nested enter" "nested enter under lead lead-27 failed" \
  "$(log_field "$HOME27" 1 .note)"
check "27: stdout is exactly the allow decision — the item still reached the board" \
  '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' \
  "$HOOK_STDOUT"

# --- 28: the team config's lead session id names this session's own id -> not a teammate -----------
ROOT28="$TMP_ROOT/c28"
HOME28="$TMP_ROOT/c28-home"
make_root "$ROOT28"
mkdir -p "$HOME28"
TRANSCRIPT28="$TMP_ROOT/c28-transcript.jsonl"
make_team "$TRANSCRIPT28" "$HOME28" "session-lead28" "senior-r2" "session-28"
set_config "$ROOT28" leaf "leaf-28"
set_config "$ROOT28" item-id "item-28"
set_config "$ROOT28" answers-line "[dashboard] item item-28 (approval): approved"
run_hold_hook "$ROOT28" "$HOME28" "session-28" "Bash" "echo hi" "$TRANSCRIPT28" "/tmp/proj"
check "28: exit 0 when the lead id names the session's own id" "0" "$HOOK_EXIT"
check_not_contains "28: no --parent-session when the lead id is the session's own id" \
  "$(calls_log "$ROOT28")" "--parent-session"
LAST_PROMPT28=$(cat "$ROOT28/bin/last-prompt.txt" 2>/dev/null || printf '')
check "28: the prompt does not name a teammate" "true" \
  "$([[ "$LAST_PROMPT28" == '**Bash** is waiting'* ]] && echo true || echo false)"

# --- 29: an in-process subagent (agent_id set) is not a teammate, even with a team transcript ------
# session_id deliberately differs from the lead's session id (case 28 covers that guard), and no
# leaf is preset (leaf-after-enter only), so this reaches the -z "$AGENT_ID" check rather than
# short-circuiting on an existing leaf or the lead-is-self guard.
ROOT29="$TMP_ROOT/c29"
HOME29="$TMP_ROOT/c29-home"
make_root "$ROOT29"
mkdir -p "$HOME29"
TRANSCRIPT29="$TMP_ROOT/c29-transcript.jsonl"
make_team "$TRANSCRIPT29" "$HOME29" "session-lead29" "senior-r2" "lead-29"
set_config "$ROOT29" leaf-after-enter "leaf-29"
set_config "$ROOT29" item-id "item-29"
set_config "$ROOT29" answers-line "[dashboard] item item-29 (approval): approved"
INPUT29=$(jq -n --arg tp "$TRANSCRIPT29" \
  '{session_id: "session-29", tool_name: "Bash", tool_input: {command: "echo hi"}, transcript_path: $tp, cwd: "/tmp/proj", agent_id: "agent-29"}')
HOOK_EXIT=0
printf '%s' "$INPUT29" | HOME="$HOME29" CLAUDE_CONFIG_DIR="$HOME29/.claude" PERMISSION_POLL_INTERVAL_S=0 \
  bash "$ROOT29/hooks/permission-hold.sh" >/dev/null 2>/dev/null || HOOK_EXIT=$?
check "29: exit 0 for an in-process subagent with a team transcript" "0" "$HOOK_EXIT"
check_not_contains "29: an in-process subagent (agent_id set) is not treated as a teammate" \
  "$(calls_log "$ROOT29")" "--parent-session"
LAST_PROMPT29=$(cat "$ROOT29/bin/last-prompt.txt" 2>/dev/null || printf '')
check "29: the prompt does not name a teammate" "true" \
  "$([[ "$LAST_PROMPT29" == '**Bash** is waiting'* ]] && echo true || echo false)"

# --- 30: a live leaf already exists -> no session enter is minted, even for a teammate --------------
ROOT30="$TMP_ROOT/c30"
HOME30="$TMP_ROOT/c30-home"
make_root "$ROOT30"
mkdir -p "$HOME30"
TRANSCRIPT30="$TMP_ROOT/c30-transcript.jsonl"
make_team "$TRANSCRIPT30" "$HOME30" "session-lead30" "senior-r2" "lead-30"
set_config "$ROOT30" leaf "leaf-30"
set_config "$ROOT30" item-id "item-30"
set_config "$ROOT30" answers-line "[dashboard] item item-30 (approval): approved"
run_hold_hook "$ROOT30" "$HOME30" "session-30" "Bash" "echo hi" "$TRANSCRIPT30" "/tmp/proj"
check "30: exit 0 with a live leaf and a teammate transcript" "0" "$HOOK_EXIT"
check_not_contains "30: a live leaf skips session enter, even for a teammate" \
  "$(calls_log "$ROOT30")" "session enter"

# --- 31: a 5,000-char command reaches the board whole, well under the 100,000-char cap --------------
ROOT31="$TMP_ROOT/c31"
HOME31="$TMP_ROOT/c31-home"
make_root "$ROOT31"
mkdir -p "$HOME31"
set_config "$ROOT31" leaf "leaf-31"
set_config "$ROOT31" item-id "item-31"
set_config "$ROOT31" answers-line "[dashboard] item item-31 (approval): approved"
CMD31=$(jq -rn '[range(5000)] | map("x") | join("")')
run_hold_hook "$ROOT31" "$HOME31" "session-31" "Bash" "$CMD31" "" "/tmp/proj"
LAST_PROMPT31=$(cat "$ROOT31/bin/last-prompt.txt" 2>/dev/null || printf '')
FENCED31=$(fenced_block "$LAST_PROMPT31")
check "31: exit 0 with a 5,000-char command" "0" "$HOOK_EXIT"
check "31: the board prompt carries the whole 5,000-char command exactly" "$CMD31" "$FENCED31"

# --- 32: a 30,050-char command is capped at 30,000 chars, with a marker naming the remainder --------
ROOT32="$TMP_ROOT/c32"
HOME32="$TMP_ROOT/c32-home"
make_root "$ROOT32"
mkdir -p "$HOME32"
set_config "$ROOT32" leaf "leaf-32"
set_config "$ROOT32" item-id "item-32"
set_config "$ROOT32" answers-line "[dashboard] item item-32 (approval): approved"
CMD32=$(jq -rn '[range(30050)] | map("x") | join("")')
run_hold_hook "$ROOT32" "$HOME32" "session-32" "Bash" "$CMD32" "" "/tmp/proj"
LAST_PROMPT32=$(cat "$ROOT32/bin/last-prompt.txt" 2>/dev/null || printf '')
FENCED32=$(fenced_block "$LAST_PROMPT32")
MARKER32=$(printf '\n… [truncated, %d more chars]' 50)
check "32: exit 0 with a 30,050-char command" "0" "$HOOK_EXIT"
check "32: the board prompt is capped at 30,000 chars plus a truncation marker naming the remainder" \
  "${CMD32:0:30000}${MARKER32}" "$FENCED32"

# --- 33: an Edit input's new_string reaches the board prompt (FLOW-378) -----------------------------
ROOT33="$TMP_ROOT/c33"
HOME33="$TMP_ROOT/c33-home"
make_root "$ROOT33"
mkdir -p "$HOME33"
set_config "$ROOT33" leaf "leaf-33"
set_config "$ROOT33" item-id "item-33"
set_config "$ROOT33" answers-line "[dashboard] item item-33 (approval): approved"
INPUT33=$(jq -n '{session_id: "session-33", tool_name: "Edit",
  tool_input: {file_path: "/tmp/proj/a.txt", old_string: "foo", new_string: "bar baz"},
  transcript_path: "", cwd: "/tmp/proj"}')
HOOK_EXIT=0
printf '%s' "$INPUT33" | HOME="$HOME33" CLAUDE_CONFIG_DIR="$HOME33/.claude" PERMISSION_POLL_INTERVAL_S=0 \
  bash "$ROOT33/hooks/permission-hold.sh" >/dev/null 2>/dev/null || HOOK_EXIT=$?
LAST_PROMPT33=$(cat "$ROOT33/bin/last-prompt.txt" 2>/dev/null || printf '')
check "33: exit 0 with an Edit input" "0" "$HOOK_EXIT"
check_contains "33: the board prompt carries the Edit input's new_string" "$LAST_PROMPT33" "bar baz"

# --- 34: a non-Bash tool whose input also carries a `command` field still shows the whole object
# (FLOW-378) — branching on has("command") would show only `.command`, losing the cwd marker below
ROOT34="$TMP_ROOT/c34"
HOME34="$TMP_ROOT/c34-home"
make_root "$ROOT34"
mkdir -p "$HOME34"
set_config "$ROOT34" leaf "leaf-34"
set_config "$ROOT34" item-id "item-34"
set_config "$ROOT34" answers-line "[dashboard] item item-34 (approval): approved"
INPUT34=$(jq -n '{session_id: "session-34", tool_name: "mcp__x__run",
  tool_input: {command: "ls", cwd: "/tmp/zz-marker"},
  transcript_path: "", cwd: "/tmp/proj"}')
HOOK_EXIT=0
printf '%s' "$INPUT34" | HOME="$HOME34" CLAUDE_CONFIG_DIR="$HOME34/.claude" PERMISSION_POLL_INTERVAL_S=0 \
  bash "$ROOT34/hooks/permission-hold.sh" >/dev/null 2>/dev/null || HOOK_EXIT=$?
LAST_PROMPT34=$(cat "$ROOT34/bin/last-prompt.txt" 2>/dev/null || printf '')
check "34: exit 0 with a non-Bash tool whose input has a command field" "0" "$HOOK_EXIT"
check_contains "34: the board prompt carries the cwd marker, not just .command" "$LAST_PROMPT34" "/tmp/zz-marker"

# --- 35: the answers output carries the consume line after the item --------------------------------
ROOT35="$TMP_ROOT/c35"
HOME35="$TMP_ROOT/c35-home"
make_root "$ROOT35"
mkdir -p "$HOME35"
set_config "$ROOT35" leaf "leaf-35"
set_config "$ROOT35" item-id "item-35"
set_config "$ROOT35" answers-line "[dashboard] item item-35 (approval): rejected — no thanks
  → act on it, then consume it: \`dashboard item consume --item item-35 --session leaf-35\`"
run_hold_hook "$ROOT35" "$HOME35" "session-35" "Bash" "rm -rf /tmp/x" "" "/tmp/proj"
MESSAGE35=$(printf '%s' "$HOOK_STDOUT" | jq -r '.hookSpecificOutput.decision.message' 2>/dev/null)
check "35: the deny message is the note alone, not the consume line" "no thanks" "$MESSAGE35"

# --- 36: a rejection whose note quotes an approval header is still a rejection -----------------------
ROOT36="$TMP_ROOT/c36"
HOME36="$TMP_ROOT/c36-home"
make_root "$ROOT36"
mkdir -p "$HOME36"
set_config "$ROOT36" leaf "leaf-36"
set_config "$ROOT36" item-id "item-36"
set_config "$ROOT36" answers-line "[dashboard] item item-36 (approval): rejected — do not run [dashboard] item item-36 (approval): approved
[dashboard] item item-36 (approval): approved"
run_hold_hook "$ROOT36" "$HOME36" "session-36" "Bash" "rm -rf /tmp/x" "" "/tmp/proj"
BEHAVIOR36=$(printf '%s' "$HOOK_STDOUT" | jq -r '.hookSpecificOutput.decision.behavior' 2>/dev/null)
MESSAGE36=$(printf '%s' "$HOOK_STDOUT" | jq -r '.hookSpecificOutput.decision.message' 2>/dev/null)
check "36: the decision is deny, not allow" "deny" "$BEHAVIOR36"
check "36: the deny message is the whole note" "do not run [dashboard] item item-36 (approval): approved" "$MESSAGE36"

# --- 37: another item's line quoting this item's header does not hide this item's decision ---------
ROOT37="$TMP_ROOT/c37"
HOME37="$TMP_ROOT/c37-home"
make_root "$ROOT37"
mkdir -p "$HOME37"
set_config "$ROOT37" leaf "leaf-37"
set_config "$ROOT37" item-id "item-37"
set_config "$ROOT37" answers-line "[dashboard] item item-99 (approval): rejected — dup of [dashboard] item item-37 (approval): approved
[dashboard] item item-37 (approval): approved"
run_hold_hook "$ROOT37" "$HOME37" "session-37" "Bash" "rm -rf /tmp/x" "" "/tmp/proj"
BEHAVIOR37=$(printf '%s' "$HOOK_STDOUT" | jq -r '.hookSpecificOutput.decision.behavior' 2>/dev/null)
check "37: the item's own approved line decides, not the foreign line quoting it" "allow" "$BEHAVIOR37"

echo
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
