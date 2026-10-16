#!/bin/bash
# Test script for session-start.sh
# Drives the hook against constructed PLUGIN_ROOT states and verifies which
# blocks land in additionalContext, the missing-file behaviours, and that the
# hand-rolled JSON escaper survives a round trip through a real JSON parser.

# Deliberately -uo, NOT -euo (five of the seven sibling suites use -euo; this one and
# test-install-cli-deps.sh do not). Cases 3 and 3c assert a nonzero exit inline —
# `<hook>; check "..." "1" "$?"` — which under `-e` would terminate the suite at the
# first correctly-failing hook and silently skip every case after it. If you add -e to
# match the siblings, both of those cases must first capture the status in an `if`.
set -uo pipefail

export CLAUDE_CODE_EXECPATH=/nonexistent

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/session-start.sh"
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

# Build a plugin root containing a copy of the hook plus the three skill files.
# $1 = root path, $2 = contract content ("-" to omit), $3 = style content ("-" to omit),
# $4 = keep-it-simple content ("-" or absent to omit)
make_root() {
  local root="$1" contract="$2" style="$3" rules="${4:--}"
  mkdir -p "$root/hooks" "$root/skills/workflow-guide"
  cp "$HOOK_SCRIPT" "$root/hooks/session-start.sh"
  chmod +x "$root/hooks/session-start.sh"
  [[ "$contract" != "-" ]] && printf '%s' "$contract" > "$root/skills/workflow-guide/contract.md"
  [[ "$style" != "-" ]] && printf '%s' "$style" > "$root/skills/workflow-guide/output-style.md"
  [[ "$rules" != "-" ]] && printf '%s' "$rules" > "$root/skills/workflow-guide/keep-it-simple.md"
  return 0
}

# Extract additionalContext from the hook's stdout using a real JSON parser, so a
# mis-escaped payload fails loudly here instead of silently reaching the model.
# Case 4 covers backslash/quote/tab/newline; case 5 covers every control byte JSON
# forbids raw. Together those are the characters the escaper claims to handle.
extract_context() {
  python3 -c 'import json,sys; print(json.load(sys.stdin)["hookSpecificOutput"]["additionalContext"])'
}

# --- Case 1: both files present -> both blocks injected ---------------------
ROOT1="$TMP_ROOT/both"
make_root "$ROOT1" "CONTRACT_MARKER_ONE" "STYLE_MARKER_ONE"
OUT1="$("$ROOT1/hooks/session-start.sh" 2>/dev/null)"
RC1=$?
check "both present: exit 0" "0" "$RC1"
CTX1="$(printf '%s' "$OUT1" | extract_context)"
case "$CTX1" in *CONTRACT_MARKER_ONE*) r=yes ;; *) r=no ;; esac
check "both present: contract content injected" "yes" "$r"
case "$CTX1" in *STYLE_MARKER_ONE*) r=yes ;; *) r=no ;; esac
check "both present: style content injected" "yes" "$r"
check "both present: two EXTREMELY_IMPORTANT blocks" "2" \
  "$(printf '%s' "$CTX1" | grep -c '<EXTREMELY_IMPORTANT>')"

# --- Case 2: style missing -> contract only, warns, still exit 0 ------------
ROOT2="$TMP_ROOT/no-style"
make_root "$ROOT2" "CONTRACT_MARKER_TWO" "-"
ERR2="$TMP_ROOT/err2.txt"
OUT2="$("$ROOT2/hooks/session-start.sh" 2>"$ERR2")"
RC2=$?
check "style missing: exit 0" "0" "$RC2"
CTX2="$(printf '%s' "$OUT2" | extract_context)"
case "$CTX2" in *CONTRACT_MARKER_TWO*) r=yes ;; *) r=no ;; esac
check "style missing: contract still injected" "yes" "$r"
check "style missing: only one block" "1" \
  "$(printf '%s' "$CTX2" | grep -c '<EXTREMELY_IMPORTANT>')"
case "$(cat "$ERR2")" in *output-style.md*) r=yes ;; *) r=no ;; esac
check "style missing: warns on stderr" "yes" "$r"

# --- Case 3: contract missing -> fatal, unchanged from today ----------------
ROOT3="$TMP_ROOT/no-contract"
make_root "$ROOT3" "-" "STYLE_MARKER_THREE"
"$ROOT3/hooks/session-start.sh" >/dev/null 2>&1
check "contract missing: exit 1" "1" "$?"

# --- Case 3c: contract present but EMPTY -> fatal, same as missing ----------
# "Empty counts as missing" has to hold for the contract too, or the hook exits 0
# having injected an empty authoritative block — the session silently loses its
# process rules, which is the exact outcome the fatal-vs-degrade split exists to
# prevent. Case 3 covers a *missing* contract; this covers a truncated one.
ROOT3C="$TMP_ROOT/empty-contract"
make_root "$ROOT3C" "-" "STYLE_MARKER_3C"
: > "$ROOT3C/skills/workflow-guide/contract.md"
ERR3C="$TMP_ROOT/err3c.txt"
"$ROOT3C/hooks/session-start.sh" >/dev/null 2>"$ERR3C"
check "empty contract: exit 1" "1" "$?"
case "$(cat "$ERR3C")" in *"missing or empty"*) r=yes ;; *) r=no ;; esac
check "empty contract: warns on stderr" "yes" "$r"

# --- Case 3b: style present but empty -> treated as missing -----------------
# What the emptiness check `|| [[ -z "$output_style_content" ]]` actually buys
# is the STDERR WARNING, and only that. Block suppression is not at stake: the
# `[[ -n "$output_style_content" ]]` guard already omits the block whenever the
# content is empty, with or without the check. Verified by deleting only the
# `|| [[ -z ... ]]` clause and re-running — "only one block" still passed,
# "warns on stderr" failed.
# So of the three assertions below, exactly one is load-bearing. Do not read this
# case as proof that the check controls output shape; it controls whether a broken
# install is silent.
ROOT3B="$TMP_ROOT/empty-style"
make_root "$ROOT3B" "CONTRACT_MARKER_3B" "-"
: > "$ROOT3B/skills/workflow-guide/output-style.md"
ERR3B="$TMP_ROOT/err3b.txt"
OUT3B="$("$ROOT3B/hooks/session-start.sh" 2>"$ERR3B")"
RC3B=$?
check "empty style: exit 0" "0" "$RC3B"
CTX3B="$(printf '%s' "$OUT3B" | extract_context)"
check "empty style: only one block" "1" \
  "$(printf '%s' "$CTX3B" | grep -c '<EXTREMELY_IMPORTANT>')"
case "$(cat "$ERR3B")" in *"missing or empty"*) r=yes ;; *) r=no ;; esac
check "empty style: warns on stderr" "yes" "$r"

# --- Case 4: escaper round-trips the characters it claims to handle ---------
# A literal backslash, a double quote, a tab and a newline in both files.
ROOT4="$TMP_ROOT/escaping"
TRICKY='back\slash "quoted" and	tab
second line'
make_root "$ROOT4" "$TRICKY" "$TRICKY"
OUT4="$("$ROOT4/hooks/session-start.sh" 2>/dev/null)"
CTX4="$(printf '%s' "$OUT4" | extract_context)"
case "$CTX4" in *'back\slash "quoted" and'*) r=yes ;; *) r=no ;; esac
check "escaping: backslash and quotes survive the round trip" "yes" "$r"
check "escaping: both copies present" "2" \
  "$(printf '%s' "$CTX4" | grep -c 'second line')"

# --- Case 5: every control byte JSON forbids raw ----------------------------
# JSON forbids raw U+0001..U+001F in a string. Before the escaper handled them,
# any one of them made the whole payload unparseable — and an unparseable payload
# is dropped WHOLESALE, taking the contract with it. Exit code stayed 0 and stderr
# stayed empty, so the session silently lost its process rules. This asserts the
# whole class at once, and that the contract survives it.
ROOT5="$TMP_ROOT/control-bytes"
make_root "$ROOT5" "CONTRACT_MARKER_FIVE" "-"
{
  printf 'STYLE_MARKER_FIVE'
  for b in $(seq 1 31); do printf "\\x$(printf '%02x' "$b")"; done
} > "$ROOT5/skills/workflow-guide/output-style.md"
OUT5="$("$ROOT5/hooks/session-start.sh" 2>/dev/null)"
if printf '%s' "$OUT5" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1; then
  r=yes
else
  r=no
fi
check "control bytes: stdout is valid JSON" "yes" "$r"
CTX5="$(printf '%s' "$OUT5" | extract_context)"
case "$CTX5" in *CONTRACT_MARKER_FIVE*) r=yes ;; *) r=no ;; esac
check "control bytes: contract survives" "yes" "$r"
case "$CTX5" in *STYLE_MARKER_FIVE*) r=yes ;; *) r=no ;; esac
check "control bytes: style still injected" "yes" "$r"

# --- Case 5b: a read that fails PART WAY must not inject the fragment -------
# A command substitution keeps whatever the command wrote before it failed, so a
# `cat` dying mid-read (I/O error on a failing disk or a network filesystem) yields
# partial, non-empty content AND a nonzero status. Without the explicit clear, the
# hook warns "continuing without the output style" and then injects the truncated
# fragment regardless — presenting half a rule block to the model as authoritative.
# Stub `cat` on PATH to reproduce it deterministically; the hook calls `cat` unqualified.
ROOT5B="$TMP_ROOT/partial-read"
make_root "$ROOT5B" "CONTRACT_MARKER_5B" "STYLE_MARKER_5B_TRUNCATED"
# Marker names are load-bearing, not arbitrary: the stub emits STYLE_MARKER_5B_TRUNC,
# a strict prefix of the fixture's STYLE_MARKER_5B_TRUNCATED. So if the PATH stub ever
# stops applying, the REAL file content still matches the *TRUNC* pattern below and this
# case fails rather than passing vacuously. Don't "tidy" one name without the other.
STUB_BIN="$TMP_ROOT/stub-bin"
mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/cat" <<'STUB'
#!/bin/bash
# Emits a partial read then fails, as a real cat does on a mid-read I/O error.
case "$1" in
  *output-style.md) printf 'STYLE_MARKER_5B_TRUNC'; exit 1 ;;
  *) exec /bin/cat "$@" ;;
esac
STUB
chmod +x "$STUB_BIN/cat"
ERR5B="$TMP_ROOT/err5b.txt"
OUT5B="$(PATH="$STUB_BIN:$PATH" "$ROOT5B/hooks/session-start.sh" 2>"$ERR5B")"
RC5B=$?
check "partial read: exit 0" "0" "$RC5B"
CTX5B="$(printf '%s' "$OUT5B" | extract_context)"
case "$CTX5B" in *CONTRACT_MARKER_5B*) r=yes ;; *) r=no ;; esac
check "partial read: contract still injected" "yes" "$r"
case "$CTX5B" in *STYLE_MARKER_5B_TRUNC*) r=leaked ;; *) r=suppressed ;; esac
check "partial read: fragment NOT injected" "suppressed" "$r"
check "partial read: only one block" "1" \
  "$(printf '%s' "$CTX5B" | grep -c '<EXTREMELY_IMPORTANT>')"
case "$(cat "$ERR5B")" in *"missing or empty"*) r=yes ;; *) r=no ;; esac
check "partial read: warns on stderr" "yes" "$r"

# --- Case 6: minimum Claude Code version ------------------------------------
# $1 = stub body. Prints the hook's stdout; the stub stands in for the claude binary.
run_with_version_stub() {
  local stub="$TMP_ROOT/claude-stub-$RANDOM"
  printf '#!/bin/bash\n%s\n' "$1" > "$stub"
  chmod +x "$stub"
  CLAUDE_CODE_EXECPATH="$stub" "$ROOT1/hooks/session-start.sh" 2>/dev/null
}
# Exit 0 when systemMessage is present, 1 when the JSON parses without it, 2 when it does not parse.
has_system_message() {
  python3 -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except ValueError:
    sys.exit(2)
sys.exit(0 if "systemMessage" in doc else 1)'
}

OUT6="$(run_with_version_stub "echo '2.1.100 (Claude Code)'")"
RC6=$?
check "old version: exit 0" "0" "$RC6"
SYS6="$(printf '%s' "$OUT6" | python3 -c 'import json,sys; print(json.load(sys.stdin)["systemMessage"])')"
case "$SYS6" in *2.1.290*2.1.100*) r=yes ;; *) r=no ;; esac
check "old version: systemMessage names both versions" "yes" "$r"
case "$(printf '%s' "$OUT6" | extract_context)" in *"$SYS6"*) r=yes ;; *) r=no ;; esac
check "old version: additionalContext carries the same sentence" "yes" "$r"

OUT6B="$(run_with_version_stub "echo '2.1.290 (Claude Code)'")"
printf '%s' "$OUT6B" | has_system_message; check "current version: no systemMessage" "1" "$?"

OUT6C="$(run_with_version_stub "exit 1")"
RC6C=$?
check "failing version command: exit 0" "0" "$RC6C"
printf '%s' "$OUT6C" | has_system_message; check "failing version command: no systemMessage" "1" "$?"

# --- Case 7: keep-it-simple rules -------------------------------------------
# check_file NAME EXPECTED_FILE ACTUAL_FILE: byte-for-byte comparison of two raw captures.
check_file() {
  if cmp -s "$2" "$3"; then check "$1" "same" "same"; else check "$1" "same" "different"; fi
}
# Expected-stdout builders, from each case's fixture inputs. The fixtures contain nothing the
# escaper changes, so the escaped form equals the raw text; the payload layout is the hook's own,
# with the empty line where no systemMessage is emitted.
block_contract() { printf '%s' "<EXTREMELY_IMPORTANT>\nBEFORE responding to any request, obey this contract:\n\n$1\n</EXTREMELY_IMPORTANT>"; }
block_style() { printf '%s' "<EXTREMELY_IMPORTANT>\nThis is how you write to the user, on every reply:\n\n$1\n</EXTREMELY_IMPORTANT>"; }
block_rules() { printf '%s' "<EXTREMELY_IMPORTANT>\nHow you build, on every task:\n\n$1\n</EXTREMELY_IMPORTANT>"; }
payload() { printf '{\n%s\n  "hookSpecificOutput": {\n    "hookEventName": "%s",\n    "additionalContext": "%s"\n  }\n}\n' "$1" "$2" "$3"; }
# A stub claude that reports a current version, so no version warning reaches the payload.
VERSION_STUB="$TMP_ROOT/claude-stub-current"
printf '#!/bin/bash\necho "9.9.9 (Claude Code)"\n' > "$VERSION_STUB"
chmod +x "$VERSION_STUB"
RULES_WARNING_TAIL="skills/workflow-guide/keep-it-simple.md is missing or empty — continuing without the keep-it-simple rules"

# Session mode: all three present -> three blocks, contract then style then rules.
ROOT7="$TMP_ROOT/rules"
make_root "$ROOT7" "CONTRACT_MARKER_SEVEN" "STYLE_MARKER_SEVEN" "RULES_MARKER_SEVEN"
CLAUDE_CODE_EXECPATH="$VERSION_STUB" "$ROOT7/hooks/session-start.sh" >"$TMP_ROOT/out7.txt" 2>"$TMP_ROOT/err7.txt"
RC7=$?
check "rules present: exit 0" "0" "$RC7"
: >"$TMP_ROOT/empty.txt"
check_file "rules present: stderr empty" "$TMP_ROOT/empty.txt" "$TMP_ROOT/err7.txt"
CTX7="$(extract_context <"$TMP_ROOT/out7.txt")"
case "$CTX7" in *RULES_MARKER_SEVEN*) r=yes ;; *) r=no ;; esac
check "rules present: rules injected" "yes" "$r"
check "rules present: three EXTREMELY_IMPORTANT blocks" "3" \
  "$(printf '%s' "$CTX7" | grep -c '<EXTREMELY_IMPORTANT>')"
payload "" SessionStart "$(block_contract CONTRACT_MARKER_SEVEN)\n\n$(block_style STYLE_MARKER_SEVEN)\n\n$(block_rules RULES_MARKER_SEVEN)" >"$TMP_ROOT/want7.txt"
check_file "rules present: stdout is exactly the three blocks" "$TMP_ROOT/want7.txt" "$TMP_ROOT/out7.txt"
BEFORE7="${CTX7%%RULES_MARKER_SEVEN*}"
case "$BEFORE7" in *CONTRACT_MARKER_SEVEN*STYLE_MARKER_SEVEN*) r=last ;; *) r=not-last ;; esac
check "rules present: rules block comes last" "last" "$r"

# Session mode: rules missing -> exit 0, stdout is exactly the contract and style blocks, stderr is
# exactly the warning.
ROOT7B="$TMP_ROOT/no-rules"
make_root "$ROOT7B" "CONTRACT_MARKER_7B" "STYLE_MARKER_7B" "-"
CLAUDE_CODE_EXECPATH="$VERSION_STUB" "$ROOT7B/hooks/session-start.sh" >"$TMP_ROOT/out7b.txt" 2>"$TMP_ROOT/err7b.txt"
RC7B=$?
check "rules missing: exit 0" "0" "$RC7B"
check "rules missing: two blocks" "2" \
  "$(extract_context <"$TMP_ROOT/out7b.txt" | grep -c '<EXTREMELY_IMPORTANT>')"
payload "" SessionStart "$(block_contract CONTRACT_MARKER_7B)\n\n$(block_style STYLE_MARKER_7B)" >"$TMP_ROOT/wantout7b.txt"
check_file "rules missing: stdout is exactly the contract and style blocks" "$TMP_ROOT/wantout7b.txt" "$TMP_ROOT/out7b.txt"
printf 'session-start hook: %s/%s\n' "$ROOT7B" "$RULES_WARNING_TAIL" >"$TMP_ROOT/want7b.txt"
check_file "rules missing: stderr is exactly the warning" "$TMP_ROOT/want7b.txt" "$TMP_ROOT/err7b.txt"

# Subagent mode: rules only, under SubagentStart. The contract is absent from this root on
# purpose: a subagent never needs it, so its absence must not make the hook exit 1.
ROOT7C="$TMP_ROOT/subagent"
make_root "$ROOT7C" "-" "STYLE_MARKER_7C" "RULES_MARKER_7C"
"$ROOT7C/hooks/session-start.sh" subagent >"$TMP_ROOT/out7c.txt" 2>"$TMP_ROOT/err7c.txt"
RC7C=$?
check "subagent: exit 0 without a contract" "0" "$RC7C"
check_file "subagent: stderr empty" "$TMP_ROOT/empty.txt" "$TMP_ROOT/err7c.txt"
payload_sub() { printf '{\n  "hookSpecificOutput": {\n    "hookEventName": "SubagentStart",\n    "additionalContext": "%s"\n  }\n}\n' "$1"; }
payload_sub "$(block_rules RULES_MARKER_7C)" >"$TMP_ROOT/wantout7c.txt"
check_file "subagent: stdout is exactly the rules block" "$TMP_ROOT/wantout7c.txt" "$TMP_ROOT/out7c.txt"
EVENT7C="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["hookSpecificOutput"]["hookEventName"])' <"$TMP_ROOT/out7c.txt")"
check "subagent: event is SubagentStart" "SubagentStart" "$EVENT7C"
CTX7C="$(extract_context <"$TMP_ROOT/out7c.txt")"
case "$CTX7C" in *RULES_MARKER_7C*) r=yes ;; *) r=no ;; esac
check "subagent: rules injected" "yes" "$r"
case "$CTX7C" in *STYLE_MARKER_7C*) r=leaked ;; *) r=absent ;; esac
check "subagent: output style NOT injected" "absent" "$r"
check "subagent: one block" "1" "$(printf '%s' "$CTX7C" | grep -c '<EXTREMELY_IMPORTANT>')"

# Subagent mode: rules missing -> exit 0, nothing on stdout, exact warning.
ROOT7D="$TMP_ROOT/subagent-no-rules"
make_root "$ROOT7D" "-" "-" "-"
"$ROOT7D/hooks/session-start.sh" subagent >"$TMP_ROOT/out7d.txt" 2>"$TMP_ROOT/err7d.txt"
RC7D=$?
check "subagent, rules missing: exit 0" "0" "$RC7D"
check_file "subagent, rules missing: stdout empty" "$TMP_ROOT/empty.txt" "$TMP_ROOT/out7d.txt"
printf 'session-start hook: %s/%s\n' "$ROOT7D" "$RULES_WARNING_TAIL" >"$TMP_ROOT/want7d.txt"
check_file "subagent, rules missing: stderr is exactly the warning" "$TMP_ROOT/want7d.txt" "$TMP_ROOT/err7d.txt"

# A partial read of the rules must not inject the fragment. Same construction as case 5b, and
# the same load-bearing marker names: the stub's RULES_MARKER_7E_TRUNC is a strict prefix of the
# fixture's RULES_MARKER_7E_TRUNCATED, so a stub that stops applying fails this case.
ROOT7E="$TMP_ROOT/rules-partial-read"
make_root "$ROOT7E" "CONTRACT_MARKER_7E" "STYLE_MARKER_7E" "RULES_MARKER_7E_TRUNCATED"
STUB_BIN_7E="$TMP_ROOT/stub-bin-7e"
mkdir -p "$STUB_BIN_7E"
cat > "$STUB_BIN_7E/cat" <<'STUB'
#!/bin/bash
case "$1" in
  *keep-it-simple.md) printf 'RULES_MARKER_7E_TRUNC'; exit 1 ;;
  *) exec /bin/cat "$@" ;;
esac
STUB
chmod +x "$STUB_BIN_7E/cat"
CLAUDE_CODE_EXECPATH="$VERSION_STUB" PATH="$STUB_BIN_7E:$PATH" "$ROOT7E/hooks/session-start.sh" >"$TMP_ROOT/out7e.txt" 2>"$TMP_ROOT/err7e.txt"
RC7E=$?
check "rules partial read: exit 0" "0" "$RC7E"
CTX7E="$(extract_context <"$TMP_ROOT/out7e.txt")"
case "$CTX7E" in *CONTRACT_MARKER_7E*) r=yes ;; *) r=no ;; esac
check "rules partial read: contract still injected" "yes" "$r"
case "$CTX7E" in *RULES_MARKER_7E_TRUNC*) r=leaked ;; *) r=suppressed ;; esac
check "rules partial read: fragment NOT injected" "suppressed" "$r"
check "rules partial read: two blocks" "2" "$(printf '%s' "$CTX7E" | grep -c '<EXTREMELY_IMPORTANT>')"
payload "" SessionStart "$(block_contract CONTRACT_MARKER_7E)\n\n$(block_style STYLE_MARKER_7E)" >"$TMP_ROOT/wantout7e.txt"
check_file "rules partial read: stdout is exactly the contract and style blocks" "$TMP_ROOT/wantout7e.txt" "$TMP_ROOT/out7e.txt"
printf 'session-start hook: %s/%s\n' "$ROOT7E" "$RULES_WARNING_TAIL" >"$TMP_ROOT/want7e.txt"
check_file "rules partial read: stderr is exactly the warning" "$TMP_ROOT/want7e.txt" "$TMP_ROOT/err7e.txt"

# --- Case 8: the real hook over the real plugin root ------------------------
# Runs the shipped hook against the shipped files in both modes: stdout must be one valid JSON
# document with the expected event name and the rules block in its context. The decode is strict
# UTF-8 and locale-independent: json.load on a text stdin would accept invalid bytes under a C locale.
for mode in session subagent; do
  if [[ "$mode" == "session" ]]; then
    "$HOOK_SCRIPT" >"$TMP_ROOT/real-$mode.txt" 2>"$TMP_ROOT/realerr-$mode.txt"
    want_event=SessionStart
  else
    "$HOOK_SCRIPT" subagent >"$TMP_ROOT/real-$mode.txt" 2>"$TMP_ROOT/realerr-$mode.txt"
    want_event=SubagentStart
  fi
  RCREAL=$?
  check "real hook, $mode mode: exit 0" "0" "$RCREAL"
  check_file "real hook, $mode mode: stderr empty" "$TMP_ROOT/empty.txt" "$TMP_ROOT/realerr-$mode.txt"
  got="$(python3 -c '
import json, sys
out = json.loads(sys.stdin.buffer.read().decode("utf-8"))["hookSpecificOutput"]
print(out["hookEventName"], "<keep-it-simple>" in out["additionalContext"])' <"$TMP_ROOT/real-$mode.txt" 2>&1)"
  check "real hook, $mode mode: valid JSON with the rules block" "$want_event True" "$got"
done

# --- Summary ---------------------------------------------------------------
echo
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]]
