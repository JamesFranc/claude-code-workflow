#!/usr/bin/env bash
# SessionStart hook: injects workflow-guide as mandatory instructions,
# plus the always-on output style and keep-it-simple rules.
#
# Run as `session-start.sh subagent` (the SubagentStart registration) it injects only the
# keep-it-simple rules: a plain subagent never acts on the board contract and never writes a reply
# to the user, so the contract and the output style are not its to carry.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
mode="${1:-session}"

if [[ "$mode" != "subagent" ]]; then
    if ! workflow_guide_content="$(cat "${PLUGIN_ROOT}/skills/workflow-guide/contract.md" 2>/dev/null)" \
       || [[ -z "$workflow_guide_content" ]]; then
        echo "session-start hook: ${PLUGIN_ROOT}/skills/workflow-guide/contract.md is missing or empty" >&2
        exit 1
    fi

    # The contract gates correctness, so a missing contract is fatal (above). The output style shapes
    # prose only — losing it must not cost the session its process rules, so a missing style file warns
    # and degrades instead of exiting. The asymmetry is deliberate; test-session-start.sh pins both halves.
    # Empty counts as missing: `cat` succeeds on an empty file, and dropping the style silently is the
    # one outcome worse than dropping it loudly.
    if ! output_style_content="$(cat "${PLUGIN_ROOT}/skills/workflow-guide/output-style.md" 2>/dev/null)" \
       || [[ -z "$output_style_content" ]]; then
        # NOT redundant — do not delete this as a dead assignment. A command substitution keeps whatever
        # the command wrote before it failed, so a `cat` killed mid-read (this hook's process group being
        # signalled on timeout is the everyday case) leaves PARTIAL content here, non-empty:
        #   v="$( { cat big & p=$!; sleep .001; kill -TERM $p; wait $p; } )"   # len=913408 rc=143
        # Without this line the hook warns "continuing without" and injects the fragment anyway. Pinned by
        # the stubbed-cat case in test-session-start.sh.
        output_style_content=""
        echo "session-start hook: ${PLUGIN_ROOT}/skills/workflow-guide/output-style.md is missing or empty — continuing without the output style" >&2
    fi
fi

# The keep-it-simple rules degrade exactly as the output style does, and for the same reason: they
# shape how code is written, and losing them must never cost the session its process rules. The clear
# discards a partial read, as above; the stubbed-cat case for this file pins it.
if ! keep_it_simple_content="$(cat "${PLUGIN_ROOT}/skills/workflow-guide/keep-it-simple.md" 2>/dev/null)" \
   || [[ -z "$keep_it_simple_content" ]]; then
    keep_it_simple_content=""
    echo "session-start hook: ${PLUGIN_ROOT}/skills/workflow-guide/keep-it-simple.md is missing or empty — continuing without the keep-it-simple rules" >&2
fi

# Escape for JSON.
#
# Deliberately pure bash. Shelling out to jq or python3 would be shorter, but it would make the
# CONTRACT's injection depend on a binary that may be absent — trading a latent failure for a hard
# one, in the file whose whole point is that it must never fail to reach the session.
#
# Bulk substitution rather than a character loop: `output+="$char"` reallocated the accumulator on
# every iteration, which is quadratic and ran on every session start. The parameter expansions below
# are linear.
#
# The final pass exists because JSON forbids raw U+0000–U+001F inside a string. Emitting one makes
# the whole payload unparseable, and an unparseable payload is dropped WHOLESALE — contract included.
# That would let a stray form feed pasted into the prose file silently disable the process rules the
# contract carries, which is exactly the failure the fatal-vs-degrade split above exists to prevent.
# Rare enough that the per-character loop only runs when such a byte is actually present.
#
# Known residual, stated so the comment does not promise more than the code delivers: this repairs
# control characters, NOT invalid UTF-8. A raw 0xFF still yields undecodable stdout, and bash cannot
# meaningfully escape a byte that is not a character. test-session-start.sh runs the hook over
# every shipped file and requires valid JSON out, which is where that risk actually lives — these files are authored
# in the repo, not generated.
escape_for_json() {
    local input="$1"

    input="${input//\\/\\\\}"
    input="${input//\"/\\\"}"
    input="${input//$'\t'/\\t}"
    input="${input//$'\r'/\\r}"
    input="${input//$'\n'/\\n}"

    if [[ "$input" == *[$'\x01'-$'\x1f']* ]]; then
        local output="" i char
        for (( i=0; i<${#input}; i++ )); do
            char="${input:$i:1}"
            case "$char" in
                [$'\x01'-$'\x1f']) printf -v char '\\u%04x' "'$char" ;;
            esac
            output+="$char"
        done
        input="$output"
    fi

    printf '%s' "$input"
}

keep_it_simple_block=""
if [[ -n "$keep_it_simple_content" ]]; then
    keep_it_simple_escaped=$(escape_for_json "$keep_it_simple_content")
    keep_it_simple_block="<EXTREMELY_IMPORTANT>\nHow you build, on every task:\n\n${keep_it_simple_escaped}\n</EXTREMELY_IMPORTANT>"
fi

if [[ "$mode" == "subagent" ]]; then
    [[ -z "$keep_it_simple_block" ]] && exit 0
    cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SubagentStart",
    "additionalContext": "${keep_it_simple_block}"
  }
}
EOF
    exit 0
fi

# The wake mod (hooks/wake.ts) is a hooks module, which an older Claude Code never loads — and then
# nothing wakes this session when a board answer is released. Only a shell hook can say so. The
# minimum is the release this plugin's mod was verified on.
MIN_CLAUDE_CODE_VERSION="2.1.290"
version_warning=""
if running_version="$("${CLAUDE_CODE_EXECPATH:-claude}" --version 2>/dev/null)"; then
    running_version="${running_version%% *}"
    if [[ -n "$running_version" ]] \
       && [[ "$(printf '%s\n%s\n' "$MIN_CLAUDE_CODE_VERSION" "$running_version" | sort -V | head -n 1)" != "$MIN_CLAUDE_CODE_VERSION" ]]; then
        version_warning="This workflow plugin needs Claude Code ${MIN_CLAUDE_CODE_VERSION} or newer, and this session runs ${running_version}. Until Claude Code is updated, a released board answer will not wake this session: check the board yourself with \`dashboard answers\`."
    fi
fi

workflow_guide_escaped=$(escape_for_json "$workflow_guide_content")

additional_context="<EXTREMELY_IMPORTANT>\nBEFORE responding to any request, obey this contract:\n\n${workflow_guide_escaped}\n</EXTREMELY_IMPORTANT>"

if [[ -n "$output_style_content" ]]; then
    output_style_escaped=$(escape_for_json "$output_style_content")
    additional_context+="\n\n<EXTREMELY_IMPORTANT>\nThis is how you write to the user, on every reply:\n\n${output_style_escaped}\n</EXTREMELY_IMPORTANT>"
fi

if [[ -n "$keep_it_simple_block" ]]; then
    additional_context+="\n\n${keep_it_simple_block}"
fi

system_message_line=""
if [[ -n "$version_warning" ]]; then
    version_warning_escaped=$(escape_for_json "$version_warning")
    additional_context+="\n\n${version_warning_escaped}"
    system_message_line="  \"systemMessage\": \"${version_warning_escaped}\","
fi

cat <<EOF
{
${system_message_line}
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "${additional_context}"
  }
}
EOF

exit 0
